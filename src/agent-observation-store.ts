import {
  AgentState,
  agentCount,
  agentObservationRevision,
  agentRunKey,
  directAgentOrdinal,
  type AbsolutePath,
  type AgentCompletion,
  type AgentId,
  type AgentObservationRevision,
  type AgentOrdinal,
  type AgentRunKey,
  type CompletionState,
  type ModelSpec,
  type RunId,
  type RunAttemptId,
  type ThinkingLevel,
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
} from "./constants.ts";

export interface AgentObservationMutationPort {
  registerSpawned(input: SpawnObservationInput): void;
  acceptRun(input: AcceptedRunObservationInput): void;
  updateLifecycle(record: Readonly<RunRecord>): void;
  publishCompletion(completion: AgentCompletion): void;
  registerSensitiveValues(values: ObservationSensitiveValues): void;
  acknowledgeDelivered(keys: readonly AgentRunKey[]): void;
  reconcile(snapshot: ObservationReconciliationSnapshot): void;
  dispose(): void;
}

export interface AgentObservationStoreOptions {
  readonly reconciliation?: () => ObservationReconciliationSnapshot;
  readonly diagnostic?: (message: string) => void;
}

interface RetainedAgent {
  readonly agentId: AgentId;
  readonly ordinal: AgentOrdinal;
  readonly position: number;
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

interface PendingObservationAttempt {
  readonly agentId: AgentId;
  readonly attemptId: RunAttemptId;
  readonly creation: number;
  readonly events: RpcObservationEvent[];
  readonly onEvent: (event: RpcObservationEvent) => void;
  readonly onBind: (runId: RunId) => void;
  bytes: number;
  rejected: boolean;
  boundRunId?: RunId;
}

/** Process-local, UI-neutral projection of one controller's directly owned children. */
export class AgentObservationStore implements SubagentObservationPort, AgentObservationMutationPort, ObservationAttemptSinkFactory {
  private readonly agents = new Map<AgentId, RetainedAgent>();
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

  constructor(options: AgentObservationStoreOptions = {}) {
    this.reconciliationSupplier = options.reconciliation;
    this.diagnostic = options.diagnostic ?? (() => {});
  }

  observation(agentId: AgentId): AgentObservation | undefined {
    return this.disposed ? undefined : this.agents.get(agentId)?.observation;
  }

  directSnapshot(): DirectAgentSnapshotResult {
    if (this.disposed) return this.snapshotCache!;
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
    const entries = Object.freeze(selected.map((agent): DirectAgentProjection => Object.freeze({
      agentId: agent.agentId,
      observation: agent.observation,
      row: directAgentRow(agent.observation),
    })));
    this.snapshotCache = Object.freeze({
      kind: "snapshot",
      revision: this.revision,
      health: this.health,
      total: agentCount(all.length),
      omitted: agentCount(all.length - entries.length),
      omittedActive: agentCount(Math.max(0, active.length - MAX_DIRECT_AGENT_OBSERVATIONS)),
      entries,
    });
    return this.snapshotCache;
  }

  transcriptSource(_agentId: AgentId): TranscriptSource | undefined { return undefined; }

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
      model: input.model,
      thinkingLevel: input.thinkingLevel,
      candidate: boundedCandidate(input.assignment),
      lifecycleState: AgentState.Stopped,
      pendingDelivery: false,
      observation: undefined as never,
    };
    retained.observation = freezeObservation(retained, this.nextRevision(), model, IDLE, this.labelContext());
    this.agents.set(input.agentId, retained);
    changed.push(input.ordinal);
    this.commit(changed, false);
    this.retryFailedReconciliation();
  }

  acceptRun(input: AcceptedRunObservationInput): void {
    if (this.disposed) return;
    const agent = this.agents.get(input.agentId);
    if (agent === undefined) return;
    const candidate = boundedCandidate(input.assignment);
    const sensitiveChanged = this.addSensitiveValues({ agentIds: new Set(), runIds: new Set([input.runId]), internalPaths: new Set() });
    const equivalent = agent.latestRunId === input.runId && agent.candidate === candidate;
    agent.latestRunId = input.runId;
    agent.acceptedAttemptId = input.attemptId;
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
      bytes: 0, rejected: this.disposed || this.attempts.has(attemptId),
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
    this.replaceObservation(agent, { context: frozen });
    this.commit([agent.ordinal], false);
  }

  failObservationProjection(agentId: AgentId): void {
    if (this.disposed) return;
    const agent = this.agents.get(agentId);
    if (agent === undefined) return;
    this.replaceObservation(agent, { activity: PROJECTION_UNAVAILABLE, context: UNAVAILABLE_CONTEXT });
    this.commit([agent.ordinal], false);
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

  reconcile(snapshot: ObservationReconciliationSnapshot): void {
    if (this.disposed) return;
    this.registerSensitiveValuesWithoutCommit(snapshot.sensitiveValues);
    const authorities = new Map(snapshot.agents.map((agent) => [agent.agentId, agent]));
    const runs = new Map(snapshot.runs.map((run) => [run.agentId, run]));
    const completions = new Map(snapshot.completions.map((completion) => [completion.agentId, completion]));
    const changed: AgentOrdinal[] = [];
    const authoritativeIds = new Set(snapshot.spawnSequence);
    for (const [id, agent] of this.agents) {
      if (authoritativeIds.has(id)) continue;
      this.agents.delete(id);
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
      this.replaceObservation(agent, { activity: RESTORATION_UNAVAILABLE, context: UNAVAILABLE_CONTEXT });
      if (agent.observation !== before) changed.push(agent.ordinal);
    }
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
    this.agents.clear();
    this.attempts.clear();
    this.pendingAttemptEvents = 0;
    this.pendingAttemptBytes = 0;
    this.snapshotCache = Object.freeze({ kind: "unavailable", finalRevision: this.revision });
  }

  /** Explicit total-adapter test seam; not part of the widget-facing port. */
  testAdapter(): { reportProjectionFailure(): void } {
    return { reportProjectionFailure: () => this.reportProjectionFailure() };
  }

  private recordAttempt(attempt: PendingObservationAttempt, event: RpcObservationEvent): void {
    if (this.disposed || attempt.rejected) return;
    if (attempt.boundRunId !== undefined) {
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
    if (this.disposed || attempt.rejected || attempt.boundRunId !== undefined) return;
    const agent = this.agents.get(attempt.agentId);
    if (agent === undefined || agent.latestRunId !== runId || agent.acceptedAttemptId !== attempt.attemptId) {
      this.rejectAttempt(attempt);
      return;
    }
    attempt.boundRunId = runId;
    const events = attempt.events.splice(0);
    this.pendingAttemptEvents -= events.length;
    this.pendingAttemptBytes -= attempt.bytes;
    attempt.bytes = 0;
    attempt.onBind(runId);
    for (const event of events) {
      this.projectActivity(attempt.agentId, runId, event);
      attempt.onEvent(event);
    }
  }

  private projectActivity(agentId: AgentId, runId: RunId, event: RpcObservationEvent): void {
    const agent = this.agents.get(agentId);
    if (agent === undefined || agent.latestRunId !== runId) return;
    let activity: AgentActivity | undefined;
    if (event.kind === "assistant-content" && event.phase === "delta") {
      const preview = event.text === undefined ? undefined : activityText(event.text);
      activity = Object.freeze({ kind: event.contentKind === "thinking" ? "thinking" : "responding", ...(preview === undefined ? {} : { preview }) });
    } else if (event.kind === "tool") {
      activity = Object.freeze({ kind: "tool", tool: event.tool, phase: event.phase, ...(event.preview === undefined ? {} : { preview: activityText(event.preview) }) });
    } else if (event.kind === "agent-settled") activity = IDLE;
    else if (event.kind === "transport-unavailable") activity = TRANSPORT_UNAVAILABLE;
    if (activity === undefined || agent.observation.activity === activity) return;
    this.replaceObservation(agent, { activity });
    this.commit([agent.ordinal], false);
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
      try { this.reconcile(this.reconciliationSupplier!()); }
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
    this.addSensitiveValues({ agentIds: new Set([input.agentId]), runIds: new Set(), internalPaths: new Set([input.sessionPath, input.cwd]) });
    const retained: RetainedAgent = {
      agentId: input.agentId, ordinal: input.ordinal, position: directPosition(input.ordinal), model: input.model,
      thinkingLevel: input.thinkingLevel, candidate: boundedCandidate(input.assignment), lifecycleState: AgentState.Stopped,
      pendingDelivery: false, observation: undefined as never,
    };
    retained.observation = freezeObservation(retained, this.nextRevision(), safeModel(input.model, input.thinkingLevel), RESTORATION_UNAVAILABLE, this.labelContext());
    this.agents.set(input.agentId, retained);
  }

  private replaceObservation(agent: RetainedAgent, overrides: Partial<Pick<AgentObservation, "taskLabel" | "activity" | "context">>): void {
    const taskLabel = overrides.taskLabel ?? deriveTaskLabel(agent.candidate, this.labelContext());
    const activity = overrides.activity ?? agent.observation.activity;
    const context = overrides.context ?? agent.observation.context;
    const displayState = deriveDisplayState(agent.lifecycleState, agent.completionState);
    if (agent.observation.taskLabel === taskLabel && agent.observation.lifecycleState === agent.lifecycleState &&
        agent.observation.displayState === displayState && agent.observation.completionPendingDelivery === agent.pendingDelivery &&
        agent.observation.activity === activity && agent.observation.context === context) return;
    agent.observation = Object.freeze({
      ...agent.observation, taskLabel, lifecycleState: agent.lifecycleState, displayState, activity, context,
      completionPendingDelivery: agent.pendingDelivery, revision: this.nextRevision(),
    });
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

  private addSensitiveValues(values: ObservationSensitiveValues): boolean {
    let changed = false;
    for (const id of values.agentIds) if (!this.knownAgentIds.has(id)) { this.knownAgentIds.add(id); changed = true; }
    for (const id of values.runIds) if (!this.knownRunIds.has(id)) { this.knownRunIds.add(id); changed = true; }
    for (const path of values.internalPaths) if (!this.knownInternalPaths.has(path)) { this.knownInternalPaths.add(path); changed = true; }
    return changed;
  }

  private registerSensitiveValuesWithoutCommit(values: ObservationSensitiveValues): void { this.addSensitiveValues(values); }
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
  const fail = (): void => {
    try { store.failObservationProjection(identity.agentId); } catch { /* total boundary */ }
    try { report("projection-failed"); } catch { /* diagnostics are optional */ }
  };
  let discarded = false;
  const scoped = store.createRoutedAttemptSink(
    identity.agentId,
    identity.attemptId,
    (event) => { try { context.observe(event); } catch { fail(); } },
    (runId) => { try { context.reset(runId); } catch { fail(); } },
  );
  return {
    record(event): void { if (discarded) return; try { scoped.record(event); } catch { fail(); } },
    bind(runId): void { if (discarded) return; try { scoped.bind(runId); } catch { fail(); } },
    discard(): void {
      if (discarded) return;
      discarded = true;
      try { scoped.discard(); } catch { fail(); }
      try { context.dispose(); } catch { fail(); }
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
function boundedCandidate(value: string): string {
  const bytes = new TextEncoder().encode(value);
  if (bytes.byteLength <= 512) return value.replace(/[\u0000-\u001f\u007f-\u009f]/gu, " ");
  return new TextDecoder().decode(bytes.subarray(0, 512)).replace(/[\u0000-\u001f\u007f-\u009f]/gu, " ");
}
function directPosition(ordinal: AgentOrdinal): number { return Number(String(ordinal).slice(1)); }
function compareOrdinals(left: AgentOrdinal, right: AgentOrdinal): number { return directPosition(left) - directPosition(right); }
function isThenable(value: void): value is never { return typeof value === "object" && value !== null && "then" in value; }
function sameTask(observation: AgentObservation, candidate: string, context: ReturnType<AgentObservationStore["labelContext"]>): boolean { return observation.taskLabel === deriveTaskLabel(candidate, context); }
