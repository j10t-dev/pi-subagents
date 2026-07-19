import { describe, expect, test } from "bun:test";
import { AgentErrorCode, AgentState, CompletionState, CodedError, PublicPreflightError, agentId, modelSpec, runId, truncateUtf8, verifiedContainmentReceiptPath } from "../src/domain.ts";
import { diagnosticsPath } from "../src/paths.ts";
import { SubagentController, type LaunchSession, type LaunchTransport, type PiControllerComposition, type PreparationScope } from "../src/controller.ts";
import type { RunRuntime } from "../src/run-controller.ts";
import { testAbsolutePath, testAgentId, testAttemptId, testCommittedOutputPath, testEntryId, testReceiptPath, testRunId, testSessionPath, testVerifiedReceiptPath } from "./support/brands.ts";
import { completedCompletion } from "./support/messages.ts";
import { launchSession, runningTransport, testRuntime } from "./support/launches.ts";
import { deferred } from "./support/async.ts";
import { testBarrier } from "./support/barriers.ts";
import { testRestorationPort } from "./support/restoration.ts";

/** Post-native-identity seams, each of which must own settlement against a stop/shutdown contender. */
const postIdentitySeams = ["bindRun", "persistRunStarted", "waitSettled"] as const;

const TEST_SELECTION = Object.freeze({
  model: modelSpec("mock-provider/luna"),
  thinkingLevel: "high" as const,
  tools: Object.freeze(["read"]),
});

function preparationScopeTypeFixture(scope: PreparationScope): void {
  // @ts-expect-error detached work is scheduling-only and has no awaitable result
  const scheduled: Promise<void> = scope.scheduleExternal(async () => {});
  void scheduled;
  // @ts-expect-error the generic result-returning escape hatch must not exist
  scope.runExternal(() => Promise.resolve());
}
void preparationScopeTypeFixture;

describe("parent lifecycle wiring", () => {
  test("shutdown runs completion cleanup only after active ownership is clear and retries failures without re-containing", async () => {
    let cleanups = 0;
    let containments = 0;
    const id = agentId("shutdown-complete");
    const c = new SubagentController({
      composition: {
        prepareSpawn: async () => { throw new Error("unused"); },
        prepareSend: async () => { throw new Error("unused"); },
        shutdownComplete: async () => {
          cleanups++;
          if (cleanups === 1) throw new Error("cleanup failed");
        },
      },
    });
    c.runs.restore([{ agentId: id, runId: runId("deadbeef"), state: AgentState.Running, transcriptPath: testSessionPath("/tmp/pi-subagents-test/shutdown-complete"),
      runtime: { abort: async () => {}, contain: async () => { containments++; return testVerifiedReceiptPath("/tmp/pi-subagents-test/shutdown-complete.receipt"); } } }]);

    await expect(c.shutdown()).rejects.toThrow("cleanup failed");
    expect(cleanups).toBe(1);
    expect(containments).toBe(1);
    expect(c.runs.activeCount()).toBe(0);
    await expect(c.shutdown()).resolves.toBeUndefined();
    expect(cleanups).toBe(2);
    expect(containments).toBe(1);
  });

  test("shutdown does not run completion cleanup while containment remains unresolved", async () => {
    let cleanups = 0;
    const id = agentId("shutdown-complete-retained");
    const c = new SubagentController({ composition: {
      prepareSpawn: async () => { throw new Error("unused"); },
      prepareSend: async () => { throw new Error("unused"); },
      shutdownComplete: async () => { cleanups++; },
    } });
    c.runs.restore([{ agentId: id, runId: runId("deadbeef"), state: AgentState.Running, transcriptPath: testSessionPath("/tmp/pi-subagents-test/shutdown-complete-retained"),
      runtime: { abort: async () => {}, contain: async () => { throw new Error("still populated"); } } }]);

    await expect(c.shutdown()).rejects.toThrow("containment_failed:");
    expect(cleanups).toBe(0);
  });

  test.each([
    ["model unavailable", new PublicPreflightError(AgentErrorCode.ModelUnavailable, 'model pattern "missing/model" is unavailable; use a configured Pi model identifier'), 'model_unavailable: model pattern "missing/model" is unavailable; use a configured Pi model identifier'],
    ["inactive tool", new PublicPreflightError(AgentErrorCode.InvalidInput, 'child tool "web_fetch" is not active in the parent'), 'invalid_input: child tool "web_fetch" is not active in the parent'],
    ["explicit lifecycle tool", new PublicPreflightError(AgentErrorCode.InvalidInput, 'child tool "spawn_agent" is reserved for parent lifecycle control'), 'invalid_input: child tool "spawn_agent" is reserved for parent lifecycle control'],
    ["hostile untyped exception", new Error("HOSTILE_PREPARATION_SECRET"), "spawn_failed: failed to spawn child agent"],
  ] as const)("preflight rejection preserves only approved %s detail before lifecycle effects", async (_name, thrown, expected) => {
    const counters = { reserve: 0, createSession: 0, persistSpawned: 0, createLaunch: 0, watchdog: 0, launch: 0 };
    const c = new SubagentController({
      trace: (event) => { if (event === "reserve") counters.reserve++; },
      composition: {
        prepareSpawn: async () => {
          throw thrown;
          return {
            selection: TEST_SELECTION,
            createSession: async () => { counters.createSession++; throw new Error("unused"); },
            persistSpawned: async () => { counters.persistSpawned++; },
            createLaunch: async () => { counters.createLaunch++; counters.watchdog++; counters.launch++; throw new Error("unused"); },
          };
        },
        prepareSend: async () => { throw new Error("unused"); },
      },
    });

    const failure = await c.spawn({ task: "one" }).catch((error: Error) => error);

    if (!(failure instanceof Error)) throw new Error("expected spawn rejection");
    expect(failure.message).toBe(expected);
    expect(failure.message).not.toContain("HOSTILE_PREPARATION_SECRET");
    expect(counters).toEqual({ reserve: 0, createSession: 0, persistSpawned: 0, createLaunch: 0, watchdog: 0, launch: 0 });
    expect(c.runs.activeCount()).toBe(0);
    expect(await c.receive()).toEqual({ completions: [], agents: [], timedOut: false });
  });

  test("a preparation CodedError diagnostics path survives publicError into the spawn rejection", async () => {
    const path = diagnosticsPath("/tmp", "prepare-coded.log");
    const c = new SubagentController({
      composition: {
        prepareSpawn: async () => { throw new CodedError(AgentErrorCode.ModelUnavailable, path); },
        prepareSend: async () => { throw new Error("unused"); },
      },
    });
    const failure = await c.spawn({ task: "one" }).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(CodedError);
    expect((failure as CodedError).code).toBe(AgentErrorCode.SpawnFailed);
    expect(String((failure as CodedError).diagnosticsPath)).toBe("/tmp/prepare-coded.log");
    expect((failure as CodedError).message).toBe("spawn_failed: failed to spawn child agent");
    expect((failure as CodedError).message).not.toContain("model_unavailable");
  });

  test("a preparation CodedError diagnostics path survives prepareBounded/publicError into the sendInput rejection", async () => {
    const path = diagnosticsPath("/tmp", "send-prepare-coded.log");
    const c = new SubagentController({
      composition: {
        prepareSpawn: async () => { throw new Error("unused"); },
        prepareSend: async () => { throw new CodedError(AgentErrorCode.InvalidAgent, path); },
      },
    });
    const failure = await c.sendInput(agentId("agent-a"), "hello").catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(CodedError);
    expect((failure as CodedError).code).toBe(AgentErrorCode.InvalidAgent);
    expect(String((failure as CodedError).diagnosticsPath)).toBe("/tmp/send-prepare-coded.log");
    expect((failure as CodedError).message).toBe("invalid_agent: unknown or unowned agent");
  });

  test("restore waits for preparation admitted before RunController launch admission", async () => {
    const prepared = deferred<void>();
    const entered = deferred<void>();
    let createSessions = 0;
    const c = new SubagentController({ restoration: {
      stateRoot: testAbsolutePath("/tmp"), getBranch: () => [], resolveContainment: async () => unresolvedContainment(), firstUserEntryAfter: async () => undefined,
      finaliseContained: async () => { throw new Error("unused"); },
      appender: testRestorationPort().appender,
    }, composition: {
      prepareSpawn: async () => {
        entered.resolve();
        await prepared.promise;
        return { selection: TEST_SELECTION, createSession: async () => { createSessions++; throw new Error("must not launch after restore admission"); }, persistSpawned: async () => {}, createLaunch: async () => { throw new Error("unused"); } };
      },
      prepareSend: async () => { throw new Error("unused"); },
    } });

    const spawning = c.spawn({ task: "one" });
    await entered.promise;
    const restoring = c.restore();
    prepared.resolve();
    await expect(spawning).rejects.toThrow("invalid_state:");
    await expect(restoring).resolves.toBeUndefined();
    expect(createSessions).toBe(0);
  });

  test("synchronous shutdown in prepareSpawn rejects boundedly without closing admission or launching", async () => {
    let createSessions = 0;
    let c!: SubagentController;
    c = new SubagentController({ composition: {
      prepareSpawn: async () => {
        await expect(c.shutdown()).rejects.toThrow("invalid_state: agent is not in a valid state for this operation");
        return { selection: TEST_SELECTION, createSession: async () => { createSessions++; throw new Error("must not launch"); }, persistSpawned: async () => {}, createLaunch: async () => { throw new Error("unused"); } };
      },
      prepareSend: async () => { throw new Error("unused"); },
    } });

    await expect(c.spawn({ task: "one" })).rejects.toThrow("invalid_state: agent is not in a valid state for this operation");
    expect(createSessions).toBe(0);
  });

  test("shutdown after an await in prepareSpawn rejects boundedly without deadlock or launch", async () => {
    let createSessions = 0;
    let c!: SubagentController;
    c = new SubagentController({ composition: {
      prepareSpawn: async () => {
        await Promise.resolve();
        await expect(c.shutdown()).rejects.toThrow("invalid_state: agent is not in a valid state for this operation");
        return { selection: TEST_SELECTION, createSession: async () => { createSessions++; throw new Error("must not launch"); }, persistSpawned: async () => {}, createLaunch: async () => { throw new Error("unused"); } };
      },
      prepareSend: async () => { throw new Error("unused"); },
    } });

    await expect(c.spawn({ task: "one" })).rejects.toThrow("invalid_state: agent is not in a valid state for this operation");
    expect(createSessions).toBe(0);
  });

  test("shutdown after an await in prepareSend rejects boundedly without deadlock or launch", async () => {
    const id = agentId("existing");
    let createLaunches = 0;
    let c!: SubagentController;
    c = new SubagentController({ composition: {
      prepareSpawn: async () => { throw new Error("unused"); },
      prepareSend: async () => {
        await Promise.resolve();
        await expect(c.shutdown()).rejects.toThrow("invalid_state: agent is not in a valid state for this operation");
        return { session: { agentId: id, transcriptPath: testSessionPath("/tmp/pi-subagents-test/existing"), previousLeafId: null, attemptId: testAttemptId("attempt"), containmentReceiptPath: testReceiptPath("/tmp/pi-subagents-test/r") }, createLaunch: async () => { createLaunches++; throw new Error("must not launch"); } };
      },
    } });
    c.runs.register({ agentId: id, state: AgentState.Stopped, transcriptPath: testSessionPath("/tmp/pi-subagents-test/existing") });

    await expect(c.sendInput(id, "next")).rejects.toThrow("invalid_state: agent is not in a valid state for this operation");
    expect(createLaunches).toBe(0);
  });

  test("synchronous shutdown in prepareSend rejects boundedly without closing admission or launching", async () => {
    const id = agentId("existing-sync");
    let createLaunches = 0;
    let c!: SubagentController;
    c = new SubagentController({ composition: {
      prepareSpawn: async () => { throw new Error("unused"); },
      prepareSend: async () => {
        await expect(c.shutdown()).rejects.toThrow("invalid_state: agent is not in a valid state for this operation");
        return { session: { agentId: id, transcriptPath: testSessionPath("/tmp/pi-subagents-test/existing-sync"), previousLeafId: null, attemptId: testAttemptId("attempt"), containmentReceiptPath: testReceiptPath("/tmp/pi-subagents-test/r") }, createLaunch: async () => { createLaunches++; throw new Error("must not launch"); } };
      },
    } });
    c.runs.register({ agentId: id, state: AgentState.Stopped, transcriptPath: testSessionPath("/tmp/pi-subagents-test/existing-sync") });

    await expect(c.sendInput(id, "next")).rejects.toThrow("invalid_state: agent is not in a valid state for this operation");
    expect(createLaunches).toBe(0);
  });

  test("forbidden preparation shutdown does not close a concurrent admitted preparation", async () => {
    const bothEntered = deferred<void>();
    const releaseConcurrent = deferred<void>();
    let entered = 0;
    let createSessions = 0;
    let c!: SubagentController;
    c = new SubagentController({ composition: {
      prepareSpawn: async ({ task }) => {
        entered++;
        if (entered === 2) bothEntered.resolve();
        await bothEntered.promise;
        if (task === "caller") {
          await expect(c.shutdown()).rejects.toThrow("invalid_state: agent is not in a valid state for this operation");
        } else {
          await releaseConcurrent.promise;
        }
        const session: LaunchSession = { agentId: agentId(task), transcriptPath: testSessionPath(`/tmp/pi-subagents-test/${task}`), previousLeafId: null, attemptId: testAttemptId(`attempt-${task}`), containmentReceiptPath: testReceiptPath(`/tmp/pi-subagents-test/${task}.receipt`) };
        return { selection: TEST_SELECTION, createSession: async () => { createSessions++; return session; }, persistSpawned: async () => {}, createLaunch: async () => transport(session, () => {}) };
      },
      prepareSend: async () => { throw new Error("unused"); },
    } });

    const caller = c.spawn({ task: "caller" });
    const concurrent = c.spawn({ task: "concurrent" });
    const callerOutcome = caller.catch((error: Error) => error);
    await Promise.resolve();
    releaseConcurrent.resolve();
    await expect(concurrent).resolves.toMatchObject({ state: AgentState.Running });
    expect(await callerOutcome).toHaveProperty("message", "invalid_state: agent is not in a valid state for this operation");
    expect(createSessions).toBe(1);
    await c.shutdown();
  });

  test("detached prepareSpawn shutdown joins createSession and contains the admitted run", async () => {
    const fireShutdown = deferred<void>();
    const shutdownStarted = deferred<void>();
    let shutdownResolved = false;
    let containments = 0;
    let c!: SubagentController;
    const session: LaunchSession = { agentId: agentId("detached-spawn"), transcriptPath: testSessionPath("/tmp/pi-subagents-test/detached-spawn"), previousLeafId: null, attemptId: testAttemptId("attempt"), containmentReceiptPath: testReceiptPath("/tmp/pi-subagents-test/r") };
    c = new SubagentController({ composition: {
      prepareSpawn: async (_input, scope) => {
        scope.scheduleExternal(() => { void (async () => { await fireShutdown.promise; shutdownStarted.resolve(); await c.shutdown(); shutdownResolved = true; })(); });
        return {
          selection: TEST_SELECTION,
          createSession: async () => { fireShutdown.resolve(); await shutdownStarted.promise; await Promise.resolve(); expect(shutdownResolved).toBeFalse(); return session; },
          persistSpawned: async () => {},
          createLaunch: async () => transport(session, () => { containments++; }),
        };
      },
      prepareSend: async () => { throw new Error("unused"); },
    } });

    await expect(c.spawn({ task: "one" })).resolves.toMatchObject({ state: AgentState.Running });
    await expect(c.shutdown()).resolves.toBeUndefined();
    expect(shutdownResolved).toBeTrue();
    expect(containments).toBe(1);
    expect(c.runs.activeCount()).toBe(0);
  });

  test("detached prepareSend shutdown joins createLaunch and contains the admitted run", async () => {
    const fireShutdown = deferred<void>();
    const shutdownStarted = deferred<void>();
    let shutdownResolved = false;
    let containments = 0;
    let c!: SubagentController;
    const session: LaunchSession = { agentId: agentId("detached-send"), transcriptPath: testSessionPath("/tmp/pi-subagents-test/detached-send"), previousLeafId: null, attemptId: testAttemptId("attempt"), containmentReceiptPath: testReceiptPath("/tmp/pi-subagents-test/r") };
    c = new SubagentController({ composition: {
      prepareSpawn: async () => { throw new Error("unused"); },
      prepareSend: async (_agentId, _message, scope) => {
        scope.scheduleExternal(() => { void (async () => { await fireShutdown.promise; shutdownStarted.resolve(); await c.shutdown(); shutdownResolved = true; })(); });
        return { session, createLaunch: async () => { fireShutdown.resolve(); await shutdownStarted.promise; await Promise.resolve(); expect(shutdownResolved).toBeFalse(); return transport(session, () => { containments++; }); } };
      },
    } });
    c.runs.register({ agentId: session.agentId, state: AgentState.Stopped, transcriptPath: session.transcriptPath });

    await expect(c.sendInput(session.agentId, "next")).resolves.toMatchObject({ state: AgentState.Running });
    await expect(c.shutdown()).resolves.toBeUndefined();
    expect(shutdownResolved).toBeTrue();
    expect(containments).toBe(1);
    expect(c.runs.activeCount()).toBe(0);
  });

  test("detached preparation context cannot reuse a released operation token", async () => {
    const fireShutdown = deferred<void>();
    const shutdownFinished = deferred<void>();
    let containments = 0;
    let c!: SubagentController;
    const session: LaunchSession = { agentId: agentId("released-token"), transcriptPath: testSessionPath("/tmp/pi-subagents-test/released-token"), previousLeafId: null, attemptId: testAttemptId("attempt"), containmentReceiptPath: testReceiptPath("/tmp/pi-subagents-test/r") };
    c = new SubagentController({ composition: {
      prepareSpawn: async () => {
        void (async () => { await fireShutdown.promise; await c.shutdown(); shutdownFinished.resolve(); })();
        return { selection: TEST_SELECTION, createSession: async () => session, persistSpawned: async () => {}, createLaunch: async () => transport(session, () => { containments++; }) };
      },
      prepareSend: async () => { throw new Error("unused"); },
    } });

    await expect(c.spawn({ task: "one" })).resolves.toMatchObject({ state: AgentState.Running });
    fireShutdown.resolve();
    await shutdownFinished.promise;
    expect(containments).toBe(1);
    expect(c.runs.activeCount()).toBe(0);
  });

  test("shutdown drains asynchronous send preparation and cancels before launch", async () => {
    const entered = deferred<void>();
    const prepared = deferred<void>();
    const id = agentId("existing");
    let createLaunches = 0;
    const c = new SubagentController({ composition: {
      prepareSpawn: async () => { throw new Error("unused"); },
      prepareSend: async () => {
        entered.resolve();
        await prepared.promise;
        return { session: { agentId: id, transcriptPath: testSessionPath("/tmp/pi-subagents-test/existing"), previousLeafId: null, attemptId: testAttemptId("attempt"), containmentReceiptPath: testReceiptPath("/tmp/pi-subagents-test/r") }, createLaunch: async () => { createLaunches++; throw new Error("must not launch"); } };
      },
    } });
    c.runs.register({ agentId: id, state: AgentState.Stopped, transcriptPath: testSessionPath("/tmp/pi-subagents-test/existing") });

    const sending = c.sendInput(id, "next");
    await entered.promise;
    const shutdown = c.shutdown();
    prepared.resolve();
    await expect(sending).rejects.toThrow("invalid_state:");
    await expect(shutdown).resolves.toBeUndefined();
    expect(createLaunches).toBe(0);
  });

  test("shutdown drains asynchronous spawn preparation and cancels before launch", async () => {
    const preparing = testBarrier("spawn-preparation");
    let createLaunches = 0;
    const session = surrenderSession("drained-spawn-preparation");
    const c = new SubagentController({ composition: {
      prepareSpawn: async () => {
        await preparing.enterAndWait();
        return { selection: TEST_SELECTION, createSession: async () => session, persistSpawned: async () => {},
          createLaunch: async () => { createLaunches++; throw new Error("must not launch"); } };
      },
      prepareSend: async () => { throw new Error("unused"); },
    } });

    const spawning = c.spawn({ task: "one" });
    await preparing.entered;
    const shutdown = c.shutdown();
    preparing.release();

    await expect(spawning).rejects.toThrow("invalid_state:");
    await expect(shutdown).resolves.toBeUndefined();
    expect(createLaunches).toBe(0);
  });

  test("spawn launch is accepted before shutdown", async () => {
    const preparing = testBarrier("spawn-launch-ready");
    let containments = 0;
    const session = surrenderSession("spawn-admission-first");
    const c = new SubagentController({ capacity: 1, composition: {
      // Ownership is accepted at launch, not at preparation entry: a preparation still
      // blocked when shutdown starts is cancelled instead of contained.
      prepareSpawn: async () => ({
        selection: TEST_SELECTION, createSession: async () => session, persistSpawned: async () => {},
        createLaunch: async () => {
          const base = transport(session, () => { containments++; });
          return { ...base, ready: async () => { await preparing.enterAndWait(); } };
        },
      }),
      prepareSend: async () => { throw new Error("unused"); },
    } });

    const spawning = c.spawn({ task: "one" });
    await preparing.entered;
    let shutdownSettled = false;
    const shuttingDown = c.shutdown().then(() => { shutdownSettled = true; });
    await Promise.resolve();
    expect(shutdownSettled).toBe(false);
    preparing.release();

    await expect(spawning).resolves.toMatchObject({ state: AgentState.Running });
    await expect(shuttingDown).resolves.toBeUndefined();
    expect(containments).toBe(1);
    expect(c.runs.snapshot(session.agentId)).toMatchObject({ state: AgentState.Stopped });
    expect(c.runs.activeCount()).toBe(0);
  });

  test("shutdown closes admission before spawn", async () => {
    const containing = testBarrier("shutdown-containment");
    const counters = { prepare: 0, createSession: 0, createLaunch: 0 };
    const id = agentId("closed-before-spawn");
    const c = new SubagentController({ capacity: 1, composition: {
      prepareSpawn: async () => {
        counters.prepare++;
        return { selection: TEST_SELECTION, createSession: async () => { counters.createSession++; throw new Error("must not create a session"); },
          persistSpawned: async () => {}, createLaunch: async () => { counters.createLaunch++; throw new Error("must not launch"); } };
      },
      prepareSend: async () => { throw new Error("unused"); },
    } });
    c.runs.restore([{ agentId: id, runId: runId("deadbeef"), state: AgentState.Running, transcriptPath: testSessionPath("/tmp/pi-subagents-test/closed-before-spawn"),
      runtime: { abort: async () => {}, contain: async () => { await containing.enterAndWait(); return testVerifiedReceiptPath("/tmp/pi-subagents-test/closed-before-spawn.receipt"); } } }]);

    const shuttingDown = c.shutdown();
    await containing.entered;
    await expect(c.spawn({ task: "one" })).rejects.toThrow("invalid_state:");
    containing.release();

    await expect(shuttingDown).resolves.toBeUndefined();
    expect(counters).toEqual({ prepare: 0, createSession: 0, createLaunch: 0 });
    expect(c.runs.activeCount()).toBe(0);
  });

  test("send admission enters before shutdown", async () => {
    const admitting = testBarrier("send-admission");
    let containments = 0;
    const id = agentId("send-admission-first");
    const session = surrenderSession("send-admission-first");
    const c = new SubagentController({ capacity: 1, composition: {
      prepareSpawn: async () => { throw new Error("unused"); },
      prepareSend: async () => ({ session: { ...session, agentId: id }, createLaunch: async () => {
        const base = transport({ ...session, agentId: id }, () => { containments++; });
        return { ...base, ready: async () => { await admitting.enterAndWait(); } };
      } }),
    } });
    c.runs.register({ agentId: id, state: AgentState.Stopped, transcriptPath: session.transcriptPath });

    const sending = c.sendInput(id, "next");
    await admitting.entered;
    let shutdownSettled = false;
    const shuttingDown = c.shutdown().then(() => { shutdownSettled = true; });
    await Promise.resolve();
    expect(shutdownSettled).toBe(false);
    admitting.release();

    await expect(sending).resolves.toMatchObject({ state: AgentState.Running });
    await expect(shuttingDown).resolves.toBeUndefined();
    expect(containments).toBe(1);
    expect(c.runs.snapshot(id)).toMatchObject({ state: AgentState.Stopped });
    expect(c.runs.activeCount()).toBe(0);
  });

  test("shutdown closes admission before send", async () => {
    const containing = testBarrier("shutdown-containment-before-send");
    const counters = { prepare: 0, createLaunch: 0 };
    const id = agentId("closed-before-send");
    const idle = agentId("idle-before-send");
    const c = new SubagentController({ capacity: 2, composition: {
      prepareSpawn: async () => { throw new Error("unused"); },
      prepareSend: async () => {
        counters.prepare++;
        return { session: surrenderSession("closed-before-send"), createLaunch: async () => { counters.createLaunch++; throw new Error("must not launch"); } };
      },
    } });
    c.runs.restore([{ agentId: id, runId: runId("deadbeef"), state: AgentState.Running, transcriptPath: testSessionPath("/tmp/pi-subagents-test/closed-before-send"),
      runtime: { abort: async () => {}, contain: async () => { await containing.enterAndWait(); return testVerifiedReceiptPath("/tmp/pi-subagents-test/closed-before-send.receipt"); } } }]);
    c.runs.register({ agentId: idle, state: AgentState.Stopped, transcriptPath: testSessionPath("/tmp/pi-subagents-test/idle-before-send") });

    const shuttingDown = c.shutdown();
    await containing.entered;
    await expect(c.sendInput(idle, "next")).rejects.toThrow("invalid_state:");
    containing.release();

    await expect(shuttingDown).resolves.toBeUndefined();
    expect(counters).toEqual({ prepare: 0, createLaunch: 0 });
    expect(c.runs.activeCount()).toBe(0);
  });

  test("native identity is adopted before shutdown", async () => {
    const adopted = testBarrier("post-identity-adoption");
    let containments = 0;
    const session = surrenderSession("identity-before-shutdown");
    const c = new SubagentController({ capacity: 1, composition: {
      prepareSpawn: async () => ({ selection: TEST_SELECTION, createSession: async () => session, persistSpawned: async () => {},
        createLaunch: async () => {
          const base = transport(session, () => { containments++; });
          return { ...base, persistRunStarted: async () => { await adopted.enterAndWait(); } };
        } }),
      prepareSend: async () => { throw new Error("unused"); },
    } });

    const spawning = c.spawn({ task: "one" });
    await adopted.entered;
    const shuttingDown = c.shutdown();
    adopted.release();

    const started = await spawning;
    if (started.state !== AgentState.Running) throw new Error(`expected a running spawn, got ${started.state}`);
    await expect(shuttingDown).resolves.toBeUndefined();
    expect(c.runs.snapshot(session.agentId)).toMatchObject({ state: AgentState.Stopped, runId: started.runId });
    expect(containments).toBe(1);
    expect(c.runs.activeCount()).toBe(0);
  });

  test("shutdown begins before native identity adoption", async () => {
    const identifying = testBarrier("pre-identity-adoption");
    let containments = 0;
    const session = surrenderSession("shutdown-before-identity");
    const c = new SubagentController({ capacity: 1, composition: {
      prepareSpawn: async () => ({ selection: TEST_SELECTION, createSession: async () => session, persistSpawned: async () => {},
        createLaunch: async () => {
          const base = transport(session, () => { containments++; });
          return { ...base, getEntries: async (since?: string | null) => {
            if (since !== undefined) await identifying.enterAndWait();
            return base.getEntries(since);
          } };
        } }),
      prepareSend: async () => { throw new Error("unused"); },
    } });

    const spawning = c.spawn({ task: "one" });
    await identifying.entered;
    const shuttingDown = c.shutdown();
    identifying.release();

    await expect(spawning).resolves.toMatchObject({ state: AgentState.Running });
    await expect(shuttingDown).resolves.toBeUndefined();
    expect(c.runs.snapshot(session.agentId)).toMatchObject({ state: AgentState.Stopped });
    expect(containments).toBe(1);
    expect(c.runs.activeCount()).toBe(0);
  });

  test("shutdownStart runs before active runtime abort and containment", async () => {
    const trace: string[] = [];
    const id = agentId("shutdown-hook-order");
    const c = new SubagentController({ capacity: 1, composition: {
      prepareSpawn: async () => { throw new Error("unused"); },
      prepareSend: async () => { throw new Error("unused"); },
      shutdownStart: () => { trace.push("shutdownStart"); },
    } });
    c.runs.restore([{ agentId: id, runId: runId("deadbeef"), state: AgentState.Running, transcriptPath: testSessionPath("/tmp/pi-subagents-test/hook-order"),
      runtime: { abort: async () => { trace.push("abort"); }, contain: async () => { trace.push("contain"); return testVerifiedReceiptPath("/tmp/pi-subagents-test/hook-order.receipt"); } } }]);

    await c.shutdown();

    expect(trace).toEqual(["shutdownStart", "abort", "contain"]);
  });

  test("concurrent shutdown callers invoke shutdownStart once", async () => {
    const contain = deferred<void>();
    let starts = 0;
    const id = agentId("shutdown-hook-concurrent");
    const c = new SubagentController({ capacity: 1, composition: {
      prepareSpawn: async () => { throw new Error("unused"); },
      prepareSend: async () => { throw new Error("unused"); },
      shutdownStart: () => { starts++; },
    } });
    c.runs.restore([{ agentId: id, runId: runId("deadbeef"), state: AgentState.Running, transcriptPath: testSessionPath("/tmp/pi-subagents-test/hook-concurrent"),
      runtime: { abort: async () => {}, contain: async () => { await contain.promise; return testVerifiedReceiptPath("/tmp/pi-subagents-test/hook-concurrent.receipt"); } } }]);

    const first = c.shutdown();
    const second = c.shutdown();
    contain.resolve();
    await Promise.all([first, second]);

    expect(second).toBe(first);
    expect(starts).toBe(1);
  });

  test("a failed containment retry does not invoke shutdownStart again", async () => {
    let starts = 0;
    let containments = 0;
    const id = agentId("shutdown-hook-retry");
    const c = new SubagentController({ capacity: 1, composition: {
      prepareSpawn: async () => { throw new Error("unused"); },
      prepareSend: async () => { throw new Error("unused"); },
      shutdownStart: () => { starts++; },
    } });
    c.runs.restore([{ agentId: id, runId: runId("deadbeef"), state: AgentState.Running, transcriptPath: testSessionPath("/tmp/pi-subagents-test/hook-retry"),
      runtime: { abort: async () => {}, contain: async () => { if (++containments === 1) throw new Error("still alive"); return testVerifiedReceiptPath("/tmp/pi-subagents-test/hook-retry.receipt"); } } }]);

    await expect(c.shutdown()).rejects.toThrow("containment_failed:");
    await expect(c.shutdown()).resolves.toBeUndefined();

    expect(starts).toBe(1);
    expect(containments).toBe(2);
  });

  test("a throwing shutdownStart hook does not prevent containment", async () => {
    const trace: string[] = [];
    const id = agentId("shutdown-hook-throws");
    const c = new SubagentController({ capacity: 1, composition: {
      prepareSpawn: async () => { throw new Error("unused"); },
      prepareSend: async () => { throw new Error("unused"); },
      shutdownStart: () => { trace.push("shutdownStart"); throw new Error("UI cleanup failed"); },
    } });
    c.runs.restore([{ agentId: id, runId: runId("deadbeef"), state: AgentState.Running, transcriptPath: testSessionPath("/tmp/pi-subagents-test/hook-throws"),
      runtime: { abort: async () => { trace.push("abort"); }, contain: async () => { trace.push("contain"); return testVerifiedReceiptPath("/tmp/pi-subagents-test/hook-throws.receipt"); } } }]);

    await expect(c.shutdown()).resolves.toBeUndefined();
    expect(trace).toEqual(["shutdownStart", "abort", "contain"]);
  });

  test("concurrent external shutdown callers join one close and later launches are not prepared", async () => {
    let preparations = 0;
    const c = new SubagentController({ composition: {
      prepareSpawn: async () => {
        preparations++;
        throw new Error("must not prepare after shutdown");
      },
      prepareSend: async () => { throw new Error("unused"); },
    } });

    const first = c.shutdown();
    const second = c.shutdown();
    expect(second).toBe(first);
    await expect(Promise.all([first, second])).resolves.toEqual([undefined, undefined]);
    await expect(c.spawn({ task: "late" })).rejects.toThrow("invalid_state: agent is not in a valid state for this operation");
    expect(preparations).toBe(0);
  });

  test("concurrent shutdown failure is bounded, retains ownership, and a later call retries containment", async () => {
    let containments = 0;
    const id = agentId("shutdown-retry");
    const c = new SubagentController({ capacity: 1 });
    c.runs.restore([{ agentId: id, runId: runId("deadbeef"), state: AgentState.Running, transcriptPath: testSessionPath("/tmp/pi-subagents-test/retry"),
      runtime: { abort: async () => {}, contain: async () => { if (++containments === 1) throw new Error("raw containment detail"); return testVerifiedReceiptPath("/tmp/pi-subagents-test/retry.receipt"); } } }]);

    const first = c.shutdown();
    const concurrent = c.shutdown();
    expect(concurrent).toBe(first);
    await expect(Promise.all([first, concurrent])).rejects.toThrow("containment_failed: could not confirm child process termination");
    expect(c.runs.snapshot(id)?.state).toBe(AgentState.Stopping);
    expect(c.runs.activeCount()).toBe(1);

    const retry = c.shutdown();
    expect(retry).not.toBe(first);
    await expect(retry).resolves.toBeUndefined();
    expect(c.runs.activeCount()).toBe(0);
    expect(containments).toBe(2);
    expect(c.shutdown()).toBe(retry);
  });

  test("shutdown waits for every stop outcome before rejecting a failed attempt", async () => {
    const gate = deferred<void>();
    let rejected = false;
    const c = new SubagentController({ capacity: 2 });
    c.runs.restore([
      { agentId: agentId("shutdown-fails"), runId: runId("deadbeef"), state: AgentState.Running, transcriptPath: testSessionPath("/tmp/pi-subagents-test/fails"),
        runtime: { abort: async () => {}, contain: async () => { throw new Error("raw failure"); } } },
      { agentId: agentId("shutdown-waits"), runId: runId("cafebabe"), state: AgentState.Running, transcriptPath: testSessionPath("/tmp/pi-subagents-test/waits"),
        runtime: { abort: async () => {}, contain: async () => { await gate.promise; return testVerifiedReceiptPath("/tmp/pi-subagents-test/waits.receipt"); } } },
    ]);

    const shutdown = c.shutdown().catch((error: Error) => { rejected = true; throw error; });
    await Promise.resolve();
    expect(rejected).toBeFalse();
    gate.resolve();
    await expect(shutdown).rejects.toThrow("containment_failed:");
    expect(c.runs.activeCount()).toBe(1);
  });

  test("shutdown retries a retained settling agent after terminal append failure", async () => {
    let terminalAttempts = 0;
    const id = agentId("terminal-retry");
    const c = new SubagentController({ capacity: 1, composition: {
      prepareSpawn: async () => { throw new Error("unused"); },
      prepareSend: async () => { throw new Error("unused"); },
      finaliseRun: async (record) => {
        if (++terminalAttempts === 1) throw new Error("raw append detail");
        return { agentId: record.agentId, runId: record.runId!, state: CompletionState.Cancelled, reason: "parent_shutdown" as const, output: truncateUtf8("", 50_000), outputPath: testCommittedOutputPath("/tmp/pi-subagents-test/result.md"), transcriptPath: record.transcriptPath };
      },
    } });
    c.runs.restore([{ agentId: id, runId: runId("deadbeef"), state: AgentState.Settling, transcriptPath: testSessionPath("/tmp/pi-subagents-test/terminal"),
      runtime: testRuntime({ contain: async () => testVerifiedReceiptPath("/tmp/pi-subagents-test/terminal.receipt") }) }]);

    await expect(c.shutdown()).rejects.toThrow("terminal_persistence_failed: child was contained but its terminal record could not be persisted");
    expect(c.runs.snapshot(id)?.state).toBe(AgentState.Settling);
    expect(c.runs.activeCount()).toBe(1);
    await expect(c.shutdown()).resolves.toBeUndefined();
    expect(terminalAttempts).toBe(2);
    expect(c.runs.activeCount()).toBe(0);
  });

  test("stop distinguishes terminal-persistence failure after proven containment from containment failure", async () => {
    let containments = 0;
    const id = agentId("terminal-code");
    const c = new SubagentController({ capacity: 1, composition: {
      prepareSpawn: async () => { throw new Error("unused"); },
      prepareSend: async () => { throw new Error("unused"); },
      finaliseRun: async () => { throw new Error("raw append detail"); },
    } });
    c.runs.restore([{ agentId: id, runId: runId("deadbeef"), state: AgentState.Running, transcriptPath: testSessionPath("/tmp/pi-subagents-test/terminal-code"),
      runtime: { abort: async () => {}, contain: async () => { containments++; return testVerifiedReceiptPath("/tmp/pi-subagents-test/terminal-code.receipt"); } } }]);

    const outcome = await c.stop(id);

    expect(outcome).toMatchObject({ agentId: id, runId: runId("deadbeef"), state: "failed", agentState: AgentState.Stopping,
      error: { code: "terminal_persistence_failed" } });
    expect(containments).toBe(1);
    expect(c.runs.snapshot(id)?.state).toBe(AgentState.Stopping);
    expect(c.runs.activeCount()).toBe(1);
    expect(c.completions.queuedCount()).toBe(0);
  });

  test("scheduled external callback runs in a future turn and handles rejection", async () => {
    const callbackFinished = deferred<void>();
    let ran = false;
    const c = new SubagentController({ composition: {
      prepareSpawn: async (_input, scope) => {
        scope.scheduleExternal(async () => {
          ran = true;
          try { throw new Error("detached detail"); }
          finally { callbackFinished.resolve(); }
        });
        expect(ran).toBeFalse();
        throw new Error("prepared");
      },
      prepareSend: async () => { throw new Error("unused"); },
    } });

    await expect(c.spawn({ task: "one" })).rejects.toThrow("spawn_failed: failed to spawn child agent");
    await callbackFinished.promise;
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(ran).toBeTrue();
  });

  test("shutdown and restore join an admitted spawn without deadlock", async () => {
    const launchGate = deferred<void>();
    const launchEntered = deferred<void>();
    const session: LaunchSession = {
      agentId: agentId("admitted"), transcriptPath: testSessionPath("/tmp/pi-subagents-test/admitted"),
      previousLeafId: null, attemptId: testAttemptId("attempt"), containmentReceiptPath: testReceiptPath("/tmp/pi-subagents-test/r"),
    };
    const c = new SubagentController({ capacity: 1, restoration: {
      stateRoot: testAbsolutePath("/tmp"), getBranch: () => [], resolveContainment: async () => unresolvedContainment(), firstUserEntryAfter: async () => undefined,
      finaliseContained: async () => { throw new Error("unused"); },
      appender: testRestorationPort().appender,
    }, composition: {
      prepareSpawn: async () => ({
        selection: TEST_SELECTION,
        createSession: async () => session,
        persistSpawned: async () => {},
        createLaunch: async () => ({
          containment: { backend: "cgroup-v2" as const, scopePath: testAbsolutePath("/tmp/test-cgroup/attempt") },
          ready: async () => { launchEntered.resolve(); await launchGate.promise; throw new Error("launch failed"); },
          persistLaunchRequested: async () => {}, start: async () => {}, getEntries: async () => ({ entries: [], leafId: null }),
          prompt: async () => {}, waitForAgentStart: async () => {}, bindRun: () => {}, persistRunStarted: async () => {}, waitSettled: () => new Promise<never>(() => {}),
          runtime: testRuntime({ contain: async () => testVerifiedReceiptPath("/tmp/pi-subagents-test/r") }),
        }),
      }),
      prepareSend: async () => { throw new Error("unused"); },
    } });

    const spawning = c.spawn({ task: "one" });
    await launchEntered.promise;
    const restoring = c.restore();
    const shuttingDown = c.shutdown();
    launchGate.resolve();
    await expect(spawning).resolves.toBeDefined();
    await expect(restoring).rejects.toThrow("invalid_state:");
    await expect(shuttingDown).resolves.toBeUndefined();
    expect(c.runs.activeCount()).toBe(0);
  });

  test("controller owns the exact launch transaction and returns running before immediate settlement", async () => {
    const trace: string[] = [];
    let statusRefreshed!: () => void;
    const statusRefresh = new Promise<void>((resolve) => { statusRefreshed = resolve; });
    let settle!: (value: { reason: "agent_settled"; stopReason: "stop" }) => void;
    const settled = new Promise<{ reason: "agent_settled"; stopReason: "stop" }>((resolve) => { settle = resolve; });
    const session: LaunchSession = {
      agentId: agentId("agent-a"), transcriptPath: testSessionPath("/tmp/pi-subagents-test/a"),
      previousLeafId: null, attemptId: testAttemptId("attempt-a"),
      containmentReceiptPath: testReceiptPath("/tmp/pi-subagents-test/receipt"),
    };
    const containment = { backend: "cgroup-v2" as const, scopePath: testAbsolutePath("/tmp/cgroups/attempt-a") };
    const transport: LaunchTransport = {
      containment,
      ready: async () => { trace.push("watchdog:ready"); },
      persistLaunchRequested: async () => {
        expect(session.containment).toEqual(containment);
        trace.push("persist:run_launch_requested:v2");
      },
      start: async () => { trace.push("watchdog:launch_request"); trace.push("watchdog:launch_ack_with_pgid"); },
      getEntries: async (since) => {
        trace.push(since === undefined ? "rpc:get_entries_before" : "rpc:get_entries_after");
        return since === undefined
          ? { entries: [], leafId: null }
          : { entries: [{ id: "deadbeef", type: "message", message: { role: "user", content: "literal assignment" } }], leafId: "deadbeef" };
      },
      prompt: async (message) => { trace.push(`rpc:prompt:${message}`); },
      waitForAgentStart: async () => { trace.push("rpc:agent_start"); },
      bindRun: () => { trace.push("output:bind_run"); },
      persistRunStarted: async () => { trace.push("persist:run_started"); settle({ reason: "agent_settled", stopReason: "stop" }); },
      waitSettled: () => settled,
      runtime: testRuntime({ contain: async () => testVerifiedReceiptPath("/tmp/pi-subagents-test/receipt") }),
    };
    const c = new SubagentController({ composition: {
      prepareSpawn: async () => ({
        selection: TEST_SELECTION,
        createSession: async () => { trace.push("create-session"); return session; },
        persistSpawned: async () => { trace.push("persist:spawned"); },
        createLaunch: async () => transport,
      }),
      prepareSend: async () => { throw new Error("unused"); },
    }, trace: (event) => { trace.push(event); }, onStatusChange: statusRefreshed });

    const result = await c.spawn({ task: "literal assignment" });
    trace.push("return:running");

    expect(result).toEqual({
      agentId: agentId("agent-a"),
      runId: runId("deadbeef"),
      state: AgentState.Running,
      model: modelSpec("mock-provider/luna"),
      thinkingLevel: "high",
      tools: ["read"],
    });
    expect(trace).toEqual([
      "reserve", "create-session", "persist:spawned", "watchdog:ready",
      "persist:run_launch_requested:v2", "watchdog:launch_request", "watchdog:launch_ack_with_pgid",
      "rpc:get_entries_before", "rpc:prompt:literal assignment", "rpc:agent_start", "rpc:get_entries_after",
      "output:bind_run", "persist:run_started", "return:running",
    ]);
    expect(await Promise.race([statusRefresh.then(() => true), Bun.sleep(100).then(() => false)])).toBeTrue();
    expect(c.status()).toBe("agents: 0 running, 0 result ready");
  });

  test("resolves exact identity only after agent_start and polls pending snapshots", async () => {
    const barrier = deferred<void>();
    const barrierEntered = deferred<void>();
    const delay = deferred<void>();
    const trace: string[] = [];
    let snapshots = 0;
    let literal = "";
    const session = surrenderSession("strict-identity");
    const transport: LaunchTransport = {
      containment: { backend: "cgroup-v2" as const, scopePath: testAbsolutePath("/tmp/test-cgroup/attempt") },
      ready: async () => {}, persistLaunchRequested: async () => {}, start: async () => {},
      getEntries: async (since?: string | null) => {
        if (since === undefined) return { entries: [], leafId: "baseline" };
        snapshots++;
        return snapshots === 1
          ? { entries: [], leafId: "baseline" }
          : { entries: [{ id: "deadbeef", type: "message", message: { role: "user", content: literal } }], leafId: "deadbeef" };
      },
      prompt: async (message) => { literal = message; trace.push("prompt"); },
      waitForAgentStart: async () => { trace.push("barrier"); barrierEntered.resolve(); await barrier.promise; },
      bindRun: () => { trace.push("bind"); }, persistRunStarted: async () => { trace.push("started"); },
      waitSettled: () => new Promise<never>(() => {}),
      runtime: { abort: async () => {}, contain: async () => verifiedContainmentReceiptPath(session.containmentReceiptPath) },
    };
    const c = new SubagentController({
      identityDeadline: () => new AbortController().signal,
      identityDelay: async () => { trace.push("delay"); await delay.promise; },
      composition: {
        prepareSpawn: async () => ({ selection: TEST_SELECTION, createSession: async () => session, persistSpawned: async () => {}, createLaunch: async () => transport }),
        prepareSend: async () => { throw new Error("unused"); },
      },
    });

    const spawning = c.spawn({ task: "literal assignment" });
    await barrierEntered.promise;
    expect(trace).toEqual(["prompt", "barrier"]);
    barrier.resolve();
    while (!trace.includes("delay")) await Promise.resolve();
    expect(trace).toEqual(["prompt", "barrier", "delay"]);
    delay.resolve();
    await expect(spawning).resolves.toMatchObject({ runId: runId("deadbeef"), state: AgentState.Running });
    expect(trace).toEqual(["prompt", "barrier", "delay", "bind", "started"]);
  });

  test("fails closed without adopting identity when a post-barrier snapshot is ambiguous", async () => {
    const session = surrenderSession("ambiguous-identity");
    let lookups = 0;
    let bound = false;
    let started = false;
    const c = new SubagentController({ composition: {
      prepareSpawn: async () => ({ selection: TEST_SELECTION, createSession: async () => session, persistSpawned: async () => {}, createLaunch: async () => ({
        containment: { backend: "cgroup-v2" as const, scopePath: testAbsolutePath("/tmp/test-cgroup/attempt") },
        ready: async () => {}, persistLaunchRequested: async () => {}, start: async () => {},
        getEntries: async (since?: string | null) => since === undefined ? { entries: [], leafId: "baseline" } : {
          entries: [
            { id: "deadbeef", type: "message", message: { role: "user", content: "literal assignment" } },
            { id: "cafebabe", type: "message", message: { role: "user", content: "competing" } },
          ], leafId: "cafebabe",
        },
        prompt: async () => {}, waitForAgentStart: async () => {},
        bindRun: () => { bound = true; }, persistRunStarted: async () => { started = true; },
        waitSettled: () => new Promise<never>(() => {}),
        runtime: { abort: async () => {}, contain: async () => { lookups++; return verifiedContainmentReceiptPath(session.containmentReceiptPath); } },
      }) }),
      prepareSend: async () => { throw new Error("unused"); },
    } });

    await expect(c.spawn({ task: "literal assignment" })).resolves.toMatchObject({ state: AgentState.Stopped, error: { code: AgentErrorCode.SpawnFailed } });
    expect(lookups).toBe(1);
    expect(bound).toBeFalse();
    expect(started).toBeFalse();
    expect(c.completions.queuedCount()).toBe(0);
  });

  test.each(["baseline lookup", "prompt acknowledgement", "agent_start barrier", "post-barrier getEntries polling", "inter-poll delay"] as const)(
    "deadline aborts %s, contains the child, and leaves no accepted run",
    async (phase) => {
      const deadline = new AbortController();
      const entered = deferred<void>();
      const session = surrenderSession(`deadline-${phase.replaceAll(/[^a-z0-9]+/g, "-")}`);
      let containments = 0;
      const block = (): Promise<never> => new Promise<never>(() => {});
      const transport: LaunchTransport = {
        containment: { backend: "cgroup-v2" as const, scopePath: testAbsolutePath("/tmp/test-cgroup/attempt") },
        ready: async () => {}, persistLaunchRequested: async () => {}, start: async () => {},
        getEntries: async (since?: string | null) => {
          if (since === undefined) {
            if (phase === "baseline lookup") { entered.resolve(); return block(); }
            return { entries: [], leafId: "baseline" };
          }
          if (phase === "post-barrier getEntries polling") { entered.resolve(); return block(); }
          return { entries: [], leafId: "baseline" };
        },
        prompt: async () => {
          if (phase === "prompt acknowledgement") { entered.resolve(); await block(); }
        },
        waitForAgentStart: async () => {
          if (phase === "agent_start barrier") { entered.resolve(); await block(); }
        },
        bindRun: () => { throw new Error("must not bind after deadline abort"); },
        persistRunStarted: async () => { throw new Error("must not persist after deadline abort"); },
        waitSettled: () => new Promise<never>(() => {}),
        runtime: { abort: async () => {}, contain: async () => { containments++; return verifiedContainmentReceiptPath(session.containmentReceiptPath); } },
      };
      const c = new SubagentController({
        identityDeadline: () => deadline.signal,
        identityDelay: async () => {
          if (phase === "inter-poll delay") entered.resolve();
          await block();
        },
        composition: {
          prepareSpawn: async () => ({ selection: TEST_SELECTION, createSession: async () => session, persistSpawned: async () => {}, createLaunch: async () => transport }),
          prepareSend: async () => { throw new Error("unused"); },
        },
      });

      const spawning = c.spawn({ task: "literal assignment" });
      await entered.promise;
      deadline.abort();
      const result = await Promise.race([
        spawning,
        Bun.sleep(100).then(() => { throw new Error(`deadline did not abort ${phase}`); }),
      ]);

      expect(result).toMatchObject({ agentId: session.agentId, state: AgentState.Stopped, error: { code: AgentErrorCode.SpawnFailed } });
      expect(containments).toBe(1);
      expect(c.runs.snapshot(session.agentId)?.runId).toBeUndefined();
      expect(c.completions.queuedCount()).toBe(0);
    },
  );

  test("capacity is reserved after pure preflight and before child-session creation", async () => {
    let creations = 0;
    const composition = {
      prepareSpawn: async () => ({
        selection: TEST_SELECTION,
        createSession: async () => ({ agentId: agentId(`agent-${++creations}`), transcriptPath: testSessionPath("/tmp/pi-subagents-test/a"), previousLeafId: null, attemptId: testAttemptId("attempt"), containmentReceiptPath: testReceiptPath("/tmp/pi-subagents-test/r") }),
        persistSpawned: async () => {},
        createLaunch: async () => ({
          containment: { backend: "cgroup-v2" as const, scopePath: testAbsolutePath("/tmp/test-cgroup/attempt") },
          ready: async () => {}, persistLaunchRequested: async () => {}, start: async () => {},
          getEntries: async (since?: string | null) => since === undefined ? { entries: [], leafId: null } : { entries: [{ id: "deadbeef", type: "message", message: { role: "user", content: "one" } }], leafId: "deadbeef" },
          prompt: async () => {}, waitForAgentStart: async () => {}, bindRun: () => {}, persistRunStarted: async () => {}, waitSettled: () => new Promise<never>(() => {}),
          runtime: testRuntime({ contain: async () => testVerifiedReceiptPath("/tmp/pi-subagents-test/r") }),
        }),
      }),
      prepareSend: async () => { throw new Error("unused"); },
    };
    const c = new SubagentController({ capacity: 1, composition });
    const spawned = await c.spawn({ task: "one" });
    expect(spawned.agentId as string).toBe("agent-1");
    if (spawned.state !== AgentState.Running) throw new Error("expected accepted run");
    expect(spawned.runId as string).toBe("deadbeef");
    expect(spawned.state).toBe("running");
    await expect(c.spawn({ task: "two" })).rejects.toThrow("capacity_exceeded:");
    expect(creations).toBe(1);
  });

  test("failure before native user identity contains, returns stopped, creates no completion, and releases once", async () => {
    const trace: string[] = [];
    const session: LaunchSession = { agentId: agentId("agent-failed"), transcriptPath: testSessionPath("/tmp/pi-subagents-test/f"), previousLeafId: null, attemptId: testAttemptId("attempt-f"), containmentReceiptPath: testReceiptPath("/tmp/pi-subagents-test/f.receipt") };
    const c = new SubagentController({ capacity: 1, composition: {
      prepareSpawn: async () => ({ selection: TEST_SELECTION, createSession: async () => session, persistSpawned: async () => {}, createLaunch: async () => ({
        containment: { backend: "cgroup-v2" as const, scopePath: testAbsolutePath("/tmp/test-cgroup/attempt") },
        ready: async () => {}, persistLaunchRequested: async () => {}, start: async () => {},
        getEntries: async () => { throw new Error("transport detail must not escape"); }, prompt: async () => {}, waitForAgentStart: async () => {}, bindRun: () => {}, persistRunStarted: async () => {},
        waitSettled: () => new Promise<never>(() => {}),
        runtime: { abort: async () => {}, contain: async () => { trace.push("contain"); return testVerifiedReceiptPath("/tmp/pi-subagents-test/f.receipt"); } },
      }) }), prepareSend: async () => { throw new Error("unused"); },
    } });

    const failed = await c.spawn({ task: "assignment" });
    expect(failed).toEqual({ agentId: agentId("agent-failed"), state: AgentState.Stopped, error: expect.objectContaining({ code: "spawn_failed" }) });
    expect(trace).toEqual(["contain"]);
    expect(c.completions.queuedCount()).toBe(0);
    expect(c.runs.activeCount()).toBe(0);
    expect(c.runs.snapshot(agentId("agent-failed"))?.runId).toBeUndefined();
  });

  test("pre-native-ID containment failure retains ownership and capacity for receipt retry", async () => {
    let containments = 0;
    const session: LaunchSession = { agentId: agentId("agent-retained"), transcriptPath: testSessionPath("/tmp/pi-subagents-test/f"), previousLeafId: null, attemptId: testAttemptId("attempt-f"), containmentReceiptPath: testReceiptPath("/tmp/pi-subagents-test/f.receipt") };
    const c = new SubagentController({ capacity: 1, composition: {
      prepareSpawn: async () => ({ selection: TEST_SELECTION, createSession: async () => session, persistSpawned: async () => {}, createLaunch: async () => ({
        containment: { backend: "cgroup-v2" as const, scopePath: testAbsolutePath("/tmp/test-cgroup/attempt") },
        ready: async () => {}, persistLaunchRequested: async () => {}, start: async () => {},
        getEntries: async () => { throw new Error("raw transport detail"); }, prompt: async () => {}, waitForAgentStart: async () => {}, bindRun: () => {}, persistRunStarted: async () => {},
        waitSettled: () => new Promise<never>(() => {}),
        runtime: { abort: async () => {}, contain: async () => { if (++containments === 1) throw new Error("still alive"); return testVerifiedReceiptPath("/tmp/pi-subagents-test/f.receipt"); } },
      }) }), prepareSend: async () => { throw new Error("unused"); },
    } });
    const failed = await c.spawn({ task: "assignment" });
    expect(failed).toMatchObject({ agentId: session.agentId, state: AgentState.Stopping, error: { code: "containment_failed" } });
    expect(c.runs.activeCount()).toBe(1);
    expect(c.runs.snapshot(session.agentId)?.state).toBe(AgentState.Stopping);
    expect(await c.stop(session.agentId)).toMatchObject({ state: "already_stopped" });
    expect(c.runs.activeCount()).toBe(0);
  });

  for (const operation of ["spawn", "send"] as const) {
    test(`${operation} createLaunch that spawns then throws holds capacity until containment is proven`, async () => {
      let containments = 0;
      const session = surrenderSession(`retain-${operation}`);
      const createLaunch = (surrender: (runtime: RunRuntime) => void): Promise<LaunchTransport> => {
        surrender({ abort: async () => {}, contain: async () => {
          if (++containments === 1) throw new Error("process group still alive");
          return testVerifiedReceiptPath(String(session.containmentReceiptPath));
        } });
        throw new Error("raw spawn detail after process-group creation");
      };
      const c = new SubagentController({ capacity: 1, composition: {
        prepareSpawn: async () => ({ selection: TEST_SELECTION, createSession: async () => session, persistSpawned: async () => {}, createLaunch: (_session, surrender) => createLaunch(surrender) }),
        prepareSend: async () => ({ session, createLaunch: (surrender) => createLaunch(surrender) }),
      } });
      if (operation === "send") c.runs.register({ agentId: session.agentId, state: AgentState.Stopped, transcriptPath: session.transcriptPath });

      const result = operation === "spawn" ? await c.spawn({ task: "one" }) : await c.sendInput(session.agentId, "next");

      expect(result).toMatchObject({ agentId: session.agentId, state: AgentState.Stopping, error: { code: "containment_failed" } });
      expect(c.runs.snapshot(session.agentId)?.state).toBe(AgentState.Stopping);
      expect(c.runs.activeCount()).toBe(1);
      expect(c.completions.queuedCount()).toBe(0);
      expect(containments).toBe(1);

      expect(await c.stop(session.agentId)).toMatchObject({ state: "already_stopped" });
      expect(c.runs.snapshot(session.agentId)?.state).toBe(AgentState.Stopped);
      expect(c.runs.activeCount()).toBe(0);
      expect(containments).toBe(2);
    });

    test(`${operation} createLaunch that spawns then throws reports stopped only after containment succeeds`, async () => {
      const trace: string[] = [];
      const session = surrenderSession(`contained-${operation}`);
      const createLaunch = (surrender: (runtime: RunRuntime) => void): Promise<LaunchTransport> => {
        surrender({ abort: async () => {}, contain: async () => { trace.push("contain"); return testVerifiedReceiptPath(String(session.containmentReceiptPath)); } });
        throw new Error("raw spawn detail after process-group creation");
      };
      const c = new SubagentController({ capacity: 1, composition: {
        prepareSpawn: async () => ({ selection: TEST_SELECTION, createSession: async () => session, persistSpawned: async () => {}, createLaunch: (_session, surrender) => createLaunch(surrender) }),
        prepareSend: async () => ({ session, createLaunch: (surrender) => createLaunch(surrender) }),
      } });
      if (operation === "send") c.runs.register({ agentId: session.agentId, state: AgentState.Stopped, transcriptPath: session.transcriptPath });

      const result = operation === "spawn" ? await c.spawn({ task: "one" }) : await c.sendInput(session.agentId, "next");

      expect(result).toMatchObject({ agentId: session.agentId, state: AgentState.Stopped, error: { code: "spawn_failed" } });
      expect(trace).toEqual(["contain"]);
      expect(c.runs.activeCount()).toBe(0);
      expect(c.completions.queuedCount()).toBe(0);
    });
  }

  for (const seam of ["bindRun", "persistRunStarted", "waitSettled"] as const) {
    test(`failure at post-identity ${seam} retains identity, persists one failed terminal, and remains resumable`, async () => {
      const trace: string[] = [];
      let startedAttempts = 0;
      let launchNumber = 0;
      const session: LaunchSession = { agentId: agentId(`post-id-${seam}`), transcriptPath: testSessionPath("/tmp/pi-subagents-test/post-id"),
        previousLeafId: null, attemptId: testAttemptId("attempt-post-id"), containmentReceiptPath: testReceiptPath("/tmp/pi-subagents-test/post-id.receipt") };
      const makeTransport = (): LaunchTransport => {
        const current = launchNumber++;
        const currentRunId = current === 0 ? "deadbeef" : "cafebabe";
        let assignment = "";
        return {
          containment: { backend: "cgroup-v2" as const, scopePath: testAbsolutePath("/tmp/test-cgroup/attempt") },
          ready: async () => {}, persistLaunchRequested: async () => {}, start: async () => {},
          getEntries: async (since?: string | null) => since === undefined
            ? { entries: [], leafId: null }
            : { entries: [{ id: currentRunId, type: "message", message: { role: "user", content: assignment } }], leafId: currentRunId },
          prompt: async (message) => { assignment = message; },
          waitForAgentStart: async () => {},
          bindRun: () => { if (current === 0 && seam === "bindRun") throw new Error("raw bind secret"); },
          persistRunStarted: async () => {
            trace.push(`started:${currentRunId}`);
            if (current === 0 && seam === "persistRunStarted" && ++startedAttempts === 1) throw new Error("raw persistence secret");
          },
          waitSettled: () => {
            if (current === 0 && seam === "waitSettled") throw new Error("raw callback secret");
            return new Promise<never>(() => {});
          },
          runtime: { abort: async () => {}, contain: async () => { trace.push(`contain:${currentRunId}`); return testVerifiedReceiptPath(String(session.containmentReceiptPath)); } },
        };
      };
      const c = new SubagentController({ composition: {
        prepareSpawn: async () => ({ selection: TEST_SELECTION, createSession: async () => session, persistSpawned: async () => {}, createLaunch: async () => makeTransport() }),
        prepareSend: async () => ({ session: { ...session, previousLeafId: testEntryId("deadbeef"), attemptId: testAttemptId("attempt-next") }, createLaunch: async () => makeTransport() }),
        finaliseRun: async (record, settlement) => {
          trace.push(`completed:${record.runId}:${settlement.kind}`);
          if (settlement.kind !== "failed") throw new Error("expected failed settlement");
          return { agentId: record.agentId, runId: record.runId!, state: CompletionState.Failed,
            error: settlement.cause, output: truncateUtf8("", 50_000),
            outputPath: testCommittedOutputPath("/tmp/pi-subagents-test/post-id.output.md"), transcriptPath: record.transcriptPath };
        },
      } });

      const result = await c.spawn({ task: "first" });

      expect(result).toMatchObject({ agentId: session.agentId, runId: runId("deadbeef"), state: AgentState.Settling, error: { code: "spawn_failed" } });
      expect(c.runs.snapshot(session.agentId)).toMatchObject({ state: AgentState.Settling, runId: runId("deadbeef") });
      await c.stop(session.agentId);
      expect(c.runs.snapshot(session.agentId)).toMatchObject({ state: AgentState.Stopped, runId: runId("deadbeef") });
      expect(c.runs.activeCount()).toBe(0);
      const received = await c.receive();
      expect(received.completions).toHaveLength(1);
      expect(received.completions[0]).toMatchObject({ runId: runId("deadbeef"), state: CompletionState.Failed });
      expect(trace.filter((item) => item === "completed:deadbeef:failed")).toHaveLength(1);
      expect(trace.indexOf("started:deadbeef")).toBeLessThan(trace.indexOf("completed:deadbeef:failed"));

      await expect(c.sendInput(session.agentId, "second")).resolves.toMatchObject({ runId: runId("cafebabe"), state: AgentState.Running });
    });
  }

  test("post-identity RunStarted failure retains a retryable terminal obligation", async () => {
    let persistAttempts = 0;
    let completions = 0;
    let containments = 0;
    const trace: string[] = [];
    const session: LaunchSession = { agentId: agentId("post-id-retry"), transcriptPath: testSessionPath("/tmp/pi-subagents-test/post-id-retry"),
      previousLeafId: null, attemptId: testAttemptId("attempt-post-id-retry"), containmentReceiptPath: testReceiptPath("/tmp/pi-subagents-test/post-id-retry.receipt") };
    const c = new SubagentController({ composition: {
      prepareSpawn: async () => ({ selection: TEST_SELECTION, createSession: async () => session, persistSpawned: async () => {}, createLaunch: async () => ({
        containment: { backend: "cgroup-v2" as const, scopePath: testAbsolutePath("/tmp/test-cgroup/attempt") },
        ready: async () => {}, persistLaunchRequested: async () => {}, start: async () => {},
        getEntries: async (since?: string | null) => since === undefined ? { entries: [], leafId: null }
          : { entries: [{ id: "deadbeef", type: "message", message: { role: "user", content: "first" } }], leafId: "deadbeef" },
        prompt: async () => {}, waitForAgentStart: async () => {}, bindRun: () => {},
        persistRunStarted: async () => { trace.push("started"); if (++persistAttempts < 3) throw new Error("raw persistence detail"); },
        waitSettled: () => new Promise<never>(() => {}),
        runtime: { abort: async () => {}, contain: async () => { trace.push("contain"); containments++; return testVerifiedReceiptPath(String(session.containmentReceiptPath)); } },
      }) }),
      prepareSend: async () => { throw new Error("unused"); },
      finaliseRun: async (record, settlement) => {
        trace.push("completed");
        completions++;
        if (settlement.kind !== "failed") throw new Error("expected failure");
        return { agentId: record.agentId, runId: record.runId!, state: CompletionState.Failed, error: settlement.cause,
          output: truncateUtf8("", 50_000), outputPath: testCommittedOutputPath("/tmp/pi-subagents-test/post-id-retry.output.md"), transcriptPath: record.transcriptPath };
      },
    } });

    await expect(c.spawn({ task: "first" })).resolves.toMatchObject({ runId: runId("deadbeef"), state: AgentState.Settling, error: { code: "spawn_failed" } });
    expect(c.runs.snapshot(session.agentId)).toMatchObject({ state: AgentState.Settling, runId: runId("deadbeef") });
    expect(c.runs.activeCount()).toBe(1);
    expect(c.completions.queuedCount()).toBe(0);
    expect(await c.stop(session.agentId)).toMatchObject({ state: "already_stopped" });
    expect(persistAttempts).toBe(3);
    expect(containments).toBe(1);
    expect(completions).toBe(1);
    expect(trace).toEqual(["started", "contain", "started", "started", "completed"]);
    expect((await c.receive()).completions).toHaveLength(1);
  });

  test("permanent post-identity RunStarted failure contains once and retains the terminal obligation", async () => {
    const trace: string[] = [];
    const session: LaunchSession = { agentId: agentId("post-id-permanent"), transcriptPath: testSessionPath("/tmp/pi-subagents-test/post-id-permanent"),
      previousLeafId: null, attemptId: testAttemptId("attempt-post-id-permanent"), containmentReceiptPath: testReceiptPath("/tmp/pi-subagents-test/post-id-permanent.receipt") };
    const c = new SubagentController({ composition: {
      prepareSpawn: async () => ({ selection: TEST_SELECTION, createSession: async () => session, persistSpawned: async () => {}, createLaunch: async () => ({
        containment: { backend: "cgroup-v2" as const, scopePath: testAbsolutePath("/tmp/test-cgroup/attempt") },
        ready: async () => {}, persistLaunchRequested: async () => {}, start: async () => {},
        getEntries: async (since?: string | null) => since === undefined ? { entries: [], leafId: null }
          : { entries: [{ id: "deadbeef", type: "message", message: { role: "user", content: "first" } }], leafId: "deadbeef" },
        prompt: async () => {}, waitForAgentStart: async () => {}, bindRun: () => {},
        persistRunStarted: async () => { trace.push("started"); throw new Error("permanent append failure"); },
        waitSettled: () => new Promise<never>(() => {}),
        runtime: { abort: async () => {}, contain: async () => { trace.push("contain"); return testVerifiedReceiptPath(String(session.containmentReceiptPath)); } },
      }) }),
      prepareSend: async () => { throw new Error("unused"); },
      finaliseRun: async () => { trace.push("completed"); throw new Error("must not finalise"); },
    } });

    await expect(c.spawn({ task: "first" })).resolves.toMatchObject({ runId: runId("deadbeef"), state: AgentState.Settling, error: { code: "spawn_failed" } });
    expect(c.runs.snapshot(session.agentId)).toMatchObject({ state: AgentState.Settling, runId: runId("deadbeef") });
    expect(c.runs.activeCount()).toBe(1);
    expect(c.completions.queuedCount()).toBe(0);

    await expect(c.stop(session.agentId)).resolves.toMatchObject({ state: "failed", agentState: AgentState.Settling, error: { code: "terminal_persistence_failed" } });
    expect(trace).toEqual(["started", "contain", "started", "started"]);
    expect(c.runs.activeCount()).toBe(1);
    expect(c.completions.queuedCount()).toBe(0);
  });

  for (const seam of postIdentitySeams) for (const operation of ["spawn", "send"] as const) {
    for (const contender of ["stop", "shutdown"] as const) {
      test(`post-identity ${seam} failure owns settlement before the ${operation} ${contender} contender`, async () => {
        const suffix = `${seam}-${operation}-${contender}`;
        const id = agentId(`race-${suffix}`);
        const session: LaunchSession = { agentId: id, transcriptPath: testSessionPath(`/tmp/pi-subagents-test/${suffix}`),
          previousLeafId: null, attemptId: testAttemptId(`attempt-${suffix}`), containmentReceiptPath: testReceiptPath(`/tmp/pi-subagents-test/${suffix}.receipt`) };
        const admitted = testBarrier(`post-identity-${suffix}`);
        const trace: string[] = [];
        let startedAttempts = 0;
        const makeTransport = (): LaunchTransport => {
          let assignment = "";
          return {
          containment: { backend: "cgroup-v2" as const, scopePath: testAbsolutePath("/tmp/test-cgroup/attempt") },
          ready: async () => {}, persistLaunchRequested: async () => {}, start: async () => {},
          getEntries: async (since?: string | null) => {
            if (since === undefined) return { entries: [], leafId: null };
            await admitted.enterAndWait();
            return { entries: [{ id: "deadbeef", type: "message", message: { role: "user", content: assignment } }], leafId: "deadbeef" };
          },
          prompt: async (message) => { assignment = message; },
          waitForAgentStart: async () => {},
          bindRun: () => { if (seam === "bindRun") throw new Error("bind failed"); },
          persistRunStarted: async () => {
            trace.push("started");
            if (seam === "persistRunStarted" && ++startedAttempts === 1) throw new Error("started failed");
          },
          waitSettled: () => { if (seam === "waitSettled") throw new Error("subscription failed"); return new Promise<never>(() => {}); },
          runtime: {
            abort: async () => { trace.push("abort"); },
            contain: async () => { trace.push("contain"); return testVerifiedReceiptPath(String(session.containmentReceiptPath)); },
          },
        };
        };
        const c = new SubagentController({ composition: {
          prepareSpawn: async () => ({ selection: TEST_SELECTION, createSession: async () => session, persistSpawned: async () => {}, createLaunch: async () => makeTransport() }),
          prepareSend: async () => ({ session, createLaunch: async () => makeTransport() }),
          persistStopping: async () => { trace.push("stopping"); },
          finaliseRun: async (record, settlement) => {
            trace.push(`completed:${settlement.kind}`);
            if (settlement.kind !== "failed") throw new Error("expected failed settlement");
            return { agentId: record.agentId, runId: record.runId!, state: CompletionState.Failed, error: settlement.cause,
              output: truncateUtf8("", 50_000), outputPath: testCommittedOutputPath(`/tmp/pi-subagents-test/${suffix}.output.md`), transcriptPath: record.transcriptPath };
          },
        } });
        if (operation === "send") c.runs.register({ agentId: id, state: AgentState.Stopped, transcriptPath: session.transcriptPath });
        const launching = operation === "spawn" ? c.spawn({ task: "first" }) : c.sendInput(id, "next");
        await admitted.entered;
        const competing = contender === "stop" ? c.stop(id) : c.shutdown();
        admitted.release();

        await expect(launching).resolves.toMatchObject({ agentId: id, runId: runId("deadbeef"), state: AgentState.Settling, error: { code: "spawn_failed" } });
        if (contender === "stop") await expect(competing).resolves.toMatchObject({ agentId: id, state: "already_stopped" });
        else await expect(competing).resolves.toBeUndefined();
        expect(trace).toEqual(seam === "bindRun"
          ? ["contain", "started", "completed:failed"]
          : seam === "persistRunStarted"
            ? ["started", "contain", "started", "completed:failed"]
            : ["started", "contain", "completed:failed"]);
        expect(c.runs.snapshot(id)).toMatchObject({ state: AgentState.Stopped, runId: runId("deadbeef") });
        expect(c.runs.activeCount()).toBe(0);
        expect((await c.receive()).completions).toEqual([expect.objectContaining({ runId: runId("deadbeef"), state: CompletionState.Failed })]);
      });
    }
  }

  test("runtime back-pings use followUp while busy and triggerTurn while idle, once per epoch", async () => {
    const sent: object[] = [];
    let busy = true;
    const c = new SubagentController({ parent: { isBusy: () => busy, sendMessage: async (_text, options) => { sent.push(options); } } });
    await c.publish(completion("deadbeef"));
    await c.publish(completion("cafebabe"));
    expect(sent).toEqual([{ deliverAs: "followUp", triggerTurn: false }]);
    await c.receive();
    busy = false;
    await c.publish(completion("facefeed"));
    expect(sent[1]).toEqual({ deliverAs: "followUp", triggerTurn: true });
  });

  test("ping failure does not duplicate queue publication and can be retried", async () => {
    let pings = 0;
    const c = new SubagentController({ parent: { isBusy: () => false, sendMessage: async () => { if (++pings === 1) throw new Error("ping failed"); } } });
    const value = completion("deadbeef");
    await expect(c.publish(value)).resolves.toBeUndefined();
    expect(c.completions.queuedCount()).toBe(1);
    await expect(c.publish(value)).resolves.toBeUndefined();
    expect(c.completions.queuedCount()).toBe(1);
    expect(pings).toBe(2);
  });

  test("restoration emits nextTurn without triggering a turn", async () => {
    const sent: object[] = [];
    const c = new SubagentController({ parent: { isBusy: () => false, sendMessage: async (_text, options) => { sent.push(options); } } });
    c.completions.restore([{ agentId: agentId("a"), state: AgentState.Stopped, sessionPath: testSessionPath("/tmp/pi-subagents-test/a"), latestCompletion: completion("deadbeef") }]);
    await c.notifyRestored(1);
    expect(sent).toEqual([{ deliverAs: "nextTurn", triggerTurn: false }]);
  });

  test("tree blocks active ownership and switch/fork warn", async () => {
    const warnings: string[] = [];
    const c = new SubagentController({ parent: { isBusy: () => false, sendMessage: async () => {}, warn: (message) => { warnings.push(message); } } });
    c.runs.restore([{ agentId: agentId("a"), state: AgentState.Running, transcriptPath: testSessionPath("/tmp/pi-subagents-test/a"), runId: runId("deadbeef") }]);
    expect(c.beforeTree()).toBeFalse();
    expect(c.beforeSwitch()).toBeTrue();
    expect(c.beforeFork()).toBeTrue();
    expect(warnings).toHaveLength(3);
  });
});

function completion(id: string) {
  return completedCompletion({
    agentId: testAgentId("a"),
    runId: testRunId(id),
    output: truncateUtf8("ok", 50_000),
    outputPath: testCommittedOutputPath(`/tmp/pi-subagents-test/${id}.md`),
    transcriptPath: testSessionPath("/tmp/pi-subagents-test/a"),
  });
}
function unresolvedContainment() {
  return {
    kind: "unresolved-historical" as const,
    runtime: { abort: async () => {}, contain: async () => { throw new Error("unavailable"); } },
  };
}

function surrenderSession(suffix: string): LaunchSession {
  return launchSession(suffix, {
    transcriptPath: testSessionPath(`/tmp/pi-subagents-test/${suffix}`),
    containmentReceiptPath: testReceiptPath(`/tmp/pi-subagents-test/${suffix}.receipt`),
  });
}
function transport(session: LaunchSession, contained: () => void): LaunchTransport {
  return runningTransport(session, {
    waitSettled: () => new Promise<never>(() => {}),
    runtime: testRuntime({ contain: async () => {
      contained();
      return testVerifiedReceiptPath(String(session.containmentReceiptPath));
    } }),
  });
}
