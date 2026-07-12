import { describe, expect, test } from "bun:test";

import { AgentEventType, AgentState, RestorationActionType, agentId, modelSpec } from "../src/domain.ts";
import { absolutePath, sessionPath } from "../src/paths.ts";
import { decodePersistedAgentEvent } from "../src/schemas.ts";
import type { Usage } from "../src/domain.ts";
import {
  AgentEventAppender,
  decodeAgentEvent as decodeAgentEventAtRoot,
  foldAgentEvents as foldAgentEventsAtRoot,
  type RestorationAction,
} from "../src/persistence.ts";

const AGENT = "a1b2c3d4";
const OTHER_AGENT = "e5f6a7b8";
const RUN = "b2c3d4e5";
const ATTEMPT = "attempt-1";
const SESSION_PATH = "/tmp/pi-subagents/sessions/child.jsonl";
const CWD = "/tmp/pi-subagents/work";
const RECEIPT_PATH = "/tmp/pi-subagents/receipts/run-1.json";
const OUTPUT_PATH = "/tmp/pi-subagents/output/run-1.txt";
const STATE_ROOT = "/tmp/pi-subagents";
const descriptor = {
  backend: "cgroup-v2" as const,
  scopePath: "/tmp/pi-subagents/cgroups/parent/attempt",
};
const launchV2 = {
  schemaVersion: 2,
  eventType: AgentEventType.RunLaunchRequested,
  payload: {
    agentId: AGENT,
    previousLeafId: null,
    attemptId: ATTEMPT,
    containmentReceiptPath: RECEIPT_PATH,
    containment: descriptor,
  },
};
const decodeAgentEvent = (value: unknown, root = STATE_ROOT) => decodeAgentEventAtRoot(value, root);
const foldAgentEvents = (entries: Parameters<typeof foldAgentEventsAtRoot>[0], root = STATE_ROOT) => foldAgentEventsAtRoot(entries, root);

function spawnedEntry(agentId = AGENT) {
  return {
    type: "custom" as const,
    customType: "pi-subagents:event",
    data: {
      schemaVersion: 1,
      eventType: AgentEventType.Spawned,
      payload: {
        agentId,
        sessionPath: SESSION_PATH,
        cwd: CWD,
        provider: "anthropic",
        modelId: "claude-sonnet-5",
        thinkingLevel: "medium",
        tools: ["bash", "read"],
      },
    },
  };
}

function launchEntry(agentId = AGENT, attemptId = ATTEMPT) {
  return {
    type: "custom" as const,
    customType: "pi-subagents:event",
    data: {
      schemaVersion: 1,
      eventType: AgentEventType.RunLaunchRequested,
      payload: {
        agentId,
        previousLeafId: null,
        attemptId,
        containmentReceiptPath: RECEIPT_PATH,
      },
    },
  };
}

function launchV2Entry(agentId = AGENT, attemptId = ATTEMPT) {
  return {
    type: "custom" as const,
    customType: "pi-subagents:event",
    data: {
      ...launchV2,
      payload: { ...launchV2.payload, agentId, attemptId },
    },
  };
}

function startedEntry(agentId = AGENT, runId = RUN, attemptId = ATTEMPT) {
  return {
    type: "custom" as const,
    customType: "pi-subagents:event",
    data: {
      schemaVersion: 1,
      eventType: AgentEventType.RunStarted,
      payload: { agentId, runId, attemptId },
    },
  };
}

function stoppingEntry(agentId = AGENT, runId = RUN) {
  return {
    type: "custom" as const,
    customType: "pi-subagents:event",
    data: {
      schemaVersion: 1,
      eventType: AgentEventType.RunStopping,
      payload: {
        agentId,
        runId,
        reason: "stop_requested",
        containmentReceiptPath: RECEIPT_PATH,
      },
    },
  };
}

function completedEntry(agentId = AGENT, runId = RUN) {
  return {
    type: "custom" as const,
    customType: "pi-subagents:event",
    data: {
      schemaVersion: 1,
      eventType: AgentEventType.RunCompleted,
      payload: {
        state: "completed",
        agentId,
        runId,
        output: { text: "done", originalBytes: 4, retainedBytes: 4, truncated: false },
        outputPath: OUTPUT_PATH,
        transcriptPath: SESSION_PATH,
      },
    },
  };
}

function cancelledEntry(agentId = AGENT, runId = RUN) {
  return {
    type: "custom" as const,
    customType: "pi-subagents:event",
    data: {
      schemaVersion: 1,
      eventType: AgentEventType.RunCompleted,
      payload: {
        state: "cancelled",
        agentId,
        runId,
        reason: "stop_requested",
        output: { text: "", originalBytes: 0, retainedBytes: 0, truncated: false },
        outputPath: OUTPUT_PATH,
        transcriptPath: SESSION_PATH,
      },
    },
  };
}

function failedEntry(agentId = AGENT, runId = RUN) {
  return {
    type: "custom" as const,
    customType: "pi-subagents:event",
    data: {
      schemaVersion: 1,
      eventType: AgentEventType.RunCompleted,
      payload: {
        state: "failed",
        agentId,
        runId,
        error: { code: "process_exited", message: "child process exited unexpectedly" },
        output: { text: "", originalBytes: 0, retainedBytes: 0, truncated: false },
        outputPath: OUTPUT_PATH,
        transcriptPath: SESSION_PATH,
      },
    },
  };
}

describe("persisted completion usage", () => {
  const validUsage: Usage = {
    input: 1200,
    output: 340,
    cacheRead: 800,
    cacheWrite: 500,
    cacheWrite1h: 120,
    reasoning: 96,
    totalTokens: 2340,
    cost: { input: 0.003, output: 0.005, cacheRead: 0.0002, cacheWrite: 0.001, total: 0.0092 },
  };

  const completedEnvelope = (usage: unknown) => ({
    schemaVersion: 1,
    eventType: AgentEventType.RunCompleted,
    payload: { ...completedEntry().data.payload, usage: { turns: 1, usage } },
  });

  test("decodes valid current Pi usage", () => {
    expect(() => decodePersistedAgentEvent(completedEnvelope(validUsage))).not.toThrow();
  });

  test.each([
    ["negative token", (usage: Usage) => ({ ...usage, input: -1 })],
    ["NaN token", (usage: Usage) => ({ ...usage, output: Number.NaN })],
    ["infinite token", (usage: Usage) => ({ ...usage, cacheRead: Number.POSITIVE_INFINITY })],
    ["negative optional", (usage: Usage) => ({ ...usage, reasoning: -1 })],
    ["NaN optional", (usage: Usage) => ({ ...usage, cacheWrite1h: Number.NaN })],
    ["negative cost", (usage: Usage) => ({ ...usage, cost: { ...usage.cost, total: -1 } })],
    ["infinite cost", (usage: Usage) => ({ ...usage, cost: { ...usage.cost, input: Number.POSITIVE_INFINITY } })],
    ["missing totalTokens", (usage: Usage) => {
      const { totalTokens: _totalTokens, ...incomplete } = usage;
      return incomplete;
    }],
    ["missing required cost field", (usage: Usage) => {
      const { cacheWrite: _cacheWrite, ...incompleteCost } = usage.cost;
      return { ...usage, cost: incompleteCost };
    }],
  ] as const)("rejects persisted completion usage with %s", (_label, mutate) => {
    expect(() => decodePersistedAgentEvent(completedEnvelope(mutate(validUsage)))).toThrow(/invalid_input/);
  });
});

describe("decodeAgentEvent", () => {
  test("retains the canonical off thinking level without changing the spawned event shape", () => {
    const value = { ...spawnedEntry().data, payload: { ...spawnedEntry().data.payload, thinkingLevel: "off" } };

    expect(decodeAgentEvent(value).payload).toEqual({
      ...spawnedEntry().data.payload,
      agentId: agentId(AGENT),
      sessionPath: sessionPath(STATE_ROOT, SESSION_PATH),
      cwd: absolutePath(CWD),
      thinkingLevel: "off",
      modelId: modelSpec("claude-sonnet-5"),
    });
  });

  test("round-trips every event type into branded domain values", () => {
    expect(decodeAgentEvent(spawnedEntry().data).eventType).toBe(AgentEventType.Spawned);
    expect(decodeAgentEvent(launchEntry().data).eventType).toBe(
      AgentEventType.RunLaunchRequested,
    );
    expect(decodeAgentEvent(startedEntry().data).eventType).toBe(AgentEventType.RunStarted);
    expect(decodeAgentEvent(stoppingEntry().data).eventType).toBe(AgentEventType.RunStopping);
    expect(decodeAgentEvent(completedEntry().data).eventType).toBe(AgentEventType.RunCompleted);
    expect(decodeAgentEvent(cancelledEntry().data).eventType).toBe(AgentEventType.RunCompleted);
    expect(decodeAgentEvent(failedEntry().data).eventType).toBe(AgentEventType.RunCompleted);
  });

  test("preserves historical version 1 and decodes descriptor-bearing version 2", () => {
    expect(decodeAgentEvent(spawnedEntry().data).schemaVersion).toBe(1);
    const decoded = decodeAgentEvent(launchV2);
    expect(decoded.schemaVersion).toBe(2);
    expect(decoded.eventType).toBe(AgentEventType.RunLaunchRequested);
    expect(decoded.payload).toEqual({
      ...launchV2.payload,
      agentId: agentId(AGENT),
      containmentReceiptPath: RECEIPT_PATH,
      containment: { ...descriptor, scopePath: absolutePath(descriptor.scopePath) },
    } as never);
  });

  test.each([
    ["extra descriptor key", { ...launchV2, payload: { ...launchV2.payload, containment: { ...descriptor, extra: true } } }],
    ["missing backend", { ...launchV2, payload: { ...launchV2.payload, containment: { scopePath: descriptor.scopePath } } }],
    ["wrong backend", { ...launchV2, payload: { ...launchV2.payload, containment: { ...descriptor, backend: "pgid" } } }],
    ["relative scope path", { ...launchV2, payload: { ...launchV2.payload, containment: { ...descriptor, scopePath: "relative/scope" } } }],
    ["v2 launch without containment", { ...launchEntry().data, schemaVersion: 2 }],
    ["v1 launch with containment", { ...launchEntry().data, payload: { ...launchEntry().data.payload, containment: descriptor } }],
  ])("rejects %s", (_label, malformed) => {
    expect(() => decodeAgentEvent(malformed)).toThrow(/invalid_input/);
  });

  test("rejects an unknown schema version", () => {
    const malformed = { ...spawnedEntry().data, schemaVersion: 99 };
    expect(() => decodeAgentEvent(malformed)).toThrow(/invalid_input/);
  });

  test("rejects a payload mismatched with its event type", () => {
    const malformed = { ...spawnedEntry().data, eventType: AgentEventType.RunStarted };
    expect(() => decodeAgentEvent(malformed)).toThrow(/invalid_input/);
  });

  test("rejects a non-object value", () => {
    expect(() => decodeAgentEvent("not an event")).toThrow(/invalid_input/);
    expect(() => decodeAgentEvent(null)).toThrow(/invalid_input/);
  });

  test.each([
    ["session path", () => ({ ...spawnedEntry().data, payload: { ...spawnedEntry().data.payload, sessionPath: "/tmp/outside.jsonl" } })],
    ["receipt path", () => ({ ...launchEntry().data, payload: { ...launchEntry().data.payload, containmentReceiptPath: "/tmp/outside.receipt" } })],
    ["output path", () => ({ ...completedEntry().data, payload: { ...completedEntry().data.payload, outputPath: "/tmp/outside.txt" } })],
  ])("rejects a persisted %s outside the branch state root", (_label, value) => {
    expect(() => decodeAgentEvent(value(), STATE_ROOT)).toThrow(/escapes|contained/);
  });

  test.each([
    ["retained byte mismatch", { text: "£", originalBytes: 2, retainedBytes: 1, truncated: true }],
    ["impossible truncation", { text: "done", originalBytes: 4, retainedBytes: 4, truncated: true }],
    ["oversized retained output", { text: "x".repeat(50_001), originalBytes: 50_001, retainedBytes: 50_001, truncated: false }],
  ])("rejects completion output with %s", (_label, output) => {
    const value = { ...completedEntry().data, payload: { ...completedEntry().data.payload, output } };
    expect(() => decodeAgentEvent(value, STATE_ROOT)).toThrow(/invalid_input/);
  });

  test("rejects empty restored model IDs and overlong persisted error messages", () => {
    const spawnedValue = { ...spawnedEntry().data, payload: { ...spawnedEntry().data.payload, modelId: " " } };
    expect(() => decodeAgentEvent(spawnedValue, STATE_ROOT)).toThrow(/model spec/);
    const failed = failedEntry();
    const failedValue = { ...failed.data, payload: { ...failed.data.payload,
      error: { ...failed.data.payload.error, message: "£".repeat(5_001) } } };
    expect(() => decodeAgentEvent(failedValue, STATE_ROOT)).toThrow(/invalid_input/);
  });
});

describe("foldAgentEvents", () => {
  test("a path-invalid event rejects the complete agent record and emits a bounded diagnostic", () => {
    const hostile = { ...completedEntry().data, payload: { ...completedEntry().data.payload, outputPath: "/tmp/escape" } };
    const restored = foldAgentEvents([spawnedEntry(), launchEntry(), startedEntry(),
      { type: "custom", customType: "pi-subagents:event", data: hostile }], STATE_ROOT);
    expect(restored.agents.size).toBe(0);
    expect(restored.actions).toEqual([]);
    expect(Buffer.byteLength(restored.invalidEvents[0]!)).toBeLessThanOrEqual(10_000);
  });

  test.each([
    {
      name: "overlapping RunLaunchRequested",
      entries: [spawnedEntry(), launchEntry(), launchEntry(AGENT, "attempt-2")],
      prior: { state: AgentState.Stopped },
      pendingAttempt: ATTEMPT,
      action: { type: RestorationActionType.ReconcileLaunch, attemptId: ATTEMPT },
    },
    {
      name: "mismatched attemptId",
      entries: [spawnedEntry(), launchEntry(), startedEntry(AGENT, RUN, "attempt-2")],
      prior: { state: AgentState.Stopped },
      pendingAttempt: ATTEMPT,
      action: { type: RestorationActionType.ReconcileLaunch, attemptId: ATTEMPT },
    },
    {
      name: "RunStarted while the agent is non-stopped",
      entries: [spawnedEntry(), launchEntry(), startedEntry(), launchEntry(AGENT, "attempt-2"),
        startedEntry(AGENT, "c3d4e5f6", "attempt-2")],
      prior: { state: AgentState.Running, currentRunId: RUN },
      pendingAttempt: undefined,
      action: { type: RestorationActionType.ReconcileStarted, attemptId: ATTEMPT, runId: RUN },
    },
  ])("diagnoses $name without mutating prior state or producing the rejected transition's action", ({ entries, prior, pendingAttempt, action }) => {
    const restored = foldAgentEvents(entries);
    const record = restored.agents.get(AGENT as never);
    expect(record).toMatchObject(prior);
    expect(record?.pendingLaunch?.attemptId as string | undefined).toBe(pendingAttempt);
    expect(restored.invalidEvents.length).toBeGreaterThan(0);
    expect(restored.invalidEvents.every((message) => Buffer.byteLength(message) <= 10_000)).toBeTrue();
    expect(restored.actions).toHaveLength(1);
    expect(restored.actions[0]).toMatchObject(action);
  });
  test("folds v2 containment ownership through launch, start, and completion without inheritance", () => {
    const first = foldAgentEvents([spawnedEntry(), launchV2Entry()]);
    const pending = first.agents.get(agentId(AGENT))?.pendingLaunch;
    expect(pending !== undefined && "containment" in pending ? pending.containment : undefined)
      .toEqual({ ...descriptor, scopePath: absolutePath(descriptor.scopePath) });

    const running = foldAgentEvents([spawnedEntry(), launchV2Entry(), startedEntry()]);
    expect(running.agents.get(agentId(AGENT))?.pendingLaunch).toBeUndefined();
    expect(running.agents.get(agentId(AGENT))?.currentContainment)
      .toEqual({ ...descriptor, scopePath: absolutePath(descriptor.scopePath) });

    const completed = foldAgentEvents([spawnedEntry(), launchV2Entry(), startedEntry(), completedEntry()]);
    expect(completed.agents.get(agentId(AGENT))?.latestCompletionContainment)
      .toEqual({ ...descriptor, scopePath: absolutePath(descriptor.scopePath) });

    const later = foldAgentEvents([
      spawnedEntry(), launchV2Entry(), startedEntry(), completedEntry(), launchEntry(AGENT, "attempt-2"),
    ]);
    const laterPending = later.agents.get(agentId(AGENT))?.pendingLaunch;
    expect(laterPending !== undefined && "containment" in laterPending ? laterPending.containment : undefined).toBeUndefined();
  });

  test("a lone Spawned event produces a stopped agent with no actions", () => {
    const restored = foldAgentEvents([spawnedEntry()]);
    const record = restored.agents.get(AGENT as never);
    expect(record?.state).toBe(AgentState.Stopped);
    expect(restored.actions).toEqual([]);
    expect(restored.invalidEvents).toEqual([]);
  });

  test("a completed run yields a stopped agent with a validate-receipt action", () => {
    const restored = foldAgentEvents([
      spawnedEntry(),
      launchEntry(),
      startedEntry(),
      completedEntry(),
    ]);
    const record = restored.agents.get(AGENT as never);
    expect(record?.state).toBe(AgentState.Stopped);
    expect(record?.latestCompletion?.state).toBe("completed");
    expect(restored.invalidEvents).toEqual([]);
    expect(restored.actions).toEqual([
      {
        type: RestorationActionType.ValidateCompletedReceipt,
        agentId: AGENT,
        containmentReceiptPath: RECEIPT_PATH,
        attemptId: ATTEMPT,
        eventVersion: 1,
      },
    ] as unknown as RestorationAction[]);
  });

  test("a post-launch failure folds RunStarted then failed RunCompleted without RunStopping diagnostics", () => {
    const restored = foldAgentEvents([
      spawnedEntry(),
      launchEntry(),
      startedEntry(),
      failedEntry(),
    ]);

    expect(restored.agents.get(AGENT as never)).toMatchObject({
      state: AgentState.Stopped,
      latestCompletion: { state: "failed", runId: RUN },
    });
    expect(restored.invalidEvents).toEqual([]);
    expect(restored.actions).toEqual([
      expect.objectContaining({ type: RestorationActionType.ValidateCompletedReceipt, agentId: AGENT }),
    ]);
  });

  test("a cancelled run via RunStopping yields a stopped agent with a validate-receipt action", () => {
    const restored = foldAgentEvents([
      spawnedEntry(),
      launchEntry(),
      startedEntry(),
      stoppingEntry(),
      cancelledEntry(),
    ]);
    const record = restored.agents.get(AGENT as never);
    expect(record?.state).toBe(AgentState.Stopped);
    expect(record?.latestCompletion?.state).toBe("cancelled");
    expect(restored.invalidEvents).toEqual([]);
    expect(restored.actions.length).toBe(1);
    expect(restored.actions[0]?.type).toBe(RestorationActionType.ValidateCompletedReceipt);
  });

  test("an unmatched launch (no RunStarted) yields a reconcile_launch action", () => {
    const restored = foldAgentEvents([spawnedEntry(), launchEntry()]);
    expect(restored.actions).toEqual([
      {
        type: RestorationActionType.ReconcileLaunch,
        agentId: AGENT,
        attemptId: ATTEMPT,
        previousLeafId: null,
        containmentReceiptPath: RECEIPT_PATH,
        eventVersion: 1,
      },
    ] as unknown as RestorationAction[]);
    expect(restored.invalidEvents).toEqual([]);
  });

  test("an unmatched RunStarted (no stop or completion) yields a reconcile_started action", () => {
    const restored = foldAgentEvents([spawnedEntry(), launchEntry(), startedEntry()]);
    expect(restored.actions).toEqual([
      {
        type: RestorationActionType.ReconcileStarted,
        agentId: AGENT,
        runId: RUN,
        containmentReceiptPath: RECEIPT_PATH,
        attemptId: ATTEMPT,
        eventVersion: 1,
      },
    ] as unknown as RestorationAction[]);
    expect(restored.invalidEvents).toEqual([]);
  });

  test("an unmatched RunStopping (no completion) yields a reconcile_stopping action", () => {
    const restored = foldAgentEvents([
      spawnedEntry(),
      launchEntry(),
      startedEntry(),
      stoppingEntry(),
    ]);
    expect(restored.actions).toEqual([
      {
        type: RestorationActionType.ReconcileStopping,
        agentId: AGENT,
        runId: RUN,
        reason: "stop_requested",
        containmentReceiptPath: RECEIPT_PATH,
        attemptId: ATTEMPT,
        eventVersion: 1,
      },
    ] as unknown as RestorationAction[]);
    expect(restored.invalidEvents).toEqual([]);
  });

  test("a duplicate terminal event for an already-stopped agent is diagnosed and ignored", () => {
    const restored = foldAgentEvents([
      spawnedEntry(),
      launchEntry(),
      startedEntry(),
      completedEntry(),
      completedEntry(),
    ]);
    const record = restored.agents.get(AGENT as never);
    expect(record?.state).toBe(AgentState.Stopped);
    expect(restored.invalidEvents.length).toBe(1);
  });

  test("an abandoned branch (events for an agent with no Spawned event) never gains ownership", () => {
    const restored = foldAgentEvents([launchEntry(), startedEntry(), completedEntry()]);
    expect(restored.agents.size).toBe(0);
    expect(restored.invalidEvents.length).toBe(3);
    expect(restored.actions).toEqual([]);
  });

  test("a malformed schema version becomes a bounded diagnostic, not a thrown error", () => {
    const malformed = {
      type: "custom" as const,
      customType: "pi-subagents:event",
      data: { ...spawnedEntry().data, schemaVersion: 99 },
    };
    const restored = foldAgentEvents([malformed]);
    expect(restored.agents.size).toBe(0);
    expect(restored.invalidEvents.length).toBe(1);
  });

  test("non-custom and differently-typed custom entries are ignored", () => {
    const restored = foldAgentEvents([
      { type: "message" },
      { type: "custom", customType: "other-extension:event", data: { anything: true } },
      spawnedEntry(),
    ]);
    expect(restored.agents.size).toBe(1);
    expect(restored.invalidEvents).toEqual([]);
  });

  test("folds the full branch, including a Spawned event older than firstKeptEntryId", () => {
    const fullBranchWithPreCompactionSpawn = [
      spawnedEntry(),
      launchEntry(),
      startedEntry(),
      {
        type: "compaction" as const,
        summary: "…",
        firstKeptEntryId: "ffffffff",
        tokensBefore: 1000,
      },
      completedEntry(),
    ];

    const restored = foldAgentEvents(fullBranchWithPreCompactionSpawn);

    expect(restored.agents.get(AGENT as never)?.sessionPath as unknown as string).toBe(
      SESSION_PATH,
    );
    expect(restored.invalidEvents).toEqual([]);
  });

  test("two independent agents on the same branch are folded independently", () => {
    const restored = foldAgentEvents([
      spawnedEntry(AGENT),
      spawnedEntry(OTHER_AGENT),
      launchEntry(AGENT),
      startedEntry(AGENT),
      completedEntry(AGENT),
    ]);
    expect(restored.agents.get(AGENT as never)?.state).toBe(AgentState.Stopped);
    expect(restored.agents.get(OTHER_AGENT as never)?.state).toBe(AgentState.Stopped);
    expect(restored.actions.some((a) => a.agentId === OTHER_AGENT)).toBe(false);
  });
});

describe("AgentEventAppender ordering", () => {
  test("appends a version 2 launch with its exact containment descriptor", async () => {
    const written: unknown[] = [];
    const appender = new AgentEventAppender((_type, event) => { written.push(event); });

    await appender.appendRunLaunchRequested({
      ...launchV2.payload,
      agentId: agentId(AGENT),
      attemptId: ATTEMPT as never,
      containmentReceiptPath: RECEIPT_PATH as never,
      containment: { ...descriptor, scopePath: absolutePath(descriptor.scopePath) },
    });

    expect(written).toEqual([launchV2]);
  });

  test("RunStarted append is idempotent across concurrent and later retries", async () => {
    const written: unknown[] = [];
    const appender = new AgentEventAppender((_type, event) => { written.push(event); });
    const started = startedEntry(AGENT, RUN).data.payload as never;

    await Promise.all([appender.appendRunStarted(started), appender.appendRunStarted(started)]);
    await appender.appendRunStarted(started);

    expect(written).toHaveLength(1);
  });

  test("same native run ID on two agents appends each completion exactly once", async () => {
    const written: unknown[] = [];
    const appender = new AgentEventAppender((_type, event) => { written.push(event); });
    const a = completedEntry(AGENT, RUN).data.payload as never;
    const b = completedEntry(OTHER_AGENT, RUN).data.payload as never;
    await Promise.all([appender.appendRunCompleted(a), appender.appendRunCompleted(b), appender.appendRunCompleted(a)]);
    expect(written).toHaveLength(2);
  });
  test("append() calls from concurrent callers are serialized in submission order per caller", async () => {
    const written: unknown[] = [];
    const appender = new AgentEventAppender((_customType, data) => {
      written.push(data);
    });

    const callerA = async () => {
      await appender.appendSpawned(spawnedEntry(AGENT).data.payload as never);
      await appender.appendRunLaunchRequested(launchEntry(AGENT).data.payload as never);
    };
    const callerB = async () => {
      await appender.appendSpawned(spawnedEntry(OTHER_AGENT).data.payload as never);
    };

    await Promise.all([callerA(), callerB()]);

    expect(written.length).toBe(3);
  });

  test("withGroup() keeps a multi-event transition contiguous under a concurrent caller", async () => {
    const written: Array<{ eventType: string }> = [];
    const appender = new AgentEventAppender((_customType, data) => {
      written.push(data as { eventType: string });
    });

    const stopThenComplete = appender.withGroup(async (append) => {
      await append(AgentEventType.RunStopping, stoppingEntry().data.payload as never);
      await new Promise((resolve) => setTimeout(resolve, 1));
      await append(AgentEventType.RunCompleted, cancelledEntry().data.payload as never);
    });
    const otherSpawn = appender.appendSpawned(spawnedEntry(OTHER_AGENT).data.payload as never);

    await Promise.all([stopThenComplete, otherSpawn]);

    const stopIndex = written.findIndex((e) => e.eventType === AgentEventType.RunStopping);
    const completeIndex = written.findIndex((e) => e.eventType === AgentEventType.RunCompleted);
    expect(completeIndex).toBe(stopIndex + 1);
  });
});
