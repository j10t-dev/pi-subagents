import { AsyncLocalStorage } from "node:async_hooks";
import { dirname } from "node:path";
import { CompletionService, type AwaitOptions, type CompletionAwaitResult } from "./completion-service.ts";
import type { AgentObservationMutationPort } from "./agent-observation-store.ts";
import type {
  ObservationAgentAuthority,
  ObservationReconciliationSnapshot,
  ObservationSensitiveValues,
  SubagentObservationPort,
} from "./agent-observation.ts";
import {
  AgentErrorCode,
  agentRunKey,
  AgentState,
  CancellationReason,
  CodedError,
  agentId,
  toAgentError,
  type AgentCompletion,
  type AgentError,
  type AgentId,
  type Milliseconds,
  type RunCapacity,
  type RunId,
  type SessionEntryId,
  type SessionPath,
  type ContainmentReceiptPath,
  type RunAttemptId,
  type AbsolutePath,
  type ModelSpec,
  type ThinkingLevel,
  directAgentOrdinal,
  agentObservationRevision,
  modelSpecFrom,
  verifiedContainmentReceiptPath,
  isPublicPreflightError,
  truncateUtf8,
} from "./domain.ts";
import type { EffectiveChildSelection } from "./child-selection.ts";
import { RunController, classifyTerminal, type RunRecord, type RunRuntime, type Settlement, type StopResult } from "./run-controller.ts";
import type { RpcRunClient } from "./rpc-client.ts";
import { absolutePath } from "./paths.ts";
import { classifyAssignmentEntries } from "./assignment-identity.ts";
import { delayWithAbort, waitWithAbort } from "./async-primitives.ts";
import {
  ASSIGNMENT_IDENTITY_POLL_MS,
  ASSIGNMENT_IDENTITY_TIMEOUT_MS,
  DEFAULT_MAX_CONCURRENT_RUNS,
  MAX_ERROR_MESSAGE_BYTES,
} from "./constants.ts";
import type { ContainmentDescriptor } from "./containment.ts";
import {
  RestorationApplicationError,
  applyRestoration,
  collectRestorationEvidence,
  planRestoration,
  type RestorationContainmentDecision,
  type AppliedAgentRecord,
  type RestorationPort,
  type RestoredTerminalObligation,
  type StagedRestorePlan,
} from "./restoration.ts";
export type { RestorationContainmentDecision, RestorationPort } from "./restoration.ts";

export interface SpawnAgentRequest { task: string; model?: string; cwd?: string; tools?: string[] }

export interface LaunchSession {
  agentId: AgentId;
  transcriptPath: SessionPath;
  /** Authoritative composition metadata used only by the observation projection. */
  cwd?: AbsolutePath;
  model?: ModelSpec;
  thinkingLevel?: ThinkingLevel;
  previousLeafId: SessionEntryId | null;
  attemptId: RunAttemptId;
  containmentReceiptPath: ContainmentReceiptPath;
  containment?: ContainmentDescriptor;
}

export interface LaunchTransport extends Pick<RpcRunClient, "start" | "getEntries" | "prompt" | "bindRun" | "waitForAgentStart" | "waitSettled"> {
  ready(): Promise<ContainmentDescriptor>;
  persistLaunchRequested(): Promise<void>;
  persistRunStarted(runId: RunId): Promise<void>;
  runtime: RunRuntime;
  recordFailure?(error: unknown): void;
}

/**
 * Hands cgroup containment responsibility to the controller. A `createLaunch`
 * implementation MUST call this with a usable containment handle before it spawns anything, and
 * MUST NOT spawn if it cannot: the controller contains through the surrendered handle when
 * `createLaunch` throws, and treats a throw with no surrendered handle as proof that no process
 * group exists. Surrendering is idempotent from the caller's side — the last handle wins.
 */
export type SurrenderContainment = (runtime: RunRuntime) => void;

export interface SpawnPreparation {
  readonly selection: EffectiveChildSelection;
  createSession(): Promise<LaunchSession>;
  persistSpawned(session: LaunchSession): Promise<void>;
  /** Must surrender containment before process-group spawn; see {@link SurrenderContainment}. */
  createLaunch(session: LaunchSession, surrender: SurrenderContainment): Promise<LaunchTransport>;
}

export interface SendPreparation {
  session: LaunchSession;
  /** Must surrender containment before process-group spawn; see {@link SurrenderContainment}. */
  createLaunch(surrender: SurrenderContainment): Promise<LaunchTransport>;
}

/** Lifecycle boundary available only while a composition preparation is executing. */
export interface PreparationScope {
  /** Schedules detached work for a future turn outside preparation re-entrancy context. */
  scheduleExternal(callback: () => void): void;
}

export type StartResult =
  | { agentId: AgentId; runId: RunId; state: typeof AgentState.Running }
  | { agentId: AgentId; runId: RunId; state: typeof AgentState.Settling; error: AgentError }
  | { agentId: AgentId; state: typeof AgentState.Stopped | typeof AgentState.Stopping; error: AgentError };

export type SpawnStartResult =
  | (Extract<StartResult, { state: typeof AgentState.Running }> & EffectiveChildSelection)
  | Exclude<StartResult, { state: typeof AgentState.Running }>;

export type PublicStopOutcome =
  | { agentId: AgentId; runId: RunId; state: "cancelled" }
  | { agentId: AgentId; state: "already_stopped" }
  | {
      agentId: AgentId;
      runId?: RunId;
      state: "failed";
      agentState: typeof AgentState.Settling | typeof AgentState.Stopping;
      error: AgentError;
    };

/** Production assembly supplies facilities; transaction ordering remains controller-owned. */
export interface PiControllerComposition {
  /** Pure/validation-only preflight. */
  prepareSpawn(input: SpawnAgentRequest, scope: PreparationScope): Promise<SpawnPreparation>;
  prepareSend(agentId: AgentId, literalMessage: string, scope: PreparationScope): Promise<SendPreparation>;
  /** Persists RunStopping before abort. */
  persistStopping?(record: Readonly<RunRecord>, reason: CancellationReason): Promise<void>;
  /** Performs output recovery, persists RunCompleted, then returns the durable DTO. */
  finaliseRun?(record: Readonly<RunRecord>, settlement: Settlement): Promise<AgentCompletion>;
  restore?(): Promise<void>;
  shutdownStart?(): void;
  /** Cleans up composition-owned resources after every run has released ownership. */
  shutdownComplete?(): Promise<void>;
}

export interface ParentLifecyclePort {
  isBusy(): boolean;
  sendMessage(text: string, options: { deliverAs: "followUp" | "nextTurn"; triggerTurn: boolean }): Promise<void> | void;
  warn?(message: string): void;
}

export interface SubagentControllerOptions {
  capacity?: RunCapacity;
  observation?: AgentObservationMutationPort;
  observationPort?: SubagentObservationPort;
  completions?: CompletionService;
  composition?: PiControllerComposition;
  parent?: ParentLifecyclePort;
  restoration?: RestorationPort;
  trace?: (event: string) => void;
  onStatusChange?: () => void;
  identityDeadline?: () => AbortSignal;
  identityDelay?: (milliseconds: Milliseconds, signal: AbortSignal) => Promise<void>;
  onCompletionDelivered?: (key: ReturnType<typeof agentRunKey>) => void;
}

interface ControllerOperation {
  readonly done: Promise<void>;
  activePreparation: boolean;
  preparationShutdownAttempted: boolean;
  release(): void;
}

export class SubagentController {
  readonly runs: RunController;
  readonly completions: CompletionService;
  private readonly composition: PiControllerComposition | undefined;
  private readonly parent: ParentLifecyclePort | undefined;
  private readonly restoration: RestorationPort | undefined;
  private readonly trace: ((event: string) => void) | undefined;
  private shuttingDown: Promise<void> | undefined;
  private lifecycle: "open" | "restoring" | "closing" = "open";
  private readonly operations = new Set<ControllerOperation>();
  private readonly preparationContext = new AsyncLocalStorage<ControllerOperation>();
  private suppressPings = false;
  private restored = false;
  private restoreInFlight: Promise<void> | undefined;
  private restorationApplied = false;
  private stagedRestorePlan: StagedRestorePlan | undefined;
  private readonly restoredStartedAppends = new Set<ReturnType<typeof agentRunKey>>();
  private readonly restoredRecords = new Map<AgentId, RestoredTerminalObligation>();
  private readonly durableCompletions = new Map<ReturnType<typeof agentRunKey>, AgentCompletion>();
  private readonly pendingNotifications = new Set<ReturnType<typeof agentRunKey>>();
  private readonly identityDeadline: () => AbortSignal;
  private readonly identityDelay: (milliseconds: Milliseconds, signal: AbortSignal) => Promise<void>;
  private readonly onCompletionDelivered: (key: ReturnType<typeof agentRunKey>) => void;
  private readonly observation: AgentObservationMutationPort;
  private readonly observationReadPort: SubagentObservationPort;
  private readonly observationAgents = new Map<AgentId, ObservationAgentAuthority>();
  private readonly acceptedAssignments = new Map<ReturnType<typeof agentRunKey>, string>();
  private readonly observationSpawnSequence: AgentId[] = [];
  private readonly acceptedRunIds = new Set<RunId>();
  private observationReconciliationScheduled = false;

  constructor(options: SubagentControllerOptions = {}) {
    this.completions = options.completions ?? new CompletionService();
    this.composition = options.composition;
    this.parent = options.parent;
    this.restoration = options.restoration;
    this.trace = options.trace;
    this.identityDeadline = options.identityDeadline ?? (() => AbortSignal.timeout(Number(ASSIGNMENT_IDENTITY_TIMEOUT_MS)));
    this.identityDelay = options.identityDelay ?? delayWithAbort;
    this.onCompletionDelivered = options.onCompletionDelivered ?? (() => {});
    this.observationReadPort = options.observationPort ?? unavailableObservationPort();
    this.observation = totalObservationAdapter(options.observation ?? inertObservation(), () => this.observationReconciliationSnapshot(), () => {
      if (this.observationReconciliationScheduled) return false;
      this.observationReconciliationScheduled = true;
      return true;
    }, () => { this.observationReconciliationScheduled = false; });
    this.runs = new RunController({
      capacity: options.capacity ?? DEFAULT_MAX_CONCURRENT_RUNS,
      onReserve: () => this.trace?.("reserve"),
      observation: { afterMutation: (record) => this.observation.updateLifecycle(record) },
      onStopping: (record, reason) => this.composition?.persistStopping?.(record, reason),
      onTerminal: async (record, settlement) => {
        if (this.restoredRecords.has(record.agentId)) {
          return await this.finaliseRestored(record);
        }
        const existing = record.runId === undefined ? undefined : this.durableCompletions.get(agentRunKey(record.agentId, record.runId));
        const completion = existing ?? await this.composition?.finaliseRun?.(record, settlement);
        if (completion !== undefined) this.durableCompletions.set(agentRunKey(completion.agentId, completion.runId), completion);
        if (completion !== undefined) await this.publish(completion);
      },
      onRelease: () => {
        this.syncInventory();
        try { options.onStatusChange?.(); } catch { /* status rendering cannot retain terminal ownership */ }
      },
    });
  }

  spawn(input: SpawnAgentRequest): Promise<SpawnStartResult> {
    let token: ControllerOperation;
    try { token = this.admitOperation(); }
    catch (error) { return Promise.reject(publicError(error, AgentErrorCode.SpawnFailed)); }
    return this.spawnOwned(input, token).finally(() => token.release());
  }

  private async spawnOwned(input: SpawnAgentRequest, token: ControllerOperation): Promise<SpawnStartResult> {
    if (input.task.length === 0) throw new CodedError(AgentErrorCode.InvalidInput);
    if (this.composition === undefined) throw new CodedError(AgentErrorCode.SpawnFailed);
    let prepared: SpawnPreparation;
    try {
      prepared = await this.prepare(token, (scope) => this.composition!.prepareSpawn(input, scope));
    } catch (error) {
      if (isPublicPreflightError(error)) throw error;
      if (error instanceof CodedError) throw new CodedError(AgentErrorCode.SpawnFailed, error.diagnosticsPath);
      throw new CodedError(AgentErrorCode.SpawnFailed);
    }
    try {
      this.requireOperationOpen(token);
      const result = await this.runs.spawnNew(async (register, adoptIdentity) => {
        const session = await prepared.createSession();
        register(session);
        await prepared.persistSpawned(session);
        this.observeSpawned(session, prepared, input.task);
        const created = await this.createLaunchContained((surrender) => prepared.createLaunch(session, surrender));
        if (created.status === "failed") return { status: "failed", agentId: session.agentId, transcriptPath: session.transcriptPath };
        if (created.status === "containment_failed") {
          return { status: "containment_failed", agentId: session.agentId, transcriptPath: session.transcriptPath, runtime: created.runtime };
        }
        return this.executeLaunch(session, input.task, created.transport, adoptIdentity);
      });
      this.syncInventory();
      if (result.status === "settling") return { agentId: result.agentId, runId: result.runId, state: AgentState.Settling, error: toAgentError(AgentErrorCode.SpawnFailed) };
      if (result.status === "failed") return { agentId: result.agentId, state: AgentState.Stopped, error: toAgentError(AgentErrorCode.SpawnFailed) };
      if (result.status === "containment_failed") return { agentId: result.agentId, state: AgentState.Stopping, error: toAgentError(AgentErrorCode.ContainmentFailed) };
      return {
        agentId: result.agentId,
        runId: result.runId,
        state: AgentState.Running,
        model: prepared.selection.model,
        thinkingLevel: prepared.selection.thinkingLevel,
        tools: [...prepared.selection.tools],
        ...(prepared.selection.warning === undefined ? {} : { warning: prepared.selection.warning }),
      };
    } catch (error) {
      if (isPublicPreflightError(error)) throw new CodedError(AgentErrorCode.SpawnFailed);
      throw publicError(error, AgentErrorCode.SpawnFailed);
    }
  }

  sendInput(agentIdValue: AgentId, literalMessage: string): Promise<StartResult> {
    let token: ControllerOperation;
    try { token = this.admitOperation(); }
    catch (error) { return Promise.reject(publicError(error, AgentErrorCode.SessionUnavailable)); }
    return this.sendInputOwned(agentIdValue, literalMessage, token)
      .catch((error: unknown) => Promise.reject(publicError(error, AgentErrorCode.SessionUnavailable)))
      .finally(() => token.release());
  }

  private async sendInputOwned(agentIdValue: AgentId, literalMessage: string, token: ControllerOperation): Promise<StartResult> {
    if (literalMessage.length === 0) throw new CodedError(AgentErrorCode.InvalidInput);
    if (this.composition === undefined) throw new CodedError(AgentErrorCode.SessionUnavailable);
    const prepared = await this.prepareBounded(token, AgentErrorCode.SessionUnavailable,
      (scope) => this.composition!.prepareSend(agentIdValue, literalMessage, scope));
    this.requireOperationOpen(token);
    const result = await this.runs.launch(agentIdValue, async (adoptIdentity) => {
      const created = await this.createLaunchContained((surrender) => prepared.createLaunch(surrender));
      if (created.status === "failed") return { status: "failed" };
      if (created.status === "containment_failed") return { status: "containment_failed", runtime: created.runtime };
      const launch = await this.executeLaunch(prepared.session, literalMessage, created.transport, adoptIdentity);
      if (launch.status === "accepted") return { status: launch.status, runId: launch.runId, runtime: launch.runtime, onAccepted: launch.onAccepted };
      if (launch.status === "identity_failed") return { status: launch.status, runId: launch.runId, runtime: launch.runtime, beforeTerminal: launch.beforeTerminal };
      if (launch.status === "containment_failed") return { status: launch.status, runtime: launch.runtime };
      return { status: launch.status };
    });
    this.syncInventory();
    if (result.status === "settling") return { agentId: result.agentId, runId: result.runId, state: AgentState.Settling, error: toAgentError(AgentErrorCode.SpawnFailed) };
    if (result.status === "failed") return { agentId: result.agentId, state: AgentState.Stopped, error: toAgentError(AgentErrorCode.SpawnFailed) };
    if (result.status === "containment_failed") return { agentId: result.agentId, state: AgentState.Stopping, error: toAgentError(AgentErrorCode.ContainmentFailed) };
    return { agentId: result.agentId, runId: result.runId, state: AgentState.Running };
  }

  async awaitReady(options?: AwaitOptions): Promise<CompletionAwaitResult> {
    const result = await this.completions.awaitReady(options);
    if (result.completion !== undefined) {
      const key = agentRunKey(result.completion.agentId, result.completion.runId);
      this.observation.acknowledgeDelivered([key]);
      try { this.onCompletionDelivered(key); }
      catch { /* observation acknowledgement cannot affect lifecycle delivery */ }
    }
    if (result.remainingCompletions > 0 && !this.suppressPings) {
      try { await this.ping(result.remainingCompletions); }
      catch { /* the remaining queue stays visible to the next publish or drain */ }
    }
    return result;
  }

  async stop(agentIdValue: AgentId, reason: CancellationReason = CancellationReason.StopRequested): Promise<PublicStopOutcome> {
    const result = await this.runs.stop(agentIdValue, reason);
    this.syncInventory();
    return stopOutcome(result);
  }

  async publish(completion: AgentCompletion): Promise<void> {
    const key = agentRunKey(completion.agentId, completion.runId);
    this.durableCompletions.set(key, completion);
    const result = await this.completions.publish(completion);
    this.observation.publishCompletion(completion);
    if (result.shouldNotify) this.pendingNotifications.add(key);
    if (!this.pendingNotifications.has(key) || this.suppressPings) return;
    // A failed ping keeps the key pending: the queue entry is already durable and visible to the
    // next `await_agent`, and a re-publication of the same completion retries the notification.
    try {
      await this.ping(result.queueSize);
      this.pendingNotifications.delete(key);
    } catch { /* retried by the next publication of this completion */ }
  }

  restore(): Promise<void> {
    if (this.lifecycle === "closing") return Promise.reject(new CodedError(AgentErrorCode.InvalidState));
    if (this.restored) return Promise.resolve();
    if (this.restoreInFlight !== undefined) return this.restoreInFlight;
    if (this.lifecycle !== "open") return Promise.reject(new CodedError(AgentErrorCode.InvalidState));
    this.lifecycle = "restoring";
    const token = this.createOperation();
    const prior = [...this.operations].filter((operation) => operation !== token).map((operation) => operation.done);
    const operation = this.restoreOwnedAfter(prior).finally(() => {
      token.release();
      if (this.lifecycle === "restoring") this.lifecycle = "open";
    });
    this.restoreInFlight = operation;
    void operation.finally(() => {
      if (this.restoreInFlight === operation) this.restoreInFlight = undefined;
    }).catch(() => undefined);
    return operation;
  }

  private async restoreOwnedAfter(prior: readonly Promise<void>[]): Promise<void> {
    await Promise.allSettled(prior);
    if (this.lifecycle === "closing") throw new CodedError(AgentErrorCode.InvalidState);
    await this.restoreOwned();
  }

  private async restoreOwned(): Promise<void> {
    if (this.restorationApplied) {
      await this.retryRestoredCompletionObligations();
      this.restored = true;
      return;
    }
    if (this.restoration === undefined) {
      await this.composition?.restore?.();
      this.restorationApplied = true;
      this.restored = true;
      return;
    }

    const admission = await this.runs.beginRestore();
    try {
      let plan = this.stagedRestorePlan;
      if (plan === undefined) {
        const folded = this.restoration.folded;
        for (const diagnostic of folded.invalidEvents) this.parent?.warn?.(diagnostic);
        const evidence = await collectRestorationEvidence(
          folded,
          this.restoration,
          (input) => this.completedRestorationRuntime(input),
        );
        plan = planRestoration(folded, evidence);
        for (const agentIdValue of plan.warnings) this.warnContainment(agentIdValue);
        this.stagedRestorePlan = plan;
      }

      let restored: readonly AppliedAgentRecord[];
      try {
        restored = await applyRestoration(plan, admission, this.restoration, {
          durableCompletions: this.durableCompletions,
          restoredStartedAppends: this.restoredStartedAppends,
          restoredRecords: this.restoredRecords,
        }, (agentIdValue, error) => this.warnCompletionRestoreFailure(agentIdValue, error));
      } catch (error) {
        if (!(error instanceof RestorationApplicationError)) {
          this.stagedRestorePlan = undefined;
          throw error;
        }
        if (!error.admissionCommitted) throw error.cause;
        this.stagedRestorePlan = undefined;
        this.restorationApplied = true;
        this.completions.restore(error.restored.map(completionInventory));
        throw error.cause;
      }

      this.completions.restore(restored.map(completionInventory));
      await this.restoreObservationAuthority(restored);
      this.observation.reconcile(this.observationReconciliationSnapshot());
      this.restorationApplied = true;
      this.stagedRestorePlan = undefined;
      this.restored = ![...this.restoredRecords.values()].some(
        (obligation) => obligation.kind === "restore-completion",
      );
    } finally {
      admission.release();
    }
  }

  private async retryRestoredCompletionObligations(): Promise<void> {
    if (this.restoration === undefined) return;
    for (const [agentIdValue, obligation] of this.restoredRecords) {
      if (obligation.kind !== "restore-completion") continue;
      const candidate = obligation.record.completion;
      if (candidate === undefined) {
        throw new Error("invalid_state: restored completion obligation has no completion");
      }
      const completion = await this.restoration.restoreCompletion({
        ...obligation.record,
        completion: candidate,
      });
      this.durableCompletions.set(agentRunKey(completion.agentId, completion.runId), completion);
      await this.completions.publish(completion);
      this.observation.publishCompletion(completion);
      this.restoredRecords.delete(agentIdValue);
    }
  }

  private async appendRestoredRunStarted(agentIdValue: AgentId, nativeRunId: RunId, attemptId: RunAttemptId): Promise<void> {
    if (this.restoration === undefined) return;
    const key = agentRunKey(agentIdValue, nativeRunId);
    if (this.restoredStartedAppends.has(key)) return;
    await this.restoration.appender.appendRunStarted({ agentId: agentIdValue, runId: nativeRunId, attemptId });
    this.restoredStartedAppends.add(key);
  }

  status(): string {
    const active = this.runs.snapshots().filter((a) => a.state !== AgentState.Stopped).length;
    const ready = this.completions.queuedCount();
    return `agents: ${active} running, ${ready} result${ready === 1 ? "" : "s"} ready`;
  }

  beforeTree(): boolean {
    const allowed = this.runs.activeCount() === 0;
    if (!allowed) this.parent?.warn?.("Active child agents must reach stopped before tree navigation.");
    return allowed;
  }

  beforeSwitch(): boolean { return this.warnReplacement("switch"); }
  beforeFork(): boolean { return this.warnReplacement("fork"); }

  shutdown(): Promise<void> {
    const preparation = this.preparationContext.getStore();
    if (preparation?.activePreparation === true && this.operations.has(preparation)) {
      preparation.preparationShutdownAttempted = true;
      return Promise.reject(new CodedError(AgentErrorCode.InvalidState));
    }
    if (this.shuttingDown !== undefined) return this.shuttingDown;
    const enteringClosing = this.lifecycle !== "closing";
    this.lifecycle = "closing";
    this.suppressPings = true;
    if (enteringClosing) {
      try { this.composition?.shutdownStart?.(); }
      catch { /* UI cleanup cannot prevent containment. */ }
    }
    const admitted = [...this.operations].map((operation) => operation.done);
    const operation = (async () => {
      await Promise.allSettled(admitted);
      const active = this.runs.snapshots().filter((record) => record.state !== AgentState.Stopped);
      const outcomes = await Promise.all(active.map(async (record) => {
        try { return await this.runs.stop(record.agentId, CancellationReason.ParentShutdown); }
        catch { return undefined; }
      }));
      this.syncInventory();
      const retained = outcomes.filter((result) => result === undefined || result.status === "containment_failed");
      if (retained.length === 0 && this.runs.activeCount() === 0) {
        await this.composition?.shutdownComplete?.();
        this.observation.dispose();
        return;
      }
      const containedButUnrecorded = retained.length > 0 && retained.every((result) =>
        result?.status === "containment_failed" && result.code === AgentErrorCode.TerminalPersistenceFailed);
      throw new CodedError(containedButUnrecorded ? AgentErrorCode.TerminalPersistenceFailed : AgentErrorCode.ContainmentFailed);
    })();
    this.shuttingDown = operation;
    void operation.catch(() => {
      if (this.shuttingDown === operation) this.shuttingDown = undefined;
    });
    return operation;
  }

  private admitOperation(): ControllerOperation {
    if (this.lifecycle !== "open") throw new CodedError(AgentErrorCode.InvalidState);
    return this.createOperation();
  }

  private createOperation(): ControllerOperation {
    let resolve!: () => void;
    const token: ControllerOperation = {
      done: new Promise<void>((done) => { resolve = done; }),
      activePreparation: false,
      preparationShutdownAttempted: false,
      release: () => {
        if (!this.operations.delete(token)) return;
        token.activePreparation = false;
        resolve();
      },
    };
    this.operations.add(token);
    return token;
  }

  private async prepare<T>(token: ControllerOperation, operation: (scope: PreparationScope) => Promise<T>): Promise<T> {
    token.activePreparation = true;
    const scope: PreparationScope = {
      scheduleExternal: (callback: () => void): void => {
        if (!token.activePreparation || !this.operations.has(token)) throw new CodedError(AgentErrorCode.InvalidState);
        this.preparationContext.exit(() => {
          setImmediate(() => {
            try { void Promise.resolve(callback()).catch(() => undefined); }
            catch { /* Detached callback failures are bounded at this scheduling boundary. */ }
          });
        });
      },
    };
    try {
      return await this.preparationContext.run(token, () => operation(scope));
    } finally {
      token.activePreparation = false;
    }
  }

  private async prepareBounded<T>(
    token: ControllerOperation,
    fallbackCode: AgentErrorCode,
    operation: (scope: PreparationScope) => Promise<T>,
  ): Promise<T> {
    try {
      return await this.prepare(token, operation);
    } catch (error) {
      throw publicError(error, fallbackCode);
    }
  }

  private requireOperationOpen(token: ControllerOperation): void {
    if (this.lifecycle !== "open" || token.preparationShutdownAttempted) throw new CodedError(AgentErrorCode.InvalidState);
  }

  private syncInventory(): void {
    for (const record of this.runs.snapshots()) this.completions.upsertAgent({
      agentId: record.agentId, state: record.state, transcriptPath: record.transcriptPath,
      ...(record.state === AgentState.Stopped || record.runId === undefined ? {} : { currentRunId: record.runId }),
    });
  }

  /**
   * Runs a composition `createLaunch` under the containment-surrender contract: a throw after the
   * composition surrendered a handle is contained here, so capacity is never released and the
   * agent is never reported stopped while cgroup liveness remains possible.
   */
  private async createLaunchContained(
    create: (surrender: SurrenderContainment) => Promise<LaunchTransport>,
  ): Promise<
    | { status: "launched"; transport: LaunchTransport }
    | { status: "failed" }
    | { status: "containment_failed"; runtime: RunRuntime }
  > {
    let surrendered: RunRuntime | undefined;
    try {
      return { status: "launched", transport: await create((runtime) => { surrendered = runtime; }) };
    } catch { /* contained below through whatever the composition surrendered */ }
    const runtime: RunRuntime | undefined = surrendered;
    if (runtime === undefined) return { status: "failed" };
    try {
      await runtime.contain();
      return { status: "failed" };
    } catch { return { status: "containment_failed", runtime }; }
  }

  private async executeLaunch(
    session: LaunchSession,
    literalPrompt: string,
    transport: LaunchTransport,
    adoptIdentity: (runId: RunId, runtime: RunRuntime, beforeTerminal?: () => Promise<void>) => void,
  ): Promise<
    | { status: "accepted"; agentId: AgentId; transcriptPath: SessionPath; runId: RunId; runtime: RunRuntime; onAccepted: () => void }
    | { status: "identity_failed"; agentId: AgentId; transcriptPath: SessionPath; runId: RunId; runtime: RunRuntime; beforeTerminal: () => Promise<void> }
    | { status: "failed"; agentId: AgentId; transcriptPath: SessionPath }
    | { status: "containment_failed"; agentId: AgentId; transcriptPath: SessionPath; runtime: RunRuntime }
  > {
    let nativeRunId: RunId | undefined;
    let runtime: RunRuntime | undefined;
    let runStartedPersisted = false;
    const ensureRunStarted = async (): Promise<void> => {
      if (nativeRunId === undefined || runStartedPersisted) return;
      await transport.persistRunStarted(nativeRunId);
      runStartedPersisted = true;
    };
    try {
      runtime = transport.runtime;
      session.containment = await transport.ready();
      await transport.persistLaunchRequested();
      await transport.start();
      const deadline = this.identityDeadline();
      const bounded = <T>(operation: Promise<T>): Promise<T> => waitWithAbort(operation, deadline);
      const before = await bounded(transport.getEntries());
      await bounded(transport.prompt(literalPrompt));
      await bounded(transport.waitForAgentStart());
      while (true) {
        const snapshot = await bounded(transport.getEntries(before.leafId));
        const identity = classifyAssignmentEntries(snapshot.entries, literalPrompt);
        if (identity.kind === "invalid") throw new CodedError(AgentErrorCode.SpawnFailed);
        if (identity.kind === "matched") {
          nativeRunId = identity.runId;
          break;
        }
        await bounded(this.identityDelay(ASSIGNMENT_IDENTITY_POLL_MS, deadline));
      }
      const matchedRunId = nativeRunId;
      if (matchedRunId === undefined) throw new CodedError(AgentErrorCode.SpawnFailed);
      adoptIdentity(matchedRunId, runtime, ensureRunStarted);
      await ensureRunStarted();
      this.acceptedAssignments.set(agentRunKey(session.agentId, matchedRunId), literalPrompt);
      this.acceptedRunIds.add(matchedRunId);
      this.observation.acceptRun({
        agentId: session.agentId,
        runId: matchedRunId,
        attemptId: session.attemptId,
        assignment: literalPrompt,
      });
      transport.bindRun(matchedRunId);
      const settled = transport.waitSettled();
      return {
        status: "accepted", agentId: session.agentId, transcriptPath: session.transcriptPath, runId: matchedRunId,
        runtime,
        onAccepted: () => { void settled.then((result) => this.runs.settle(session.agentId, matchedRunId, classifyTerminal(result.reason === "agent_settled"
          ? { kind: "settled", stopReason: result.stopReason, ...(result.toolSequenceCompleted === undefined ? {} : { toolSequenceCompleted: result.toolSequenceCompleted }), ...(result.failureCause === undefined ? {} : { failureCause: result.failureCause }) }
          : { kind: "process_exited", failureCause: result.failureCause }))).catch(() => undefined); },
      };
    } catch (error) {
      transport.recordFailure?.(error);
      if (nativeRunId !== undefined) {
        return { status: "identity_failed", agentId: session.agentId, transcriptPath: session.transcriptPath,
          runId: nativeRunId, runtime: runtime!, beforeTerminal: ensureRunStarted };
      }
      if (runtime === undefined) {
        return { status: "containment_failed", agentId: session.agentId, transcriptPath: session.transcriptPath, runtime: unavailableRuntime() };
      }
      try {
        await runtime.contain();
        return { status: "failed", agentId: session.agentId, transcriptPath: session.transcriptPath };
      } catch {
        return { status: "containment_failed", agentId: session.agentId, transcriptPath: session.transcriptPath, runtime };
      }
    }
  }

  observationPort(): SubagentObservationPort { return this.observationReadPort; }

  private observeSpawned(session: LaunchSession, prepared: SpawnPreparation, assignment: string): void {
    const authority: ObservationAgentAuthority = {
      agentId: session.agentId,
      sessionPath: session.transcriptPath,
      cwd: session.cwd ?? absolutePath(dirname(session.transcriptPath)),
      model: prepared.selection.model,
      thinkingLevel: prepared.selection.thinkingLevel,
    };
    this.observationAgents.set(session.agentId, authority);
    if (!this.observationSpawnSequence.includes(session.agentId)) this.observationSpawnSequence.push(session.agentId);
    this.observation.registerSensitiveValues(this.sensitiveValues());
    this.observation.registerSpawned({
      ...authority,
      ordinal: directAgentOrdinal(this.observationSpawnSequence.indexOf(session.agentId) + 1),
      assignment,
    });
  }

  private async restoreObservationAuthority(records: readonly AppliedAgentRecord[]): Promise<void> {
    this.observationSpawnSequence.splice(0, this.observationSpawnSequence.length, ...(this.restoration?.folded.spawnSequence ?? []));
    for (const record of records) {
      this.observationAgents.set(record.agentId, {
        agentId: record.agentId,
        sessionPath: record.sessionPath,
        cwd: record.cwd,
        model: modelSpecFrom(record.provider, record.modelId),
        thinkingLevel: record.thinkingLevel,
      });
      const runId = record.state === AgentState.Stopped ? record.completion?.payload.runId : record.runId;
      if (runId !== undefined) {
        let assignment: string | undefined;
        try { assignment = await this.restoration?.readAssignment?.(record.sessionPath, runId); }
        catch { /* unavailable restoration labels use the safe fallback */ }
        this.acceptedAssignments.set(agentRunKey(record.agentId, runId), assignment ?? "Delegated task");
        this.acceptedRunIds.add(runId);
      }
    }
  }

  /** Authoritative ledger snapshot used only by total observation reconciliation adapters. */
  observationReconciliationSnapshot(): ObservationReconciliationSnapshot {
    const completionAuthority = this.completions.authoritySnapshot();
    return {
      spawnSequence: Object.freeze([...this.observationSpawnSequence]),
      agents: Object.freeze([...this.observationAgents.values()].map((agent) => Object.freeze({ ...agent }))),
      runs: Object.freeze(this.runs.snapshots().map((record) => Object.freeze({
        agentId: record.agentId,
        state: record.state,
        ...(record.runId === undefined ? {} : { runId: record.runId }),
      }))),
      completions: Object.freeze([...this.durableCompletions.values()]),
      pendingDelivery: completionAuthority.pendingDelivery,
      acceptedAssignments: new Map(this.acceptedAssignments),
      sensitiveValues: this.sensitiveValues(),
    };
  }

  private sensitiveValues(): ObservationSensitiveValues {
    const internalPaths = new Set<AbsolutePath>();
    if (this.restoration !== undefined) internalPaths.add(this.restoration.stateRoot);
    for (const agent of this.observationAgents.values()) {
      internalPaths.add(agent.sessionPath);
      internalPaths.add(agent.cwd);
    }
    for (const completion of this.durableCompletions.values()) {
      internalPaths.add(completion.outputPath);
      internalPaths.add(completion.transcriptPath);
      if (completion.state === "failed" && completion.error.diagnosticsPath !== undefined) internalPaths.add(completion.error.diagnosticsPath);
    }
    return {
      agentIds: new Set(this.observationSpawnSequence),
      runIds: new Set(this.acceptedRunIds),
      internalPaths,
    };
  }

  private warnReplacement(kind: string): boolean {
    if (this.runs.activeCount() === 0) return false;
    this.parent?.warn?.(`Proceeding with parent session ${kind} will cancel active child agents.`);
    return true;
  }

  private async ping(count: number): Promise<void> {
    if (this.parent === undefined) return;
    const text = `${count} agent completion${count === 1 ? " is" : "s are"} ready. Call await_agent to collect ${count === 1 ? "it" : "them"}.`;
    await this.parent.sendMessage(text, { deliverAs: "followUp", triggerTurn: !this.parent.isBusy() });
  }

  private warnContainment(agentIdValue: AgentId): void {
    this.parent?.warn?.(`containment_failed: receipt for agent ${agentIdValue} could not be verified`);
  }

  private warnCompletionRestoreFailure(agentIdValue: AgentId, error: unknown): void {
    const detail = error instanceof Error ? error.message : String(error);
    const warning = `Restored completion for agent ${agentIdValue} remains unavailable: ${detail}`;
    this.parent?.warn?.(truncateUtf8(warning, MAX_ERROR_MESSAGE_BYTES).text);
  }

  private completedRestorationRuntime(
    input: Parameters<RestorationPort["resolveContainment"]>[0],
  ): RunRuntime {
    return {
      abort: async () => {},
      contain: async () => {
        if (this.restoration === undefined) throw new CodedError(AgentErrorCode.ContainmentFailed);
        const decision = await this.restoration.resolveContainment(input);
        if (decision.kind === "contained") return decision.receipt;
        return decision.runtime.contain();
      },
    };
  }

  private async finaliseRestored(record: Readonly<RunRecord>): Promise<RunId | undefined> {
    let obligation = this.restoredRecords.get(record.agentId);
    if (obligation === undefined || this.restoration === undefined) return undefined;
    if (obligation.kind === "restore-completion") {
      const candidate = obligation.record.completion;
      if (candidate === undefined) {
        throw new Error("invalid_state: restored completion obligation has no completion");
      }
      const completion = await this.restoration.restoreCompletion({
        ...obligation.record,
        completion: candidate,
      });
      this.durableCompletions.set(agentRunKey(completion.agentId, completion.runId), completion);
      await this.publish(completion);
      this.restoredRecords.delete(record.agentId);
      return completion.runId;
    }
    let nativeRunId = record.runId ?? obligation.start?.runId;
    if (nativeRunId === undefined) {
      const pendingLaunch = obligation.record.state === AgentState.Stopped ? obligation.record.pendingLaunch : undefined;
      if (pendingLaunch === undefined) throw new Error("invalid_state: restored pre-native obligation has no launch cursor");
      nativeRunId = await this.restoration.firstUserEntryAfter(obligation.record.sessionPath, pendingLaunch.payload.previousLeafId);
      if (nativeRunId === undefined) {
        this.restoredRecords.delete(record.agentId);
        return undefined;
      }
      obligation = { ...obligation, start: { runId: nativeRunId, attemptId: pendingLaunch.payload.attemptId } };
      this.restoredRecords.set(record.agentId, obligation);
    }
    if (obligation.start !== undefined) {
      await this.appendRestoredRunStarted(record.agentId, obligation.start.runId, obligation.start.attemptId);
    }
    const key = agentRunKey(record.agentId, nativeRunId);
    const completion = this.durableCompletions.get(key)
      ?? await this.restoration.finaliseContained(obligation.record, nativeRunId, obligation.settlement);
    this.durableCompletions.set(key, completion);
    await this.restoration.appender.appendRunCompleted(completion);
    await this.publish(completion);
    this.restoredRecords.delete(record.agentId);
    return nativeRunId;
  }
}

function inertObservation(): AgentObservationMutationPort {
  return {
    registerSpawned: () => {}, acceptRun: () => {}, updateLifecycle: () => {}, publishCompletion: () => {},
    registerSensitiveValues: () => {}, acknowledgeDelivered: () => {}, reconcile: () => {}, dispose: () => {},
  };
}

function unavailableObservationPort(): SubagentObservationPort {
  return {
    observation: () => undefined,
    directSnapshot: () => ({ kind: "unavailable", finalRevision: agentObservationRevision(0) }),
    transcriptSource: () => undefined,
    subscribe: () => () => {},
  };
}

function totalObservationAdapter(
  port: AgentObservationMutationPort,
  authority: () => ObservationReconciliationSnapshot,
  claimReconciliation: () => boolean,
  releaseReconciliation: () => void,
): AgentObservationMutationPort {
  let reconciliationFailed = false;
  const schedule = (): void => {
    if (!claimReconciliation()) return;
    queueMicrotask(() => {
      try {
        port.reconcile(authority());
        reconciliationFailed = false;
      } catch { reconciliationFailed = true; }
      finally { releaseReconciliation(); }
    });
  };
  const invoke = <T extends readonly unknown[]>(operation: (...args: T) => void) => (...args: T): void => {
    const retry = reconciliationFailed;
    try { operation(...args); }
    catch { schedule(); return; }
    if (retry) { reconciliationFailed = false; schedule(); }
  };
  return {
    registerSpawned: invoke(port.registerSpawned.bind(port)),
    acceptRun: invoke(port.acceptRun.bind(port)),
    updateLifecycle: invoke(port.updateLifecycle.bind(port)),
    publishCompletion: invoke(port.publishCompletion.bind(port)),
    registerSensitiveValues: invoke(port.registerSensitiveValues.bind(port)),
    acknowledgeDelivered: invoke(port.acknowledgeDelivered.bind(port)),
    reconcile: invoke(port.reconcile.bind(port)),
    dispose: invoke(port.dispose.bind(port)),
  };
}

function unavailableRuntime(): RunRuntime {
  return {
    abort: async () => { throw new CodedError(AgentErrorCode.ContainmentFailed); },
    contain: async () => { throw new CodedError(AgentErrorCode.ContainmentFailed); },
  };
}

function stopOutcome(result: StopResult): PublicStopOutcome {
  if (result.status === "containment_failed") return { agentId: result.agentId, ...(result.runId ? { runId: result.runId } : {}), state: "failed", agentState: result.agentState, error: toAgentError(result.code) };
  if (result.status === "already_stopped") return { agentId: result.agentId, state: "already_stopped" };
  return { agentId: result.agentId, runId: result.runId, state: "cancelled" };
}

function completionInventory(record: AppliedAgentRecord) {
  return {
    agentId: record.agentId, state: record.state, sessionPath: record.sessionPath,
    ...(record.state !== AgentState.Stopped && record.runId !== undefined ? { currentRunId: record.runId } : {}),
    ...(record.completion === undefined ? {} : { latestCompletion: record.completion.payload }),
  };
}

function publicError(error: unknown, fallbackCode: AgentErrorCode): Error {
  if (error instanceof CodedError) return new CodedError(error.code, error.diagnosticsPath);
  return new CodedError(preparationErrorCode(error) ?? fallbackCode);
}

function preparationErrorCode(error: unknown): AgentErrorCode | undefined {
  if (error instanceof CodedError || isPublicPreflightError(error)) return error.code;
  const prefix = error instanceof Error ? /^([a-z_]+):/.exec(error.message)?.[1] : undefined;
  const prefixedCode = Object.values(AgentErrorCode).find((code) => code === prefix);
  if (prefixedCode !== undefined) return prefixedCode;
  if (typeof error !== "object" || error === null) return undefined;
  let candidate: unknown;
  try { candidate = (error as { code?: unknown }).code; }
  catch { return undefined; }
  return Object.values(AgentErrorCode).find((code) => code === candidate);
}
