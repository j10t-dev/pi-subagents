import { AsyncLocalStorage } from "node:async_hooks";
import { CompletionService, type ReceiveAgentResult, type ReceiveOptions } from "./completion-service.ts";
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
  type RunId,
  type SessionEntryId,
  type SessionPath,
  type ContainmentReceiptPath,
  type AbsolutePath,
  type RunAttemptId,
  type VerifiedContainmentReceiptPath,
  verifiedContainmentReceiptPath,
  isPublicPreflightError,
} from "./domain.ts";
import type { EffectiveChildSelection } from "./child-selection.ts";
import { RunController, classifyTerminal, type RunRecord, type RunRuntime, type Settlement, type StopResult } from "./run-controller.ts";
import { foldAgentEvents, type AgentEventAppender, type RestoredAgentRecord } from "./persistence.ts";
import type { RpcRunClient } from "./rpc-client.ts";
import { classifyAssignmentEntries } from "./assignment-identity.ts";
import { delayWithAbort, waitWithAbort } from "./async-primitives.ts";
import { ASSIGNMENT_IDENTITY_POLL_MS, ASSIGNMENT_IDENTITY_TIMEOUT_MS } from "./constants.ts";
import type { ContainmentDescriptor } from "./containment.ts";

export interface SpawnAgentRequest { task: string; model?: string; cwd?: string; tools?: string[] }

export interface LaunchSession {
  agentId: AgentId;
  transcriptPath: SessionPath;
  previousLeafId: SessionEntryId | null;
  attemptId: RunAttemptId;
  containmentReceiptPath: ContainmentReceiptPath;
  containment?: ContainmentDescriptor;
}

export interface LaunchTransport extends Pick<RpcRunClient, "start" | "getEntries" | "prompt" | "bindRun" | "waitForAgentStart" | "waitSettled"> {
  readonly containment: ContainmentDescriptor;
  ready(): Promise<void>;
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

export type RestorationContainmentDecision =
  | { kind: "contained"; receipt: VerifiedContainmentReceiptPath }
  | { kind: "requires-containment"; runtime: RunRuntime }
  | { kind: "unresolved-historical"; runtime: RunRuntime };

export interface RestorationPort {
  /** Parent branch state root used to contain every restored durable path. */
  stateRoot: AbsolutePath;
  getBranch(): readonly { type: string; customType?: string; data?: unknown }[];
  resolveContainment(input: {
    attemptId: RunAttemptId;
    receiptPath: ContainmentReceiptPath;
    descriptor?: ContainmentDescriptor;
    eventVersion: 1 | 2;
  }): Promise<RestorationContainmentDecision>;
  firstUserEntryAfter(sessionPath: SessionPath, cursor: SessionEntryId | null): Promise<RunId | undefined>;
  finaliseContained(
    record: RestoredAgentRecord,
    runId: RunId,
    settlement:
      | { kind: "interrupted" }
      | { kind: "cancelled"; reason: CancellationReason },
  ): Promise<AgentCompletion>;
  appender: AgentEventAppender;
}

export interface SubagentControllerOptions {
  capacity?: number;
  completions?: CompletionService;
  composition?: PiControllerComposition;
  parent?: ParentLifecyclePort;
  restoration?: RestorationPort;
  trace?: (event: string) => void;
  onStatusChange?: () => void;
  identityDeadline?: () => AbortSignal;
  identityDelay?: (milliseconds: number, signal: AbortSignal) => Promise<void>;
}

interface RestoredCompletionIntent {
  readonly type: "completed";
  readonly record: RestoredAgentRecord;
  readonly runId: RunId;
  readonly settlement:
    | { kind: "interrupted" }
    | { kind: "cancelled"; reason: CancellationReason };
}

interface RestoredFinalisationObligation {
  readonly kind: "finalise";
  readonly record: RestoredAgentRecord;
  readonly settlement:
    | { kind: "interrupted" }
    | { kind: "cancelled"; reason: CancellationReason };
  readonly start?: { runId: RunId; attemptId: RunAttemptId };
}

interface RestoredCompletionObligation {
  readonly kind: "restore-completion";
  readonly record: RestoredAgentRecord;
}

type RestoredTerminalObligation = RestoredFinalisationObligation | RestoredCompletionObligation;

interface StagedRestorePlan {
  readonly restored: RestoredAgentRecord[];
  readonly runtimeRecords: readonly RunRecord[];
  readonly durableWrites: readonly RestoredCompletionIntent[];
  readonly obligations: ReadonlyMap<AgentId, RestoredTerminalObligation>;
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
  private restorationBackPingCount = 0;
  private stagedRestorePlan: StagedRestorePlan | undefined;
  private readonly restoredStartedAppends = new Set<ReturnType<typeof agentRunKey>>();
  private readonly restoredRecords = new Map<AgentId, RestoredTerminalObligation>();
  private readonly durableCompletions = new Map<ReturnType<typeof agentRunKey>, AgentCompletion>();
  private readonly pendingNotifications = new Set<ReturnType<typeof agentRunKey>>();
  private readonly identityDeadline: () => AbortSignal;
  private readonly identityDelay: (milliseconds: number, signal: AbortSignal) => Promise<void>;

  constructor(options: SubagentControllerOptions = {}) {
    this.completions = options.completions ?? new CompletionService();
    this.composition = options.composition;
    this.parent = options.parent;
    this.restoration = options.restoration;
    this.trace = options.trace;
    this.identityDeadline = options.identityDeadline ?? (() => AbortSignal.timeout(ASSIGNMENT_IDENTITY_TIMEOUT_MS));
    this.identityDelay = options.identityDelay ?? delayWithAbort;
    this.runs = new RunController({
      capacity: options.capacity ?? 4,
      onReserve: () => this.trace?.("reserve"),
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

  receive(options?: ReceiveOptions): Promise<ReceiveAgentResult> { return this.completions.receive(options); }

  async stop(agentIdValue: AgentId, reason: CancellationReason = CancellationReason.StopRequested): Promise<PublicStopOutcome> {
    const result = await this.runs.stop(agentIdValue, reason);
    this.syncInventory();
    return stopOutcome(result);
  }

  async publish(completion: AgentCompletion): Promise<void> {
    const key = agentRunKey(completion.agentId, completion.runId);
    const result = await this.completions.publish(completion);
    if (result.shouldNotify) this.pendingNotifications.add(key);
    if (!this.pendingNotifications.has(key) || this.suppressPings) return;
    // A failed ping keeps the key pending: the queue entry is already durable and visible to the
    // next `receive_agent`, and a re-publication of the same completion retries the notification.
    try {
      await this.ping(result.queueSize, "runtime");
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
      await this.notifyRestored(this.restorationBackPingCount);
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
        const folded = foldAgentEvents(this.restoration.getBranch(), this.restoration.stateRoot);
        for (const diagnostic of folded.invalidEvents) this.parent?.warn?.(diagnostic);
        const restored: RestoredAgentRecord[] = [];
        const intents: RestoredCompletionIntent[] = [];
        const obligations = new Map<AgentId, RestoredTerminalObligation>();
        const containmentDecisions = new Map<string, Promise<RestorationContainmentDecision>>();
        const runtimes = new Map<AgentId, RunRuntime>();
        const historical = new Set<AgentId>();
        const resolveContainment = async (input: {
          path: ContainmentReceiptPath | undefined;
          attemptId: RunAttemptId | undefined;
          descriptor?: ContainmentDescriptor;
          eventVersion: 1 | 2;
        }): Promise<{ contained: boolean; decision: RestorationContainmentDecision }> => {
          if (input.path === undefined || input.attemptId === undefined) {
            return { contained: false, decision: { kind: "requires-containment", runtime: unavailableRuntime() } };
          }
          const key = `${input.path}\0${input.attemptId}\0${input.eventVersion}\0${input.descriptor?.scopePath ?? ""}`;
          let pending = containmentDecisions.get(key);
          if (pending === undefined) {
            pending = this.restoration!.resolveContainment({
              attemptId: input.attemptId,
              receiptPath: input.path,
              ...(input.descriptor === undefined ? {} : { descriptor: input.descriptor }),
              eventVersion: input.eventVersion,
            });
            containmentDecisions.set(key, pending);
          }
          let decision: RestorationContainmentDecision;
          try { decision = await pending; }
          catch { decision = { kind: "requires-containment", runtime: unavailableRuntime() }; }
          if (decision.kind === "contained") return { contained: true, decision };
          if (decision.kind === "unresolved-historical") return { contained: false, decision };
          try {
            await decision.runtime.contain();
            return { contained: true, decision };
          } catch {
            return { contained: false, decision };
          }
        };

        for (const record of folded.agents.values()) {
          const activeInput = record.pendingLaunch !== undefined
            ? {
                path: record.pendingLaunch.containmentReceiptPath,
                attemptId: record.pendingLaunch.attemptId,
                ...("containment" in record.pendingLaunch ? { descriptor: record.pendingLaunch.containment } : {}),
                eventVersion: record.pendingLaunchEventVersion ?? 1,
              }
            : record.currentAttemptId !== undefined
              ? {
                  path: record.currentReceiptPath,
                  attemptId: record.currentAttemptId,
                  ...(record.currentContainment === undefined ? {} : { descriptor: record.currentContainment }),
                  eventVersion: record.currentEventVersion ?? 1,
                }
              : {
                  path: record.latestCompletionReceiptPath,
                  attemptId: record.latestCompletionAttemptId,
                  ...(record.latestCompletionContainment === undefined ? {} : { descriptor: record.latestCompletionContainment }),
                  eventVersion: record.latestCompletionEventVersion ?? 1,
                };
          const resolution = await resolveContainment(activeInput);
          if (resolution.decision.kind === "contained") {
            const receipt = resolution.decision.receipt;
            runtimes.set(record.agentId, { abort: async () => {}, contain: async () => receipt });
          } else {
            runtimes.set(record.agentId, resolution.decision.runtime);
            if (resolution.decision.kind === "unresolved-historical") historical.add(record.agentId);
          }
          let candidate = record;
          if (record.latestCompletion !== undefined && !resolution.contained) candidate = withoutLatestCompletion(record);
          const contained = resolution.contained;
          if (record.pendingLaunch !== undefined && contained) {
            const settlement = { kind: "interrupted" as const };
            let nativeRunId: RunId | undefined;
            try { nativeRunId = await this.restoration.firstUserEntryAfter(record.sessionPath, record.pendingLaunch.previousLeafId); }
            catch {
              this.warnContainment(record.agentId);
              restored.push(asUncontained(candidate));
              obligations.set(record.agentId, { kind: "finalise", record, settlement });
              continue;
            }
            if (nativeRunId === undefined) {
              restored.push(asStopped(candidate));
            } else {
              const active = asActiveRestored(record, nativeRunId, AgentState.Settling);
              restored.push(active);
              intents.push({ type: "completed", record, runId: nativeRunId, settlement });
              obligations.set(record.agentId, { kind: "finalise", record, settlement, start: { runId: nativeRunId, attemptId: record.pendingLaunch.attemptId } });
            }
          } else if (record.pendingLaunch !== undefined) {
            this.warnContainment(record.agentId);
            restored.push(asUncontained(candidate));
            obligations.set(record.agentId, { kind: "finalise", record, settlement: { kind: "interrupted" } });
          } else if (record.state === AgentState.Running && record.currentRunId !== undefined) {
            const settlement = { kind: "interrupted" as const };
            const active = asActiveRestored(record, record.currentRunId, AgentState.Settling);
            restored.push(active);
            obligations.set(record.agentId, { kind: "finalise", record, settlement });
            if (contained) intents.push({ type: "completed", record, runId: record.currentRunId, settlement });
            else this.warnContainment(record.agentId);
          } else if (record.state === AgentState.Stopping && record.currentRunId !== undefined) {
            const settlement = { kind: "cancelled" as const, reason: record.pendingStopReason ?? CancellationReason.StopRequested };
            const active = asActiveRestored(record, record.currentRunId, AgentState.Stopping);
            restored.push(active);
            obligations.set(record.agentId, { kind: "finalise", record, settlement });
            if (contained) intents.push({ type: "completed", record, runId: record.currentRunId, settlement });
            else this.warnContainment(record.agentId);
          } else if (record.state === AgentState.Stopped && record.latestCompletion !== undefined && candidate.latestCompletion !== undefined) {
            restored.push(candidate);
          } else if (record.state === AgentState.Stopped && record.latestCompletion !== undefined) {
            this.warnContainment(record.agentId);
            restored.push(asUncontained(candidate));
            obligations.set(record.agentId, { kind: "restore-completion", record });
            if (activeInput.path !== undefined && activeInput.attemptId !== undefined) {
              runtimes.set(record.agentId, this.completedRestorationRuntime({
                attemptId: activeInput.attemptId,
                receiptPath: activeInput.path,
                ...(activeInput.descriptor === undefined ? {} : { descriptor: activeInput.descriptor }),
                eventVersion: activeInput.eventVersion,
              }));
            }
          } else if (record.state === AgentState.Stopped) {
            restored.push(record);
          } else {
            this.warnContainment(record.agentId);
            restored.push(asUncontained(candidate));
          }
        }

        const runtimeRecords = restored.map((record) => {
          const runtime = record.state === AgentState.Stopped ? undefined : runtimes.get(record.agentId);
          const preNative = record.pendingLaunch !== undefined && record.currentRunId === undefined && record.state !== AgentState.Stopped;
          const responsibility = historical.has(record.agentId) ? "historical-unresolved" as const : preNative ? "pre-native" as const : undefined;
          return { agentId: record.agentId, state: record.state, transcriptPath: record.sessionPath,
            ...(record.currentRunId ? { runId: record.currentRunId } : {}),
            ...(runtime === undefined ? {} : { runtime }),
            ...(responsibility === undefined ? {} : { containmentResponsibility: responsibility }),
            ...(preNative && obligations.has(record.agentId) ? { restoredTerminalObligation: true as const } : {}) };
        });
        plan = { restored, runtimeRecords, durableWrites: intents, obligations };
        this.stagedRestorePlan = plan;
      }

      try { admission.reserve(plan.runtimeRecords); }
      catch (error) { this.stagedRestorePlan = undefined; throw error; }

      try {
        for (const obligation of plan.obligations.values()) {
          if (obligation.kind === "finalise" && obligation.start !== undefined) {
            await this.appendRestoredRunStarted(obligation.record.agentId, obligation.start.runId, obligation.start.attemptId);
          }
        }
        for (const intent of plan.durableWrites) {
          const completion = await this.restoration.finaliseContained(intent.record, intent.runId, intent.settlement);
          this.durableCompletions.set(agentRunKey(intent.record.agentId, intent.runId), completion);
        }
        for (const intent of plan.durableWrites) {
          const completion = this.durableCompletions.get(agentRunKey(intent.record.agentId, intent.runId));
          if (completion === undefined) throw new Error("invalid_state: restored durable completion unavailable");
          await this.restoration.appender.appendRunCompleted(completion);
        }
        for (const intent of plan.durableWrites) {
          const completion = this.durableCompletions.get(agentRunKey(intent.record.agentId, intent.runId));
          if (completion === undefined) throw new Error("invalid_state: restored durable completion unavailable");
          const stopped = asStopped(intent.record, completion);
          const index = plan.restored.findIndex((record) => record.agentId === intent.record.agentId);
          if (index >= 0) plan.restored[index] = stopped;
          admission.replace({ agentId: stopped.agentId, state: AgentState.Stopped, transcriptPath: stopped.sessionPath });
        }
        for (const record of plan.restored) {
          const obligation = plan.obligations.get(record.agentId);
          if (record.state !== AgentState.Stopped && obligation !== undefined) this.restoredRecords.set(record.agentId, obligation);
        }
        admission.commit();
      } catch (error) {
        for (const [agentIdValue, obligation] of plan.obligations) this.restoredRecords.set(agentIdValue, obligation);
        admission.commit();
        this.restorationApplied = true;
        this.stagedRestorePlan = undefined;
        const failedRestore = this.completions.restore(plan.restored.map(completionInventory));
        this.restorationBackPingCount = failedRestore.backPingCount;
        throw error;
      }

      const result = this.completions.restore(plan.restored.map(completionInventory));
      this.restorationBackPingCount = result.backPingCount;
      this.restorationApplied = true;
      this.stagedRestorePlan = undefined;
      await this.notifyRestored(result.backPingCount);
      this.restored = true;
    } finally {
      admission.release();
    }
  }

  private async appendRestoredRunStarted(agentIdValue: AgentId, nativeRunId: RunId, attemptId: RunAttemptId): Promise<void> {
    if (this.restoration === undefined) return;
    const key = agentRunKey(agentIdValue, nativeRunId);
    if (this.restoredStartedAppends.has(key)) return;
    await this.restoration.appender.appendRunStarted({ agentId: agentIdValue, runId: nativeRunId, attemptId });
    this.restoredStartedAppends.add(key);
  }

  async notifyRestored(count: number): Promise<void> {
    if (count > 0 && !this.suppressPings) await this.ping(count, "restored");
  }

  status(): string {
    const active = this.runs.snapshots().filter((a) => a.state !== AgentState.Stopped).length;
    return `agents: ${active} running, ${this.completions.queuedCount()} result ready`;
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
      await transport.ready();
      session.containment = transport.containment;
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
      transport.bindRun(matchedRunId);
      await ensureRunStarted();
      const settled = transport.waitSettled();
      return {
        status: "accepted", agentId: session.agentId, transcriptPath: session.transcriptPath, runId: matchedRunId,
        runtime,
        onAccepted: () => { void settled.then((result) => this.runs.settle(session.agentId, nativeRunId!, classifyTerminal(result.reason === "agent_settled"
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

  private warnReplacement(kind: string): boolean {
    if (this.runs.activeCount() === 0) return false;
    this.parent?.warn?.(`Proceeding with parent session ${kind} will cancel active child agents.`);
    return true;
  }

  private async ping(count: number, kind: "runtime" | "restored"): Promise<void> {
    if (this.parent === undefined) return;
    const text = `${count} agent completion${count === 1 ? " is" : "s are"} ready. Call receive_agent to collect ${count === 1 ? "it" : "them"}.`;
    if (kind === "restored") return void await this.parent.sendMessage(text, { deliverAs: "nextTurn", triggerTurn: false });
    await this.parent.sendMessage(text, { deliverAs: "followUp", triggerTurn: !this.parent.isBusy() });
  }

  private warnContainment(agentIdValue: AgentId): void {
    this.parent?.warn?.(`containment_failed: receipt for agent ${agentIdValue} could not be verified`);
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
      const completion = obligation.record.latestCompletion;
      if (completion === undefined) throw new Error("invalid_state: restored completion obligation has no completion");
      this.durableCompletions.set(agentRunKey(completion.agentId, completion.runId), completion);
      await this.publish(completion);
      this.restoredRecords.delete(record.agentId);
      return completion.runId;
    }
    let nativeRunId = record.runId ?? obligation.start?.runId;
    if (nativeRunId === undefined) {
      const pendingLaunch = obligation.record.pendingLaunch;
      if (pendingLaunch === undefined) throw new Error("invalid_state: restored pre-native obligation has no launch cursor");
      nativeRunId = await this.restoration.firstUserEntryAfter(obligation.record.sessionPath, pendingLaunch.previousLeafId);
      if (nativeRunId === undefined) {
        this.restoredRecords.delete(record.agentId);
        return undefined;
      }
      obligation = { ...obligation, start: { runId: nativeRunId, attemptId: pendingLaunch.attemptId } };
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

function completionInventory(record: RestoredAgentRecord) {
  return { agentId: record.agentId, state: record.state, sessionPath: record.sessionPath,
    ...(record.currentRunId ? { currentRunId: record.currentRunId } : {}),
    ...(record.latestCompletion ? { latestCompletion: record.latestCompletion } : {}) };
}

function asActiveRestored(
  record: RestoredAgentRecord,
  runId: RunId,
  state: typeof AgentState.Settling | typeof AgentState.Stopping,
): RestoredAgentRecord {
  const { latestCompletion: _completion, ...rest } = record;
  void _completion;
  return { ...rest, state, currentRunId: runId };
}

function asStopped(record: RestoredAgentRecord, latestCompletion?: AgentCompletion): RestoredAgentRecord {
  const { currentRunId: _run, pendingLaunch: _launch, pendingStopReason: _reason, ...durable } = record;
  void _run; void _launch; void _reason;
  return { ...durable, state: AgentState.Stopped, ...(latestCompletion === undefined ? {} : { latestCompletion }) };
}

function asUncontained(record: RestoredAgentRecord): RestoredAgentRecord {
  return { ...record, state: record.state === AgentState.Stopping || record.pendingLaunch !== undefined ? AgentState.Stopping : AgentState.Settling };
}

function withoutLatestCompletion(record: RestoredAgentRecord): RestoredAgentRecord {
  const { latestCompletion: _completion, latestCompletionAttemptId: _attempt, latestCompletionReceiptPath: _receipt, ...rest } = record;
  void _completion; void _attempt; void _receipt;
  return rest;
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
