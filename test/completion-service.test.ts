import { describe, expect, spyOn, test } from "bun:test";

import { AgentState } from "../src/domain.ts";
import { CompletionService, type AgentSummary } from "../src/completion-service.ts";
import type { AgentCompletion } from "../src/domain.ts";

const AGENT = "agent-1" as never;
const OTHER_AGENT = "agent-2" as never;
const RUN = "run-1" as never;
const SESSION_PATH = "/tmp/pi-subagents/sessions/child.jsonl" as never;
const OUTPUT_PATH = "/tmp/pi-subagents/output/run-1.txt" as never;

function completion(overrides: Partial<AgentCompletion> = {}): AgentCompletion {
  return {
    agentId: AGENT,
    runId: RUN,
    state: "completed",
    output: { text: "hello", originalBytes: 5 as never, retainedBytes: 5 as never, truncated: false },
    outputPath: OUTPUT_PATH,
    transcriptPath: SESSION_PATH,
    ...overrides,
  } as AgentCompletion;
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

    await expect(second).rejects.toThrow("invalid_state: receive_agent is already waiting");
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
    await expect(service.receive({ timeoutMs: 0 as never })).resolves.toMatchObject({
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

    const result = await service.receive({ timeoutMs: 10 as never });
    expect(result.completions).toEqual([]);
    expect(result.timedOut).toBe(true);

    await service.publish(completion());
    const next = await service.receive();
    expect(next.completions.length).toBe(1);
  });

  test("timeout cannot clear a later waiter", async () => {
    const service = new CompletionService();
    service.upsertAgent(running());

    await expect(service.receive({ timeoutMs: 1 as never })).resolves.toMatchObject({ timedOut: true });
    const later = service.receive();
    await service.publish(completion());

    await expect(later).resolves.toMatchObject({ completions: [expect.any(Object)], timedOut: false });
  });

  test("abort cannot clear a later waiter", async () => {
    const service = new CompletionService();
    service.upsertAgent(running());
    const controller = new AbortController();

    const first = service.receive({ signal: controller.signal });
    controller.abort();
    await expect(first).rejects.toBeInstanceOf(Error);

    const later = service.receive();
    await service.publish(completion());
    await expect(later).resolves.toMatchObject({ completions: [expect.any(Object)], timedOut: false });
  });

  test("publication before timeout delivers exactly one completion and leaves none queued", async () => {
    const service = new CompletionService();
    service.upsertAgent(running());

    const waiting = service.receive({ timeoutMs: 10 as never });
    await service.publish(completion());

    await expect(waiting).resolves.toMatchObject({ completions: [expect.any(Object)], timedOut: false });
    expect(service.queuedCount()).toBe(0);
  });

  test("timeout before publication leaves exactly one completion for the next receiver", async () => {
    const service = new CompletionService();
    service.upsertAgent(running());

    await expect(service.receive({ timeoutMs: 1 as never })).resolves.toMatchObject({ completions: [], timedOut: true });
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

  test("abort before publication leaves the completion for the next receiver", async () => {
    const service = new CompletionService();
    service.upsertAgent(running());
    const controller = new AbortController();
    const waiting = service.receive({ signal: controller.signal });

    controller.abort();
    await expect(waiting).rejects.toBeInstanceOf(Error);
    await service.publish(completion());

    await expect(service.receive()).resolves.toMatchObject({ completions: [expect.any(Object)] });
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
  });

  test("recomputes retainedBytes/truncated against the aggregate budget in queue order", async () => {
    const service = new CompletionService(10);
    await service.publish(
      completion({
        agentId: AGENT,
        output: { text: "0123456789", originalBytes: 10 as never, retainedBytes: 10 as never, truncated: false },
      }),
    );
    await service.publish(
      completion({
        agentId: OTHER_AGENT,
        output: { text: "abcdefghij", originalBytes: 10 as never, retainedBytes: 10 as never, truncated: false },
      }),
    );

    const result = await service.receive();
    expect(result.completions[0]?.output.text).toBe("0123456789");
    expect(result.completions[0]?.output.truncated).toBe(false);
    expect(result.completions[1]?.output.text).toBe("");
    expect(result.completions[1]?.output.truncated).toBe(true);
  });

  test("never mutates the persisted completion object", async () => {
    const service = new CompletionService(3);
    const original = completion({
      output: { text: "hello", originalBytes: 5 as never, retainedBytes: 5 as never, truncated: false },
    });
    await service.publish(original);

    const result = await service.receive();
    expect(result.completions[0]).not.toBe(original);
    expect(original.output.truncated).toBe(false);
    expect(original.output.text).toBe("hello");
  });

  test("aggregate rebudget preserves persisted original size and truncation history", async () => {
    const persisted = completion({
      output: { text: "x".repeat(50_000), originalBytes: 100_000 as never, retainedBytes: 50_000 as never, truncated: true },
    });
    const fullAllowance = new CompletionService(50_000);
    await fullAllowance.publish(persisted);
    const fullyAdmitted = (await fullAllowance.receive()).completions[0]!.output;
    expect(fullyAdmitted.text).toBe("x".repeat(50_000));
    expect(fullyAdmitted.originalBytes).toBe(100_000 as never);
    expect(fullyAdmitted.retainedBytes).toBe(50_000 as never);
    expect(fullyAdmitted.truncated).toBeTrue();

    const laterTruncation = new CompletionService(20_000);
    await laterTruncation.publish(persisted);
    const rebudgeted = (await laterTruncation.receive()).completions[0]!.output;
    expect(rebudgeted.text).toBe("x".repeat(20_000));
    expect(rebudgeted.originalBytes).toBe(100_000 as never);
    expect(rebudgeted.retainedBytes).toBe(20_000 as never);
    expect(rebudgeted.truncated).toBeTrue();
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

    service.upsertAgent({ ...running(), currentRunId: "cafebabe" as never });

    expect(service.snapshotAgents()).toEqual([{
      ...running(), currentRunId: "cafebabe" as never,
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
    const restoreResult = service.restore([
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
    ]);

    expect(restoreResult.backPingCount).toBe(1);
    const result = await service.receive();
    expect(result.completions.length).toBe(1);
    expect(result.agents.map((a) => a.agentId).sort()).toEqual([AGENT, OTHER_AGENT].sort());
  });
});

