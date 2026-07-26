import { describe, expect, test } from "bun:test";
import { AgentObservationStore, createTotalRpcObservationAdapter } from "../src/agent-observation-store.ts";
import type { ObservationReconciliationSnapshot, TranscriptItem } from "../src/agent-observation.ts";
import { createContextObservationService } from "../src/context-observation.ts";
import { rpcContentIndex, rpcStopReason, rpcToolCallId } from "../src/domain.ts";
import { toolDisplayName, transcriptText } from "../src/agent-observation.ts";
import {
  AgentState,
  CompletionState,
  agentId,
  agentRunKey,
  contextPercent,
  directAgentOrdinal,
  modelSpec,
  runAttemptId,
  runId,
  transcriptFileName,
  truncateUtf8,
  utf8Bytes,
  type AgentId,
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

function registerAt(store: AgentObservationStore, id: AgentId, path: string): void {
  store.registerSpawned({
    agentId: id,
    ordinal: directAgentOrdinal(1),
    assignment: "Review races",
    sessionPath: testSessionPath(path),
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
    sink.record({ kind: "assistant-content", contentIndex: rpcContentIndex(0), contentKind: "thinking", phase: "delta", delta: transcriptText("plan") });
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
    sink.record({ kind: "assistant-content", contentIndex: rpcContentIndex(0), contentKind: "thinking", phase: "delta", delta: transcriptText("rejected") });
    store.acceptRun({ agentId: A, runId: R1, attemptId: attempt, assignment: "Review races" });
    sink.bind(R1);
    expect(store.observation(A)?.activity).toEqual({ kind: "idle" });
  });

  test("the 65th small event rejects the attempt independently of the byte cap", () => {
    const store = new AgentObservationStore(); register(store); const attempt = runAttemptId("attempt-a");
    const sink = store.createAttemptSink(A, attempt);
    sink.record({ kind: "assistant-content", contentIndex: rpcContentIndex(0), contentKind: "thinking", phase: "delta", delta: transcriptText("would-project") });
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
        sink.record({ kind: "assistant-content", contentIndex: rpcContentIndex(0), contentKind: "thinking", phase: "delta", delta: transcriptText(`plan-${index}`) });
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
      sink.record({ kind: "assistant-content", contentIndex: rpcContentIndex(0), contentKind: "thinking", phase: "delta", delta: transcriptText(`plan-${index}`) });
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
    sink.record({ kind: "assistant-content", contentIndex: rpcContentIndex(0), contentKind: "thinking", phase: "delta", delta: transcriptText("must-not-project") });
    sink.bind(mismatch === "wrong run" ? runId("cafebabe") : R1);
    sink.record({ kind: "assistant-content", contentIndex: rpcContentIndex(0), contentKind: "thinking", phase: "delta", delta: transcriptText("still-rejected") });
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
        sink.record({ kind: "assistant-content", contentIndex: rpcContentIndex(0), contentKind: "thinking", phase: "delta", delta: transcriptText(`plan-${index}`) });
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

  test("field-equivalent context and activity updates preserve observation and direct snapshot identity", () => {
    const store = new AgentObservationStore(); register(store);
    const attempt = runAttemptId("semantic-no-op");
    store.acceptRun({ agentId: A, runId: R1, attemptId: attempt, assignment: "Review races" });
    const sink = store.createAttemptSink(A, attempt); sink.bind(R1);
    store.updateContext(A, R1, { kind: "known", percent: contextPercent(25) });
    sink.record({ kind: "tool", toolCallId: rpcToolCallId("same-tool"), tool: toolDisplayName("read"), phase: "running", preview: transcriptText("preview") });
    const observation = store.observation(A)!;
    const direct = store.directSnapshot();
    const revision = observation.revision;
    const directRevision = direct.kind === "snapshot" ? direct.revision : undefined;

    store.updateContext(A, R1, { kind: "known", percent: contextPercent(25) });
    sink.record({ kind: "tool", toolCallId: rpcToolCallId("same-tool"), tool: toolDisplayName("read"), phase: "running", preview: transcriptText("preview") });

    expect(store.observation(A)).toBe(observation);
    expect(store.observation(A)!.revision).toBe(revision);
    expect(store.directSnapshot()).toBe(direct);
    expect(store.directSnapshot()).toMatchObject({ revision: directRevision });
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

  test("projects an owner-relative transcript basename derived from the authoritative session path", () => {
    const store = new AgentObservationStore();
    registerAt(store, A, "/tmp/pi-subagents-test/state/owner/sessions/child.jsonl");
    const direct = store.directSnapshot();
    if (direct.kind !== "snapshot") throw new Error("expected snapshot");

    expect(direct.entries[0]).toMatchObject({ transcriptFile: transcriptFileName("child.jsonl") });
    expect(direct.health).toEqual({ kind: "healthy" });
    expect(JSON.stringify(direct)).not.toContain("/state/owner/sessions");
  });

  test("degrades projection health but retains the row when the session basename is unsafe", () => {
    const store = new AgentObservationStore();
    registerAt(store, A, "/tmp/pi-subagents-test/state/owner/sessions/child");
    const direct = store.directSnapshot();
    if (direct.kind !== "snapshot") throw new Error("expected snapshot");

    expect(direct.entries).toHaveLength(1);
    expect(direct.entries[0]!.transcriptFile).toBeUndefined();
    expect(direct.entries[0]!.observation.lifecycleState).toBe(AgentState.Stopped);
    expect(direct.health).toEqual({ kind: "degraded", codes: ["projection-failed"] });
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

  test("bind flushes prompt before assistant and replacements preserve sequence", () => {
    const store = new AgentObservationStore(); register(store);
    const attempt = runAttemptId("transcript-a");
    const sink = store.createAttemptSink(A, attempt);
    sink.record({ kind: "prompt-accepted", text: transcriptText("Review races") });
    sink.record({ kind: "assistant-start" });
    sink.record({ kind: "assistant-content", contentIndex: rpcContentIndex(0), contentKind: "text", phase: "delta", delta: transcriptText("Hel") });
    store.acceptRun({ agentId: A, runId: R1, attemptId: attempt, assignment: "Review races" });
    sink.bind(R1);
    const before = store.transcriptSource(A)!.snapshot();
    const assistantSequence = before.items[1]!.sequence;
    sink.record({ kind: "assistant-content", contentIndex: rpcContentIndex(0), contentKind: "text", phase: "delta", delta: transcriptText("lo") });
    const after = store.transcriptSource(A)!.snapshot();
    expect(after.items.map(({ kind }) => kind)).toEqual(["user", "assistant"]);
    expect(after.items[1]).toMatchObject({ sequence: assistantSequence, phase: "partial", text: "Hello", runId: R1 });
    expect(Number(after.revision)).toBeGreaterThan(Number(before.revision));
  });

  test("assistant delta saturation is a stable no-op and an end snapshot replaces accumulated chunks", () => {
    const { store, sink } = boundTranscriptStore();
    sink.record({ kind: "assistant-start" });
    sink.record({ kind: "assistant-content", contentIndex: rpcContentIndex(0), contentKind: "text", phase: "delta", delta: transcriptText("🙂".repeat(2_048)) });
    const source = store.transcriptSource(A)!;
    const saturated = source.snapshot();

    sink.record({ kind: "assistant-content", contentIndex: rpcContentIndex(0), contentKind: "text", phase: "delta", delta: transcriptText("ignored") });

    expect(source.snapshot()).toBe(saturated);
    expect(source.snapshot().items[0]).toMatchObject({ phase: "partial", text: "🙂".repeat(2_048) });

    sink.record({ kind: "assistant-content", contentIndex: rpcContentIndex(0), contentKind: "text", phase: "end", text: transcriptText("authoritative final") });
    expect(source.snapshot().items).toEqual([
      expect.objectContaining({ sequence: saturated.items[0]!.sequence, phase: "final", text: "authoritative final" }),
    ]);
  });

  test("long multibyte assistant and tool transcript previews stay live and activity-safe through the total adapter", () => {
    const store = new AgentObservationStore(); register(store);
    const attempt = runAttemptId("long-safe");
    const context = createContextObservationService({ getSessionStats: async () => ({}) }, (run, value) => store.updateContext(A, run, value));
    const sink = createTotalRpcObservationAdapter(store, context, { agentId: A, attemptId: attempt }, () => {});
    store.acceptRun({ agentId: A, runId: R1, attemptId: attempt, assignment: "Review races" });
    sink.bind(R1);
    sink.record({ kind: "assistant-start" });
    sink.record({ kind: "assistant-content", contentIndex: rpcContentIndex(0), contentKind: "text", phase: "delta", delta: transcriptText("🙂".repeat(2_048)) });
    sink.record({ kind: "tool", toolCallId: rpcToolCallId("long-tool"), tool: toolDisplayName("read"), phase: "running", preview: transcriptText("界".repeat(2_000)) });

    const transcript = store.transcriptSource(A)!.snapshot();
    expect(transcript.availability).toBe("live");
    expect(transcript.items).toEqual([
      expect.objectContaining({ kind: "assistant", text: "🙂".repeat(2_048) }),
      expect.objectContaining({ kind: "tool", preview: "界".repeat(2_000) }),
    ]);
    const activity = store.observation(A)!.activity;
    expect(activity).toMatchObject({ kind: "tool", preview: "界".repeat(160) });
    expect(Buffer.byteLength(activity.kind === "tool" ? activity.preview ?? "" : "", "utf8")).toBeLessThanOrEqual(512);
  });

  test("assistant end without usable final blocks retains and finalises accumulated delta text", () => {
    const { store, sink } = boundTranscriptStore();
    sink.record({ kind: "assistant-start" });
    sink.record({ kind: "assistant-content", contentIndex: rpcContentIndex(0), contentKind: "thinking", phase: "delta", delta: transcriptText("Hel") });
    sink.record({ kind: "assistant-content", contentIndex: rpcContentIndex(0), contentKind: "thinking", phase: "delta", delta: transcriptText("lo") });
    sink.record({ kind: "assistant-end", finalBlocks: [], usage: zeroUsage(), stopReason: rpcStopReason("stop") });
    expect(store.transcriptSource(A)!.snapshot().items).toEqual([
      expect.objectContaining({ kind: "thinking", phase: "final", text: "Hello" }),
    ]);
  });

  test("assistant generations do not merge reused content indices", () => {
    const { store, sink } = boundTranscriptStore();
    sink.record({ kind: "assistant-start" });
    sink.record({ kind: "assistant-content", contentIndex: rpcContentIndex(0), contentKind: "thinking", phase: "delta", delta: transcriptText("first") });
    sink.record({ kind: "assistant-end", finalBlocks: [], usage: zeroUsage(), stopReason: rpcStopReason("stop") });
    sink.record({ kind: "assistant-start" });
    sink.record({ kind: "assistant-content", contentIndex: rpcContentIndex(0), contentKind: "thinking", phase: "delta", delta: transcriptText("second") });
    const thinking = store.transcriptSource(A)!.snapshot().items.flatMap((item) => item.kind === "thinking" ? [{ text: item.text, sequence: item.sequence }] : []);
    expect(thinking.map((item) => String(item.text))).toEqual(["first", "second"]);
    expect(thinking[0]!.sequence).not.toBe(thinking[1]!.sequence);
  });

  test("block end and message end finalise one correlated assistant item", () => {
    const { store, sink } = boundTranscriptStore();
    sink.record({ kind: "assistant-start" });
    sink.record({ kind: "assistant-content", contentIndex: rpcContentIndex(0), contentKind: "text", phase: "delta", delta: transcriptText("draft") });
    const source = store.transcriptSource(A)!;
    const sequence = source.snapshot().items[0]!.sequence;
    sink.record({ kind: "assistant-content", contentIndex: rpcContentIndex(0), contentKind: "text", phase: "end", text: transcriptText("block snapshot") });
    const blockEnd = source.snapshot();
    expect(blockEnd.items).toEqual([
      expect.objectContaining({ sequence, kind: "assistant", phase: "final", text: "block snapshot" }),
    ]);
    expect(store.testAdapter().correlationCount(A)).toBe(1);

    sink.record({ kind: "assistant-content", contentIndex: rpcContentIndex(0), contentKind: "text", phase: "delta", delta: transcriptText("late") });
    sink.record({ kind: "assistant-content", contentIndex: rpcContentIndex(0), contentKind: "text", phase: "end", text: transcriptText("block snapshot") });
    expect(source.snapshot()).toBe(blockEnd);

    sink.record({ kind: "assistant-end", finalBlocks: [
      { contentIndex: rpcContentIndex(0), kind: "text", text: transcriptText("message final") },
    ], usage: zeroUsage(), stopReason: rpcStopReason("stop") });
    expect(source.snapshot().items).toEqual([
      expect.objectContaining({ sequence, kind: "assistant", phase: "final", text: "message final" }),
    ]);
    expect(store.testAdapter().correlationCount(A)).toBe(0);
  });

  test("message final blocks preserve stable multi-block ordering after block ends", () => {
    const { store, sink } = boundTranscriptStore();
    sink.record({ kind: "assistant-start" });
    sink.record({ kind: "assistant-content", contentIndex: rpcContentIndex(0), contentKind: "thinking", phase: "delta", delta: transcriptText("thought draft") });
    sink.record({ kind: "assistant-content", contentIndex: rpcContentIndex(0), contentKind: "thinking", phase: "end", text: transcriptText("thought block") });
    sink.record({ kind: "assistant-content", contentIndex: rpcContentIndex(1), contentKind: "text", phase: "delta", delta: transcriptText("answer draft") });
    sink.record({ kind: "assistant-content", contentIndex: rpcContentIndex(1), contentKind: "text", phase: "end", text: transcriptText("answer block") });
    const sequences = store.transcriptSource(A)!.snapshot().items.map((item) => item.sequence);

    sink.record({ kind: "assistant-end", finalBlocks: [
      { contentIndex: rpcContentIndex(0), kind: "thinking", text: transcriptText("thought final") },
      { contentIndex: rpcContentIndex(1), kind: "text", text: transcriptText("answer final") },
    ], usage: zeroUsage(), stopReason: rpcStopReason("stop") });

    expect(store.transcriptSource(A)!.snapshot().items).toEqual([
      expect.objectContaining({ sequence: sequences[0], kind: "thinking", text: "thought final" }),
      expect.objectContaining({ sequence: sequences[1], kind: "assistant", text: "answer final" }),
    ]);
    expect(store.testAdapter().correlationCount(A)).toBe(0);
  });

  test("assistant end finalises streamed blocks and inserts final-only blocks in content order", () => {
    const { store, sink } = boundTranscriptStore();
    sink.record({ kind: "assistant-start" });
    sink.record({ kind: "assistant-content", contentIndex: rpcContentIndex(1), contentKind: "thinking", phase: "delta", delta: transcriptText("streamed") });
    sink.record({ kind: "assistant-end", finalBlocks: [
      { contentIndex: rpcContentIndex(1), kind: "thinking", text: transcriptText("final thought") },
      { contentIndex: rpcContentIndex(2), kind: "text", text: transcriptText("final answer") },
    ], usage: zeroUsage(), stopReason: rpcStopReason("stop") });
    expect(store.transcriptSource(A)!.snapshot().items).toEqual([
      expect.objectContaining({ kind: "thinking", phase: "final", text: "final thought" }),
      expect.objectContaining({ kind: "assistant", phase: "final", text: "final answer" }),
    ]);
    expect(store.testAdapter().correlationCount(A)).toBe(0);
  });

  test("message end finalises an open streamed block absent from final blocks", () => {
    const { store, sink } = boundTranscriptStore();
    sink.record({ kind: "assistant-start" });
    sink.record({ kind: "assistant-content", contentIndex: rpcContentIndex(0), contentKind: "text", phase: "delta", delta: transcriptText("streamed") });
    sink.record({ kind: "assistant-end", finalBlocks: [], usage: zeroUsage(), stopReason: rpcStopReason("stop") });
    expect(store.transcriptSource(A)!.snapshot().items).toEqual([
      expect.objectContaining({ kind: "assistant", phase: "final", text: "streamed" }),
    ]);
  });

  test("tool update and end replace one item then release correlation", () => {
    const { store, sink } = boundTranscriptStore();
    const id = rpcToolCallId("call-1");
    sink.record({ kind: "tool", toolCallId: id, tool: toolDisplayName("read"), phase: "running", preview: transcriptText("a") });
    const sequence = store.transcriptSource(A)!.snapshot().items[0]!.sequence;
    sink.record({ kind: "tool", toolCallId: id, tool: toolDisplayName("read"), phase: "running", preview: transcriptText("b") });
    sink.record({ kind: "tool", toolCallId: id, tool: toolDisplayName("read"), phase: "completed", preview: transcriptText("done") });
    expect(store.transcriptSource(A)!.snapshot().items).toEqual([
      expect.objectContaining({ sequence, kind: "tool", phase: "completed", preview: "done" }),
    ]);
    expect(store.testAdapter().correlationCount(A)).toBe(0);
  });

  test("discard publishes nothing and returned snapshots cannot mutate retained state", () => {
    const store = new AgentObservationStore(); register(store);
    const discarded = store.createAttemptSink(A, runAttemptId("discarded"));
    discarded.record({ kind: "prompt-accepted", text: transcriptText("secret") });
    discarded.discard();
    expect(store.transcriptSource(A)!.snapshot().items).toEqual([]);
    const attempt = runAttemptId("visible");
    store.acceptRun({ agentId: A, runId: R1, attemptId: attempt, assignment: "Review races" });
    const sink = store.createAttemptSink(A, attempt); sink.bind(R1);
    sink.record({ kind: "prompt-accepted", text: transcriptText("visible") });
    const snapshot = store.transcriptSource(A)!.snapshot();
    expect(() => (snapshot.items as TranscriptItem[]).push(snapshot.items[0]!)).toThrow();
    expect(store.transcriptSource(A)!.snapshot().items).toHaveLength(1);
  });

  test("per-source pressure evicts only that source's oldest closed item", () => {
    const store = new AgentObservationStore({ transcriptBudgets: { perSourceItems: 2, perSourceBytes: 256 * 1024, globalItems: 10, globalBytes: 1024 * 1024 } });
    register(store); register(store, agentId("agent-b"), 2);
    appendClosed(store, A, R1, "a1", "a1");
    appendClosed(store, agentId("agent-b"), runId("cafebabe"), "b1", "b1");
    const beforeB = store.transcriptSource(agentId("agent-b"))!.snapshot();
    appendClosed(store, A, R1, "a2", "a2");
    appendClosed(store, A, R1, "a3", "a3");
    expect(store.transcriptSource(A)!.snapshot()).toMatchObject({ truncatedBefore: true, items: [
      expect.objectContaining({ text: "a2" }), expect.objectContaining({ text: "a3" }),
    ] });
    expect(store.transcriptSource(agentId("agent-b"))!.snapshot()).toBe(beforeB);
  });

  test("global pressure independently evicts the store-wide oldest closed item", () => {
    const store = new AgentObservationStore({ transcriptBudgets: { perSourceItems: 10, perSourceBytes: 256 * 1024, globalItems: 3, globalBytes: 1024 * 1024 } });
    register(store); const other = agentId("agent-b"); register(store, other, 2);
    appendClosed(store, A, R1, "global-a1", "one");
    appendClosed(store, other, runId("cafebabe"), "global-b1", "two");
    appendClosed(store, A, R1, "global-a2", "three");
    appendClosed(store, A, R1, "global-a3", "four");
    expect(store.transcriptSource(A)!.snapshot()).toMatchObject({ truncatedBefore: true, items: [
      expect.objectContaining({ text: "three" }), expect.objectContaining({ text: "four" }),
    ] });
    expect(store.transcriptSource(other)!.snapshot().items).toEqual([expect.objectContaining({ text: "two" })]);
    expect(store.testAdapter().transcriptItemCount()).toBe(3);
  });

  test("open-only pressure fails owner closed, pins the run, then recovers next run", () => {
    const store = new AgentObservationStore({ transcriptBudgets: { perSourceItems: 1, perSourceBytes: 256 * 1024, globalItems: 1, globalBytes: 1024 * 1024 } });
    register(store);
    const { sink } = bindTranscript(store, A, R1, runAttemptId("open"));
    sink.record({ kind: "assistant-start" });
    sink.record({ kind: "assistant-content", contentIndex: rpcContentIndex(0), contentKind: "text", phase: "delta", delta: transcriptText("open-one") });
    const firstSequence = Number(store.transcriptSource(A)!.snapshot().items[0]!.sequence);
    sink.record({ kind: "assistant-content", contentIndex: rpcContentIndex(1), contentKind: "text", phase: "delta", delta: transcriptText("open-two") });
    expect(store.transcriptSource(A)!.snapshot()).toMatchObject({ availability: "unavailable", items: [
      expect.objectContaining({ kind: "notice", code: "projection-unavailable", sequence: firstSequence + 1 }),
    ] });
    expect(store.testAdapter().correlationCount(A)).toBe(0);
    sink.record({ kind: "prompt-accepted", text: transcriptText("ignored") });
    store.updateLifecycle({ agentId: A, runId: R1, state: AgentState.Stopped, transcriptPath: testSessionPath("/tmp/pi-subagents-test/agent-a.jsonl") });
    expect(store.transcriptSource(A)!.snapshot().availability).toBe("unavailable");
    const R2 = runId("cafebabe");
    bindTranscript(store, A, R2, runAttemptId("recovery"));
    expect(store.transcriptSource(A)!.snapshot().availability).toBe("live");
  });

  test("repeated acceptance of a healthy current run preserves its complete projection identity", () => {
    const { store, sink } = boundTranscriptStore();
    sink.record({ kind: "prompt-accepted", text: transcriptText("retained") });
    sink.record({ kind: "assistant-start" });
    sink.record({ kind: "assistant-content", contentIndex: rpcContentIndex(0), contentKind: "text", phase: "delta", delta: transcriptText("open") });
    const source = store.transcriptSource(A)!;
    const transcript = source.snapshot();
    const observation = store.observation(A);
    const direct = store.directSnapshot();
    const correlations = store.testAdapter().correlationCount(A);

    store.acceptRun({ agentId: A, runId: R1, attemptId: runAttemptId("bound"), assignment: "Review races" });

    expect(store.transcriptSource(A)).toBe(source);
    expect(source.snapshot()).toBe(transcript);
    expect(source.snapshot()).toMatchObject({ availability: "live", items: transcript.items, revision: transcript.revision });
    expect(store.testAdapter().correlationCount(A)).toBe(correlations);
    expect(store.observation(A)).toBe(observation);
    expect(store.directSnapshot()).toBe(direct);
  });

  test("repeated acceptance of a disabled current run preserves its unavailable projection identity", () => {
    const store = new AgentObservationStore({ transcriptBudgets: { perSourceItems: 1, perSourceBytes: 256 * 1024, globalItems: 1, globalBytes: 1024 * 1024 } });
    register(store);
    const attempt = runAttemptId("same-disabled-run");
    const sink = bindTranscript(store, A, R1, attempt).sink;
    sink.record({ kind: "assistant-start" });
    sink.record({ kind: "assistant-content", contentIndex: rpcContentIndex(0), contentKind: "text", phase: "delta", delta: transcriptText("one") });
    sink.record({ kind: "assistant-content", contentIndex: rpcContentIndex(1), contentKind: "text", phase: "delta", delta: transcriptText("two") });
    const source = store.transcriptSource(A)!;
    const failed = source.snapshot();
    const observation = store.observation(A);
    const direct = store.directSnapshot();

    store.acceptRun({ agentId: A, runId: R1, attemptId: attempt, assignment: "Review races" });
    sink.bind(R1);
    sink.record({ kind: "prompt-accepted", text: transcriptText("ignored after duplicate acceptance") });
    expect(store.transcriptSource(A)).toBe(source);
    expect(source.snapshot()).toBe(failed);
    expect(source.snapshot().availability).toBe("unavailable");
    expect(store.testAdapter().correlationCount(A)).toBe(0);
    expect(store.observation(A)).toBe(observation);
    expect(store.directSnapshot()).toBe(direct);

    const R2 = runId("cafebabe");
    bindTranscript(store, A, R2, runAttemptId("different-run"));
    expect(source.snapshot().availability).toBe("live");
  });

  test("a stale projection fault cannot mutate the exact current run", () => {
    const store = new AgentObservationStore(); register(store);
    const first = bindTranscript(store, A, R1, runAttemptId("stale-first")).sink;
    first.record({ kind: "prompt-accepted", text: transcriptText("first") });
    const R2 = runId("cafebabe");
    const second = bindTranscript(store, A, R2, runAttemptId("stale-second")).sink;
    second.record({ kind: "prompt-accepted", text: transcriptText("second") });
    second.record({ kind: "assistant-start" });
    second.record({ kind: "assistant-content", contentIndex: rpcContentIndex(0), contentKind: "text", phase: "delta", delta: transcriptText("current open") });
    const source = store.transcriptSource(A)!;
    const transcript = source.snapshot();
    const observation = store.observation(A);
    const direct = store.directSnapshot();
    const correlations = store.testAdapter().correlationCount(A);

    store.failTranscriptProjection(A, R1);

    expect(source.snapshot()).toBe(transcript);
    expect(source.snapshot()).toMatchObject({ availability: "live", items: transcript.items, revision: transcript.revision });
    expect(store.testAdapter().correlationCount(A)).toBe(correlations);
    expect(store.observation(A)).toBe(observation);
    expect(store.directSnapshot()).toBe(direct);
  });

  test("global open-only pressure and emergency failure finish within hard caps", () => {
    const store = new AgentObservationStore({ transcriptBudgets: { perSourceItems: 10, perSourceBytes: 256 * 1024, globalItems: 2, globalBytes: 1024 * 1024 } });
    const ids = [A, agentId("agent-b"), agentId("agent-c")];
    const runs = [R1, runId("cafebabe"), runId("feedface")];
    ids.forEach((id, index) => register(store, id, index + 1));
    ids.forEach((id, index) => {
      const sink = bindTranscript(store, id, runs[index]!, runAttemptId(`open-global-${index}`)).sink;
      sink.record({ kind: "assistant-start" });
      sink.record({ kind: "assistant-content", contentIndex: rpcContentIndex(0), contentKind: "text", phase: "delta", delta: transcriptText(String(id)) });
    });
    expect(store.testAdapter().transcriptItemCount()).toBeLessThanOrEqual(2);
    expect(store.transcriptSource(A)!.snapshot().availability).toBe("unavailable");
    expect(store.testAdapter().correlationCount(A)).toBe(0);

    store.failTranscriptProjection(agentId("agent-b"), runId("cafebabe"));
    expect(store.testAdapter().transcriptItemCount()).toBeLessThanOrEqual(2);
  });

  test("per-source byte pressure evicts closed UTF-8 items to the exact independent cap", () => {
    const store = new AgentObservationStore({ transcriptBudgets: { perSourceItems: 100, perSourceBytes: 8, globalItems: 100, globalBytes: 1_024 } });
    register(store); const other = agentId("byte-source-b"); register(store, other, 2);
    appendClosed(store, other, runId("cafebabe"), "byte-source-b", "🙂");
    appendClosed(store, A, R1, "byte-source-a1", "éé");
    appendClosed(store, A, R1, "byte-source-a2", "éé");
    appendClosed(store, A, R1, "byte-source-a3", "éé");

    const retained = store.transcriptSource(A)!.snapshot();
    expect(retained).toMatchObject({ truncatedBefore: true, items: [
      expect.objectContaining({ text: "éé" }), expect.objectContaining({ text: "éé" }),
    ] });
    expect(transcriptBytes(retained.items)).toBe(8);
    expect(transcriptBytes(store.transcriptSource(other)!.snapshot().items)).toBe(4);
    expect(store.testAdapter().correlationCount(A)).toBe(0);
  });

  test("global byte pressure deterministically evicts the oldest closed UTF-8 item to the exact cap", () => {
    const store = new AgentObservationStore({ transcriptBudgets: { perSourceItems: 100, perSourceBytes: 1_024, globalItems: 100, globalBytes: 8 } });
    register(store); const other = agentId("byte-global-b"); register(store, other, 2);
    appendClosed(store, A, R1, "byte-global-a1", "éé");
    appendClosed(store, other, runId("cafebabe"), "byte-global-b1", "🙂");
    appendClosed(store, A, R1, "byte-global-a2", "界a");

    const sourceA = store.transcriptSource(A)!.snapshot();
    const sourceB = store.transcriptSource(other)!.snapshot();
    expect(sourceA).toMatchObject({ truncatedBefore: true, items: [expect.objectContaining({ text: "界a" })] });
    expect(sourceB.items).toEqual([expect.objectContaining({ text: "🙂" })]);
    expect(transcriptBytes([...sourceA.items, ...sourceB.items])).toBe(8);
    expect(store.testAdapter().correlationCount(A) + store.testAdapter().correlationCount(other)).toBe(0);
  });

  test("per-source open byte pressure fails closed without stale correlations", () => {
    const store = new AgentObservationStore({ transcriptBudgets: { perSourceItems: 100, perSourceBytes: 7, globalItems: 100, globalBytes: 1_024 } });
    register(store);
    const sink = bindTranscript(store, A, R1, runAttemptId("byte-open")).sink;
    sink.record({ kind: "assistant-start" });
    sink.record({ kind: "assistant-content", contentIndex: rpcContentIndex(0), contentKind: "text", phase: "delta", delta: transcriptText("🙂🙂") });

    const snapshot = store.transcriptSource(A)!.snapshot();
    expect(snapshot).toMatchObject({ availability: "unavailable", items: [expect.objectContaining({ code: "projection-unavailable" })] });
    expect(transcriptBytes(snapshot.items)).toBe(0);
    expect(store.testAdapter().correlationCount(A)).toBe(0);
  });

  test("text fields retain a complete UTF-8 prefix of at most 8 KiB", () => {
    const { store, sink } = boundTranscriptStore();
    sink.record({ kind: "prompt-accepted", text: "🙂".repeat(3_000) as ReturnType<typeof transcriptText> });
    const item = store.transcriptSource(A)!.snapshot().items[0]!;
    if (item.kind !== "user") throw new Error("expected user item");
    expect(new TextEncoder().encode(item.text).byteLength).toBe(8_192);
    expect(item.text.endsWith("🙂")).toBeTrue();
  });

  test("truncated metadata is permanent and consumes no sequence", () => {
    const store = new AgentObservationStore({ transcriptBudgets: { perSourceItems: 1, perSourceBytes: 256 * 1024, globalItems: 10, globalBytes: 1024 * 1024 } });
    register(store);
    appendClosed(store, A, R1, "truncate-one", "one");
    appendClosed(store, A, R1, "truncate-two", "two");
    const after = store.transcriptSource(A)!.snapshot();
    const sequence = after.items[0]!.sequence;
    expect(after.truncatedBefore).toBeTrue();
    store.updateLifecycle({ agentId: A, runId: R1, state: AgentState.Stopped, transcriptPath: testSessionPath("/tmp/pi-subagents-test/agent-a.jsonl") });
    expect(store.transcriptSource(A)!.snapshot()).toMatchObject({ truncatedBefore: true, items: [expect.objectContaining({ sequence })] });
  });

  test("transcript revisions and notifications do not advance observation revision", async () => {
    const { store, sink } = boundTranscriptStore();
    await flush();
    const observationRevision = store.observation(A)!.revision;
    const revisions: number[] = [];
    store.transcriptSource(A)!.subscribe((snapshot) => { revisions.push(Number(snapshot.revision)); });
    sink.record({ kind: "prompt-accepted", text: transcriptText("one") });
    sink.record({ kind: "prompt-accepted", text: transcriptText("two") });
    await flush();
    expect(revisions).toHaveLength(1);
    expect(store.observation(A)!.revision).toBe(observationRevision);
  });

  test("reused assistant indices and tool IDs remain correlated to exact native runs", () => {
    const store = new AgentObservationStore(); register(store);
    const first = bindTranscript(store, A, R1, runAttemptId("run-one")).sink;
    appendGenerationAndTool(first, "first");
    store.updateLifecycle({ agentId: A, runId: R1, state: AgentState.Stopped, transcriptPath: testSessionPath("/tmp/pi-subagents-test/agent-a.jsonl") });
    const R2 = runId("cafebabe");
    const second = bindTranscript(store, A, R2, runAttemptId("run-two")).sink;
    appendGenerationAndTool(second, "second");
    const items = store.transcriptSource(A)!.snapshot().items;
    expect(items.filter((item) => "runId" in item && item.runId === R1).map((item) => item.kind)).toEqual(["assistant", "tool"]);
    expect(items.filter((item) => "runId" in item && item.runId === R2).map((item) => item.kind)).toEqual(["assistant", "tool"]);
  });

  test("transport notice occurs once per healthy-to-unavailable epoch", () => {
    const store = new AgentObservationStore(); register(store);
    const first = bindTranscript(store, A, R1, runAttemptId("first")).sink;
    first.record({ kind: "transport-unavailable" }); first.record({ kind: "transport-unavailable" });
    expect(store.transcriptSource(A)!.snapshot().items.filter((item) => item.kind === "notice")).toHaveLength(1);
    const R2 = runId("cafebabe");
    const second = bindTranscript(store, A, R2, runAttemptId("second")).sink;
    second.record({ kind: "transport-unavailable" });
    expect(store.transcriptSource(A)!.snapshot().items.filter((item) => item.kind === "notice" && item.code === "transport-unavailable")).toHaveLength(2);
  });

  test("disposed retained transcript source has one immutable terminal snapshot and inert subscriptions", async () => {
    const store = new AgentObservationStore(); register(store);
    const source = store.transcriptSource(A)!;
    let calls = 0; source.subscribe(() => { calls++; });
    store.dispose(); await flush();
    const final = source.snapshot();
    expect(final.availability).toBe("unavailable");
    expect(Object.isFrozen(final)).toBeTrue();
    expect(Object.isFrozen(final.items)).toBeTrue();
    source.subscribe(() => { calls++; });
    expect(source.snapshot()).toBe(final);
    expect(calls).toBe(0);
  });

  test.each(["unbound", "bound"] as const)("projection throw fails %s transcript closed without escaping", (phase) => {
    class ThrowingStore extends AgentObservationStore {
      override createRoutedAttemptSink(...args: Parameters<AgentObservationStore["createRoutedAttemptSink"]>) {
        const sink = super.createRoutedAttemptSink(...args);
        return {
          record: (event: Parameters<typeof sink.record>[0]) => { sink.record(event); if (phase === "unbound" || phase === "bound") throw new Error("projector fault"); },
          bind: (run: Parameters<typeof sink.bind>[0]) => sink.bind(run),
          discard: () => sink.discard(),
        };
      }
    }
    const store = new ThrowingStore(); register(store);
    const attempt = runAttemptId(`throw-${phase}`);
    const context = { reset: () => {}, observe: () => {}, dispose: () => {} };
    const sink = createTotalRpcObservationAdapter(store, context, { agentId: A, attemptId: attempt }, () => {});
    if (phase === "bound") {
      store.acceptRun({ agentId: A, runId: R1, attemptId: attempt, assignment: "Review races" });
      sink.bind(R1);
    }
    expect(() => sink.record({ kind: "prompt-accepted", text: transcriptText("damaged") })).not.toThrow();
    if (phase === "unbound") {
      store.acceptRun({ agentId: A, runId: R1, attemptId: attempt, assignment: "Review races" });
      sink.bind(R1);
    }
    expect(store.transcriptSource(A)!.snapshot()).toMatchObject({ availability: "unavailable", items: [expect.objectContaining({ code: "projection-unavailable" })] });
  });

  test("activity-context callback failure reconciliation preserves a healthy bound transcript", async () => {
    const authority: ObservationReconciliationSnapshot = {
      spawnSequence: [A],
      agents: [{ agentId: A, sessionPath: testSessionPath("/tmp/pi-subagents-test/agent-a.jsonl"), cwd: testAbsolutePath("/tmp/pi-subagents-test"), model: modelSpec("mock-provider/luna"), thinkingLevel: "high" }],
      runs: [{ agentId: A, state: AgentState.Running, runId: R1 }],
      completions: [], pendingDelivery: new Set(),
      acceptedAssignments: new Map([[agentRunKey(A, R1), "Review races"]]),
      sensitiveValues: { agentIds: new Set([A]), runIds: new Set([R1]), internalPaths: new Set() },
    };
    const store = new AgentObservationStore({ reconciliation: () => authority }); register(store);
    const attempt = runAttemptId("production-callback-fault");
    const context = { reset: () => {}, observe: () => { throw new Error("context callback fault"); }, dispose: () => {} };
    const sink = createTotalRpcObservationAdapter(store, context, { agentId: A, attemptId: attempt }, () => {});
    store.acceptRun({ agentId: A, runId: R1, attemptId: attempt, assignment: "Review races" });
    store.updateLifecycle({ agentId: A, runId: R1, state: AgentState.Running, transcriptPath: testSessionPath("/tmp/pi-subagents-test/agent-a.jsonl") });
    sink.bind(R1);
    sink.record({ kind: "prompt-accepted", text: transcriptText("Review races") });
    sink.record({ kind: "assistant-start" });
    sink.record({ kind: "assistant-content", contentIndex: rpcContentIndex(0), contentKind: "text", phase: "delta", delta: transcriptText("healthy") });
    const source = store.transcriptSource(A)!;
    const before = source.snapshot();

    sink.record({ kind: "turn-end" });
    await flush();

    expect(source.snapshot()).toBe(before);
    expect(source.snapshot()).toMatchObject({ availability: "live", revision: before.revision, items: before.items });
    expect(store.observation(A)).toMatchObject({
      lifecycleState: AgentState.Running,
      activity: { kind: "unavailable", reason: "projection" },
      context: { kind: "unavailable" },
    });
    expect(store.directSnapshot()).toMatchObject({ health: { kind: "healthy" } });
  });

  test("a store disposed before its first snapshot reports unavailable, never undefined", () => {
    const store = new AgentObservationStore();
    store.dispose();
    const result = store.directSnapshot();
    expect(result).toBeDefined();
    expect(result.kind).toBe("unavailable");
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

function zeroUsage() {
  return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } as const;
}

function bindTranscript(store: AgentObservationStore, id: typeof A, run: typeof R1, attempt: ReturnType<typeof runAttemptId>) {
  store.acceptRun({ agentId: id, runId: run, attemptId: attempt, assignment: "Review races" });
  const sink = store.createAttemptSink(id, attempt); sink.bind(run);
  return { store, sink };
}

function boundTranscriptStore() {
  const store = new AgentObservationStore(); register(store);
  return bindTranscript(store, A, R1, runAttemptId("bound"));
}

const closedSinks = new WeakMap<AgentObservationStore, Map<string, ReturnType<AgentObservationStore["createAttemptSink"]>>>();
function appendClosed(store: AgentObservationStore, id: typeof A, run: typeof R1, attemptName: string, text: string): void {
  let sinks = closedSinks.get(store);
  if (sinks === undefined) { sinks = new Map(); closedSinks.set(store, sinks); }
  const key = `${id}\u0000${run}`;
  let sink = sinks.get(key);
  if (sink === undefined) {
    sink = bindTranscript(store, id, run, runAttemptId(attemptName)).sink;
    sinks.set(key, sink);
  }
  sink.record({ kind: "prompt-accepted", text: transcriptText(text) });
}

function transcriptBytes(items: readonly TranscriptItem[]): number {
  return items.reduce((total, item) => {
    if (item.kind === "user" || item.kind === "assistant" || item.kind === "thinking") return total + Buffer.byteLength(item.text);
    return total + (item.kind === "tool" && item.preview !== undefined ? Buffer.byteLength(item.preview) : 0);
  }, 0);
}

function appendGenerationAndTool(sink: ReturnType<AgentObservationStore["createAttemptSink"]>, text: string): void {
  sink.record({ kind: "assistant-start" });
  sink.record({ kind: "assistant-content", contentIndex: rpcContentIndex(0), contentKind: "text", phase: "delta", delta: transcriptText(text) });
  sink.record({ kind: "assistant-end", finalBlocks: [], usage: zeroUsage(), stopReason: rpcStopReason("stop") });
  sink.record({ kind: "tool", toolCallId: rpcToolCallId("call-1"), tool: toolDisplayName("read"), phase: "completed" });
}
