import { AGENT_EVENT_CUSTOM_TYPE } from "../../src/constants.ts";
import { AgentEventType, AgentState, CancellationReason, type AgentCompletion, type AgentEventPayloadMap, type PersistedAgentEvent } from "../../src/domain.ts";
import { AgentEventAppender, type RestoredAgentRecord } from "../../src/persistence.ts";
import type { RestorationPort } from "../../src/controller.ts";
import { completedCompletion } from "./messages.ts";
import { testAbsolutePath, testAgentId, testAttemptId, testModelSpec, testReceiptPath, testRunId, testSessionPath, testVerifiedReceiptPath } from "./brands.ts";

export function testRestorationPort(overrides: Partial<RestorationPort> = {}): RestorationPort {
  const appender = new AgentEventAppender(() => {});
  return {
    stateRoot: testAbsolutePath("/tmp/pi-subagents-test"),
    getBranch: () => [],
    resolveContainment: async () => ({ kind: "contained", receipt: testVerifiedReceiptPath() }),
    firstUserEntryAfter: async () => undefined,
    finaliseContained: async (_record: RestoredAgentRecord, runId) => completedCompletion({ runId }),
    appender,
    ...overrides,
  };
}

export type RestorationEventEntry = { readonly type: "custom"; readonly customType: typeof AGENT_EVENT_CUSTOM_TYPE; readonly data: PersistedAgentEvent };

const wrap = (data: PersistedAgentEvent): RestorationEventEntry =>
  ({ type: "custom", customType: AGENT_EVENT_CUSTOM_TYPE, data });

export function spawnedEntry(overrides: Partial<AgentEventPayloadMap[typeof AgentEventType.Spawned]> = {}, schemaVersion: 1 | 2 = 2): RestorationEventEntry {
  const payload: AgentEventPayloadMap[typeof AgentEventType.Spawned] = {
    agentId: testAgentId(), sessionPath: testSessionPath(), cwd: testAbsolutePath("/tmp/pi-subagents-test"),
    provider: "mock-provider", modelId: testModelSpec(), thinkingLevel: "high", tools: ["read"], ...overrides,
  };
  // Each builder branches on the literal schema version so its object narrows to one union member.
  return wrap(schemaVersion === 1
    ? { schemaVersion: 1, eventType: AgentEventType.Spawned, payload }
    : { schemaVersion: 2, eventType: AgentEventType.Spawned, payload });
}

export function launchEntry(overrides: Partial<AgentEventPayloadMap[typeof AgentEventType.RunLaunchRequested]> = {}, schemaVersion: 1 | 2 = 2): RestorationEventEntry {
  const { containment, ...common } = {
    agentId: testAgentId(), previousLeafId: null, attemptId: testAttemptId(), containmentReceiptPath: testReceiptPath(),
    containment: { backend: "cgroup-v2" as const, scopePath: testAbsolutePath("/tmp/cgroup/attempt-1") },
    ...overrides,
  };
  return wrap(schemaVersion === 1
    ? { schemaVersion: 1, eventType: AgentEventType.RunLaunchRequested, payload: common }
    : { schemaVersion: 2, eventType: AgentEventType.RunLaunchRequested, payload: { ...common, containment } });
}

export function startedEntry(overrides: Partial<AgentEventPayloadMap[typeof AgentEventType.RunStarted]> = {}, schemaVersion: 1 | 2 = 2): RestorationEventEntry {
  const payload = { agentId: testAgentId(), runId: testRunId(), attemptId: testAttemptId(), ...overrides };
  return wrap(schemaVersion === 1
    ? { schemaVersion: 1, eventType: AgentEventType.RunStarted, payload }
    : { schemaVersion: 2, eventType: AgentEventType.RunStarted, payload });
}

export function stoppingEntry(overrides: Partial<AgentEventPayloadMap[typeof AgentEventType.RunStopping]> = {}, schemaVersion: 1 | 2 = 2): RestorationEventEntry {
  const payload = {
    agentId: testAgentId(), runId: testRunId(), reason: CancellationReason.StopRequested,
    containmentReceiptPath: testReceiptPath(), ...overrides,
  };
  return wrap(schemaVersion === 1
    ? { schemaVersion: 1, eventType: AgentEventType.RunStopping, payload }
    : { schemaVersion: 2, eventType: AgentEventType.RunStopping, payload });
}

export function completedEntry(
  overrides: Partial<Extract<AgentCompletion, { state: "completed" }>> = {},
  schemaVersion: 1 | 2 = 2,
): RestorationEventEntry {
  const payload = completedCompletion(overrides);
  return wrap(schemaVersion === 1
    ? { schemaVersion: 1, eventType: AgentEventType.RunCompleted, payload }
    : { schemaVersion: 2, eventType: AgentEventType.RunCompleted, payload });
}
