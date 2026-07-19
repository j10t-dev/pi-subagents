import { describe, expect, test } from "bun:test";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import { AgentEventAppender } from "../src/persistence.ts";
import { firstUserEntryAfterCursor } from "../src/pi-composition.ts";
import { SubagentController, type RestorationPort } from "../src/controller.ts";
import { testAbsolutePath, testAgentId, testAttemptId, testCommittedOutputPath, testMilliseconds, testModelSpec, testReceiptPath, testRunId, testSessionPath, testVerifiedReceiptPath } from "./support/brands.ts";
import { testBarrier } from "./support/barriers.ts";
import { testRuntime } from "./support/launches.ts";
import { completedEntry, launchEntry, spawnedEntry, startedEntry, stoppingEntry, testRestorationPort, type RestorationEventEntry } from "./support/restoration.ts";
import { completedCompletion } from "./support/messages.ts";
import { AgentEventType, CancellationReason, CompletionState, agentId, runId, truncateUtf8 } from "../src/domain.ts";

describe("branch restoration", () => {
  test("a missing non-null restoration cursor is session unavailable and never scans from zero", () => {
    const entries = [{ id: "deadbeef", type: "message", message: { role: "user" } }];
    // malformed trust-boundary fixture: Pi entry decoding must reject this incomplete wire value.
    const malformedEntries = entries as unknown as SessionEntry[];
    expect(() => firstUserEntryAfterCursor(malformedEntries, testRunId("cafebabe"))).toThrow("session_unavailable");
  });
  test("receipt decision completes before shutdown", async () => {
    const deciding = testBarrier("receipt-decision-first");
    let completeDecision!: () => void;
    const decisionCompleted = new Promise<void>((resolve) => { completeDecision = resolve; });
    const writes: unknown[] = [], pings: unknown[] = [];
    const order: string[] = [];
    let validations = 0;
    const restoration = port([spawned(), launch(), started()], false, writes);
    // The first decision is the restoration receipt; later calls are the shutdown containment retry.
    restoration.validateReceipt = async () => {
      if (++validations > 1) return true;
      await deciding.enterAndWait();
      return false;
    };
    const resolveContainment = restoration.resolveContainment.bind(restoration);
    restoration.resolveContainment = async (input) => {
      const decision = await resolveContainment(input);
      order.push("receipt-decision:constructed");
      completeDecision();
      return decision;
    };
    const c = new SubagentController({ restoration, parent: { isBusy: () => false, sendMessage: async (_text, options) => { pings.push(options); } } });

    // Minimal pair with the row below: the decision is released *before* shutdown starts,
    // but shutdown still overlaps the in-flight restoration — it must join it, not race it.
    const restoring = c.restore();
    await deciding.entered;
    expect(validations).toBe(1);
    deciding.release();
    await decisionCompleted;
    order.push("shutdown:started");
    const shuttingDown = c.shutdown();
    await Promise.all([restoring, shuttingDown]);

    expect(order).toEqual(["receipt-decision:constructed", "shutdown:started"]);
    expect({ validations, writes: writes.length, active: c.runs.activeCount(), queued: c.completions.queuedCount(), pings: pings.length })
      .toEqual({ validations: 2, writes: 1, active: 0, queued: 1, pings: 0 });
    expect(c.runs.snapshots()).toMatchObject([{ state: "stopped" }]);
  });

  test("shutdown starts before receipt decision", async () => {
    const deciding = testBarrier("receipt-decision");
    const writes: unknown[] = [], pings: unknown[] = [];
    let validations = 0;
    const restoration = port([spawned(), launch(), started()], false, writes);
    restoration.validateReceipt = async () => {
      if (++validations > 1) return true;
      await deciding.enterAndWait();
      return false;
    };
    const c = new SubagentController({ restoration, parent: { isBusy: () => false, sendMessage: async (_text, options) => { pings.push(options); } } });

    const restoring = c.restore();
    await deciding.entered;
    const shuttingDown = c.shutdown();
    deciding.release();
    await Promise.all([restoring, shuttingDown]);

    expect({ validations, writes: writes.length, active: c.runs.activeCount(), queued: c.completions.queuedCount(), pings: pings.length })
      .toEqual({ validations: 2, writes: 1, active: 0, queued: 1, pings: 0 });
    expect(c.runs.snapshots()).toMatchObject([{ state: "stopped" }]);
  });

  test("restoration stages before shutdown and commits", async () => {
    const committing = testBarrier("restore-commit");
    const writes: unknown[] = [], pings: unknown[] = [];
    const restoration = port([spawned(), launch(), started()], true, writes);
    const appendCompleted = restoration.appender.appendRunCompleted.bind(restoration.appender);
    restoration.appender.appendRunCompleted = async (completion) => {
      await committing.enterAndWait();
      return appendCompleted(completion);
    };
    const c = new SubagentController({ restoration, parent: { isBusy: () => false, sendMessage: async (_text, options) => { pings.push(options); } } });

    const restoring = c.restore();
    await committing.entered;
    const shuttingDown = c.shutdown();
    committing.release();
    await Promise.all([restoring, shuttingDown]);

    expect(writes.map((value) => (value as { eventType: string }).eventType)).toEqual([AgentEventType.RunCompleted]);
    expect({ active: c.runs.activeCount(), queued: c.completions.queuedCount(), pings: pings.length })
      .toEqual({ active: 0, queued: 1, pings: 0 });
    expect(c.runs.snapshots()).toMatchObject([{ state: "stopped" }]);
  });

  test("restoration stages before shutdown and rolls back", async () => {
    const committing = testBarrier("restore-commit-rollback");
    const writes: unknown[] = [], pings: unknown[] = [];
    let attempts = 0;
    const restoration = port([spawned(), launch(), started()], true, writes);
    const appendCompleted = restoration.appender.appendRunCompleted.bind(restoration.appender);
    restoration.appender.appendRunCompleted = async (completion) => {
      if (++attempts > 1) return appendCompleted(completion);
      await committing.enterAndWait();
      throw new Error("disk unavailable");
    };
    const c = new SubagentController({ restoration, parent: { isBusy: () => false, sendMessage: async (_text, options) => { pings.push(options); } } });

    const restoring = c.restore();
    await committing.entered;
    const shuttingDown = c.shutdown();
    committing.release();

    await expect(restoring).rejects.toThrow("disk unavailable");
    await expect(shuttingDown).resolves.toBeUndefined();
    expect(writes.map((value) => (value as { eventType: string }).eventType)).toEqual([AgentEventType.RunCompleted]);
    expect({ attempts, active: c.runs.activeCount(), queued: c.completions.queuedCount(), pings: pings.length })
      .toEqual({ attempts: 2, active: 0, queued: 1, pings: 0 });
    expect(c.runs.snapshots()).toMatchObject([{ state: "stopped" }]);
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
      return { ...completedCompletion({ runId: id }), state: CompletionState.Failed, error: { code: "run_interrupted", message: "run was interrupted before completion" } };
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
    expect(c.runs.snapshot(testAgentId("agent-a"))?.state).toBe("settling");
    expect(c.runs.activeCount()).toBe(1);
    expect(writes).toEqual([]);
    expect((await c.receive({ timeoutMs: testMilliseconds(1) })).completions).toEqual([]);

    await c.stop(testAgentId("agent-a"));
    expect(c.runs.activeCount()).toBe(0);
    expect(writes).toHaveLength(1);
    expect((await c.receive()).completions).toHaveLength(1);
  });

  test("unresolved v1 launch retains historical responsibility without inspecting native identity", async () => {
    const warnings: string[] = [];
    let identityLookups = 0;
    const restoration = port([spawned(), launch()], false, []);
    restoration.firstUserEntryAfter = async () => { identityLookups++; return testRunId("cafebabe"); };
    const c = new SubagentController({
      capacity: 1,
      restoration,
      parent: { isBusy: () => false, sendMessage: async () => {}, warn: (message) => warnings.push(message) },
    });

    await c.restore();

    expect(c.runs.snapshot(testAgentId("agent-a"))).toMatchObject({
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
            return testVerifiedReceiptPath(input.receiptPath);
          },
        },
      };
    };
    const c = new SubagentController({ capacity: 1, restoration });

    await c.restore();
    expect(containmentAttempts).toBe(1);
    expect(c.runs.activeCount()).toBe(1);
    expect(c.runs.snapshot(testAgentId("agent-a"))?.state).toBe("settling");

    await c.stop(testAgentId("agent-a"));
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
    const c = new SubagentController({ restoration: port([spawned(), launch()], true, writes, testRunId("cafebabe")) });
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
    expect((await c.receive({ timeoutMs: testMilliseconds(1) })).completions).toEqual([]);
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
      if (receiptValid) return { kind: "contained", receipt: testVerifiedReceiptPath(input.receiptPath) };
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
    expect(c.runs.snapshot(testAgentId("agent-a"))?.state).toBe("settling");
    expect((await c.receive({ timeoutMs: testMilliseconds(1) })).completions).toEqual([]);
    let resumed = false;
    await expect(c.runs.launch(testAgentId("agent-a"), async () => {
      resumed = true;
      throw new Error("must not resume");
    })).rejects.toThrow("invalid_state:");
    expect(resumed).toBeFalse();

    receiptValid = true;
    await Promise.all([
      c.stop(testAgentId("agent-a")),
      c.stop(testAgentId("agent-a")),
    ]);

    expect(resolutions).toBe(2);
    expect(failedContainments).toBe(version === 2 ? 1 : 0);
    expect(finalisations).toBe(0);
    expect(writes).toEqual([]);
    expect(releases).toBe(1);
    expect(c.runs.activeCount()).toBe(0);
    const restored = await c.receive();
    expect(restored.completions).toMatchObject([{
      agentId: testAgentId("agent-a"),
      runId: testRunId("deadbeef"),
      state: CompletionState.Completed,
      output: { text: "", originalBytes: 0, retainedBytes: 0, truncated: false },
    }]);
    expect((await c.receive()).completions).toEqual([]);
  });

  test("receipt validation errors retain nonterminal state", async () => {
    const warnings: string[] = [];
    const restoration = port([spawned(), launch()], true, []);
    restoration.validateReceipt = async () => { throw new Error("malformed receipt"); };
    const c = new SubagentController({ restoration, parent: { isBusy: () => false, sendMessage: async () => {}, warn: (message) => warnings.push(message) } });
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
    expect(await c.stop(testAgentId("agent-a"))).toMatchObject({ state: "failed", agentState: "stopping" });
    valid = true;
    await Promise.all([c.stop(testAgentId("agent-a")), c.shutdown()]);
    expect(c.runs.snapshots()).toMatchObject([{ agentId: testAgentId("agent-a"), state: "stopped", transcriptPath: "/tmp/pi-subagents-test/a.jsonl" }]);
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
    const restoration = port([spawned(), launch()], false, writes, testRunId("cafebabe"));
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
    expect(c.runs.snapshot(testAgentId("agent-a"))?.state).toBe("stopping");
    expect(c.runs.activeCount()).toBe(1);
    expect(cursorReconciliations).toBe(0);

    valid = true;
    await c.stop(testAgentId("agent-a"));

    expect(c.runs.snapshot(testAgentId("agent-a"))).toMatchObject({ state: "stopped", runId: testRunId("cafebabe") });
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
    expect(await c.stop(testAgentId("agent-a"))).toMatchObject({ state: "failed", agentState: "settling", error: { code: "containment_failed" } });
    expect(writes).toHaveLength(0);
    valid = true;
    expect(await c.stop(testAgentId("agent-a"))).toMatchObject({ state: "already_stopped" });
    expect(writes).toHaveLength(1);
    expect((await c.receive()).completions).toMatchObject([{ state: "failed", runId: "deadbeef" }]);
    expect(c.runs.activeCount()).toBe(0);
  });

  test("an unavailable child session after verified containment retains nonterminal state", async () => {
    const warnings: string[] = [];
    const restoration = port([spawned(), launch()], true, []);
    restoration.firstUserEntryAfter = async () => { throw new Error("session unavailable"); };
    const c = new SubagentController({ restoration, parent: { isBusy: () => false, sendMessage: async () => {}, warn: (message) => warnings.push(message) } });
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
    const c = new SubagentController({ restoration });
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

  test("a second restore caller joins the in-flight receipt decision and shares one durable record, reservation, completion, and next-turn ping", async () => {
    let validations = 0;
    const deciding = testBarrier("shared-receipt-decision");
    const writes: unknown[] = [], pings: unknown[] = [];
    const restoration = port([spawned(), launch(), started()], true, writes);
    restoration.validateReceipt = async () => { validations++; await deciding.enterAndWait(); return true; };
    const c = new SubagentController({ restoration, parent: {
      isBusy: () => false,
      sendMessage: async (_text, options) => { pings.push(options); },
    } });

    const first = c.restore();
    await deciding.entered;
    const second = c.restore();
    deciding.release();
    await Promise.all([first, second]);

    expect(validations).toBe(1);
    expect(writes).toHaveLength(1);
    expect(c.runs.snapshots()).toHaveLength(1);
    expect(c.runs.activeCount()).toBe(0);
    expect(c.completions.queuedCount()).toBe(1);
    expect(pings).toEqual([{ deliverAs: "nextTurn", triggerTurn: false }]);
  });

  test("restore failure clears the in-flight promise and retry does not duplicate durable appends", async () => {
    const writes: unknown[] = [];
    let completionAttempts = 0;
    const restoration = port([spawned(), launch()], true, writes, testRunId("cafebabe"));
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
    await c.stop(testAgentId("agent-a"));
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
      const restoration = port([spawned(), launch()], false, writes, testRunId("cafebabe"));
      restoration.validateReceipt = async () => decisions[calls++]!;
      const appendCompleted = restoration.appender.appendRunCompleted.bind(restoration.appender);
      restoration.appender.appendRunCompleted = async (completion) => {
        if (++completionAttempts === 1) throw new Error("disk unavailable");
        return appendCompleted(completion);
      };
      const c = new SubagentController({ capacity: 1, restoration });

      if (decisions[0]) {
        await expect(c.restore()).rejects.toThrow("disk unavailable");
        await c.stop(testAgentId("agent-a"));
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
    await c.stop(testAgentId("agent-a"));
    expect(c.runs.activeCount()).toBe(1);
    await expect(c.runs.spawnNew(async () => { throw new Error("must not run"); })).rejects.toThrow("capacity_exceeded:");
    await c.stop(testAgentId("agent-b"));
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
    await c.stop(testAgentId("agent-b"));
    await c.stop(testAgentId("agent-c"));
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
        expect((await c.receive({ timeoutMs: testMilliseconds(1) })).completions).toEqual([]);
      }
    });
  }
});

function spawned() { return spawnedEntry({ agentId: testAgentId(), sessionPath: testSessionPath("/tmp/pi-subagents-test/a.jsonl"), cwd: testAbsolutePath("/tmp"), provider: "p", modelId: testModelSpec("m"), tools: [] }, 1); }
function spawnedFor(id: string, path: string) { return spawnedEntry({ agentId: testAgentId(id), sessionPath: testSessionPath(`/tmp/pi-subagents-test/${path.split("/").at(-1)!}`), cwd: testAbsolutePath("/tmp"), provider: "p", modelId: testModelSpec("m"), tools: [] }, 1); }
function launch(attemptId = "attempt") { return launchEntry({ agentId: testAgentId(), attemptId: testAttemptId(attemptId), containmentReceiptPath: testReceiptPath(`/tmp/pi-subagents-test/${attemptId}.receipt`) }, 1); }
function launchV2(attemptId = "attempt") { return launchEntry({ agentId: testAgentId(), attemptId: testAttemptId(attemptId), containmentReceiptPath: testReceiptPath(`/tmp/pi-subagents-test/${attemptId}.receipt`), containment: { backend: "cgroup-v2", scopePath: testAbsolutePath(`/tmp/cgroups/agent-a/${attemptId}`) } }, 2); }
function launchFor(id: string, attemptId: string) { return launchEntry({ agentId: testAgentId(id), attemptId: testAttemptId(attemptId), containmentReceiptPath: testReceiptPath(`/tmp/pi-subagents-test/${attemptId}.receipt`) }, 1); }
function started(id = "deadbeef", attemptId = "attempt") { return startedEntry({ agentId: testAgentId(), runId: testRunId(id), attemptId: testAttemptId(attemptId) }, 1); }
function startedV2(id = "deadbeef", attemptId = "attempt") { return startedEntry({ agentId: testAgentId(), runId: testRunId(id), attemptId: testAttemptId(attemptId) }, 2); }
function startedFor(id: string, nativeRunId: string, attemptId: string) { return startedEntry({ agentId: testAgentId(id), runId: testRunId(nativeRunId), attemptId: testAttemptId(attemptId) }, 1); }
function stopping(reason: CancellationReason) { return stoppingEntry({ reason, containmentReceiptPath: testReceiptPath("/tmp/pi-subagents-test/attempt.receipt") }, 1); }
function completed(id = "deadbeef") {
  return completedEntry({
    runId: testRunId(id), transcriptPath: testSessionPath("/tmp/pi-subagents-test/a.jsonl"),
    outputPath: testCommittedOutputPath(`/tmp/pi-subagents-test/${id}.md`), output: truncateUtf8("", 50_000),
  }, 1);
}
function completedV2(id = "deadbeef") {
  return completedEntry({
    runId: testRunId(id), transcriptPath: testSessionPath("/tmp/pi-subagents-test/a.jsonl"),
    outputPath: testCommittedOutputPath(`/tmp/pi-subagents-test/${id}.md`), output: truncateUtf8("", 50_000),
  }, 2);
}

type TestRestorationPort = RestorationPort & {
  validateReceipt(path: unknown, attemptId: unknown): Promise<boolean>;
};

function port(branch: RestorationEventEntry[], valid: boolean, writes: unknown[], found?: ReturnType<typeof testRunId>, attempts?: string[]): TestRestorationPort {
  const appender = new AgentEventAppender((_type, data) => { writes.push(data); });
  let result!: TestRestorationPort;
  result = Object.assign(testRestorationPort({
    stateRoot: testAbsolutePath("/tmp"),
    getBranch: () => branch,
    resolveContainment: async (input) => {
      if (await result.validateReceipt(input.receiptPath, input.attemptId)) return { kind: "contained", receipt: testVerifiedReceiptPath(input.receiptPath) };
      return {
        kind: "unresolved-historical",
        runtime: testRuntime({ contain: async () => {
          if (!await result.validateReceipt(input.receiptPath, input.attemptId)) throw new Error("containment receipt unavailable");
          return testVerifiedReceiptPath(input.receiptPath);
        } }),
      };
    },
    firstUserEntryAfter: async () => found,
    finaliseContained: async (_record, id, settlement) => settlement.kind === "cancelled"
      ? { ...completedCompletion({ runId: id }), state: CompletionState.Cancelled, reason: settlement.reason }
      : { ...completedCompletion({ runId: id }), state: CompletionState.Failed, error: { code: "run_interrupted", message: "run was interrupted before completion" } },
    appender,
  }), {
    validateReceipt: async (_path: unknown, attemptId: unknown) => { attempts?.push(String(attemptId)); return valid; },
  });
  return result;
}
