import { describe, expect, test } from "bun:test";
import { Value } from "typebox/value";
import { AgentErrorCode, AgentState, CodedError, CompletionState, PublicPreflightError, agentId, directAgentOrdinal, modelSpec, runCapacity, runId, runAttemptId, truncateUtf8, utf8Bytes, type ToolName } from "../src/domain.ts";
import { directAgentRow } from "../src/agent-observation.ts";
import { AgentObservationStore } from "../src/agent-observation-store.ts";
import { createObservationDisplayResolver } from "../src/tool-presentation.ts";
import { diagnosticsPath } from "../src/paths.ts";
import { CompletionService } from "../src/completion-service.ts";
import { MAX_AGGREGATE_AWAIT_BYTES } from "../src/constants.ts";
import { SubagentController, type LaunchSession, type LaunchTransport, type PiControllerComposition, type PublicStopOutcome } from "../src/controller.ts";
import { deferred } from "./support/async.ts";
import { testAbsolutePath, testCommittedOutputPath, testRunId, testSessionPath, testToolName, testVerifiedReceiptPath } from "./support/brands.ts";
import { launchSession, runningTransport as sharedRunningTransport, testRuntime } from "./support/launches.ts";
import {
  createSubagentTools,
  type SubagentToolController,
  type SubagentToolInput,
  type SubagentToolName,
  type SubagentToolRegistry,
  type SpawnAgentInput,
  type SendInputInput,
  type AwaitAgentInput,
  type StopAgentInput,
  awaitAgentSchema,
  sendInputSchema,
  spawnAgentSchema,
  stopAgentSchema,
} from "../src/tools.ts";

type Equal<A, B> =
  (<T>() => T extends A ? 1 : 2) extends
  (<T>() => T extends B ? 1 : 2) ? true : false;
type Assert<T extends true> = T;

const toolTypeContracts: readonly [
  Assert<Equal<SubagentToolInput<"spawn_agent">, SpawnAgentInput>>,
  Assert<Equal<SubagentToolInput<"send_input">, SendInputInput>>,
  Assert<Equal<SubagentToolInput<"await_agent">, AwaitAgentInput>>,
  Assert<Equal<SubagentToolInput<"stop_agent">, StopAgentInput>>,
  Assert<Equal<keyof SubagentToolRegistry,
    "spawn_agent" | "send_input" | "await_agent" | "stop_agent">>,
] = [true, true, true, true, true];
void toolTypeContracts;
type ToolControllerFake = Partial<Record<keyof SubagentToolController, (...args: never[]) => unknown>>;

/**
 * Malformed tool-result fixtures cross this internal trust boundary once. Tool tests only invoke
 * supplied methods; production's concrete controller has unrelated state and lifecycle members.
 */
function fakeToolController(value: ToolControllerFake): SubagentToolController {
  // malformed trust-boundary fixture: fake tool methods may return deliberately invalid DTOs.
  return value as unknown as SubagentToolController;
}

const TEST_SELECTION = Object.freeze({
  model: modelSpec("mock-provider/luna"),
  thinkingLevel: "high" as const,
  tools: Object.freeze([testToolName("read")]),
});
const _internalSelectionTools: readonly ToolName[] = TEST_SELECTION.tools;
void _internalSelectionTools;

describe("exact tool contracts", () => {
  test("production resolver renders an individually addressed owned observation", () => {
    const store = new AgentObservationStore();
    const id = agentId("agent-a");
    store.registerSpawned({ agentId: id, ordinal: directAgentOrdinal(1), assignment: "Review races",
      sessionPath: testSessionPath("/tmp/pi-subagents-test/agent-a.jsonl"), cwd: testAbsolutePath("/tmp/pi-subagents-test"),
      model: modelSpec("mock-provider/luna"), thinkingLevel: "high" });
    store.acceptRun({ agentId: id, runId: testRunId("deadbeef"), attemptId: runAttemptId("attempt-a"), assignment: "Review races" });
    store.updateLifecycle({ agentId: id, runId: testRunId("deadbeef"), state: AgentState.Running,
      transcriptPath: testSessionPath("/tmp/pi-subagents-test/agent-a.jsonl") });
    const tools = createSubagentTools(new SubagentController(), createObservationDisplayResolver(store));
    expect(tools.spawn_agent.renderResult?.({ agentId: id, runId: testRunId("deadbeef"), state: "running" }, { expanded: false }))
      .toBe("A1 · luna:h · Review races · running");
  });

  test("production resolver renders an owned agent omitted from directSnapshot", () => {
    const store = new AgentObservationStore();
    for (let index = 0; index < 201; index++) {
      const id = agentId(`agent-${String(index).padStart(3, "0")}`);
      store.registerSpawned({ agentId: id, ordinal: directAgentOrdinal(index + 1), assignment: "Review races",
        sessionPath: testSessionPath(`/tmp/pi-subagents-test/${id}.jsonl`), cwd: testAbsolutePath("/tmp/pi-subagents-test"),
        model: modelSpec("mock-provider/luna"), thinkingLevel: "high" });
    }
    const active = agentId("agent-active");
    store.registerSpawned({ agentId: active, ordinal: directAgentOrdinal(202), assignment: "Inspect output",
      sessionPath: testSessionPath("/tmp/pi-subagents-test/agent-active.jsonl"), cwd: testAbsolutePath("/tmp/pi-subagents-test"),
      model: modelSpec("mock-provider/luna"), thinkingLevel: "high" });
    store.updateLifecycle({ agentId: active, runId: testRunId("cafebabe"), state: AgentState.Running,
      transcriptPath: testSessionPath("/tmp/pi-subagents-test/agent-active.jsonl") });
    const target = store.observation(agentId("agent-000"))!;

    expect(store.directSnapshot()).toMatchObject({ kind: "snapshot", omitted: 2 });
    expect(createObservationDisplayResolver(store).resolve(target.agentId)).toEqual(directAgentRow(target));
  });

  test("returns each exported input schema by identity", () => {
    const tools = createSubagentTools(new SubagentController());
    expect(tools.spawn_agent.parameters).toBe(spawnAgentSchema);
    expect(tools.send_input.parameters).toBe(sendInputSchema);
    expect(tools.await_agent.parameters).toBe(awaitAgentSchema);
    expect(tools.stop_agent.parameters).toBe(stopAgentSchema);
  });

  test("schemas use the design field names and reject inferred aliases", () => {
    expect(Value.Check(spawnAgentSchema, { task: "work", model: "p/m:high", cwd: "/tmp", tools: ["read"] })).toBeTrue();
    expect(Value.Check(spawnAgentSchema, { task: "work", thinking: "high" })).toBeFalse();
    expect(Value.Check(sendInputSchema, { agentId: "agent-a", message: "literal" })).toBeTrue();
    expect(Value.Check(sendInputSchema, { agent_id: "agent-a", task: "literal" })).toBeFalse();
    expect(Value.Check(awaitAgentSchema, { timeoutMs: 0 })).toBeTrue();
    expect(Value.Check(awaitAgentSchema, { timeout_ms: 0 })).toBeFalse();
    expect(Value.Check(stopAgentSchema, { agentIds: ["agent-a", "agent-a"] })).toBeTrue();
  });

  test("await_agent schema rejects unsafe timeout integers at the public boundary", () => {
    expect(Value.Check(awaitAgentSchema, { timeoutMs: Number.MAX_SAFE_INTEGER })).toBeTrue();
    expect(Value.Check(awaitAgentSchema, { timeoutMs: Number.MAX_SAFE_INTEGER + 1 })).toBeFalse();
  });

  test("spawn schema describes its asynchronous lifecycle and every input field", () => {
    expect(Value.Check(spawnAgentSchema, { task: "work" })).toBeTrue();
    expect(Value.Check(spawnAgentSchema, {})).toBeFalse();
    expect(Value.Check(spawnAgentSchema, {
      task: "work",
      model: "openai-codex/gpt-5.6-luna:high",
      cwd: "/tmp/child",
      tools: [],
    })).toBeTrue();
    expect(schemaDescription(spawnAgentSchema)).toBe(
      "Start a fresh persistent child session asynchronously; collect completion with await_agent.",
    );
    expect(schemaDescription(spawnAgentSchema.properties.task)).toBe(
      "Literal first assignment for the fresh child session.",
    );
    expect(schemaDescription(spawnAgentSchema.properties.model)).toBe(
      "Optional child model pattern, for example gpt-5.6-luna, openai-codex/gpt-5.6-luna, or either with :high.",
    );
    expect(schemaDescription(spawnAgentSchema.properties.cwd)).toBe(
      "Optional child working directory; defaults to the parent working directory.",
    );
    expect(schemaDescription(spawnAgentSchema.properties.tools)).toBe(
      "Optional exact allowlist from parent-active tools; omission inherits eligible tools and [] enables none.",
    );
  });

  test("spawn and send execute through production composition without wrapping literal input", async () => {
    const messages: string[] = [];
    const controller = fakeToolController({
      spawn: async (_input: { task: string }) => ({ agentId: agentId("agent-a"), runId: runId("deadbeef"), state: AgentState.Running,
        model: modelSpec("mock-provider/luna"), thinkingLevel: "high", tools: ["web_fetch", "read"] }),
      sendInput: async (_id: unknown, message: string) => { messages.push(message); return { agentId: agentId("agent-a"), runId: runId("cafebabe"), state: AgentState.Running }; },
    });
    const { spawn_agent: spawn, send_input: send } = createSubagentTools(controller);
    expect((await spawn!.execute({ task: "work" })).details).toEqual({ agentId: "agent-a", runId: "deadbeef", state: "running",
      model: "mock-provider/luna", thinkingLevel: "high", tools: ["web_fetch", "read"] });
    expect((await send!.execute({ agentId: "agent-a", message: "literal" })).details).toEqual({ agentId: "agent-a", runId: "cafebabe", state: "running" });
    expect(messages).toEqual(["literal"]);
  });

  test("projects one completion and exact paged inventory metadata", async () => {
    const summaries = Array.from({ length: 205 }, (_, index) => ({
      agentId: agentId(`agent-${String(index).padStart(3, "0")}`),
      state: AgentState.Stopped,
      transcriptPath: testSessionPath(`/tmp/pi-subagents-test/${index}.jsonl`),
    }));
    const result = await createSubagentTools(fakeToolController({
      awaitReady: async () => ({ completion: undefined, remainingCompletions: 0, agents: summaries, timedOut: false }),
    })).await_agent.execute({ afterAgentId: "agent-099" });

    expect(result.details).toMatchObject({
      completions: [],
      remainingCompletions: 0,
      inventory: { total: 205, omitted: 105, remaining: 5, nextAfterAgentId: "agent-199" },
    });
    expect((result.details as { inventory: { agents: unknown[] } }).inventory.agents).toHaveLength(100);
  });

  test("allocates the exact deterministic output residual for escaped multibyte JSON", async () => {
    const outputText = `\\\"😀£`.repeat(20_000);
    const completion = {
      agentId: agentId("agent-a"), runId: runId("deadbeef"), state: CompletionState.Completed,
      output: truncateUtf8(outputText, utf8Bytes(50_000)),
      outputPath: "/tmp/\\\"output", transcriptPath: "/tmp/\\\"transcript",
    };
    const controller = fakeToolController({
      awaitReady: async () => ({ completion, remainingCompletions: 0, agents: [], timedOut: false }),
    });
    const tool = createSubagentTools(controller).await_agent;

    const first = await tool.execute({});
    const second = await tool.execute({});
    const projected = testRecord(JSON.parse(first.content));
    const projectedCompletion = testRecord((projected.completions as unknown[])[0]);
    const projectedOutput = testRecord(projectedCompletion.output);
    const retained = testString(projectedOutput, "text");
    const nextPoint = [...completion.output.text][[...retained].length];

    expect(second.content).toBe(first.content);
    expect(completion.output.text.startsWith(retained)).toBeTrue();
    expect(nextPoint).toBeDefined();
    expect(retained).not.toContain("\uFFFD");
    expect(Buffer.byteLength(first.content, "utf8")).toBeLessThanOrEqual(MAX_AGGREGATE_AWAIT_BYTES);
    const extendedOutput = { ...projectedOutput, text: retained + nextPoint,
      retainedBytes: Buffer.byteLength(retained + nextPoint!, "utf8") };
    const extendedCompletion = { ...projectedCompletion, output: extendedOutput };
    const extended = { ...projected, completions: [extendedCompletion] };
    expect(Buffer.byteLength(JSON.stringify(extended), "utf8")).toBeGreaterThan(MAX_AGGREGATE_AWAIT_BYTES);
  });

  test("pages whole escaped multibyte summaries with exact metadata under byte pressure", async () => {
    const pathSegment = `\\\"£`.repeat(500);
    const summaries = Array.from({ length: 205 }, (_, index) => ({
      agentId: agentId(`agent-${String(index).padStart(3, "0")}`),
      state: AgentState.Stopped,
      transcriptPath: testSessionPath(`/tmp/pi-subagents-test/${pathSegment}-${index}`),
    }));
    const controller = fakeToolController({
      awaitReady: async () => ({ completion: undefined, remainingCompletions: 0, agents: summaries, timedOut: false }),
    });
    const tool = createSubagentTools(controller).await_agent;

    const first = await tool.execute({ afterAgentId: "agent-099" });
    const second = await tool.execute({ afterAgentId: "agent-099" });
    const inventory = testRecord(testRecord(first.details).inventory);
    const agents = inventory.agents as Array<{ agentId: string }>;

    expect(second.content).toBe(first.content);
    expect(agents.length).toBeGreaterThan(0);
    expect(agents.length).toBeLessThan(100);
    expect(inventory.omitted).toBe(205 - agents.length);
    expect(inventory.remaining).toBe(105 - agents.length);
    expect(inventory.nextAfterAgentId).toBe(agents.at(-1)?.agentId);
    expect(Buffer.byteLength(first.content, "utf8")).toBeLessThanOrEqual(MAX_AGGREGATE_AWAIT_BYTES);
    expect(first.content).not.toContain("\uFFFD");
  });

  test("canonicalises stored error messages from known codes", async () => {
    const controller = fakeToolController({ sendInput: async () => ({
      agentId: "agent-a", state: "stopped",
      error: { code: "protocol_error", message: "stored-secret-message", diagnosticsPath: "/tmp/diagnostic" },
    }) });

    const result = await createSubagentTools(controller).send_input.execute({ agentId: "agent-a", message: "next" });

    expect(result.details).toEqual({ agentId: "agent-a", state: "stopped", error: {
      code: "protocol_error", message: "child process protocol error", diagnosticsPath: "/tmp/diagnostic",
    } });
    expect(result.content).not.toContain("stored-secret-message");
  });

  test("projects and renders an exact post-native settling launch failure", async () => {
    const controller = fakeToolController({ sendInput: async () => ({
      agentId: "agent-a", runId: "deadbeef", state: "settling",
      error: { code: "spawn_failed", message: "raw-secret" }, extra: "secret",
    }) });
    const tool = createSubagentTools(controller).send_input;

    const result = await tool.execute({ agentId: "agent-a", message: "next" });

    expect(result.details).toEqual({ agentId: "agent-a", runId: "deadbeef", state: "settling",
      error: { code: "spawn_failed", message: "failed to spawn child agent" } });
    expect(tool.renderResult!(result)).toBe("Agent · unavailable");
  });

  test("preserves only typed public preflight detail at the spawn tool boundary", async () => {
    const message = 'invalid_input: child tool "web_fetch" is not active in the parent';
    const controller = fakeToolController({ spawn: async () => { throw new PublicPreflightError(AgentErrorCode.InvalidInput, message.slice("invalid_input: ".length)); } });

    const failure = await createSubagentTools(controller).spawn_agent.execute({ task: "work" }).catch((error: Error) => error);

    expect(failure).toBeInstanceOf(PublicPreflightError);
    if (!(failure instanceof Error)) throw new Error("expected spawn rejection");
    expect(failure.message).toBe(message);
  });

  test("stop_agent retains a CodedError diagnostics path in the failed outcome DTO", async () => {
    const path = diagnosticsPath("/tmp", "stop-coded.log");
    const controller = fakeToolController({
      stop: async () => { throw new CodedError(AgentErrorCode.ContainmentFailed, path); },
    });
    const { stop_agent: stop } = createSubagentTools(controller);
    const result = await stop!.execute({ agentIds: ["agent-a"] });
    expect(result.details).toEqual({ outcomes: [{
      agentId: "agent-a",
      state: "failed",
      error: { code: "containment_failed", message: "could not confirm child process termination", diagnosticsPath: "/tmp/stop-coded.log" },
    }] });
  });

  test("send_input rethrows a CodedError preserving code, message and diagnostics path", async () => {
    const path = diagnosticsPath("/tmp", "send-coded.log");
    const controller = fakeToolController({
      sendInput: async () => { throw new CodedError(AgentErrorCode.SessionUnavailable, path); },
    });
    const { send_input: send } = createSubagentTools(controller);
    const caught = await send!.execute({ agentId: "agent-a", message: "m" })
      .then(() => { throw new Error("expected rejection"); }, (e: unknown) => e);
    expect(caught).toBeInstanceOf(CodedError);
    expect((caught as CodedError).code).toBe(AgentErrorCode.SessionUnavailable);
    expect(String((caught as CodedError).diagnosticsPath)).toBe("/tmp/send-coded.log");
    expect((caught as CodedError).message).toBe("session_unavailable: child session is unavailable");
  });

  test("spawn_agent rethrows a CodedError through executeSpawn/stableOperationError preserving the diagnostics path", async () => {
    const path = diagnosticsPath("/tmp", "spawn-coded.log");
    const controller = fakeToolController({
      spawn: async () => { throw new CodedError(AgentErrorCode.ModelUnavailable, path); },
    });
    const { spawn_agent: spawn } = createSubagentTools(controller);
    const caught = await spawn!.execute({ task: "work" })
      .then(() => { throw new Error("expected rejection"); }, (e: unknown) => e);
    expect(caught).toBeInstanceOf(CodedError);
    expect((caught as CodedError).code).toBe(AgentErrorCode.ModelUnavailable);
    expect(String((caught as CodedError).diagnosticsPath)).toBe("/tmp/spawn-coded.log");
    expect((caught as CodedError).message).toBe("model_unavailable: requested model is unavailable");
  });

  test("a foreign regex-coded error still maps to its stable code with no diagnostics path", async () => {
    const controller = fakeToolController({
      stop: async () => { throw new Error("capacity_exceeded: raw foreign detail"); },
    });
    const { stop_agent: stop } = createSubagentTools(controller);
    const result = await stop!.execute({ agentIds: ["agent-a"] });
    expect(result.details).toEqual({ outcomes: [{
      agentId: "agent-a",
      state: "failed",
      error: { code: "capacity_exceeded", message: "maximum concurrent runs exceeded" },
    }] });
  });

  test.each([
    ["prefixed Error", new Error("invalid_input: THROW_SECRET"), "invalid_input: invalid input"],
    ["error-shaped object", { code: AgentErrorCode.InvalidInput, message: "THROW_SECRET" }, "invalid_input: invalid input"],
    ["getter object", Object.defineProperty({}, "code", { get: () => { throw new Error("THROW_SECRET"); } }), "spawn_failed: failed to spawn child agent"],
    ["control characters", new Error("transport\u0000THROW_SECRET\nvalue"), "spawn_failed: failed to spawn child agent"],
    ["transport failure", new Error("transport failed: THROW_SECRET"), "spawn_failed: failed to spawn child agent"],
  ] as const)("canonicalises %s without exposing hostile detail", async (_name, thrown, expected) => {
    const controller = fakeToolController({ spawn: async () => { throw thrown; } });

    const failure = await createSubagentTools(controller).spawn_agent.execute({ task: "work" }).catch((error: Error) => error);

    expect(failure).toBeInstanceOf(Error);
    if (!(failure instanceof Error)) throw new Error("expected spawn rejection");
    expect(failure.message).toBe(expected);
    expect(failure.message).not.toContain("THROW_SECRET");
  });

  test("maps a typed error thrown after successful preflight to generic spawn failure", async () => {
    const controller = new SubagentController({ composition: {
      prepareSpawn: async () => ({
        selection: TEST_SELECTION,
        createSession: async () => { throw new PublicPreflightError(AgentErrorCode.InvalidInput, "LATE_SECRET"); },
        persistSpawned: async () => {},
        createLaunch: async () => { throw new Error("unused"); },
      }),
      prepareSend: async () => { throw new Error("unused"); },
    } });

    const failure = await createSubagentTools(controller).spawn_agent.execute({ task: "work" }).catch((error: Error) => error);

    if (!(failure instanceof Error)) throw new Error("expected spawn rejection");
    expect(failure.message).toBe("spawn_failed: failed to spawn child agent");
    expect(failure.message).not.toContain("LATE_SECRET");
  });

  test.each([
    ["invalid nested usage", () => createSubagentTools(fakeToolController({ awaitReady: async () => ({ completion: { agentId: "agent-a", runId: "deadbeef", state: "completed", output: { text: "", originalBytes: 0, retainedBytes: 0, truncated: false }, outputPath: "/tmp/o", transcriptPath: "/tmp/t", usage: { turns: 1, usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: Number.NaN, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } } }, remainingCompletions: 0, agents: [], timedOut: false }) })).await_agent.execute({})],
    ["invalid cacheWrite1h usage", () => createSubagentTools(fakeToolController({ awaitReady: async () => ({ completion: { agentId: "agent-a", runId: "deadbeef", state: "completed", output: { text: "", originalBytes: 0, retainedBytes: 0, truncated: false }, outputPath: "/tmp/o", transcriptPath: "/tmp/t", usage: { turns: 1, usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cacheWrite1h: Number.NaN, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } } }, remainingCompletions: 0, agents: [], timedOut: false }) })).await_agent.execute({})],
    ["invalid output byte metadata", () => createSubagentTools(fakeToolController({ awaitReady: async () => ({ completion: { agentId: "agent-a", runId: "deadbeef", state: "completed", output: { text: "x", originalBytes: 1, retainedBytes: 999, truncated: false }, outputPath: "/tmp/o", transcriptPath: "/tmp/t" }, remainingCompletions: 0, agents: [], timedOut: false }) })).await_agent.execute({})],
    ["invalid path", () => createSubagentTools(fakeToolController({ awaitReady: async () => ({ completion: undefined, remainingCompletions: 0, agents: [{ agentId: "agent-a", state: "stopped", transcriptPath: "relative/secret" }], timedOut: false }) })).await_agent.execute({})],
    ["invalid canonical model reference", () => createSubagentTools(fakeToolController({ spawn: async () => ({ agentId: "agent-a", runId: "deadbeef", state: "running", model: "unqualified-model", thinkingLevel: "high", tools: [] }) })).spawn_agent.execute({ task: "work" })],
    ["invalid canonical model components", () => createSubagentTools(fakeToolController({ spawn: async () => ({ agentId: "agent-a", runId: "deadbeef", state: "running", model: "mock-provider /luna", thinkingLevel: "high", tools: [] }) })).spawn_agent.execute({ task: "work" })],
    ["overlong warning", () => createSubagentTools(fakeToolController({ spawn: async () => ({ agentId: "agent-a", runId: "deadbeef", state: "running", model: "mock-provider/luna", thinkingLevel: "high", tools: [], warning: "x".repeat(100_000) }) })).spawn_agent.execute({ task: "work" })],
    ["overlong tool value", () => createSubagentTools(fakeToolController({ spawn: async () => ({ agentId: "agent-a", runId: "deadbeef", state: "running", model: "mock-provider/luna", thinkingLevel: "high", tools: ["x".repeat(1_000)] }) })).spawn_agent.execute({ task: "work" })],
    ["invalid diagnostics path", () => createSubagentTools(fakeToolController({ awaitReady: async () => ({ completion: { agentId: "agent-a", runId: "deadbeef", state: "failed", output: { text: "", originalBytes: 0, retainedBytes: 0, truncated: false }, outputPath: "/tmp/o", transcriptPath: "/tmp/t", error: { code: "protocol_error", message: "child process protocol error", diagnosticsPath: "relative/secret" } }, remainingCompletions: 0, agents: [], timedOut: false }) })).await_agent.execute({})],
  ] as const)("maps invalid child-derived %s internal DTO to a bounded error", async (_name, execute) => {
    await expect(execute()).rejects.toThrow("internal_error: internal agent result is invalid");
  });

  for (const operation of ["spawn", "send"] as const) {
    for (const [kind, thrown, expected] of [
      ["raw Error", new Error("transport-secret"), operation === "spawn" ? "spawn_failed: failed to spawn child agent" : "session_unavailable: child session is unavailable"],
      ["coded Error", new Error("model_unavailable: provider-secret"), operation === "spawn" ? "spawn_failed: failed to spawn child agent" : "model_unavailable: requested model is unavailable"],
      ["AgentError DTO", { code: "invalid_input", message: "validation-secret" }, operation === "spawn" ? "spawn_failed: failed to spawn child agent" : "invalid_input: invalid input"],
      ["non-Error", { transport: "object-secret" }, operation === "spawn" ? "spawn_failed: failed to spawn child agent" : "session_unavailable: child session is unavailable"],
    ] as const) {
      test(`${operation} normalises a ${kind} from preparation at the tool boundary`, async () => {
        let launchSideEffects = 0;
        const existing = agentId("existing");
        const composition = {
          prepareSpawn: async () => { throw thrown; },
          prepareSend: async () => { throw thrown; },
        } satisfies PiControllerComposition;
        const controller = new SubagentController({ composition });
        controller.runs.register({ agentId: existing, state: AgentState.Stopped, transcriptPath: testSessionPath("/tmp/pi-subagents-test/existing.jsonl") });
        const failure = operation === "spawn"
          ? await createSubagentTools(controller).spawn_agent.execute({ task: "work" }).catch((error: Error) => error)
          : await createSubagentTools(controller).send_input.execute({ agentId: existing, message: "literal" }).catch((error: Error) => error);

        expect(failure).toBeInstanceOf(Error);
        expect((failure as Error).message).toBe(expected);
        expect(JSON.stringify(failure)).not.toContain("secret");
        expect(Object.keys(failure as object)).toEqual([]);
        expect(launchSideEffects).toBe(0);
        expect(controller.runs.activeCount()).toBe(0);
      });
    }
  }

  for (const thrown of [new Error("raw-secret"), new Error("model_unavailable: coded-secret"), { raw: "object-secret" }] as const) {
    const expected = thrown instanceof Error && thrown.message.startsWith("model_unavailable:")
      ? "model_unavailable: requested model is unavailable"
      : "spawn_failed: failed to spawn child agent";
    test(`spawn normalises ${thrown instanceof Error ? thrown.message.split("-")[0] : "non-error"} session creation failures and leaves no owner`, async () => {
      const controller = new SubagentController({ composition: {
        prepareSpawn: async () => ({ selection: TEST_SELECTION, createSession: async () => { throw thrown; }, persistSpawned: async () => {}, createLaunch: async () => { throw new Error("unused"); } }),
        prepareSend: async () => { throw new Error("unused"); },
      } });

      const failure = await createSubagentTools(controller).spawn_agent.execute({ task: "work" }).catch((error: Error) => error);

      expect(failure).toBeInstanceOf(Error);
      expect((failure as Error).message).toBe(expected);
      expect(controller.runs.snapshots()).toEqual([]);
    });
  }

  for (const thrown of [new Error("raw-persist-secret"), new Error("protocol_error: coded-persist-secret")] as const) {
    test(`spawn normalises ${thrown.message.startsWith("raw") ? "raw" : "coded"} persistSpawned failures and rolls back runtime ownership`, async () => {
      const session = launchSession(`persist-${thrown.message.startsWith("raw") ? "raw" : "coded"}`);
      const controller = new SubagentController({ composition: {
        prepareSpawn: async () => ({ selection: TEST_SELECTION, createSession: async () => session, persistSpawned: async () => { throw thrown; }, createLaunch: async () => { throw new Error("unused"); } }),
        prepareSend: async () => { throw new Error("unused"); },
      } });

      const failure = await createSubagentTools(controller).spawn_agent.execute({ task: "work" }).catch((error: Error) => error);

      expect(failure).toBeInstanceOf(Error);
      expect((failure as Error).message).toBe(thrown.message.startsWith("raw")
        ? "spawn_failed: failed to spawn child agent"
        : "protocol_error: child process protocol error");
      expect(controller.runs.snapshots()).toEqual([]);
      expect(controller.runs.activeCount()).toBe(0);
    });
  }

  for (const operation of ["spawn", "send"] as const) {
    test(`${operation} surfaces genuine RunController capacity exhaustion without preparing a launch`, async () => {
      let preparations = 0;
      const running = launchSession("capacity-running");
      const idle = launchSession(`capacity-idle-${operation}`);
      const controller = new SubagentController({ capacity: runCapacity(1), composition: {
        prepareSpawn: async () => {
          preparations++;
          return { selection: TEST_SELECTION, createSession: async () => running, persistSpawned: async () => {}, createLaunch: async () => runningTransport(running) };
        },
        prepareSend: async () => { preparations++; return { session: idle, createLaunch: async () => runningTransport(idle) }; },
      } });
      const { spawn_agent: spawn, send_input: send } = createSubagentTools(controller);
      await expect(spawn!.execute({ task: "occupy" })).resolves.toMatchObject({ details: { state: "running" } });
      controller.runs.register({ agentId: idle.agentId, state: AgentState.Stopped, transcriptPath: idle.transcriptPath });
      const preparedBefore = preparations;

      const failure = await (operation === "spawn"
        ? spawn!.execute({ task: "second" })
        : send!.execute({ agentId: idle.agentId, message: "next" })).catch((error: Error) => error);

      expect(failure).toBeInstanceOf(Error);
      expect((failure as Error).message).toBe("capacity_exceeded: maximum concurrent runs exceeded");
      expect(preparations).toBe(preparedBefore + 1);
      expect(controller.runs.activeCount()).toBe(1);
      expect(controller.runs.snapshot(idle.agentId)?.state).toBe(AgentState.Stopped);
    });
  }

  test("send surfaces a genuine invalid-state RunController admission failure", async () => {
    const session = launchSession("invalid-state");
    const controller = new SubagentController({ composition: {
      prepareSpawn: async () => ({ selection: TEST_SELECTION, createSession: async () => session, persistSpawned: async () => {}, createLaunch: async () => runningTransport(session) }),
      prepareSend: async () => ({ session, createLaunch: async () => runningTransport(session) }),
    } });
    const { spawn_agent: spawn, send_input: send } = createSubagentTools(controller);
    await expect(spawn!.execute({ task: "occupy" })).resolves.toMatchObject({ details: { state: "running" } });

    const failure = await send!.execute({ agentId: session.agentId, message: "next" }).catch((error: Error) => error);

    expect(failure).toBeInstanceOf(Error);
    expect((failure as Error).message).toBe("invalid_state: agent is not in a valid state for this operation");
    expect(controller.runs.snapshot(session.agentId)?.state).toBe(AgentState.Running);
  });

  test("await times out at the tool boundary and dequeues nothing", async () => {
    const completions = new CompletionService();
    completions.upsertAgent({ agentId: agentId("agent-a"), state: AgentState.Running, transcriptPath: testSessionPath("/tmp/pi-subagents-test/a.jsonl"), currentRunId: runId("deadbeef") });
    const controller = new SubagentController({ completions });
    const awaitTool = createSubagentTools(controller).await_agent;

    const result = await awaitTool.execute({ timeoutMs: 5 });

    expect(result.details).toEqual({ completions: [], remainingCompletions: 0, inventory: {
      total: 1, omitted: 0, remaining: 0,
      agents: [{ agentId: "agent-a", state: "running", transcriptPath: "/tmp/pi-subagents-test/a.jsonl", currentRunId: "deadbeef" }],
    }, timedOut: true });
    expect(controller.completions.queuedCount()).toBe(0);
  });

  test("await cancellation rethrows the host abort and dequeues no completion", async () => {
    const completions = new CompletionService();
    completions.upsertAgent({ agentId: agentId("agent-a"), state: AgentState.Running, transcriptPath: testSessionPath("/tmp/pi-subagents-test/a.jsonl"), currentRunId: runId("deadbeef") });
    const controller = new SubagentController({ completions });
    const awaitTool = createSubagentTools(controller).await_agent;
    const abort = new AbortController();

    const pending = awaitTool.execute({}, abort.signal).catch((error: Error) => error);
    await new Promise<void>((resolve) => setImmediate(resolve));
    abort.abort();
    const failure = await pending;

    expect(failure).toBeInstanceOf(Error);
    expect((failure as Error).name).toBe("AbortError");
    expect((failure as Error).message).not.toContain("internal_error");
    await controller.publish({ agentId: agentId("agent-a"), runId: runId("deadbeef"), state: CompletionState.Completed,
      output: truncateUtf8("done", utf8Bytes(50_000)), outputPath: testCommittedOutputPath({ workDir: testAbsolutePath("/tmp/pi-subagents-test/output/agent-a"), runId: runId("deadbeef") }), transcriptPath: testSessionPath("/tmp/pi-subagents-test/a.jsonl") });
    expect(controller.completions.queuedCount()).toBe(1);
    expect((await awaitTool.execute({})).details).toMatchObject({ completions: [{ agentId: "agent-a", runId: "deadbeef", state: "completed" }] });
  });

  for (const operation of ["spawn", "send"] as const) {
    for (const seam of ["createLaunch", "ready", "persistLaunchRequested", "start", "getEntriesBefore", "prompt", "getEntriesAfter", "bindRun", "persistRunStarted"] as const) {
      for (const thrown of [new Error("raw-post-prep-secret"), new Error("protocol_error: coded-post-prep-secret")] as const) {
        test(`${operation} returns an exact launch-failed DTO for ${seam} ${thrown.message.startsWith("raw") ? "raw" : "coded"} failure`, async () => {
          const session = launchSession(operation);
          const createLaunch = async () => {
            if (seam === "createLaunch") throw thrown;
            return failingTransport(session, seam, thrown);
          };
          const controller = new SubagentController({ composition: {
            prepareSpawn: async () => ({ selection: TEST_SELECTION, createSession: async () => session, persistSpawned: async () => {}, createLaunch }),
            prepareSend: async () => ({ session, createLaunch }),
          } });
          if (operation === "send") controller.runs.register({ agentId: session.agentId, state: AgentState.Stopped, transcriptPath: session.transcriptPath });
          const result = operation === "spawn"
            ? await createSubagentTools(controller).spawn_agent.execute({ task: "work" })
            : await createSubagentTools(controller).send_input.execute({ agentId: session.agentId, message: "next" });

          const postNative = seam === "bindRun" || seam === "persistRunStarted";
          expect(result.details).toEqual(postNative
            ? { agentId: session.agentId, runId: "deadbeef", state: "settling", error: { code: "spawn_failed", message: "failed to spawn child agent" } }
            : { agentId: session.agentId, state: "stopped", error: { code: "spawn_failed", message: "failed to spawn child agent" } });
          expect(result.content).not.toContain("secret");
          expect(controller.runs.snapshot(session.agentId)?.state).toBe(seam === "persistRunStarted" ? AgentState.Settling : AgentState.Stopped);
          expect(controller.runs.snapshot(session.agentId)?.runId).toBe(seam === "bindRun" || seam === "persistRunStarted" ? runId("deadbeef") : undefined);
          expect(controller.runs.activeCount()).toBe(seam === "persistRunStarted" ? 1 : 0);
        });
      }
    }
  }

  for (const operation of ["spawn", "send"] as const) {
    for (const thrown of [new Error("raw-containment-secret"), new Error("containment_failed: coded-containment-secret")] as const) {
      test(`${operation} returns containment-failed DTO when pre-native containment throws`, async () => {
        const session = launchSession(`${operation}-containment`);
        const createLaunch = async () => failingTransport(session, "ready", new Error("launch-secret"), thrown);
        const controller = new SubagentController({ composition: {
          prepareSpawn: async () => ({ selection: TEST_SELECTION, createSession: async () => session, persistSpawned: async () => {}, createLaunch }),
          prepareSend: async () => ({ session, createLaunch }),
        } });
        if (operation === "send") controller.runs.register({ agentId: session.agentId, state: AgentState.Stopped, transcriptPath: session.transcriptPath });
        const result = operation === "spawn"
          ? await createSubagentTools(controller).spawn_agent.execute({ task: "work" })
          : await createSubagentTools(controller).send_input.execute({ agentId: session.agentId, message: "next" });

        expect(result.details).toEqual({ agentId: session.agentId, state: "stopping", error: { code: "containment_failed", message: "could not confirm child process termination" } });
        expect(result.content).not.toContain("secret");
        expect(controller.runs.snapshot(session.agentId)?.state).toBe(AgentState.Stopping);
        expect(controller.runs.activeCount()).toBe(1);
      });
    }
  }

  test("tool renderers expose compact contract fields without output, errors, messages, or raw DTO text", async () => {
    const secret = "MODEL_OUTPUT_SECRET".repeat(10_000);
    const controller = fakeToolController({
      spawn: async () => ({ agentId: "agent-a", runId: "deadbeef", state: "running",
        model: "mock-provider/family/luna", thinkingLevel: "off", tools: [], message: secret, process: { secret } }),
      sendInput: async () => ({ agentId: "agent-a", runId: "cafebabe", state: "running", message: secret, client: { secret } }),
      awaitReady: async () => ({
        completion: {
          agentId: "agent-a", runId: "deadbeef", state: CompletionState.Failed,
          output: truncateUtf8(secret, utf8Bytes(50_000)), outputPath: "/tmp/out.md", transcriptPath: "/tmp/session.jsonl",
          error: { code: "protocol_error", message: secret },
        },
        remainingCompletions: 0,
        agents: [{
          agentId: "agent-a", state: AgentState.Stopped, transcriptPath: "/tmp/session.jsonl",
          latestCompletionState: CompletionState.Failed, latestOutputPath: "/tmp/out.md",
          raw: secret,
        }],
        timedOut: false,
        raw: secret,
      }),
      stop: async (id: string) => ({
        agentId: id, runId: "deadbeef", state: "failed", agentState: "stopping",
        error: { code: "containment_failed", message: secret }, process: { secret },
      }),
    });
    const tools = createSubagentTools(controller);
    const results = await Promise.all([
      tools.spawn_agent.execute({ task: "prompt-secret" }),
      tools.send_input.execute({ agentId: "agent-a", message: "message-secret" }),
      tools.await_agent.execute({}),
      tools.stop_agent.execute({ agentIds: ["agent-a"] }),
    ]);
    const rendered = [
      tools.spawn_agent.renderResult!(results[0]!),
      tools.send_input.renderResult!(results[1]!),
      tools.await_agent.renderResult!(results[2]!),
      tools.stop_agent.renderResult!(results[3]!),
    ];

    expect(rendered[0]).toBe("Agent · unavailable");
    expect(rendered[0]).not.toContain("mock-provider");
    expect(rendered[0]).not.toContain("thinkingLevel");
    expect(results[0]!.details).toMatchObject({
      model: "mock-provider/family/luna",
      thinkingLevel: "off",
    });
    expect(results[0]!.content).toContain('"model":"mock-provider/family/luna"');
    expect(results[0]!.content).toContain('"thinkingLevel":"off"');
    expect(rendered[1]).toBe("Agent · unavailable");
    expect(rendered[2]).toBe("Agent · unavailable");
    expect(rendered[2]).not.toContain("outputPath");
    expect(rendered[2]).not.toContain("latestOutputPath");
    expect(rendered[2]).not.toContain("transcriptPath");
    expect(rendered[2]).not.toContain("/tmp/session.jsonl");
    expect(results[2]!.details).toMatchObject({
      completions: [{ transcriptPath: "/tmp/session.jsonl" }],
      inventory: { agents: [{ transcriptPath: "/tmp/session.jsonl" }] },
    });
    expect(results[2]!.content).toContain('"transcriptPath":"/tmp/session.jsonl"');
    expect(rendered[3]).toBe("Agent · unavailable");
    for (const text of rendered) {
      expect(new TextEncoder().encode(text).byteLength).toBeLessThanOrEqual(8_192);
      expect(text).not.toContain("MODEL_OUTPUT_SECRET");
      expect(text).not.toContain("prompt-secret");
      expect(text).not.toContain("message-secret");
      expect(text).not.toContain('"details"');
      expect(text).not.toContain('"content"');
    }
  });

  test("await renderer bounds a large inventory without displaying transcript paths", async () => {
    const agents = Array.from({ length: 1_000 }, (_, index) => ({
      agentId: `agent-${index}`,
      state: AgentState.Stopped,
      transcriptPath: `/tmp/${"path/".repeat(500)}${index}.jsonl`,
    }));
    const controller = fakeToolController({ awaitReady: async () => ({ completion: undefined, remainingCompletions: 0, agents, timedOut: false }) });
    const awaitTool = createSubagentTools(controller).await_agent;

    const rendered = awaitTool.renderResult!(await awaitTool.execute({}));

    expect(rendered).toMatch(/^\d+ stopped agents not shown/);
    expect(rendered).not.toContain("transcriptPath");
    expect(rendered).not.toContain("/tmp/path/");
    expect(new TextEncoder().encode(rendered).byteLength).toBeLessThanOrEqual(8_192);
  });

  test("stop projects each successful public outcome without injected fields", async () => {
    const cancelled = { agentId: agentId("agent-a"), runId: runId("deadbeef"), state: "cancelled" } satisfies PublicStopOutcome;
    const alreadyStopped = { agentId: agentId("agent-b"), state: "already_stopped" } satisfies PublicStopOutcome;
    const failed = {
      agentId: agentId("agent-c"),
      state: "failed",
      agentState: AgentState.Stopping,
      error: { code: AgentErrorCode.ContainmentFailed, message: "could not confirm child process termination" },
    } satisfies PublicStopOutcome;
    const controller = fakeToolController({
      stop: async (id: string) => {
        if (id === "agent-a") return { ...cancelled, injected: "secret" };
        if (id === "agent-b") return { ...alreadyStopped, injected: "secret" };
        return { ...failed, injected: "secret" };
      },
    });

    const result = await createSubagentTools(controller).stop_agent.execute({ agentIds: ["agent-a", "agent-b", "agent-c"] });

    expect(result.details).toEqual({ outcomes: [
      { agentId: "agent-a", runId: "deadbeef", state: "cancelled" },
      { agentId: "agent-b", state: "already_stopped" },
      {
        agentId: "agent-c",
        state: "failed",
        agentState: "stopping",
        error: { code: "containment_failed", message: "could not confirm child process termination" },
      },
    ] });
  });

  test("stop is set-valued, preserves duplicates, and isolates invalid members", async () => {
    const calls: string[] = [];
    const controller = fakeToolController({
      stop: async (id: string) => { calls.push(id); return { agentId: id, state: "already_stopped" }; },
    });
    const stop = createSubagentTools(controller).stop_agent;
    const result = await stop.execute({ agentIds: ["agent-a", "!", "agent-a"] });
    expect(result.details).toEqual({ outcomes: [
      { agentId: "agent-a", state: "already_stopped" },
      { agentId: expect.stringMatching(/^invalid-[0-9a-f]{24}$/), state: "failed", error: { code: "invalid_agent", message: "unknown or unowned agent" } },
      { agentId: "agent-a", state: "already_stopped" },
    ] });
    expect(calls).toEqual(["agent-a", "agent-a"]);
  });

  test("stop preserves one bounded failed outcome for every malformed identifier", async () => {
    const huge = "TOP_SECRET".repeat(100_000);
    const tool = createSubagentTools(new SubagentController()).stop_agent;

    const result = await tool.execute({ agentIds: ["", huge, "", huge] });
    const outcomes = (result.details as { outcomes: Array<{ agentId: string; state: string }> }).outcomes;

    expect(outcomes).toHaveLength(4);
    expect(outcomes.map(({ state }) => state)).toEqual(["failed", "failed", "failed", "failed"]);
    expect(outcomes[0]!.agentId).toBe(outcomes[2]!.agentId);
    expect(outcomes[1]!.agentId).toBe(outcomes[3]!.agentId);
    expect(outcomes[0]!.agentId).not.toBe(outcomes[1]!.agentId);
    expect(new TextEncoder().encode(result.content).byteLength).toBeLessThan(2_000);
    expect(result.content).not.toContain("TOP_SECRET");
  });

  for (const name of HOSTILE_TOOL_NAMES) {
    test(`${name} fails closed when a public DTO getter throws`, async () => {
      const secret = `DTO_GETTER_SECRET_${name}`;
      const controller = fakeToolController({
        spawn: async () => Object.defineProperty({}, "state", { get: () => { throw new Error(secret); } }),
        sendInput: async () => Object.defineProperty({}, "state", { get: () => { throw new Error(secret); } }),
        awaitReady: async () => Object.defineProperty({}, "completions", { get: () => { throw new Error(secret); } }),
        stop: async () => Object.defineProperty({}, "state", { get: () => { throw new Error(secret); } }),
      });
      const tools = createSubagentTools(controller);

      const failure = await executeTool(tools, name, HOSTILE_TOOL_CASES[name].validInput)
        .catch((error: Error) => error);

      expect(failure).toBeInstanceOf(Error);
      expect((failure as Error).message).toBe("internal_error: internal agent result is invalid");
      expect((failure as Error).message).not.toContain(secret);
    });
  }

  for (const name of HOSTILE_TOOL_NAMES) {
    test(`${name} fails closed when an input getter throws`, async () => {
      const secret = `INPUT_GETTER_SECRET_${name}`;
      const input = Object.defineProperty({}, HOSTILE_TOOL_CASES[name].inputKey, {
        enumerable: true,
        get: () => { throw new Error(secret); },
      });
      const tools = createSubagentTools(new SubagentController());

      const failure = await executeTool(tools, name, input).catch((error: Error) => error);

      expect(failure).toBeInstanceOf(Error);
      expect((failure as Error).message).toBe("internal_error: internal agent result is invalid");
      expect((failure as Error).message).not.toContain(secret);
    });
  }

  test("tool serialisation fails closed when JSON conversion throws", async () => {
    const controller = fakeToolController({ spawn: async () => ({ agentId: "agent-a", runId: "deadbeef", state: "running" }) });
    const original = JSON.stringify;
    JSON.stringify = () => { throw new Error("JSON_SECRET"); };
    try {
      const failure = await createSubagentTools(controller).spawn_agent.execute({ task: "x" }).catch((error: Error) => error);
      expect(failure).toBeInstanceOf(Error);
      expect((failure as Error).message).toBe("internal_error: internal agent result is invalid");
    } finally {
      JSON.stringify = original;
    }
  });

  test("multi-agent stop starts every valid target concurrently", async () => {
    const entered: string[] = []; const release = deferred<void>();
    const controller = fakeToolController({ stop: async (id: string) => { entered.push(id); await release.promise; return { agentId: id, runId: "deadbeef", state: "cancelled" }; } });
    const operation = createSubagentTools(controller).stop_agent.execute({ agentIds: ["agent-a", "agent-b", "agent-c"] });
    await eventually(() => entered.length === 3);
    expect(entered).toEqual(["agent-a", "agent-b", "agent-c"]);
    release.resolve();
    expect((await operation).details).toEqual({ outcomes: [
      { agentId: "agent-a", runId: "deadbeef", state: "cancelled" },
      { agentId: "agent-b", runId: "deadbeef", state: "cancelled" },
      { agentId: "agent-c", runId: "deadbeef", state: "cancelled" },
    ] });
  });

  test("multi-agent stop preserves duplicate, stopped, running, settling, stopping, failure and invalid outcomes", async () => {
    const outcomes: Record<string, object> = {
      running: { agentId: "running", runId: "deadbeef", state: "cancelled" },
      settling: { agentId: "settling", state: "already_stopped" },
      stopping: { agentId: "stopping", runId: "cafebabe", state: "cancelled" },
      stopped: { agentId: "stopped", state: "already_stopped" },
      failed: { agentId: "failed", runId: "feedface", state: "failed", agentState: "stopping", error: { code: "containment_failed", message: "could not confirm child process termination" } },
    };
    const controller = fakeToolController({ stop: async (id: string) => outcomes[id]! });
    const stop = createSubagentTools(controller).stop_agent;
    const details = (await stop.execute({ agentIds: ["running", "settling", "stopping", "stopped", "failed", "running", "!"] })).details as { outcomes: object[] };
    expect(details.outcomes).toEqual([
      outcomes.running!, outcomes.settling!, outcomes.stopping!, outcomes.stopped!, outcomes.failed!, outcomes.running!,
      { agentId: expect.stringMatching(/^invalid-[0-9a-f]{24}$/), state: "failed", error: { code: "invalid_agent", message: "unknown or unowned agent" } },
    ]);
    expect(JSON.stringify(details).length).toBeLessThan(1_024);
  });
});

function testRecord(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error("expected test record");
  return value as Record<string, unknown>;
}

function testString(value: Record<string, unknown>, key: string): string {
  const item = value[key];
  if (typeof item !== "string") throw new Error(`expected test string ${key}`);
  return item;
}

function schemaDescription(schema: object): string | undefined {
  if (!("description" in schema)) return undefined;
  return typeof schema.description === "string" ? schema.description : undefined;
}

/**
 * Dispatches to one named tool. Each branch casts the untrusted object to that tool's declared
 * input type: this is the documented public-tool trust boundary, and the point of these tests is
 * that a malformed value crossing it fails closed rather than leaking.
 */
function executeTool(tools: SubagentToolRegistry, name: SubagentToolName, input: object) {
  switch (name) {
    case "spawn_agent":
      // Deliberately malformed hostile input: this cast crosses the public-tool trust boundary.
      return tools.spawn_agent.execute(input as SpawnAgentInput);
    case "send_input":
      // Deliberately malformed hostile input: this cast crosses the public-tool trust boundary.
      return tools.send_input.execute(input as SendInputInput);
    case "await_agent":
      // Deliberately malformed hostile input: this cast crosses the public-tool trust boundary.
      return tools.await_agent.execute(input as AwaitAgentInput);
    case "stop_agent":
      // Deliberately malformed hostile input: this cast crosses the public-tool trust boundary.
      return tools.stop_agent.execute(input as StopAgentInput);
  }
}

/** Per-tool fixtures: a well-formed input, and the input key each hostile-getter case attacks. */
const HOSTILE_TOOL_CASES = {
  spawn_agent: { validInput: { task: "x" }, inputKey: "task" },
  send_input: { validInput: { agentId: "agent-a", message: "x" }, inputKey: "agentId" },
  await_agent: { validInput: {}, inputKey: "timeoutMs" },
  stop_agent: { validInput: { agentIds: ["agent-a"] }, inputKey: "agentIds" },
} as const satisfies Record<SubagentToolName, { validInput: object; inputKey: string }>;

const HOSTILE_TOOL_NAMES = Object.keys(HOSTILE_TOOL_CASES) as SubagentToolName[];

async function eventually(condition: () => boolean) { for (let i = 0; i < 100 && !condition(); i++) await Promise.resolve(); expect(condition()).toBeTrue(); }

/**
 * The shared launch transport, specialised for tool tests: the run never settles on its own, and
 * containment resolves to this session's own receipt path.
 */
function runningTransport(session: LaunchSession): LaunchTransport {
  return sharedRunningTransport(session, {
    runtime: testRuntime({ contain: async () => testVerifiedReceiptPath(session.containmentReceiptPath) }),
    waitSettled: () => new Promise<never>(() => {}),
  });
}

function failingTransport(
  session: LaunchSession,
  seam: "ready" | "persistLaunchRequested" | "start" | "getEntriesBefore" | "prompt" | "getEntriesAfter" | "bindRun" | "persistRunStarted",
  thrown: Error,
  containmentError?: Error,
): LaunchTransport {
  const base = sharedRunningTransport(session, {
    runtime: testRuntime({
      contain: async () => {
        if (containmentError !== undefined) throw containmentError;
        return testVerifiedReceiptPath(session.containmentReceiptPath);
      },
    }),
  });
  // Each override throws at exactly one launch seam; everything else delegates to the shared
  // transport. `getEntries` still discriminates on `since` because the two launch calls (before
  // the prompt, and after it) are distinguishable only by that argument.
  return {
    ...base,
    ready: async () => { if (seam === "ready") throw thrown; return base.ready(); },
    persistLaunchRequested: async () => { if (seam === "persistLaunchRequested") throw thrown; },
    start: async () => { if (seam === "start") throw thrown; },
    getEntries: async (since) => {
      if (since === undefined && seam === "getEntriesBefore") throw thrown;
      if (since !== undefined && seam === "getEntriesAfter") throw thrown;
      return base.getEntries(since);
    },
    prompt: async (message) => { if (seam === "prompt") throw thrown; await base.prompt(message); },
    bindRun: () => { if (seam === "bindRun") throw thrown; },
    persistRunStarted: async () => { if (seam === "persistRunStarted") throw thrown; },
    waitSettled: () => new Promise<never>(() => {}),
  };
}
