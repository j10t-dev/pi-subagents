import { describe, expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Type } from "typebox";

import { createPiSubagentsExtension, type ExtensionController } from "../index.ts";
import { CompletionService } from "../src/completion-service.ts";
import { SubagentController, type LaunchSession, type LaunchTransport } from "../src/controller.ts";
import {
  MAX_AGGREGATE_RECEIVE_BYTES,
  MAX_COMPLETION_OUTPUT_BYTES,
  MAX_ERROR_MESSAGE_BYTES,
  MAX_RPC_RECORD_BYTES,
  MAX_STDERR_TAIL_BYTES,
} from "../src/constants.ts";
import { AgentErrorCode, AgentState, CompletionState, modelSpec, runId, terminalFailureCause, toAgentError, truncateUtf8, verifiedContainmentReceiptPath } from "../src/domain.ts";
import { BoundedJsonlDecoder } from "../src/jsonl.ts";
import { OutputStore } from "../src/output-store.ts";
import { RpcRunClient } from "../src/rpc-client.ts";
import { createSubagentTools } from "../src/tools.ts";
import { UIForwarder } from "../src/ui-forwarder.ts";
import { containmentReceiptPath, diagnosticsPath, outputPath as outputPathIn, sessionPath } from "../src/paths.ts";
import {
  testAbsolutePath, testAgentId, testAttemptId, testCommittedOutputPath,
  testSessionPath,
} from "./support/brands.ts";
import { extensionApiForTest, lifecycleOn, type ExtensionApiPort } from "./support/extension-api.ts";

const FAKE_CHILD = join(import.meta.dir, "fixtures", "fake-rpc-child.mjs");

/** The probe stands in for an unrelated host tool, so it carries its own schema. */
const parentProbeSchema = Type.Object({
  question: Type.String({ description: "Anything the parent should echo back." }),
});
const TEST_SELECTION = Object.freeze({
  model: modelSpec("mock-provider/luna"),
  thinkingLevel: "high" as const,
  tools: Object.freeze(["read"]),
});

describe("context safety", () => {
  test("tens of MiB of one ordinary record never exceed the 16 MiB decoder allocation", () => {
    let oversized = 0;
    const decoder = new BoundedJsonlDecoder({ maxRecordBytes: MAX_RPC_RECORD_BYTES, onRecord: () => {},
      onOversize: () => { oversized += 1; }, onDecodeError: () => {} });
    const chunk = new Uint8Array(1024 * 1024).fill(0x61);
    let peak = 0;
    for (let index = 0; index < 24; index++) {
      decoder.push(chunk);
      peak = Math.max(peak, decoder.retainedAllocationBytes);
    }
    decoder.push(Uint8Array.of(0x0a));
    expect(peak).toBeLessThanOrEqual(MAX_RPC_RECORD_BYTES);
    expect(oversized).toBe(1);
    expect(decoder.pendingBytes).toBe(0);
  });

  test("one receive batch retains at most 50 KB and the service remains usable", async () => {
    const service = new CompletionService();
    for (const [index, id] of ["deadbeef", "cafebabe"].entries()) {
      await service.publish({ agentId: testAgentId(`context-${index}`), runId: runId(id), state: CompletionState.Completed,
        output: truncateUtf8("x".repeat(MAX_COMPLETION_OUTPUT_BYTES), MAX_COMPLETION_OUTPUT_BYTES),
        outputPath: testCommittedOutputPath(`/tmp/pi-subagents-test/output/${id}.output`),
        transcriptPath: testSessionPath(`/tmp/pi-subagents-test/sessions/${id}.jsonl`) });
    }
    const first = await service.receive();
    expect(first.completions.reduce((bytes, item) => bytes + item.output.retainedBytes, 0)).toBe(MAX_AGGREGATE_RECEIVE_BYTES);
    expect((await service.receive()).completions).toEqual([]);
  });

  test("published safety limits retain their exact operator contract", () => {
    expect({ output: MAX_COMPLETION_OUTPUT_BYTES, error: MAX_ERROR_MESSAGE_BYTES, stderr: MAX_STDERR_TAIL_BYTES })
      .toEqual({ output: 50_000, error: 10_000, stderr: 50_000 });
  });

  test("cumulative message updates and a huge tool result retain bounded authoritative output", async () => {
    const fixture = fakeClient("context-cumulative");
    try {
      fixture.client.start();
      const id = runId("aaaaaaaa");
      fixture.client.bindRun(id);
      await fixture.client.prompt("flood");
      await expect(fixture.client.waitSettled()).resolves.toMatchObject({ reason: "agent_settled", stopReason: "stop" });
      expect(fixture.store.currentOutput(id)).toEqual({
        output: expect.objectContaining({ text: "authoritative after cumulative flood", retainedBytes: 36 }),
        transportIncomplete: false,
      });
      expect(Buffer.byteLength(fixture.store.getDiagnosticsTail())).toBeLessThanOrEqual(MAX_ERROR_MESSAGE_BYTES);
      expect(fixture.store.getDiagnosticsTail()).toContain("oversized rpc record");
    } finally { await fixture.close(); }
  }, 30_000);

  test("oversized UI and malformed output are contained with bounded non-secret diagnostics", async () => {
    for (const scenario of ["oversized-ui", "malformed"] as const) {
      const fixture = fakeClient(scenario);
      try {
        fixture.client.start();
        await fixture.client.prompt("break transport");
        await expect(fixture.client.waitSettled()).resolves.toEqual({ reason: "process_exited", code: null, signal: null,
          failureCause: terminalFailureCause(AgentErrorCode.ProtocolError) });
        const diagnostic = fixture.store.getDiagnosticsTail();
        expect(Buffer.byteLength(diagnostic)).toBeLessThanOrEqual(MAX_ERROR_MESSAGE_BYTES);
        expect(diagnostic).not.toContain("u".repeat(1_000));
      } finally { await fixture.close(); }
    }
  }, 30_000);

  test("large stderr remains within its public tail limit", async () => {
    const fixture = fakeClient("stderr-single-chunk");
    try {
      fixture.client.start();
      await fixture.client.prompt("stderr");
      await fixture.client.waitSettled();
      const tail = fixture.store.getStderrTail();
      expect(Buffer.byteLength(tail)).toBeLessThanOrEqual(MAX_STDERR_TAIL_BYTES);
      expect(tail.endsWith("NEWEST-STDERR-END")).toBeTrue();
    } finally { await fixture.close(); }
  }, 30_000);

  test("hostile child failures remain durable through controller receive and do not brick parent tools or later children", async () => {
    const fixture = hostileController();
    const provider = await providerHarness(fixture.controller);
    try {
      for (const scenario of ["oversized-ui", "captured-transport-exception"] as const) {
        const started = await fixture.controller.spawn({ task: scenario });
        expect(started.state).toBe(AgentState.Running);
        if (!("runId" in started)) throw new Error("hostile child did not acquire a run identity");
        const received = await provider.dispatch("receive_agent", { timeoutMs: 10_000 });
        expect(received.content).toHaveLength(1);
        const modelText = received.content[0]!.text;
        expect(Buffer.byteLength(modelText)).toBeLessThanOrEqual(MAX_AGGREGATE_RECEIVE_BYTES);
        const modelDetails = receiveDetails(requireRecord(JSON.parse(modelText)));
        expect(modelDetails.completions).toMatchObject([{ agentId: started.agentId, runId: started.runId,
          state: CompletionState.Failed }]);
        const details = receiveDetails(received.details);
        expect(details.completions).toHaveLength(1);
        expect(details.completions.reduce((bytes, item) => bytes + outputBytes(item), 0))
          .toBeLessThanOrEqual(MAX_AGGREGATE_RECEIVE_BYTES);
        const failed = details.completions[0]!;
        expect(failed).toMatchObject({ agentId: started.agentId, runId: started.runId, state: CompletionState.Failed });
        expect(existsSync(requireString(failed, "outputPath"))).toBeTrue();
        expect(existsSync(requireString(failed, "transcriptPath"))).toBeTrue();
        const error = requireRecord(failed.error);
        const diagnosticPath = requireString(error, "diagnosticsPath");
        expect(existsSync(diagnosticPath)).toBeTrue();
        expect(Buffer.byteLength(requireString(error, "message"))).toBeLessThanOrEqual(MAX_ERROR_MESSAGE_BYTES);
        for (const key of ["outputPath", "transcriptPath"] as const) {
          expect(Buffer.byteLength(requireString(failed, key))).toBeLessThanOrEqual(4_096);
        }
      }

      const probe = await provider.dispatch("parent_probe", {});
      expect(probe).toEqual({ content: [{ type: "text", text: "parent tool remains callable" }], details: { ok: true } });

      const healthy = await fixture.controller.spawn({ task: "normal" });
      if (!("runId" in healthy)) throw new Error("healthy child did not acquire a run identity");
      const after = await provider.dispatch("receive_agent", { timeoutMs: 10_000 });
      expect(Buffer.byteLength(after.content[0]!.text)).toBeLessThanOrEqual(MAX_AGGREGATE_RECEIVE_BYTES);
      const afterDetails = receiveDetails(after.details);
      expect(afterDetails.completions).toMatchObject([{ agentId: healthy.agentId, runId: healthy.runId, state: CompletionState.Completed }]);
      expect(requireRecord(afterDetails.completions[0]!.output).text).toBe("hello world");
      expect(receiveDetails((await provider.dispatch("receive_agent", {})).details).completions).toEqual([]);
    } finally { await provider.close(); await fixture.close(); }
  }, 30_000);
});

function hostileController(): {
  controller: SubagentController;
  close(): Promise<void>;
} {
  const root = mkdtempSync(join(tmpdir(), "pi-context-controller-"));
  const clients = new Set<RpcRunClient>();
  const stores = new Map<string, OutputStore>();
  let sequence = 0;
  const controller = new SubagentController({ composition: {
    prepareSpawn: async (input) => {
      const ordinal = sequence++;
      const id = testAgentId(`hostile-${ordinal}`);
      const nativeRunId = runId(`${ordinal + 1}`.padStart(8, "0"));
      // This suite writes real files under a per-test OS temp root, so paths validate against it.
      const transcriptPath = sessionPath(root, `${id}.jsonl`);
      writeFileSync(transcriptPath, `${JSON.stringify({ type: "session", id })}\n`);
      const session: LaunchSession = { agentId: id, transcriptPath, previousLeafId: null,
        attemptId: testAttemptId(`attempt-${ordinal}`), containmentReceiptPath: containmentReceiptPath(root, `${id}.receipt`) };
      return {
        selection: TEST_SELECTION,
        createSession: async () => session,
        persistSpawned: async () => {},
        createLaunch: async (_session, surrender) => {
          const transport = hostileLaunch(root, input.task, session, nativeRunId, clients, stores);
          surrender(transport.runtime);
          return transport;
        },
      };
    },
    prepareSend: async () => { throw new Error("unused"); },
    finaliseRun: async (record, settlement) => {
      const store = stores.get(record.agentId);
      if (store === undefined || record.runId === undefined) throw new Error("missing hostile output store");
      const output = store.currentOutput(record.runId).output;
      const outputPath = outputPathIn(root, `${record.agentId}-${record.runId}.output`);
      writeFileSync(outputPath, output.text);
      if (settlement.kind === "completed") return { agentId: record.agentId, runId: record.runId, state: CompletionState.Completed,
        output, outputPath: testCommittedOutputPath(outputPath, root), transcriptPath: record.transcriptPath };
      const diagnostic = store.getDiagnosticsTail() + store.getStderrTail();
      const diagnosticPath = diagnosticsPath(root, `${record.agentId}-${record.runId}.diagnostic`);
      writeFileSync(diagnosticPath, diagnostic);
      return { agentId: record.agentId, runId: record.runId, state: CompletionState.Failed,
        error: toAgentError(undefined, AgentErrorCode.ProtocolError, diagnosticPath), output,
        outputPath: testCommittedOutputPath(outputPath, root), transcriptPath: record.transcriptPath };
    },
  } });
  return { controller, close: async () => {
    await controller.shutdown();
    await Promise.all([...clients].map((client) => client.shutdown().catch(() => undefined)));
    rmSync(root, { recursive: true, force: true });
  } };
}

interface ProviderToolResult {
  content: Array<{ type: "text"; text: string }>;
  details: object;
}

async function providerHarness(controller: SubagentController): Promise<{
  dispatch(name: string, input: object): Promise<ProviderToolResult>;
  close(): Promise<void>;
}> {
  type RegisteredTool = { execute(
    toolCallId: string,
    input: object,
    signal: AbortSignal,
    update: undefined,
    context: object,
  ): Promise<ProviderToolResult> };
  function registerTestTool(tools: Map<string, RegisteredTool>): ExtensionApiPort["registerTool"] {
    // `registerTool` is generic over each tool's parameter schema, so no concrete function type is
    // assignable to it; this probe only needs the tool's name and executor.
    return ((tool: { name: string; execute: RegisteredTool["execute"] }) => tools.set(tool.name, tool)) as unknown as ExtensionApiPort["registerTool"];
  }
  const tools = new Map<string, RegisteredTool>();
  const handlers = new Map<string, Array<(event: object, context: object) => Promise<void> | void>>();
  const api = {
    registerTool: registerTestTool(tools),
    on: lifecycleOn(handlers),
    appendEntry: () => {},
    sendMessage: () => {},
    getThinkingLevel: () => "high",
    getActiveTools: () => [],
  } satisfies ExtensionApiPort;
  api.registerTool({
    name: "parent_probe", label: "Parent probe", description: "Test parent availability", parameters: parentProbeSchema,
    execute: async () => ({ content: [{ type: "text", text: "parent tool remains callable" }], details: { ok: true } }),
  });
  const adapter: ExtensionController = {
    restore: () => controller.restore(), shutdown: () => controller.shutdown(), status: () => controller.status(),
    tools: () => createSubagentTools(controller), beforeTree: () => controller.beforeTree(),
    beforeSwitch: () => controller.beforeSwitch(), beforeFork: () => controller.beforeFork(),
  };
  createPiSubagentsExtension({ platform: "linux", child: false,
    createController: () => adapter, diagnostic: () => {} })(extensionApiForTest(api));
  const context = { ui: { setStatus: () => {} } };
  for (const handler of handlers.get("session_start") ?? []) await handler({ type: "session_start", reason: "startup" }, context);
  return {
    dispatch: async (name, input) => {
      const registered = tools.get(name);
      if (registered === undefined) throw new Error(`missing registered tool ${name}`);
      return registered.execute("provider-call", input, new AbortController().signal, undefined, context);
    },
    close: async () => {
      for (const handler of handlers.get("session_shutdown") ?? []) await handler({ type: "session_shutdown", reason: "quit" }, context);
    },
  };
}

function receiveDetails(value: object): { completions: Record<string, unknown>[] } {
  const record = requireRecord(value);
  if (!Array.isArray(record.completions) || !record.completions.every(isRecord)) throw new Error("invalid receive details");
  return { completions: record.completions };
}

function outputBytes(completion: Record<string, unknown>): number {
  const output = requireRecord(completion.output);
  const retained = output.retainedBytes;
  if (typeof retained !== "number") throw new Error("invalid retained output bytes");
  return retained;
}

function requireRecord(value: unknown): Record<string, unknown> {
  if (!isRecord(value)) throw new Error("expected record");
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requireString(record: Record<string, unknown>, key: string): string {
  const value = record[key];
  if (typeof value !== "string") throw new Error(`expected string ${key}`);
  return value;
}

function hostileLaunch(
  root: string,
  scenario: string,
  session: LaunchSession,
  nativeRunId: ReturnType<typeof runId>,
  clients: Set<RpcRunClient>,
  stores: Map<string, OutputStore>,
): LaunchTransport {
  const store = new OutputStore({ workDir: join(root, `store-${session.agentId}`) });
  const child = spawn(process.execPath, [FAKE_CHILD], { cwd: root,
    env: { ...process.env, FAKE_RPC_SCENARIO: scenario }, stdio: ["pipe", "pipe", "pipe"] });
  const client = new RpcRunClient({
    launchTransport: async () => ({ stdin: child.stdin, stdout: child.stdout, stderr: child.stderr,
      exited: new Promise((resolve) => child.once("exit", (code, signal) => resolve({ code, signal }))),
      terminate: () => { child.kill(); } }),
    outputStore: store,
    uiForwarder: new UIForwarder({ hasUI: false, ui: {
      select: async () => undefined, confirm: async () => false, input: async () => undefined, editor: async () => undefined,
      notify: () => {}, setStatus: () => {}, setWidget: () => {},
    } }),
    agentId: session.agentId,
    runAttemptId: session.attemptId,
  });
  clients.add(client);
  stores.set(session.agentId, store);
  let queried = false;
  let assignment = "";
  return {
    runtime: { abort: async () => { await client.abort(); }, contain: async () => {
      await client.shutdown();
      // The session receipt is already validated against this suite's temp root.
      return verifiedContainmentReceiptPath(session.containmentReceiptPath);
    } },
    containment: { backend: "cgroup-v2" as const, scopePath: testAbsolutePath("/tmp/test-cgroup/attempt") },
    ready: async () => {}, persistLaunchRequested: async () => {}, persistRunStarted: async () => {},
    start: async () => { client.start(); },
    getEntries: async () => queried
      ? { entries: [{ type: "message", id: nativeRunId, message: { role: "user", content: assignment } }], leafId: nativeRunId }
      : (queried = true, { entries: [], leafId: null }),
    prompt: async (message) => { assignment = message; await client.prompt(message); }, waitForAgentStart: () => client.waitForAgentStart(), bindRun: (id) => client.bindRun(id), waitSettled: () => client.waitSettled(),
  };
}

function fakeClient(scenario: string): { client: RpcRunClient; store: OutputStore; close: () => Promise<void> } {
  // Bun defers disposal of closed child-process epoll handles across this large process suite.
  Bun.gc(true);
  const dir = mkdtempSync(join(tmpdir(), "pi-context-safety-"));
  const store = new OutputStore({ workDir: dir });
  const child = spawn(process.execPath, [FAKE_CHILD], {
    cwd: dir, env: { ...process.env, FAKE_RPC_SCENARIO: scenario }, stdio: ["pipe", "pipe", "pipe"],
  });
  const client = new RpcRunClient({
    launchTransport: async () => ({ stdin: child.stdin, stdout: child.stdout, stderr: child.stderr,
      exited: new Promise((resolve) => child.once("exit", (code, signal) => resolve({ code, signal }))),
      terminate: () => { child.kill(); } }),
    outputStore: store,
    uiForwarder: new UIForwarder({ hasUI: false, ui: {
      select: async () => undefined, confirm: async () => false, input: async () => undefined, editor: async () => undefined,
      notify: () => {}, setStatus: () => {}, setWidget: () => {},
    } }),
    agentId: testAgentId(`context-${scenario}`), runAttemptId: testAttemptId(`attempt-${scenario}`),
  });
  return { client, store, close: async () => { await client.shutdown(); rmSync(dir, { recursive: true, force: true }); } };
}
