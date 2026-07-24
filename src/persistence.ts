import { AGENT_EVENT_CUSTOM_TYPE, CURRENT_EVENT_SCHEMA_VERSION, MAX_COMPLETION_OUTPUT_BYTES, MAX_ERROR_MESSAGE_BYTES } from "./constants.ts";
import {
  agentRunKey,
  agentId,
  AgentErrorCode,
  AgentEventType,
  AgentState,
  type AbsolutePath,
  type AgentCompletion,
  type AgentEventPayloadMap,
  type AgentId,
  type AgentUsage,
  type CancellationReason,
  type ContainmentReceiptPath,
  type PersistedAgentEvent,
  type RestorableAgentCompletion,
  type RunAttemptId,
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
  modelId,
  providerId,
  toolName,
  utf8Bytes,
  truncateUtf8,
} from "./domain.ts";
import {
  absolutePath,
  restoredContainmentReceiptPath,
  restoredDiagnosticsPath,
  restoredOutputPath,
  restoredSessionPath,
} from "./paths.ts";
import { PersistenceSequencer } from "./async-primitives.ts";
import { Value } from "typebox/value";
import { AgentUsageSchema, decodePersistedAgentEvent, type AgentCompletionDto } from "./schemas.ts";
import type { RestorationContainmentDescriptor } from "./containment.ts";

interface DecodedAgentEventPayloadMapV1 {
  [AgentEventType.Spawned]: SpawnedPayload;
  [AgentEventType.RunLaunchRequested]: RunLaunchRequestedPayloadV1;
  [AgentEventType.RunStarted]: RunStartedPayload;
  [AgentEventType.RunStopping]: RunStoppingPayload;
  [AgentEventType.RunCompleted]: RestorableAgentCompletion;
}

export interface RestorationRunLaunchRequestedPayloadV2
  extends RunLaunchRequestedPayloadV1 {
  readonly containment: RestorationContainmentDescriptor;
}

export interface DecodedAgentEventPayloadMap extends DecodedAgentEventPayloadMapV1 {
  [AgentEventType.RunLaunchRequested]: RestorationRunLaunchRequestedPayloadV2;
}

type DecodedPersistedAgentEventV1 = {
  [K in AgentEventType]: {
    schemaVersion: 1;
    eventType: K;
    payload: DecodedAgentEventPayloadMapV1[K];
  };
}[AgentEventType];

type DecodedPersistedAgentEventV2 = {
  [K in AgentEventType]: {
    schemaVersion: 2;
    eventType: K;
    payload: DecodedAgentEventPayloadMap[K];
  };
}[AgentEventType];

export type DecodedPersistedAgentEvent =
  | DecodedPersistedAgentEventV1
  | DecodedPersistedAgentEventV2;

/** Matches Pi's `ExtensionAPI.appendEntry<T>(customType, data)` shape so it can be injected in tests. */
export type AppendEntryFn = (customType: string, data: unknown) => void;

/**
 * Decodes an `unknown` custom-entry payload into a fully-branded `DecodedPersistedAgentEvent`.
 * Throws `invalid_input: ...` when the envelope fails schema validation or a field fails
 * to brand; callers convert that failure into a bounded diagnostic rather than propagating it.
 */
export function decodeAgentEvent(value: unknown, stateRoot: AbsolutePath): DecodedPersistedAgentEvent {
  const dto = decodePersistedAgentEvent(value);
  switch (dto.eventType) {
    case AgentEventType.Spawned: {
      const payload: SpawnedPayload = {
        agentId: agentId(dto.payload.agentId),
        sessionPath: restoredSessionPath(stateRoot, dto.payload.sessionPath),
        cwd: absolutePath(dto.payload.cwd),
        provider: providerId(dto.payload.provider),
        modelId: modelId(dto.payload.modelId),
        thinkingLevel: dto.payload.thinkingLevel,
        tools: dto.payload.tools.map(toolName),
      };
      return { schemaVersion: dto.schemaVersion, eventType: dto.eventType, payload };
    }
    case AgentEventType.RunLaunchRequested: {
      const common: RunLaunchRequestedPayloadV1 = {
        agentId: agentId(dto.payload.agentId),
        previousLeafId:
          dto.payload.previousLeafId === null ? null : sessionEntryId(dto.payload.previousLeafId),
        attemptId: runAttemptId(dto.payload.attemptId),
        containmentReceiptPath: restoredContainmentReceiptPath(stateRoot, dto.payload.containmentReceiptPath),
      };
      if (dto.schemaVersion === 1) {
        return { schemaVersion: 1, eventType: dto.eventType, payload: common };
      }
      const payload: RestorationRunLaunchRequestedPayloadV2 = {
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
        containmentReceiptPath: restoredContainmentReceiptPath(stateRoot, dto.payload.containmentReceiptPath),
      };
      return { schemaVersion: dto.schemaVersion, eventType: dto.eventType, payload };
    }
    case AgentEventType.RunCompleted: {
      const payload = decodeCompletionPayload(dto.payload, stateRoot);
      return { schemaVersion: dto.schemaVersion, eventType: dto.eventType, payload };
    }
  }
}

function decodeCompletionPayload(dto: AgentCompletionDto, stateRoot: AbsolutePath): RestorableAgentCompletion {
  const textBytes = new TextEncoder().encode(dto.output.text).byteLength;
  if (textBytes !== dto.output.retainedBytes || dto.output.retainedBytes > MAX_COMPLETION_OUTPUT_BYTES ||
      dto.output.originalBytes < dto.output.retainedBytes ||
      dto.output.truncated !== (dto.output.originalBytes > dto.output.retainedBytes)) {
    throw new Error("invalid_input: inconsistent persisted completion output metadata");
  }
  if (dto.state === "failed" && new TextEncoder().encode(dto.error.message).byteLength > MAX_ERROR_MESSAGE_BYTES) {
    throw new Error("invalid_input: persisted completion error exceeds byte limit");
  }
  const base: Omit<RestorableAgentCompletion, "state" | "error" | "reason"> = {
    agentId: agentId(dto.agentId),
    runId: brandRunId(dto.runId),
    output: {
      text: dto.output.text,
      originalBytes: utf8Bytes(dto.output.originalBytes),
      retainedBytes: utf8Bytes(dto.output.retainedBytes),
      truncated: dto.output.truncated,
    },
    outputPath: restoredOutputPath(stateRoot, dto.outputPath),
    transcriptPath: restoredSessionPath(stateRoot, dto.transcriptPath),
    ...(dto.usage !== undefined ? { usage: validateUsage(dto.usage) } : {}),
  };
  if (dto.state === "failed" && dto.error !== undefined) {
    const diagnosticsPath =
      dto.error.diagnosticsPath === undefined
        ? undefined
        : restoredDiagnosticsPath(stateRoot, dto.error.diagnosticsPath);
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

export interface AgentMetadata {
  agentId: AgentId;
  sessionPath: SpawnedPayload["sessionPath"];
  cwd: SpawnedPayload["cwd"];
  provider: SpawnedPayload["provider"];
  modelId: SpawnedPayload["modelId"];
  thinkingLevel: SpawnedPayload["thinkingLevel"];
  tools: SpawnedPayload["tools"];
}

export type PendingLaunch =
  | { payload: RunLaunchRequestedPayloadV1; eventVersion: 1 }
  | { payload: RestorationRunLaunchRequestedPayloadV2; eventVersion: 2 };

export interface ActiveRun {
  runId: RunId;
  receiptPath: ContainmentReceiptPath;
  attemptId: RunAttemptId;
  containment?: RestorationContainmentDescriptor;
  eventVersion: 1 | 2;
}

export interface CompletedRunMetadata {
  readonly receiptPath: ContainmentReceiptPath;
  readonly attemptId: RunAttemptId;
  readonly containment?: RestorationContainmentDescriptor;
  readonly eventVersion: 1 | 2;
}

export interface CompletedRunCandidate extends CompletedRunMetadata {
  readonly payload: RestorableAgentCompletion;
}

export interface DurableCompletedRun extends CompletedRunMetadata {
  readonly payload: AgentCompletion;
}

export type FoldedAgentRecord = AgentMetadata & { completion?: CompletedRunCandidate } & (
  | { state: typeof AgentState.Stopped; pendingLaunch?: PendingLaunch }
  | { state: typeof AgentState.Running; run: ActiveRun }
  | { state: typeof AgentState.Stopping; run: ActiveRun; stopReason: CancellationReason }
);

export function pickMetadata(record: AgentMetadata): AgentMetadata {
  const { agentId, sessionPath, cwd, provider, modelId, thinkingLevel, tools } = record;
  return { agentId, sessionPath, cwd, provider, modelId, thinkingLevel, tools };
}

export type RestorationAction =
  | {
      type: typeof RestorationActionType.ValidateCompletedReceipt;
      agentId: AgentId;
      containmentReceiptPath: ContainmentReceiptPath;
      attemptId: RunAttemptId;
      descriptor?: RestorationContainmentDescriptor;
      eventVersion: 1 | 2;
    }
  | {
      type: typeof RestorationActionType.ReconcileLaunch;
      agentId: AgentId;
      attemptId: RunAttemptId;
      previousLeafId: SessionEntryId | null;
      containmentReceiptPath: ContainmentReceiptPath;
      descriptor?: RestorationContainmentDescriptor;
      eventVersion: 1 | 2;
    }
  | {
      type: typeof RestorationActionType.ReconcileStarted;
      agentId: AgentId;
      runId: RunId;
      containmentReceiptPath: ContainmentReceiptPath;
      attemptId: RunAttemptId;
      descriptor?: RestorationContainmentDescriptor;
      eventVersion: 1 | 2;
    }
  | {
      type: typeof RestorationActionType.ReconcileStopping;
      agentId: AgentId;
      runId: RunId;
      reason: CancellationReason;
      containmentReceiptPath: ContainmentReceiptPath;
      attemptId: RunAttemptId;
      descriptor?: RestorationContainmentDescriptor;
      eventVersion: 1 | 2;
    };

export interface RestoredRegistry {
  agents: Map<AgentId, FoldedAgentRecord>;
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
export function foldAgentEvents(entries: readonly FoldableEntry[], stateRoot: AbsolutePath): RestoredRegistry {
  const agents = new Map<AgentId, FoldedAgentRecord>();
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

    let event: DecodedPersistedAgentEvent;
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
    if (record.state === AgentState.Stopped && record.pendingLaunch !== undefined) {
      const { payload, eventVersion } = record.pendingLaunch;
      actions.push({
        type: RestorationActionType.ReconcileLaunch,
        agentId: record.agentId,
        attemptId: payload.attemptId,
        previousLeafId: payload.previousLeafId,
        containmentReceiptPath: payload.containmentReceiptPath,
        ...("containment" in payload ? { descriptor: payload.containment } : {}),
        eventVersion,
      });
    } else if (record.state === AgentState.Running) {
      actions.push({
        type: RestorationActionType.ReconcileStarted,
        agentId: record.agentId,
        runId: record.run.runId,
        containmentReceiptPath: record.run.receiptPath,
        attemptId: record.run.attemptId,
        ...(record.run.containment === undefined ? {} : { descriptor: record.run.containment }),
        eventVersion: record.run.eventVersion,
      });
    } else if (record.state === AgentState.Stopping) {
      actions.push({
        type: RestorationActionType.ReconcileStopping,
        agentId: record.agentId,
        runId: record.run.runId,
        reason: record.stopReason,
        containmentReceiptPath: record.run.receiptPath,
        attemptId: record.run.attemptId,
        ...(record.run.containment === undefined ? {} : { descriptor: record.run.containment }),
        eventVersion: record.run.eventVersion,
      });
    } else if (record.completion !== undefined) {
      actions.push({
        type: RestorationActionType.ValidateCompletedReceipt,
        agentId: record.agentId,
        containmentReceiptPath: record.completion.receiptPath,
        attemptId: record.completion.attemptId,
        ...(record.completion.containment === undefined ? {} : { descriptor: record.completion.containment }),
        eventVersion: record.completion.eventVersion,
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
  agents: Map<AgentId, FoldedAgentRecord>,
  event: DecodedPersistedAgentEvent,
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
      agents.set(event.payload.agentId, {
        ...record,
        pendingLaunch: event.schemaVersion === 1
          ? { payload: event.payload, eventVersion: 1 }
          : { payload: event.payload, eventVersion: 2 },
      });
      return;
    }
    case AgentEventType.RunStarted: {
      const record = agents.get(event.payload.agentId);
      if (record === undefined) {
        pushInvalid(`run_started for unknown agent ${event.payload.agentId}`);
        return;
      }
      const pending = record.state === AgentState.Stopped ? record.pendingLaunch : undefined;
      if (pending?.payload.attemptId !== event.payload.attemptId) {
        pushInvalid(`unmatched run_started for agent ${event.payload.agentId}`);
        return;
      }
      if (record.state !== AgentState.Stopped) {
        pushInvalid(`run_started while agent ${event.payload.agentId} was not stopped`);
        return;
      }
      agents.set(event.payload.agentId, {
        ...pickMetadata(record),
        ...(record.completion === undefined ? {} : { completion: record.completion }),
        state: AgentState.Running,
        run: {
          runId: event.payload.runId,
          receiptPath: pending.payload.containmentReceiptPath,
          attemptId: pending.payload.attemptId,
          ...(pending.eventVersion === 2 ? { containment: pending.payload.containment } : {}),
          eventVersion: pending.eventVersion,
        },
      });
      return;
    }
    case AgentEventType.RunStopping: {
      const record = agents.get(event.payload.agentId);
      if (record === undefined) {
        pushInvalid(`run_stopping for unknown agent ${event.payload.agentId}`);
        return;
      }
      if (record.state !== AgentState.Running || record.run.runId !== event.payload.runId) {
        pushInvalid(`unmatched run_stopping for agent ${event.payload.agentId}`);
        return;
      }
      agents.set(event.payload.agentId, {
        ...pickMetadata(record),
        ...(record.completion === undefined ? {} : { completion: record.completion }),
        state: AgentState.Stopping,
        run: { ...record.run, receiptPath: event.payload.containmentReceiptPath },
        stopReason: event.payload.reason,
      });
      return;
    }
    case AgentEventType.RunCompleted: {
      const record = agents.get(event.payload.agentId);
      if (record === undefined) {
        pushInvalid(`run_completed for unknown agent ${event.payload.agentId}`);
        return;
      }
      if (record.state === AgentState.Stopped || record.run.runId !== event.payload.runId) {
        pushInvalid(`duplicate or unmatched run_completed for agent ${event.payload.agentId}`);
        return;
      }
      if (record.sessionPath !== event.payload.transcriptPath) {
        agents.delete(event.payload.agentId);
        pushInvalid(`run_completed transcript mismatch for agent ${event.payload.agentId}`);
        return;
      }
      agents.set(event.payload.agentId, {
        ...pickMetadata(record),
        state: AgentState.Stopped,
        completion: {
          payload: event.payload,
          receiptPath: record.run.receiptPath,
          attemptId: record.run.attemptId,
          ...(record.run.containment === undefined ? {} : { containment: record.run.containment }),
          eventVersion: record.run.eventVersion,
        },
      });
      return;
    }
  }
}
