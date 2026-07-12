import { describe, expect, test } from "bun:test";
import { AGENT_EVENT_CUSTOM_TYPE } from "../src/constants.ts";
import { AgentEventAppender } from "../src/persistence.ts";
import { firstUserEntryAfterCursor } from "../src/pi-composition.ts";
import { SubagentController, type RestorationPort } from "../src/controller.ts";
import { AgentEventType, CancellationReason, CompletionState, agentId, runId, truncateUtf8 } from "../src/domain.ts";

describe("branch restoration", () => {
  test("a missing non-null restoration cursor is session unavailable and never scans from zero", () => {
    const entries = [{ id: "deadbeef", type: "message", message: { role: "user" } }];
    expect(() => firstUserEntryAfterCursor(entries as never, "cafebabe" as never)).toThrow("session_unavailable");
  });
  test("100 restore/shutdown barriers either contain the restored owner or prevent restore mutation", async () => {
    for (let schedule = 0; schedule < 100; schedule++) {
      const entered = deferred<void>();
      const decide = deferred<boolean>();
      let validations = 0;
      const restoration = port([spawned(), launch(), started()], false, []);
      restoration.validateReceipt = async () => {
        if (++validations === 1) { entered.resolve(); return decide.promise; }
        return true;
      };
      const c = new SubagentController({ restoration });
      const restoring = c.restore();
      await entered.promise;
      let shuttingDown: Promise<void>;
      if (schedule % 4 === 0) {
        decide.resolve(false);
        shuttingDown = c.shutdown();
      } else if (schedule % 4 === 1) {
        shuttingDown = c.shutdown();
        decide.resolve(false);
      } else if (schedule % 4 === 2) {
        queueMicrotask(() => decide.resolve(false));
        shuttingDown = c.shutdown();
      } else {
        shuttingDown = c.shutdown();
        await Promise.resolve();
        decide.resolve(false);
      }
      await Promise.all([restoring, shuttingDown]);
      expect(c.runs.activeCount()).toBe(0);
      expect(c.runs.snapshots()).toMatchObject([{ state: "stopped" }]);
    }
  });

  test("restore requested after shutdown rejects without reading the branch", async () => {
    let reads = 0;
    const restoration = port([], true, []);
    restoration.getBranch = () => { reads++; return []; };
    const c = new SubagentController({ restoration });
    await c.shutdown();
    await expect(c.restore()).rejects.toThrow("invalid_state:");
    expect(reads).toBe(0);
  });

  test("restores a clean stopped agent without requiring a receipt", async () => {
    const c = new SubagentController({ restoration: port([spawned()], true, []) });
    await c.restore();
    expect(c.runs.snapshots()).toMatchObject([{ state: "stopped" }]);
    expect((await c.receive()).completions).toEqual([]);
  });

  test("receipt-gates interrupted runs, persists one failure, and reconstructs capacity", async () => {
    const writes: unknown[] = [];
    const branch = [spawned(), launch(), started()];
    const c = new SubagentController({ capacity: 1, restoration: port(branch, true, writes) });
    await c.restore();
    expect(c.runs.activeCount()).toBe(0);
    const received = await c.receive();
    expect(received.completions[0]?.runId as string | undefined).toBe("deadbeef");
    expect(received.completions[0]?.state).toBe("failed");
    expect(writes).toHaveLength(1);
  });

  test("orders restored completion persistence after durable output finalisation", async () => {
    const trace: string[] = [];
    const writes: unknown[] = [];
    const restoration = port([spawned(), launch(), started()], true, writes);
    restoration.validateReceipt = async () => { trace.push("receipt:verified"); return true; };
    restoration.finaliseContained = async (_record, id) => {
      trace.push("transcript:recovered", "output:file-sync", "output:rename", "output:directory-sync");
      return { ...base(id), state: CompletionState.Failed, error: { code: "run_interrupted", message: "run was interrupted before completion" } };
    };
    const append = restoration.appender.appendRunCompleted.bind(restoration.appender);
    restoration.appender.appendRunCompleted = async (completion) => { trace.push("persist:run-completed"); await append(completion); };

    const c = new SubagentController({ restoration });
    await c.restore();

    expect(trace).toEqual([
      "receipt:verified",
      "transcript:recovered",
      "output:file-sync",
      "output:rename",
      "output:directory-sync",
      "persist:run-completed",
    ]);
  });

  test("retains restored terminal ownership and capacity when durable finalisation fails, then retries", async () => {
    const writes: unknown[] = [];
    const restoration = port([spawned(), launch(), started()], true, writes);
    const finalise = restoration.finaliseContained;
    let attempts = 0;
    restoration.finaliseContained = async (...args) => {
      if (++attempts === 1) throw new Error("publication failed");
      return finalise(...args);
    };
    const c = new SubagentController({ capacity: 1, restoration });

    await expect(c.restore()).rejects.toThrow("publication failed");
    expect(c.runs.snapshot(agentId("agent-a"))?.state).toBe("settling");
    expect(c.runs.activeCount()).toBe(1);
    expect(writes).toEqual([]);
    expect((await c.receive({ timeoutMs: 1 as never })).completions).toEqual([]);

    await c.stop(agentId("agent-a"));
    expect(c.runs.activeCount()).toBe(0);
    expect(writes).toHaveLength(1);
    expect((await c.receive()).completions).toHaveLength(1);
  });

  test("unresolved v1 launch retains historical responsibility without inspecting native identity", async () => {
    const warnings: string[] = [];
    let identityLookups = 0;
    const restoration = port([spawned(), launch()], false, []);
    restoration.firstUserEntryAfter = async () => { identityLookups++; return runId("cafebabe"); };
    const c = new SubagentController({
      capacity: 1,
      restoration,
      parent: { isBusy: () => false, sendMessage: async () => {}, warn: (message) => warnings.push(message) },
    });

    await c.restore();

    expect(c.runs.snapshot(agentId("agent-a"))).toMatchObject({
      state: "stopping",
      containmentResponsibility: "historical-unresolved",
    });
    expect(c.runs.activeCount()).toBe(1);
    expect(identityLookups).toBe(0);
    expect(warnings).toHaveLength(1);
  });

  test("unresolved v2 started work contains immediately and retains capacity until retry succeeds", async () => {
    const writes: unknown[] = [];
    const branch = [spawned(), launchV2(), started()];
    const restoration = port(branch, false, writes);
    let containmentAttempts = 0;
    restoration.resolveContainment = async (input) => {
      expect(input.eventVersion).toBe(2);
      expect(input.descriptor?.backend).toBe("cgroup-v2");
      expect(input.descriptor?.scopePath as string | undefined).toBe("/tmp/cgroups/agent-a/attempt");
      return {
        kind: "requires-containment",
        runtime: {
          abort: async () => {},
          contain: async () => {
            containmentAttempts++;
            if (containmentAttempts === 1) throw new Error("cgroup kill failed");
            return input.receiptPath as never;
          },
        },
      };
    };
    const c = new SubagentController({ capacity: 1, restoration });

    await c.restore();
    expect(containmentAttempts).toBe(1);
    expect(c.runs.activeCount()).toBe(1);
    expect(c.runs.snapshot(agentId("agent-a"))?.state).toBe("settling");

    await c.stop(agentId("agent-a"));
    expect(containmentAttempts).toBe(2);
    expect(c.runs.activeCount()).toBe(0);
    expect(writes).toHaveLength(1);
  });

  test("missing receipt retains non-resumable state and capacity without completion", async () => {
    const writes: unknown[] = [];
    const c = new SubagentController({ capacity: 1, restoration: port([spawned(), launch(), started()], false, writes) });
    await c.restore();
    expect(c.runs.activeCount()).toBe(1);
    expect(c.runs.snapshots()[0]?.state).toBe("settling");
    expect(writes).toEqual([]);
  });

  test("unmatched launch uses the first native user entry after its cursor", async () => {
    const writes: unknown[] = [];
    const c = new SubagentController({ restoration: port([spawned(), launch()], true, writes, runId("cafebabe")) });
    await c.restore();
    const received = await c.receive();
    expect(received.completions[0]?.runId as string | undefined).toBe("cafebabe");
    expect(writes).toHaveLength(2);
  });

  test("an unaccepted unmatched launch becomes stopped only after its matching receipt", async () => {
    const writes: unknown[] = [];
    const seen: string[] = [];
    const c = new SubagentController({ restoration: port([spawned(), launch()], true, writes, undefined, seen) });
    await c.restore();
    expect(c.runs.snapshots()[0]?.state).toBe("stopped");
    expect(c.runs.activeCount()).toBe(0);
    expect(writes).toEqual([]);
    expect(seen).toEqual(["attempt"]);
  });

  for (const reason of [CancellationReason.StopRequested, CancellationReason.ParentShutdown]) {
    test(`restores unmatched stopping as ${reason} cancellation`, async () => {
      const writes: unknown[] = [];
      const c = new SubagentController({ restoration: port([spawned(), launch(), started(), stopping(reason)], true, writes) });
      await c.restore();
      expect((await c.receive()).completions).toMatchObject([{ state: "cancelled", reason }]);
      expect(writes).toHaveLength(1);
      expect(c.runs.activeCount()).toBe(0);
    });
  }

  test("re-exposes only the latest completion and uses a non-triggering next-turn ping", async () => {
    const pings: unknown[] = [];
    const branch = [spawned(), launch(), started(), completed("deadbeef"), launch("attempt-2"), started("feedface", "attempt-2"), completed("feedface")];
    const c = new SubagentController({ restoration: port(branch, true, []), parent: { isBusy: () => false, sendMessage: async (_text, options) => { pings.push(options); } } });
    await c.restore();
    expect((await c.receive()).completions.map((value) => value.runId as string)).toEqual(["feedface"]);
    expect(pings).toEqual([{ deliverAs: "nextTurn", triggerTurn: false }]);
  });

  test("invalid latest-completion receipt retains capacity and does not expose completion", async () => {
    const warnings: string[] = [];
    const c = new SubagentController({ capacity: 1, restoration: port([spawned(), launch(), started(), completed()], false, []), parent: { isBusy: () => false, sendMessage: async () => {}, warn: (message) => warnings.push(message) } });
    await c.restore();
    expect(c.runs.activeCount()).toBe(1);
    expect((await c.receive({ timeoutMs: 1 as never })).completions).toEqual([]);
    expect(warnings[0]).toContain("containment_failed");
  });

  test.each([
    ["version 1", 1 as const],
    ["version 2", 2 as const],
  ])("invalid-then-valid completed %s receipt restores the durable completion exactly once", async (_label, version) => {
    const writes: unknown[] = [];
    const branch = version === 1
      ? [spawned(), launch(), started(), completed()]
      : [spawned(), launchV2(), startedV2(), completedV2()];
    const restoration = port(branch, false, writes);
    let receiptValid = false;
    let resolutions = 0;
    let failedContainments = 0;
    let finalisations = 0;
    let releases = 0;
    restoration.resolveContainment = async (input) => {
      resolutions++;
      expect(input.eventVersion).toBe(version);
      expect(input.descriptor?.backend).toBe(version === 2 ? "cgroup-v2" : undefined);
      if (receiptValid) return { kind: "contained", receipt: input.receiptPath as never };
      const runtime = {
        abort: async () => {},
        contain: async () => { failedContainments++; throw new Error("receipt unavailable"); },
      };
      return version === 1
        ? { kind: "unresolved-historical", runtime }
        : { kind: "requires-containment", runtime };
    };
    restoration.finaliseContained = async () => {
      finalisations++;
      throw new Error("must not fabricate an already-durable completion");
    };
    const c = new SubagentController({
      capacity: 1,
      restoration,
      onStatusChange: () => { releases++; },
    });

    await c.restore();

    expect(c.runs.activeCount()).toBe(1);
    expect(c.runs.snapshot(agentId("agent-a"))?.state).toBe("settling");
    expect((await c.receive({ timeoutMs: 1 as never })).completions).toEqual([]);
    let resumed = false;
    await expect(c.runs.launch(agentId("agent-a"), async () => {
      resumed = true;
      throw new Error("must not resume");
    })).rejects.toThrow("invalid_state:");
    expect(resumed).toBeFalse();

    receiptValid = true;
    await Promise.all([
      c.stop(agentId("agent-a")),
      c.stop(agentId("agent-a")),
    ]);

    expect(resolutions).toBe(2);
    expect(failedContainments).toBe(version === 2 ? 1 : 0);
    expect(finalisations).toBe(0);
    expect(writes).toEqual([]);
    expect(releases).toBe(1);
    expect(c.runs.activeCount()).toBe(0);
    const restored = await c.receive();
    expect(restored.completions).toMatchObject([{
      agentId: agentId("agent-a"),
      runId: runId("deadbeef"),
      state: CompletionState.Completed,
      output: { text: "", originalBytes: 0, retainedBytes: 0, truncated: false },
    }]);
    expect((await c.receive()).completions).toEqual([]);
  });

  test("receipt validation errors retain nonterminal state", async () => {
    const warnings: string[] = [];
    const restoration = port([spawned(), launch()], true, []);
    restoration.validateReceipt = async () => { throw new Error("malformed receipt"); };
    const c = new SubagentController({ restoration: restoration as never, parent: { isBusy: () => false, sendMessage: async () => {}, warn: (message) => warnings.push(message) } });
    await c.restore();
    expect(c.runs.activeCount()).toBe(1);
    expect(warnings[0]).toContain("containment_failed");
  });

  test("an unmatched launch with a later valid receipt finishes pre-native containment without a completion", async () => {
    const writes: unknown[] = [];
    let valid = false;
    const restoration = port([spawned(), launch()], false, writes);
    restoration.validateReceipt = async () => valid;
    const c = new SubagentController({ capacity: 1, restoration });
    await c.restore();
    expect(await c.stop(agentId("agent-a"))).toMatchObject({ state: "failed", agentState: "stopping" });
    valid = true;
    await Promise.all([c.stop(agentId("agent-a")), c.shutdown()]);
    expect(c.runs.snapshots()).toMatchObject([{ agentId: agentId("agent-a"), state: "stopped", transcriptPath: "/tmp/a.jsonl" }]);
    expect(c.runs.activeCount()).toBe(0);
    expect(writes).toEqual([]);
    expect((await c.receive()).completions).toEqual([]);
  });

  test("receipt-false-then-true reconciles a historical pre-native cursor and releases capacity", async () => {
    const writes: unknown[] = [];
    let valid = false;
    let cursorReconciliations = 0;
    let restoredFinalisations = 0;
    let liveFinalisations = 0;
    const restoration = port([spawned(), launch()], false, writes, runId("cafebabe"));
    restoration.validateReceipt = async () => valid;
    const firstUserEntryAfter = restoration.firstUserEntryAfter;
    restoration.firstUserEntryAfter = async (...args) => {
      cursorReconciliations++;
      return firstUserEntryAfter(...args);
    };
    const finaliseContained = restoration.finaliseContained;
    restoration.finaliseContained = async (...args) => {
      restoredFinalisations++;
      return finaliseContained(...args);
    };
    const c = new SubagentController({ capacity: 1, restoration, composition: {
      prepareSpawn: async () => { throw new Error("unused"); },
      prepareSend: async () => { throw new Error("unused"); },
      finaliseRun: async () => { liveFinalisations++; throw new Error("must not use live finalisation"); },
    } });

    await c.restore();
    expect(c.runs.snapshot(agentId("agent-a"))?.state).toBe("stopping");
    expect(c.runs.activeCount()).toBe(1);
    expect(cursorReconciliations).toBe(0);

    valid = true;
    await c.stop(agentId("agent-a"));

    expect(c.runs.snapshot(agentId("agent-a"))).toMatchObject({ state: "stopped", runId: runId("cafebabe") });
    expect(c.runs.activeCount()).toBe(0);
    expect(cursorReconciliations).toBe(1);
    expect(restoredFinalisations).toBe(1);
    expect(liveFinalisations).toBe(0);
    expect(writes.map((value) => (value as { eventType: string }).eventType)).toEqual([
      AgentEventType.RunStarted,
      AgentEventType.RunCompleted,
    ]);
    expect((await c.receive()).completions).toMatchObject([{ state: "failed", runId: "cafebabe" }]);
  });

  test("a later valid receipt finalises a restored settling run exactly once", async () => {
    const writes: unknown[] = [];
    let valid = false;
    const restoration = port([spawned(), launch(), started()], false, writes);
    restoration.validateReceipt = async () => valid;
    const c = new SubagentController({ capacity: 1, restoration });
    await c.restore();
    expect(await c.stop(agentId("agent-a"))).toMatchObject({ state: "failed", agentState: "settling", error: { code: "containment_failed" } });
    expect(writes).toHaveLength(0);
    valid = true;
    expect(await c.stop(agentId("agent-a"))).toMatchObject({ state: "already_stopped" });
    expect(writes).toHaveLength(1);
    expect((await c.receive()).completions).toMatchObject([{ state: "failed", runId: "deadbeef" }]);
    expect(c.runs.activeCount()).toBe(0);
  });

  test("an unavailable child session after verified containment retains nonterminal state", async () => {
    const warnings: string[] = [];
    const restoration = port([spawned(), launch()], true, []);
    restoration.firstUserEntryAfter = async () => { throw new Error("session unavailable"); };
    const c = new SubagentController({ restoration: restoration as never, parent: { isBusy: () => false, sendMessage: async () => {}, warn: (message) => warnings.push(message) } });
    await c.restore();
    expect(c.runs.activeCount()).toBe(1);
    expect(c.runs.snapshots()[0]?.state).toBe("stopping");
    expect(warnings[0]).toContain("containment_failed");
  });

  test("waits for the bounded receipt decision before retaining capacity", async () => {
    let decide!: (valid: boolean) => void;
    const barrier = new Promise<boolean>((resolve) => { decide = resolve; });
    const restoration = port([spawned(), launch(), started()], true, []);
    restoration.validateReceipt = async () => barrier;
    const c = new SubagentController({ restoration: restoration as never });
    const restoring = c.restore();
    expect(c.runs.snapshots()).toEqual([]);
    decide(false);
    await restoring;
    expect(c.runs.activeCount()).toBe(1);
  });

  test("repeated restore is idempotent", async () => {
    const writes: unknown[] = [];
    const c = new SubagentController({ restoration: port([spawned(), launch(), started()], true, writes) });
    await c.restore();
    await c.restore();
    expect(writes).toHaveLength(1);
    expect((await c.receive()).completions).toHaveLength(1);
  });

  test("100 restoration schedules expose one durable record, reservation, completion, and next-turn ping", async () => {
    for (let schedule = 0; schedule < 100; schedule++) {
      let validations = 0;
      let decide!: (valid: boolean) => void;
      const barrier = new Promise<boolean>((resolve) => { decide = resolve; });
      const writes: unknown[] = [], pings: unknown[] = [];
      const restoration = port([spawned(), launch(), started()], true, writes);
      restoration.validateReceipt = async () => { validations++; return barrier; };
      const c = new SubagentController({ restoration, parent: {
        isBusy: () => false,
        sendMessage: async (_text, options) => { pings.push(options); },
      } });
      const callers = Array.from({ length: 100 }, () => c.restore());
      decide(true);
      await Promise.all(callers);
      expect(validations).toBe(1);
      expect(writes).toHaveLength(1);
      expect(c.runs.snapshots()).toHaveLength(1);
      expect(c.runs.activeCount()).toBe(0);
      expect(c.completions.queuedCount()).toBe(1);
      expect(pings).toEqual([{ deliverAs: "nextTurn", triggerTurn: false }]);
    }
  });

  test("restore failure clears the in-flight promise and retry does not duplicate durable appends", async () => {
    const writes: unknown[] = [];
    let completionAttempts = 0;
    const restoration = port([spawned(), launch()], true, writes, runId("cafebabe"));
    const appendCompleted = restoration.appender.appendRunCompleted.bind(restoration.appender);
    restoration.appender.appendRunCompleted = async (completion) => {
      completionAttempts++;
      if (completionAttempts === 1) throw new Error("disk unavailable");
      return appendCompleted(completion);
    };
    const c = new SubagentController({ restoration });
    await expect(Promise.all([c.restore(), c.restore()])).rejects.toThrow("disk unavailable");
    expect(c.runs.snapshots()).toMatchObject([{ state: "settling" }]);
    expect(c.runs.activeCount()).toBe(1);
    await c.stop(agentId("agent-a"));
    await c.restore();
    expect(writes).toHaveLength(2);
    expect(writes.map((value) => (value as { eventType: string }).eventType)).toEqual([AgentEventType.RunStarted, AgentEventType.RunCompleted]);
    expect((await c.receive()).completions).toHaveLength(1);
  });

  for (const decisions of [[true, false], [false, true]] as const) {
    test(`retry preserves the staged ${decisions[0]} receipt decision after RunCompleted failure`, async () => {
      const writes: unknown[] = [];
      let calls = 0;
      let completionAttempts = 0;
      const restoration = port([spawned(), launch()], false, writes, runId("cafebabe"));
      restoration.validateReceipt = async () => decisions[calls++]!;
      const appendCompleted = restoration.appender.appendRunCompleted.bind(restoration.appender);
      restoration.appender.appendRunCompleted = async (completion) => {
        if (++completionAttempts === 1) throw new Error("disk unavailable");
        return appendCompleted(completion);
      };
      const c = new SubagentController({ capacity: 1, restoration });

      if (decisions[0]) {
        await expect(c.restore()).rejects.toThrow("disk unavailable");
        await c.stop(agentId("agent-a"));
        expect(writes.map((value) => (value as { eventType: string }).eventType)).toEqual([AgentEventType.RunStarted, AgentEventType.RunCompleted]);
        expect((await c.receive()).completions).toHaveLength(1);
      } else {
        await c.restore();
        expect(writes).toEqual([]);
        expect(c.runs.activeCount()).toBe(1);
      }
      expect(calls).toBe(1);
    });
  }

  test("restores inherited obligations above capacity and releases them only as each terminalises", async () => {
    const writes: unknown[] = [], pings: unknown[] = [];
    let valid = false;
    const branch = [
      spawnedFor("agent-a", "/tmp/a.jsonl"), launchFor("agent-a", "attempt-a"), startedFor("agent-a", "deadbeef", "attempt-a"),
      spawnedFor("agent-b", "/tmp/b.jsonl"), launchFor("agent-b", "attempt-b"), startedFor("agent-b", "cafebabe", "attempt-b"),
    ];
    const restoration = port(branch, false, writes);
    restoration.validateReceipt = async () => valid;
    const c = new SubagentController({ capacity: 1, restoration, parent: {
      isBusy: () => false,
      sendMessage: async (_text, options) => { pings.push(options); },
    } });

    await Promise.all([c.restore(), c.restore()]);
    expect(c.runs.snapshots()).toHaveLength(2);
    expect(c.runs.activeCount()).toBe(2);
    await expect(c.runs.spawnNew(async () => { throw new Error("must not run"); })).rejects.toThrow("capacity_exceeded:");

    valid = true;
    await c.stop(agentId("agent-a"));
    expect(c.runs.activeCount()).toBe(1);
    await expect(c.runs.spawnNew(async () => { throw new Error("must not run"); })).rejects.toThrow("capacity_exceeded:");
    await c.stop(agentId("agent-b"));
    expect(c.runs.activeCount()).toBe(0);
    expect(c.completions.queuedCount()).toBe(2);
    expect(writes).toHaveLength(2);
  });

  test("mixed receipt decisions finalise contained records and retain other inherited ownership", async () => {
    const writes: unknown[] = [], pings: unknown[] = [];
    let secondContained = false;
    const branch = [
      spawnedFor("agent-a", "/tmp/a.jsonl"), launchFor("agent-a", "attempt-a"), startedFor("agent-a", "deadbeef", "attempt-a"),
      spawnedFor("agent-b", "/tmp/b.jsonl"), launchFor("agent-b", "attempt-b"), startedFor("agent-b", "cafebabe", "attempt-b"),
      spawnedFor("agent-c", "/tmp/c.jsonl"), launchFor("agent-c", "attempt-c"), startedFor("agent-c", "facefeed", "attempt-c"),
    ];
    const restoration = port(branch, false, writes);
    restoration.validateReceipt = async (_path, attemptId) => attemptId === "attempt-a" || secondContained;
    const c = new SubagentController({ capacity: 1, restoration, parent: {
      isBusy: () => false,
      sendMessage: async (_text, options) => { pings.push(options); },
    } });

    await c.restore();
    expect(writes).toHaveLength(1);
    expect(c.runs.snapshots()).toHaveLength(3);
    expect(c.runs.activeCount()).toBe(2);
    expect(c.completions.queuedCount()).toBe(1);

    secondContained = true;
    await c.stop(agentId("agent-b"));
    await c.stop(agentId("agent-c"));
    expect(writes).toHaveLength(3);
    expect(c.runs.activeCount()).toBe(0);
    expect(c.completions.queuedCount()).toBe(3);
  });

  for (const decisions of [[true, false], [false, true]] as const) {
    test(`uses one receipt decision when verifier would return ${decisions.join(" then ")}`, async () => {
      let calls = 0;
      const restoration = port([spawned(), launch(), started(), completed()], false, []);
      restoration.validateReceipt = async () => decisions[calls++]!;
      const c = new SubagentController({ capacity: 1, restoration });

      await c.restore();

      expect(calls).toBe(1);
      if (decisions[0]) {
        expect(c.runs.activeCount()).toBe(0);
        expect((await c.receive()).completions).toHaveLength(1);
      } else {
        expect(c.runs.activeCount()).toBe(1);
        expect((await c.receive({ timeoutMs: 1 as never })).completions).toEqual([]);
      }
    });
  }
});

function spawned() { return entry(AgentEventType.Spawned, { agentId: "agent-a", sessionPath: "/tmp/a.jsonl", cwd: "/tmp", provider: "p", modelId: "m", thinkingLevel: "high", tools: [] }); }
function spawnedFor(id: string, sessionPath: string) { return entry(AgentEventType.Spawned, { agentId: id, sessionPath, cwd: "/tmp", provider: "p", modelId: "m", thinkingLevel: "high", tools: [] }); }
function launch(attemptId = "attempt") { return entry(AgentEventType.RunLaunchRequested, { agentId: "agent-a", previousLeafId: null, attemptId, containmentReceiptPath: `/tmp/${attemptId}.receipt` }); }
function launchV2(attemptId = "attempt") {
  return entry(AgentEventType.RunLaunchRequested, {
    agentId: "agent-a",
    previousLeafId: null,
    attemptId,
    containmentReceiptPath: `/tmp/${attemptId}.receipt`,
    containment: { backend: "cgroup-v2", scopePath: `/tmp/cgroups/agent-a/${attemptId}` },
  }, 2);
}
function launchFor(id: string, attemptId: string) { return entry(AgentEventType.RunLaunchRequested, { agentId: id, previousLeafId: null, attemptId, containmentReceiptPath: `/tmp/${attemptId}.receipt` }); }
function started(id = "deadbeef", attemptId = "attempt") { return entry(AgentEventType.RunStarted, { agentId: "agent-a", runId: id, attemptId }); }
function startedV2(id = "deadbeef", attemptId = "attempt") {
  return entry(AgentEventType.RunStarted, { agentId: "agent-a", runId: id, attemptId }, 2);
}
function startedFor(id: string, nativeRunId: string, attemptId: string) { return entry(AgentEventType.RunStarted, { agentId: id, runId: nativeRunId, attemptId }); }
function stopping(reason: CancellationReason) { return entry(AgentEventType.RunStopping, { agentId: "agent-a", runId: "deadbeef", reason, containmentReceiptPath: "/tmp/attempt.receipt" }); }
function completed(id = "deadbeef") { return entry(AgentEventType.RunCompleted, { ...base(runId(id)), state: CompletionState.Completed }); }
function completedV2(id = "deadbeef") {
  return entry(AgentEventType.RunCompleted, { ...base(runId(id)), state: CompletionState.Completed }, 2);
}
function entry(eventType: string, payload: object, schemaVersion: 1 | 2 = 1) {
  return { type: "custom", customType: AGENT_EVENT_CUSTOM_TYPE, data: { schemaVersion, eventType, payload } };
}

type TestRestorationPort = RestorationPort & {
  validateReceipt(path: unknown, attemptId: unknown): Promise<boolean>;
};

function port(branch: ReturnType<typeof entry>[], valid: boolean, writes: unknown[], found?: ReturnType<typeof runId>, attempts?: string[]): TestRestorationPort {
  const appender = new AgentEventAppender((_type, data) => { writes.push(data); });
  const result: TestRestorationPort = {
    stateRoot: "/tmp" as never,
    getBranch: () => branch,
    validateReceipt: async (_path: unknown, attemptId: unknown) => { attempts?.push(String(attemptId)); return valid; },
    resolveContainment: async (input) => {
      if (await result.validateReceipt(input.receiptPath, input.attemptId)) {
        return { kind: "contained", receipt: input.receiptPath as never };
      }
      return {
        kind: "unresolved-historical",
        runtime: {
          abort: async () => {},
          contain: async () => {
            if (!await result.validateReceipt(input.receiptPath, input.attemptId)) throw new Error("containment receipt unavailable");
            return input.receiptPath as never;
          },
        },
      };
    },
    firstUserEntryAfter: async () => found,
    finaliseContained: async (_record: unknown, id: ReturnType<typeof runId>, settlement) => settlement.kind === "cancelled"
      ? ({ ...base(id), state: CompletionState.Cancelled, reason: settlement.reason })
      : ({ ...base(id), state: CompletionState.Failed, error: { code: "run_interrupted", message: "run was interrupted before completion" } }),
    appender,
  };
  return result;
}

function deferred<T>() { let resolve!: (value: T | PromiseLike<T>) => void; const promise = new Promise<T>((r) => { resolve = r; }); return { promise, resolve }; }

function base(id: ReturnType<typeof runId>) { return { agentId: agentId("agent-a"), runId: id, output: truncateUtf8("", 50_000), outputPath: `/tmp/${id}.md` as never, transcriptPath: "/tmp/a.jsonl" as never }; }
