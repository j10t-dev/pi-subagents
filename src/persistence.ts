import { AGENT_EVENT_CUSTOM_TYPE, CURRENT_EVENT_SCHEMA_VERSION, MAX_COMPLETION_OUTPUT_BYTES, MAX_ERROR_MESSAGE_BYTES } from "./constants.ts";
import {
  agentRunKey,
  agentId,
  AgentErrorCode,
  AgentEventType,
  AgentState,
  type AgentCompletion,
  type AgentEventPayloadMap,
  type AgentId,
  type AgentUsage,
  type AbsolutePath,
  type CancellationReason,
  type ContainmentReceiptPath,
  type DiagnosticsPath,
  type PersistedAgentEvent,
  type RunAttemptId,
  type RunCompletedPayload,
  type RunId,
  type RunLaunchRequestedPayloadV1,
  type RunLaunchRequestedPayloadV2,
  type RunStartedPayload,
  type RunStoppingPayload,
  type SessionEntryId,
  type SpawnedPayload,
  RestorationActionType,
  runAttemptId,
  runId as brandRunId,
  sessionEntryId,
  modelSpec,
  utf8Bytes,
  truncateUtf8,
} from "./domain.ts";
import { absolutePath, restoredStatePath } from "./paths.ts";
import { PersistenceSequencer } from "./async-primitives.ts";
import { Value } from "typebox/value";
import { AgentUsageSchema, decodePersistedAgentEvent, type AgentCompletionDto } from "./schemas.ts";
import type { ContainmentDescriptor } from "./containment.ts";

/** Matches Pi's `ExtensionAPI.appendEntry<T>(customType, data)` shape so it can be injected in tests. */
export type AppendEntryFn = (customType: string, data: unknown) => void;

/**
 * Decodes an `unknown` custom-entry payload into a fully-branded `PersistedAgentEvent`.
 * Throws `invalid_input: ...` when the envelope fails schema validation or a field fails
 * to brand; callers convert that failure into a bounded diagnostic rather than propagating it.
 */
export function decodeAgentEvent(value: unknown, stateRoot: string): PersistedAgentEvent {
  const dto = decodePersistedAgentEvent(value);
  switch (dto.eventType) {
    case AgentEventType.Spawned: {
      const payload: SpawnedPayload = {
        agentId: agentId(dto.payload.agentId),
        sessionPath: restoredSessionPath(dto.payload.sessionPath, stateRoot),
        cwd: absolutePath(dto.payload.cwd),
        provider: dto.payload.provider,
        modelId: modelSpec(dto.payload.modelId),
        thinkingLevel: dto.payload.thinkingLevel,
        tools: dto.payload.tools,
      };
      return { schemaVersion: dto.schemaVersion, eventType: dto.eventType, payload };
    }
    case AgentEventType.RunLaunchRequested: {
      const common: RunLaunchRequestedPayloadV1 = {
        agentId: agentId(dto.payload.agentId),
        previousLeafId:
          dto.payload.previousLeafId === null ? null : sessionEntryId(dto.payload.previousLeafId),
        attemptId: runAttemptId(dto.payload.attemptId),
        containmentReceiptPath: restoredReceiptPath(dto.payload.containmentReceiptPath, stateRoot),
      };
      if (dto.schemaVersion === 1) {
        return { schemaVersion: 1, eventType: dto.eventType, payload: common };
      }
      const payload: RunLaunchRequestedPayloadV2 = {
        ...common,
        containment: {
          backend: dto.payload.containment.backend,
          scopePath: absolutePath(dto.payload.containment.scopePath),
        },
      };
      return { schemaVersion: 2, eventType: dto.eventType, payload };
    }
    case AgentEventType.RunStarted: {
      const payload: RunStartedPayload = {
        agentId: agentId(dto.payload.agentId),
        runId: brandRunId(dto.payload.runId),
        attemptId: runAttemptId(dto.payload.attemptId),
      };
      return { schemaVersion: dto.schemaVersion, eventType: dto.eventType, payload };
    }
    case AgentEventType.RunStopping: {
      const payload: RunStoppingPayload = {
        agentId: agentId(dto.payload.agentId),
        runId: brandRunId(dto.payload.runId),
        reason: dto.payload.reason as CancellationReason,
        containmentReceiptPath: restoredReceiptPath(dto.payload.containmentReceiptPath, stateRoot),
      };
      return { schemaVersion: dto.schemaVersion, eventType: dto.eventType, payload };
    }
    case AgentEventType.RunCompleted: {
      const payload = decodeCompletionPayload(dto.payload, stateRoot);
      return { schemaVersion: dto.schemaVersion, eventType: dto.eventType, payload };
    }
  }
}

function decodeCompletionPayload(dto: AgentCompletionDto, stateRoot: string): RunCompletedPayload {
  const textBytes = new TextEncoder().encode(dto.output.text).byteLength;
  if (textBytes !== dto.output.retainedBytes || dto.output.retainedBytes > MAX_COMPLETION_OUTPUT_BYTES ||
      dto.output.originalBytes < dto.output.retainedBytes ||
      dto.output.truncated !== (dto.output.originalBytes > dto.output.retainedBytes)) {
    throw new Error("invalid_input: inconsistent persisted completion output metadata");
  }
  if (dto.state === "failed" && new TextEncoder().encode(dto.error.message).byteLength > MAX_ERROR_MESSAGE_BYTES) {
    throw new Error("invalid_input: persisted completion error exceeds byte limit");
  }
  const base: Omit<AgentCompletion, "state" | "error" | "reason"> = {
    agentId: agentId(dto.agentId),
    runId: brandRunId(dto.runId),
    output: {
      text: dto.output.text,
      originalBytes: utf8Bytes(dto.output.originalBytes),
      retainedBytes: utf8Bytes(dto.output.retainedBytes),
      truncated: dto.output.truncated,
    },
    outputPath: restoredOutputPath(dto.outputPath, stateRoot) as AgentCompletion["outputPath"],
    transcriptPath: restoredSessionPath(dto.transcriptPath, stateRoot),
    ...(dto.usage !== undefined ? { usage: validateUsage(dto.usage) } : {}),
  };
  if (dto.state === "failed" && dto.error !== undefined) {
    const diagnosticsPath =
      dto.error.diagnosticsPath === undefined
        ? undefined
        : (restoredDiagnosticsPath(dto.error.diagnosticsPath, stateRoot) as DiagnosticsPath);
    return {
      ...base,
      state: "failed",
      error:
        diagnosticsPath === undefined
          ? { code: dto.error.code as AgentErrorCode, message: dto.error.message }
          : { code: dto.error.code as AgentErrorCode, message: dto.error.message, diagnosticsPath },
    };
  }
  if (dto.state === "cancelled" && dto.reason !== undefined) {
    return { ...base, state: "cancelled", reason: dto.reason as CancellationReason };
  }
  return { ...base, state: "completed" };
}

function restoredSessionPath(value: string, root: string): SpawnedPayload["sessionPath"] {
  return restoredStatePath(root, value) as SpawnedPayload["sessionPath"];
}

function restoredReceiptPath(value: string, root: string): ContainmentReceiptPath {
  return restoredStatePath(root, value) as ContainmentReceiptPath;
}

function restoredOutputPath(value: string, root: string): AbsolutePath {
  return restoredStatePath(root, value);
}

function restoredDiagnosticsPath(value: string, root: string): AbsolutePath {
  return restoredStatePath(root, value);
}

function validateUsage(value: NonNullable<AgentCompletionDto["usage"]>): AgentUsage {
  try {
    return Value.Parse(AgentUsageSchema, value);
  } catch {
    throw new Error("invalid_input: invalid persisted completion usage");
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

// --- Typed append methods ------------------------------------------------

/** Appends typed lifecycle events through a shared, order-preserving persistence sequencer. */
export class AgentEventAppender {
  private readonly sequencer: PersistenceSequencer<PersistedAgentEvent>;
  private readonly startedRuns = new Set<ReturnType<typeof agentRunKey>>();
  private readonly startingRuns = new Map<ReturnType<typeof agentRunKey>, Promise<void>>();
  private readonly completedRuns = new Set<ReturnType<typeof agentRunKey>>();
  private readonly completingRuns = new Map<ReturnType<typeof agentRunKey>, Promise<void>>();

  constructor(write: AppendEntryFn) {
    this.sequencer = new PersistenceSequencer<PersistedAgentEvent>((event) => {
      write(AGENT_EVENT_CUSTOM_TYPE, event);
    });
  }

  appendSpawned(payload: AgentEventPayloadMap[typeof AgentEventType.Spawned]): Promise<void> {
    return this.append(AgentEventType.Spawned, payload);
  }

  appendRunLaunchRequested(
    payload: AgentEventPayloadMap[typeof AgentEventType.RunLaunchRequested],
  ): Promise<void> {
    return this.append(AgentEventType.RunLaunchRequested, payload);
  }

  appendRunStarted(
    payload: AgentEventPayloadMap[typeof AgentEventType.RunStarted],
  ): Promise<void> {
    const key = agentRunKey(payload.agentId, payload.runId);
    if (this.startedRuns.has(key)) return Promise.resolve();
    const existing = this.startingRuns.get(key);
    if (existing !== undefined) return existing;
    const operation = this.append(AgentEventType.RunStarted, payload).then(() => { this.startedRuns.add(key); })
      .finally(() => { this.startingRuns.delete(key); });
    this.startingRuns.set(key, operation);
    return operation;
  }

  appendRunStopping(
    payload: AgentEventPayloadMap[typeof AgentEventType.RunStopping],
  ): Promise<void> {
    return this.append(AgentEventType.RunStopping, payload);
  }

  appendRunCompleted(
    payload: AgentEventPayloadMap[typeof AgentEventType.RunCompleted],
  ): Promise<void> {
    const key = agentRunKey(payload.agentId, payload.runId);
    if (this.completedRuns.has(key)) return Promise.resolve();
    const existing = this.completingRuns.get(key);
    if (existing !== undefined) return existing;
    const operation = this.append(AgentEventType.RunCompleted, payload).then(() => { this.completedRuns.add(key); })
      .finally(() => { this.completingRuns.delete(key); });
    this.completingRuns.set(key, operation);
    return operation;
  }

  /**
   * Reserves the shared sequencer for a multi-event transition (e.g. `RunStopping` immediately
   * followed by `RunCompleted`) so no other caller's append can interleave between them.
   */
  withGroup<T>(
    fn: (
      appendEvent: <K extends AgentEventType>(
        eventType: K,
        payload: AgentEventPayloadMap[K],
      ) => Promise<void>,
    ) => Promise<T>,
  ): Promise<T> {
    return this.sequencer.withGroup((rawAppend) =>
      fn((eventType, payload) =>
        rawAppend({ schemaVersion: CURRENT_EVENT_SCHEMA_VERSION, eventType, payload } as PersistedAgentEvent),
      ),
    );
  }

  private append<K extends AgentEventType>(
    eventType: K,
    payload: AgentEventPayloadMap[K],
  ): Promise<void> {
    const event = { schemaVersion: CURRENT_EVENT_SCHEMA_VERSION, eventType, payload } as PersistedAgentEvent;
    return this.sequencer.append(event);
  }
}

// --- Pure event fold ------------------------------------------------------

export interface RestoredAgentRecord {
  agentId: AgentId;
  sessionPath: SpawnedPayload["sessionPath"];
  cwd: SpawnedPayload["cwd"];
  provider: string;
  modelId: SpawnedPayload["modelId"];
  thinkingLevel: SpawnedPayload["thinkingLevel"];
  tools: readonly string[];
  state: AgentState;
  currentRunId?: RunId;
  currentReceiptPath?: ContainmentReceiptPath;
  currentAttemptId?: RunAttemptId;
  currentContainment?: ContainmentDescriptor;
  currentEventVersion?: 1 | 2;
  pendingLaunch?: RunLaunchRequestedPayloadV1 | RunLaunchRequestedPayloadV2;
  pendingLaunchEventVersion?: 1 | 2;
  pendingStopReason?: CancellationReason;
  latestCompletion?: AgentCompletion;
  latestCompletionReceiptPath?: ContainmentReceiptPath;
  latestCompletionAttemptId?: RunAttemptId;
  latestCompletionContainment?: ContainmentDescriptor;
  latestCompletionEventVersion?: 1 | 2;
}

export type RestorationAction =
  | {
      type: typeof RestorationActionType.ValidateCompletedReceipt;
      agentId: AgentId;
      containmentReceiptPath: ContainmentReceiptPath;
      attemptId: RunAttemptId;
      descriptor?: ContainmentDescriptor;
      eventVersion: 1 | 2;
    }
  | {
      type: typeof RestorationActionType.ReconcileLaunch;
      agentId: AgentId;
      attemptId: RunAttemptId;
      previousLeafId: SessionEntryId | null;
      containmentReceiptPath: ContainmentReceiptPath;
      descriptor?: ContainmentDescriptor;
      eventVersion: 1 | 2;
    }
  | {
      type: typeof RestorationActionType.ReconcileStarted;
      agentId: AgentId;
      runId: RunId;
      containmentReceiptPath: ContainmentReceiptPath;
      attemptId: RunAttemptId;
      descriptor?: ContainmentDescriptor;
      eventVersion: 1 | 2;
    }
  | {
      type: typeof RestorationActionType.ReconcileStopping;
      agentId: AgentId;
      runId: RunId;
      reason: CancellationReason;
      containmentReceiptPath: ContainmentReceiptPath;
      attemptId: RunAttemptId;
      descriptor?: ContainmentDescriptor;
      eventVersion: 1 | 2;
    };

export interface RestoredRegistry {
  agents: Map<AgentId, RestoredAgentRecord>;
  actions: RestorationAction[];
  invalidEvents: string[];
}

interface FoldableEntry {
  readonly type: string;
  readonly customType?: string;
  readonly data?: unknown;
}

/**
 * Pure fold over the full leaf-to-root branch (`SessionManager.getBranch()`), not the
 * compaction-aware context view. Ownership of a completion follows the branch containing the
 * `Spawned` event, so this must see every custom entry regardless of `firstKeptEntryId`.
 * Invalid or out-of-order events become bounded diagnostics in `invalidEvents` and are skipped;
 * they never create or mutate agent ownership. Fold state (Running/Stopping/Stopped) reflects
 * only what the persisted log proves; the transient runtime `Settling` state has no persisted
 * event and is therefore not observable here.
 */
export function foldAgentEvents(entries: readonly FoldableEntry[], stateRoot: string): RestoredRegistry {
  const agents = new Map<AgentId, RestoredAgentRecord>();
  const actions: RestorationAction[] = [];
  const invalidEvents: string[] = [];
  const rejectedAgents = new Set<AgentId>();

  const pushInvalid = (message: string): void => {
    invalidEvents.push(truncateUtf8(message, MAX_ERROR_MESSAGE_BYTES).text);
  };

  for (const entry of entries) {
    if (entry.type !== "custom" || entry.customType !== AGENT_EVENT_CUSTOM_TYPE) {
      continue;
    }

    let event: PersistedAgentEvent;
    try {
      event = decodeAgentEvent(entry.data, stateRoot);
    } catch (error) {
      pushInvalid(`invalid persisted agent event: ${error instanceof Error ? error.message : "decode failure"}`);
      const rejected = persistedAgentId(entry.data);
      if (rejected !== undefined) {
        agents.delete(rejected);
        rejectedAgents.add(rejected);
      }
      continue;
    }

    if (rejectedAgents.has(event.payload.agentId)) {
      pushInvalid(`event for rejected agent ${event.payload.agentId}`);
      continue;
    }

    applyEvent(agents, event, pushInvalid);
  }

  for (const record of agents.values()) {
    if (record.pendingLaunch !== undefined) {
      actions.push({
        type: RestorationActionType.ReconcileLaunch,
        agentId: record.agentId,
        attemptId: record.pendingLaunch.attemptId,
        previousLeafId: record.pendingLaunch.previousLeafId,
        containmentReceiptPath: record.pendingLaunch.containmentReceiptPath,
        ...("containment" in record.pendingLaunch ? { descriptor: record.pendingLaunch.containment } : {}),
        eventVersion: record.pendingLaunchEventVersion ?? 1,
      });
    } else if (record.state === AgentState.Running && record.currentRunId !== undefined) {
      actions.push({
        type: RestorationActionType.ReconcileStarted,
        agentId: record.agentId,
        runId: record.currentRunId,
        containmentReceiptPath: record.currentReceiptPath as ContainmentReceiptPath,
        attemptId: record.currentAttemptId as RunAttemptId,
        ...(record.currentContainment === undefined ? {} : { descriptor: record.currentContainment }),
        eventVersion: record.currentEventVersion ?? 1,
      });
    } else if (record.state === AgentState.Stopping && record.currentRunId !== undefined) {
      actions.push({
        type: RestorationActionType.ReconcileStopping,
        agentId: record.agentId,
        runId: record.currentRunId,
        reason: record.pendingStopReason as CancellationReason,
        containmentReceiptPath: record.currentReceiptPath as ContainmentReceiptPath,
        attemptId: record.currentAttemptId as RunAttemptId,
        ...(record.currentContainment === undefined ? {} : { descriptor: record.currentContainment }),
        eventVersion: record.currentEventVersion ?? 1,
      });
    } else if (record.state === AgentState.Stopped && record.latestCompletion !== undefined) {
      actions.push({
        type: RestorationActionType.ValidateCompletedReceipt,
        agentId: record.agentId,
        containmentReceiptPath: record.latestCompletionReceiptPath as ContainmentReceiptPath,
        attemptId: record.latestCompletionAttemptId as RunAttemptId,
        ...(record.latestCompletionContainment === undefined ? {} : { descriptor: record.latestCompletionContainment }),
        eventVersion: record.latestCompletionEventVersion ?? 1,
      });
    }
  }

  return { agents, actions, invalidEvents };
}

function persistedAgentId(value: unknown): AgentId | undefined {
  if (!isRecord(value) || !isRecord(value.payload) || typeof value.payload.agentId !== "string") return undefined;
  try { return agentId(value.payload.agentId); } catch { return undefined; }
}

function applyEvent(
  agents: Map<AgentId, RestoredAgentRecord>,
  event: PersistedAgentEvent,
  pushInvalid: (message: string) => void,
): void {
  switch (event.eventType) {
    case AgentEventType.Spawned: {
      if (agents.has(event.payload.agentId)) {
        pushInvalid(`duplicate spawned event for agent ${event.payload.agentId}`);
        return;
      }
      agents.set(event.payload.agentId, {
        agentId: event.payload.agentId,
        sessionPath: event.payload.sessionPath,
        cwd: event.payload.cwd,
        provider: event.payload.provider,
        modelId: event.payload.modelId,
        thinkingLevel: event.payload.thinkingLevel,
        tools: event.payload.tools,
        state: AgentState.Stopped,
      });
      return;
    }
    case AgentEventType.RunLaunchRequested: {
      const record = agents.get(event.payload.agentId);
      if (record === undefined) {
        pushInvalid(`run_launch_requested for unknown agent ${event.payload.agentId}`);
        return;
      }
      if (record.state !== AgentState.Stopped) {
        pushInvalid(`run_launch_requested while agent ${event.payload.agentId} was not stopped`);
        return;
      }
      if (record.pendingLaunch !== undefined) {
        pushInvalid(`overlapping run_launch_requested for agent ${event.payload.agentId}`);
        return;
      }
      record.pendingLaunch = event.payload;
      record.pendingLaunchEventVersion = event.schemaVersion;
      return;
    }
    case AgentEventType.RunStarted: {
      const record = agents.get(event.payload.agentId);
      if (record === undefined) {
        pushInvalid(`run_started for unknown agent ${event.payload.agentId}`);
        return;
      }
      if (record.pendingLaunch?.attemptId !== event.payload.attemptId) {
        pushInvalid(`unmatched run_started for agent ${event.payload.agentId}`);
        return;
      }
      if (record.state !== AgentState.Stopped) {
        pushInvalid(`run_started while agent ${event.payload.agentId} was not stopped`);
        return;
      }
      record.state = AgentState.Running;
      record.currentRunId = event.payload.runId;
      record.currentReceiptPath = record.pendingLaunch.containmentReceiptPath;
      record.currentAttemptId = record.pendingLaunch.attemptId;
      if (record.pendingLaunchEventVersion === undefined) delete record.currentEventVersion;
      else record.currentEventVersion = record.pendingLaunchEventVersion;
      if ("containment" in record.pendingLaunch) record.currentContainment = record.pendingLaunch.containment;
      else delete record.currentContainment;
      delete record.pendingLaunch;
      delete record.pendingLaunchEventVersion;
      return;
    }
    case AgentEventType.RunStopping: {
      const record = agents.get(event.payload.agentId);
      if (record === undefined) {
        pushInvalid(`run_stopping for unknown agent ${event.payload.agentId}`);
        return;
      }
      if (record.state !== AgentState.Running || record.currentRunId !== event.payload.runId) {
        pushInvalid(`unmatched run_stopping for agent ${event.payload.agentId}`);
        return;
      }
      record.state = AgentState.Stopping;
      record.currentReceiptPath = event.payload.containmentReceiptPath;
      record.pendingStopReason = event.payload.reason;
      return;
    }
    case AgentEventType.RunCompleted: {
      const record = agents.get(event.payload.agentId);
      if (record === undefined) {
        pushInvalid(`run_completed for unknown agent ${event.payload.agentId}`);
        return;
      }
      if (record.currentRunId !== event.payload.runId || record.state === AgentState.Stopped) {
        pushInvalid(`duplicate or unmatched run_completed for agent ${event.payload.agentId}`);
        return;
      }
      if (record.sessionPath !== event.payload.transcriptPath) {
        agents.delete(event.payload.agentId);
        pushInvalid(`run_completed transcript mismatch for agent ${event.payload.agentId}`);
        return;
      }
      record.state = AgentState.Stopped;
      record.latestCompletion = event.payload;
      if (record.currentReceiptPath !== undefined) record.latestCompletionReceiptPath = record.currentReceiptPath;
      if (record.currentAttemptId !== undefined) record.latestCompletionAttemptId = record.currentAttemptId;
      if (record.currentContainment !== undefined) record.latestCompletionContainment = record.currentContainment;
      else delete record.latestCompletionContainment;
      if (record.currentEventVersion === undefined) delete record.latestCompletionEventVersion;
      else record.latestCompletionEventVersion = record.currentEventVersion;
      delete record.pendingStopReason;
      return;
    }
  }
}
