import {
  type AbsolutePath,
  type AgentCompletion,
  type AgentId,
  type AgentRunKey,
  agentRunKey,
  AgentErrorCode,
  AgentState,
  CodedError,
  RestorationActionType,
  type CancellationReason,
  type ContainmentReceiptPath,
  type RunAttemptId,
  type RunId,
  type SessionEntryId,
  type SessionPath,
  type VerifiedContainmentReceiptPath,
} from "./domain.ts";
import type { ContainmentDescriptor } from "./containment.ts";
import type { AgentEventAppender, RestorationAction, RestoredAgentRecord, RestoredRegistry } from "./persistence.ts";
import type { RestoreAdmission, RunRecord, RunRuntime } from "./run-controller.ts";

export interface RestorationContainmentInput {
  readonly attemptId: RunAttemptId;
  readonly receiptPath: ContainmentReceiptPath;
  readonly descriptor?: ContainmentDescriptor;
  readonly eventVersion: 1 | 2;
}

export type RestoredSettlement =
  | { readonly kind: "interrupted" }
  | { readonly kind: "cancelled"; readonly reason: CancellationReason };

export type RestorationContainmentDecision =
  | { kind: "contained"; receipt: VerifiedContainmentReceiptPath }
  | { kind: "requires-containment"; runtime: RunRuntime }
  | { kind: "unresolved-historical"; runtime: RunRuntime };

export interface RestorationPort {
  stateRoot: AbsolutePath;
  getBranch(): readonly { readonly type: string; readonly customType?: string; readonly data?: unknown }[];
  resolveContainment(input: RestorationContainmentInput): Promise<RestorationContainmentDecision>;
  firstUserEntryAfter(sessionPath: SessionPath, cursor: SessionEntryId | null): Promise<RunId | undefined>;
  finaliseContained(record: RestoredAgentRecord, runId: RunId, settlement: RestoredSettlement): Promise<AgentCompletion>;
  appender: AgentEventAppender;
}

export type ContainmentEvidence =
  | { kind: "contained"; runtime: RunRuntime }
  | { kind: "uncontained"; runtime: RunRuntime }
  | { kind: "historical-unresolved"; runtime: RunRuntime };

export type LaunchIdentityEvidence =
  | { kind: "not-applicable" }
  | { kind: "run-found"; runId: RunId }
  | { kind: "no-run" }
  | { kind: "lookup-failed" };

export interface AgentRestorationEvidence {
  containment: ContainmentEvidence;
  launchIdentity: LaunchIdentityEvidence;
}

export type RestorationEvidence = ReadonlyMap<AgentId, AgentRestorationEvidence>;

export async function collectRestorationEvidence(
  registry: RestoredRegistry,
  port: RestorationPort,
  completedRuntime: (input: RestorationContainmentInput) => RunRuntime,
): Promise<RestorationEvidence> {
  const resolutions = new Map<string, Promise<ContainmentResolution>>();
  const evidence = await Promise.all(registry.actions.map(async (action) => {
    const input = containmentInput(action);
    const key = containmentKey(input);
    let resolution = resolutions.get(key);
    if (resolution === undefined) {
      resolution = resolveContainment(port, input);
      resolutions.set(key, resolution);
    }
    const containment = containmentEvidence(await resolution, action, input, completedRuntime);
    const launchIdentity = await launchIdentityEvidence(action, containment, registry, port);
    return [action.agentId, { containment, launchIdentity }] as const;
  }));
  return new Map(evidence);
}

type ContainmentResolution =
  | { readonly kind: "contained"; readonly runtime: RunRuntime }
  | { readonly kind: "uncontained"; readonly runtime: RunRuntime }
  | { readonly kind: "historical-unresolved"; readonly runtime: RunRuntime };

function containmentInput(action: RestorationAction): RestorationContainmentInput {
  return {
    attemptId: action.attemptId,
    receiptPath: action.containmentReceiptPath,
    ...(action.descriptor === undefined ? {} : { descriptor: action.descriptor }),
    eventVersion: action.eventVersion,
  };
}

function containmentKey(input: RestorationContainmentInput): string {
  return `${input.receiptPath}\0${input.attemptId}\0${input.eventVersion}\0${input.descriptor?.backend ?? ""}\0${input.descriptor?.scopePath ?? ""}`;
}

async function resolveContainment(port: RestorationPort, input: RestorationContainmentInput): Promise<ContainmentResolution> {
  let decision: RestorationContainmentDecision;
  try {
    decision = await port.resolveContainment(input);
  } catch {
    return { kind: "uncontained", runtime: unavailableRuntime() };
  }
  switch (decision.kind) {
    case "contained":
      return { kind: "contained", runtime: containedRuntime(decision.receipt) };
    case "unresolved-historical":
      return { kind: "historical-unresolved", runtime: decision.runtime };
    case "requires-containment":
      try {
        await decision.runtime.contain();
        return { kind: "contained", runtime: decision.runtime };
      } catch {
        return { kind: "uncontained", runtime: decision.runtime };
      }
  }
}

function containmentEvidence(
  resolution: ContainmentResolution,
  action: RestorationAction,
  input: RestorationContainmentInput,
  completedRuntime: (input: RestorationContainmentInput) => RunRuntime,
): ContainmentEvidence {
  if (resolution.kind === "contained" || action.type !== RestorationActionType.ValidateCompletedReceipt) return resolution;
  return { kind: resolution.kind, runtime: completedRuntime(input) };
}

async function launchIdentityEvidence(
  action: RestorationAction,
  containment: ContainmentEvidence,
  registry: RestoredRegistry,
  port: RestorationPort,
): Promise<LaunchIdentityEvidence> {
  if (action.type !== RestorationActionType.ReconcileLaunch || containment.kind !== "contained") {
    return { kind: "not-applicable" };
  }
  const record = registry.agents.get(action.agentId);
  if (record === undefined) return { kind: "lookup-failed" };
  try {
    const runId = await port.firstUserEntryAfter(record.sessionPath, action.previousLeafId);
    return runId === undefined ? { kind: "no-run" } : { kind: "run-found", runId };
  } catch {
    return { kind: "lookup-failed" };
  }
}

function containedRuntime(receipt: VerifiedContainmentReceiptPath): RunRuntime {
  return { abort: async () => {}, contain: async () => receipt };
}

export interface RestoredCompletionIntent {
  readonly record: RestoredAgentRecord;
  readonly runId: RunId;
  readonly settlement: RestoredSettlement;
}

export type RestoredTerminalObligation =
  | { readonly kind: "finalise"; readonly record: RestoredAgentRecord; readonly settlement: RestoredSettlement; readonly start?: { runId: RunId; attemptId: RunAttemptId } }
  | { readonly kind: "restore-completion"; readonly record: RestoredAgentRecord };

export interface StagedRestorePlan {
  readonly restored: RestoredAgentRecord[];
  readonly runtimeRecords: RunRecord[];
  readonly durableWrites: RestoredCompletionIntent[];
  readonly obligations: ReadonlyMap<AgentId, RestoredTerminalObligation>;
  readonly warnings: readonly AgentId[];
}

export interface RestorationApplicationState {
  readonly durableCompletions: Map<AgentRunKey, AgentCompletion>;
  readonly restoredStartedAppends: Set<AgentRunKey>;
  readonly restoredRecords: Map<AgentId, RestoredTerminalObligation>;
}

export class RestorationApplicationError extends Error {
  constructor(
    override readonly cause: unknown,
    readonly restored: readonly RestoredAgentRecord[],
    readonly admissionCommitted = true,
    readonly recoveryCause?: unknown,
  ) {
    super("restoration application failed", { cause });
    this.name = "RestorationApplicationError";
  }
}

export async function applyRestoration(
  plan: StagedRestorePlan,
  admission: RestoreAdmission,
  port: RestorationPort,
  state: RestorationApplicationState,
): Promise<RestoredAgentRecord[]> {
  admission.reserve(plan.runtimeRecords);
  const runtimeRecords = new Map(plan.runtimeRecords.map((record) => [record.agentId, record]));
  const replacedRecords: RunRecord[] = [];

  try {
    for (const obligation of plan.obligations.values()) {
      if (obligation.kind !== "finalise" || obligation.start === undefined) continue;
      const key = agentRunKey(obligation.record.agentId, obligation.start.runId);
      if (state.restoredStartedAppends.has(key)) continue;
      await port.appender.appendRunStarted({
        agentId: obligation.record.agentId,
        runId: obligation.start.runId,
        attemptId: obligation.start.attemptId,
      });
      state.restoredStartedAppends.add(key);
    }

    for (const intent of plan.durableWrites) {
      const key = agentRunKey(intent.record.agentId, intent.runId);
      const completion = state.durableCompletions.get(key)
        ?? await port.finaliseContained(intent.record, intent.runId, intent.settlement);
      state.durableCompletions.set(key, completion);
    }

    for (const intent of plan.durableWrites) {
      const completion = state.durableCompletions.get(agentRunKey(intent.record.agentId, intent.runId));
      if (completion === undefined) throw new CodedError(AgentErrorCode.InvalidState);
      await port.appender.appendRunCompleted(completion);
    }

    const restored = [...plan.restored];
    for (const intent of plan.durableWrites) {
      const completion = state.durableCompletions.get(agentRunKey(intent.record.agentId, intent.runId));
      if (completion === undefined) throw new CodedError(AgentErrorCode.InvalidState);
      const stopped = asStopped(intent.record, completion);
      admission.replace({ agentId: stopped.agentId, state: AgentState.Stopped, transcriptPath: stopped.sessionPath });
      const original = runtimeRecords.get(stopped.agentId);
      if (original === undefined) throw new CodedError(AgentErrorCode.InvalidState);
      replacedRecords.push(original);
      const index = restored.findIndex((record) => record.agentId === intent.record.agentId);
      if (index >= 0) restored[index] = stopped;
    }

    for (const record of restored) {
      const obligation = plan.obligations.get(record.agentId);
      if (record.state === AgentState.Stopped) {
        state.restoredRecords.delete(record.agentId);
      } else if (obligation !== undefined) {
        state.restoredRecords.set(record.agentId, obligation);
      }
    }
    admission.commit();
    return restored;
  } catch (error) {
    const recoveryFailures: unknown[] = [];
    for (const record of replacedRecords.reverse()) {
      try {
        admission.replace(record);
      } catch (recoveryError) {
        recoveryFailures.push(recoveryError);
      }
    }
    for (const [agentId, obligation] of plan.obligations) state.restoredRecords.set(agentId, obligation);
    if (recoveryFailures.length === 0) {
      try {
        admission.commit();
      } catch (recoveryError) {
        recoveryFailures.push(recoveryError);
      }
    }
    const recoveryCause = recoveryFailures.length === 0
      ? undefined
      : recoveryFailures.length === 1
        ? recoveryFailures[0]
        : new AggregateError(recoveryFailures, "restoration admission recovery failed");
    throw new RestorationApplicationError(error, plan.restored, recoveryFailures.length === 0, recoveryCause);
  }
}

export function planRestoration(registry: RestoredRegistry, evidence: RestorationEvidence): StagedRestorePlan {
  const actions = indexActions(registry);
  const restored: RestoredAgentRecord[] = [];
  const durableWrites: RestoredCompletionIntent[] = [];
  const obligations = new Map<AgentId, RestoredTerminalObligation>();
  const warnings: AgentId[] = [];
  const usedEvidence = new Map<AgentId, AgentRestorationEvidence>();

  for (const record of registry.agents.values()) {
    const action = actions.get(record.agentId);
    if (action === undefined) {
      if (record.state !== AgentState.Stopped) throw new CodedError(AgentErrorCode.InvalidState);
      restored.push(record);
      continue;
    }

    const agentEvidence = evidence.get(record.agentId) ?? failSafeEvidence();
    usedEvidence.set(record.agentId, agentEvidence);

    switch (action.type) {
      case RestorationActionType.ReconcileLaunch: {
        const settlement = { kind: "interrupted" as const };
        switch (agentEvidence.containment.kind) {
          case "contained":
            switch (agentEvidence.launchIdentity.kind) {
              case "run-found": {
                const active = asActiveRestored(record, agentEvidence.launchIdentity.runId, AgentState.Settling);
                restored.push(active);
                durableWrites.push({ record, runId: agentEvidence.launchIdentity.runId, settlement });
                obligations.set(record.agentId, {
                  kind: "finalise",
                  record,
                  settlement,
                  start: { runId: agentEvidence.launchIdentity.runId, attemptId: action.attemptId },
                });
                break;
              }
              case "no-run":
                restored.push(asStopped(record));
                break;
              case "lookup-failed":
                restored.push(asUncontained(record));
                obligations.set(record.agentId, { kind: "finalise", record, settlement });
                warnings.push(record.agentId);
                break;
              case "not-applicable":
                throw new CodedError(AgentErrorCode.InvalidState);
            }
            break;
          case "uncontained":
          case "historical-unresolved":
            restored.push(asUncontained(withoutLatestCompletion(record)));
            obligations.set(record.agentId, { kind: "finalise", record, settlement });
            warnings.push(record.agentId);
            break;
        }
        break;
      }
      case RestorationActionType.ReconcileStarted: {
        const settlement = { kind: "interrupted" as const };
        restored.push(asActiveRestored(record, action.runId, AgentState.Settling));
        obligations.set(record.agentId, { kind: "finalise", record, settlement });
        switch (agentEvidence.containment.kind) {
          case "contained":
            durableWrites.push({ record, runId: action.runId, settlement });
            break;
          case "uncontained":
          case "historical-unresolved":
            warnings.push(record.agentId);
            break;
        }
        break;
      }
      case RestorationActionType.ReconcileStopping: {
        const settlement = { kind: "cancelled" as const, reason: action.reason };
        restored.push(asActiveRestored(record, action.runId, AgentState.Stopping));
        obligations.set(record.agentId, { kind: "finalise", record, settlement });
        switch (agentEvidence.containment.kind) {
          case "contained":
            durableWrites.push({ record, runId: action.runId, settlement });
            break;
          case "uncontained":
          case "historical-unresolved":
            warnings.push(record.agentId);
            break;
        }
        break;
      }
      case RestorationActionType.ValidateCompletedReceipt:
        switch (agentEvidence.containment.kind) {
          case "contained":
            restored.push(record);
            break;
          case "uncontained":
          case "historical-unresolved":
            restored.push(asUncontained(withoutLatestCompletion(record)));
            obligations.set(record.agentId, { kind: "restore-completion", record });
            warnings.push(record.agentId);
            break;
        }
        break;
    }
  }

  const runtimeRecords = restored.map((record): RunRecord => {
    if (record.state === AgentState.Stopped) {
      return { agentId: record.agentId, state: record.state, transcriptPath: record.sessionPath };
    }
    const agentEvidence = usedEvidence.get(record.agentId);
    if (agentEvidence === undefined) throw new CodedError(AgentErrorCode.InvalidState);
    const preNative = record.pendingLaunch !== undefined && record.currentRunId === undefined;
    const responsibility = agentEvidence.containment.kind === "historical-unresolved"
      ? "historical-unresolved" as const
      : preNative
        ? "pre-native" as const
        : undefined;
    return {
      agentId: record.agentId,
      state: record.state,
      transcriptPath: record.sessionPath,
      ...(record.currentRunId === undefined ? {} : { runId: record.currentRunId }),
      runtime: agentEvidence.containment.runtime,
      ...(responsibility === undefined ? {} : { containmentResponsibility: responsibility }),
      ...(preNative && obligations.has(record.agentId) ? { restoredTerminalObligation: true as const } : {}),
    };
  });

  return { restored, runtimeRecords, durableWrites, obligations, warnings };
}

function indexActions(registry: RestoredRegistry): ReadonlyMap<AgentId, RestorationAction> {
  const actions = new Map<AgentId, RestorationAction>();
  for (const action of registry.actions) {
    if (!registry.agents.has(action.agentId) || actions.has(action.agentId)) {
      throw new CodedError(AgentErrorCode.InvalidState);
    }
    actions.set(action.agentId, action);
  }
  return actions;
}

function failSafeEvidence(): AgentRestorationEvidence {
  return {
    containment: { kind: "uncontained", runtime: unavailableRuntime() },
    launchIdentity: { kind: "not-applicable" },
  };
}

function unavailableRuntime(): RunRuntime {
  return {
    abort: async () => { throw new CodedError(AgentErrorCode.ContainmentFailed); },
    contain: async () => { throw new CodedError(AgentErrorCode.ContainmentFailed); },
  };
}

export function asActiveRestored(
  record: RestoredAgentRecord,
  runId: RunId,
  state: typeof AgentState.Settling | typeof AgentState.Stopping,
): RestoredAgentRecord {
  const { latestCompletion: _completion, ...rest } = record;
  return { ...rest, state, currentRunId: runId };
}

export function asStopped(record: RestoredAgentRecord, latestCompletion?: AgentCompletion): RestoredAgentRecord {
  const { currentRunId: _run, pendingLaunch: _launch, pendingStopReason: _reason, ...durable } = record;
  return { ...durable, state: AgentState.Stopped, ...(latestCompletion === undefined ? {} : { latestCompletion }) };
}

export function asUncontained(record: RestoredAgentRecord): RestoredAgentRecord {
  return {
    ...record,
    state: record.state === AgentState.Stopping || record.pendingLaunch !== undefined
      ? AgentState.Stopping
      : AgentState.Settling,
  };
}

export function withoutLatestCompletion(record: RestoredAgentRecord): RestoredAgentRecord {
  const {
    latestCompletion: _completion,
    latestCompletionAttemptId: _attempt,
    latestCompletionReceiptPath: _receipt,
    latestCompletionContainment: _containment,
    latestCompletionEventVersion: _eventVersion,
    ...rest
  } = record;
  return rest;
}
