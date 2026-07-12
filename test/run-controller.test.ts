import { describe, expect, test } from "bun:test";
import { AgentErrorCode, AgentState, CancellationReason, agentId, runId, terminalFailureCause } from "../src/domain.ts";
import { RunController, classifyTerminal, type RunControllerOptions } from "../src/run-controller.ts";

describe("RunController arbitration", () => {
  test("restore admission joins an in-flight launch and excludes later launches until commit", async () => {
    const c = controller({ capacity: 1 });
    const existing = register(c);
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
    restore.reserve([{ agentId: agentId("restored"), state: AgentState.Settling, transcriptPath: "/tmp/restored" as never, runId: runId("deadbeef") }]);
    restore.commit();
    await expect(c.spawnNew(async () => { throw new Error("must not run"); })).rejects.toThrow("invalid_state:");
    restore.release();
    expect(c.activeCount()).toBe(1);
  });

  test("restore admission inherits obligations above current capacity and blocks new launches", async () => {
    const c = controller({ capacity: 1 });
    const restore = await c.beginRestore();
    restore.reserve([
      { agentId: agentId("one"), state: AgentState.Settling, transcriptPath: "/tmp/one" as never, runId: runId("deadbeef"), runtime: runtime() },
      { agentId: agentId("two"), state: AgentState.Stopping, transcriptPath: "/tmp/two" as never, runId: runId("cafebabe"), runtime: runtime() },
    ]);
    restore.commit();
    restore.release();
    expect(c.activeCount()).toBe(2);
    await expect(c.spawnNew(async () => { throw new Error("must not run"); })).rejects.toThrow("capacity_exceeded:");
    await c.stop(agentId("one"), CancellationReason.StopRequested);
    expect(c.activeCount()).toBe(1);
    await expect(c.spawnNew(async () => { throw new Error("must not run"); })).rejects.toThrow("capacity_exceeded:");
    await c.stop(agentId("two"), CancellationReason.StopRequested);
    expect(c.activeCount()).toBe(0);
  });

  test("direct restore inherits every prior-session obligation above capacity", () => {
    const c = controller({ capacity: 1 });
    const records = [
      { agentId: agentId("first"), state: AgentState.Settling, transcriptPath: "/tmp/first" as never, runId: runId("deadbeef"), runtime: runtime() },
      { agentId: agentId("second"), state: AgentState.Stopping, transcriptPath: "/tmp/second" as never, runId: runId("cafebabe"), runtime: runtime() },
    ];
    c.restore(records);
    expect(c.snapshots()).toHaveLength(2);
    expect(c.activeCount()).toBe(2);
  });

  test("restore cannot overwrite an existing record or leak its reservation", () => {
    const c = controller({ capacity: 2 });
    const existing = { agentId: agentId("existing"), state: AgentState.Settling, transcriptPath: "/tmp/existing" as never, runId: runId("deadbeef") };
    c.restore([existing]);

    expect(() => c.restore([{ ...existing, state: AgentState.Stopped }])).toThrow("invalid_agent:");
    expect(c.snapshots()).toEqual([existing]);
    expect(c.activeCount()).toBe(1);
  });

  test("a natural candidate survives publication failure and stop retries that same candidate", async () => {
    const seen: string[] = [];
    let attempts = 0;
    const c = controller({ onTerminal: async (_record, settlement) => {
      seen.push(settlement.kind);
      if (++attempts === 1) throw new Error("publication failed");
    } });
    const id = register(c);
    await c.launch(id, async () => ({ status: "accepted", runId: runId("deadbeef"), runtime: runtime() }));
    expect((await c.settle(id, runId("deadbeef"), { kind: "completed" })).status).toBe("containment_failed");
    expect(await c.stop(id, CancellationReason.StopRequested)).toMatchObject({ status: "already_stopped" });
    expect(seen).toEqual(["completed", "completed"]);
  });

  test("pre-run containment retry releases ownership without creating a terminal run", async () => {
    let contains = 0;
    let terminals = 0;
    const c = controller({ onTerminal: async () => { terminals++; } });
    await c.spawnNew(async (register) => {
      register({ agentId: agentId("pre-run"), transcriptPath: "/tmp/pre" as never });
      return { status: "containment_failed", agentId: agentId("pre-run"), transcriptPath: "/tmp/pre" as never,
        runtime: { abort: async () => {}, contain: async () => { contains++; return "/tmp/pre.receipt" as never; } } };
    });
    expect(await c.stop(agentId("pre-run"), CancellationReason.StopRequested)).toEqual({ status: "already_stopped", agentId: agentId("pre-run") });
    expect(terminals).toBe(0);
    expect(contains).toBe(1);
    expect(c.activeCount()).toBe(0);
  });
  test("restored historical-unresolved receipt retries join one pre-run owner", async () => {
    let valid = false, contains = 0, terminals = 0, stoppings = 0, releases = 0;
    const c = controller({
      onStopping: () => { stoppings++; },
      onTerminal: () => { terminals++; },
      onRelease: () => { releases++; },
    });
    const id = agentId("restored-pre-run");
    c.restore([{
      agentId: id, state: AgentState.Stopping, transcriptPath: "/tmp/pre" as never,
      containmentResponsibility: "historical-unresolved",
      runtime: { abort: async () => { throw new Error("must not abort"); }, contain: async () => {
        contains++;
        if (!valid) throw new Error("receipt unavailable");
        return "/tmp/pre.receipt" as never;
      } },
    }]);

    expect(await c.stop(id, "stop")).toMatchObject({ status: "containment_failed", agentState: AgentState.Stopping });
    expect(c.snapshot(id)?.containmentResponsibility).toBe("historical-unresolved");
    valid = true;
    const results = await Promise.all([c.stop(id, "stop"), c.stop(id, "shutdown")]);
    expect(results).toEqual([
      { status: "already_stopped", agentId: id },
      { status: "already_stopped", agentId: id },
    ]);
    expect({ contains, terminals, stoppings, releases, active: c.activeCount(), runId: c.snapshot(id)?.runId }).toEqual({
      contains: 2, terminals: 0, stoppings: 0, releases: 1, active: 0, runId: undefined,
    });
  });
  test("pre-run containment has one joinable owner across 100 success and failure/retry schedules", async () => {
    for (let schedule = 0; schedule < 100; schedule++) {
      let attempts = 0, releases = 0;
      const gate = deferred<void>();
      const c = controller({ onRelease: () => { releases++; } });
      const id = agentId(`pre-${schedule}`);
      await c.spawnNew(async (register) => {
        register({ agentId: id, transcriptPath: "/tmp/pre" as never });
        return { status: "containment_failed", agentId: id, transcriptPath: "/tmp/pre" as never,
          runtime: { abort: async () => {}, contain: async () => { attempts++; await gate.promise; if (schedule % 2 === 1 && attempts === 1) throw new Error("still alive"); return "/tmp/r" as never; } } };
      });
      const callers = [c.stop(id, "shutdown"), c.stop(id, "retry"), c.stop(id, "stop")];
      gate.resolve();
      const first = await Promise.all(callers);
      expect(attempts).toBe(1);
      expect(new Set(first.map((value) => value.status)).size).toBe(1);
      if (schedule % 2 === 1) expect((await c.stop(id, "retry")).status).toBe("already_stopped");
      expect(releases).toBe(1);
      expect((await c.stop(id, "late")).status).toBe("already_stopped");
      expect(attempts).toBe(schedule % 2 === 1 ? 2 : 1);
    }
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
    const c = controller({ onTerminal: () => { publications++; } });
    const id = agentId("restored");
    c.restore([{ agentId: id, state: AgentState.Settling, transcriptPath: "/tmp/a" as never, runId: runId("deadbeef") }]);
    const result = await c.settle(id, runId("deadbeef"), { kind: "completed" });
    expect(result).toMatchObject({ status: "containment_failed", agentState: AgentState.Settling });
    expect(c.snapshot(id)?.state).toBe(AgentState.Settling);
    expect(c.activeCount()).toBe(1);
    expect(publications).toBe(0);
  });

  test("terminal persistence rejection resolves every waiter and permits one later retry", async () => {
    let attempts = 0, publications = 0, releases = 0;
    const c = controller({
      onTerminal: () => { publications++; if (++attempts === 1) throw new Error("disk detail"); },
      onRelease: () => { releases++; },
    });
    const id = register(c);
    await c.launch(id, async () => ({ status: "accepted", runId: runId("deadbeef"), runtime: runtime() }));
    const natural = c.settle(id, runId("deadbeef"), { kind: "completed" });
    const waiter = c.stop(id, CancellationReason.StopRequested);
    await expect(Promise.all([natural, waiter])).resolves.toEqual([
      expect.objectContaining({ status: "containment_failed", agentState: AgentState.Settling }),
      expect.objectContaining({ status: "containment_failed", agentState: AgentState.Settling }),
    ]);
    expect(c.activeCount()).toBe(1);
    expect(c.snapshot(id)?.state).toBe(AgentState.Settling);
    expect((await c.settle(id, runId("deadbeef"), { kind: "completed" })).status).toBe("stopped");
    expect(publications).toBe(2);
    expect(releases).toBe(1);
  });
  test("accepted native identity excludes overlapping send", async () => {
    const c = controller(); const id = register(c);
    const accepted = await c.launch(id, async () => ({ status: "accepted", runId: runId("deadbeef"), runtime: runtime() }));
    expect(accepted).toEqual({ status: "running", agentId: id, runId: runId("deadbeef") });
    await expect(c.launch(id, async () => ({ status: "accepted", runId: runId("cafebabe"), runtime: runtime() }))).rejects.toThrow("invalid_state:");
  });

  test("an unexpected throw after native identity adoption terminalises the retained run", async () => {
    const seen: string[] = [];
    const c = controller({ onTerminal: (_record, settlement) => {
      seen.push(settlement.kind === "failed" ? settlement.cause.code : settlement.kind);
    } });
    const id = register(c);

    const result = await c.launch(id, async (adoptIdentity) => {
      adoptIdentity(runId("deadbeef"), runtime());
      throw new Error("raw post-identity detail");
    });

    expect(result).toEqual({ status: "settling", agentId: id, runId: runId("deadbeef") });
    await c.stop(id, CancellationReason.StopRequested);
    expect(c.snapshot(id)).toMatchObject({ state: AgentState.Stopped, runId: runId("deadbeef") });
    expect(seen).toEqual([AgentErrorCode.SpawnFailed]);
    expect(c.activeCount()).toBe(0);
  });

  test("post-identity launch failure owns settlement before waiting stops resume in 100 schedules", async () => {
    for (let schedule = 0; schedule < 100; schedule++) {
      const trace: string[] = [];
      const failed = deferred<void>();
      const releaseFailure = deferred<void>();
      const c = controller({
        onStopping: () => { trace.push("persist:stopping"); },
        onTerminal: (_record, settlement) => { trace.push(`publish:${settlement.kind}`); },
      });
      const id = register(c, schedule);
      const launching = c.launch(id, async (adoptIdentity) => {
        adoptIdentity(runId("deadbeef"), {
          abort: async () => { trace.push("abort"); },
          contain: async () => { trace.push("contain"); return "/tmp/receipt" as never; },
        });
        failed.resolve();
        await releaseFailure.promise;
        throw new Error("post-ID launch failure");
      });
      await failed.promise;
      const stopping = c.stop(id, schedule % 2 === 0 ? CancellationReason.StopRequested : CancellationReason.ParentShutdown);
      releaseFailure.resolve();

      expect(await launching).toEqual({ status: "settling", agentId: id, runId: runId("deadbeef") });
      expect(await stopping).toEqual({ status: "already_stopped", agentId: id });
      expect(trace).toEqual(["contain", "publish:failed"]);
      expect(c.snapshot(id)).toMatchObject({ state: AgentState.Stopped, runId: runId("deadbeef") });
      expect(c.activeCount()).toBe(0);
    }
  });

  test("post-identity spawn failure owns settlement before waiting shutdown stops resume in 100 schedules", async () => {
    for (let schedule = 0; schedule < 100; schedule++) {
      const trace: string[] = [];
      const failed = deferred<void>();
      const releaseFailure = deferred<void>();
      const id = agentId(`spawn-failure-${schedule}`);
      const c = controller({
        onStopping: () => { trace.push("persist:stopping"); },
        onTerminal: (_record, settlement) => { trace.push(`publish:${settlement.kind}`); },
      });
      const spawning = c.spawnNew(async (register, adoptIdentity) => {
        register({ agentId: id, transcriptPath: "/tmp/spawn-failure" as never });
        adoptIdentity(runId("deadbeef"), {
          abort: async () => { trace.push("abort"); },
          contain: async () => { trace.push("contain"); return "/tmp/receipt" as never; },
        });
        failed.resolve();
        await releaseFailure.promise;
        throw new Error("post-ID spawn failure");
      });
      await failed.promise;
      const stopping = c.stop(id, CancellationReason.ParentShutdown);
      releaseFailure.resolve();

      expect(await spawning).toEqual({ status: "settling", agentId: id, runId: runId("deadbeef") });
      expect(await stopping).toEqual({ status: "already_stopped", agentId: id });
      expect(trace).toEqual(["contain", "publish:failed"]);
      expect(c.snapshot(id)).toMatchObject({ state: AgentState.Stopped, runId: runId("deadbeef") });
      expect(c.activeCount()).toBe(0);
    }
  });

  for (const operation of ["send", "spawn"] as const) {
    test(`${operation} callback-subscription failure owns settlement before 100 waiting stop/shutdown contenders`, async () => {
      for (let schedule = 0; schedule < 100; schedule++) {
        const trace: string[] = [];
        const id = operation === "send" ? agentId(`accepted-send-${schedule}`) : agentId(`accepted-spawn-${schedule}`);
        const c = controller({
          onStopping: () => { trace.push("persist:stopping"); },
          onTerminal: (_record, settlement) => { trace.push(`publish:${settlement.kind}`); },
        });
        if (operation === "send") c.register({ agentId: id, state: AgentState.Stopped, transcriptPath: "/tmp/accepted" as never });
        let contender!: Promise<unknown>;
        const acceptedRun = {
          status: "accepted" as const,
          runId: runId("deadbeef"),
          runtime: {
            abort: async () => { trace.push("abort"); },
            contain: async () => { trace.push("contain"); return "/tmp/receipt" as never; },
          },
          onAccepted: () => {
            contender = c.stop(id, schedule % 2 === 0 ? CancellationReason.StopRequested : CancellationReason.ParentShutdown);
            throw new Error("callback subscription failed");
          },
        };

        const launching = operation === "send"
          ? c.launch(id, async () => acceptedRun)
          : c.spawnNew(async (register) => {
            register({ agentId: id, transcriptPath: "/tmp/accepted" as never });
            return { ...acceptedRun, agentId: id, transcriptPath: "/tmp/accepted" as never };
          });

        expect(await launching).toEqual({ status: "settling", agentId: id, runId: runId("deadbeef") });
        expect(await contender).toEqual({ status: "already_stopped", agentId: id });
        expect(trace).toEqual(["contain", "publish:failed"]);
        expect(c.snapshot(id)).toMatchObject({ state: AgentState.Stopped, runId: runId("deadbeef") });
        expect(c.activeCount()).toBe(0);
      }
    });
  }

  for (const operation of ["send", "spawn"] as const) {
    test(`${operation} reports settling immediately when post-native acceptance fails`, async () => {
      const terminalGate = deferred<void>();
      const id = agentId(`settling-${operation}`);
      const c = controller({ onTerminal: async () => { await terminalGate.promise; } });
      if (operation === "send") c.register({ agentId: id, state: AgentState.Stopped, transcriptPath: "/tmp/settling" as never });
      const failed = {
        status: "identity_failed" as const,
        runId: runId("deadbeef"),
        runtime: runtime(),
        beforeTerminal: async () => {},
      };

      const launching = operation === "send"
        ? c.launch(id, async (adoptIdentity) => { adoptIdentity(failed.runId, failed.runtime); return failed; })
        : c.spawnNew(async (register, adoptIdentity) => {
          register({ agentId: id, transcriptPath: "/tmp/settling" as never });
          adoptIdentity(failed.runId, failed.runtime);
          return { ...failed, agentId: id, transcriptPath: "/tmp/settling" as never };
        });

      expect(await Promise.race([launching, Bun.sleep(100).then(() => "timed_out" as const)])).toEqual({
        status: "settling", agentId: id, runId: runId("deadbeef"),
      });
      expect(c.snapshot(id)?.state).toBe(AgentState.Settling);
      terminalGate.resolve();
      await expect(c.stop(id, CancellationReason.StopRequested)).resolves.toEqual({ status: "already_stopped", agentId: id });
      expect(c.snapshot(id)?.state).toBe(AgentState.Stopped);
    });
  }

  test("settlement wins in 100 deterministic schedules and stop only waits", async () => {
    for (let i = 0; i < 100; i++) {
      let publications = 0; const c = controller({ onTerminal: () => { publications++; } }); const id = register(c, i);
      await c.launch(id, async () => ({ status: "accepted", runId: runId("deadbeef"), runtime: runtime() }));
      const settling = c.settle(id, runId("deadbeef"), { kind: "completed" });
      const stopped = await c.stop(id, CancellationReason.StopRequested);
      await settling;
      expect(stopped.status).toBe("already_stopped"); expect(publications).toBe(1);
    }
  });

  test("stop wins in 100 schedules, persists intent before abort, and later settlement is evidence only", async () => {
    for (let i = 0; i < 100; i++) {
      const trace: string[] = []; const c = controller({ onStopping: () => { trace.push("persist:stopping"); }, onTerminal: (_r, s) => { trace.push(`publish:${s.kind}`); } }); const id = register(c, i);
      await c.launch(id, async () => ({ status: "accepted", runId: runId("deadbeef"), runtime: runtime(trace) }));
      const stopping = c.stop(id, CancellationReason.StopRequested);
      await c.settle(id, runId("deadbeef"), { kind: "completed" });
      expect((await stopping).status).toBe("stopped");
      expect(trace).toEqual(["persist:stopping", "abort", "contain", "publish:cancelled"]);
    }
  });

  test("an unacknowledged abort cannot block bounded stop containment", async () => {
    const trace: string[] = [];
    const abortNeverSettles = new Promise<void>(() => {});
    const c = controller({
      onStopping: () => { trace.push("persist:stopping"); },
      onTerminal: (_record, settlement) => { trace.push(`publish:${settlement.kind}`); },
      onRelease: () => { trace.push("release"); },
    });
    const id = register(c);
    await c.launch(id, async () => ({
      status: "accepted",
      runId: runId("deadbeef"),
      runtime: {
        abort: async () => { trace.push("abort:sent"); await abortNeverSettles; },
        contain: async () => { trace.push("contain:receipt"); return "/tmp/receipt" as never; },
      },
    }));

    const result = await Promise.race([
      c.stop(id, CancellationReason.StopRequested),
      Bun.sleep(100).then(() => "timed_out" as const),
    ]);

    expect(result).toEqual({ status: "stopped", agentId: id, runId: runId("deadbeef") });
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

  test.each([CancellationReason.StopRequested, CancellationReason.ParentShutdown])(
    "the winning %s cancellation reason reaches terminal finalisation",
    async (reason) => {
      const settlements: unknown[] = [];
      const c = controller({ onTerminal: (_record, settlement) => { settlements.push(settlement); } });
      const id = register(c);
      await c.launch(id, async () => ({ status: "accepted", runId: runId("deadbeef"), runtime: runtime() }));

      await c.stop(id, reason);

      expect(settlements).toEqual([{ kind: "cancelled", reason }]);
    },
  );

  test("failed containment retains stopping state and reservation; later receipt finalises once", async () => {
    let attempts = 0, releases = 0, publications = 0;
    const c = controller({ onRelease: () => { releases++; }, onTerminal: () => { publications++; } }); const id = register(c);
    await c.launch(id, async () => ({ status: "accepted", runId: runId("deadbeef"), runtime: runtime([], async () => { if (++attempts === 1) throw new Error("alive"); }) }));
    expect((await c.stop(id, CancellationReason.StopRequested)).status).toBe("containment_failed");
    expect(c.snapshot(id)?.state).toBe(AgentState.Stopping); expect(c.activeCount()).toBe(1); expect(publications).toBe(0);
    expect((await c.stop(id, CancellationReason.StopRequested)).status).toBe("stopped");
    expect(releases).toBe(1); expect(publications).toBe(1);
  });

  test("beforeTerminal failure after proven containment reports terminal_persistence_failed, not containment_failed, and retry does not re-contain", async () => {
    let containments = 0;
    let beforeTerminalAttempts = 0;
    const c = controller();
    const id = register(c);
    const rt = runtime([], async () => { containments++; });
    await c.launch(id, async (adoptIdentity) => {
      adoptIdentity(runId("deadbeef"), rt, async () => {
        beforeTerminalAttempts++;
        if (beforeTerminalAttempts === 1) throw new Error("append unavailable");
      });
      return { status: "accepted", runId: runId("deadbeef"), runtime: rt };
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

  test("duplicate terminal callbacks settle exactly once in 100 schedules", async () => {
    for (let i = 0; i < 100; i++) {
      let publications = 0, releases = 0, containments = 0;
      const gate = deferred<void>();
      const c = controller({ onTerminal: () => { publications++; }, onRelease: () => { releases++; } });
      const id = register(c, i);
      await c.launch(id, async () => ({ status: "accepted", runId: runId("deadbeef"), runtime: runtime([], async () => { containments++; await gate.promise; }) }));
      const callbacks = i % 2 === 0
        ? [c.settle(id, runId("deadbeef"), { kind: "completed" }), c.settle(id, runId("deadbeef"), { kind: "failed", cause: terminalFailureCause(AgentErrorCode.ProtocolError) }), c.stop(id, CancellationReason.StopRequested)]
        : [c.stop(id, CancellationReason.StopRequested), c.settle(id, runId("deadbeef"), { kind: "completed" }), c.settle(id, runId("deadbeef"), { kind: "failed", cause: terminalFailureCause(AgentErrorCode.ProtocolError) })];
      gate.resolve();
      await Promise.all(callbacks);
      expect(publications).toBe(1); expect(releases).toBe(1); expect(containments).toBe(1);
      expect(c.activeCount()).toBe(0); expect(c.snapshot(id)?.state).toBe(AgentState.Stopped);
    }
  });

  test("send_input versus stop has only serialisable outcomes in 100 schedules", async () => {
    for (let i = 0; i < 100; i++) {
      const c = controller(); const id = register(c, i);
      if (i % 2 === 1) {
        await c.launch(id, async () => ({ status: "accepted", runId: runId("deadbeef"), runtime: runtime() }));
        const sending = c.launch(id, async () => ({ status: "accepted", runId: runId("cafebabe"), runtime: runtime() }));
        const stopping = c.stop(id, CancellationReason.StopRequested);
        await expect(sending).rejects.toThrow("invalid_state:");
        expect((await stopping).status).toBe("stopped");
        expect(c.activeCount()).toBe(0); expect(c.snapshot(id)?.state).toBe(AgentState.Stopped);
        continue;
      }
      const launchGate = deferred<void>();
      const sending = c.launch(id, async () => { await launchGate.promise; return { status: "accepted", runId: runId("deadbeef"), runtime: runtime() }; });
      const stopping = c.stop(id, CancellationReason.StopRequested);
      launchGate.resolve();
      const [send, stop] = await Promise.all([sending, stopping]);
      expect(send.status).toBe("running");
      expect(stop.status).toBe("stopped");
      expect(c.activeCount()).toBe(0);
      expect(c.snapshot(id)).toMatchObject({ state: AgentState.Stopped, runId: runId("deadbeef") });
    }
  });

  test("sequential runs have fresh terminal ownership and ignore delayed prior-run callbacks", async () => {
    for (let schedule = 0; schedule < 100; schedule++) {
      const publications: string[] = [];
      const c = controller({ onTerminal: (record, settlement) => { publications.push(`${record.runId}:${settlement.kind}`); } });
      const id = register(c, schedule);
      const first = runId("deadbeef");
      const second = runId("cafebabe");
      await c.launch(id, async () => ({ status: "accepted", runId: first, runtime: runtime() }));
      expect((await c.settle(id, first, { kind: "completed" })).status).toBe("stopped");
      await c.launch(id, async () => ({ status: "accepted", runId: second, runtime: runtime() }));

      const delayed = c.settle(id, first, schedule % 2 === 0
        ? { kind: "failed", cause: terminalFailureCause(AgentErrorCode.ProtocolError) }
        : { kind: "completed" });
      const stopped = c.stop(id, CancellationReason.StopRequested);

      expect((await delayed).status).toBe("already_stopped");
      expect(await stopped).toEqual({ status: "stopped", agentId: id, runId: second });
      expect(publications).toEqual(["deadbeef:completed", "cafebabe:cancelled"]);
      expect(c.activeCount()).toBe(0);
    }
  });

  test("does not hold the agent mutex while stop persistence or containment waits", async () => {
    const persistence = deferred<void>(); const persistenceEntered = deferred<void>(); const containment = deferred<void>();
    const c = controller({ onStopping: () => { persistenceEntered.resolve(); return persistence.promise; } }); const id = register(c);
    await c.launch(id, async () => ({ status: "accepted", runId: runId("deadbeef"), runtime: runtime([], () => containment.promise) }));
    const stopping = c.stop(id, CancellationReason.StopRequested);
    await persistenceEntered.promise;
    const competingLaunch = c.launch(id, async () => ({ status: "accepted" as const, runId: runId("cafebabe"), runtime: runtime() }));
    let launchOutcome: "pending" | "accepted" | "rejected" = "pending";
    void competingLaunch.then(() => { launchOutcome = "accepted"; }, () => { launchOutcome = "rejected"; });
    for (let i = 0; i < 10 && launchOutcome === "pending"; i++) await Promise.resolve();
    expect(String(launchOutcome)).toBe("rejected");
    persistence.resolve(); await Promise.resolve();
    expect(c.snapshot(id)?.state).toBe(AgentState.Stopping);
    containment.resolve();
    expect((await stopping).status).toBe("stopped");
  });
});

function controller(options: Partial<RunControllerOptions> = {}) { return new RunController({ capacity: 2, ...options }); }
function register(c: RunController, suffix = 0) { const id = agentId(`agent-${suffix}`); c.register({ agentId: id, state: AgentState.Stopped, transcriptPath: "/tmp/a" as never }); return id; }
function runtime(trace: string[] = [], contain = async () => {}) { return { abort: async () => { trace.push("abort"); }, contain: async () => { trace.push("contain"); await contain(); return "/tmp/receipt" as never; } }; }
function deferred<T>() { let resolve!: (value: T | PromiseLike<T>) => void; const promise = new Promise<T>((r) => { resolve = r; }); return { promise, resolve }; }
