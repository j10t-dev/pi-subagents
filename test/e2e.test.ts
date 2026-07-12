import { describe, expect, test } from "bun:test";
import { spawn as spawnProcess, type ChildProcess } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { CompletionService } from "../src/completion-service.ts";
import { SubagentController, type RestorationPort, type SurrenderContainment } from "../src/controller.ts";
import {
  AgentErrorCode,
  AgentEventType,
  AgentState,
  CancellationReason,
  CompletionState,
  agentId,
  createRunAttemptId,
  modelSpec,
  runId,
  truncateUtf8,
  type AgentCompletion,
  type AgentId,
  type RunId,
} from "../src/domain.ts";
import { OutputStore } from "../src/output-store.ts";
import { AgentEventAppender, foldAgentEvents } from "../src/persistence.ts";
import { buildRpcLaunchSpec } from "../src/pi-launcher.ts";
import { RunController, classifyTerminal, type RunControllerOptions } from "../src/run-controller.ts";
import { UIForwarder } from "../src/ui-forwarder.ts";
import { verifyContainmentReceipt } from "../src/watchdog-client.ts";

const A = agentId("agent-a");
const B = agentId("agent-b");
const R1 = runId("deadbeef");
const R2 = runId("cafebabe");
const RUN_SIGNAL = new AbortController().signal;

describe("required end-to-end scenarios", () => {
  test("01 spawn one child and receive its completion", async () => {
    const service = new CompletionService();
    service.upsertAgent(summary(A, AgentState.Running, R1));
    const waiting = service.receive();
    await service.publish(completion(A, R1, "one"));
    expect((await waiting).completions).toEqual([expect.objectContaining({ agentId: A, runId: R1 })]);
  });

  test("02 B completes first, is received and resumed before A is received", async () => {
    const service = new CompletionService();
    service.upsertAgent(summary(A, AgentState.Running, R1));
    service.upsertAgent(summary(B, AgentState.Running, R1));
    await service.publish(completion(B, R1, "B1"));
    expect((await service.receive()).completions.map((item) => item.agentId)).toEqual([B]);
    service.upsertAgent(summary(B, AgentState.Running, R2));
    await service.publish(completion(A, R1, "A1"));
    expect((await service.receive()).completions.map((item) => item.agentId)).toEqual([A]);
    expect(service.snapshotAgents().find((item) => item.agentId === B)?.currentRunId).toBe(R2);
  });

  test("03 one receive drains several queued completions", async () => {
    const service = new CompletionService();
    await service.publish(completion(A, R1, "A"));
    await service.publish(completion(B, R1, "B"));
    expect((await service.receive()).completions.map((item) => item.output.text)).toEqual(["A", "B"]);
  });

  test("04 stop several running agents", async () => {
    const runs = controller({ capacity: 3 });
    for (const id of [A, B]) await start(runs, id, R1);
    const stopped = await Promise.all([A, B].map((id) => runs.stop(id, CancellationReason.StopRequested)));
    expect(stopped.map((item) => item.status)).toEqual(["stopped", "stopped"]);
    expect(runs.activeCount()).toBe(0);
  });

  test("05 parent shutdown cancels active children", async () => {
    const terminal: string[] = [];
    const runs = controller({ capacity: 3, onTerminal: (_record, settlement) => { terminal.push(settlement.kind); } });
    const processes = [spawnSleeper(), spawnSleeper()];
    try {
      await Promise.all(processes.map(waitSpawn));
      for (const [index, id] of [A, B].entries()) {
        const child = processes[index]!;
        runs.register({ agentId: id, state: AgentState.Stopped, transcriptPath: `/tmp/${id}` as never });
        await runs.launch(id, async () => ({ status: "accepted", runId: R1, runtime: {
          abort: async () => { child.kill("SIGTERM"); },
          contain: async () => { await waitExit(child); return `/tmp/${id}.receipt` as never; },
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
    expect(service.restore([{ agentId: A, state: AgentState.Stopped, sessionPath: "/tmp/a" as never, latestCompletion: completion(A, R1, "old") }])).toEqual({ backPingCount: 1 });
    expect((await service.receive()).completions[0]?.output.text).toBe("old");
  });

  test("07 stopped child resumes after parent restart", async () => {
    const runs = controller();
    runs.restore([{ agentId: A, state: AgentState.Stopped, transcriptPath: "/tmp/a" as never, runId: R1 }]);
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
    const result = await ui.forward(A, { type: "extension_ui_request", method: "confirm", id: "confirm-1", title: "Proceed", message: "Continue?" }, RUN_SIGNAL);
    expect(result).toEqual({ type: "extension_ui_response", id: "confirm-1", confirmed: true });
    expect(seen[0]).toContain(A);
  });

  test("09 process exit without agent_settled is a failed terminal observation", () => {
    expect(classifyTerminal({ kind: "process_exited" })).toEqual({ kind: "failed", cause: expect.objectContaining({ code: AgentErrorCode.ProcessExited }) });
  });

  test("10 empty receive returns immediately", async () => {
    const outcome = await Promise.race([new CompletionService().receive(), Bun.sleep(100).then(() => "timeout")]);
    expect(outcome).toEqual({ completions: [], agents: [], timedOut: false });
  });

  test("11 send_input rejects running, settling and stopping without mutating runs", async () => {
    for (const state of [AgentState.Running, AgentState.Settling, AgentState.Stopping]) {
      const runs = controller();
      runs.restore([{ agentId: A, state, transcriptPath: "/tmp/a" as never, runId: R1 }]);
      await expect(runs.launch(A, async () => ({ status: "accepted", runId: R2, runtime: runtime() }))).rejects.toThrow("invalid_state:");
      expect(runs.snapshot(A)).toMatchObject({ state, runId: R1 });
    }
  });

  test("12 compaction-safe restoration recovers pre-compaction inventory and completion", async () => {
    const service = new CompletionService();
    service.restore([{ agentId: A, state: AgentState.Stopped, sessionPath: "/tmp/a" as never, latestCompletion: completion(A, R1, "before compaction") }]);
    expect((await service.receive())).toMatchObject({ completions: [{ agentId: A, runId: R1 }], agents: [{ agentId: A }] });
  });

  test("13 switch, fork, clone, reload and new-session boundaries cancel ownership without shutdown pings", async () => {
    for (const boundary of ["switch", "fork", "clone", "reload", "new-session"] as const) {
      const root = mkdtempSync(join(tmpdir(), `pi-e2e-boundary-${boundary}-`));
      const receipt = join(root, "attempt.receipt");
      writeReceipt(receipt, "attempt");
      const entries: Array<{ type: "custom"; customType: string; data: unknown }> = [];
      const appender = new AgentEventAppender((customType, data) => { entries.push({ type: "custom", customType, data }); });
      await appendRunning(appender, receipt);
      const warnings: string[] = []; const pings: string[] = []; let contained = 0;
      const host = new SubagentController({ composition: {
        prepareSpawn: async () => { throw new Error("unused"); }, prepareSend: async () => { throw new Error("unused"); },
        persistStopping: async (record, reason) => appender.appendRunStopping({ agentId: record.agentId, runId: record.runId!,
          reason: reason === CancellationReason.ParentShutdown ? reason : CancellationReason.StopRequested,
          containmentReceiptPath: receipt as never }),
        finaliseRun: async (record, settlement) => {
          const value = { ...completion(record.agentId, record.runId!, ""), state: CompletionState.Cancelled,
            reason: settlement.kind === "cancelled" ? settlement.reason ?? CancellationReason.StopRequested : CancellationReason.StopRequested } as const;
          await appender.appendRunCompleted(value);
          return value;
        },
      }, parent: { isBusy: () => false, sendMessage: (message) => { pings.push(message); }, warn: (message) => { warnings.push(message); } } });
      host.runs.restore([{ agentId: A, state: AgentState.Running, transcriptPath: "/tmp/agent-a.jsonl" as never, runId: R1,
        runtime: { abort: async () => {}, contain: async () => { contained++; return verifyContainmentReceipt(receipt as never, "attempt" as never).path; } } }]);

      expect(boundary === "fork" ? host.beforeFork() : host.beforeSwitch()).toBeTrue();
      await host.shutdown();

      expect(warnings).toHaveLength(1);
      expect(contained).toBe(1);
      expect(host.runs.activeCount()).toBe(0);
      expect(pings).toEqual([]);
      expect((await host.receive()).completions).toMatchObject([{ agentId: A, runId: R1, state: CompletionState.Cancelled,
        reason: CancellationReason.ParentShutdown }]);
      expect(entries.map((entry) => (entry.data as { eventType: string }).eventType)).toEqual([
        AgentEventType.Spawned, AgentEventType.RunLaunchRequested, AgentEventType.RunStarted,
        AgentEventType.RunStopping, AgentEventType.RunCompleted,
      ]);
      const replacement = new SubagentController({ restoration: restorationPort(entries, appender) });
      await replacement.restore();
      expect((await replacement.receive()).completions).toMatchObject([{ agentId: A, runId: R1,
        state: CompletionState.Cancelled, reason: CancellationReason.ParentShutdown }]);
      expect(foldAgentEvents(entries, "/tmp").agents.get(A)).toMatchObject({ state: AgentState.Stopped,
        latestCompletion: { runId: R1, reason: CancellationReason.ParentShutdown } });
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("14 tree navigation is cancelled for running, settling and stopping ownership", () => {
    for (const state of [AgentState.Running, AgentState.Settling, AgentState.Stopping]) {
      const host = new SubagentController({ parent: { isBusy: () => false, sendMessage: () => {} } });
      host.runs.restore([{ agentId: A, state, transcriptPath: "/tmp/a" as never, runId: R1 }]);
      expect(host.beforeTree()).toBeFalse();
    }
  });

  test("15 aggregate budget truncates later inline output while sidecars remain authoritative", async () => {
    const service = new CompletionService(4);
    await service.publish(completion(A, R1, "1234"));
    await service.publish(completion(B, R1, "later"));
    const received = await service.receive();
    expect(received.completions.map((item) => item.output.text)).toEqual(["1234", ""]);
    expect(String(received.completions[1]?.outputPath)).toBe("/tmp/agent-b-deadbeef.txt");
  });

  test("16 receive inventory rediscovers IDs hidden by compaction", async () => {
    const service = new CompletionService();
    service.restore([
      { agentId: A, state: AgentState.Stopped, sessionPath: "/tmp/a" as never, latestCompletion: completion(A, R1, "done") },
      { agentId: B, state: AgentState.Running, sessionPath: "/tmp/b" as never, currentRunId: R2 },
    ]);
    expect((await service.receive()).agents.map((item) => item.agentId).sort()).toEqual([A, B].sort());
  });

  test("17 external cwd does not inherit parent project trust", () => {
    const spec = buildRpcLaunchSpec({
      invocation: { command: "/usr/bin/node" as never, argsPrefix: ["/opt/pi/cli.js"] }, cwd: "/external" as never,
      childSessionDir: "/tmp/sessions" as never, effectiveTools: ["read"], effectiveModel: "mock/model" as never,
      effectiveThinking: "minimal", trustedRoot: "/project" as never, env: {},
    });
    expect(spec.args).not.toContain("--approve");
  });

  test("18 restoration can expose a persisted completion again with the stable run ID", async () => {
    const persisted = completion(A, R1, "stable");
    const first = new CompletionService(); await first.publish(persisted); await first.receive();
    const restored = new CompletionService(); restored.restore([{ agentId: A, state: AgentState.Stopped, sessionPath: "/tmp/a" as never, latestCompletion: persisted }]);
    expect((await restored.receive()).completions[0]?.runId).toBe(R1);
  });

  test("19 stop versus settlement with failed containment retains one stopping terminal obligation", async () => {
    let attempts = 0; let terminals = 0;
    const runs = controller({ onTerminal: () => { terminals++; } });
    runs.register({ agentId: A, state: AgentState.Stopped, transcriptPath: "/tmp/a" as never });
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
    const runs = controller({ capacity: 1, onTerminal: async (record) => {
      persistedTerminal++;
      await completions.publish(completion(record.agentId, record.runId!, "contained"));
    } });
    runs.register({ agentId: A, state: AgentState.Stopped, transcriptPath: "/tmp/a" as never });
    runs.register({ agentId: B, state: AgentState.Stopped, transcriptPath: "/tmp/b" as never });
    await runs.launch(A, async () => ({ status: "accepted", runId: R1, runtime: {
      abort: async () => {},
      contain: async () => {
        if (killOrEmptyProofFails) throw new Error("kill or populated-empty proof failed");
        acceptedV2Receipts++;
        return "/tmp/verified-v2-receipt" as never;
      },
    } }));

    expect((await runs.stop(A, CancellationReason.StopRequested)).status).toBe("containment_failed");
    expect(runs.snapshot(A)?.state).toBe(AgentState.Stopping);
    expect(runs.activeCount()).toBe(1);
    await expect(runs.launch(B, async () => ({ status: "accepted", runId: R2, runtime: runtime() })))
      .rejects.toThrow("capacity_exceeded:");
    expect(persistedTerminal).toBe(0);
    expect(acceptedV2Receipts).toBe(0);
    expect((await completions.receive()).completions).toEqual([]);

    killOrEmptyProofFails = false;
    expect((await runs.stop(A, CancellationReason.StopRequested)).status).toBe("stopped");
    expect(acceptedV2Receipts).toBe(1);
    expect(persistedTerminal).toBe(1);
    expect((await completions.receive()).completions).toMatchObject([{ agentId: A, runId: R1 }]);
    expect(runs.activeCount()).toBe(0);
    expect((await runs.launch(B, async () => ({ status: "accepted", runId: R2, runtime: runtime() }))).status).toBe("running");
  });

  test("21 restored RunStopping finalises only after watchdog-confirmed containment", async () => {
    const root = mkdtempSync(join(tmpdir(), "pi-e2e-restored-stopping-"));
    const receipt = join(root, "attempt.receipt");
    const child = spawnProcess(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { detached: true, stdio: "ignore" });
    await waitSpawn(child);
    process.kill(-child.pid!, "SIGKILL");
    await waitExit(child);
    writeFileSync(receipt, JSON.stringify({ version: 1, attemptId: "attempt", pgid: child.pid,
      outcome: "terminated", timestamp: new Date().toISOString() }));
    expect(processAbsent(child)).toBeTrue();
    expect(String(verifyContainmentReceipt(receipt as never, "attempt" as never).path)).toBe(receipt);

    const entries: Array<{ type: "custom"; customType: string; data: unknown }> = [];
    const appender = new AgentEventAppender((customType, data) => { entries.push({ type: "custom", customType, data }); });
    await appendRunning(appender, receipt);
    await appender.appendRunStopping({ agentId: A, runId: R1, reason: CancellationReason.ParentShutdown,
      containmentReceiptPath: receipt as never });
    const restored = new SubagentController({ restoration: restorationPort(entries, appender) });
    await restored.restore();
    expect(restored.runs.activeCount()).toBe(0);
    expect((await restored.receive()).completions).toMatchObject([{ agentId: A, runId: R1,
      state: CompletionState.Cancelled, reason: CancellationReason.ParentShutdown }]);
    expect(entries.map((entry) => (entry.data as { eventType: string }).eventType).at(-1)).toBe(AgentEventType.RunCompleted);
    rmSync(root, { recursive: true, force: true });
  });

  test("21 repeated restoration bounds duplicate completion visibility by stable run ID", async () => {
    const service = new CompletionService(); const persisted = completion(A, R1, "stable");
    service.restore([{ agentId: A, state: AgentState.Stopped, sessionPath: "/tmp/a" as never, latestCompletion: persisted }]);
    service.restore([{ agentId: A, state: AgentState.Stopped, sessionPath: "/tmp/a" as never, latestCompletion: persisted }]);
    expect((await service.receive()).completions.map((item) => item.runId)).toEqual([R1]);
  });

  test("22 partial assistant output is discarded and prior committed output remains authoritative", () => {
    const dir = mkdtempSync(join(tmpdir(), "pi-subagents-e2e-"));
    try {
      const store = new OutputStore({ workDir: dir }); const attempt = createRunAttemptId();
      store.beginAttempt(attempt); const path = store.bindRun(attempt, R1);
      store.onMessageEnd(R1, assistant("committed"));
      store.onMessageStart(R1, assistant("")); store.onTextDelta(R1, 0, "partial"); store.discardPartial(R1);
      expect(readFileSync(path, "utf8")).toBe("committed");
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  test("23 NEEDS_CONTEXT resume sends the clean literal assignment through the stopped-agent path", async () => {
    const assignment = "Additional context without protocol markers";
    let prompted = "";
    const host = controllerWithNativeLaunch(A, R2, (message) => { prompted = message; });
    host.runs.restore([{ agentId: A, state: AgentState.Stopped, transcriptPath: "/tmp/a" as never, runId: R1 }]);

    const resumed = await host.sendInput(A, assignment);

    expect(resumed).toEqual({ agentId: A, runId: R2, state: AgentState.Running });
    expect(prompted).toBe(assignment);
    expect(prompted).not.toMatch(/NEEDS_CONTEXT|<subagent|assignment:/i);
    await host.shutdown();
  });

  test("24 public IDs come from the native session and first assignment entry", async () => {
    const nativeSessionId = agentId("native-session-42"); const assignmentEntryId = runId("0123abcd");
    const host = controllerWithNativeLaunch(nativeSessionId, assignmentEntryId, () => {});

    const value = await host.spawn({ task: "literal assignment" });

    expect(value).toEqual({ agentId: nativeSessionId, runId: assignmentEntryId, state: AgentState.Running,
      model: modelSpec("mock-provider/luna"), thinkingLevel: "high", tools: ["read"] });
    expect(host.runs.snapshot(nativeSessionId)).toMatchObject({ agentId: nativeSessionId, runId: assignmentEntryId });
    await host.shutdown();
  });
});

function completion(id: AgentId, run: RunId, text: string): AgentCompletion {
  return { agentId: id, runId: run, state: CompletionState.Completed, output: truncateUtf8(text, 50_000),
    outputPath: `/tmp/${id}-${run}.txt` as never, transcriptPath: `/tmp/${id}.jsonl` as never };
}
function summary(id: AgentId, state: typeof AgentState.Running, currentRunId: RunId) {
  return { agentId: id, state, transcriptPath: `/tmp/${id}.jsonl` as never, currentRunId };
}
function controller(options: Partial<RunControllerOptions> = {}) { return new RunController({ capacity: 2, ...options }); }
async function start(runs: RunController, id: AgentId, run: RunId) {
  runs.register({ agentId: id, state: AgentState.Stopped, transcriptPath: `/tmp/${id}` as never });
  return runs.launch(id, async () => ({ status: "accepted", runId: run, runtime: runtime() }));
}
function runtime(contain: () => Promise<void> = async () => {}) {
  return { abort: async () => {}, contain: async () => { await contain(); return "/tmp/receipt" as never; } };
}
function assistant(text: string) {
  return { role: "assistant", content: [{ type: "text", text }], stopReason: "stop", usage: {
    input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  }, timestamp: Date.now() } as never;
}

function controllerWithNativeLaunch(id: AgentId, nativeRunId: RunId, onPrompt: (message: string) => void): SubagentController {
  const session = { agentId: id, transcriptPath: `/tmp/${id}.jsonl` as never, previousLeafId: null,
    attemptId: `attempt-${id}` as never, containmentReceiptPath: `/tmp/${id}.receipt` as never };
  const launch = async (surrender: SurrenderContainment) => {
    const owned = runtime();
    surrender(owned);
    let reads = 0;
    let assignment = "";
    return {
      runtime: owned,
      containment: { backend: "cgroup-v2" as const, scopePath: "/tmp/test-cgroup/attempt" as never },
      ready: async () => {}, persistLaunchRequested: async () => {}, persistRunStarted: async () => {}, start: async () => {},
      getEntries: async () => reads++ === 0 ? { entries: [], leafId: null } : {
        entries: [{ type: "message", id: nativeRunId, message: { role: "user", content: assignment } }], leafId: nativeRunId,
      },
      prompt: async (message: string) => { assignment = message; onPrompt(message); }, waitForAgentStart: async () => {}, bindRun: () => {}, waitSettled: () => new Promise<never>(() => {}),
    };
  };
  return new SubagentController({ composition: {
    prepareSpawn: async () => ({ selection: { model: modelSpec("mock-provider/luna"), thinkingLevel: "high", tools: ["read"] },
      createSession: async () => session, persistSpawned: async () => {}, createLaunch: async (_session, surrender) => launch(surrender) }),
    prepareSend: async () => ({ session, createLaunch: launch }),
  } });
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

async function appendRunning(appender: AgentEventAppender, receipt: string): Promise<void> {
  await appender.appendSpawned({ agentId: A, sessionPath: "/tmp/agent-a.jsonl" as never, cwd: "/tmp" as never,
    provider: "mock", modelId: "mock/model" as never, thinkingLevel: "minimal", tools: [] });
  await appender.appendRunLaunchRequested({ agentId: A, previousLeafId: null, attemptId: "attempt" as never,
    containmentReceiptPath: receipt as never,
    containment: { backend: "cgroup-v2", scopePath: "/tmp/test-cgroup/attempt" as never } });
  await appender.appendRunStarted({ agentId: A, runId: R1, attemptId: "attempt" as never });
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
    stateRoot: "/tmp" as never,
    getBranch: () => entries,
    resolveContainment: async ({ receiptPath, attemptId }) => ({
      kind: "contained",
      receipt: verifyContainmentReceipt(receiptPath, attemptId).path,
    }),
    firstUserEntryAfter: async () => undefined,
    finaliseContained: async (record, nativeRunId, settlement) => settlement.kind === "cancelled"
      ? ({ ...completion(record.agentId, nativeRunId, ""), state: CompletionState.Cancelled, reason: settlement.reason })
      : ({ ...completion(record.agentId, nativeRunId, ""),
        state: CompletionState.Failed, error: { code: AgentErrorCode.RunInterrupted, message: "interrupted" } }),
    appender,
  };
}
