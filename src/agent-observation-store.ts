import { basename } from "node:path";

import {
  AgentState,
  agentCount,
  agentObservationRevision,
  agentRunKey,
  directAgentOrdinal,
  transcriptAssistantGroup,
  transcriptRevision,
  tryTranscriptFileName,
  transcriptSequence,
  type AbsolutePath,
  type AgentCompletion,
  type AgentId,
  type AgentObservationRevision,
  type AgentOrdinal,
  type AgentRunKey,
  type CompletionState,
  type ConversationStopReason,
  type ModelSpec,
  type RunId,
  type RunAttemptId,
  type SessionPath,
  type ThinkingLevel,
  type TranscriptRevision,
} from "./domain.ts";
import {
  deriveDisplayState,
  deriveModelLabel,
  deriveTaskLabel,
  directAgentRow,
  unknownModelLabel,
  type AcceptedRunObservationInput,
  type AgentActivity,
  type AgentObservation,
  type DirectAgentProjection,
  type DirectAgentSnapshotResult,
  type ObservationChange,
  type ObservationHealth,
  type ObservationListener,
  type ObservationReconciliationSnapshot,
  type ObservationSensitiveValues,
  type ObservationAttemptSinkFactory,
  type RpcObservationEvent,
  type RpcObservationSink,
  type ContextObservation,
  type ObservationHealthCode,
  type SpawnObservationInput,
  type SubagentObservationPort,
  type TranscriptItem,
  type TranscriptListener,
  type TranscriptSnapshot,
  type TranscriptSource,
  activityText,
} from "./agent-observation.ts";
import type { ContextObservationService } from "./context-observation.ts";
import type { RunRecord } from "./run-controller.ts";
import {
  MAX_DIRECT_AGENT_OBSERVATIONS,
  MAX_PENDING_ATTEMPT_BYTES,
  MAX_PENDING_ATTEMPT_EVENTS,
  MAX_PENDING_OBSERVATION_BYTES,
  MAX_PENDING_OBSERVATION_EVENTS,
  MAX_TRANSCRIPT_FIELD_BYTES,
  MAX_TRANSCRIPT_SOURCE_BYTES,
  MAX_TRANSCRIPT_SOURCE_ITEMS,
  MAX_TRANSCRIPT_STORE_BYTES,
  MAX_TRANSCRIPT_STORE_ITEMS,
} from "./constants.ts";

export type ObservationReconciliationPurpose = "restoration" | "projection-repair";

export interface AgentObservationMutationPort {
  registerSpawned(input: SpawnObservationInput): void;
  acceptRun(input: AcceptedRunObservationInput): void;
  updateLifecycle(record: Readonly<RunRecord>): void;
  publishCompletion(completion: AgentCompletion): void;
  registerSensitiveValues(values: ObservationSensitiveValues): void;
  acknowledgeDelivered(keys: readonly AgentRunKey[]): void;
  reconcile(snapshot: ObservationReconciliationSnapshot, purpose: ObservationReconciliationPurpose): void;
  dispose(): void;
}

export interface TranscriptBudgets {
  readonly perSourceItems: number;
  readonly perSourceBytes: number;
  readonly globalItems: number;
  readonly globalBytes: number;
}

export interface AgentObservationStoreOptions {
  readonly reconciliation?: () => ObservationReconciliationSnapshot;
  readonly diagnostic?: (message: string) => void;
  readonly transcriptBudgets?: TranscriptBudgets;
}

interface RetainedAgent {
  readonly agentId: AgentId;
  readonly ordinal: AgentOrdinal;
  readonly position: number;
  readonly sessionPath: SessionPath;
  readonly cwd: AbsolutePath;
  readonly model: ModelSpec;
  readonly thinkingLevel: ThinkingLevel;
  candidate: string;
  lifecycleState: AgentState;
  latestRunId?: RunId;
  acceptedAttemptId?: RunAttemptId;
  completionRunId?: RunId;
  completionState?: CompletionState;
  pendingDelivery: boolean;
  observation: AgentObservation;
}

const HEALTHY: ObservationHealth = Object.freeze({ kind: "healthy" });
const IDLE: AgentActivity = Object.freeze({ kind: "idle" });
const RESTORATION_UNAVAILABLE: AgentActivity = Object.freeze({ kind: "unavailable", reason: "restoration" });
const UNAVAILABLE_CONTEXT = Object.freeze({ kind: "unavailable" } as const);
const PROJECTION_UNAVAILABLE: AgentActivity = Object.freeze({ kind: "unavailable", reason: "projection" });
const TRANSPORT_UNAVAILABLE: AgentActivity = Object.freeze({ kind: "unavailable", reason: "transport" });

interface TranscriptEntry {
  item: TranscriptItem;
  readonly order: number;
  open: boolean;
  bytes: number;
}

interface RetainedTranscript {
  readonly agentId: AgentId;
  readonly source: TranscriptSource;
  readonly entries: TranscriptEntry[];
  readonly listeners: Set<TranscriptListener>;
  readonly blockIndex: Map<string, number>;
  assistantEntry?: TranscriptEntry;
  revision: TranscriptRevision;
  sequence: number;
  generation: number;
  generationOpen: boolean;
  truncatedBefore: boolean;
  availability: TranscriptSnapshot["availability"];
  boundRunId?: RunId;
  disabledRunId?: RunId;
  transportHealthy: boolean;
  snapshot?: TranscriptSnapshot;
  notificationScheduled: boolean;
  disposed: boolean;
}

interface PendingObservationAttempt {
  readonly agentId: AgentId;
  readonly attemptId: RunAttemptId;
  readonly creation: number;
  readonly events: RpcObservationEvent[];
  readonly onEvent: (event: RpcObservationEvent) => void;
  readonly onBind: (runId: RunId) => void;
  bytes: number;
  rejected: boolean;
  discarded: boolean;
  boundRunId?: RunId;
}

/** Process-local, UI-neutral projection of one controller's directly owned children. */
export class AgentObservationStore implements SubagentObservationPort, AgentObservationMutationPort, ObservationAttemptSinkFactory {
  private readonly agents = new Map<AgentId, RetainedAgent>();
  private readonly transcripts = new Map<AgentId, RetainedTranscript>();
  private readonly listeners = new Set<ObservationListener>();
  private readonly knownAgentIds = new Set<AgentId>();
  private readonly knownRunIds = new Set<RunId>();
  private readonly knownInternalPaths = new Set<AbsolutePath>();
  private readonly reconciliationSupplier: (() => ObservationReconciliationSnapshot) | undefined;
  private readonly diagnostic: (message: string) => void;
  private revision = agentObservationRevision(0);
  private health: ObservationHealth = HEALTHY;
  private snapshotCache: DirectAgentSnapshotResult | undefined;
  private pendingOrdinals = new Set<AgentOrdinal>();
  private pendingRescan = false;
  private notificationScheduled = false;
  private reconciliationScheduled = false;
  private retryReconciliation = false;
  private generation = 0;
  private disposed = false;
  private readonly attempts = new Map<RunAttemptId, PendingObservationAttempt>();
  private attemptCreation = 0;
  private pendingAttemptEvents = 0;
  private pendingAttemptBytes = 0;
  private retentionOrder = 0;
  private readonly transcriptBudgets: TranscriptBudgets;

  constructor(options: AgentObservationStoreOptions = {}) {
    this.reconciliationSupplier = options.reconciliation;
    this.diagnostic = options.diagnostic ?? (() => {});
    this.transcriptBudgets = options.transcriptBudgets ?? {
      perSourceItems: MAX_TRANSCRIPT_SOURCE_ITEMS,
      perSourceBytes: MAX_TRANSCRIPT_SOURCE_BYTES,
      globalItems: MAX_TRANSCRIPT_STORE_ITEMS,
      globalBytes: MAX_TRANSCRIPT_STORE_BYTES,
    };
  }

  observation(agentId: AgentId): AgentObservation | undefined {
    return this.disposed ? undefined : this.agents.get(agentId)?.observation;
  }

  directSnapshot(): DirectAgentSnapshotResult {
    // A disposed store keeps serving its final snapshot, so a reader that outlives it sees the last
    // truth rather than an empty tree. With no snapshot ever taken there is no such truth to serve.
    if (this.disposed) return this.snapshotCache ?? { kind: "unavailable", finalRevision: this.revision };
    if (this.snapshotCache !== undefined) return this.snapshotCache;
    const all = [...this.agents.values()];
    const active = all.filter((agent) => agent.lifecycleState !== AgentState.Stopped)
      .sort((left, right) => left.position - right.position);
    const selected = active.slice(0, MAX_DIRECT_AGENT_OBSERVATIONS);
    const remaining = MAX_DIRECT_AGENT_OBSERVATIONS - selected.length;
    if (remaining > 0) {
      const terminal = all.filter((agent) => agent.lifecycleState === AgentState.Stopped)
        .sort((left, right) => right.position - left.position)
        .slice(0, remaining);
      selected.push(...terminal);
    }
    selected.sort((left, right) => left.position - right.position);
    let locatorUnsafe = false;
    const entries = Object.freeze(selected.map((agent): DirectAgentProjection => {
      // The wire carries only an owner-relative basename; an unsafe one degrades the projection
      // without withdrawing the lifecycle row it belongs to.
      const transcriptFile = tryTranscriptFileName(basename(agent.sessionPath));
      if (transcriptFile === undefined) locatorUnsafe = true;
      return Object.freeze({
        agentId: agent.agentId,
        observation: agent.observation,
        row: directAgentRow(agent.observation),
        ...(transcriptFile === undefined ? {} : { transcriptFile }),
      });
    }));
    this.snapshotCache = Object.freeze({
      kind: "snapshot",
      revision: this.revision,
      health: locatorUnsafe ? withProjectionFailure(this.health) : this.health,
      total: agentCount(all.length),
      omitted: agentCount(all.length - entries.length),
      omittedActive: agentCount(Math.max(0, active.length - MAX_DIRECT_AGENT_OBSERVATIONS)),
      entries,
    });
    return this.snapshotCache;
  }

  transcriptSource(agentId: AgentId): TranscriptSource | undefined {
    return this.disposed ? undefined : this.transcripts.get(agentId)?.source;
  }

  subscribe(listener: ObservationListener): () => void {
    if (this.disposed) return () => {};
    this.listeners.add(listener);
    let active = true;
    return () => {
      if (!active) return;
      active = false;
      this.listeners.delete(listener);
    };
  }

  registerSpawned(input: SpawnObservationInput): void {
    if (this.disposed) return;
    if (this.agents.has(input.agentId)) { this.retryFailedReconciliation(); return; }
    const sensitiveChanged = this.addSensitiveValues({
      agentIds: new Set([input.agentId]),
      runIds: new Set(),
      internalPaths: new Set([input.sessionPath, input.cwd]),
    });
    const changed = sensitiveChanged ? this.rederiveAll() : [];
    const model = safeModel(input.model, input.thinkingLevel);
    const retained: RetainedAgent = {
      agentId: input.agentId,
      ordinal: input.ordinal,
      position: directPosition(input.ordinal),
      sessionPath: input.sessionPath,
      cwd: input.cwd,
      model: input.model,
      thinkingLevel: input.thinkingLevel,
      candidate: boundedCandidate(input.assignment),
      lifecycleState: AgentState.Stopped,
      pendingDelivery: false,
      observation: undefined as never,
    };
    retained.observation = freezeObservation(retained, this.nextRevision(), model, IDLE, this.labelContext());
    this.agents.set(input.agentId, retained);
    this.createTranscript(input.agentId, "stopped");
    changed.push(input.ordinal);
    this.commit(changed, false);
    this.retryFailedReconciliation();
  }

  acceptRun(input: AcceptedRunObservationInput): void {
    if (this.disposed) return;
    const agent = this.agents.get(input.agentId);
    if (agent === undefined || agent.latestRunId === input.runId) return;
    const candidate = boundedCandidate(input.assignment);
    const sensitiveChanged = this.addSensitiveValues({ agentIds: new Set(), runIds: new Set([input.runId]), internalPaths: new Set() });
    const equivalent = agent.latestRunId === input.runId && agent.candidate === candidate;
    agent.latestRunId = input.runId;
    agent.acceptedAttemptId = input.attemptId;
    this.acceptTranscriptRun(input.agentId, input.runId);
    agent.candidate = candidate;
    const changed = sensitiveChanged ? this.rederiveAll() : [];
    if (!equivalent || !sameTask(agent.observation, candidate, this.labelContext())) {
      this.replaceObservation(agent, { taskLabel: deriveTaskLabel(candidate, this.labelContext()), context: UNAVAILABLE_CONTEXT, activity: IDLE });
      changed.push(agent.ordinal);
    }
    if (changed.length > 0) this.commit(changed, false);
    this.retryFailedReconciliation();
  }

  createAttemptSink(agentId: AgentId, attemptId: RunAttemptId): RpcObservationSink {
    return this.createRoutedAttemptSink(agentId, attemptId, () => {}, () => {});
  }

  createRoutedAttemptSink(
    agentId: AgentId,
    attemptId: RunAttemptId,
    onEvent: (event: RpcObservationEvent) => void,
    onBind: (runId: RunId) => void,
  ): RpcObservationSink {
    const attempt: PendingObservationAttempt = {
      agentId, attemptId, creation: ++this.attemptCreation, events: [], onEvent, onBind,
      bytes: 0, rejected: this.disposed || this.attempts.has(attemptId), discarded: false,
    };
    if (!attempt.rejected) this.attempts.set(attemptId, attempt);
    return {
      record: (event) => this.recordAttempt(attempt, event),
      bind: (runId) => this.bindAttempt(attempt, runId),
      discard: () => this.releaseAttempt(attempt),
    };
  }

  updateContext(agentId: AgentId, runId: RunId, context: ContextObservation): void {
    if (this.disposed) return;
    const agent = this.agents.get(agentId);
    if (agent === undefined || agent.latestRunId !== runId) return;
    const frozen = Object.freeze({ ...context });
    if (this.replaceObservation(agent, { context: frozen })) this.commit([agent.ordinal], false);
  }

  failObservationProjection(agentId: AgentId): void {
    if (this.disposed) return;
    const agent = this.agents.get(agentId);
    if (agent === undefined) return;
    if (this.replaceObservation(agent, { activity: PROJECTION_UNAVAILABLE, context: UNAVAILABLE_CONTEXT })) {
      this.commit([agent.ordinal], false);
    }
    this.reportProjectionFailure();
  }

  updateLifecycle(record: Readonly<RunRecord>): void {
    if (this.disposed) return;
    const agent = this.agents.get(record.agentId);
    if (agent === undefined) { this.retryFailedReconciliation(); return; }
    const runChanged = record.runId !== undefined && agent.latestRunId !== record.runId;
    const stateChanged = agent.lifecycleState !== record.state;
    if (!runChanged && !stateChanged) { this.retryFailedReconciliation(); return; }
    let sensitiveChanged = false;
    if (record.runId !== undefined) {
      agent.latestRunId = record.runId;
      sensitiveChanged = this.addSensitiveValues({ agentIds: new Set(), runIds: new Set([record.runId]), internalPaths: new Set() });
    }
    const changed = sensitiveChanged ? this.rederiveAll() : [];
    agent.lifecycleState = record.state;
    this.projectTranscriptLifecycle(agent, record.runId);
    const before = agent.observation;
    this.replaceObservation(agent, {});
    if (agent.observation !== before) changed.push(agent.ordinal);
    this.commit(changed, false);
    this.retryFailedReconciliation();
  }

  publishCompletion(completion: AgentCompletion): void {
    if (this.disposed) return;
    const agent = this.agents.get(completion.agentId);
    if (agent === undefined) { this.retryFailedReconciliation(); return; }
    const sensitiveChanged = this.addSensitiveValues({
      agentIds: new Set(),
      runIds: new Set([completion.runId]),
      internalPaths: new Set([
        completion.outputPath,
        completion.transcriptPath,
        ...(completion.state === "failed" && completion.error.diagnosticsPath !== undefined ? [completion.error.diagnosticsPath] : []),
      ]),
    });
    const equivalent = agent.completionRunId === completion.runId && agent.completionState === completion.state && agent.pendingDelivery;
    if (equivalent && !sensitiveChanged) { this.retryFailedReconciliation(); return; }
    agent.latestRunId = completion.runId;
    agent.completionRunId = completion.runId;
    agent.completionState = completion.state;
    agent.pendingDelivery = true;
    const changed = sensitiveChanged ? this.rederiveAll() : [];
    const before = agent.observation;
    this.replaceObservation(agent, {});
    if (agent.observation !== before) changed.push(agent.ordinal);
    this.commit(changed, false);
    this.retryFailedReconciliation();
  }

  registerSensitiveValues(values: ObservationSensitiveValues): void {
    if (this.disposed) return;
    if (this.addSensitiveValues(values)) {
      const changed = this.rederiveAll();
      this.commit(changed, false);
    }
    this.retryFailedReconciliation();
  }

  acknowledgeDelivered(keys: readonly AgentRunKey[]): void {
    if (this.disposed || keys.length === 0) return;
    const wanted = new Set(keys);
    const changed: AgentOrdinal[] = [];
    for (const agent of this.agents.values()) {
      if (agent.completionRunId === undefined || !agent.pendingDelivery || !wanted.has(agentRunKey(agent.agentId, agent.completionRunId))) continue;
      agent.pendingDelivery = false;
      this.replaceObservation(agent, {});
      changed.push(agent.ordinal);
    }
    if (changed.length > 0) this.commit(changed, false);
    this.retryFailedReconciliation();
  }

  reconcile(snapshot: ObservationReconciliationSnapshot, purpose: ObservationReconciliationPurpose = "restoration"): void {
    if (this.disposed) return;
    const sensitiveChanged = this.registerSensitiveValuesWithoutCommit(snapshot.sensitiveValues);
    const authorities = new Map(snapshot.agents.map((agent) => [agent.agentId, agent]));
    const runs = new Map(snapshot.runs.map((run) => [run.agentId, run]));
    const completions = new Map(snapshot.completions.map((completion) => [completion.agentId, completion]));
    const changed: AgentOrdinal[] = [];
    const changedTranscripts = new Set<RetainedTranscript>(sensitiveChanged ? this.transcripts.values() : []);
    const authoritativeIds = new Set(snapshot.spawnSequence);
    for (const [id, agent] of this.agents) {
      if (authoritativeIds.has(id)) continue;
      this.agents.delete(id);
      this.disposeTranscript(this.transcripts.get(id));
      this.transcripts.delete(id);
      changed.push(agent.ordinal);
    }
    for (let index = 0; index < snapshot.spawnSequence.length; index++) {
      const id = snapshot.spawnSequence[index]!;
      const authority = authorities.get(id);
      if (authority === undefined) continue;
      let agent = this.agents.get(id);
      const run = runs.get(id);
      const completion = completions.get(id);
      const runId = run?.runId ?? completion?.runId;
      const assignment = runId === undefined ? undefined : snapshot.acceptedAssignments.get(agentRunKey(id, runId));
      const ordinal = directAgentOrdinal(index + 1);
      const requiresRestoration = purpose === "restoration" || agent === undefined;
      if (agent === undefined) {
        this.registerSpawnedWithoutCommit({ ...authority, ordinal, assignment: assignment ?? "Delegated task" });
        changed.push(ordinal);
        agent = this.agents.get(id)!;
      } else if (agent.ordinal !== ordinal || agent.model !== authority.model || agent.thinkingLevel !== authority.thinkingLevel) {
        const priorOrdinal = agent.ordinal;
        const replacement: RetainedAgent = {
          ...agent,
          ordinal,
          position: index + 1,
          cwd: authority.cwd,
          model: authority.model,
          thinkingLevel: authority.thinkingLevel,
          observation: Object.freeze({
            ...agent.observation,
            ordinal,
            modelLabel: safeModel(authority.model, authority.thinkingLevel),
            revision: this.nextRevision(),
          }),
        };
        this.agents.set(id, replacement);
        agent = replacement;
        changed.push(priorOrdinal, ordinal);
      }
      const candidate = boundedCandidate(assignment ?? agent.candidate ?? "Delegated task");
      const lifecycleState = run?.state ?? AgentState.Stopped;
      const pending = completion === undefined ? false : snapshot.pendingDelivery.has(agentRunKey(id, completion.runId));
      const before = agent.observation;
      agent.candidate = candidate;
      agent.lifecycleState = lifecycleState;
      const restoredAvailability = lifecycleState === AgentState.Stopped ? "stopped" : "unavailable";
      const transcript = this.createTranscript(id, restoredAvailability);
      if (requiresRestoration) {
        const transcriptChanged = transcript.boundRunId !== runId || transcript.availability !== restoredAvailability;
        if (runId === undefined) delete transcript.boundRunId;
        else transcript.boundRunId = runId;
        transcript.availability = restoredAvailability;
        if (transcriptChanged) changedTranscripts.add(transcript);
      }
      if (runId === undefined) delete agent.latestRunId;
      else agent.latestRunId = runId;
      if (completion === undefined) {
        delete agent.completionRunId;
        delete agent.completionState;
      } else {
        agent.completionRunId = completion.runId;
        agent.completionState = completion.state;
      }
      agent.pendingDelivery = pending;
      this.replaceObservation(agent, requiresRestoration
        ? { activity: RESTORATION_UNAVAILABLE, context: UNAVAILABLE_CONTEXT }
        : {});
      if (agent.observation !== before) changed.push(agent.ordinal);
    }
    this.commitTranscripts(changedTranscripts);
    const healthChanged = this.health.kind !== "healthy";
    this.health = HEALTHY;
    this.retryReconciliation = false;
    if (changed.length > 0 || healthChanged) this.commit(changed, changed.length > MAX_DIRECT_AGENT_OBSERVATIONS);
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.generation++;
    this.revision = agentObservationRevision(Number(this.revision) + 1);
    this.listeners.clear();
    this.pendingOrdinals.clear();
    this.pendingRescan = false;
    this.notificationScheduled = false;
    this.reconciliationScheduled = false;
    for (const source of this.transcripts.values()) this.disposeTranscript(source);
    this.agents.clear();
    this.attempts.clear();
    this.pendingAttemptEvents = 0;
    this.pendingAttemptBytes = 0;
    this.snapshotCache = Object.freeze({ kind: "unavailable", finalRevision: this.revision });
  }

  /** Explicit test seam; not part of the widget-facing port. */
  testAdapter(): { reportProjectionFailure(): void; correlationCount(agentId: AgentId): number; transcriptItemCount(): number } {
    return {
      reportProjectionFailure: () => this.reportProjectionFailure(),
      correlationCount: (agentId) => {
        const source = this.transcripts.get(agentId);
        return source?.blockIndex.size ?? 0;
      },
      transcriptItemCount: () => [...this.transcripts.values()].reduce((total, source) => total + source.entries.length, 0),
    };
  }

  /** Emergency operation for the total RPC adapter. */
  failTranscriptProjection(agentId: AgentId, runId: RunId): void {
    try {
      const source = this.transcripts.get(agentId);
      if (source === undefined || source.boundRunId !== runId) return;
      const affected = new Set<RetainedTranscript>();
      this.failTranscript(source, runId, affected);
      this.enforceTranscriptBudgets(source, affected);
      this.commitTranscripts(affected);
    } catch { /* emergency operation is total */ }
  }

  failAttemptProjection(agentId: AgentId, attemptId: RunAttemptId): void {
    const attempt = this.attempts.get(attemptId);
    if (attempt !== undefined && attempt.agentId === agentId) {
      if (attempt.boundRunId === undefined) this.rejectAttempt(attempt);
      else this.failTranscriptProjection(agentId, attempt.boundRunId);
      return;
    }
    const agent = this.agents.get(agentId);
    if (agent?.acceptedAttemptId === attemptId && agent.latestRunId !== undefined) this.failTranscriptProjection(agentId, agent.latestRunId);
  }

  private recordAttempt(attempt: PendingObservationAttempt, event: RpcObservationEvent): void {
    if (this.disposed || attempt.rejected) return;
    if (attempt.boundRunId !== undefined) {
      this.projectTranscript(attempt.agentId, attempt.boundRunId, event);
      this.projectActivity(attempt.agentId, attempt.boundRunId, event);
      attempt.onEvent(event);
      return;
    }
    const bytes = new TextEncoder().encode(JSON.stringify(event)).byteLength;
    if (attempt.events.length + 1 > MAX_PENDING_ATTEMPT_EVENTS || attempt.bytes + bytes > MAX_PENDING_ATTEMPT_BYTES) {
      this.rejectAttempt(attempt);
      return;
    }
    while (this.pendingAttemptEvents + 1 > MAX_PENDING_OBSERVATION_EVENTS || this.pendingAttemptBytes + bytes > MAX_PENDING_OBSERVATION_BYTES) {
      const oldest = [...this.attempts.values()].filter((value) => !value.rejected && value.boundRunId === undefined)
        .sort((left, right) => left.creation - right.creation)[0];
      if (oldest === undefined) { this.rejectAttempt(attempt); return; }
      this.rejectAttempt(oldest);
      if (attempt.rejected) return;
    }
    attempt.events.push(cloneObservationEvent(event));
    attempt.bytes += bytes;
    this.pendingAttemptEvents++;
    this.pendingAttemptBytes += bytes;
  }

  private bindAttempt(attempt: PendingObservationAttempt, runId: RunId): void {
    if (this.disposed || attempt.discarded || attempt.boundRunId !== undefined) return;
    const agent = this.agents.get(attempt.agentId);
    if (attempt.rejected) {
      if (agent?.latestRunId === runId && agent.acceptedAttemptId === attempt.attemptId) this.failTranscriptProjection(attempt.agentId, runId);
      return;
    }
    if (agent === undefined || agent.latestRunId !== runId || agent.acceptedAttemptId !== attempt.attemptId) {
      this.rejectAttempt(attempt);
      return;
    }
    attempt.boundRunId = runId;
    const events = attempt.events.splice(0);
    this.pendingAttemptEvents -= events.length;
    this.pendingAttemptBytes -= attempt.bytes;
    attempt.bytes = 0;
    this.bindTranscriptRun(attempt.agentId, runId);
    attempt.onBind(runId);
    for (const event of events) {
      this.projectTranscript(attempt.agentId, runId, event);
      this.projectActivity(attempt.agentId, runId, event);
      attempt.onEvent(event);
    }
  }

  private createTranscript(agentId: AgentId, availability: TranscriptSnapshot["availability"]): RetainedTranscript {
    const existing = this.transcripts.get(agentId);
    if (existing !== undefined) return existing;
    let retained!: RetainedTranscript;
    const source: TranscriptSource = Object.freeze({
      snapshot: (): TranscriptSnapshot => this.transcriptSnapshot(retained),
      subscribe: (listener: TranscriptListener): (() => void) => {
        if (retained.disposed) return () => {};
        retained.listeners.add(listener);
        let active = true;
        return () => { if (active) { active = false; retained.listeners.delete(listener); } };
      },
    });
    retained = {
      agentId, source, entries: [], listeners: new Set(), blockIndex: new Map(),
      revision: transcriptRevision(0), sequence: 0, generation: 0, generationOpen: false,
      truncatedBefore: false, availability, transportHealthy: false, notificationScheduled: false, disposed: false,
    };
    this.transcripts.set(agentId, retained);
    return retained;
  }

  private transcriptSnapshot(source: RetainedTranscript): TranscriptSnapshot {
    if (source.snapshot !== undefined) return source.snapshot;
    const items = Object.freeze(source.entries.map((entry) => entry.item));
    const agent = this.agents.get(source.agentId);
    const managed = new Set<string>([...this.knownInternalPaths].map(String));
    if (agent !== undefined) managed.delete(String(agent.cwd));
    source.snapshot = Object.freeze({
      revision: source.revision,
      items,
      truncatedBefore: source.truncatedBefore,
      availability: source.availability,
      sensitiveValues: Object.freeze({
        nativeIds: Object.freeze(new Set<string>([...this.knownAgentIds, ...this.knownRunIds].map(String))) as ReadonlySet<string>,
        managedPathsAndNames: Object.freeze(managed) as ReadonlySet<string>,
      }),
      ...(agent === undefined ? {} : { renderingCwd: agent.cwd }),
    });
    return source.snapshot;
  }

  private acceptTranscriptRun(agentId: AgentId, runId: RunId): void {
    const source = this.transcripts.get(agentId);
    if (source === undefined || source.disabledRunId === runId) return;
    const changed = source.disabledRunId !== undefined || source.boundRunId !== undefined || source.availability !== "unavailable";
    delete source.disabledRunId;
    source.boundRunId = runId;
    source.transportHealthy = false;
    source.generationOpen = false;
    this.releaseRunCorrelations(source);
    source.availability = "unavailable";
    if (changed) this.commitTranscripts(new Set([source]));
  }

  private bindTranscriptRun(agentId: AgentId, runId: RunId): void {
    const source = this.transcripts.get(agentId);
    if (source === undefined || source.boundRunId !== runId || source.disabledRunId === runId) return;
    source.transportHealthy = true;
    if (source.availability !== "live") {
      source.availability = "live";
      this.commitTranscripts(new Set([source]));
    }
  }

  private projectTranscript(agentId: AgentId, runId: RunId, event: RpcObservationEvent): void {
    const source = this.transcripts.get(agentId);
    if (source === undefined || source.boundRunId !== runId || source.disabledRunId === runId) return;
    const affected = new Set<RetainedTranscript>();
    const sequenceBefore = source.sequence;
    switch (event.kind) {
      case "prompt-accepted":
        this.insertTranscript(source, Object.freeze({ sequence: this.nextTranscriptSequence(source), runId, kind: "user", text: boundedTranscriptPrefix(event.text) }), false, affected);
        break;
      case "assistant-start":
        if (source.generationOpen) { this.failTranscript(source, runId, affected, sequenceBefore); this.enforceTranscriptBudgets(source, affected); this.commitTranscripts(affected); return; }
        source.generation++;
        source.generationOpen = true;
        source.blockIndex.clear();
        source.assistantEntry = this.insertTranscript(source, Object.freeze({
          sequence: this.nextTranscriptSequence(source),
          runId,
          kind: "assistant",
          group: transcriptAssistantGroup(source.generation),
          phase: "partial",
          blocks: Object.freeze([]),
        }), true, affected);
        break;
      case "assistant-content": {
        if (!source.generationOpen || source.assistantEntry === undefined) { this.failTranscript(source, runId, affected, sequenceBefore); this.enforceTranscriptBudgets(source, affected); this.commitTranscripts(affected); return; }
        if (event.phase === "start") break;
        const entry = source.assistantEntry;
        const owner = assistantTranscriptItem(entry.item);
        const key = assistantKey(runId, source.generation, event.contentIndex, event.contentKind);
        const located = source.blockIndex.get(key);
        const previous = located === undefined ? undefined : owner.blocks[located];
        if (previous?.kind === event.contentKind && previous.phase === "final") break;
        const previousText = previous?.kind === event.contentKind ? previous.text : "";
        const text = event.phase === "delta"
          ? boundedTranscriptPrefix(`${previousText}${event.delta}`)
          : boundedTranscriptPrefix(event.text);
        const block = Object.freeze({ kind: event.contentKind, phase: event.phase === "end" ? "final" as const : "partial" as const, text });
        const blocks = [...owner.blocks];
        if (located === undefined) {
          source.blockIndex.set(key, blocks.length);
          blocks.push(block);
        } else {
          blocks[located] = block;
        }
        this.replaceTranscript(source, entry, Object.freeze({ ...owner, blocks: Object.freeze(blocks) }), true, affected);
        break;
      }
      case "assistant-end": {
        if (!source.generationOpen || source.assistantEntry === undefined) { this.failTranscript(source, runId, affected, sequenceBefore); this.enforceTranscriptBudgets(source, affected); this.commitTranscripts(affected); return; }
        const entry = source.assistantEntry;
        const owner = assistantTranscriptItem(entry.item);
        const blocks = [...owner.blocks];
        for (const finalBlock of event.finalBlocks) {
          const key = assistantKey(runId, source.generation, finalBlock.contentIndex, finalBlock.kind);
          const located = source.blockIndex.get(key);
          const block = Object.freeze({ kind: finalBlock.kind, phase: "final" as const, text: boundedTranscriptPrefix(finalBlock.text) });
          if (located === undefined) {
            source.blockIndex.set(key, blocks.length);
            blocks.push(block);
          } else {
            blocks[located] = block;
          }
        }
        const finalised = blocks.map((block) => block.kind === "tool" || block.phase === "final"
          ? block
          : Object.freeze({ ...block, phase: "final" as const }));
        this.replaceTranscript(source, entry, Object.freeze({
          ...owner,
          phase: "final",
          stopReason: conversationStopReason(event.stopReason),
          blocks: Object.freeze(finalised),
        }), false, affected);
        delete source.assistantEntry;
        source.blockIndex.clear();
        source.generationOpen = false;
        break;
      }
      case "tool": {
        if (source.assistantEntry === undefined) {
          source.generation++;
          source.blockIndex.clear();
          source.assistantEntry = this.insertTranscript(source, Object.freeze({
            sequence: this.nextTranscriptSequence(source),
            runId,
            kind: "assistant",
            group: transcriptAssistantGroup(source.generation),
            phase: "partial",
            blocks: Object.freeze([]),
          }), true, affected);
        }
        const entry = source.assistantEntry;
        const owner = assistantTranscriptItem(entry.item);
        const key = `${runId}\u0000${event.toolCallId}`;
        const located = source.blockIndex.get(key);
        const previous = located === undefined ? undefined : owner.blocks[located];
        const priorPresentation = previous?.kind === "tool" ? previous.presentation : undefined;
        const presentation = Object.freeze({
          ...priorPresentation,
          callId: event.toolCallId,
          tool: event.tool,
          phase: event.phase,
          ...(event.preview === undefined ? {} : { preview: boundedTranscriptPrefix(event.preview) }),
          ...(event.arguments === undefined ? {} : { arguments: event.arguments }),
          ...(event.result === undefined ? {} : { result: event.result }),
        });
        const blocks = [...owner.blocks];
        const block = Object.freeze({ kind: "tool" as const, presentation });
        if (located === undefined) {
          source.blockIndex.set(key, blocks.length);
          blocks.push(block);
        } else {
          blocks[located] = block;
        }
        this.replaceTranscript(source, entry, Object.freeze({ ...owner, blocks: Object.freeze(blocks) }), source.generationOpen || event.phase === "running", affected);
        if (event.phase !== "running") source.blockIndex.delete(key);
        break;
      }
      case "transport-unavailable":
        if (source.transportHealthy) {
          source.transportHealthy = false;
          source.availability = "unavailable";
          this.insertTranscript(source, Object.freeze({ sequence: this.nextTranscriptSequence(source), kind: "notice", code: "transport-unavailable" }), false, affected);
        }
        break;
      case "agent-settled":
      case "turn-end":
      case "compaction":
        break;
    }
    this.enforceTranscriptBudgets(source, affected, sequenceBefore);
    this.commitTranscripts(affected);
  }

  private insertTranscript(source: RetainedTranscript, item: TranscriptItem, open: boolean, affected: Set<RetainedTranscript>): TranscriptEntry {
    const entry: TranscriptEntry = { item, order: ++this.retentionOrder, open, bytes: transcriptItemBytes(item) };
    source.entries.push(entry); affected.add(source);
    return entry;
  }

  private replaceTranscript(source: RetainedTranscript, entry: TranscriptEntry, item: TranscriptItem, open: boolean, affected: Set<RetainedTranscript>): void {
    const bytes = transcriptItemBytes(item);
    if (sameTranscriptItem(entry.item, item) && entry.open === open) return;
    entry.item = item; entry.open = open; entry.bytes = bytes; affected.add(source);
  }

  private enforceTranscriptBudgets(owner: RetainedTranscript, affected: Set<RetainedTranscript>, ownerSequenceBefore?: number): void {
    while (sourceOverBudget(owner, this.transcriptBudgets)) {
      const closed = oldestEntry(owner.entries, false);
      if (closed !== undefined) {
        this.evictTranscript(owner, closed, affected);
        continue;
      }
      const oldestOpen = oldestEntry(owner.entries, true);
      if (!this.failTranscript(owner, owner.boundRunId, affected, ownerSequenceBefore) && oldestOpen !== undefined) {
        this.evictTranscript(owner, oldestOpen, affected);
      }
    }
    while (storeOverBudget(this.transcripts.values(), this.transcriptBudgets)) {
      const sources = [...this.transcripts.values()];
      const closed = sources.flatMap((source) => source.entries.map((entry) => ({ source, entry })))
        .filter(({ entry }) => !entry.open).sort((left, right) => left.entry.order - right.entry.order)[0];
      if (closed !== undefined) {
        this.evictTranscript(closed.source, closed.entry, affected);
        continue;
      }
      const open = sources.flatMap((source) => source.entries.map((entry) => ({ source, entry })))
        .sort((left, right) => left.entry.order - right.entry.order)[0];
      if (open === undefined) return;
      const rollback = open.source === owner ? ownerSequenceBefore : undefined;
      if (!this.failTranscript(open.source, open.source.boundRunId, affected, rollback)) {
        this.evictTranscript(open.source, open.entry, affected);
      }
    }
  }

  private evictTranscript(source: RetainedTranscript, entry: TranscriptEntry, affected: Set<RetainedTranscript>): void {
    const index = source.entries.indexOf(entry);
    if (index < 0) return;
    source.entries.splice(index, 1);
    source.truncatedBefore = true;
    this.releaseEntryCorrelations(source, entry);
    affected.add(source);
  }

  private failTranscript(
    source: RetainedTranscript | undefined,
    runId: RunId | undefined,
    affected?: Set<RetainedTranscript>,
    sequenceBefore?: number,
  ): boolean {
    if (source === undefined || source.disposed || runId === undefined || source.disabledRunId === runId) return false;
    source.entries.length = 0;
    source.blockIndex.clear(); delete source.assistantEntry; source.generationOpen = false;
    source.disabledRunId = runId; source.transportHealthy = false; source.availability = "unavailable";
    if (sequenceBefore !== undefined) source.sequence = sequenceBefore;
    const item = Object.freeze({ sequence: this.nextTranscriptSequence(source), kind: "notice" as const, code: "projection-unavailable" as const });
    const notice: TranscriptEntry = { item, order: ++this.retentionOrder, open: false, bytes: transcriptItemBytes(item) };
    source.entries.push(notice);
    if (affected === undefined) this.commitTranscripts(new Set([source]));
    else affected.add(source);
    return true;
  }

  private nextTranscriptSequence(source: RetainedTranscript) { return transcriptSequence(++source.sequence); }

  private releaseEntryCorrelations(source: RetainedTranscript, entry: TranscriptEntry): void {
    if (source.assistantEntry !== entry) return;
    source.blockIndex.clear();
    delete source.assistantEntry;
  }

  private releaseRunCorrelations(source: RetainedTranscript, runId?: RunId): void {
    if (runId !== undefined && source.assistantEntry?.item.kind === "assistant"
      && source.assistantEntry.item.runId !== runId) return;
    source.blockIndex.clear();
    delete source.assistantEntry;
  }

  private commitTranscripts(sources: Set<RetainedTranscript>): void {
    for (const source of sources) {
      if (source.disposed) continue;
      source.revision = transcriptRevision(Number(source.revision) + 1);
      delete source.snapshot;
      this.scheduleTranscriptNotification(source);
    }
  }

  private scheduleTranscriptNotification(source: RetainedTranscript): void {
    if (source.notificationScheduled || source.disposed) return;
    source.notificationScheduled = true;
    const generation = this.generation;
    queueMicrotask(() => {
      source.notificationScheduled = false;
      if (source.disposed || this.disposed || generation !== this.generation) return;
      const snapshot = this.transcriptSnapshot(source);
      for (const listener of [...source.listeners]) {
        if (!source.listeners.has(listener)) continue;
        try {
          const returned = listener(snapshot);
          if (isThenable(returned)) { source.listeners.delete(listener); void Promise.resolve(returned).catch(() => undefined); }
        } catch { source.listeners.delete(listener); }
      }
    });
  }

  private projectActivity(agentId: AgentId, runId: RunId, event: RpcObservationEvent): void {
    try {
      const agent = this.agents.get(agentId);
      if (agent === undefined || agent.latestRunId !== runId) return;
      let activity: AgentActivity | undefined;
      if (event.kind === "assistant-content" && event.phase === "delta") {
        activity = Object.freeze({ kind: event.contentKind === "thinking" ? "thinking" : "responding", preview: boundedActivityPreview(event.delta) });
      } else if (event.kind === "tool") {
        activity = Object.freeze({ kind: "tool", tool: event.tool, phase: event.phase,
          ...(event.preview === undefined ? {} : { preview: boundedActivityPreview(event.preview) }) });
      } else if (event.kind === "agent-settled") activity = IDLE;
      else if (event.kind === "transport-unavailable") activity = TRANSPORT_UNAVAILABLE;
      if (activity !== undefined && this.replaceObservation(agent, { activity })) this.commit([agent.ordinal], false);
    } catch {
      try { this.failObservationProjection(agentId); } catch { /* activity projection is total */ }
    }
  }

  private rejectAttempt(attempt: PendingObservationAttempt): void {
    if (attempt.rejected) return;
    attempt.rejected = true;
    this.pendingAttemptEvents -= attempt.events.length;
    this.pendingAttemptBytes -= attempt.bytes;
    attempt.events.length = 0;
    attempt.bytes = 0;
    this.attempts.delete(attempt.attemptId);
  }

  private releaseAttempt(attempt: PendingObservationAttempt): void {
    if (attempt.discarded) return;
    attempt.discarded = true;
    if (attempt.rejected) return;
    if (attempt.boundRunId !== undefined) {
      attempt.rejected = true;
      this.attempts.delete(attempt.attemptId);
      return;
    }
    this.rejectAttempt(attempt);
  }

  private reportProjectionFailure(): void {
    if (this.disposed) return;
    const next = Object.freeze({ kind: "degraded" as const, codes: Object.freeze(["projection-failed" as const]) });
    if (this.health.kind !== "degraded" || this.health.codes[0] !== "projection-failed") {
      this.health = next;
      this.commit([], false);
    }
    this.scheduleReconciliation();
  }

  private scheduleReconciliation(): void {
    if (this.reconciliationScheduled || this.reconciliationSupplier === undefined || this.disposed) return;
    this.reconciliationScheduled = true;
    const generation = this.generation;
    queueMicrotask(() => {
      this.reconciliationScheduled = false;
      if (this.disposed || generation !== this.generation) return;
      try { this.reconcile(this.reconciliationSupplier!(), "projection-repair"); }
      catch {
        this.health = Object.freeze({ kind: "degraded", codes: Object.freeze(["reconciliation-failed" as const]) });
        this.retryReconciliation = true;
        this.commit([], false);
      }
    });
  }

  private retryFailedReconciliation(): void {
    if (!this.retryReconciliation) return;
    this.retryReconciliation = false;
    this.scheduleReconciliation();
  }

  private registerSpawnedWithoutCommit(input: SpawnObservationInput): void {
    if (this.agents.has(input.agentId)) return;
    this.addSensitiveValues({ agentIds: new Set([input.agentId]), runIds: new Set(), internalPaths: new Set([input.sessionPath, input.cwd]) }, false);
    const retained: RetainedAgent = {
      agentId: input.agentId, ordinal: input.ordinal, position: directPosition(input.ordinal),
      sessionPath: input.sessionPath, cwd: input.cwd, model: input.model,
      thinkingLevel: input.thinkingLevel, candidate: boundedCandidate(input.assignment), lifecycleState: AgentState.Stopped,
      pendingDelivery: false, observation: undefined as never,
    };
    retained.observation = freezeObservation(retained, this.nextRevision(), safeModel(input.model, input.thinkingLevel), RESTORATION_UNAVAILABLE, this.labelContext());
    this.agents.set(input.agentId, retained);
    this.createTranscript(input.agentId, "stopped");
  }

  private projectTranscriptLifecycle(agent: RetainedAgent, runId: RunId | undefined): void {
    const source = this.transcripts.get(agent.agentId);
    if (source === undefined) return;
    if (agent.lifecycleState === AgentState.Stopped) {
      const terminalRunId = runId ?? source.boundRunId;
      this.releaseRunCorrelations(source, terminalRunId);
      if (terminalRunId !== undefined) for (const entry of source.entries) {
        if (entry.open && "runId" in entry.item && entry.item.runId === terminalRunId) entry.open = false;
      }
      source.generationOpen = false;
      source.transportHealthy = false;
      delete source.boundRunId;
      const availability = source.disabledRunId === (runId ?? agent.latestRunId) ? "unavailable" : "stopped";
      if (source.availability !== availability) { source.availability = availability; this.commitTranscripts(new Set([source])); }
    } else if (!source.transportHealthy && source.availability !== "unavailable") {
      source.availability = "unavailable";
      this.commitTranscripts(new Set([source]));
    }
  }

  private disposeTranscript(source: RetainedTranscript | undefined): void {
    if (source === undefined || source.disposed) return;
    source.disposed = true;
    source.notificationScheduled = false;
    source.listeners.clear();
    source.blockIndex.clear(); delete source.assistantEntry;
    source.revision = transcriptRevision(Number(source.revision) + 1);
    source.availability = "unavailable";
    delete source.snapshot;
    source.snapshot = this.transcriptSnapshot(source);
  }

  private replaceObservation(agent: RetainedAgent, overrides: Partial<Pick<AgentObservation, "taskLabel" | "activity" | "context">>): boolean {
    const taskLabel = overrides.taskLabel ?? deriveTaskLabel(agent.candidate, this.labelContext());
    const activity = overrides.activity ?? agent.observation.activity;
    const context = overrides.context ?? agent.observation.context;
    const displayState = deriveDisplayState(agent.lifecycleState, agent.completionState);
    if (agent.observation.taskLabel === taskLabel && agent.observation.lifecycleState === agent.lifecycleState &&
        agent.observation.displayState === displayState && agent.observation.completionPendingDelivery === agent.pendingDelivery &&
        sameActivity(agent.observation.activity, activity) && sameContext(agent.observation.context, context)) return false;
    agent.observation = Object.freeze({
      ...agent.observation, taskLabel, lifecycleState: agent.lifecycleState, displayState, activity, context,
      completionPendingDelivery: agent.pendingDelivery, revision: this.nextRevision(),
    });
    return true;
  }

  private rederiveAll(): AgentOrdinal[] {
    const context = this.labelContext();
    const changed: AgentOrdinal[] = [];
    for (const agent of this.agents.values()) {
      const taskLabel = deriveTaskLabel(agent.candidate, context);
      if (taskLabel === agent.observation.taskLabel) continue;
      agent.observation = Object.freeze({ ...agent.observation, taskLabel, revision: this.nextRevision() });
      changed.push(agent.ordinal);
    }
    return changed;
  }

  private addSensitiveValues(values: ObservationSensitiveValues, publishTranscriptMetadata = true): boolean {
    let changed = false;
    for (const id of values.agentIds) if (!this.knownAgentIds.has(id)) { this.knownAgentIds.add(id); changed = true; }
    for (const id of values.runIds) if (!this.knownRunIds.has(id)) { this.knownRunIds.add(id); changed = true; }
    for (const path of values.internalPaths) if (!this.knownInternalPaths.has(path)) { this.knownInternalPaths.add(path); changed = true; }
    if (changed && publishTranscriptMetadata) this.commitTranscripts(new Set(this.transcripts.values()));
    return changed;
  }

  private registerSensitiveValuesWithoutCommit(values: ObservationSensitiveValues): boolean {
    return this.addSensitiveValues(values, false);
  }
  private labelContext() { return { knownAgentIds: this.knownAgentIds, knownRunIds: this.knownRunIds, knownInternalPaths: this.knownInternalPaths }; }
  private nextRevision(): AgentObservationRevision { return agentObservationRevision(Number(this.revision) + 1); }

  private commit(ordinals: readonly AgentOrdinal[], forceRescan: boolean): void {
    this.revision = agentObservationRevision(Number(this.revision) + 1);
    this.snapshotCache = undefined;
    if (!this.pendingRescan) {
      for (const ordinal of ordinals) this.pendingOrdinals.add(ordinal);
      if (forceRescan || this.pendingOrdinals.size > MAX_DIRECT_AGENT_OBSERVATIONS) {
        this.pendingOrdinals.clear();
        this.pendingRescan = true;
      }
    }
    this.scheduleNotification();
  }

  private scheduleNotification(): void {
    if (this.notificationScheduled || this.disposed) return;
    this.notificationScheduled = true;
    const generation = this.generation;
    queueMicrotask(() => {
      this.notificationScheduled = false;
      if (this.disposed || generation !== this.generation) return;
      const rescanRequired = this.pendingRescan;
      const changed = Object.freeze(rescanRequired ? [] : [...this.pendingOrdinals].sort(compareOrdinals));
      this.pendingOrdinals.clear();
      this.pendingRescan = false;
      const change: ObservationChange = Object.freeze({ revision: this.revision, health: this.health, changed, rescanRequired });
      for (const listener of [...this.listeners]) {
        if (!this.listeners.has(listener)) continue;
        try {
          const returned = listener(change);
          if (isThenable(returned)) {
            this.listeners.delete(listener);
            void Promise.resolve(returned).catch(() => undefined);
            this.reportListener("thenable listener removed");
          }
        } catch {
          this.listeners.delete(listener);
          this.reportListener("throwing listener removed");
        }
      }
    });
  }

  private reportListener(message: string): void { try { this.diagnostic(message); } catch { /* diagnostics are optional */ } }
}

/** Catches every projection mutation and schedules authoritative reconciliation on failure. */
export function createTotalAgentObservationAdapter(store: AgentObservationStore): AgentObservationMutationPort {
  const invoke = <T extends readonly unknown[]>(operation: (...args: T) => void) => (...args: T): void => {
    try { operation(...args); } catch { store.testAdapter().reportProjectionFailure(); }
  };
  return {
    registerSpawned: invoke(store.registerSpawned.bind(store)),
    acceptRun: invoke(store.acceptRun.bind(store)),
    updateLifecycle: invoke(store.updateLifecycle.bind(store)),
    publishCompletion: invoke(store.publishCompletion.bind(store)),
    registerSensitiveValues: invoke(store.registerSensitiveValues.bind(store)),
    acknowledgeDelivered: invoke(store.acknowledgeDelivered.bind(store)),
    reconcile: invoke(store.reconcile.bind(store)),
    dispose: invoke(store.dispose.bind(store)),
  };
}

export function createTotalRpcObservationAdapter(
  store: AgentObservationStore,
  context: ContextObservationService,
  identity: { readonly agentId: AgentId; readonly attemptId: RunAttemptId },
  report: (code: ObservationHealthCode) => void,
): RpcObservationSink {
  const reportFailure = (): void => { try { report("projection-failed"); } catch { /* diagnostics are optional */ } };
  const failObservation = (): void => {
    try { store.failObservationProjection(identity.agentId); } catch { /* total boundary */ }
    reportFailure();
  };
  const failTranscript = (): void => {
    try { store.failObservationProjection(identity.agentId); } catch { /* total boundary */ }
    try { store.failAttemptProjection(identity.agentId, identity.attemptId); } catch { /* total boundary */ }
    reportFailure();
  };
  let discarded = false;
  const scoped = store.createRoutedAttemptSink(
    identity.agentId,
    identity.attemptId,
    (event) => { try { context.observe(event); } catch { failObservation(); } },
    (runId) => { try { context.reset(runId); } catch { failObservation(); } },
  );
  return {
    record(event): void { if (discarded) return; try { scoped.record(event); } catch { failTranscript(); } },
    bind(runId): void { if (discarded) return; try { scoped.bind(runId); } catch { failTranscript(); } },
    discard(): void {
      if (discarded) return;
      discarded = true;
      try { scoped.discard(); } catch { failTranscript(); }
      try { context.dispose(); } catch { failObservation(); }
    },
  };
}

function cloneObservationEvent(event: RpcObservationEvent): RpcObservationEvent {
  switch (event.kind) {
    case "assistant-end": return Object.freeze({ ...event,
      finalBlocks: Object.freeze(event.finalBlocks.map((block) => Object.freeze({ ...block }))),
      usage: Object.freeze({ ...event.usage, cost: Object.freeze({ ...event.usage.cost }) }),
    });
    case "assistant-content": return Object.freeze({ ...event });
    case "tool": return Object.freeze({ ...event });
    case "prompt-accepted": return Object.freeze({ ...event });
    case "compaction": return Object.freeze({ ...event });
    case "assistant-start":
    case "turn-end":
    case "agent-settled":
    case "transport-unavailable": return Object.freeze({ ...event });
  }
}

function freezeObservation(
  agent: RetainedAgent,
  revision: AgentObservationRevision,
  modelLabel: AgentObservation["modelLabel"],
  activity: AgentActivity,
  context: Parameters<typeof deriveTaskLabel>[1],
): AgentObservation {
  return Object.freeze({
    agentId: agent.agentId,
    ordinal: agent.ordinal,
    taskLabel: deriveTaskLabel(agent.candidate, context),
    modelLabel,
    context: UNAVAILABLE_CONTEXT,
    lifecycleState: agent.lifecycleState,
    displayState: deriveDisplayState(agent.lifecycleState, agent.completionState),
    activity,
    completionPendingDelivery: agent.pendingDelivery,
    revision,
  });
}
function safeModel(model: ModelSpec, thinking: ThinkingLevel): AgentObservation["modelLabel"] { try { return deriveModelLabel(model, thinking); } catch { return unknownModelLabel(); } }
function withProjectionFailure(health: ObservationHealth): ObservationHealth {
  const codes = health.kind === "degraded" ? health.codes : [];
  if (codes.includes("projection-failed")) return health;
  return Object.freeze({ kind: "degraded" as const, codes: Object.freeze([...codes, "projection-failed" as const]) });
}
function boundedCandidate(value: string): string {
  const bytes = new TextEncoder().encode(value);
  if (bytes.byteLength <= 512) return value.replace(/[\u0000-\u001f\u007f-\u009f]/gu, " ");
  return new TextDecoder().decode(bytes.subarray(0, 512)).replace(/[\u0000-\u001f\u007f-\u009f]/gu, " ");
}
function directPosition(ordinal: AgentOrdinal): number { return Number(String(ordinal).slice(1)); }
function compareOrdinals(left: AgentOrdinal, right: AgentOrdinal): number { return directPosition(left) - directPosition(right); }
function isThenable(value: void): value is never { return typeof value === "object" && value !== null && "then" in value; }
function sameTask(observation: AgentObservation, candidate: string, context: ReturnType<AgentObservationStore["labelContext"]>): boolean { return observation.taskLabel === deriveTaskLabel(candidate, context); }
function sameContext(left: ContextObservation, right: ContextObservation): boolean {
  return left.kind === right.kind && (left.kind === "unavailable" || (right.kind === "known" && left.percent === right.percent));
}
function sameActivity(left: AgentActivity, right: AgentActivity): boolean {
  if (left.kind !== right.kind) return false;
  if (left.kind === "idle") return true;
  if (left.kind === "unavailable") return right.kind === "unavailable" && left.reason === right.reason;
  if (left.kind === "responding" || left.kind === "thinking") return right.kind === left.kind && left.preview === right.preview;
  return right.kind === "tool" && left.tool === right.tool && left.phase === right.phase && left.preview === right.preview;
}

const transcriptEncoder = new TextEncoder();
function boundedActivityPreview(value: string): ReturnType<typeof activityText> {
  let output = ""; let points = 0; let bytes = 0;
  for (const point of value) {
    const pointBytes = transcriptEncoder.encode(point).byteLength;
    if (points === 160 || bytes + pointBytes > 512) break;
    output += point; points++; bytes += pointBytes;
  }
  return activityText(output);
}
function boundedTranscriptPrefix(value: string): typeof value & import("./domain.ts").TranscriptText {
  const bytes = transcriptEncoder.encode(value);
  if (bytes.byteLength <= MAX_TRANSCRIPT_FIELD_BYTES) return value as typeof value & import("./domain.ts").TranscriptText;
  let output = ""; let used = 0;
  for (const point of value) {
    const encoded = transcriptEncoder.encode(point);
    if (used + encoded.byteLength > MAX_TRANSCRIPT_FIELD_BYTES) break;
    output += point; used += encoded.byteLength;
  }
  return output as typeof value & import("./domain.ts").TranscriptText;
}
function transcriptItemBytes(item: TranscriptItem): number {
  if (item.kind === "user") return transcriptEncoder.encode(item.text).byteLength;
  if (item.kind !== "assistant") return 0;
  return item.blocks.reduce((total, block) => {
    if (block.kind === "text" || block.kind === "thinking") {
      return total + transcriptEncoder.encode(block.text).byteLength;
    }
    const previewBytes = block.presentation.preview === undefined
      ? 0
      : transcriptEncoder.encode(block.presentation.preview).byteLength;
    const argumentBytes = transcriptJsonBytes(block.presentation.arguments);
    const resultBytes = block.presentation.result?.content.reduce(
      (bytes, text) => bytes + transcriptEncoder.encode(text).byteLength,
      0,
    ) ?? 0;
    const detailBytes = transcriptJsonBytes(block.presentation.result?.details);
    return total + previewBytes + argumentBytes + resultBytes + detailBytes;
  }, 0);
}
function transcriptJsonBytes(value: import("./domain.ts").BoundedTranscriptJson | undefined): number {
  return value === undefined ? 0 : transcriptEncoder.encode(JSON.stringify(value)).byteLength;
}

function assistantKey(runId: RunId, generation: number, index: import("./domain.ts").RpcContentIndex, kind: "text" | "thinking"): string {
  return `${runId}\u0000${generation}\u0000${index}\u0000${kind}`;
}
function assistantTranscriptItem(item: TranscriptItem): Extract<TranscriptItem, { readonly kind: "assistant" }> {
  if (item.kind !== "assistant") throw new Error("invalid_state: assistant correlation mismatch");
  return item;
}

function conversationStopReason(value: import("./domain.ts").RpcStopReason): ConversationStopReason {
  const reason = String(value);
  return reason === "stop" || reason === "length" || reason === "aborted" || reason === "toolUse"
    ? reason
    : "error";
}
function oldestEntry(entries: readonly TranscriptEntry[], open: boolean): TranscriptEntry | undefined {
  return entries.filter((entry) => entry.open === open).sort((left, right) => left.order - right.order)[0];
}
function sourceOverBudget(source: RetainedTranscript, budgets: TranscriptBudgets): boolean {
  return source.entries.length > budgets.perSourceItems || source.entries.reduce((total, entry) => total + entry.bytes, 0) > budgets.perSourceBytes;
}
function storeOverBudget(sources: Iterable<RetainedTranscript>, budgets: TranscriptBudgets): boolean {
  let items = 0; let bytes = 0;
  for (const source of sources) { items += source.entries.length; bytes += source.entries.reduce((total, entry) => total + entry.bytes, 0); }
  return items > budgets.globalItems || bytes > budgets.globalBytes;
}
function sameTranscriptItem(left: TranscriptItem, right: TranscriptItem): boolean {
  if (left.kind !== right.kind || left.sequence !== right.sequence) return false;
  if (left.kind === "notice" && right.kind === "notice") return left.code === right.code;
  if (left.kind === "user" && right.kind === "user") return left.runId === right.runId && left.text === right.text;
  return left.kind === "assistant" && right.kind === "assistant"
    && left.runId === right.runId
    && left.group === right.group
    && left.phase === right.phase
    && left.stopReason === right.stopReason
    && JSON.stringify(left.blocks) === JSON.stringify(right.blocks);
}
