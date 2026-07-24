import { describe, expect, spyOn, test } from "bun:test";

import { AgentState, truncateUtf8, utf8Bytes } from "../src/domain.ts";
import { CompletionService, completionKey, type AgentSummary } from "../src/completion-service.ts";
import type { AgentCompletion, AgentRunKey } from "../src/domain.ts";
import {
  testAgentId,
  testCommittedOutputPath,
  testRunId,
  testSessionPath,
  testMilliseconds,
} from "./support/brands.ts";

const AGENT = testAgentId("agent-1");
const OTHER_AGENT = testAgentId("agent-2");
const RUN = testRunId("deadbeef");
const SESSION_PATH = testSessionPath();
const OUTPUT_PATH = testCommittedOutputPath();
const COMPLETION_KEY: AgentRunKey = completionKey({ agentId: AGENT, runId: RUN });
// @ts-expect-error arbitrary strings cannot enter the completion publication key set.
const _arbitraryCompletionKey: AgentRunKey = "agent-1\0deadbeef";
void COMPLETION_KEY;
void _arbitraryCompletionKey;

function completion(
  overrides: Partial<Extract<AgentCompletion, { state: "completed" }>> = {},
): Extract<AgentCompletion, { state: "completed" }> {
  return {
    agentId: AGENT,
    runId: RUN,
    state: "completed",
    output: { text: "hello", originalBytes: utf8Bytes(5), retainedBytes: utf8Bytes(5), truncated: false },
    outputPath: OUTPUT_PATH,
    transcriptPath: SESSION_PATH,
    ...overrides,
  } satisfies Extract<AgentCompletion, { state: "completed" }>;
}

function running(agentId = AGENT): AgentSummary {
  return { agentId, state: AgentState.Running, transcriptPath: SESSION_PATH, currentRunId: RUN };
}

describe("CompletionService.receive", () => {
  test("returns immediately with an empty batch when nothing is queued and no run is active", async () => {
    const service = new CompletionService();
    const result = await service.receive();
    expect(result.completions).toEqual([]);
    expect(result.timedOut).toBe(false);
  });

  test("drains everything queued immediately", async () => {
    const service = new CompletionService();
    await service.publish(completion());
    await service.publish(completion({ agentId: OTHER_AGENT }));

    const result = await service.receive();
    expect(result.completions.length).toBe(2);
    expect(result.timedOut).toBe(false);
  });

  test("rejects a second receiver that would block without disturbing the first", async () => {
    const service = new CompletionService();
    service.upsertAgent(running());

    const first = service.receive();
    const second = service.receive();

    await expect(second).rejects.toThrow("invalid_state: agent is not in a valid state for this operation");
    await service.publish(completion());
    await expect(first).resolves.toMatchObject({
      completions: [expect.objectContaining({ runId: RUN })],
      timedOut: false,
    });
    expect(service.queuedCount()).toBe(0);
  });

  test("zero-timeout polling neither claims nor disturbs the blocking waiter", async () => {
    const service = new CompletionService();
    service.upsertAgent(running());

    const waiting = service.receive();
    await expect(service.receive({ timeoutMs: testMilliseconds(0) })).resolves.toMatchObject({
      completions: [],
      timedOut: true,
    });

    await service.publish(completion());
    await expect(waiting).resolves.toMatchObject({ completions: [expect.any(Object)], timedOut: false });
  });

  test("queued completions still drain while another caller is blocked only after publication", async () => {
    const service = new CompletionService();
    service.upsertAgent(running());
    const waiting = service.receive();

    await service.publish(completion());
    const delivered = await waiting;

    expect(delivered.completions).toHaveLength(1);
    await expect(service.receive()).resolves.toMatchObject({ completions: [], timedOut: false });
  });

  test("times out and returns an empty, timed-out batch without consuming later arrivals", async () => {
    const service = new CompletionService();
    service.upsertAgent(running());

    const result = await service.receive({ timeoutMs: testMilliseconds(10) });
    expect(result.completions).toEqual([]);
    expect(result.timedOut).toBe(true);

    await service.publish(completion());
    const next = await service.receive();
    expect(next.completions.length).toBe(1);
  });

  test("timeout cannot clear a later waiter", async () => {
    const service = new CompletionService();
    service.upsertAgent(running());

    await expect(service.receive({ timeoutMs: testMilliseconds(1) })).resolves.toMatchObject({ timedOut: true });
    const later = service.receive();
    await service.publish(completion());

    await expect(later).resolves.toMatchObject({ completions: [expect.any(Object)], timedOut: false });
  });

  test("an aborted waiter cannot clear the waiter installed after it", async () => {
    const service = new CompletionService();
    service.upsertAgent(running());
    const controller = new AbortController();

    const first = service.receive({ signal: controller.signal });
    controller.abort();
    await expect(first).rejects.toBeInstanceOf(Error);

    const later = service.receive();
    await service.publish(completion());
    await expect(later).resolves.toMatchObject({ completions: [expect.any(Object)], timedOut: false });
    expect(service.queuedCount()).toBe(0);
  });

  test("publication before timeout delivers exactly one completion and leaves none queued", async () => {
    const service = new CompletionService();
    service.upsertAgent(running());

    const waiting = service.receive({ timeoutMs: testMilliseconds(10) });
    await service.publish(completion());

    await expect(waiting).resolves.toMatchObject({ completions: [expect.any(Object)], timedOut: false });
    expect(service.queuedCount()).toBe(0);
  });

  test("timeout before publication leaves exactly one completion for the next receiver", async () => {
    const service = new CompletionService();
    service.upsertAgent(running());

    await expect(service.receive({ timeoutMs: testMilliseconds(1) })).resolves.toMatchObject({ completions: [], timedOut: true });
    await service.publish(completion());

    await expect(service.receive()).resolves.toMatchObject({ completions: [expect.any(Object)] });
  });

  test("publication before abort delivers exactly one completion and leaves none queued", async () => {
    const service = new CompletionService();
    service.upsertAgent(running());
    const controller = new AbortController();
    const removeAbortListener = spyOn(controller.signal, "removeEventListener");

    const waiting = service.receive({ signal: controller.signal });
    await service.publish(completion());
    controller.abort();

    await expect(waiting).resolves.toMatchObject({ completions: [expect.any(Object)], timedOut: false });
    expect(removeAbortListener).toHaveBeenCalledWith("abort", expect.any(Function));
    expect(service.queuedCount()).toBe(0);
  });

  test("abort rejects only that waiter and leaves the completion for the next receive", async () => {
    const service = new CompletionService();
    service.upsertAgent(running());
    const controller = new AbortController();
    const waiting = service.receive({ signal: controller.signal });

    controller.abort();
    await expect(waiting).rejects.toBeInstanceOf(Error);
    await service.publish(completion());
    expect(service.queuedCount()).toBe(1);

    await expect(service.receive()).resolves.toMatchObject({ completions: [expect.any(Object)], timedOut: false });
    expect(service.queuedCount()).toBe(0);
  });

  test("an already-aborted signal rejects its installed waiter without disturbing a subsequent waiter", async () => {
    const service = new CompletionService();
    service.upsertAgent(running());
    const controller = new AbortController();
    controller.abort();

    await expect(service.receive({ signal: controller.signal })).rejects.toBeInstanceOf(Error);
    const later = service.receive();
    await service.publish(completion());

    await expect(later).resolves.toMatchObject({ completions: [expect.any(Object)], timedOut: false });
    expect(service.queuedCount()).toBe(0);
  });

  test("drains an immutable clone without aggregate truncation", async () => {
    const service = new CompletionService();
    const original = completion({ output: truncateUtf8("x".repeat(60_000), utf8Bytes(50_000)) });
    await service.publish(original);
    const [drained] = (await service.receive()).completions;
    expect(drained).not.toBe(original);
    expect(drained?.output).not.toBe(original.output);
    expect(drained?.output).toEqual(original.output);
    expect(Number(original.output.retainedBytes)).toBe(50_000);
  });

  test("clones failed errors and nested usage without mutating persisted completions", async () => {
    const service = new CompletionService();
    const usage = { turns: 1, usage: { input: 2, output: 3, cacheRead: 4, cacheWrite: 5, cacheWrite1h: 6, reasoning: 7, totalTokens: 27,
      cost: { input: 1, output: 2, cacheRead: 3, cacheWrite: 4, total: 10 } } };
    const original = {
      ...completion({
        output: truncateUtf8("failed", utf8Bytes(50_000)),
        usage,
      }),
      state: "failed" as const,
      error: { code: "protocol_error" as const, message: "failure" },
    };
    await service.publish(original);

    const [drained] = (await service.receive()).completions;
    if (drained?.state !== "failed") throw new Error("expected failed completion");
    expect(drained).not.toBe(original);
    expect(drained.error).not.toBe(original.error);
    expect(drained.usage).not.toBe(usage);
    expect(drained.usage?.usage).not.toBe(usage.usage);
    expect(drained.usage?.usage.cost).not.toBe(usage.usage.cost);
    expect(drained).toEqual(original);
  });

  test("snapshotAgents includes every owned agent, running or completed", async () => {
    const service = new CompletionService();
    service.upsertAgent(running(OTHER_AGENT));
    await service.publish(completion());

    const agents = service.snapshotAgents();
    expect(agents.map((a) => a.agentId).sort()).toEqual([AGENT, OTHER_AGENT].sort());
  });

  test("starting a later run preserves the separately archived latest completion", async () => {
    const service = new CompletionService();
    await service.publish(completion());

    service.upsertAgent({ ...running(), currentRunId: testRunId("cafebabe") });

    expect(service.snapshotAgents()).toEqual([{
      ...running(), currentRunId: testRunId("cafebabe"),
      latestCompletionState: "completed",
      latestOutputPath: OUTPUT_PATH,
    }]);
  });
});

describe("CompletionService back-ping notification", () => {
  test("same native run ID from two agents is independently published", async () => {
    const service = new CompletionService();
    await Promise.all([service.publish(completion()), service.publish(completion({ agentId: OTHER_AGENT }))]);
    expect((await service.receive()).completions).toHaveLength(2);
  });
  test("publishing the same run is idempotent", async () => {
    const service = new CompletionService();
    await service.publish(completion());
    await service.publish(completion());
    expect(service.queuedCount()).toBe(1);
    expect((await service.receive()).completions).toHaveLength(1);
  });
  test("notifies on an empty-to-non-empty transition with no active receiver", async () => {
    const service = new CompletionService();
    const result = await service.publish(completion());
    expect(result.shouldNotify).toBe(true);
  });

  test("suppresses further notifications while the queue stays non-empty", async () => {
    const service = new CompletionService();
    await service.publish(completion());
    const second = await service.publish(completion({ agentId: OTHER_AGENT }));
    expect(second.shouldNotify).toBe(false);
  });

  test("an active receiver suppresses the notification entirely", async () => {
    const service = new CompletionService();
    service.upsertAgent(running());

    const receivePromise = service.receive();
    const result = await service.publish(completion());

    expect(result.shouldNotify).toBe(false);
    await receivePromise;
  });

  test("draining the queue allows the next empty-to-non-empty transition to notify again", async () => {
    const service = new CompletionService();
    await service.publish(completion());
    await service.receive();

    const result = await service.publish(completion({ agentId: OTHER_AGENT }));
    expect(result.shouldNotify).toBe(true);
  });
});

describe("CompletionService.restore", () => {
  test("restore is sealed once live completion operations begin", async () => {
    const service = new CompletionService();
    await service.receive();
    expect(() => service.restore([])).toThrow("invalid_state");
  });
  test("re-queues each agent's latest completion for duplicate-visibility delivery", async () => {
    const service = new CompletionService();
    expect(service.restore([
      {
        agentId: AGENT,
        state: AgentState.Stopped,
        sessionPath: SESSION_PATH,
        latestCompletion: completion(),
      },
      {
        agentId: OTHER_AGENT,
        state: AgentState.Running,
        sessionPath: SESSION_PATH,
        currentRunId: RUN,
      },
    ])).toBeUndefined();

    expect(service.queuedCount()).toBe(1);
    const result = await service.receive();
    expect(result.completions).toMatchObject([{ agentId: AGENT, runId: RUN }]);
    expect(result.agents.map((a) => a.agentId).sort()).toEqual([AGENT, OTHER_AGENT].sort());
  });
});

