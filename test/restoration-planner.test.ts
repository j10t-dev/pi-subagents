import { expect, test } from "bun:test";
import {
  AgentErrorCode,
  AgentState,
  CancellationReason,
  RestorationActionType,
  type AgentId,
  type RunId,
} from "../src/domain.ts";
import {
  foldAgentEvents,
  type FoldedAgentRecord,
  type PendingLaunch,
  type RestorationAction,
  type RestoredRegistry,
} from "../src/persistence.ts";
import {
  planRestoration,
  type AgentRestorationEvidence,
  type PlannedAgentRecord,
  type StagedRestorePlan,
} from "../src/restoration.ts";
import type { RunRecord, RunRuntime } from "../src/run-controller.ts";
import {
  testAbsolutePath,
  testAgentId,
  testAttemptId,
  testEntryId,
  testModelId,
  testProviderId,
  testReceiptPath,
  testRunId,
  testSessionPath,
  testToolName,
  testVerifiedReceiptPath,
} from "./support/brands.ts";
import { completedCompletion } from "./support/messages.ts";
import { completedEntry, launchEntry, spawnedEntry, startedEntry } from "./support/restoration.ts";

const AGENT = testAgentId("agent-a");
const RUN = testRunId("deadbeef");
const PREVIOUS_RUN = testRunId("cafebabe");
const ATTEMPT = testAttemptId("attempt-1");
const REASON = CancellationReason.ParentShutdown;
const launchFixture: PendingLaunch = {
  payload: {
    agentId: AGENT, previousLeafId: testEntryId("aaaaaaaa"), attemptId: ATTEMPT,
    containmentReceiptPath: testReceiptPath(),
    containment: { backend: "cgroup-v2", scopePath: testAbsolutePath("/tmp/cgroup/attempt-1") },
  },
  eventVersion: 2,
};
// @ts-expect-error a Settling planner record requires a native runId
const _badSettling: PlannedAgentRecord = { ...baseStopped(), state: AgentState.Settling, pendingLaunch: launchFixture };

function runtime(): RunRuntime {
  return {
    abort: async () => {},
    contain: async () => testVerifiedReceiptPath(),
  };
}

function baseStopped(agentId: AgentId = AGENT): Extract<FoldedAgentRecord, { state: typeof AgentState.Stopped }> {
  return {
    agentId,
    sessionPath: testSessionPath(`/tmp/pi-subagents-test/sessions/${agentId}.jsonl`),
    cwd: testAbsolutePath("/tmp/pi-subagents-test"),
    provider: testProviderId(),
    modelId: testModelId(),
    thinkingLevel: "high",
    tools: [testToolName()],
    state: AgentState.Stopped,
  };
}

function completionRecord(agentId: AgentId = AGENT): Extract<FoldedAgentRecord, { state: typeof AgentState.Stopped }> {
  const record = baseStopped(agentId);
  return {
    ...record,
    completion: {
      payload: completedCompletion({ agentId, runId: RUN, transcriptPath: record.sessionPath }),
      receiptPath: testReceiptPath(),
      attemptId: ATTEMPT,
      containment: { backend: "cgroup-v2", scopePath: testAbsolutePath("/tmp/cgroup/attempt-1") },
      eventVersion: 2,
    },
  };
}

function launchRecord(agentId: AgentId = AGENT): Extract<FoldedAgentRecord, { state: typeof AgentState.Stopped }> {
  const record = completionRecord(agentId);
  return {
    ...record,
    pendingLaunch: {
      payload: {
        agentId, previousLeafId: testEntryId("aaaaaaaa"), attemptId: ATTEMPT,
        containmentReceiptPath: testReceiptPath(),
        containment: { backend: "cgroup-v2", scopePath: testAbsolutePath("/tmp/cgroup/attempt-1") },
      },
      eventVersion: 2,
    },
  };
}

function startedRecord(agentId: AgentId = AGENT): Extract<FoldedAgentRecord, { state: typeof AgentState.Running }> {
  return {
    ...baseStopped(agentId),
    state: AgentState.Running,
    run: {
      runId: RUN, receiptPath: testReceiptPath(), attemptId: ATTEMPT,
      containment: { backend: "cgroup-v2", scopePath: testAbsolutePath("/tmp/cgroup/attempt-1") },
      eventVersion: 2,
    },
  };
}

function stoppingRecord(agentId: AgentId = AGENT): Extract<FoldedAgentRecord, { state: typeof AgentState.Stopping }> {
  const record = startedRecord(agentId);
  return {
    agentId: record.agentId, sessionPath: record.sessionPath, cwd: record.cwd,
    provider: record.provider, modelId: record.modelId, thinkingLevel: record.thinkingLevel, tools: record.tools,
    state: AgentState.Stopping, run: record.run, stopReason: REASON,
    ...(record.completion === undefined ? {} : { completion: record.completion }),
  };
}

function launchAction(agentId: AgentId = AGENT): RestorationAction {
  return {
    type: RestorationActionType.ReconcileLaunch,
    agentId,
    attemptId: ATTEMPT,
    previousLeafId: testEntryId("aaaaaaaa"),
    containmentReceiptPath: testReceiptPath(),
    descriptor: { backend: "cgroup-v2", scopePath: testAbsolutePath("/tmp/cgroup/attempt-1") },
    eventVersion: 2,
  };
}

function startedAction(agentId: AgentId = AGENT): RestorationAction {
  return {
    type: RestorationActionType.ReconcileStarted,
    agentId,
    runId: RUN,
    containmentReceiptPath: testReceiptPath(),
    attemptId: ATTEMPT,
    descriptor: { backend: "cgroup-v2", scopePath: testAbsolutePath("/tmp/cgroup/attempt-1") },
    eventVersion: 2,
  };
}

function stoppingAction(agentId: AgentId = AGENT): RestorationAction {
  return {
    type: RestorationActionType.ReconcileStopping,
    agentId,
    runId: RUN,
    reason: REASON,
    containmentReceiptPath: testReceiptPath(),
    attemptId: ATTEMPT,
    descriptor: { backend: "cgroup-v2", scopePath: testAbsolutePath("/tmp/cgroup/attempt-1") },
    eventVersion: 2,
  };
}

function completedAction(agentId: AgentId = AGENT): RestorationAction {
  return {
    type: RestorationActionType.ValidateCompletedReceipt,
    agentId,
    containmentReceiptPath: testReceiptPath(),
    attemptId: ATTEMPT,
    descriptor: { backend: "cgroup-v2", scopePath: testAbsolutePath("/tmp/cgroup/attempt-1") },
    eventVersion: 2,
  };
}

function registry(record: FoldedAgentRecord, action?: RestorationAction): RestoredRegistry {
  return {
    agents: new Map([[record.agentId, record]]),
    actions: action === undefined ? [] : [action],
    invalidEvents: [],
  };
}

function contained(runRuntime: RunRuntime): AgentRestorationEvidence {
  return { containment: { kind: "contained", runtime: runRuntime }, launchIdentity: { kind: "not-applicable" } };
}

function containedLaunch(runRuntime: RunRuntime, launchIdentity: AgentRestorationEvidence["launchIdentity"]): AgentRestorationEvidence {
  return { containment: { kind: "contained", runtime: runRuntime }, launchIdentity };
}

function uncontained(runRuntime: RunRuntime): AgentRestorationEvidence {
  return { containment: { kind: "uncontained", runtime: runRuntime }, launchIdentity: { kind: "not-applicable" } };
}

function historical(runRuntime: RunRuntime): AgentRestorationEvidence {
  return { containment: { kind: "historical-unresolved", runtime: runRuntime }, launchIdentity: { kind: "not-applicable" } };
}

function withoutCompletion(
  record: Extract<FoldedAgentRecord, { state: typeof AgentState.Stopped }>,
): Extract<FoldedAgentRecord, { state: typeof AgentState.Stopped }> {
  const { completion: _completion, ...rest } = record;
  return rest;
}

function stopped(record: FoldedAgentRecord): PlannedAgentRecord {
  return {
    agentId: record.agentId, sessionPath: record.sessionPath, cwd: record.cwd,
    provider: record.provider, modelId: record.modelId, thinkingLevel: record.thinkingLevel, tools: record.tools,
    state: AgentState.Stopped,
    ...(record.completion === undefined ? {} : { completion: record.completion }),
  };
}

function active(record: FoldedAgentRecord, runId: RunId, state: typeof AgentState.Settling | typeof AgentState.Stopping): PlannedAgentRecord {
  return {
    agentId: record.agentId, sessionPath: record.sessionPath, cwd: record.cwd,
    provider: record.provider, modelId: record.modelId, thinkingLevel: record.thinkingLevel, tools: record.tools,
    state, runId,
    ...(record.state === AgentState.Stopped && record.pendingLaunch !== undefined ? { pendingLaunch: record.pendingLaunch } : {}),
  };
}

function preNative(record: Extract<FoldedAgentRecord, { state: typeof AgentState.Stopped }>, keepCompletion: boolean): PlannedAgentRecord {
  if (record.pendingLaunch === undefined) throw new Error("launch required");
  return {
    agentId: record.agentId, sessionPath: record.sessionPath, cwd: record.cwd,
    provider: record.provider, modelId: record.modelId, thinkingLevel: record.thinkingLevel, tools: record.tools,
    state: AgentState.Stopping, pendingLaunch: record.pendingLaunch,
    ...(keepCompletion && record.completion !== undefined ? { completion: record.completion } : {}),
  };
}

function runRecord(
  record: PlannedAgentRecord,
  runRuntime?: RunRuntime,
  responsibility?: "pre-native" | "historical-unresolved",
  restoredTerminalObligation?: true,
): RunRecord {
  return {
    agentId: record.agentId,
    state: record.state,
    transcriptPath: record.sessionPath,
    ...(record.state === AgentState.Stopped || record.runId === undefined ? {} : { runId: record.runId }),
    ...(runRuntime === undefined ? {} : { runtime: runRuntime }),
    ...(responsibility === undefined ? {} : { containmentResponsibility: responsibility }),
    ...(restoredTerminalObligation === undefined ? {} : { restoredTerminalObligation }),
  };
}

function expectPlan(actual: StagedRestorePlan, expected: StagedRestorePlan): void {
  expect(actual.restored).toEqual(expected.restored);
  expect(actual.runtimeRecords).toEqual(expected.runtimeRecords);
  expect(actual.durableWrites).toEqual(expected.durableWrites);
  expect(actual.obligations).toEqual(expected.obligations);
  expect(actual.warnings).toEqual(expected.warnings);
}

function plan(record: FoldedAgentRecord, action: RestorationAction | undefined, evidence?: AgentRestorationEvidence): StagedRestorePlan {
  return planRestoration(registry(record, action), evidence === undefined ? new Map() : new Map([[record.agentId, evidence]]));
}

test("plans an empty restored registry", () => {
  expectPlan(planRestoration({ agents: new Map(), actions: [], invalidEvents: [] }, new Map()), {
    restored: [], runtimeRecords: [], durableWrites: [], obligations: new Map(), warnings: [],
  });
});

test("row 1: no action, stopped Spawned remains unchanged without evidence lookup", () => {
  class EvidenceLookupForbidden extends Map<AgentId, AgentRestorationEvidence> {
    override get(_agentId: AgentId): AgentRestorationEvidence | undefined {
      throw new Error("evidence must not be read");
    }
  }
  const record = baseStopped();
  expectPlan(planRestoration(registry(record), new EvidenceLookupForbidden()), {
    restored: [record], runtimeRecords: [runRecord(record)], durableWrites: [], obligations: new Map(), warnings: [],
  });
});

test("a crashed relaunch of a completed agent with a failed lookup restores pre-native (delta 6)", () => {
  const registry = foldAgentEvents([
    spawnedEntry(),
    launchEntry(),
    startedEntry(),
    completedEntry(),
    launchEntry({ attemptId: testAttemptId("attempt-2") }),
  ], testAbsolutePath("/tmp/pi-subagents-test"));
  const evidence: AgentRestorationEvidence = {
    containment: { kind: "contained", runtime: runtime() },
    launchIdentity: { kind: "lookup-failed" },
  };
  const staged = planRestoration(registry, new Map([[testAgentId(), evidence]]));
  expect(staged.restored[0]).toMatchObject({ state: AgentState.Stopping });
  expect(staged.runtimeRecords[0]).toMatchObject({
    containmentResponsibility: "pre-native",
    restoredTerminalObligation: true,
  });
  expect(staged.runtimeRecords[0]?.runId).toBeUndefined();
  expect(staged.warnings).toEqual([testAgentId()]);
});

test("row 2: ReconcileLaunch + contained/no-run removes pending launch", () => {
  const record = launchRecord();
  const restored = stopped(record);
  const runRuntime = runtime();
  expectPlan(plan(record, launchAction(), containedLaunch(runRuntime, { kind: "no-run" })), {
    restored: [restored], runtimeRecords: [runRecord(restored)], durableWrites: [], obligations: new Map(), warnings: [],
  });
});

test("row 3: ReconcileLaunch + contained/run-found plans interrupted finalisation and RunStarted", () => {
  const record = launchRecord();
  const runRuntime = runtime();
  const restored = active(record, RUN, AgentState.Settling);
  const settlement = { kind: "interrupted" as const };
  expectPlan(plan(record, launchAction(), containedLaunch(runRuntime, { kind: "run-found", runId: RUN })), {
    restored: [restored],
    runtimeRecords: [runRecord(restored, runRuntime)],
    durableWrites: [{ record, runId: RUN, settlement }],
    obligations: new Map([[AGENT, { kind: "finalise", record, settlement, start: { runId: RUN, attemptId: ATTEMPT } }]]),
    warnings: [],
  });
});

test("row 4: ReconcileLaunch + contained/lookup-failed retains pre-native responsibility without RunStarted", () => {
  const record = launchRecord();
  const runRuntime = runtime();
  const restored = preNative(record, true);
  const settlement = { kind: "interrupted" as const };
  expectPlan(plan(record, launchAction(), containedLaunch(runRuntime, { kind: "lookup-failed" })), {
    restored: [restored],
    runtimeRecords: [runRecord(restored, runRuntime, "pre-native", true)],
    durableWrites: [],
    obligations: new Map([[AGENT, { kind: "finalise", record, settlement }]]),
    warnings: [AGENT],
  });
});

test("row 5: ReconcileLaunch + uncontained discards completion and retains pre-native responsibility without RunStarted", () => {
  const record = launchRecord();
  const runRuntime = runtime();
  const restored = preNative(withoutCompletion(record), false);
  const settlement = { kind: "interrupted" as const };
  expectPlan(plan(record, launchAction(), uncontained(runRuntime)), {
    restored: [restored],
    runtimeRecords: [runRecord(restored, runRuntime, "pre-native", true)],
    durableWrites: [],
    obligations: new Map([[AGENT, { kind: "finalise", record, settlement }]]),
    warnings: [AGENT],
  });
});

test("row 6: ReconcileLaunch + historical-unresolved preserves historical responsibility without RunStarted", () => {
  const record = launchRecord();
  const runRuntime = runtime();
  const restored = preNative(withoutCompletion(record), false);
  const settlement = { kind: "interrupted" as const };
  expectPlan(plan(record, launchAction(), historical(runRuntime)), {
    restored: [restored],
    runtimeRecords: [runRecord(restored, runRuntime, "historical-unresolved", true)],
    durableWrites: [],
    obligations: new Map([[AGENT, { kind: "finalise", record, settlement }]]),
    warnings: [AGENT],
  });
});

test("row 7: ReconcileStarted + contained plans interrupted finalisation", () => {
  const record = startedRecord();
  const runRuntime = runtime();
  const restored = active(record, RUN, AgentState.Settling);
  const settlement = { kind: "interrupted" as const };
  expectPlan(plan(record, startedAction(), contained(runRuntime)), {
    restored: [restored], runtimeRecords: [runRecord(restored, runRuntime)],
    durableWrites: [{ record, runId: RUN, settlement }],
    obligations: new Map([[AGENT, { kind: "finalise", record, settlement }]]), warnings: [],
  });
});

test("row 8: ReconcileStarted + uncontained plans obligation without intent", () => {
  const record = startedRecord();
  const runRuntime = runtime();
  const restored = active(record, RUN, AgentState.Settling);
  const settlement = { kind: "interrupted" as const };
  expectPlan(plan(record, startedAction(), uncontained(runRuntime)), {
    restored: [restored], runtimeRecords: [runRecord(restored, runRuntime)], durableWrites: [],
    obligations: new Map([[AGENT, { kind: "finalise", record, settlement }]]), warnings: [AGENT],
  });
});

test("row 9: ReconcileStarted + historical-unresolved adds historical responsibility", () => {
  const record = startedRecord();
  const runRuntime = runtime();
  const restored = active(record, RUN, AgentState.Settling);
  const settlement = { kind: "interrupted" as const };
  expectPlan(plan(record, startedAction(), historical(runRuntime)), {
    restored: [restored], runtimeRecords: [runRecord(restored, runRuntime, "historical-unresolved")], durableWrites: [],
    obligations: new Map([[AGENT, { kind: "finalise", record, settlement }]]), warnings: [AGENT],
  });
});

test("row 10: ReconcileStopping + contained uses persisted cancellation reason", () => {
  const record = stoppingRecord();
  const runRuntime = runtime();
  const restored = active(record, RUN, AgentState.Stopping);
  const settlement = { kind: "cancelled" as const, reason: REASON };
  expectPlan(plan(record, stoppingAction(), contained(runRuntime)), {
    restored: [restored], runtimeRecords: [runRecord(restored, runRuntime)],
    durableWrites: [{ record, runId: RUN, settlement }],
    obligations: new Map([[AGENT, { kind: "finalise", record, settlement }]]), warnings: [],
  });
});

test("row 11: ReconcileStopping + uncontained retains persisted cancellation obligation", () => {
  const record = stoppingRecord();
  const runRuntime = runtime();
  const restored = active(record, RUN, AgentState.Stopping);
  const settlement = { kind: "cancelled" as const, reason: REASON };
  expectPlan(plan(record, stoppingAction(), uncontained(runRuntime)), {
    restored: [restored], runtimeRecords: [runRecord(restored, runRuntime)], durableWrites: [],
    obligations: new Map([[AGENT, { kind: "finalise", record, settlement }]]), warnings: [AGENT],
  });
});

test("row 12: ReconcileStopping + historical-unresolved adds historical responsibility", () => {
  const record = stoppingRecord();
  const runRuntime = runtime();
  const restored = active(record, RUN, AgentState.Stopping);
  const settlement = { kind: "cancelled" as const, reason: REASON };
  expectPlan(plan(record, stoppingAction(), historical(runRuntime)), {
    restored: [restored], runtimeRecords: [runRecord(restored, runRuntime, "historical-unresolved")], durableWrites: [],
    obligations: new Map([[AGENT, { kind: "finalise", record, settlement }]]), warnings: [AGENT],
  });
});

test("row 13: ValidateCompletedReceipt + contained preserves stopped completion and its proof obligation", () => {
  const record = completionRecord();
  const runRuntime = runtime();
  expectPlan(plan(record, completedAction(), contained(runRuntime)), {
    restored: [record], runtimeRecords: [runRecord(record)], durableWrites: [],
    obligations: new Map([[AGENT, { kind: "restore-completion", record }]]), warnings: [],
  });
});

test("row 14: ValidateCompletedReceipt + uncontained removes completion and retains original retry record", () => {
  const record = completionRecord();
  const runRuntime = runtime();
  const restored = active(withoutCompletion(record), RUN, AgentState.Settling);
  expectPlan(plan(record, completedAction(), uncontained(runRuntime)), {
    restored: [restored], runtimeRecords: [runRecord(restored, runRuntime)], durableWrites: [],
    obligations: new Map([[AGENT, { kind: "restore-completion", record }]]), warnings: [AGENT],
  });
});

test("row 15: ValidateCompletedReceipt + historical-unresolved preserves historical responsibility and original retry record", () => {
  const record = completionRecord();
  const runRuntime = runtime();
  const restored = active(withoutCompletion(record), RUN, AgentState.Settling);
  expectPlan(plan(record, completedAction(), historical(runRuntime)), {
    restored: [restored], runtimeRecords: [runRecord(restored, runRuntime, "historical-unresolved")], durableWrites: [],
    obligations: new Map([[AGENT, { kind: "restore-completion", record }]]), warnings: [AGENT],
  });
});

test("rejects duplicate actions fail-closed with InvalidState", () => {
  const record = launchRecord();
  const input = registry(record, launchAction());
  input.actions.push(launchAction());
  expect(() => planRestoration(input, new Map())).toThrow(expect.objectContaining({ code: AgentErrorCode.InvalidState }));
});

test("rejects an action whose registry record is missing fail-closed with InvalidState", () => {
  const input: RestoredRegistry = { agents: new Map(), actions: [launchAction()], invalidEvents: [] };
  expect(() => planRestoration(input, new Map())).toThrow(expect.objectContaining({ code: AgentErrorCode.InvalidState }));
});

test("rejects a non-stopped record without an action fail-closed with InvalidState", () => {
  const record = startedRecord();
  expect(() => planRestoration(registry(record), new Map())).toThrow(expect.objectContaining({ code: AgentErrorCode.InvalidState }));
});

test("emits restored and runtime records in registry map order rather than action order", () => {
  const first = completionRecord(testAgentId("agent-first"));
  const second = completionRecord(testAgentId("agent-second"));
  const firstRuntime = runtime();
  const secondRuntime = runtime();
  const input: RestoredRegistry = {
    agents: new Map([[second.agentId, second], [first.agentId, first]]),
    actions: [completedAction(first.agentId), completedAction(second.agentId)],
    invalidEvents: [],
  };
  const evidence = new Map<AgentId, AgentRestorationEvidence>([
    [first.agentId, contained(firstRuntime)],
    [second.agentId, contained(secondRuntime)],
  ]);
  expectPlan(planRestoration(input, evidence), {
    restored: [second, first], runtimeRecords: [runRecord(second), runRecord(first)],
    durableWrites: [],
    obligations: new Map([
      [second.agentId, { kind: "restore-completion", record: second }],
      [first.agentId, { kind: "restore-completion", record: first }],
    ]),
    warnings: [],
  });
});

test("absent evidence synthesises the uncontained pre-native fail-safe plan", async () => {
  const record = launchRecord();
  const restored = preNative(withoutCompletion(record), false);
  const result = plan(record, launchAction());
  expect(result.restored).toEqual([restored]);
  expect(result.runtimeRecords).toEqual([{
    ...runRecord(restored, undefined, "pre-native", true),
    runtime: expect.objectContaining({ abort: expect.any(Function), contain: expect.any(Function) }),
  }]);
  expect(result.durableWrites).toEqual([]);
  expect(result.obligations).toEqual(new Map([[AGENT, {
    kind: "finalise", record, settlement: { kind: "interrupted" },
  }]]));
  expect(result.warnings).toEqual([AGENT]);
  await expect(result.runtimeRecords[0]!.runtime!.contain()).rejects.toThrow(expect.objectContaining({ code: AgentErrorCode.ContainmentFailed }));
});
