import { describe, expect, test } from "bun:test";
import { spawn as spawnProcess, type ChildProcess } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { SessionManager } from "@earendil-works/pi-coding-agent";

import { CompletionService } from "../src/completion-service.ts";
import type { AgentObservationMutationPort } from "../src/agent-observation-store.ts";
import type { ObservationReconciliationSnapshot, SpawnObservationInput } from "../src/agent-observation.ts";
import { SubagentController, type LaunchTransport, type PiControllerComposition, type RestorationPort, type SurrenderContainment } from "../src/controller.ts";
import type { ContainmentAttempt, ContainmentBackend, ContainmentDescriptor } from "../src/containment.ts";
import {
  AgentErrorCode,
  AgentEventType,
  AgentState,
  CancellationReason,
  CompletionState,
  agentId,
  agentRunKey,
  createRunAttemptId,
  delegationDepth,
  modelSpec,
  observedCgroupScopePath,
  runCapacity,
  runId,
  truncateUtf8,
  utf8Bytes,
  type AgentCompletion,
  type AgentId,
  type ContainmentReceiptPath,
  type RunId,
} from "../src/domain.ts";
import { OutputStore } from "../src/output-store.ts";
import { containmentReceiptPath, sessionPath } from "../src/paths.ts";
import { AgentEventAppender, foldAgentEvents } from "../src/persistence.ts";
import { createProductionController, effectiveToolsForRelaunch } from "../src/pi-composition.ts";
import { buildRpcLaunchSpec, type BuildRpcLaunchOptions } from "../src/pi-launcher.ts";
import { RunController, classifyTerminal, type RunControllerOptions, type RunRuntime } from "../src/run-controller.ts";
import { UIForwarder } from "../src/ui-forwarder.ts";
import { verifyContainmentReceipt } from "../src/watchdog-client.ts";
import {
  testAbsolutePath, testAttemptId, testCommittedOutputPath, testContainmentAttempt, testModelId,
  testModelSpec, testProviderId, testReceiptPath, testSessionPath, testToolName, testUIRequestId,
  testVerifiedReceiptPath,
} from "./support/brands.ts";
import { agentSummary, assistantMessage, completedCompletion, testUsage } from "./support/messages.ts";
import { testRuntime } from "./support/launches.ts";
import { restoreRuns, testRunController } from "./support/controllers.ts";
import { extensionApiForTest } from "./support/extension-api.ts";
import { temporaryStateRoot } from "./support/temp-state.ts";

function completionArray<T>(result: { readonly completion?: T }): T[] {
  return result.completion === undefined ? [] : [result.completion];
}

const A = agentId("agent-a");
const B = agentId("agent-b");
const R1 = runId("deadbeef");
const R2 = runId("cafebabe");
const RUN_SIGNAL = new AbortController().signal;
// @ts-expect-error output work directories must be validated absolute paths.
const _rawOutputStore = new OutputStore({ workDir: "/tmp/raw-output-root" });
void _rawOutputStore;

describe("controller orchestration scenarios", () => {
  test("spawn observes only after persistence, accepts before bind, and acknowledges exact delivery", async () => {
    const events: string[] = [];
    const observation = recordingObservation(events);
    const host = controllerWithNativeLaunch(A, R1, () => {}, { observation, events });
    const started = await host.spawn({ task: "Review races" });
    expect(started).toMatchObject({ agentId: A, runId: R1, state: AgentState.Running });
    expect(events.indexOf("persist:spawned")).toBeLessThan(events.indexOf(`spawned:${A}`));
    expect(events.indexOf("persist:started")).toBeLessThan(events.indexOf(`accepted:${A}:${R1}`));
    expect(events.indexOf(`accepted:${A}:${R1}`)).toBeLessThan(events.indexOf(`bind:${R1}`));
    await host.publish(completion(A, R1, "done"));
    await host.awaitReady();
    expect(events).toContain(`completion:${A}:${R1}`);
    expect(events).toContain(`ack:${agentRunKey(A, R1)}`);
  });

  test("durably spawned children receive a safe observation when optional session metadata is absent", async () => {
    let registered: SpawnObservationInput | undefined;
    const host = controllerWithNativeLaunch(A, R1, () => {}, {
      observation: recordingObservation([], { registerSpawned: (input) => { registered = input; } }),
      omitObservationMetadata: true,
    });

    expect(await host.spawn({ task: "Review races" })).toMatchObject({ state: AgentState.Running });
    expect(registered).toMatchObject({
      agentId: A,
      cwd: "/tmp/pi-subagents-test",
      model: "mock-provider/luna",
      thinkingLevel: "high",
      assignment: "Review races",
    });
  });

  test("observation failure leaves durable lifecycle and completion outcomes unchanged", async () => {
    const host = controllerWithNativeLaunch(A, R1, () => {}, {
      observation: recordingObservation([], {
        registerSpawned: () => { throw new Error("spawn projection fault"); },
        updateLifecycle: () => { throw new Error("lifecycle projection fault"); },
      }),
    });
    expect(await host.spawn({ task: "Review races" })).toMatchObject({ state: AgentState.Running });
    await host.publish(completion(A, R1, "done"));
    expect(await host.awaitReady()).toMatchObject({ completion: { agentId: A, runId: R1, state: CompletionState.Completed } });
  });

  test("reconciliation sees complete durable outcomes and exact undrained delivery keys", async () => {
    const reconciliations: ObservationReconciliationSnapshot[] = [];
    const host = new SubagentController({ observation: recordingObservation([], {
      publishCompletion: () => { throw new Error("completion projection fault"); },
      acknowledgeDelivered: () => { throw new Error("delivery projection fault"); },
      reconcile: (snapshot) => { reconciliations.push(snapshot); },
    }) });
    await host.publish(completion(A, R1, "first"));
    await host.publish(completion(B, R2, "second"));

    const delivered = await host.awaitReady();
    await Promise.resolve().then(() => Promise.resolve());
    const reconciled = reconciliations.at(-1)!;

    expect(delivered.completion).toMatchObject({ agentId: A, runId: R1 });
    expect(reconciled.completions.map(({ agentId: id, runId: run }) => [id, run])).toEqual([[A, R1], [B, R2]]);
    expect([...reconciled.pendingDelivery]).toEqual([agentRunKey(B, R2)]);
  });

  test("01 spawn one child and await its completion", async () => {
    const service = new CompletionService();
    service.upsertAgent(summary(A, AgentState.Running, R1));
    const waiting = service.awaitReady();
    await service.publish(completion(A, R1, "one"));
    expect(completionArray(await waiting)).toEqual([expect.objectContaining({ agentId: A, runId: R1 })]);
  });

  test("02 B completes first, is received and resumed before A is received", async () => {
    const service = new CompletionService();
    service.upsertAgent(summary(A, AgentState.Running, R1));
    service.upsertAgent(summary(B, AgentState.Running, R1));
    await service.publish(completion(B, R1, "B1"));
    expect(completionArray(await service.awaitReady()).map((item) => item.agentId)).toEqual([B]);
    service.upsertAgent(summary(B, AgentState.Running, R2));
    await service.publish(completion(A, R1, "A1"));
    expect(completionArray(await service.awaitReady()).map((item) => item.agentId)).toEqual([A]);
    expect(service.snapshotAgents().find((item) => item.agentId === B)?.currentRunId).toBe(R2);
  });

  test("03 repeated awaits drain several queued completions one at a time", async () => {
    const service = new CompletionService();
    await service.publish(completion(A, R1, "A"));
    await service.publish(completion(B, R1, "B"));
    expect((await service.awaitReady()).completion?.output.text).toBe("A");
    expect((await service.awaitReady()).completion?.output.text).toBe("B");
  });

  test("04 stop several running agents", async () => {
    const runs = controller({ capacity: runCapacity(3) });
    for (const id of [A, B]) await start(runs, id, R1);
    const stopped = await Promise.all([A, B].map((id) => runs.stop(id, CancellationReason.StopRequested)));
    expect(stopped.map((item) => item.status)).toEqual(["stopped", "stopped"]);
    expect(runs.activeCount()).toBe(0);
  });

  test("05 parent shutdown cancels active children", async () => {
    const terminal: string[] = [];
    const runs = controller({ capacity: runCapacity(3), onTerminal: (_record, settlement) => { terminal.push(settlement.kind); } });
    const processes = [spawnSleeper(), spawnSleeper()];
    try {
      await Promise.all(processes.map(waitSpawn));
      for (const [index, id] of [A, B].entries()) {
        const child = processes[index]!;
        runs.register({ agentId: id, state: AgentState.Stopped, transcriptPath: testSessionPath(`/tmp/pi-subagents-test/${id}`) });
        await runs.launch(id, async () => ({ status: "accepted", runId: R1, runtime: {
          abort: async () => { child.kill("SIGTERM"); },
          contain: async () => { await waitExit(child); return testVerifiedReceiptPath(`/tmp/pi-subagents-test/${id}.receipt`); },
        } }));
      }
      await Promise.all([A, B].map((id) => runs.stop(id, CancellationReason.ParentShutdown)));
      expect(terminal).toEqual(["cancelled", "cancelled"]);
      expect(processes.every(processAbsent)).toBeTrue();
    } finally {
      for (const child of processes) if (!processAbsent(child)) child.kill("SIGKILL");
    }
  });

  test("06 restored parent collects an earlier uncollected completion", async () => {
    const service = new CompletionService();
    service.restore([{ agentId: A, state: AgentState.Stopped, sessionPath: testSessionPath("/tmp/pi-subagents-test/a"), latestCompletion: completion(A, R1, "old") }]);
    expect(service.queuedCount()).toBe(1);
    expect(completionArray(await service.awaitReady())[0]?.output.text).toBe("old");
    expect(service.queuedCount()).toBe(0);
  });

  test("07 stopped child resumes after parent restart", async () => {
    const runs = controller();
    await restoreRuns(runs, [{ agentId: A, state: AgentState.Stopped, transcriptPath: testSessionPath("/tmp/pi-subagents-test/a"), runId: R1 }]);
    const resumed = await runs.launch(A, async () => ({ status: "accepted", runId: R2, runtime: runtime() }));
    expect(resumed).toMatchObject({ status: "running", agentId: A, runId: R2 });
  });

  test("08 child confirmation is correlated through the parent UI", async () => {
    const seen: string[] = [];
    const ui = new UIForwarder({ hasUI: true, ui: {
      select: async () => undefined, input: async () => undefined, editor: async () => undefined,
      notify: () => {}, setStatus: () => {}, setWidget: () => {},
      confirm: async (title) => { seen.push(title); return true; },
    } });
    const result = await ui.forward(A, { type: "extension_ui_request", method: "confirm", id: testUIRequestId("confirm-1"), title: "Proceed", message: "Continue?" }, RUN_SIGNAL);
    expect(result).toEqual({ type: "extension_ui_response", id: testUIRequestId("confirm-1"), confirmed: true });
    expect(seen[0]).toContain(A);
  });

  test("09 process exit without agent_settled is a failed terminal observation", () => {
    expect(classifyTerminal({ kind: "process_exited" })).toEqual({ kind: "failed", cause: expect.objectContaining({ code: AgentErrorCode.ProcessExited }) });
  });

  test("10 empty await returns immediately", async () => {
    const outcome = await Promise.race([new CompletionService().awaitReady(), Bun.sleep(100).then(() => "timeout")]);
    expect(outcome).not.toBe("timeout");
    if (typeof outcome === "string") throw new Error("await timed out");
    expect(Number(outcome.remainingCompletions)).toBe(0);
    expect(outcome.agents).toEqual([]);
    expect(outcome.timedOut).toBeFalse();
  });

  test("11 send_input rejects running, settling and stopping without mutating runs", async () => {
    for (const state of [AgentState.Running, AgentState.Settling, AgentState.Stopping]) {
      const runs = controller();
      await restoreRuns(runs, [{ agentId: A, state, transcriptPath: testSessionPath("/tmp/pi-subagents-test/a"), runId: R1, runtime: runtime() }]);
      await expect(runs.launch(A, async () => ({ status: "accepted", runId: R2, runtime: runtime() }))).rejects.toThrow("invalid_state:");
      expect(runs.snapshot(A)).toMatchObject({ state, runId: R1 });
    }
  });

  test("12 compaction-safe restoration recovers pre-compaction inventory and completion", async () => {
    const service = new CompletionService();
    service.restore([{ agentId: A, state: AgentState.Stopped, sessionPath: testSessionPath("/tmp/pi-subagents-test/a"), latestCompletion: completion(A, R1, "before compaction") }]);
    expect((await service.awaitReady())).toMatchObject({ completion: { agentId: A, runId: R1 }, agents: [{ agentId: A }] });
  });

  test("13 switch, fork, clone, reload and new-session boundaries cancel ownership without shutdown pings", async () => {
    for (const boundary of ["switch", "fork", "clone", "reload", "new-session"] as const) {
      const state = temporaryStateRoot(`pi-controller-boundary-${boundary}-`);
      const root = String(state.path);
      try {
      const receipt = join(root, "attempt.receipt");
      // The receipt lives under a per-test OS temp root, so validate against that real root.
      const receiptPath = containmentReceiptPath(root, receipt);
      writeReceipt(receipt, "attempt");
      const entries: Array<{ type: "custom"; customType: string; data: unknown }> = [];
      const appender = new AgentEventAppender((customType, data) => { entries.push({ type: "custom", customType, data }); });
      await appendRunning(appender, receiptPath);
      const warnings: string[] = []; const pings: string[] = []; let contained = 0;
      const host = new SubagentController({ composition: {
        prepareSpawn: async () => { throw new Error("unused"); }, prepareSend: async () => { throw new Error("unused"); },
        persistStopping: async (record, reason) => appender.appendRunStopping({ agentId: record.agentId, runId: record.runId!,
          reason: reason === CancellationReason.ParentShutdown ? reason : CancellationReason.StopRequested,
          containmentReceiptPath: receiptPath }),
        finaliseRun: async (record, settlement) => {
          const value = { ...completion(record.agentId, record.runId!, ""), state: CompletionState.Cancelled,
            reason: settlement.kind === "cancelled" ? settlement.reason ?? CancellationReason.StopRequested : CancellationReason.StopRequested } as const;
          await appender.appendRunCompleted(value);
          return value;
        },
      }, parent: { isBusy: () => false, sendMessage: (message) => { pings.push(message); }, warn: (message) => { warnings.push(message); } } });
      await restoreRuns(host.runs, [{ agentId: A, state: AgentState.Running, transcriptPath: testSessionPath("/tmp/pi-subagents-test/agent-a.jsonl"), runId: R1,
        runtime: { abort: async () => {}, contain: async () => { contained++; return verifyContainmentReceipt(receiptPath, testAttemptId("attempt")).path; } } }]);

      expect(boundary === "fork" ? host.beforeFork() : host.beforeSwitch()).toBeTrue();
      await host.shutdown();

      expect(warnings).toHaveLength(1);
      expect(contained).toBe(1);
      expect(host.runs.activeCount()).toBe(0);
      expect(pings).toEqual([]);
      expect(completionArray(await host.awaitReady())).toMatchObject([{ agentId: A, runId: R1, state: CompletionState.Cancelled,
        reason: CancellationReason.ParentShutdown }]);
      expect(entries.map((entry) => (entry.data as { eventType: string }).eventType)).toEqual([
        AgentEventType.Spawned, AgentEventType.RunLaunchRequested, AgentEventType.RunStarted,
        AgentEventType.RunStopping, AgentEventType.RunCompleted,
      ]);
      const replacement = new SubagentController({ restoration: restorationPort(entries, appender) });
      await replacement.restore();
      expect(completionArray(await replacement.awaitReady())).toMatchObject([{ agentId: A, runId: R1,
        state: CompletionState.Cancelled, reason: CancellationReason.ParentShutdown }]);
      expect(foldAgentEvents(entries, testAbsolutePath("/tmp")).agents.get(A)).toMatchObject({ state: AgentState.Stopped,
        completion: { payload: { runId: R1, reason: CancellationReason.ParentShutdown } } });
      } finally {
        state.cleanup();
      }
    }
  });

  test("14 tree navigation is cancelled for running, settling and stopping ownership", async () => {
    for (const state of [AgentState.Running, AgentState.Settling, AgentState.Stopping]) {
      const host = new SubagentController({ parent: { isBusy: () => false, sendMessage: () => {} } });
      await restoreRuns(host.runs, [{ agentId: A, state, transcriptPath: testSessionPath("/tmp/pi-subagents-test/a"), runId: R1, runtime: runtime() }]);
      expect(host.beforeTree()).toBeFalse();
    }
  });

  test("15 unconfigured completion service preserves full completions while sidecars remain authoritative", async () => {
    const service = new CompletionService();
    await service.publish(completion(A, R1, "1234"));
    await service.publish(completion(B, R1, "later"));
    const first = await service.awaitReady();
    const second = await service.awaitReady();
    expect([first.completion?.output.text, second.completion?.output.text]).toEqual(["1234", "later"]);
    expect(String(second.completion?.outputPath)).toBe(
      "/tmp/pi-subagents-test/output/agent-b/deadbeef.committed",
    );
  });

  test("16 await inventory rediscovers IDs hidden by compaction", async () => {
    const service = new CompletionService();
    service.restore([
      { agentId: A, state: AgentState.Stopped, sessionPath: testSessionPath("/tmp/pi-subagents-test/a"), latestCompletion: completion(A, R1, "done") },
      { agentId: B, state: AgentState.Running, sessionPath: testSessionPath("/tmp/pi-subagents-test/b"), currentRunId: R2 },
    ]);
    expect((await service.awaitReady()).agents.map((item) => item.agentId).sort()).toEqual([A, B].sort());
  });

  test("17 external cwd does not inherit parent project trust", () => {
    const spec = buildRpcLaunchSpec({
      invocation: { command: testAbsolutePath("/usr/bin/node"), argsPrefix: ["/opt/pi/cli.js"] }, cwd: testAbsolutePath("/external"),
      childSessionDir: testAbsolutePath("/tmp/sessions"), effectiveTools: [testToolName("read")], effectiveModel: testModelSpec("mock/model"),
      effectiveThinking: "minimal", trustedRoot: testAbsolutePath("/project"), env: {},
      childDepth: delegationDepth(1), maxDepth: delegationDepth(1), maxConcurrentRuns: runCapacity(4),
    });
    expect(spec.args).not.toContain("--approve");
  });

  test("18 restoration can expose a persisted completion again with the stable run ID", async () => {
    const persisted = completion(A, R1, "stable");
    const first = new CompletionService(); await first.publish(persisted); await first.awaitReady();
    const restored = new CompletionService(); restored.restore([{ agentId: A, state: AgentState.Stopped, sessionPath: testSessionPath("/tmp/pi-subagents-test/a"), latestCompletion: persisted }]);
    expect(completionArray(await restored.awaitReady())[0]?.runId).toBe(R1);
  });

  test("19 stop versus settlement with failed containment retains one stopping terminal obligation", async () => {
    let attempts = 0; let terminals = 0;
    const runs = controller({ onTerminal: () => { terminals++; } });
    runs.register({ agentId: A, state: AgentState.Stopped, transcriptPath: testSessionPath("/tmp/pi-subagents-test/a") });
    await runs.launch(A, async () => ({ status: "accepted", runId: R1, runtime: runtime(async () => { if (++attempts === 1) throw new Error("alive"); }) }));
    expect((await runs.stop(A, CancellationReason.StopRequested)).status).toBe("containment_failed");
    expect(runs.snapshot(A)?.state).toBe(AgentState.Stopping);
    expect((await runs.stop(A, CancellationReason.StopRequested)).status).toBe("stopped");
    expect(terminals).toBe(1);
  });

  test("20 capacity remains reserved until failed kill or empty-proof retry publishes terminal persistence", async () => {
    let killOrEmptyProofFails = true;
    let acceptedV2Receipts = 0;
    let persistedTerminal = 0;
    const completions = new CompletionService();
    const runs = controller({ capacity: runCapacity(1), onTerminal: async (record) => {
      persistedTerminal++;
      await completions.publish(completion(record.agentId, record.runId!, "contained"));
    } });
    runs.register({ agentId: A, state: AgentState.Stopped, transcriptPath: testSessionPath("/tmp/pi-subagents-test/a") });
    runs.register({ agentId: B, state: AgentState.Stopped, transcriptPath: testSessionPath("/tmp/pi-subagents-test/b") });
    await runs.launch(A, async () => ({ status: "accepted", runId: R1, runtime: {
      abort: async () => {},
      contain: async () => {
        if (killOrEmptyProofFails) throw new Error("kill or populated-empty proof failed");
        acceptedV2Receipts++;
        return testVerifiedReceiptPath("/tmp/pi-subagents-test/verified-v2-receipt");
      },
    } }));

    expect((await runs.stop(A, CancellationReason.StopRequested)).status).toBe("containment_failed");
    expect(runs.snapshot(A)?.state).toBe(AgentState.Stopping);
    expect(runs.activeCount()).toBe(1);
    await expect(runs.launch(B, async () => ({ status: "accepted", runId: R2, runtime: runtime() })))
      .rejects.toThrow("capacity_exceeded:");
    expect(persistedTerminal).toBe(0);
    expect(acceptedV2Receipts).toBe(0);
    expect(completionArray(await completions.awaitReady())).toEqual([]);

    killOrEmptyProofFails = false;
    expect((await runs.stop(A, CancellationReason.StopRequested)).status).toBe("stopped");
    expect(acceptedV2Receipts).toBe(1);
    expect(persistedTerminal).toBe(1);
    expect(completionArray(await completions.awaitReady())).toMatchObject([{ agentId: A, runId: R1 }]);
    expect(runs.activeCount()).toBe(0);
    expect((await runs.launch(B, async () => ({ status: "accepted", runId: R2, runtime: runtime() }))).status).toBe("running");
  });

  test("21 restored RunStopping finalises only after watchdog-confirmed containment", async () => {
    const state = temporaryStateRoot("pi-controller-restored-stopping-");
    const root = String(state.path);
    try {
    const receipt = join(root, "attempt.receipt");
    // The receipt lives under a per-test OS temp root, so validate against that real root.
    const receiptPath = containmentReceiptPath(root, receipt);
    const child = spawnProcess(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { detached: true, stdio: "ignore" });
    await waitSpawn(child);
    process.kill(-child.pid!, "SIGKILL");
    await waitExit(child);
    writeFileSync(receipt, JSON.stringify({ version: 1, attemptId: "attempt", pgid: child.pid,
      outcome: "terminated", timestamp: new Date().toISOString() }));
    expect(processAbsent(child)).toBeTrue();
    expect(String(verifyContainmentReceipt(receiptPath, testAttemptId("attempt")).path)).toBe(receipt);

    const entries: Array<{ type: "custom"; customType: string; data: unknown }> = [];
    const appender = new AgentEventAppender((customType, data) => { entries.push({ type: "custom", customType, data }); });
    await appendRunning(appender, receiptPath);
    await appender.appendRunStopping({ agentId: A, runId: R1, reason: CancellationReason.ParentShutdown,
      containmentReceiptPath: receiptPath });
    const restored = new SubagentController({ restoration: restorationPort(entries, appender) });
    await restored.restore();
    expect(restored.runs.activeCount()).toBe(0);
    expect(completionArray(await restored.awaitReady())).toMatchObject([{ agentId: A, runId: R1,
      state: CompletionState.Cancelled, reason: CancellationReason.ParentShutdown }]);
    expect(entries.map((entry) => (entry.data as { eventType: string }).eventType).at(-1)).toBe(AgentEventType.RunCompleted);
    } finally {
      state.cleanup();
    }
  });

  test("21 repeated restoration bounds duplicate completion visibility by stable run ID", async () => {
    const service = new CompletionService(); const persisted = completion(A, R1, "stable");
    service.restore([{ agentId: A, state: AgentState.Stopped, sessionPath: testSessionPath("/tmp/pi-subagents-test/a"), latestCompletion: persisted }]);
    service.restore([{ agentId: A, state: AgentState.Stopped, sessionPath: testSessionPath("/tmp/pi-subagents-test/a"), latestCompletion: persisted }]);
    expect(completionArray(await service.awaitReady()).map((item) => item.runId)).toEqual([R1]);
  });

  test("22 partial assistant output is discarded and prior committed output remains authoritative", () => {
    const state = temporaryStateRoot("pi-subagents-controller-");
    const dir: string = state.path;
    try {
      const store = new OutputStore({ workDir: testAbsolutePath(dir) }); const attempt = createRunAttemptId();
      store.beginAttempt(attempt); const path = store.bindRun(attempt, R1);
      store.onMessageEnd(R1, assistant("committed"));
      store.onMessageStart(R1, assistant("")); store.onTextDelta(R1, 0, "partial"); store.discardPartial(R1);
      expect(readFileSync(path, "utf8")).toBe("committed");
    } finally { state.cleanup(); }
  });

  test("23 NEEDS_CONTEXT resume sends the clean literal assignment through the stopped-agent path", async () => {
    const assignment = "Additional context without protocol markers";
    let prompted = "";
    const host = controllerWithNativeLaunch(A, R2, (message) => { prompted = message; });
    await restoreRuns(host.runs, [{ agentId: A, state: AgentState.Stopped, transcriptPath: testSessionPath("/tmp/pi-subagents-test/a"), runId: R1 }]);

    const resumed = await host.sendInput(A, assignment);

    expect(resumed).toEqual({ agentId: A, runId: R2, state: AgentState.Running });
    expect(prompted).toBe(assignment);
    expect(prompted).not.toMatch(/NEEDS_CONTEXT|<subagent|assignment:/i);
    await host.shutdown();
  });

  test("restored send_input drops lifecycle tools when current depth policy reaches the child boundary", async () => {
    const state = temporaryStateRoot("pi-production-relaunch-");
    const persistedTools = [
      testToolName("read"),
      testToolName("spawn_agent"),
      testToolName("await_agent"),
    ];
    let captured: BuildRpcLaunchOptions | undefined;
    let preparedAttempts = 0;
    let bypassedAttemptPreparation = false;
    try {
      const project = join(String(state.path), "project");
      const parentSessions = join(String(state.path), "parent-sessions");
      mkdirSync(project);
      mkdirSync(parentSessions);
      const parent = SessionManager.create(project, parentSessions);
      const productionRoot = join(String(state.path), parent.getSessionId());
      const childSessions = join(productionRoot, "sessions");
      mkdirSync(childSessions, { recursive: true });
      const child = SessionManager.create(project, childSessions);
      const childFile = child.getSessionFile();
      if (childFile === undefined) throw new Error("child session file unavailable");
      const childId = agentId(child.getSessionId());
      const appender = new AgentEventAppender((customType, data) => {
        parent.appendCustomEntry(customType, data);
      });
      await appender.appendSpawned({
        agentId: childId,
        sessionPath: sessionPath(productionRoot, childFile),
        cwd: testAbsolutePath(project),
        provider: testProviderId("mock"),
        modelId: testModelId("model"),
        thinkingLevel: "minimal",
        tools: persistedTools,
      });
      const backend = productionBackend(() => { preparedAttempts++; });
      const dependencies = {
        createContainmentProvider: () => ({ kind: "available" as const, backend }),
        buildRpcLaunchSpec: (launchOptions: BuildRpcLaunchOptions) => {
          expect(preparedAttempts).toBe(1);
          captured = launchOptions;
          return buildRpcLaunchSpec({
            ...launchOptions,
            invocation: { command: testAbsolutePath("/pi"), argsPrefix: [] },
          });
        },
        createPreparedLaunch: async (prepared: { runtime: RunRuntime; attempt: ContainmentAttempt }) => {
          expect(captured?.effectiveTools).toEqual([testToolName("read")]);
          return deterministicLaunch(
            prepared.runtime,
            prepared.attempt.proveRuntimeDescriptor({
              ...prepared.attempt.candidate,
              scopePath: observedCgroupScopePath(prepared.attempt.candidate.scopePath),
            }),
          );
        },
        constructLaunch: async () => {
          bypassedAttemptPreparation = true;
          throw new Error("obsolete containment-bypass seam was used");
        },
      };
      const host = createProductionController(
        productionContext(parent, project),
        extensionApiForTest({
          registerTool: () => {}, on: () => {},
          appendEntry: (customType, data) => { parent.appendCustomEntry(customType, data); },
          sendMessage: () => {}, getThinkingLevel: () => "minimal", getActiveTools: () => ["read"],
        }),
        { capacity: runCapacity(4), currentDepth: delegationDepth(0), maxDepth: delegationDepth(1), stateRoot: testAbsolutePath(String(state.path)) },
        dependencies,
      );
      await host.restore();

      await host.sendInput(childId, "restored assignment");

      expect(preparedAttempts).toBe(1);
      expect(bypassedAttemptPreparation).toBeFalse();
      expect(captured?.effectiveTools).toEqual(effectiveToolsForRelaunch(persistedTools, delegationDepth(0), delegationDepth(1)));
      expect(captured?.effectiveTools).toEqual([testToolName("read")]);
      expect(persistedTools).toEqual([
        testToolName("read"),
        testToolName("spawn_agent"),
        testToolName("await_agent"),
      ]);
    } finally {
      state.cleanup();
    }
  });

  test("restored relaunch policy never adds lifecycle tools omitted by an explicit allowlist", () => {
    expect(effectiveToolsForRelaunch([testToolName("read")], delegationDepth(0), delegationDepth(2))).toEqual([testToolName("read")]);
  });

  test("24 public IDs come from the native session and first assignment entry", async () => {
    const nativeSessionId = agentId("native-session-42"); const assignmentEntryId = runId("0123abcd");
    const host = controllerWithNativeLaunch(nativeSessionId, assignmentEntryId, () => {});

    const value = await host.spawn({ task: "literal assignment" });

    expect(value).toEqual({ agentId: nativeSessionId, runId: assignmentEntryId, state: AgentState.Running,
      model: modelSpec("mock-provider/luna"), thinkingLevel: "high", tools: [testToolName("read")] });
    expect(host.runs.snapshot(nativeSessionId)).toMatchObject({ agentId: nativeSessionId, runId: assignmentEntryId });
    await host.shutdown();
  });
});

function completion(id: AgentId, run: RunId, text: string): AgentCompletion {
  return completedCompletion({
    agentId: id,
    runId: run,
    output: truncateUtf8(text, utf8Bytes(50_000)),
    outputPath: testCommittedOutputPath({
      workDir: testAbsolutePath(`/tmp/pi-subagents-test/output/${id}`),
      runId: run,
    }),
    transcriptPath: testSessionPath(`/tmp/pi-subagents-test/${id}.jsonl`),
  });
}
function summary(id: AgentId, state: typeof AgentState.Running, currentRunId: RunId) {
  return agentSummary({ agentId: id, state, transcriptPath: testSessionPath(`/tmp/pi-subagents-test/${id}.jsonl`), currentRunId });
}
function controller(options: Partial<RunControllerOptions> = {}) { return testRunController(options); }
async function start(runs: RunController, id: AgentId, run: RunId) {
  runs.register({ agentId: id, state: AgentState.Stopped, transcriptPath: testSessionPath(`/tmp/pi-subagents-test/${id}`) });
  return runs.launch(id, async () => ({ status: "accepted", runId: run, runtime: runtime() }));
}
function runtime(contain: () => Promise<void> = async () => {}) {
  return testRuntime({ contain: async () => {
    await contain();
    return testVerifiedReceiptPath("/tmp/pi-subagents-test/receipt");
  } });
}
function assistant(text: string) {
  // Zero usage, as this fixture carried before it moved onto the shared builder.
  return assistantMessage(text, { timestamp: Date.now(), usage: testUsage({ input: 0, output: 0, totalTokens: 0 }) });
}

function controllerWithNativeLaunch(
  id: AgentId,
  nativeRunId: RunId,
  onPrompt: (message: string) => void,
  options: { observation?: AgentObservationMutationPort; events?: string[]; omitObservationMetadata?: boolean } = {},
): SubagentController {
  const session = { agentId: id, transcriptPath: testSessionPath(`/tmp/pi-subagents-test/${id}.jsonl`), previousLeafId: null,
    attemptId: testAttemptId(`attempt-${id}`), containmentReceiptPath: testReceiptPath(`/tmp/pi-subagents-test/${id}.receipt`),
    ...(options.omitObservationMetadata === true ? {} : {
      cwd: testAbsolutePath("/tmp/pi-subagents-test"), model: modelSpec("mock-provider/luna"), thinkingLevel: "high" as const,
    }) };
  const launch = async (surrender: SurrenderContainment) => {
    const owned = runtime();
    surrender(owned);
    let reads = 0;
    let assignment = "";
    const containment = testContainmentAttempt(session.attemptId).descriptor;
    return {
      runtime: owned,
      ready: async () => containment, persistLaunchRequested: async () => {}, persistRunStarted: async () => { options.events?.push("persist:started"); }, start: async () => {},
      getEntries: async () => reads++ === 0 ? { entries: [], leafId: null } : {
        entries: [{ type: "message", id: nativeRunId, message: { role: "user", content: assignment } }], leafId: nativeRunId,
      },
      prompt: async (message: string) => { assignment = message; onPrompt(message); }, waitForAgentStart: async () => {}, bindRun: (run: RunId) => { options.events?.push(`bind:${run}`); }, waitSettled: () => new Promise<never>(() => {}),
    };
  };
  const composition = {
    prepareSpawn: async () => ({ selection: { model: modelSpec("mock-provider/luna"), thinkingLevel: "high", tools: [testToolName("read")] },
      createSession: async () => session, persistSpawned: async () => { options.events?.push("persist:spawned"); }, createLaunch: async (_session, surrender) => launch(surrender) }),
    prepareSend: async () => ({ session, createLaunch: (surrender: SurrenderContainment) => launch(surrender) }),
  } satisfies PiControllerComposition;
  return new SubagentController({ composition, ...(options.observation === undefined ? {} : { observation: options.observation }) });
}

function recordingObservation(events: string[], overrides: Partial<AgentObservationMutationPort> = {}): AgentObservationMutationPort {
  const base: AgentObservationMutationPort = {
    registerSpawned: ({ agentId }) => { events.push(`spawned:${agentId}`); },
    acceptRun: ({ agentId, runId }) => { events.push(`accepted:${agentId}:${runId}`); },
    updateLifecycle: ({ agentId, state }) => { events.push(`lifecycle:${agentId}:${state}`); },
    publishCompletion: ({ agentId, runId }) => { events.push(`completion:${agentId}:${runId}`); },
    registerSensitiveValues: () => { events.push("sensitive"); },
    acknowledgeDelivered: (keys) => { events.push(`ack:${keys.join(",")}`); },
    reconcile: () => { events.push("reconcile"); },
    dispose: () => { events.push("dispose"); },
  };
  return { ...base, ...overrides };
}

function productionContext(
  sessionManager: SessionManager,
  cwd: string,
): Parameters<typeof createProductionController>[0] {
  return {
    sessionManager,
    cwd,
    model: undefined,
    modelRegistry: { getAll: () => [] },
    hasUI: false,
    ui: {
      select: async () => undefined, confirm: async () => false, input: async () => undefined,
      editor: async () => undefined, notify: () => {}, setStatus: () => {}, setWidget: () => {},
    },
    isIdle: () => true,
    isProjectTrusted: () => false,
  };
}

function productionBackend(onPrepareAttempt: () => void): ContainmentBackend {
  const parentScope = testAbsolutePath("/tmp/test-cgroup/parent");
  const prepareAttempt = (attemptId: ContainmentAttempt["attemptId"]): ContainmentAttempt => {
    onPrepareAttempt();
    return testContainmentAttempt(attemptId);
  };
  return {
    root: testAbsolutePath("/tmp/test-cgroup"),
    parentScope,
    preflight: async () => {},
    prepareAttempt,
    restoreAttempt: prepareAttempt,
    shutdown: async () => {},
  };
}

function deterministicLaunch(
  owned: RunRuntime,
  containment: ContainmentDescriptor,
): LaunchTransport {
  let reads = 0;
  let assignment = "";
  return {
    runtime: owned,
    ready: async () => containment, persistLaunchRequested: async () => {}, persistRunStarted: async () => {},
    start: async () => {},
    getEntries: async () => reads++ === 0 ? { entries: [], leafId: null } : {
      entries: [{ type: "message", id: R2, message: { role: "user", content: assignment } }], leafId: R2,
    },
    prompt: async (message: string) => { assignment = message; }, waitForAgentStart: async () => {},
    bindRun: () => {}, waitSettled: () => new Promise<never>(() => {}),
  };
}

function spawnSleeper(): ChildProcess {
  return spawnProcess(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
}

function waitSpawn(child: ChildProcess): Promise<void> {
  if (child.pid !== undefined) return Promise.resolve();
  return new Promise((resolve, reject) => { child.once("spawn", resolve); child.once("error", reject); });
}

function waitExit(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
  return new Promise((resolve) => { child.once("exit", () => resolve()); });
}

function processAbsent(child: ChildProcess): boolean {
  const pid = child.pid;
  if (pid === undefined) return true;
  try { process.kill(pid, 0); return false; } catch { return true; }
}

async function appendRunning(appender: AgentEventAppender, receipt: ContainmentReceiptPath): Promise<void> {
  await appender.appendSpawned({ agentId: A, sessionPath: testSessionPath("/tmp/pi-subagents-test/agent-a.jsonl"), cwd: testAbsolutePath("/tmp"),
    provider: testProviderId("mock"), modelId: testModelId("model"), thinkingLevel: "minimal", tools: [] });
  await appender.appendRunLaunchRequested({ agentId: A, previousLeafId: null, attemptId: testAttemptId("attempt"),
    containmentReceiptPath: receipt,
    containment: testContainmentAttempt(testAttemptId("attempt")).descriptor });
  await appender.appendRunStarted({ agentId: A, runId: R1, attemptId: testAttemptId("attempt") });
}

function writeReceipt(path: string, attemptId: string): void {
  writeFileSync(path, JSON.stringify({ version: 1, attemptId, pgid: null, outcome: "no_process",
    timestamp: new Date().toISOString() }));
}

function restorationPort(
  entries: Array<{ type: "custom"; customType: string; data: unknown }>,
  appender: AgentEventAppender,
): RestorationPort {
  return {
    stateRoot: testAbsolutePath("/tmp"),
    folded: foldAgentEvents(entries, testAbsolutePath("/tmp")),
    resolveContainment: async ({ receiptPath, attemptId }) => ({
      kind: "contained",
      receipt: verifyContainmentReceipt(receiptPath, attemptId).path,
    }),
    firstUserEntryAfter: async () => undefined,
    finaliseContained: async (record, nativeRunId, settlement) => settlement.kind === "cancelled"
      ? ({ ...completion(record.agentId, nativeRunId, ""), state: CompletionState.Cancelled, reason: settlement.reason })
      : ({ ...completion(record.agentId, nativeRunId, ""),
        state: CompletionState.Failed, error: { code: AgentErrorCode.RunInterrupted, message: "interrupted" } }),
    restoreCompletion: async (record) => {
      const durable = completion(
        record.agentId,
        record.completion.payload.runId,
        record.completion.payload.output.text,
      );
      return { ...record.completion.payload, outputPath: durable.outputPath };
    },
    appender,
  };
}
