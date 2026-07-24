import { describe, expect, test } from "bun:test";
import { AgentObservationStore, createTotalRpcObservationAdapter } from "../src/agent-observation-store.ts";
import type { ObservationReconciliationSnapshot } from "../src/agent-observation.ts";
import { createContextObservationService } from "../src/context-observation.ts";
import { rpcContentIndex, rpcToolCallId } from "../src/domain.ts";
import { toolDisplayName, transcriptText } from "../src/agent-observation.ts";
import {
  AgentState,
  CompletionState,
  agentId,
  agentRunKey,
  directAgentOrdinal,
  modelSpec,
  runAttemptId,
  runId,
  truncateUtf8,
  utf8Bytes,
} from "../src/domain.ts";
import { testAbsolutePath, testCommittedOutputPath, testSessionPath } from "./support/brands.ts";

const R1 = runId("deadbeef");
const A = agentId("agent-a");
const flush = () => Promise.resolve().then(() => Promise.resolve());

function register(store: AgentObservationStore, id = A, position = 1, assignment = "Review races"): void {
  store.registerSpawned({
    agentId: id,
    ordinal: directAgentOrdinal(position),
    assignment,
    sessionPath: testSessionPath(`/tmp/pi-subagents-test/${id}.jsonl`),
    cwd: testAbsolutePath("/tmp/pi-subagents-test"),
    model: modelSpec("mock-provider/luna"),
    thinkingLevel: "high",
  });
}

function completion(id = A, run = R1) {
  return {
    agentId: id,
    runId: run,
    state: CompletionState.Completed,
    output: truncateUtf8("done", utf8Bytes(50_000)),
    outputPath: testCommittedOutputPath({ workDir: testAbsolutePath("/tmp/pi-subagents-test/output"), runId: run }),
    transcriptPath: testSessionPath(`/tmp/pi-subagents-test/${id}.jsonl`),
  } as const;
}

describe("AgentObservationStore", () => {
  test("buffers scoped activity before exact bind and replays context boundaries afterwards", async () => {
    const store = new AgentObservationStore(); register(store);
    const attempt = runAttemptId("attempt-a"); let statsCalls = 0;
    const context = createContextObservationService({ getSessionStats: async () => { statsCalls++; return { contextUsage: { tokens: 20, contextWindow: 100, percent: 20 } }; } }, (run, value) => store.updateContext(A, run, value));
    const sink = createTotalRpcObservationAdapter(store, context, { agentId: A, attemptId: attempt }, () => {});
    sink.record({ kind: "assistant-content", contentIndex: rpcContentIndex(0), contentKind: "thinking", phase: "delta", text: transcriptText("plan") });
    sink.record({ kind: "turn-end" });
    expect(statsCalls).toBe(0);
    store.acceptRun({ agentId: A, runId: R1, attemptId: attempt, assignment: "Review races" });
    sink.bind(R1); await flush();
    expect(statsCalls).toBe(1);
    expect(store.observation(A)).toMatchObject({ activity: { kind: "thinking", preview: "plan" }, context: { kind: "known", percent: 20 } });
  });

  test("projects tool, idle, and transport activity in stream order", () => {
    const store = new AgentObservationStore(); register(store); const attempt = runAttemptId("attempt-a");
    store.acceptRun({ agentId: A, runId: R1, attemptId: attempt, assignment: "Review races" });
    const sink = store.createAttemptSink(A, attempt); sink.bind(R1);
    sink.record({ kind: "tool", toolCallId: rpcToolCallId("call-1"), tool: toolDisplayName("read"), phase: "running" });
    expect(store.observation(A)?.activity).toMatchObject({ kind: "tool", tool: "read", phase: "running" });
    sink.record({ kind: "agent-settled" });
    expect(store.observation(A)?.activity).toEqual({ kind: "idle" });
    sink.record({ kind: "transport-unavailable" });
    expect(store.observation(A)?.activity).toEqual({ kind: "unavailable", reason: "transport" });
  });

  test("rejects one pending attempt above the 64 KiB byte cap", () => {
    const store = new AgentObservationStore(); register(store); const attempt = runAttemptId("attempt-a");
    const sink = store.createAttemptSink(A, attempt);
    for (let index = 0; index < 8; index++) sink.record({ kind: "prompt-accepted", text: transcriptText("x".repeat(8_192)) });
    sink.record({ kind: "assistant-content", contentIndex: rpcContentIndex(0), contentKind: "thinking", phase: "delta", text: transcriptText("rejected") });
    store.acceptRun({ agentId: A, runId: R1, attemptId: attempt, assignment: "Review races" });
    sink.bind(R1);
    expect(store.observation(A)?.activity).toEqual({ kind: "idle" });
  });

  test("the 65th small event rejects the attempt independently of the byte cap", () => {
    const store = new AgentObservationStore(); register(store); const attempt = runAttemptId("attempt-a");
    const sink = store.createAttemptSink(A, attempt);
    sink.record({ kind: "assistant-content", contentIndex: rpcContentIndex(0), contentKind: "thinking", phase: "delta", text: transcriptText("would-project") });
    for (let index = 0; index < 64; index++) sink.record({ kind: "turn-end" });
    store.acceptRun({ agentId: A, runId: R1, attemptId: attempt, assignment: "Review races" });
    sink.bind(R1);
    expect(store.observation(A)?.activity).toEqual({ kind: "idle" });
  });

  test("the 256-event global cap rejects the oldest pending attempt deterministically", () => {
    const store = new AgentObservationStore();
    const attempts = Array.from({ length: 5 }, (_, index) => {
      const id = agentId(`agent-${index}`); const attempt = runAttemptId(`attempt-${index}`);
      register(store, id, index + 1);
      const sink = store.createAttemptSink(id, attempt);
      if (index < 4) {
        for (let event = 0; event < 63; event++) sink.record({ kind: "turn-end" });
        sink.record({ kind: "assistant-content", contentIndex: rpcContentIndex(0), contentKind: "thinking", phase: "delta", text: transcriptText(`plan-${index}`) });
      } else sink.record({ kind: "turn-end" });
      return { id, attempt, sink, run: runId(index.toString(16).padStart(8, "0")) };
    });
    for (const value of attempts) { store.acceptRun({ agentId: value.id, runId: value.run, attemptId: value.attempt, assignment: "Review races" }); value.sink.bind(value.run); }
    expect(store.observation(attempts[0]!.id)?.activity).toEqual({ kind: "idle" });
    expect(store.observation(attempts[1]!.id)?.activity).toMatchObject({ kind: "thinking", preview: "plan-1" });
  });

  test("the 256 KiB global cap rejects the oldest pending attempt deterministically", () => {
    const store = new AgentObservationStore();
    const attempts = Array.from({ length: 6 }, (_, index) => {
      const id = agentId(`byte-agent-${index}`); const attempt = runAttemptId(`byte-attempt-${index}`);
      register(store, id, index + 1);
      const sink = store.createAttemptSink(id, attempt);
      sink.record({ kind: "assistant-content", contentIndex: rpcContentIndex(0), contentKind: "thinking", phase: "delta", text: transcriptText(`plan-${index}`) });
      const count = index < 5 ? 7 : 3;
      for (let event = 0; event < count; event++) sink.record({ kind: "prompt-accepted", text: transcriptText("x".repeat(7_000)) });
      return { id, attempt, sink, run: runId((index + 16).toString(16).padStart(8, "0")) };
    });
    for (const value of attempts) { store.acceptRun({ agentId: value.id, runId: value.run, attemptId: value.attempt, assignment: "Review races" }); value.sink.bind(value.run); }
    expect(store.observation(attempts[0]!.id)?.activity).toEqual({ kind: "idle" });
    expect(store.observation(attempts[1]!.id)?.activity).toMatchObject({ kind: "thinking", preview: "plan-1" });
  });

  test.each(["wrong agent", "wrong run", "wrong attempt"] as const)("%s bind fails closed", (mismatch) => {
    const store = new AgentObservationStore(); register(store); register(store, agentId("agent-b"), 2);
    const accepted = runAttemptId("accepted-attempt");
    store.acceptRun({ agentId: A, runId: R1, attemptId: accepted, assignment: "Review races" });
    const sink = mismatch === "wrong agent"
      ? store.createAttemptSink(agentId("agent-b"), accepted)
      : store.createAttemptSink(A, mismatch === "wrong attempt" ? runAttemptId("other-attempt") : accepted);
    sink.record({ kind: "assistant-content", contentIndex: rpcContentIndex(0), contentKind: "thinking", phase: "delta", text: transcriptText("must-not-project") });
    sink.bind(mismatch === "wrong run" ? runId("cafebabe") : R1);
    sink.record({ kind: "assistant-content", contentIndex: rpcContentIndex(0), contentKind: "thinking", phase: "delta", text: transcriptText("still-rejected") });
    expect(store.observation(A)?.activity).toEqual({ kind: "idle" });
    expect(store.observation(agentId("agent-b"))?.activity).toEqual({ kind: "idle" });
  });

  test("discard releases global event accounting before the next attempt", () => {
    const store = new AgentObservationStore();
    const attempts = Array.from({ length: 5 }, (_, index) => {
      const id = agentId(`release-agent-${index}`); const attempt = runAttemptId(`release-attempt-${index}`);
      register(store, id, index + 1); const sink = store.createAttemptSink(id, attempt);
      if (index < 4) {
        for (let event = 0; event < 63; event++) sink.record({ kind: "turn-end" });
        sink.record({ kind: "assistant-content", contentIndex: rpcContentIndex(0), contentKind: "thinking", phase: "delta", text: transcriptText(`plan-${index}`) });
      }
      return { id, attempt, sink, run: runId((index + 32).toString(16).padStart(8, "0")) };
    });
    attempts[0]!.sink.discard();
    attempts[4]!.sink.record({ kind: "turn-end" });
    const second = attempts[1]!;
    store.acceptRun({ agentId: second.id, runId: second.run, attemptId: second.attempt, assignment: "Review races" });
    second.sink.bind(second.run);
    expect(store.observation(second.id)?.activity).toMatchObject({ kind: "thinking", preview: "plan-1" });
  });

  test("store disposal releases pending accounting and makes all attempt sinks terminal", () => {
    const store = new AgentObservationStore(); register(store); const sink = store.createAttemptSink(A, runAttemptId("attempt-a"));
    for (let index = 0; index < 64; index++) sink.record({ kind: "turn-end" });
    store.dispose();
    expect(() => { sink.discard(); sink.record({ kind: "turn-end" }); sink.bind(R1); }).not.toThrow();
    expect(store.directSnapshot()).toMatchObject({ kind: "unavailable" });
  });

  test("registers immutable observations and preserves identity on no-op lifecycle updates", () => {
    const store = new AgentObservationStore();
    register(store);
    store.acceptRun({ agentId: A, runId: R1, attemptId: runAttemptId("attempt-a"), assignment: "Review races" });
    store.updateLifecycle({ agentId: A, runId: R1, state: AgentState.Running, transcriptPath: testSessionPath("/tmp/pi-subagents-test/agent-a.jsonl") });
    const before = store.observation(A)!;
    const snapshot = store.directSnapshot();
    store.updateLifecycle({ agentId: A, runId: R1, state: AgentState.Running, transcriptPath: testSessionPath("/tmp/pi-subagents-test/agent-a.jsonl") });
    expect(store.observation(A)).toBe(before);
    expect(store.directSnapshot()).toBe(snapshot);
    expect(Object.isFrozen(before)).toBeTrue();
    expect(Object.isFrozen(before.activity)).toBeTrue();
  });

  test("directSnapshot prioritises active agents and reports exact omission", () => {
    const store = new AgentObservationStore();
    for (let index = 0; index < 205; index++) register(store, agentId(`terminal-${index}`), index + 1);
    for (let index = 0; index < 3; index++) {
      const id = agentId(`active-${index}`);
      register(store, id, 206 + index);
      store.updateLifecycle({ agentId: id, runId: R1, state: AgentState.Running, transcriptPath: testSessionPath(`/tmp/pi-subagents-test/${id}.jsonl`) });
    }
    const snapshot = store.directSnapshot();
    if (snapshot.kind !== "snapshot") throw new Error("expected snapshot");
    expect(snapshot.entries).toHaveLength(200);
    expect(snapshot.entries.filter(({ observation }) => observation.lifecycleState !== AgentState.Stopped)).toHaveLength(3);
    expect(String(snapshot.entries[0]!.observation.ordinal)).toBe("A9");
    expect(Number(snapshot.total)).toBe(208);
    expect(Number(snapshot.omitted)).toBe(8);
    expect(Number(snapshot.omittedActive)).toBe(0);
  });

  test("reports active omission when more than the cap are active", () => {
    const store = new AgentObservationStore();
    for (let index = 0; index < 203; index++) {
      const id = agentId(`active-${index}`);
      register(store, id, index + 1);
      store.updateLifecycle({ agentId: id, runId: R1, state: AgentState.Running, transcriptPath: testSessionPath(`/tmp/pi-subagents-test/${id}.jsonl`) });
    }
    expect(store.directSnapshot()).toMatchObject({ total: 203, omitted: 3, omittedActive: 3 });
  });

  test("completion outcome survives exact delivery acknowledgement", () => {
    const store = new AgentObservationStore();
    register(store);
    store.acceptRun({ agentId: A, runId: R1, attemptId: runAttemptId("attempt-a"), assignment: "Review races" });
    store.publishCompletion(completion());
    store.updateLifecycle({ agentId: A, runId: R1, state: AgentState.Stopped, transcriptPath: testSessionPath("/tmp/pi-subagents-test/agent-a.jsonl") });
    expect(store.observation(A)).toMatchObject({ displayState: "completed", completionPendingDelivery: true });
    store.acknowledgeDelivered([agentRunKey(A, R1)]);
    expect(store.observation(A)).toMatchObject({ displayState: "completed", completionPendingDelivery: false });
  });

  test("registering a child atomically rederives labels containing its newly sensitive ID", async () => {
    const store = new AgentObservationStore();
    register(store, A, 1, "Review agent-b result");
    await flush();
    const labels: string[] = [];
    store.subscribe(() => { labels.push(String(store.observation(A)?.taskLabel)); });

    register(store, agentId("agent-b"), 2, "Inspect output");
    await flush();

    expect(labels).toEqual(["Review path result"]);
    expect(String(store.observation(A)?.taskLabel)).toBe("Review path result");
  });

  test("a lifecycle run ID addition atomically rederives every retained label", async () => {
    const store = new AgentObservationStore();
    register(store, A, 1, "Review deadbeef result");
    const other = agentId("agent-b");
    register(store, other, 2, "Inspect output");
    await flush();
    const labels: string[] = [];
    store.subscribe(() => { labels.push(String(store.observation(A)?.taskLabel)); });

    store.updateLifecycle({ agentId: other, runId: R1, state: AgentState.Running, transcriptPath: testSessionPath("/tmp/pi-subagents-test/agent-b.jsonl") });
    await flush();

    expect(labels).toEqual(["Review path result"]);
  });

  test("new sensitive values rederive every retained label before notification", async () => {
    const store = new AgentObservationStore();
    register(store, A, 1, "Review agent-b at /tmp/a.ts");
    register(store, agentId("agent-b"), 2, "Inspect output");
    const labels: string[][] = [];
    store.subscribe(() => {
      const snapshot = store.directSnapshot();
      if (snapshot.kind === "snapshot") labels.push(snapshot.entries.map((entry) => entry.row.taskLabel));
    });
    store.registerSensitiveValues({
      agentIds: new Set([A, agentId("agent-b")]),
      runIds: new Set([R1]),
      internalPaths: new Set([testAbsolutePath("/tmp/a.ts")]),
    });
    await flush();
    expect(labels.at(-1)?.[0]).not.toContain("agent-b");
    expect(labels.at(-1)?.[0]).not.toContain("/tmp/a.ts");
  });

  test("coalesces revisions and isolates throwing, thenable, re-entrant, and unsubscribed listeners", async () => {
    const diagnostics: string[] = [];
    const store = new AgentObservationStore({ diagnostic: (message) => diagnostics.push(message) });
    register(store);
    await flush();
    const calls: string[] = [];
    store.subscribe(() => { calls.push("throw"); throw new Error("listener fault"); });
    store.subscribe(() => { calls.push("thenable"); return Promise.resolve() as never; });
    store.subscribe(() => { calls.push("reentrant"); store.updateLifecycle({ agentId: A, state: AgentState.Stopping, runId: R1, transcriptPath: testSessionPath("/tmp/pi-subagents-test/agent-a.jsonl") }); });
    const unsubscribe = store.subscribe(() => { calls.push("unsubscribed"); });
    unsubscribe();
    store.updateLifecycle({ agentId: A, state: AgentState.Running, runId: R1, transcriptPath: testSessionPath("/tmp/pi-subagents-test/agent-a.jsonl") });
    store.updateLifecycle({ agentId: A, state: AgentState.Settling, runId: R1, transcriptPath: testSessionPath("/tmp/pi-subagents-test/agent-a.jsonl") });
    await flush();
    await flush();
    expect(calls).toEqual(["throw", "thenable", "reentrant", "reentrant"]);
    expect(diagnostics).toHaveLength(2);
  });

  test("completion input is copied without retaining a mutable output-bearing DTO", () => {
    const store = new AgentObservationStore();
    register(store);
    store.acceptRun({ agentId: A, runId: R1, attemptId: runAttemptId("attempt-a"), assignment: "Review races" });
    const supplied = { ...completion(), output: { ...completion().output } };
    store.publishCompletion(supplied);
    supplied.runId = runId("cafebabe");
    supplied.output.text = "mutated secret";

    store.acknowledgeDelivered([agentRunKey(A, R1)]);

    expect(store.observation(A)).toMatchObject({ displayState: "completed", completionPendingDelivery: false });
  });

  test("fresh reconciliation invalidates a cached empty snapshot and publishes the committed revision", async () => {
    const store = new AgentObservationStore();
    const empty = store.directSnapshot();
    const changes: Array<{ revision: number; changed: readonly string[]; rescanRequired: boolean }> = [];
    store.subscribe((change) => {
      changes.push({ revision: Number(change.revision), changed: change.changed.map(String), rescanRequired: change.rescanRequired });
    });

    store.reconcile({
      spawnSequence: [A],
      agents: [{ agentId: A, sessionPath: testSessionPath("/tmp/pi-subagents-test/agent-a.jsonl"), cwd: testAbsolutePath("/tmp/pi-subagents-test"), model: modelSpec("mock-provider/luna"), thinkingLevel: "high" }],
      runs: [{ agentId: A, state: AgentState.Stopped }], completions: [], pendingDelivery: new Set(),
      acceptedAssignments: new Map(),
      sensitiveValues: { agentIds: new Set([A]), runIds: new Set(), internalPaths: new Set() },
    });
    await flush();

    const snapshot = store.directSnapshot();
    if (snapshot.kind !== "snapshot") throw new Error("expected snapshot");
    expect(snapshot).not.toBe(empty);
    expect(Number(snapshot.total)).toBe(1);
    expect(store.observation(A)?.revision).toBe(snapshot.revision);
    expect(changes).toEqual([{ revision: Number(snapshot.revision), changed: ["A1"], rescanRequired: false }]);
  });

  test("failed reconciliation retries on the next authoritative mutation", async () => {
    let attempts = 0;
    const authority = (): ObservationReconciliationSnapshot => {
      attempts++;
      if (attempts === 1) throw new Error("authority temporarily unavailable");
      return {
        spawnSequence: [A],
        agents: [{ agentId: A, sessionPath: testSessionPath("/tmp/pi-subagents-test/agent-a.jsonl"), cwd: testAbsolutePath("/tmp/pi-subagents-test"), model: modelSpec("mock-provider/luna"), thinkingLevel: "high" as const }],
        runs: [{ agentId: A, state: AgentState.Stopped }],
        completions: [], pendingDelivery: new Set(), acceptedAssignments: new Map(),
        sensitiveValues: { agentIds: new Set([A]), runIds: new Set(), internalPaths: new Set() },
      };
    };
    const store = new AgentObservationStore({ reconciliation: authority });
    store.testAdapter().reportProjectionFailure();
    await flush();
    expect(store.directSnapshot()).toMatchObject({ health: { kind: "degraded", codes: ["reconciliation-failed"] } });

    store.registerSensitiveValues({ agentIds: new Set([A]), runIds: new Set(), internalPaths: new Set() });
    await flush();

    expect(attempts).toBe(2);
    expect(store.directSnapshot()).toMatchObject({ health: { kind: "healthy" }, total: 1 });
  });

  test("reconciliation restores authoritative ordinal and model metadata", () => {
    const store = new AgentObservationStore();
    store.registerSpawned({ agentId: A, ordinal: directAgentOrdinal(9), assignment: "Review races",
      sessionPath: testSessionPath("/tmp/pi-subagents-test/agent-a.jsonl"), cwd: testAbsolutePath("/tmp/pi-subagents-test"),
      model: modelSpec("mock-provider/wrong"), thinkingLevel: "low" });

    store.reconcile({
      spawnSequence: [A],
      agents: [{ agentId: A, sessionPath: testSessionPath("/tmp/pi-subagents-test/agent-a.jsonl"), cwd: testAbsolutePath("/tmp/pi-subagents-test"), model: modelSpec("mock-provider/luna"), thinkingLevel: "high" }],
      runs: [{ agentId: A, state: AgentState.Stopped }], completions: [], pendingDelivery: new Set(),
      acceptedAssignments: new Map(),
      sensitiveValues: { agentIds: new Set([A]), runIds: new Set(), internalPaths: new Set() },
    });

    expect(store.observation(A)).toMatchObject({ ordinal: "A1", modelLabel: "luna:h" });
  });

  test("restoration preserves outcome, pending delivery, and same-branch ordinal", () => {
    const snapshot: ObservationReconciliationSnapshot = {
      spawnSequence: [A, agentId("agent-b")],
      agents: [A, agentId("agent-b")].map((id) => ({ agentId: id,
        sessionPath: testSessionPath(`/tmp/pi-subagents-test/${id}.jsonl`), cwd: testAbsolutePath("/tmp/pi-subagents-test"),
        model: modelSpec("mock-provider/luna"), thinkingLevel: "high" })),
      runs: [{ agentId: A, state: AgentState.Stopped, runId: R1 }, { agentId: agentId("agent-b"), state: AgentState.Stopped }],
      completions: [completion()], pendingDelivery: new Set([agentRunKey(A, R1)]),
      acceptedAssignments: new Map([[agentRunKey(A, R1), "Review races"]]),
      sensitiveValues: { agentIds: new Set([A, agentId("agent-b")]), runIds: new Set([R1]), internalPaths: new Set() },
    };
    const first = new AgentObservationStore();
    first.reconcile(snapshot);
    expect(first.observation(A)).toMatchObject({ ordinal: "A1", displayState: "completed", completionPendingDelivery: true });
    first.acknowledgeDelivered([agentRunKey(A, R1)]);
    expect(first.observation(A)?.completionPendingDelivery).toBeFalse();

    const reloaded = new AgentObservationStore();
    reloaded.reconcile(snapshot);
    expect(reloaded.observation(A)).toMatchObject({ ordinal: "A1", displayState: "completed", completionPendingDelivery: true });
  });

  test("truthful reconciliation removes observations absent from authority", () => {
    const store = new AgentObservationStore();
    register(store, A, 1);
    register(store, agentId("agent-b"), 2);

    store.reconcile({
      spawnSequence: [A],
      agents: [{ agentId: A, sessionPath: testSessionPath("/tmp/pi-subagents-test/agent-a.jsonl"), cwd: testAbsolutePath("/tmp/pi-subagents-test"), model: modelSpec("mock-provider/luna"), thinkingLevel: "high" }],
      runs: [{ agentId: A, state: AgentState.Stopped }], completions: [], pendingDelivery: new Set(),
      acceptedAssignments: new Map(),
      sensitiveValues: { agentIds: new Set([A]), runIds: new Set(), internalPaths: new Set() },
    });

    expect(store.observation(agentId("agent-b"))).toBeUndefined();
    expect(store.directSnapshot()).toMatchObject({ total: 1 });
  });

  test("projection failure reconciles from authority and disposal is terminal", async () => {
    const store = new AgentObservationStore({ reconciliation: () => ({
      spawnSequence: [A],
      agents: [{ agentId: A, sessionPath: testSessionPath("/tmp/pi-subagents-test/agent-a.jsonl"), cwd: testAbsolutePath("/tmp/pi-subagents-test"), model: modelSpec("mock-provider/luna"), thinkingLevel: "high" }],
      runs: [{ agentId: A, state: AgentState.Running, runId: R1 }],
      completions: [],
      pendingDelivery: new Set(),
      acceptedAssignments: new Map([[agentRunKey(A, R1), "Review races"]]),
      sensitiveValues: { agentIds: new Set([A]), runIds: new Set([R1]), internalPaths: new Set() },
    }) });
    store.testAdapter().reportProjectionFailure();
    expect(store.directSnapshot()).toMatchObject({ health: { kind: "degraded", codes: ["projection-failed"] } });
    await flush();
    expect(store.directSnapshot()).toMatchObject({ health: { kind: "healthy" }, total: 1 });
    const beforeDispose = store.directSnapshot();
    const revision = beforeDispose.kind === "snapshot" ? beforeDispose.revision : 0;
    store.dispose();
    expect(store.directSnapshot()).toMatchObject({ kind: "unavailable", finalRevision: Number(revision) + 1 });
    expect(store.observation(A)).toBeUndefined();
    expect(store.transcriptSource(A)).toBeUndefined();
    expect(() => store.updateLifecycle({ agentId: A, state: AgentState.Stopped, transcriptPath: testSessionPath("/tmp/pi-subagents-test/agent-a.jsonl") })).not.toThrow();
  });
});
