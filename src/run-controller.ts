import { Mutex, RunSemaphore, type RunReservation } from "./async-primitives.ts";
import {
  AgentErrorCode,
  AgentState,
  CancellationReason,
  CodedError,
  terminalFailureCause,
  type AgentId,
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

interface LiveRecord extends RunRecord {
  mutex: Mutex;
  launching?: boolean;
  launchDone?: Promise<void>;
  resolveLaunchDone?: () => void;
  stopAfterLaunch?: CancellationReason;
  runtime?: RunRuntime;
  reservation?: RunReservation;
  terminal?: Promise<StopResult>;
  terminalCandidate?: Settlement;
  terminalContained?: boolean;
  preRunContainment?: boolean;
  beforeTerminal?: () => Promise<void>;
}

interface TerminalOwner {
  record: LiveRecord;
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
  capacity: number;
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
    this.agents.set(record.agentId, { ...record, mutex: new Mutex() });
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
        for (const item of staged) {
          const live: LiveRecord = { ...item.record, mutex: new Mutex(), ...(item.reservation === undefined ? {} : { reservation: item.reservation }) };
          if (item.record.containmentResponsibility !== undefined && item.record.runId === undefined) live.preRunContainment = true;
          this.agents.set(item.record.agentId, live);
        }
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
    const register = (record: Pick<RunRecord, "agentId" | "transcriptPath">): void => {
      if (registered !== undefined || this.agents.has(record.agentId)) throw new CodedError(AgentErrorCode.InvalidAgent);
      let resolveLaunchDone!: () => void;
      const launchDone = new Promise<void>((resolve) => { resolveLaunchDone = resolve; });
      registered = { ...record, state: AgentState.Stopped, mutex: new Mutex(), launching: true, launchDone, resolveLaunchDone, reservation };
      this.agents.set(record.agentId, registered);
    };
    const adoptIdentity = (runId: RunId, runtime: RunRuntime, beforeTerminal?: () => Promise<void>): void => {
      if (registered === undefined || registered.runId !== undefined) throw new CodedError(AgentErrorCode.InvalidState);
      registered.runId = runId;
      registered.runtime = runtime;
      registered.state = AgentState.Running;
      if (beforeTerminal === undefined) delete registered.beforeTerminal;
      else registered.beforeTerminal = beforeTerminal;
    };
    try {
      const launched = await operation(register, adoptIdentity);
      const launchRecord = registered;
      if (launchRecord === undefined) throw new Error("invalid_state: new launch was not registered");
      if (launchRecord.runId !== undefined && launched.status !== "accepted" && launched.status !== "identity_failed") {
        let owner!: TerminalOwner;
        await launchRecord.mutex.runExclusive(() => {
          owner = this.settleLaunchFailureLocked(launchRecord);
        });
        this.continueNaturalTerminal(owner);
        return { status: "settling", agentId: launchRecord.agentId, runId: launchRecord.runId };
      }
      if (launched.status === "failed") {
        this.finishPreIdentityLaunch(launchRecord, { releaseReservation: true });
        return { status: "failed", agentId: launched.agentId };
      }
      if (launched.status === "containment_failed") {
        launchRecord.state = AgentState.Stopping;
        launchRecord.runtime = launched.runtime;
        launchRecord.preRunContainment = true;
        this.finishPreIdentityLaunch(launchRecord, { releaseReservation: false });
        return { status: "containment_failed", agentId: launched.agentId };
      }
      if (launched.status === "identity_failed") {
        let owner!: TerminalOwner;
        await launchRecord.mutex.runExclusive(() => {
          launchRecord.beforeTerminal = launched.beforeTerminal;
          owner = this.settleLaunchFailureLocked(launchRecord);
        });
        this.continueNaturalTerminal(owner);
        return { status: "settling", agentId: launched.agentId, runId: launched.runId };
      }
      // `adoptIdentity` is the native-ID linearisation point and must precede every
      // binding, persistence and callback-subscription seam.
      if (launchRecord.state === AgentState.Stopped) adoptIdentity(launched.runId, launched.runtime);
      if (launchRecord.runId !== launched.runId || launchRecord.runtime !== launched.runtime) throw new CodedError(AgentErrorCode.InvalidState);
      const accepted = { status: "running" as const, agentId: launched.agentId, runId: launched.runId };
      try {
        launched.onAccepted?.();
        await launchRecord.mutex.runExclusive(() => { this.finishLaunch(launchRecord, true); });
        return accepted;
      }
      catch {
        let owner!: TerminalOwner;
        await launchRecord.mutex.runExclusive(() => {
          owner = this.settleLaunchFailureLocked(launchRecord);
        });
        this.continueNaturalTerminal(owner);
        return { status: "settling", agentId: launched.agentId, runId: launched.runId };
      }
    } catch (error) {
      if (registered?.runId !== undefined) {
        let owner!: TerminalOwner;
        await registered.mutex.runExclusive(() => {
          owner = this.settleLaunchFailureLocked(registered!);
        });
        this.continueNaturalTerminal(owner);
        return { status: "settling", agentId: registered.agentId, runId: registered.runId };
      }
      if (registered !== undefined) {
        this.agents.delete(registered.agentId);
        registered.state = AgentState.Stopped;
        delete registered.reservation;
        this.finishPreIdentityLaunch(registered, { releaseReservation: false });
      }
      reservation.release();
      throw error;
    }
  }

  restore(records: Iterable<RunRecord>): void {
    const restored = [...records];
    this.preflightRestore(restored);

    const inserted: LiveRecord[] = [];
    try {
      for (const record of restored) {
        const live: LiveRecord = { ...record, mutex: new Mutex() };
        if (record.containmentResponsibility !== undefined && record.runId === undefined) live.preRunContainment = true;
        if (record.state !== AgentState.Stopped) live.reservation = this.semaphore.acquireInherited();
        this.agents.set(record.agentId, live);
        inserted.push(live);
      }
    } catch (error) {
      for (const live of inserted) {
        this.agents.delete(live.agentId);
        live.reservation?.release();
      }
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
    if (record.state !== AgentState.Stopped || record.launching === true) throw new CodedError(AgentErrorCode.InvalidState);
    const reservation = this.semaphore.tryAcquire();
    if (reservation === undefined) throw new CodedError(AgentErrorCode.CapacityExceeded);
    record.reservation = reservation;
    record.launching = true;
    record.launchDone = new Promise<void>((resolve) => { record.resolveLaunchDone = resolve; });
    let launched: ExistingLaunchOperation;
    const adoptIdentity = (runId: RunId, runtime: RunRuntime, beforeTerminal?: () => Promise<void>): void => {
      if (record.state !== AgentState.Stopped || record.runId !== undefined && record.launching !== true) throw new CodedError(AgentErrorCode.InvalidState);
      record.runId = runId;
      record.runtime = runtime;
      record.state = AgentState.Running;
      if (beforeTerminal === undefined) delete record.beforeTerminal;
      else record.beforeTerminal = beforeTerminal;
    };
    try { launched = await operation(adoptIdentity); }
    catch (error) {
      if (record.runId !== undefined) {
        let owner!: TerminalOwner;
        await record.mutex.runExclusive(() => {
          owner = this.settleLaunchFailureLocked(record);
        });
        this.continueNaturalTerminal(owner);
        return { status: "settling", agentId, runId: record.runId };
      }
      await record.mutex.runExclusive(() => {
        this.finishPreIdentityLaunch(record, { releaseReservation: true });
      });
      throw error;
    }
    const result = await record.mutex.runExclusive(() => {
      if (record.runId !== undefined && launched.status !== "accepted" && launched.status !== "identity_failed") {
        return { status: "identity_failed" as const, owner: this.settleLaunchFailureLocked(record) };
      }
      if (launched.status === "failed") {
        this.finishPreIdentityLaunch(record, { releaseReservation: true });
        return { status: "failed" as const, agentId };
      }
      if (launched.status === "containment_failed") {
        record.runtime = launched.runtime;
        record.state = AgentState.Stopping;
        record.preRunContainment = true;
        this.finishPreIdentityLaunch(record, { releaseReservation: false });
        return { status: "containment_failed" as const, agentId };
      }
      if (launched.status === "identity_failed") {
        record.beforeTerminal = launched.beforeTerminal;
        return { status: "identity_failed" as const, owner: this.settleLaunchFailureLocked(record) };
      }
      // Direct RunController clients may return acceptance atomically; controller launch
      // transactions use `adoptIdentity` earlier at native-ID observation.
      if (record.state === AgentState.Stopped) adoptIdentity(launched.runId, launched.runtime);
      if (record.runId !== launched.runId || record.runtime !== launched.runtime || record.state !== AgentState.Running) throw new CodedError(AgentErrorCode.InvalidState);
      const accepted = { status: "running" as const, agentId, runId: launched.runId };
      return { status: "accepted" as const, accepted, onAccepted: launched.onAccepted };
    });
    if (result.status === "failed" || result.status === "containment_failed") return result;
    if (result.status === "identity_failed") {
      this.continueNaturalTerminal(result.owner);
      return { status: "settling", agentId, runId: record.runId! };
    }
    try {
      result.onAccepted?.();
      await record.mutex.runExclusive(() => { this.finishLaunch(record, true); });
      return result.accepted;
    }
    catch {
      let owner!: TerminalOwner;
      await record.mutex.runExclusive(() => {
        owner = this.settleLaunchFailureLocked(record);
      });
      this.continueNaturalTerminal(owner);
      return { status: "settling", agentId, runId: record.runId! };
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
    return this.terminalise(agentId, AgentState.Settling, settlement, false, undefined, expectedRunId);
  }

  async stop(agentId: AgentId, reason: CancellationReason): Promise<StopResult> {
    const record = this.require(agentId);
    let launchDone: Promise<void> | undefined;
    if (record.launching === true) {
      record.stopAfterLaunch ??= reason;
      launchDone = record.launchDone;
    }
    if (launchDone !== undefined) {
      await launchDone;
      const effectiveReason = record.stopAfterLaunch ?? reason;
      delete record.stopAfterLaunch;
      return this.stop(agentId, effectiveReason);
    }
    if (record.preRunContainment === true) return this.finishPreRunContainment(record);
    if (record.state === AgentState.Settling) {
      const result = await this.terminalise(agentId, AgentState.Settling, record.terminalCandidate ?? { kind: "failed", cause: terminalFailureCause(AgentErrorCode.RunInterrupted) }, false);
      return result.status === "stopped" ? { status: "already_stopped", agentId } : result;
    }
    return this.terminalise(agentId, AgentState.Stopping, { kind: "cancelled", reason }, true, reason);
  }

  snapshot(agentId: AgentId): RunRecord | undefined {
    const r = this.agents.get(agentId);
    return r === undefined ? undefined : {
      agentId: r.agentId,
      state: r.state,
      transcriptPath: r.transcriptPath,
      ...(r.runId ? { runId: r.runId } : {}),
      ...(r.containmentResponsibility === undefined ? {} : { containmentResponsibility: r.containmentResponsibility }),
    };
  }

  snapshots(): RunRecord[] { return [...this.agents.keys()].map((id) => this.snapshot(id)!); }
  activeCount(): number { return this.semaphore.activeCount; }

  private async terminalise(agentId: AgentId, transition: typeof AgentState.Settling | typeof AgentState.Stopping, settlement: Settlement, abort: boolean, reason?: CancellationReason, expectedRunId?: RunId): Promise<StopResult> {
    const record = this.require(agentId);
    let owner: TerminalOwner | undefined;
    let existing: Promise<StopResult> | undefined;
    await record.mutex.runExclusive(async () => {
      if (expectedRunId !== undefined && record.runId !== expectedRunId) return;
      if (record.state === AgentState.Stopped) return;
      if (record.terminal !== undefined) { existing = record.terminal; return; }
      if (record.state !== AgentState.Running && !(record.state === transition && record.terminal === undefined)) throw new CodedError(AgentErrorCode.InvalidState);
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
    if (record.state === AgentState.Running) record.state = transition;
    if (record.terminalCandidate === undefined) record.terminalCandidate = settlement;
    let resolve!: (value: StopResult) => void;
    record.terminal = new Promise<StopResult>((done) => { resolve = done; });
    return { record, settlement, abort, ...(reason === undefined ? {} : { reason }), resolve };
  }

  private settleLaunchFailureLocked(record: LiveRecord): TerminalOwner {
    const owner = this.claimTerminalLocked(
      record,
      AgentState.Settling,
      { kind: "failed", cause: terminalFailureCause(AgentErrorCode.SpawnFailed) },
    );
    this.finishLaunch(record);
    return owner;
  }

  private finishPreIdentityLaunch(
    record: LiveRecord,
    options: { releaseReservation: boolean },
  ): void {
    if (options.releaseReservation) {
      record.reservation?.release();
      delete record.reservation;
    }
    this.finishLaunch(record);
  }

  private finishLaunch(record: LiveRecord, preserveStopAfterLaunch = false): void {
    delete record.launching;
    record.resolveLaunchDone?.();
    delete record.resolveLaunchDone;
    delete record.launchDone;
    if (!preserveStopAfterLaunch) delete record.stopAfterLaunch;
  }

  private continueNaturalTerminal(owner: TerminalOwner): void {
    void this.finishTerminalOwner(owner).catch(() => undefined);
  }

  private async finishTerminalOwner(owner: TerminalOwner): Promise<StopResult> {
    const { record, settlement, abort, reason, resolve } = owner;
    const agentId = record.agentId;
    const runtime = record.runtime;
    try {
      if (abort) await this.options.onStopping?.(record, reason ?? CancellationReason.StopRequested);
      if (abort) {
        try { void runtime?.abort().catch(() => undefined); }
        catch { /* Abort is best-effort; containment remains authoritative. */ }
      }
      if (runtime === undefined) throw new Error("missing containment responsibility");
      if (record.terminalContained !== true) {
        await runtime.contain();
        record.terminalContained = true;
      }
    } catch {
      return this.retainTerminal(owner, AgentErrorCode.ContainmentFailed);
    }
    try {
      await record.beforeTerminal?.();
      const reconciledRunId = await this.options.onTerminal?.(record, record.terminalCandidate ?? settlement);
      if (record.runId === undefined && reconciledRunId !== undefined) record.runId = reconciledRunId;
    } catch {
      // Containment is proven at this point: the child is dead, only its terminal record is missing.
      return this.retainTerminal(owner, AgentErrorCode.TerminalPersistenceFailed);
    }
    await record.mutex.runExclusive(() => {
      record.state = AgentState.Stopped;
      delete record.runtime;
      delete record.terminalCandidate;
      delete record.terminalContained;
      delete record.terminal;
      delete record.beforeTerminal;
      record.reservation?.release();
      delete record.reservation;
      this.options.onRelease?.(agentId);
    });
    const runId = record.runId;
    if (runId === undefined) throw new Error("invalid_state: accepted run has no native identity");
    const result = { status: "stopped" as const, agentId, runId };
    resolve(result);
    return result;
  }

  /** Retains state, capacity and watchdog responsibility, and leaves the terminal retryable. */
  private async retainTerminal(owner: TerminalOwner, code: RetainedTerminalCode): Promise<StopResult> {
    const { record, resolve } = owner;
    const failed = {
      status: "containment_failed" as const, agentId: record.agentId,
      ...(record.runId === undefined ? {} : { runId: record.runId }),
      agentState: record.state as typeof AgentState.Settling | typeof AgentState.Stopping,
      code,
    };
    resolve(failed);
    await record.mutex.runExclusive(() => { delete record.terminal; });
    return failed;
  }

  private async finishPreRunContainment(record: LiveRecord): Promise<StopResult> {
    let owner = false;
    let existing: Promise<StopResult> | undefined;
    let resolve!: (result: StopResult) => void;
    const operation = new Promise<StopResult>((done) => { resolve = done; });
    await record.mutex.runExclusive(() => {
      if (record.state === AgentState.Stopped) return;
      if (record.terminal !== undefined) { existing = record.terminal; return; }
      record.terminal = operation;
      owner = true;
    });
    if (existing !== undefined) return existing;
    if (!owner) return { status: "already_stopped", agentId: record.agentId };
    try { await record.runtime?.contain(); }
    catch {
      const failed = { status: "containment_failed" as const, agentId: record.agentId, agentState: AgentState.Stopping, code: AgentErrorCode.ContainmentFailed };
      resolve(failed);
      await record.mutex.runExclusive(() => { delete record.terminal; });
      return failed;
    }
    if (record.restoredTerminalObligation === true) {
      try {
        const reconciledRunId = await this.options.onTerminal?.(record, {
          kind: "failed",
          cause: terminalFailureCause(AgentErrorCode.RunInterrupted),
        });
        if (reconciledRunId !== undefined) record.runId = reconciledRunId;
      } catch {
        const failed = { status: "containment_failed" as const, agentId: record.agentId, agentState: AgentState.Stopping, code: AgentErrorCode.TerminalPersistenceFailed };
        resolve(failed);
        await record.mutex.runExclusive(() => { delete record.terminal; });
        return failed;
      }
    }
    await record.mutex.runExclusive(() => {
      record.state = AgentState.Stopped;
      delete record.runtime;
      delete record.preRunContainment;
      delete record.containmentResponsibility;
      delete record.restoredTerminalObligation;
      delete record.terminal;
      record.reservation?.release();
      delete record.reservation;
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

