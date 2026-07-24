import { describe, expect, test } from "bun:test";

import {
  AgentEventType, AgentState, RestorationActionType, agentId, modelId,
  utf8Bytes, type CommittedOutputPath, type ModelId, type OutputPath, type ProviderId,
  type RunCompletedPayload, type RunLaunchRequestedPayload, type RunStartedPayload,
  type RunStoppingPayload, type SpawnedPayload, type ToolName,
} from "../src/domain.ts";
import type { ContainmentDescriptor, RestorationContainmentDescriptor } from "../src/containment.ts";
import { absolutePath, containmentReceiptPath, outputPath, sessionPath } from "../src/paths.ts";
import {
  testAgentId, testAttemptId, testCommittedOutputPath, testContainmentAttempt, testModelId,
  testProviderId, testRunId, testToolName,
} from "./support/brands.ts";
import { testBarrier } from "./support/barriers.ts";
import { decodePersistedAgentEvent } from "../src/schemas.ts";
import type { Usage } from "../src/domain.ts";
import {
  AgentEventAppender,
  decodeAgentEvent as decodeAgentEventAtRoot,
  foldAgentEvents as foldAgentEventsAtRoot,
  type DecodedPersistedAgentEvent,
  type FoldedAgentRecord,
  type PendingLaunch,
  type RestorationAction,
  type RestorationRunLaunchRequestedPayloadV2,
} from "../src/persistence.ts";

const AGENT = "a1b2c3d4";
const OTHER_AGENT = "e5f6a7b8";
const RUN = "b2c3d4e5";
const ATTEMPT = "attempt-1";
const STATE_ROOT = absolutePath("/tmp/pi-subagents-test");
const SESSION_PATH = `${STATE_ROOT}/sessions/child.jsonl`;
const CWD = `${STATE_ROOT}/work`;
const RECEIPT_PATH = `${STATE_ROOT}/receipts/run-1.json`;
const OUTPUT_PATH = `${STATE_ROOT}/output/${RUN}.committed`;
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

function spawnedPayload(id = AGENT): SpawnedPayload {
  return {
    agentId: testAgentId(id),
    sessionPath: sessionPath(STATE_ROOT, SESSION_PATH),
    cwd: absolutePath(CWD),
    provider: testProviderId("anthropic"),
    modelId: testModelId("claude-sonnet-5"),
    thinkingLevel: "medium",
    tools: [testToolName("bash"), testToolName("read")],
  };
}

function launchPayload(id = AGENT, attempt = ATTEMPT): RestorationRunLaunchRequestedPayloadV2 {
  return { agentId: testAgentId(id), previousLeafId: null, attemptId: testAttemptId(attempt), containmentReceiptPath: containmentReceiptPath(STATE_ROOT, RECEIPT_PATH), containment: { ...descriptor, scopePath: absolutePath(descriptor.scopePath) } };
}

function liveLaunchPayload(id = AGENT, attempt = ATTEMPT): RunLaunchRequestedPayload {
  return {
    agentId: testAgentId(id),
    previousLeafId: null,
    attemptId: testAttemptId(attempt),
    containmentReceiptPath: containmentReceiptPath(STATE_ROOT, RECEIPT_PATH),
    containment: testContainmentAttempt(testAttemptId(attempt)).descriptor,
  };
}

function startedPayload(id = AGENT, run = RUN): RunStartedPayload {
  return { agentId: testAgentId(id), runId: testRunId(run), attemptId: testAttemptId(ATTEMPT) };
}

function stoppingPayload(id = AGENT, run = RUN): RunStoppingPayload {
  return { agentId: testAgentId(id), runId: testRunId(run), reason: "stop_requested", containmentReceiptPath: containmentReceiptPath(STATE_ROOT, RECEIPT_PATH) };
}

function completedPayload(id = AGENT, run = RUN): RunCompletedPayload {
  return { state: "completed", agentId: testAgentId(id), runId: testRunId(run), output: { text: "done", originalBytes: utf8Bytes(4), retainedBytes: utf8Bytes(4), truncated: false }, outputPath: testCommittedOutputPath({ workDir: absolutePath(`${STATE_ROOT}/output`), runId: testRunId(run) }), transcriptPath: sessionPath(STATE_ROOT, SESSION_PATH) };
}

const baseRecordFixture = { ...spawnedPayload(), state: AgentState.Stopped } satisfies FoldedAgentRecord;
const runFixture = {
  runId: testRunId(RUN), receiptPath: containmentReceiptPath(STATE_ROOT, RECEIPT_PATH),
  attemptId: testAttemptId(ATTEMPT), eventVersion: 1 as const,
};
const v1PayloadFixture = {
  agentId: testAgentId(AGENT), previousLeafId: null, attemptId: testAttemptId(ATTEMPT),
  containmentReceiptPath: containmentReceiptPath(STATE_ROOT, RECEIPT_PATH),
};
// Type-level guards: these constructions must stay illegal.
// @ts-expect-error a running fold record requires its run bundle
const _badRunning: FoldedAgentRecord = { ...baseRecordFixture, state: AgentState.Running };
// @ts-expect-error a stopping fold record requires a stop reason
const _badStopping: FoldedAgentRecord = { ...baseRecordFixture, state: AgentState.Stopping, run: runFixture };
// @ts-expect-error a V1 launch payload cannot claim event version 2
const _badLaunch: PendingLaunch = { payload: v1PayloadFixture, eventVersion: 2 };

function cancelledPayload(id = AGENT, run = RUN): RunCompletedPayload {
  return { state: "cancelled", agentId: testAgentId(id), runId: testRunId(run), reason: "stop_requested", output: { text: "", originalBytes: utf8Bytes(0), retainedBytes: utf8Bytes(0), truncated: false }, outputPath: testCommittedOutputPath({ workDir: absolutePath(`${STATE_ROOT}/output`), runId: testRunId(run) }), transcriptPath: sessionPath(STATE_ROOT, SESSION_PATH) };
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
  test("reconstructs branded spawned identities after primitive DTO validation", () => {
    const decoded = decodeAgentEvent(spawnedEntry().data);
    if (decoded.eventType !== AgentEventType.Spawned) throw new Error("expected spawned event");
    const provider: ProviderId = decoded.payload.provider;
    const model: ModelId = decoded.payload.modelId;
    const tools: readonly ToolName[] = decoded.payload.tools;
    const primitives: readonly string[] = [provider, model, ...tools];
    expect(primitives).toEqual(["anthropic", "claude-sonnet-5", "bash", "read"]);
  });

  test("retains the canonical off thinking level without changing the spawned event shape", () => {
    const value = { ...spawnedEntry().data, payload: { ...spawnedEntry().data.payload, thinkingLevel: "off" } };

    expect(decodeAgentEvent(value).payload).toEqual({
      ...spawnedPayload(),
      thinkingLevel: "off",
    });
  });

  test("decodes a completion destination without claiming durable commitment", () => {
    const decoded = decodeAgentEvent(completedEntry().data, STATE_ROOT);
    if (decoded.eventType !== AgentEventType.RunCompleted) throw new Error("expected completion");
    const candidate: OutputPath = decoded.payload.outputPath;
    // @ts-expect-error DTO decoding cannot establish durable publication.
    const _committed: CommittedOutputPath = decoded.payload.outputPath;
    expect(String(candidate)).toBe(OUTPUT_PATH);
    void _committed;
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
    if (decoded.eventType !== AgentEventType.RunLaunchRequested || decoded.schemaVersion !== 2) {
      throw new Error("expected v2 launch event");
    }
    const stored: RestorationContainmentDescriptor = decoded.payload.containment;
    // @ts-expect-error persisted decoding cannot claim a live canonical cgroup proof.
    const _live: ContainmentDescriptor = stored;
    void _live;
    expect(decoded.payload).toEqual(launchPayload());
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

  test.each([
    ["blank provider", { provider: " " }, /provider id/],
    ["blank model ID", { modelId: " " }, /invalid model id/],
    ["control-character tool", { tools: ["read", "bad\ntool"] }, /tool name/],
  ])("rejects spawned payload with %s", (_label, replacement, message) => {
    const value = {
      ...spawnedEntry().data,
      payload: { ...spawnedEntry().data.payload, ...replacement },
    };
    expect(() => decodeAgentEvent(value, STATE_ROOT)).toThrow(message);
  });

  test("rejects overlong persisted error messages", () => {
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
      prior: { state: AgentState.Running, run: { runId: RUN } },
      pendingAttempt: undefined,
      action: { type: RestorationActionType.ReconcileStarted, attemptId: ATTEMPT, runId: RUN },
    },
  ])("diagnoses $name without mutating prior state or producing the rejected transition's action", ({ entries, prior, pendingAttempt, action }) => {
    const restored = foldAgentEvents(entries);
    const record = restored.agents.get(testAgentId(AGENT));
    expect(record).toMatchObject(prior);
    expect(record?.state === AgentState.Stopped ? record.pendingLaunch?.payload.attemptId : undefined)
      .toBe(pendingAttempt === undefined ? undefined : testAttemptId(pendingAttempt));
    expect(restored.invalidEvents.length).toBeGreaterThan(0);
    expect(restored.invalidEvents.every((message) => Buffer.byteLength(message) <= 10_000)).toBeTrue();
    expect(restored.actions).toHaveLength(1);
    expect(restored.actions[0]).toMatchObject(action);
  });
  test("folds v2 containment ownership through launch, start, and completion without inheritance", () => {
    const first = foldAgentEvents([spawnedEntry(), launchV2Entry()]);
    const firstRecord = first.agents.get(agentId(AGENT));
    const pending = firstRecord?.state === AgentState.Stopped ? firstRecord.pendingLaunch?.payload : undefined;
    expect(pending !== undefined && "containment" in pending ? pending.containment : undefined)
      .toEqual({ ...descriptor, scopePath: absolutePath(descriptor.scopePath) });

    const running = foldAgentEvents([spawnedEntry(), launchV2Entry(), startedEntry()]);
    const runningRecord = running.agents.get(agentId(AGENT));
    expect(runningRecord?.state === AgentState.Stopped ? runningRecord.pendingLaunch : undefined).toBeUndefined();
    expect(runningRecord?.state === AgentState.Running ? runningRecord.run.containment : undefined)
      .toEqual({ ...descriptor, scopePath: absolutePath(descriptor.scopePath) });

    const completed = foldAgentEvents([spawnedEntry(), launchV2Entry(), startedEntry(), completedEntry()]);
    expect(completed.agents.get(agentId(AGENT))?.completion?.containment)
      .toEqual({ ...descriptor, scopePath: absolutePath(descriptor.scopePath) });

    const later = foldAgentEvents([
      spawnedEntry(), launchV2Entry(), startedEntry(), completedEntry(), launchEntry(AGENT, "attempt-2"),
    ]);
    const laterRecord = later.agents.get(agentId(AGENT));
    const laterPending = laterRecord?.state === AgentState.Stopped ? laterRecord.pendingLaunch?.payload : undefined;
    expect(laterPending !== undefined && "containment" in laterPending ? laterPending.containment : undefined).toBeUndefined();
  });

  test("a lone Spawned event produces a stopped agent with no actions", () => {
    const restored = foldAgentEvents([spawnedEntry()]);
    const record = restored.agents.get(testAgentId(AGENT));
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
    const record = restored.agents.get(testAgentId(AGENT));
    expect(record?.state).toBe(AgentState.Stopped);
    expect(record?.completion?.payload.state).toBe("completed");
    const candidate: OutputPath | undefined = record?.completion?.payload.outputPath;
    // @ts-expect-error folding ordered events does not prove durable output publication.
    const _committed: CommittedOutputPath | undefined = record?.completion?.payload.outputPath;
    expect(String(candidate)).toBe(OUTPUT_PATH);
    void _committed;
    expect(restored.invalidEvents).toEqual([]);
    expect(restored.actions).toEqual([
      {
        type: RestorationActionType.ValidateCompletedReceipt,
        agentId: testAgentId(AGENT),
        containmentReceiptPath: containmentReceiptPath(STATE_ROOT, RECEIPT_PATH),
        attemptId: testAttemptId(ATTEMPT),
        eventVersion: 1,
      },
    ]);
  });

  test("a post-launch failure folds RunStarted then failed RunCompleted without RunStopping diagnostics", () => {
    const restored = foldAgentEvents([
      spawnedEntry(),
      launchEntry(),
      startedEntry(),
      failedEntry(),
    ]);

    expect(restored.agents.get(testAgentId(AGENT))).toMatchObject({
      state: AgentState.Stopped,
      completion: { payload: { state: "failed", runId: RUN } },
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
    const record = restored.agents.get(testAgentId(AGENT));
    expect(record?.state).toBe(AgentState.Stopped);
    expect(record?.completion?.payload.state).toBe("cancelled");
    expect(restored.invalidEvents).toEqual([]);
    expect(restored.actions.length).toBe(1);
    expect(restored.actions[0]?.type).toBe(RestorationActionType.ValidateCompletedReceipt);
  });

  test("an unmatched launch (no RunStarted) yields a reconcile_launch action", () => {
    const restored = foldAgentEvents([spawnedEntry(), launchEntry()]);
    expect(restored.actions).toEqual([
      {
        type: RestorationActionType.ReconcileLaunch,
        agentId: testAgentId(AGENT),
        attemptId: testAttemptId(ATTEMPT),
        previousLeafId: null,
        containmentReceiptPath: containmentReceiptPath(STATE_ROOT, RECEIPT_PATH),
        eventVersion: 1,
      },
    ]);
    expect(restored.invalidEvents).toEqual([]);
  });

  test("an unmatched RunStarted (no stop or completion) yields a reconcile_started action", () => {
    const restored = foldAgentEvents([spawnedEntry(), launchEntry(), startedEntry()]);
    expect(restored.actions).toEqual([
      {
        type: RestorationActionType.ReconcileStarted,
        agentId: testAgentId(AGENT),
        runId: testRunId(RUN),
        containmentReceiptPath: containmentReceiptPath(STATE_ROOT, RECEIPT_PATH),
        attemptId: testAttemptId(ATTEMPT),
        eventVersion: 1,
      },
    ]);
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
        agentId: testAgentId(AGENT),
        runId: testRunId(RUN),
        reason: "stop_requested",
        containmentReceiptPath: containmentReceiptPath(STATE_ROOT, RECEIPT_PATH),
        attemptId: testAttemptId(ATTEMPT),
        eventVersion: 1,
      },
    ]);
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
    const record = restored.agents.get(testAgentId(AGENT));
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

    expect(String(restored.agents.get(testAgentId(AGENT))?.sessionPath)).toBe(
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
    expect(restored.agents.get(testAgentId(AGENT))?.state).toBe(AgentState.Stopped);
    expect(restored.agents.get(testAgentId(OTHER_AGENT))?.state).toBe(AgentState.Stopped);
    expect(restored.actions.some((a) => a.agentId === OTHER_AGENT)).toBe(false);
  });
});

describe("AgentEventAppender ordering", () => {
  test("serialises branded spawned identities as unchanged primitive JSON", async () => {
    const written: unknown[] = [];
    const appender = new AgentEventAppender((_type, event) => { written.push(event); });

    await appender.appendSpawned(spawnedPayload());

    expect(JSON.parse(JSON.stringify(written[0]))).toEqual({
      ...spawnedEntry().data,
      schemaVersion: 2,
    });
  });

  test("appends a version 2 launch with its exact containment descriptor", async () => {
    const written: unknown[] = [];
    const appender = new AgentEventAppender((_type, event) => { written.push(event); });

    const payload = liveLaunchPayload();
    await appender.appendRunLaunchRequested(payload);

    expect(written).toEqual([{
      ...launchV2,
      payload: {
        ...launchV2.payload,
        containment: payload.containment,
      },
    }]);
  });

  test("RunStarted append is idempotent across concurrent and later retries", async () => {
    const written: unknown[] = [];
    const appender = new AgentEventAppender((_type, event) => { written.push(event); });
    const started = startedPayload(AGENT, RUN);

    await Promise.all([appender.appendRunStarted(started), appender.appendRunStarted(started)]);
    await appender.appendRunStarted(started);

    expect(written).toHaveLength(1);
  });

  test("same native run ID on two agents appends each completion exactly once", async () => {
    const written: unknown[] = [];
    const appender = new AgentEventAppender((_type, event) => { written.push(event); });
    const a = completedPayload(AGENT, RUN);
    const b = completedPayload(OTHER_AGENT, RUN);
    await Promise.all([appender.appendRunCompleted(a), appender.appendRunCompleted(b), appender.appendRunCompleted(a)]);
    expect(written).toHaveLength(2);
  });
  test("append() calls from concurrent callers are serialized in submission order per caller", async () => {
    const written: DecodedPersistedAgentEvent[] = [];
    const appender = new AgentEventAppender((_customType, data) => {
      written.push(decodeAgentEvent(data, STATE_ROOT));
    });
    const spawnedByA = testBarrier("caller-a-spawned-appended");

    const callerA = async () => {
      await appender.appendSpawned(spawnedPayload(AGENT));
      await spawnedByA.enterAndWait();
      await appender.appendRunLaunchRequested(liveLaunchPayload(AGENT));
    };
    const callerB = async () => {
      await spawnedByA.entered;
      await appender.appendSpawned(spawnedPayload(OTHER_AGENT));
      spawnedByA.release();
    };

    await Promise.all([callerA(), callerB()]);

    expect(written.map(({ eventType, payload }) => `${payload.agentId}:${eventType}`)).toEqual([
      `${AGENT}:${AgentEventType.Spawned}`,
      `${OTHER_AGENT}:${AgentEventType.Spawned}`,
      `${AGENT}:${AgentEventType.RunLaunchRequested}`,
    ]);
    expect(written
      .filter(({ payload }) => payload.agentId === agentId(AGENT))
      .map(({ eventType }) => eventType)).toEqual([
        AgentEventType.Spawned,
        AgentEventType.RunLaunchRequested,
      ]);
  });

  test("withGroup() keeps a multi-event transition contiguous under a concurrent caller", async () => {
    const written: DecodedPersistedAgentEvent[] = [];
    const appender = new AgentEventAppender((_customType, data) => {
      written.push(decodeAgentEvent(data, STATE_ROOT));
    });
    const stoppingAppended = testBarrier("grouped-run-stopping");
    let confirmOtherSpawnQueued!: () => void;
    const otherSpawnQueued = new Promise<void>((resolve) => { confirmOtherSpawnQueued = resolve; });

    const stopThenComplete = appender.withGroup(async (append) => {
      await append(AgentEventType.RunStopping, stoppingPayload());
      await stoppingAppended.enterAndWait();
      await otherSpawnQueued;
      await append(AgentEventType.RunCompleted, cancelledPayload());
    });
    await stoppingAppended.entered;
    const otherSpawn = appender.appendSpawned(spawnedPayload(OTHER_AGENT));
    confirmOtherSpawnQueued();
    stoppingAppended.release();

    await Promise.all([stopThenComplete, otherSpawn]);

    expect(written.map((event) => event.eventType)).toEqual([
      AgentEventType.RunStopping,
      AgentEventType.RunCompleted,
      AgentEventType.Spawned,
    ]);
  });
});
