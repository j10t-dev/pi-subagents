import { Mutex, RunSemaphore, type RunReservation } from "./async-primitives.ts";
import {
  AgentErrorCode,
  AgentState,
  CancellationReason,
  CodedError,
  terminalFailureCause,
  type AgentId,
  type RunCapacity,
  type RunId,
  type SessionPath,
  type TerminalFailureCause,
  type VerifiedContainmentReceiptPath,
} from "./domain.ts";

export interface RunRuntime {
  abort(): Promise<void>;
  contain(): Promise<VerifiedContainmentReceiptPath>;
}

export interface RunRecord {
  agentId: AgentId;
  state: AgentState;
  transcriptPath: SessionPath;
  runId?: RunId;
  /** Restored ownership before Pi exposed a native user-entry identity. */
  containmentResponsibility?: "pre-native" | "historical-unresolved";
  /** Restored containment capability; live launches install this internally. */
  runtime?: RunRuntime;
  /** A restored pre-native launch must reconcile historical identity after containment. */
  restoredTerminalObligation?: true;
}

interface LiveRecord {
  readonly agentId: AgentId;
  readonly transcriptPath: SessionPath;
  readonly mutex: Mutex;
  phase: Phase;
}

type RunIdentity = { runId: RunId; runtime: RunRuntime };
type RestoredProvenance = {
  containmentResponsibility?: "pre-native" | "historical-unresolved";
  restoredTerminalObligation?: true;
};

type LaunchingPhase = Extract<Phase, { kind: "launching" }>;
type TerminatingPhase = Extract<Phase, { kind: "terminating" }>;

/** Exported for tests. */
export type Phase =
  | { kind: "launching";
      reservation: RunReservation;
      done: Promise<void>;
      resolveDone: () => void;
      identity?: RunIdentity;
      beforeTerminate?: () => Promise<void>;
      provenance?: RestoredProvenance;
      stopRequested?: CancellationReason }
  | { kind: "running";
      reservation: RunReservation;
      identity: RunIdentity;
      beforeTerminate?: () => Promise<void>;
      provenance?: RestoredProvenance;
      stopRequested?: CancellationReason }
  | { kind: "preRunContainment";
      reservation: RunReservation;
      runtime: RunRuntime;
      runId?: RunId;
      provenance?: RestoredProvenance;
      completion?: Promise<StopResult> }
  | { kind: "terminating";
      reservation: RunReservation;
      runtime?: RunRuntime;
      runId?: RunId;
      terminalState: typeof AgentState.Settling | typeof AgentState.Stopping;
      outcome?: Settlement;
      contained: boolean;
      beforeTerminate?: () => Promise<void>;
      provenance?: RestoredProvenance;
      completion?: Promise<StopResult> }
  | { kind: "stopped";
      runId?: RunId;
      provenance?: RestoredProvenance };

interface TerminalOwner {
  record: LiveRecord;
  phase: TerminatingPhase;
  settlement: Settlement;
  abort: boolean;
  reason?: CancellationReason;
  resolve(result: StopResult): void;
}

export type LaunchResult = { status: "running"; agentId: AgentId; runId: RunId };
export type LaunchFailedResult =
  | { status: "failed"; agentId: AgentId }
  | { status: "settling"; agentId: AgentId; runId: RunId }
  | { status: "containment_failed"; agentId: AgentId };
type NewLaunchOperation =
  | { status: "accepted"; agentId: AgentId; transcriptPath: SessionPath; runId: RunId; runtime: RunRuntime; onAccepted?: () => void }
  | { status: "identity_failed"; agentId: AgentId; transcriptPath: SessionPath; runId: RunId; runtime: RunRuntime; beforeTerminal: () => Promise<void> }
  | { status: "failed"; agentId: AgentId; transcriptPath: SessionPath }
  | { status: "containment_failed"; agentId: AgentId; transcriptPath: SessionPath; runtime: RunRuntime };
type ExistingLaunchOperation =
  | { status: "accepted"; runId: RunId; runtime: RunRuntime; onAccepted?: () => void }
  | { status: "identity_failed"; runId: RunId; runtime: RunRuntime; beforeTerminal: () => Promise<void> }
  | { status: "failed" }
  | { status: "containment_failed"; runtime: RunRuntime };
/** Why a terminal obligation was retained: liveness unproven, or proven dead but unrecorded. */
export type RetainedTerminalCode =
  | typeof AgentErrorCode.ContainmentFailed
  | typeof AgentErrorCode.TerminalPersistenceFailed;
export type StopResult =
  | { status: "stopped"; agentId: AgentId; runId: RunId }
  | { status: "already_stopped"; agentId: AgentId }
  /** Terminal obligation retained with state, capacity and watchdog responsibility; `code` names the cause. */
  | { status: "containment_failed"; agentId: AgentId; runId?: RunId; agentState: typeof AgentState.Settling | typeof AgentState.Stopping; code: RetainedTerminalCode };
export type Settlement =
  | { kind: "completed" }
  | { kind: "cancelled"; reason?: CancellationReason }
  | { kind: "failed"; cause: TerminalFailureCause };
export type TerminalObservation =
  | { kind: "settled"; stopReason: "stop" | "length" | "error" | "aborted" | "toolUse"; toolSequenceCompleted?: boolean; failureCause?: TerminalFailureCause }
  | { kind: "process_exited"; failureCause?: TerminalFailureCause };

/** Exported for tests. */
export function agentStateOf(phase: Phase): AgentState {
  switch (phase.kind) {
    case "launching": return phase.identity === undefined ? AgentState.Stopped : AgentState.Running;
    case "running": return AgentState.Running;
    case "preRunContainment": return AgentState.Stopping;
    case "terminating": return phase.terminalState;
    case "stopped": return AgentState.Stopped;
  }
}

function runIdOf(phase: Phase): RunId | undefined {
  switch (phase.kind) {
    case "launching": return phase.identity?.runId;
    case "running": return phase.identity.runId;
    case "preRunContainment":
    case "terminating":
    case "stopped": return phase.runId;
  }
}

function runtimeOf(phase: Phase): RunRuntime | undefined {
  switch (phase.kind) {
    case "running": return phase.identity.runtime;
    case "preRunContainment":
    case "terminating": return phase.runtime;
    case "launching": return phase.identity?.runtime;
    case "stopped": return undefined;
  }
}

/** Exported for tests. */
export function toCallbackRecord(r: LiveRecord): RunRecord {
  const phase = r.phase;
  const runId = runIdOf(phase);
  const runtime = runtimeOf(phase);
  return {
    agentId: r.agentId,
    state: agentStateOf(phase),
    transcriptPath: r.transcriptPath,
    ...(runId === undefined ? {} : { runId }),
    ...(runtime === undefined ? {} : { runtime }),
    ...(phase.provenance?.containmentResponsibility === undefined ? {} : { containmentResponsibility: phase.provenance.containmentResponsibility }),
    ...(phase.provenance?.restoredTerminalObligation === undefined ? {} : { restoredTerminalObligation: phase.provenance.restoredTerminalObligation }),
  };
}

/** Exported for tests. */
export function toSnapshot(r: LiveRecord): RunRecord {
  const phase = r.phase;
  const runId = runIdOf(phase);
  return {
    agentId: r.agentId,
    state: agentStateOf(phase),
    transcriptPath: r.transcriptPath,
    ...(runId === undefined ? {} : { runId }),
    ...(phase.provenance?.containmentResponsibility === undefined ? {} : { containmentResponsibility: phase.provenance.containmentResponsibility }),
  };
}

function launchingPhase(reservation: RunReservation, provenance?: RestoredProvenance): LaunchingPhase {
  let resolveDone!: () => void;
  const done = new Promise<void>((resolve) => { resolveDone = resolve; });
  return { kind: "launching", reservation, done, resolveDone, ...(provenance === undefined ? {} : { provenance }) };
}

function runningPhase(prev: LaunchingPhase, identity: RunIdentity, preserveStopRequested: boolean): Extract<Phase, { kind: "running" }> {
  return {
    kind: "running", reservation: prev.reservation, identity,
    ...(prev.beforeTerminate === undefined ? {} : { beforeTerminate: prev.beforeTerminate }),
    ...(prev.provenance === undefined ? {} : { provenance: prev.provenance }),
    ...(preserveStopRequested && prev.stopRequested !== undefined ? { stopRequested: prev.stopRequested } : {}),
  };
}

function terminatingPhase(
  prev: Extract<Phase, { kind: "launching" | "running" | "preRunContainment" | "terminating" }>,
  terminalState: typeof AgentState.Settling | typeof AgentState.Stopping,
  settlement: Settlement,
): TerminatingPhase {
  if (prev.kind === "terminating") return { ...prev, outcome: prev.outcome ?? settlement };
  const identity = prev.kind === "preRunContainment"
    ? { runId: prev.runId, runtime: prev.runtime }
    : { runId: prev.identity?.runId, runtime: prev.identity?.runtime };
  return {
    kind: "terminating", reservation: prev.reservation, terminalState,
    outcome: settlement, contained: false,
    ...(identity.runtime === undefined ? {} : { runtime: identity.runtime }),
    ...(identity.runId === undefined ? {} : { runId: identity.runId }),
    ...(prev.kind !== "preRunContainment" && prev.beforeTerminate !== undefined ? { beforeTerminate: prev.beforeTerminate } : {}),
    ...(prev.provenance === undefined ? {} : { provenance: prev.provenance }),
  };
}

function stoppedFromTerminating(prev: TerminatingPhase): Extract<Phase, { kind: "stopped" }> {
  return {
    kind: "stopped",
    ...(prev.runId === undefined ? {} : { runId: prev.runId }),
    ...(prev.provenance === undefined ? {} : { provenance: prev.provenance }),
  };
}

export function classifyTerminal(observation: TerminalObservation, controllerStopWon = false): Settlement {
  if (observation.kind === "process_exited") return { kind: "failed", cause: observation.failureCause ?? terminalFailureCause(AgentErrorCode.ProcessExited) };
  if (observation.stopReason === "stop" || observation.stopReason === "length") return { kind: "completed" };
  if (observation.stopReason === "toolUse" && observation.toolSequenceCompleted === true) return { kind: "completed" };
  if (observation.stopReason === "aborted") return controllerStopWon
    ? { kind: "cancelled" }
    : { kind: "failed", cause: observation.failureCause ?? terminalFailureCause(AgentErrorCode.RunInterrupted) };
  return { kind: "failed", cause: observation.failureCause ?? terminalFailureCause(
    observation.stopReason === "error" ? AgentErrorCode.ProtocolError : AgentErrorCode.RunInterrupted,
  ) };
}

export interface RunControllerOptions {
  capacity: RunCapacity;
  onReserve?: () => void;
  onStopping?: (record: Readonly<RunRecord>, reason: CancellationReason) => void | Promise<void>;
  onTerminal?: (record: Readonly<RunRecord>, settlement: Settlement) => RunId | void | Promise<RunId | void>;
  onRelease?: (agentId: AgentId) => void;
}

export interface RestoreAdmission {
  reserve(records: Iterable<RunRecord>): void;
  replace(record: RunRecord): void;
  commit(): void;
  release(): void;
}

/** Lifecycle arbitration independent of Pi transport construction. External work never holds a mutex. */
export class RunController {
  private readonly semaphore: RunSemaphore;
  private readonly agents = new Map<AgentId, LiveRecord>();
  private readonly options: RunControllerOptions;
  private launchAdmissionClosed = false;
  private admittedLaunches = 0;
  private launchDrain: Promise<void> | undefined;
  private resolveLaunchDrain: (() => void) | undefined;

  constructor(options: RunControllerOptions) {
    this.options = options;
    this.semaphore = new RunSemaphore(options.capacity);
  }

  register(record: RunRecord): void {
    if (this.agents.has(record.agentId)) throw new CodedError(AgentErrorCode.InvalidAgent);
    if (record.state !== AgentState.Stopped) throw new CodedError(AgentErrorCode.InvalidState);
    const provenance = provenanceFrom(record);
    this.agents.set(record.agentId, {
      agentId: record.agentId,
      transcriptPath: record.transcriptPath,
      mutex: new Mutex(),
      phase: {
        kind: "stopped",
        ...(record.runId === undefined ? {} : { runId: record.runId }),
        ...(provenance === undefined ? {} : { provenance }),
      },
    });
  }

  async beginRestore(): Promise<RestoreAdmission> {
    if (this.launchAdmissionClosed) throw new CodedError(AgentErrorCode.InvalidState);
    this.launchAdmissionClosed = true;
    if (this.admittedLaunches > 0) {
      this.launchDrain = new Promise<void>((resolve) => { this.resolveLaunchDrain = resolve; });
      await this.launchDrain;
    }
    let staged: Array<{ record: RunRecord; reservation?: RunReservation }> | undefined;
    let released = false;
    return {
      reserve: (records) => {
        if (staged !== undefined) throw new CodedError(AgentErrorCode.InvalidState);
        const values = [...records];
        this.preflightRestore(values);
        const acquired: Array<{ record: RunRecord; reservation?: RunReservation }> = [];
        try {
          for (const record of values) {
            const reservation = record.state === AgentState.Stopped ? undefined : this.semaphore.acquireInherited();
            acquired.push({ record, ...(reservation === undefined ? {} : { reservation }) });
          }
          staged = acquired;
        } catch (error) {
          for (const item of acquired) item.reservation?.release();
          throw error;
        }
      },
      replace: (record) => {
        if (staged === undefined) throw new CodedError(AgentErrorCode.InvalidState);
        const index = staged.findIndex((item) => item.record.agentId === record.agentId);
        if (index < 0) throw new CodedError(AgentErrorCode.InvalidAgent);
        const previous = staged[index]!;
        let reservation = previous.reservation;
        if (previous.record.state !== AgentState.Stopped && record.state === AgentState.Stopped) {
          reservation?.release();
          reservation = undefined;
        } else if (previous.record.state === AgentState.Stopped && record.state !== AgentState.Stopped) {
          reservation = this.semaphore.acquireInherited();
        }
        staged[index] = { record, ...(reservation === undefined ? {} : { reservation }) };
      },
      commit: () => {
        if (staged === undefined) throw new CodedError(AgentErrorCode.InvalidState);
        const restored = staged.map((item): LiveRecord => ({
          agentId: item.record.agentId,
          transcriptPath: item.record.transcriptPath,
          mutex: new Mutex(),
          phase: restoredPhase(item.record, item.reservation),
        }));
        for (const record of restored) this.agents.set(record.agentId, record);
        staged = undefined;
      },
      release: () => {
        if (released) return;
        released = true;
        if (staged !== undefined) for (const item of staged) item.reservation?.release();
        staged = undefined;
        this.launchAdmissionClosed = false;
      },
    };
  }

  /** Reserves fleet capacity before child-session creation and releases it on every failure. */
  async spawnNew(operation: (
    register: (record: Pick<RunRecord, "agentId" | "transcriptPath">) => void,
    adoptIdentity: (runId: RunId, runtime: RunRuntime, beforeTerminal?: () => Promise<void>) => void,
  ) => Promise<NewLaunchOperation>): Promise<LaunchResult | LaunchFailedResult> {
    const leaveAdmission = this.enterLaunchAdmission();
    try { return await this.spawnNewOwned(operation); }
    finally { leaveAdmission(); }
  }

  private async spawnNewOwned(operation: (
    register: (record: Pick<RunRecord, "agentId" | "transcriptPath">) => void,
    adoptIdentity: (runId: RunId, runtime: RunRuntime, beforeTerminal?: () => Promise<void>) => void,
  ) => Promise<NewLaunchOperation>): Promise<LaunchResult | LaunchFailedResult> {
    const reservation = this.semaphore.tryAcquire();
    if (reservation === undefined) throw new CodedError(AgentErrorCode.CapacityExceeded);
    this.options.onReserve?.();
    let registered: LiveRecord | undefined;
    let launchPhase!: LaunchingPhase;
    const register = (record: Pick<RunRecord, "agentId" | "transcriptPath">): void => {
      if (registered !== undefined || this.agents.has(record.agentId)) throw new CodedError(AgentErrorCode.InvalidAgent);
      const phase = launchingPhase(reservation);
      launchPhase = phase;
      registered = { ...record, mutex: new Mutex(), phase };
      this.agents.set(record.agentId, registered);
    };
    const adoptIdentity = (runId: RunId, runtime: RunRuntime, beforeTerminal?: () => Promise<void>): void => {
      if (registered === undefined || launchPhase.identity !== undefined) throw new CodedError(AgentErrorCode.InvalidState);
      launchPhase.identity = { runId, runtime };
      // Operation contracts say `beforeTerminal`; the live phase names the action `beforeTerminate`.
      if (beforeTerminal === undefined) delete launchPhase.beforeTerminate;
      else launchPhase.beforeTerminate = beforeTerminal;
    };
    try {
      const launched = await operation(register, adoptIdentity);
      const launchRecord = registered;
      if (launchRecord === undefined) throw new Error("invalid_state: new launch was not registered");
      if (launchPhase.identity !== undefined && launched.status !== "accepted" && launched.status !== "identity_failed") {
        let owner!: TerminalOwner;
        await launchRecord.mutex.runExclusive(() => {
          owner = this.settleLaunchFailureLocked(launchRecord, launchPhase);
        });
        this.continueNaturalTerminal(owner);
        return { status: "settling", agentId: launchRecord.agentId, runId: launchPhase.identity.runId };
      }
      if (launched.status === "failed") {
        this.finishPreIdentityLaunch(launchRecord, launchPhase, { releaseReservation: true });
        return { status: "failed", agentId: launched.agentId };
      }
      if (launched.status === "containment_failed") {
        launchRecord.phase = {
          kind: "preRunContainment",
          reservation,
          runtime: launched.runtime,
          ...(launchPhase.provenance === undefined ? {} : { provenance: launchPhase.provenance }),
        };
        this.finishPreIdentityLaunch(launchRecord, launchPhase, { releaseReservation: false });
        return { status: "containment_failed", agentId: launched.agentId };
      }
      if (launched.status === "identity_failed") {
        if (launchPhase.identity === undefined) throw new CodedError(AgentErrorCode.InvalidState);
        let owner!: TerminalOwner;
        await launchRecord.mutex.runExclusive(() => {
          launchPhase.beforeTerminate = launched.beforeTerminal;
          owner = this.settleLaunchFailureLocked(launchRecord, launchPhase);
        });
        this.continueNaturalTerminal(owner);
        return { status: "settling", agentId: launched.agentId, runId: launched.runId };
      }
      // `adoptIdentity` is the native-ID linearisation point and must precede every
      // binding, persistence and callback-subscription seam.
      if (launchPhase.identity === undefined) adoptIdentity(launched.runId, launched.runtime);
      if (launchPhase.identity?.runId !== launched.runId || launchPhase.identity.runtime !== launched.runtime) throw new CodedError(AgentErrorCode.InvalidState);
      const accepted = { status: "running" as const, agentId: launched.agentId, runId: launched.runId };
      try {
        launched.onAccepted?.();
        await launchRecord.mutex.runExclusive(() => { this.finishLaunch(launchRecord, launchPhase, true); });
        return accepted;
      }
      catch {
        let owner!: TerminalOwner;
        await launchRecord.mutex.runExclusive(() => {
          owner = this.settleLaunchFailureLocked(launchRecord, launchPhase);
        });
        this.continueNaturalTerminal(owner);
        return { status: "settling", agentId: launched.agentId, runId: launched.runId };
      }
    } catch (error) {
      const registeredRecord = registered;
      if (registeredRecord !== undefined && launchPhase.identity !== undefined) {
        let owner!: TerminalOwner;
        await registeredRecord.mutex.runExclusive(() => {
          owner = this.settleLaunchFailureLocked(registeredRecord, launchPhase);
        });
        this.continueNaturalTerminal(owner);
        return { status: "settling", agentId: registeredRecord.agentId, runId: launchPhase.identity.runId };
      }
      if (registered !== undefined) {
        this.agents.delete(registered.agentId);
        this.finishPreIdentityLaunch(registered, launchPhase, { releaseReservation: false });
      }
      reservation.release();
      throw error;
    }
  }

  preflightRestore(records: Iterable<RunRecord>): void {
    const restoredIds = new Set<AgentId>();
    for (const record of records) {
      if (this.agents.has(record.agentId) || restoredIds.has(record.agentId)) throw new CodedError(AgentErrorCode.InvalidAgent);
      restoredIds.add(record.agentId);
    }
  }

  async launch(agentId: AgentId, operation: (adoptIdentity: (runId: RunId, runtime: RunRuntime, beforeTerminal?: () => Promise<void>) => void) => Promise<ExistingLaunchOperation>): Promise<LaunchResult | LaunchFailedResult> {
    const leaveAdmission = this.enterLaunchAdmission();
    try { return await this.launchOwned(agentId, operation); }
    finally { leaveAdmission(); }
  }

  private async launchOwned(agentId: AgentId, operation: (adoptIdentity: (runId: RunId, runtime: RunRuntime, beforeTerminal?: () => Promise<void>) => void) => Promise<ExistingLaunchOperation>): Promise<LaunchResult | LaunchFailedResult> {
    const record = this.require(agentId);
    // Reservation is a synchronous linearisation point. No external work or promise wait
    // occurs here, so a following stop must join this launch rather than observe Stopped.
    const phase = record.phase;
    if (phase.kind !== "stopped") throw new CodedError(AgentErrorCode.InvalidState);
    const reservation = this.semaphore.tryAcquire();
    if (reservation === undefined) throw new CodedError(AgentErrorCode.CapacityExceeded);
    const launchPhase = launchingPhase(reservation, phase.provenance);
    record.phase = launchPhase;
    let launched: ExistingLaunchOperation;
    const adoptIdentity = (runId: RunId, runtime: RunRuntime, beforeTerminal?: () => Promise<void>): void => {
      const phase = record.phase;
      if (phase.kind !== "launching" || phase.identity !== undefined) throw new CodedError(AgentErrorCode.InvalidState);
      launchPhase.identity = { runId, runtime };
      if (beforeTerminal === undefined) delete launchPhase.beforeTerminate;
      else launchPhase.beforeTerminate = beforeTerminal;
    };
    try { launched = await operation(adoptIdentity); }
    catch (error) {
      if (launchPhase.identity !== undefined) {
        let owner!: TerminalOwner;
        await record.mutex.runExclusive(() => {
          owner = this.settleLaunchFailureLocked(record, launchPhase);
        });
        this.continueNaturalTerminal(owner);
        return { status: "settling", agentId, runId: launchPhase.identity.runId };
      }
      await record.mutex.runExclusive(() => {
        this.finishPreIdentityLaunch(record, launchPhase, { releaseReservation: true });
      });
      throw error;
    }
    const result = await record.mutex.runExclusive(() => {
      if (launchPhase.identity !== undefined && launched.status !== "accepted" && launched.status !== "identity_failed") {
        return { status: "identity_failed" as const, owner: this.settleLaunchFailureLocked(record, launchPhase), runId: launchPhase.identity.runId };
      }
      if (launched.status === "failed") {
        this.finishPreIdentityLaunch(record, launchPhase, { releaseReservation: true });
        return { status: "failed" as const, agentId };
      }
      if (launched.status === "containment_failed") {
        record.phase = {
          kind: "preRunContainment",
          reservation,
          runtime: launched.runtime,
          ...(launchPhase.provenance === undefined ? {} : { provenance: launchPhase.provenance }),
        };
        this.finishPreIdentityLaunch(record, launchPhase, { releaseReservation: false });
        return { status: "containment_failed" as const, agentId };
      }
      if (launched.status === "identity_failed") {
        if (launchPhase.identity === undefined) throw new CodedError(AgentErrorCode.InvalidState);
        launchPhase.beforeTerminate = launched.beforeTerminal;
        return { status: "identity_failed" as const, owner: this.settleLaunchFailureLocked(record, launchPhase), runId: launchPhase.identity.runId };
      }
      // Direct RunController clients may return acceptance atomically; controller launch
      // transactions use `adoptIdentity` earlier at native-ID observation.
      if (launchPhase.identity === undefined) adoptIdentity(launched.runId, launched.runtime);
      if (launchPhase.identity?.runId !== launched.runId || launchPhase.identity.runtime !== launched.runtime) throw new CodedError(AgentErrorCode.InvalidState);
      const accepted = { status: "running" as const, agentId, runId: launched.runId };
      return { status: "accepted" as const, accepted, onAccepted: launched.onAccepted };
    });
    if (result.status === "failed" || result.status === "containment_failed") return result;
    if (result.status === "identity_failed") {
      this.continueNaturalTerminal(result.owner);
      return { status: "settling", agentId, runId: result.runId };
    }
    try {
      result.onAccepted?.();
      await record.mutex.runExclusive(() => { this.finishLaunch(record, launchPhase, true); });
      return result.accepted;
    }
    catch {
      let owner!: TerminalOwner;
      await record.mutex.runExclusive(() => {
        owner = this.settleLaunchFailureLocked(record, launchPhase);
      });
      this.continueNaturalTerminal(owner);
      return { status: "settling", agentId, runId: result.accepted.runId };
    }
  }

  private enterLaunchAdmission(): () => void {
    if (this.launchAdmissionClosed) throw new CodedError(AgentErrorCode.InvalidState);
    this.admittedLaunches++;
    let left = false;
    return () => {
      if (left) return;
      left = true;
      this.admittedLaunches--;
      if (this.launchAdmissionClosed && this.admittedLaunches === 0) {
        this.resolveLaunchDrain?.();
        this.resolveLaunchDrain = undefined;
        this.launchDrain = undefined;
      }
    };
  }

  async settle(agentId: AgentId, expectedRunId: RunId, settlement: Settlement): Promise<StopResult> {
    return this.terminate(agentId, AgentState.Settling, settlement, false, undefined, expectedRunId);
  }

  async stop(agentId: AgentId, reason: CancellationReason): Promise<StopResult> {
    const record = this.require(agentId);
    const phase = record.phase;
    if (phase.kind === "launching") {
      phase.stopRequested ??= reason;
      await phase.done;
      const settled = record.phase;
      const effectiveReason = (settled.kind === "launching" || settled.kind === "running")
        ? settled.stopRequested ?? reason
        : reason;
      if (settled.kind === "launching" || settled.kind === "running") delete settled.stopRequested;
      return this.stop(agentId, effectiveReason);
    }
    if (phase.kind === "preRunContainment") return this.finishPreRunContainment(record);
    if (phase.kind === "terminating" && phase.terminalState === AgentState.Settling) {
      const result = await this.terminate(agentId, AgentState.Settling, phase.outcome ?? { kind: "failed", cause: terminalFailureCause(AgentErrorCode.RunInterrupted) }, false);
      return result.status === "stopped" ? { status: "already_stopped", agentId } : result;
    }
    return this.terminate(agentId, AgentState.Stopping, { kind: "cancelled", reason }, true, reason);
  }

  snapshot(agentId: AgentId): RunRecord | undefined {
    const r = this.agents.get(agentId);
    return r === undefined ? undefined : toSnapshot(r);
  }

  snapshots(): RunRecord[] { return [...this.agents.keys()].map((id) => this.snapshot(id)!); }
  activeCount(): number { return this.semaphore.activeCount; }

  private async terminate(agentId: AgentId, transition: typeof AgentState.Settling | typeof AgentState.Stopping, settlement: Settlement, abort: boolean, reason?: CancellationReason, expectedRunId?: RunId): Promise<StopResult> {
    const record = this.require(agentId);
    let owner: TerminalOwner | undefined;
    let existing: Promise<StopResult> | undefined;
    await record.mutex.runExclusive(async () => {
      const phase = record.phase;
      if (expectedRunId !== undefined && runIdOf(phase) !== expectedRunId) return;
      if (agentStateOf(phase) === AgentState.Stopped) return;
      const inFlight = phase.kind === "terminating" || phase.kind === "preRunContainment" ? phase.completion : undefined;
      if (inFlight !== undefined) { existing = inFlight; return; }
      const state = agentStateOf(phase);
      if (state !== AgentState.Running && state !== transition) throw new CodedError(AgentErrorCode.InvalidState);
      owner = this.claimTerminalLocked(record, transition, settlement, abort, reason);
    });
    if (existing !== undefined) {
      const result = await existing;
      return result.status === "containment_failed" ? result : { status: "already_stopped", agentId };
    }
    if (owner === undefined) return { status: "already_stopped", agentId };
    return this.finishTerminalOwner(owner);
  }

  private claimTerminalLocked(
    record: LiveRecord,
    transition: typeof AgentState.Settling | typeof AgentState.Stopping,
    settlement: Settlement,
    abort = false,
    reason?: CancellationReason,
  ): TerminalOwner {
    const prev = record.phase;
    if (prev.kind === "stopped") throw new CodedError(AgentErrorCode.InvalidState);
    const phase = terminatingPhase(prev, transition, settlement);
    record.phase = phase;
    let resolve!: (value: StopResult) => void;
    phase.completion = new Promise<StopResult>((done) => { resolve = done; });
    return { record, phase, settlement, abort, ...(reason === undefined ? {} : { reason }), resolve };
  }

  private settleLaunchFailureLocked(record: LiveRecord, launching: LaunchingPhase): TerminalOwner {
    const owner = this.claimTerminalLocked(
      record,
      AgentState.Settling,
      { kind: "failed", cause: terminalFailureCause(AgentErrorCode.SpawnFailed) },
    );
    this.finishLaunch(record, launching);
    return owner;
  }

  private finishPreIdentityLaunch(
    record: LiveRecord,
    launching: LaunchingPhase,
    options: { releaseReservation: boolean },
  ): void {
    if (options.releaseReservation) launching.reservation.release();
    this.finishLaunch(record, launching);
  }

  private finishLaunch(record: LiveRecord, launching: LaunchingPhase, preserveStopRequested = false): void {
    const phase = record.phase;
    if (phase === launching) {
      record.phase = launching.identity === undefined
        ? { kind: "stopped", ...(launching.provenance === undefined ? {} : { provenance: launching.provenance }) }
        : runningPhase(launching, launching.identity, preserveStopRequested);
    }
    launching.resolveDone();
  }

  private continueNaturalTerminal(owner: TerminalOwner): void {
    void this.finishTerminalOwner(owner).catch(() => undefined);
  }

  private async finishTerminalOwner(owner: TerminalOwner): Promise<StopResult> {
    const { record, settlement, abort, reason, resolve } = owner;
    const agentId = record.agentId;
    const runtime = owner.phase.runtime;
    try {
      if (abort) await this.options.onStopping?.(toCallbackRecord(record), reason ?? CancellationReason.StopRequested);
      if (abort) {
        try { void runtime?.abort().catch(() => undefined); }
        catch { /* Abort is best-effort; containment remains authoritative. */ }
      }
      if (runtime === undefined) throw new Error("missing containment responsibility");
      if (owner.phase.contained !== true) {
        await runtime.contain();
        owner.phase.contained = true;
      }
    } catch {
      return this.retainTerminal(owner, AgentErrorCode.ContainmentFailed);
    }
    try {
      await owner.phase.beforeTerminate?.();
      const reconciledRunId = await this.options.onTerminal?.(toCallbackRecord(record), owner.phase.outcome ?? settlement);
      if (owner.phase.runId === undefined && reconciledRunId !== undefined) owner.phase.runId = reconciledRunId;
    } catch {
      // Containment is proven at this point: the child is dead, only its terminal record is missing.
      return this.retainTerminal(owner, AgentErrorCode.TerminalPersistenceFailed);
    }
    await record.mutex.runExclusive(() => {
      owner.phase.reservation.release();
      record.phase = stoppedFromTerminating(owner.phase);
      this.options.onRelease?.(agentId);
    });
    const phase = record.phase;
    const runId = runIdOf(phase);
    if (runId === undefined) throw new Error("invalid_state: accepted run has no native identity");
    const result = { status: "stopped" as const, agentId, runId };
    resolve(result);
    return result;
  }

  /** Retains state, capacity and watchdog responsibility, and leaves the terminal retryable. */
  private async retainTerminal(owner: TerminalOwner, code: RetainedTerminalCode): Promise<StopResult> {
    const { record, phase, resolve } = owner;
    const failed = {
      status: "containment_failed" as const,
      agentId: record.agentId,
      ...(phase.runId === undefined ? {} : { runId: phase.runId }),
      agentState: phase.terminalState,
      code,
    };
    resolve(failed);
    await record.mutex.runExclusive(() => { delete phase.completion; });
    return failed;
  }

  private async finishPreRunContainment(record: LiveRecord): Promise<StopResult> {
    let phase: Extract<Phase, { kind: "preRunContainment" }> | undefined;
    let existing: Promise<StopResult> | undefined;
    let resolve!: (result: StopResult) => void;
    const operation = new Promise<StopResult>((done) => { resolve = done; });
    await record.mutex.runExclusive(() => {
      const current = record.phase;
      if (current.kind !== "preRunContainment") return;
      if (current.completion !== undefined) { existing = current.completion; return; }
      current.completion = operation;
      phase = current;
    });
    if (existing !== undefined) return existing;
    if (phase === undefined) return { status: "already_stopped", agentId: record.agentId };
    const activePhase = phase;
    try { await activePhase.runtime.contain(); }
    catch {
      const failed = { status: "containment_failed" as const, agentId: record.agentId, agentState: AgentState.Stopping, code: AgentErrorCode.ContainmentFailed };
      resolve(failed);
      await record.mutex.runExclusive(() => { delete activePhase.completion; });
      return failed;
    }
    if (activePhase.provenance?.restoredTerminalObligation === true) {
      try {
        const reconciledRunId = await this.options.onTerminal?.(toCallbackRecord(record), {
          kind: "failed",
          cause: terminalFailureCause(AgentErrorCode.RunInterrupted),
        });
        if (reconciledRunId !== undefined) activePhase.runId = reconciledRunId;
      } catch {
        const failed = { status: "containment_failed" as const, agentId: record.agentId, agentState: AgentState.Stopping, code: AgentErrorCode.TerminalPersistenceFailed };
        resolve(failed);
        await record.mutex.runExclusive(() => { delete activePhase.completion; });
        return failed;
      }
    }
    await record.mutex.runExclusive(() => {
      activePhase.reservation.release();
      record.phase = { kind: "stopped", ...(activePhase.runId === undefined ? {} : { runId: activePhase.runId }) };
      this.options.onRelease?.(record.agentId);
    });
    const result = { status: "already_stopped" as const, agentId: record.agentId };
    resolve(result);
    return result;
  }

  private require(agentId: AgentId): LiveRecord {
    const record = this.agents.get(agentId);
    if (record === undefined) throw new CodedError(AgentErrorCode.InvalidAgent);
    return record;
  }
}

function provenanceFrom(record: RunRecord): RestoredProvenance | undefined {
  if (record.containmentResponsibility === undefined && record.restoredTerminalObligation === undefined) return undefined;
  return {
    ...(record.containmentResponsibility === undefined ? {} : { containmentResponsibility: record.containmentResponsibility }),
    ...(record.restoredTerminalObligation === undefined ? {} : { restoredTerminalObligation: record.restoredTerminalObligation }),
  };
}

function restoredPhase(record: RunRecord, reservation: RunReservation | undefined): Phase {
  const provenance = provenanceFrom(record);
  if (record.state === AgentState.Stopped) {
    return { kind: "stopped", ...(record.runId === undefined ? {} : { runId: record.runId }), ...(provenance === undefined ? {} : { provenance }) };
  }
  if (reservation === undefined) throw new CodedError(AgentErrorCode.InvalidState);
  if (record.containmentResponsibility !== undefined && record.runId === undefined) {
    if (record.state !== AgentState.Stopping || record.runtime === undefined) throw new CodedError(AgentErrorCode.InvalidState);
    return { kind: "preRunContainment", reservation, runtime: record.runtime, ...(provenance === undefined ? {} : { provenance }) };
  }
  if (record.runId === undefined) throw new CodedError(AgentErrorCode.InvalidState);
  if (record.state === AgentState.Running) {
    if (record.runId === undefined || record.runtime === undefined) throw new CodedError(AgentErrorCode.InvalidState);
    return { kind: "running", reservation, identity: { runId: record.runId, runtime: record.runtime }, ...(provenance === undefined ? {} : { provenance }) };
  }
  return {
    kind: "terminating", reservation, terminalState: record.state, contained: false,
    ...(record.runtime === undefined ? {} : { runtime: record.runtime }),
    ...(record.runId === undefined ? {} : { runId: record.runId }),
    ...(provenance === undefined ? {} : { provenance }),
  };
}

