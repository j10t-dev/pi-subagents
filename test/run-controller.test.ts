import { describe, expect, test } from "bun:test";
import { Mutex, RunSemaphore } from "../src/async-primitives.ts";
import { AgentErrorCode, AgentState, CancellationReason, CodedError, runCapacity, terminalFailureCause, type RunId } from "../src/domain.ts";
import {
  agentStateOf,
  classifyTerminal,
  toCallbackRecord,
  toSnapshot,
  type LaunchFailedResult,
  type LaunchResult,
  type Phase,
  type RunRecord,
  type RunRuntime,
  type StopResult,
} from "../src/run-controller.ts";
import { testBarrier } from "./support/barriers.ts";
import { testAgentId, testRunId, testSessionPath, testVerifiedReceiptPath } from "./support/brands.ts";
import { deferred } from "./support/async.ts";
import { registerStopped, restoreRuns, testRunController } from "./support/controllers.ts";
import { testRuntime } from "./support/launches.ts";

type AdoptIdentity = (runId: RunId, runtime: RunRuntime, beforeTerminal?: () => Promise<void>) => void;

const testReservation = new RunSemaphore(runCapacity(1)).tryAcquire()!;
const testIdentity = { runId: testRunId("deadbeef"), runtime: testRuntime() };
const stopResult: StopResult = { status: "already_stopped", agentId: testAgentId() };
const testTerminatingPhase: Extract<Phase, { kind: "terminating" }> = { kind: "terminating", reservation: testReservation, terminalState: AgentState.Stopping, contained: false };
// @ts-expect-error a running phase requires identity
const _badRunning: Phase = { kind: "running", reservation: testReservation };
// @ts-expect-error completion is not representable on a running phase
const _badCompletion: Phase = { kind: "running", reservation: testReservation, identity: testIdentity, completion: Promise.resolve(stopResult) };
// @ts-expect-error terminating.runtime is optional and cannot satisfy a required RunRuntime
const _rt: RunRuntime = testTerminatingPhase.runtime;

/** Each row forces one post-native-identity failure seam against one waiting contender. */
const postNativeFailureCases = [
  { operation: "send", failure: "launch-body", contender: "stop" },
  { operation: "send", failure: "launch-body", contender: "shutdown" },
  { operation: "spawn", failure: "launch-body", contender: "stop" },
  { operation: "spawn", failure: "launch-body", contender: "shutdown" },
  { operation: "send", failure: "accepted-callback", contender: "stop" },
  { operation: "send", failure: "accepted-callback", contender: "shutdown" },
  { operation: "spawn", failure: "accepted-callback", contender: "stop" },
  { operation: "spawn", failure: "accepted-callback", contender: "shutdown" },
] as const;

const terminalOrderings = [
  { name: "settlement claims terminal ownership before stop", first: "settlement" },
  { name: "stop persists intent before settlement evidence", first: "stop" },
] as const;

describe("RunController arbitration", () => {

  test("post-mutation observations see committed lifecycle state and cannot alter outcomes", async () => {
    const seen: string[] = [];
    const c = testRunController({
      observation: { afterMutation: (record) => {
        seen.push(record.state);
        if (record.state === AgentState.Stopping) throw new Error("projection fault");
      } },
    });
    const id = registerStopped(c);
    expect(await c.launch(id, async () => ({ status: "accepted", runId: testRunId("deadbeef"), runtime: testRuntime() })))
      .toMatchObject({ status: "running" });
    expect(await c.stop(id, CancellationReason.StopRequested)).toMatchObject({ status: "stopped" });
    expect(seen).toEqual([AgentState.Stopped, AgentState.Stopped, AgentState.Running, AgentState.Stopping, AgentState.Stopped]);
  });

  test("register rejects non-stopped records (delta 7)", () => {
    const c = testRunController();
    expect(() => c.register({
      agentId: testAgentId("active"),
      state: AgentState.Running,
      transcriptPath: testSessionPath("/tmp/pi-subagents-test/active"),
      runId: testRunId("deadbeef"),
    })).toThrow("invalid_state:");
  });

  test("restore admission joins an in-flight launch and excludes later launches until commit", async () => {
    const c = testRunController({ capacity: runCapacity(1) });
    const existing = registerStopped(c);
    const launchGate = deferred<void>();
    const launching = c.launch(existing, async () => {
      await launchGate.promise;
      return { status: "failed" as const };
    });

    const admission = c.beginRestore();
    await expect(c.spawnNew(async () => { throw new Error("must not run"); })).rejects.toThrow("invalid_state:");
    launchGate.resolve();
    await launching;
    const restore = await admission;
    restore.reserve([{ agentId: testAgentId("restored"), state: AgentState.Settling, transcriptPath: testSessionPath("/tmp/pi-subagents-test/restored"), runId: testRunId("deadbeef") }]);
    restore.commit();
    await expect(c.spawnNew(async () => { throw new Error("must not run"); })).rejects.toThrow("invalid_state:");
    restore.release();
    expect(c.activeCount()).toBe(1);
  });

  test("restore admission inherits obligations above current capacity and blocks new launches", async () => {
    const c = testRunController({ capacity: runCapacity(1) });
    const restore = await c.beginRestore();
    restore.reserve([
      { agentId: testAgentId("one"), state: AgentState.Settling, transcriptPath: testSessionPath("/tmp/pi-subagents-test/one"), runId: testRunId("deadbeef"), runtime: testRuntime() },
      { agentId: testAgentId("two"), state: AgentState.Stopping, transcriptPath: testSessionPath("/tmp/pi-subagents-test/two"), runId: testRunId("cafebabe"), runtime: testRuntime() },
    ]);
    restore.commit();
    restore.release();
    expect(c.activeCount()).toBe(2);
    await expect(c.spawnNew(async () => { throw new Error("must not run"); })).rejects.toThrow("capacity_exceeded:");
    await c.stop(testAgentId("one"), CancellationReason.StopRequested);
    expect(c.activeCount()).toBe(1);
    await expect(c.spawnNew(async () => { throw new Error("must not run"); })).rejects.toThrow("capacity_exceeded:");
    await c.stop(testAgentId("two"), CancellationReason.StopRequested);
    expect(c.activeCount()).toBe(0);
  });

  test("capacity rejection is a CodedError carrying the stable message", async () => {
    const c = testRunController({ capacity: runCapacity(1) });
    const restore = await c.beginRestore();
    restore.reserve([
      { agentId: testAgentId("one"), state: AgentState.Settling, transcriptPath: testSessionPath("/tmp/pi-subagents-test/one"), runId: testRunId("deadbeef"), runtime: testRuntime() },
    ]);
    restore.commit();
    restore.release();
    const error = await c.spawnNew(async () => { throw new Error("must not run"); })
      .then(() => { throw new Error("expected rejection"); }, (e: unknown) => e);
    expect(error).toBeInstanceOf(CodedError);
    expect((error as CodedError).code).toBe(AgentErrorCode.CapacityExceeded);
    expect((error as CodedError).message).toBe("capacity_exceeded: maximum concurrent runs exceeded");
  });

  test("restore rejects active records without a native identity unless pre-native stopping containment is required", async () => {
    const cases = [
      { name: "running without identity or runtime", agentId: testAgentId("bad00001"), state: AgentState.Running },
      { name: "settling without identity", agentId: testAgentId("bad00002"), state: AgentState.Settling },
      { name: "running containment responsibility without identity", agentId: testAgentId("bad00003"), state: AgentState.Running, containmentResponsibility: "pre-native" as const, runtime: testRuntime() },
    ];

    for (const testCase of cases) {
      const c = testRunController();
      await expect(restoreRuns(c, [{
        agentId: testCase.agentId,
        state: testCase.state,
        transcriptPath: testSessionPath("/tmp/pi-subagents-test/malformed"),
        ...(testCase.containmentResponsibility === undefined ? {} : { containmentResponsibility: testCase.containmentResponsibility }),
        ...(testCase.runtime === undefined ? {} : { runtime: testCase.runtime }),
      }])).rejects.toMatchObject({ code: AgentErrorCode.InvalidState });
    }
  });

  test("restore commit validates a mixed staged batch before installing records", async () => {
    const c = testRunController({ capacity: runCapacity(1) });
    const restore = await c.beginRestore();
    restore.reserve([
      { agentId: testAgentId("valid-first"), state: AgentState.Settling, transcriptPath: testSessionPath("/tmp/pi-subagents-test/valid-first"), runId: testRunId("deadbeef") },
      { agentId: testAgentId("malformed-later"), state: AgentState.Running, transcriptPath: testSessionPath("/tmp/pi-subagents-test/malformed-later") },
    ]);

    expect(() => restore.commit()).toThrow("invalid_state:");
    expect(c.snapshots()).toEqual([]);
    expect(c.activeCount()).toBe(2);

    restore.release();
    restore.release();
    expect(c.activeCount()).toBe(0);
    expect(await c.spawnNew(async (register) => {
      register({ agentId: testAgentId("reusable"), transcriptPath: testSessionPath("/tmp/pi-subagents-test/reusable") });
      return { status: "failed" as const, agentId: testAgentId("reusable"), transcriptPath: testSessionPath("/tmp/pi-subagents-test/reusable") };
    })).toEqual({ status: "failed", agentId: testAgentId("reusable") });
    expect(c.activeCount()).toBe(0);
  });

  test("restore retains identified settling and stopping records and pre-native stopping containment", async () => {
    const c = testRunController({ capacity: runCapacity(3) });
    await restoreRuns(c, [
      { agentId: testAgentId("settling-identity"), state: AgentState.Settling, transcriptPath: testSessionPath("/tmp/pi-subagents-test/settling-identity"), runId: testRunId("deadbeef") },
      { agentId: testAgentId("stopping-identity"), state: AgentState.Stopping, transcriptPath: testSessionPath("/tmp/pi-subagents-test/stopping-identity"), runId: testRunId("cafebabe"), runtime: testRuntime() },
      { agentId: testAgentId("pre-native-stopping"), state: AgentState.Stopping, transcriptPath: testSessionPath("/tmp/pi-subagents-test/pre-native-stopping"), containmentResponsibility: "pre-native", runtime: testRuntime() },
    ]);
    expect(c.snapshots().map((record) => record.state)).toEqual([AgentState.Settling, AgentState.Stopping, AgentState.Stopping]);
  });

  test("restoreRuns inherits every prior-session obligation above capacity", async () => {
    const c = testRunController({ capacity: runCapacity(1) });
    const records = [
      { agentId: testAgentId("first"), state: AgentState.Settling, transcriptPath: testSessionPath("/tmp/pi-subagents-test/first"), runId: testRunId("deadbeef"), runtime: testRuntime() },
      { agentId: testAgentId("second"), state: AgentState.Stopping, transcriptPath: testSessionPath("/tmp/pi-subagents-test/second"), runId: testRunId("cafebabe"), runtime: testRuntime() },
    ];
    await restoreRuns(c, records);
    expect(c.snapshots()).toHaveLength(2);
    expect(c.activeCount()).toBe(2);
  });

  test("restoreRuns cannot overwrite an existing record or leak its reservation", async () => {
    const c = testRunController({ capacity: runCapacity(2) });
    const existing = { agentId: testAgentId("existing"), state: AgentState.Settling, transcriptPath: testSessionPath("/tmp/pi-subagents-test/existing"), runId: testRunId("deadbeef") };
    await restoreRuns(c, [existing]);

    await expect(restoreRuns(c, [{ ...existing, state: AgentState.Stopped }])).rejects.toThrow("invalid_agent:");
    expect(c.snapshots()).toEqual([existing]);
    expect(c.activeCount()).toBe(1);
  });

  test("a natural candidate survives publication failure and stop retries that same candidate", async () => {
    const seen: string[] = [];
    let attempts = 0;
    const c = testRunController({ onTerminal: async (_record, settlement) => {
      seen.push(settlement.kind);
      if (++attempts === 1) throw new Error("publication failed");
    } });
    const id = registerStopped(c);
    await c.launch(id, async () => ({ status: "accepted", runId: testRunId("deadbeef"), runtime: testRuntime() }));
    expect((await c.settle(id, testRunId("deadbeef"), { kind: "completed" })).status).toBe("containment_failed");
    expect(await c.stop(id, CancellationReason.StopRequested)).toMatchObject({ status: "already_stopped" });
    expect(seen).toEqual(["completed", "completed"]);
  });

  test("pre-run containment retry releases ownership without creating a terminal run", async () => {
    let contains = 0;
    let terminals = 0;
    const c = testRunController({ onTerminal: async () => { terminals++; } });
    await c.spawnNew(async (register) => {
      register({ agentId: testAgentId("pre-run"), transcriptPath: testSessionPath("/tmp/pi-subagents-test/pre") });
      return { status: "containment_failed", agentId: testAgentId("pre-run"), transcriptPath: testSessionPath("/tmp/pi-subagents-test/pre"),
        runtime: { abort: async () => {}, contain: async () => { contains++; return testVerifiedReceiptPath("/tmp/pi-subagents-test/receipts/pre.receipt"); } } };
    });
    expect(await c.stop(testAgentId("pre-run"), CancellationReason.StopRequested)).toEqual({ status: "already_stopped", agentId: testAgentId("pre-run") });
    expect(terminals).toBe(0);
    expect(contains).toBe(1);
    expect(c.activeCount()).toBe(0);
  });
  test("restored historical-unresolved receipt retries join one pre-run owner", async () => {
    let valid = false, contains = 0, terminals = 0, stoppings = 0, releases = 0;
    const c = testRunController({
      onStopping: () => { stoppings++; },
      onTerminal: () => { terminals++; },
      onRelease: () => { releases++; },
    });
    const id = testAgentId("restored-pre-run");
    await restoreRuns(c, [{
      agentId: id, state: AgentState.Stopping, transcriptPath: testSessionPath("/tmp/pi-subagents-test/pre"),
      containmentResponsibility: "historical-unresolved",
      runtime: { abort: async () => { throw new Error("must not abort"); }, contain: async () => {
        contains++;
        if (!valid) throw new Error("receipt unavailable");
        return testVerifiedReceiptPath("/tmp/pi-subagents-test/receipts/pre.receipt");
      } },
    }]);

    expect(await c.stop(id, CancellationReason.StopRequested)).toMatchObject({ status: "containment_failed", agentState: AgentState.Stopping });
    expect(c.snapshot(id)?.containmentResponsibility).toBe("historical-unresolved");
    valid = true;
    const results = await Promise.all([c.stop(id, CancellationReason.StopRequested), c.stop(id, CancellationReason.ParentShutdown)]);
    expect(results).toEqual([
      { status: "already_stopped", agentId: id },
      { status: "already_stopped", agentId: id },
    ]);
    expect({ contains, terminals, stoppings, releases, active: c.activeCount(), runId: c.snapshot(id)?.runId }).toEqual({
      contains: 2, terminals: 0, stoppings: 0, releases: 1, active: 0, runId: undefined,
    });
  });
  test("concurrent stop callers enter pre-run containment before it completes and join one owner", async () => {
    let attempts = 0, releases = 0;
    const gate = testBarrier("pre-run-containment");
    const c = testRunController({ onRelease: () => { releases++; } });
    const id = testAgentId("pre-join");
    await c.spawnNew(async (register) => {
      register({ agentId: id, transcriptPath: testSessionPath("/tmp/pi-subagents-test/pre") });
      return { status: "containment_failed", agentId: id, transcriptPath: testSessionPath("/tmp/pi-subagents-test/pre"),
        runtime: { abort: async () => {}, contain: async () => { attempts++; await gate.enterAndWait(); return testVerifiedReceiptPath("/tmp/pi-subagents-test/receipts/r"); } } };
    });

    const callers = [c.stop(id, CancellationReason.ParentShutdown), c.stop(id, CancellationReason.StopRequested), c.stop(id, CancellationReason.StopRequested)];
    await gate.entered;
    expect(attempts).toBe(1);
    gate.release();

    expect(await Promise.all(callers)).toEqual([
      { status: "already_stopped", agentId: id },
      { status: "already_stopped", agentId: id },
      { status: "already_stopped", agentId: id },
    ]);
    expect(releases).toBe(1);
    expect((await c.stop(id, CancellationReason.StopRequested)).status).toBe("already_stopped");
    expect(attempts).toBe(1);
    expect(c.activeCount()).toBe(0);
  });

  test("first pre-run containment failure retains state and capacity, then explicit retry contains once more", async () => {
    let attempts = 0, releases = 0;
    const failing = testBarrier("pre-run-containment-failure");
    const c = testRunController({ onRelease: () => { releases++; } });
    const id = testAgentId("pre-retry");
    await c.spawnNew(async (register) => {
      register({ agentId: id, transcriptPath: testSessionPath("/tmp/pi-subagents-test/pre") });
      return { status: "containment_failed", agentId: id, transcriptPath: testSessionPath("/tmp/pi-subagents-test/pre"),
        runtime: { abort: async () => {}, contain: async () => {
          if (++attempts === 1) { await failing.enterAndWait(); throw new Error("still alive"); }
          return testVerifiedReceiptPath("/tmp/pi-subagents-test/receipts/r");
        } } };
    });

    const callers = [c.stop(id, CancellationReason.ParentShutdown), c.stop(id, CancellationReason.StopRequested), c.stop(id, CancellationReason.StopRequested)];
    await failing.entered;
    failing.release();
    const failures = await Promise.all(callers);

    expect(failures).toEqual([
      { status: "containment_failed", agentId: id, agentState: AgentState.Stopping, code: AgentErrorCode.ContainmentFailed },
      { status: "containment_failed", agentId: id, agentState: AgentState.Stopping, code: AgentErrorCode.ContainmentFailed },
      { status: "containment_failed", agentId: id, agentState: AgentState.Stopping, code: AgentErrorCode.ContainmentFailed },
    ]);
    expect(attempts).toBe(1);
    expect(releases).toBe(0);
    expect(c.activeCount()).toBe(1);

    expect((await c.stop(id, CancellationReason.StopRequested)).status).toBe("already_stopped");
    expect(attempts).toBe(2);
    expect(releases).toBe(1);
    expect((await c.stop(id, CancellationReason.StopRequested)).status).toBe("already_stopped");
    expect(attempts).toBe(2);
    expect(c.activeCount()).toBe(0);
  });
  test("classifies native terminal observations without treating an uncorrelated abort as cancellation", () => {
    expect(classifyTerminal({ kind: "settled", stopReason: "stop" })).toEqual({ kind: "completed" });
    expect(classifyTerminal({ kind: "settled", stopReason: "length" })).toEqual({ kind: "completed" });
    expect(classifyTerminal({ kind: "settled", stopReason: "error" })).toEqual({ kind: "failed", cause: terminalFailureCause(AgentErrorCode.ProtocolError) });
    expect(classifyTerminal({ kind: "settled", stopReason: "aborted" })).toEqual({ kind: "failed", cause: terminalFailureCause(AgentErrorCode.RunInterrupted) });
    expect(classifyTerminal({ kind: "settled", stopReason: "aborted" }, true)).toEqual({ kind: "cancelled" });
    expect(classifyTerminal({ kind: "settled", stopReason: "toolUse", toolSequenceCompleted: true })).toEqual({ kind: "completed" });
    expect(classifyTerminal({ kind: "settled", stopReason: "toolUse", toolSequenceCompleted: false })).toEqual({ kind: "failed", cause: terminalFailureCause(AgentErrorCode.RunInterrupted) });
    expect(classifyTerminal({ kind: "process_exited" })).toEqual({ kind: "failed", cause: terminalFailureCause(AgentErrorCode.ProcessExited) });
  });

  test("a restored nonterminal record without containment responsibility cannot finalise", async () => {
    let publications = 0;
    const c = testRunController({ onTerminal: () => { publications++; } });
    const id = testAgentId("restored");
    await restoreRuns(c, [{ agentId: id, state: AgentState.Settling, transcriptPath: testSessionPath("/tmp/pi-subagents-test/a"), runId: testRunId("deadbeef") }]);
    const result = await c.settle(id, testRunId("deadbeef"), { kind: "completed" });
    expect(result).toMatchObject({ status: "containment_failed", agentState: AgentState.Settling });
    expect(c.snapshot(id)?.state).toBe(AgentState.Settling);
    expect(c.activeCount()).toBe(1);
    expect(publications).toBe(0);
  });

  test("terminal persistence rejection resolves every waiter and permits one later retry", async () => {
    let attempts = 0, publications = 0, releases = 0;
    const c = testRunController({
      onTerminal: () => { publications++; if (++attempts === 1) throw new Error("disk detail"); },
      onRelease: () => { releases++; },
    });
    const id = registerStopped(c);
    await c.launch(id, async () => ({ status: "accepted", runId: testRunId("deadbeef"), runtime: testRuntime() }));
    const natural = c.settle(id, testRunId("deadbeef"), { kind: "completed" });
    const waiter = c.stop(id, CancellationReason.StopRequested);
    await expect(Promise.all([natural, waiter])).resolves.toEqual([
      expect.objectContaining({ status: "containment_failed", agentState: AgentState.Settling }),
      expect.objectContaining({ status: "containment_failed", agentState: AgentState.Settling }),
    ]);
    expect(c.activeCount()).toBe(1);
    expect(c.snapshot(id)?.state).toBe(AgentState.Settling);
    expect((await c.settle(id, testRunId("deadbeef"), { kind: "completed" })).status).toBe("stopped");
    expect(publications).toBe(2);
    expect(releases).toBe(1);
  });
  test("callback records are invocation-time snapshots, not live references", async () => {
    let seen: Readonly<RunRecord> | undefined;
    const c = testRunController({ onTerminal: (record) => { seen = record; } });
    const id = registerStopped(c);
    await c.launch(id, async () => ({ status: "accepted", runId: testRunId("deadbeef"), runtime: testRuntime() }));
    await c.stop(id, CancellationReason.StopRequested);
    expect(seen).toMatchObject({ agentId: id, state: AgentState.Stopping, runId: testRunId("deadbeef") });
    await c.launch(id, async () => ({ status: "accepted", runId: testRunId("cafebabe"), runtime: testRuntime() }));
    expect(seen).toMatchObject({ state: AgentState.Stopping, runId: testRunId("deadbeef") });
  });

  test("a stop racing a launch failure resolves once the launch settles", async () => {
    const c = testRunController();
    const id = registerStopped(c);
    const gate = deferred<void>();
    const launching = c.launch(id, async (adoptIdentity) => {
      adoptIdentity(testRunId("deadbeef"), testRuntime());
      await gate.promise;
      throw new Error("post-identity failure");
    });
    const stopping = c.stop(id, CancellationReason.StopRequested);
    gate.resolve();
    expect(await launching).toMatchObject({ status: "settling", agentId: id, runId: testRunId("deadbeef") });
    expect((await stopping).status).toBe("already_stopped");
    await c.settle(id, testRunId("deadbeef"), { kind: "completed" }).catch(() => undefined);
  });

  for (const row of [
    { name: "throw", operation: async () => { throw new Error("pre-identity"); }, expected: "throws" },
    { name: "failed", operation: async () => ({ status: "failed" as const }), expected: "failed" },
    { name: "containment_failed", operation: async () => ({ status: "containment_failed" as const, runtime: testRuntime() }), expected: "containment_failed" },
  ] as const) {
    test(`pre-identity relaunch ${row.name} does not inherit the prior run identity`, async () => {
      const c = testRunController();
      const id = registerStopped(c);
      await c.launch(id, async () => ({ status: "accepted", runId: testRunId("deadbeef"), runtime: testRuntime() }));
      await c.stop(id, CancellationReason.StopRequested);

      if (row.expected === "throws") await expect(c.launch(id, row.operation)).rejects.toThrow("pre-identity");
      else expect(await c.launch(id, row.operation)).toMatchObject({ status: row.expected, agentId: id });

      expect(c.snapshot(id)?.runId).toBeUndefined();
      if (row.expected === "containment_failed") expect(c.snapshot(id)?.state).toBe(AgentState.Stopping);
      else expect(c.snapshot(id)?.state).toBe(AgentState.Stopped);
    });
  }

  test("accepted native identity excludes overlapping send", async () => {
    const c = testRunController(); const id = registerStopped(c);
    const accepted = await c.launch(id, async () => ({ status: "accepted", runId: testRunId("deadbeef"), runtime: testRuntime() }));
    expect(accepted).toEqual({ status: "running", agentId: id, runId: testRunId("deadbeef") });
    await expect(c.launch(id, async () => ({ status: "accepted", runId: testRunId("cafebabe"), runtime: testRuntime() }))).rejects.toThrow("invalid_state:");
  });

  test("an unexpected throw after native identity adoption terminalises the retained run", async () => {
    const seen: string[] = [];
    const c = testRunController({ onTerminal: (_record, settlement) => {
      seen.push(settlement.kind === "failed" ? settlement.cause.code : settlement.kind);
    } });
    const id = registerStopped(c);

    const result = await c.launch(id, async (adoptIdentity) => {
      adoptIdentity(testRunId("deadbeef"), testRuntime());
      throw new Error("raw post-identity detail");
    });

    expect(result).toEqual({ status: "settling", agentId: id, runId: testRunId("deadbeef") });
    await c.stop(id, CancellationReason.StopRequested);
    expect(c.snapshot(id)).toMatchObject({ state: AgentState.Stopped, runId: testRunId("deadbeef") });
    expect(seen).toEqual([AgentErrorCode.SpawnFailed]);
    expect(c.activeCount()).toBe(0);
  });

  for (const testCase of postNativeFailureCases) {
    const { operation, failure, contender } = testCase;
    test(`${operation} ${failure} failure owns settlement before the waiting ${contender} contender`, async () => {
      const trace: string[] = [];
      const id = testAgentId(`${operation}-${failure}-${contender}`);
      const transcriptPath = testSessionPath("/tmp/pi-subagents-test/post-native");
      const reason = contender === "stop" ? CancellationReason.StopRequested : CancellationReason.ParentShutdown;
      const c = testRunController({
        onStopping: () => { trace.push("persist:stopping"); },
        onTerminal: (_record, settlement) => { trace.push(`publish:${settlement.kind}`); },
      });
      if (operation === "send") c.register({ agentId: id, state: AgentState.Stopped, transcriptPath });
      const runtime = testRuntime({ trace });

      let contending!: Promise<StopResult>;
      let launching: Promise<LaunchResult | LaunchFailedResult>;
      if (failure === "launch-body") {
        const failing = testBarrier(`${operation}-launch-body-${contender}`);
        const body = async (adoptIdentity: AdoptIdentity): Promise<never> => {
          adoptIdentity(testRunId("deadbeef"), runtime);
          await failing.enterAndWait();
          throw new Error("post-identity launch failure");
        };
        launching = operation === "send"
          ? c.launch(id, body)
          : c.spawnNew(async (register, adoptIdentity) => {
            register({ agentId: id, transcriptPath });
            return body(adoptIdentity);
          });
        await failing.entered;
        contending = c.stop(id, reason);
        failing.release();
      } else {
        const acceptedRun = {
          status: "accepted" as const,
          runId: testRunId("deadbeef"),
          runtime,
          onAccepted: () => {
            contending = c.stop(id, reason);
            throw new Error("callback subscription failed");
          },
        };
        launching = operation === "send"
          ? c.launch(id, async () => acceptedRun)
          : c.spawnNew(async (register) => {
            register({ agentId: id, transcriptPath });
            return { ...acceptedRun, agentId: id, transcriptPath };
          });
      }

      expect(await launching).toEqual({ status: "settling", agentId: id, runId: testRunId("deadbeef") });
      expect(await contending).toEqual({ status: "already_stopped", agentId: id });
      expect(trace).toEqual(["contain", "publish:failed"]);
      expect(c.snapshot(id)).toMatchObject({ state: AgentState.Stopped, runId: testRunId("deadbeef") });
      expect(c.activeCount()).toBe(0);
    });
  }

  for (const operation of ["send", "spawn"] as const) {
    test(`${operation} reports settling immediately when post-native acceptance fails`, async () => {
      const terminalGate = deferred<void>();
      const id = testAgentId(`settling-${operation}`);
      const c = testRunController({ onTerminal: async () => { await terminalGate.promise; } });
      if (operation === "send") c.register({ agentId: id, state: AgentState.Stopped, transcriptPath: testSessionPath("/tmp/pi-subagents-test/settling") });
      const failed = {
        status: "identity_failed" as const,
        runId: testRunId("deadbeef"),
        runtime: testRuntime(),
        beforeTerminal: async () => {},
      };

      const launching = operation === "send"
        ? c.launch(id, async (adoptIdentity) => { adoptIdentity(failed.runId, failed.runtime); return failed; })
        : c.spawnNew(async (register, adoptIdentity) => {
          register({ agentId: id, transcriptPath: testSessionPath("/tmp/pi-subagents-test/settling") });
          adoptIdentity(failed.runId, failed.runtime);
          return { ...failed, agentId: id, transcriptPath: testSessionPath("/tmp/pi-subagents-test/settling") };
        });

      expect(await Promise.race([launching, Bun.sleep(100).then(() => "timed_out" as const)])).toEqual({
        status: "settling", agentId: id, runId: testRunId("deadbeef"),
      });
      expect(c.snapshot(id)?.state).toBe(AgentState.Settling);
      terminalGate.resolve();
      await expect(c.stop(id, CancellationReason.StopRequested)).resolves.toEqual({ status: "already_stopped", agentId: id });
      expect(c.snapshot(id)?.state).toBe(AgentState.Stopped);
    });
  }

  for (const ordering of terminalOrderings) {
    test(ordering.name, async () => {
      const trace: string[] = [];
      const publications: string[] = [];
      let releases = 0;
      const gate = testBarrier(ordering.name);
      const c = testRunController({
        onStopping: async () => {
          trace.push("persist:stopping");
          if (ordering.first === "stop") await gate.enterAndWait();
        },
        onTerminal: async (_record, settlement) => {
          publications.push(settlement.kind);
          trace.push(`publish:${settlement.kind}`);
          if (ordering.first === "settlement") await gate.enterAndWait();
        },
        onRelease: () => { releases++; },
      });
      const id = registerStopped(c);
      await c.launch(id, async () => ({ status: "accepted", runId: testRunId("deadbeef"), runtime: testRuntime({ trace }) }));

      if (ordering.first === "settlement") {
        const settling = c.settle(id, testRunId("deadbeef"), { kind: "completed" });
        await gate.entered;
        const stopping = c.stop(id, CancellationReason.StopRequested);
        gate.release();

        expect(await settling).toEqual({ status: "stopped", agentId: id, runId: testRunId("deadbeef") });
        expect(await stopping).toEqual({ status: "already_stopped", agentId: id });
        expect(publications).toEqual(["completed"]);
        expect(trace).toEqual(["contain", "publish:completed"]);
      } else {
        const stopping = c.stop(id, CancellationReason.StopRequested);
        await gate.entered;
        // The first settlement joins the in-flight stop as evidence only.
        const settling = c.settle(id, testRunId("deadbeef"), { kind: "completed" });
        gate.release();

        expect(await stopping).toEqual({ status: "stopped", agentId: id, runId: testRunId("deadbeef") });
        expect(await settling).toEqual({ status: "already_stopped", agentId: id });
        // A late settlement arriving after the stop-won terminal has completed must be
        // suppressed: no second publication, and capacity already released stays released.
        expect(await c.settle(id, testRunId("deadbeef"), { kind: "completed" }))
          .toEqual({ status: "already_stopped", agentId: id });
        expect(publications).toEqual(["cancelled"]);
        expect(trace).toEqual(["persist:stopping", "abort", "contain", "publish:cancelled"]);
      }
      expect(c.snapshot(id)?.state).toBe(AgentState.Stopped);
      expect(c.activeCount()).toBe(0);
      expect(releases).toBe(1);
    });
  }

  test("an unacknowledged abort cannot block bounded stop containment", async () => {
    const trace: string[] = [];
    const abortNeverSettles = new Promise<void>(() => {});
    const c = testRunController({
      onStopping: () => { trace.push("persist:stopping"); },
      onTerminal: (_record, settlement) => { trace.push(`publish:${settlement.kind}`); },
      onRelease: () => { trace.push("release"); },
    });
    const id = registerStopped(c);
    await c.launch(id, async () => ({
      status: "accepted",
      runId: testRunId("deadbeef"),
      runtime: {
        abort: async () => { trace.push("abort:sent"); await abortNeverSettles; },
        contain: async () => { trace.push("contain:receipt"); return testVerifiedReceiptPath() },
      },
    }));

    const result = await Promise.race([
      c.stop(id, CancellationReason.StopRequested),
      Bun.sleep(100).then(() => "timed_out" as const),
    ]);

    expect(result).toEqual({ status: "stopped", agentId: id, runId: testRunId("deadbeef") });
    expect(trace).toEqual([
      "persist:stopping",
      "abort:sent",
      "contain:receipt",
      "publish:cancelled",
      "release",
    ]);
    expect(c.snapshot(id)?.state).toBe(AgentState.Stopped);
    expect(c.activeCount()).toBe(0);
  });

  test("a synchronous abort throw does not prevent authoritative containment or terminal finalisation", async () => {
    const trace: string[] = [];
    const c = testRunController({
      onStopping: () => { trace.push("persist:stopping"); },
      onTerminal: (_record, settlement) => { trace.push(`publish:${settlement.kind}`); },
      onRelease: () => { trace.push("release"); },
    });
    const id = registerStopped(c);
    await c.launch(id, async () => ({
      status: "accepted",
      runId: testRunId("deadbeef"),
      runtime: {
        abort: () => { trace.push("abort:threw"); throw new Error("abort transport failed"); },
        contain: async () => { trace.push("contain:receipt"); return testVerifiedReceiptPath(); },
      },
    }));

    expect(await c.stop(id, CancellationReason.StopRequested)).toEqual({ status: "stopped", agentId: id, runId: testRunId("deadbeef") });
    expect(trace).toEqual([
      "persist:stopping",
      "abort:threw",
      "contain:receipt",
      "publish:cancelled",
      "release",
    ]);
    expect(c.snapshot(id)?.state).toBe(AgentState.Stopped);
    expect(c.activeCount()).toBe(0);
  });

  test.each([CancellationReason.StopRequested, CancellationReason.ParentShutdown])(
    "the winning %s cancellation reason reaches terminal finalisation",
    async (reason) => {
      const settlements: unknown[] = [];
      const c = testRunController({ onTerminal: (_record, settlement) => { settlements.push(settlement); } });
      const id = registerStopped(c);
      await c.launch(id, async () => ({ status: "accepted", runId: testRunId("deadbeef"), runtime: testRuntime() }));

      await c.stop(id, reason);

      expect(settlements).toEqual([{ kind: "cancelled", reason }]);
    },
  );

  test("failed containment retains stopping state and reservation; later receipt finalises once", async () => {
    let attempts = 0, releases = 0, publications = 0;
    const c = testRunController({ onRelease: () => { releases++; }, onTerminal: () => { publications++; } });
    const id = registerStopped(c);
    await c.launch(id, async () => ({ status: "accepted", runId: testRunId("deadbeef"), runtime: testRuntime({ contain: async () => { if (++attempts === 1) throw new Error("alive"); return testVerifiedReceiptPath(); } }) }));
    expect((await c.stop(id, CancellationReason.StopRequested)).status).toBe("containment_failed");
    expect(c.snapshot(id)?.state).toBe(AgentState.Stopping);
    expect(c.activeCount()).toBe(1);
    expect(publications).toBe(0);
    expect((await c.stop(id, CancellationReason.StopRequested)).status).toBe("stopped");
    expect(releases).toBe(1);
    expect(publications).toBe(1);
  });

  test("beforeTerminal failure after proven containment reports terminal_persistence_failed, not containment_failed, and retry does not re-contain", async () => {
    let containments = 0;
    let beforeTerminalAttempts = 0;
    const c = testRunController();
    const id = registerStopped(c);
    const rt = testRuntime({ contain: async () => { containments++; return testVerifiedReceiptPath(); } });
    await c.launch(id, async (adoptIdentity) => {
      adoptIdentity(testRunId("deadbeef"), rt, async () => {
        beforeTerminalAttempts++;
        if (beforeTerminalAttempts === 1) throw new Error("append unavailable");
      });
      return { status: "accepted", runId: testRunId("deadbeef"), runtime: rt };
    });

    const first = await c.stop(id, CancellationReason.StopRequested);
    expect(first).toMatchObject({ status: "containment_failed", agentState: AgentState.Stopping, code: AgentErrorCode.TerminalPersistenceFailed });
    expect(containments).toBe(1);
    expect(c.snapshot(id)?.state).toBe(AgentState.Stopping);

    const second = await c.stop(id, CancellationReason.StopRequested);
    expect(second.status).toBe("stopped");
    expect(containments).toBe(1);
    expect(beforeTerminalAttempts).toBe(2);
  });

  test("two settlement callers released together publish one terminal and release capacity once", async () => {
    let publications = 0, releases = 0, containments = 0;
    const gate = testBarrier("duplicate-settlement-containment");
    const c = testRunController({ onTerminal: () => { publications++; }, onRelease: () => { releases++; } });
    const id = registerStopped(c);
    await c.launch(id, async () => ({ status: "accepted", runId: testRunId("deadbeef"), runtime: testRuntime({ contain: async () => { containments++; await gate.enterAndWait(); return testVerifiedReceiptPath(); } }) }));

    const callers = [
      c.settle(id, testRunId("deadbeef"), { kind: "completed" }),
      c.settle(id, testRunId("deadbeef"), { kind: "failed", cause: terminalFailureCause(AgentErrorCode.ProtocolError) }),
      c.stop(id, CancellationReason.StopRequested),
    ];
    await gate.entered;
    expect(containments).toBe(1);
    gate.release();
    await Promise.all(callers);

    expect({ publications, releases, containments }).toEqual({ publications: 1, releases: 1, containments: 1 });
    expect(c.activeCount()).toBe(0);
    expect(c.snapshot(id)?.state).toBe(AgentState.Stopped);
  });

  test("send_input admission completes before stop claims the stopped record", async () => {
    const admitting = testBarrier("send-admission");
    const c = testRunController();
    const id = registerStopped(c);
    const sending = c.launch(id, async () => {
      await admitting.enterAndWait();
      return { status: "accepted", runId: testRunId("deadbeef"), runtime: testRuntime() };
    });
    await admitting.entered;
    const stopping = c.stop(id, CancellationReason.StopRequested);
    admitting.release();

    expect(await sending).toEqual({ status: "running", agentId: id, runId: testRunId("deadbeef") });
    expect(await stopping).toEqual({ status: "stopped", agentId: id, runId: testRunId("deadbeef") });
    expect(c.snapshot(id)).toMatchObject({ state: AgentState.Stopped, runId: testRunId("deadbeef") });
    expect(c.activeCount()).toBe(0);
  });

  test("stop claims the stopped record before send_input admission", async () => {
    let admittedSends = 0;
    const stopping = testBarrier("stop-intent-persistence");
    const c = testRunController({ onStopping: async () => { await stopping.enterAndWait(); } });
    const id = registerStopped(c);
    await c.launch(id, async () => ({ status: "accepted", runId: testRunId("deadbeef"), runtime: testRuntime() }));

    const stopped = c.stop(id, CancellationReason.StopRequested);
    await stopping.entered;
    await expect(c.launch(id, async () => {
      admittedSends++;
      return { status: "accepted", runId: testRunId("cafebabe"), runtime: testRuntime() };
    })).rejects.toThrow("invalid_state:");
    stopping.release();

    expect(await stopped).toEqual({ status: "stopped", agentId: id, runId: testRunId("deadbeef") });
    expect(admittedSends).toBe(0);
    expect(c.snapshot(id)).toMatchObject({ state: AgentState.Stopped, runId: testRunId("deadbeef") });
    expect(c.activeCount()).toBe(0);
  });

  test("a delayed prior-run callback arrives before the current run terminalises and cannot publish it", async () => {
    const publications: string[] = [];
    const c = testRunController({ onTerminal: (record, settlement) => { publications.push(`${record.runId}:${settlement.kind}`); } });
    const id = registerStopped(c);
    const first = testRunId("deadbeef");
    const second = testRunId("cafebabe");
    await c.launch(id, async () => ({ status: "accepted", runId: first, runtime: testRuntime() }));
    expect((await c.settle(id, first, { kind: "completed" })).status).toBe("stopped");
    await c.launch(id, async () => ({ status: "accepted", runId: second, runtime: testRuntime() }));

    const delayed = await c.settle(id, first, { kind: "failed", cause: terminalFailureCause(AgentErrorCode.ProtocolError) });
    expect(delayed).toEqual({ status: "already_stopped", agentId: id });
    expect(c.snapshot(id)).toMatchObject({ state: AgentState.Running, runId: second });

    expect(await c.stop(id, CancellationReason.StopRequested)).toEqual({ status: "stopped", agentId: id, runId: second });
    expect(publications).toEqual(["deadbeef:completed", "cafebabe:cancelled"]);
    expect(c.activeCount()).toBe(0);
  });

  test("the current run terminalises before the delayed prior-run callback and remains the sole publication", async () => {
    const publications: string[] = [];
    const c = testRunController({ onTerminal: (record, settlement) => { publications.push(`${record.runId}:${settlement.kind}`); } });
    const id = registerStopped(c);
    const first = testRunId("deadbeef");
    const second = testRunId("cafebabe");
    await c.launch(id, async () => ({ status: "accepted", runId: first, runtime: testRuntime() }));
    expect((await c.settle(id, first, { kind: "completed" })).status).toBe("stopped");
    await c.launch(id, async () => ({ status: "accepted", runId: second, runtime: testRuntime() }));

    expect((await c.settle(id, second, { kind: "completed" })).status).toBe("stopped");
    expect(await c.settle(id, first, { kind: "completed" })).toEqual({ status: "already_stopped", agentId: id });

    expect(publications).toEqual(["deadbeef:completed", "cafebabe:completed"]);
    expect(c.snapshot(id)).toMatchObject({ state: AgentState.Stopped, runId: second });
    expect(c.activeCount()).toBe(0);
  });

  describe("phase projections", () => {
    const res = () => new RunSemaphore(runCapacity(1)).tryAcquire()!;
    const identity = { runId: testRunId("deadbeef"), runtime: testRuntime() };

    test.each<[string, Phase, AgentState]>([
      ["launching without identity", { kind: "launching", reservation: res(), done: Promise.resolve(), resolveDone: () => {} }, AgentState.Stopped],
      ["launching with identity", { kind: "launching", reservation: res(), done: Promise.resolve(), resolveDone: () => {}, identity }, AgentState.Running],
      ["running", { kind: "running", reservation: res(), identity }, AgentState.Running],
      ["preRunContainment", { kind: "preRunContainment", reservation: res(), runtime: testRuntime() }, AgentState.Stopping],
      ["terminating (settling)", { kind: "terminating", reservation: res(), terminalState: AgentState.Settling, contained: false }, AgentState.Settling],
      ["stopped", { kind: "stopped" }, AgentState.Stopped],
    ])("%s projects to the expected AgentState", (_name, phase, expected) => {
      expect(agentStateOf(phase)).toBe(expected);
    });

    test("toSnapshot omits runtime and obligation; stopped snapshots retain identity", () => {
      const live: Parameters<typeof toSnapshot>[0] = {
        agentId: testAgentId(), transcriptPath: testSessionPath(), mutex: new Mutex(),
        phase: { kind: "running", reservation: res(), identity, provenance: { containmentResponsibility: "pre-native", restoredTerminalObligation: true } },
      };
      expect(toCallbackRecord(live)).toMatchObject({ runtime: identity.runtime, restoredTerminalObligation: true, containmentResponsibility: "pre-native" });
      expect(Object.keys(toSnapshot(live)).sort()).toEqual(["agentId", "containmentResponsibility", "runId", "state", "transcriptPath"]);
      live.phase = { kind: "stopped", runId: identity.runId, provenance: { containmentResponsibility: "pre-native" } };
      expect(toSnapshot(live)).toMatchObject({ state: AgentState.Stopped, runId: identity.runId, containmentResponsibility: "pre-native" });
    });
  });

  test("does not hold the agent mutex while stop persistence or containment waits", async () => {
    const persistence = deferred<void>();
    const persistenceEntered = deferred<void>();
    const containment = deferred<void>();
    const c = testRunController({ onStopping: () => { persistenceEntered.resolve(); return persistence.promise; } });
    const id = registerStopped(c);
    await c.launch(id, async () => ({ status: "accepted", runId: testRunId("deadbeef"), runtime: testRuntime({ contain: async () => { await containment.promise; return testVerifiedReceiptPath(); } }) }));
    const stopping = c.stop(id, CancellationReason.StopRequested);
    await persistenceEntered.promise;
    const competingLaunch = c.launch(id, async () => ({ status: "accepted" as const, runId: testRunId("cafebabe"), runtime: testRuntime() }));
    let launchOutcome: string = "pending";
    void competingLaunch.then(() => { launchOutcome = "accepted"; }, () => { launchOutcome = "rejected"; });
    for (let i = 0; i < 10 && launchOutcome === "pending"; i++) await Promise.resolve();
    expect(launchOutcome).toBe("rejected");
    persistence.resolve();
    await Promise.resolve();
    expect(c.snapshot(id)?.state).toBe(AgentState.Stopping);
    containment.resolve();
    expect((await stopping).status).toBe("stopped");
  });
});

