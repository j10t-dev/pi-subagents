import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, describe, expect, test } from "bun:test";

import { AgentObservationStore } from "../src/agent-observation-store.ts";
import type { AgentDisplayState, ObservationChange, SubagentObservationPort } from "../src/agent-observation.ts";
import { createAgentWidgetSource } from "../src/agent-widget/source.ts";
import { INDEX_REFRESH_WINDOW_MS, MAX_WIDGET_ROWS } from "../src/constants.ts";
import {
  AgentState,
  CompletionState,
  agentCount,
  agentDepth,
  agentId,
  agentObservationRevision,
  agentOrdinal,
  directAgentOrdinal,
  incarnationId,
  modelSpec,
  observationRevision,
  runId,
} from "../src/domain.ts";
import {
  encodeObservationSnapshot,
  observationSlotDirectory,
  observationSnapshotPath,
  type ObservationRow,
} from "../src/observation-snapshot-path.ts";
import { testAbsolutePath, testSessionPath } from "./support/brands.ts";

const AGENT_DIR = testAbsolutePath(mkdtempSync(join(tmpdir(), "agent-widget-source-")));
const waitForIndexRefresh = () => Bun.sleep(Number(INDEX_REFRESH_WINDOW_MS) + 40);

afterEach(() => {
  rmSync(AGENT_DIR, { recursive: true, force: true });
  mkdirSync(AGENT_DIR, { recursive: true });
});
afterAll(() => { rmSync(AGENT_DIR, { recursive: true, force: true }); });

function writePublished(owner: string, agents: readonly {
  readonly ordinal: string;
  readonly sessionId: string;
  readonly state?: AgentDisplayState;
}[]): void {
  const sessionId = agentId(owner);
  const rows: ObservationRow[] = agents.map((agent) => ({
    ordinal: agentOrdinal(agent.ordinal),
    sessionId: agentId(agent.sessionId),
    model: "luna:h" as ObservationRow["model"],
    context: "42%" as ObservationRow["context"],
    taskLabel: agent.ordinal as ObservationRow["taskLabel"],
    state: agent.state ?? CompletionState.Completed,
  }));
  const encoded = encodeObservationSnapshot({
    sessionId,
    incarnation: incarnationId("source-test"),
    revision: observationRevision(1),
    total: agentCount(rows.length),
    omitted: agentCount(0),
    degraded: false,
    agents: rows,
  });
  if (!encoded.ok) throw new Error("snapshot fixture exceeded codec bound");
  mkdirSync(observationSlotDirectory(AGENT_DIR, sessionId), { recursive: true });
  writeFileSync(observationSnapshotPath(AGENT_DIR, sessionId), encoded.text);
}

function register(store: AgentObservationStore, name: string, position: number, assignment: string): void {
  const id = agentId(name);
  const sessionPath = testSessionPath(`/tmp/pi-subagents-test/${name}.jsonl`);
  store.registerSpawned({
    agentId: id,
    ordinal: directAgentOrdinal(position),
    assignment,
    sessionPath,
    cwd: AGENT_DIR,
    model: modelSpec("mock-provider/luna"),
    thinkingLevel: "high",
  });
  store.updateLifecycle({ agentId: id, runId: runId("deadbeef"), state: AgentState.Running, transcriptPath: sessionPath });
}

function sourceOver(store: AgentObservationStore, maxRows = MAX_WIDGET_ROWS) {
  return createAgentWidgetSource(store as SubagentObservationPort, { agentDir: AGENT_DIR, maxRows });
}

describe("createAgentWidgetSource", () => {
  test("passes B1 ordinals, depth, labels and counts through unchanged", () => {
    const store = new AgentObservationStore();
    register(store, "agent-a", 1, "Research terminal UX");
    register(store, "agent-b", 2, "Review findings");
    const source = sourceOver(store);

    const snapshot = source.snapshot();
    expect(snapshot.rows.map((row) => row.ordinal)).toEqual([agentOrdinal("A1"), agentOrdinal("A2")]);
    expect(snapshot.rows.map((row) => Number(row.depth))).toEqual([0, 0]);
    expect(String(snapshot.rows[0]!.taskLabel)).toBe("Research terminal UX");
    expect(Number(snapshot.total)).toBe(2);
    expect(Number(snapshot.omitted)).toBe(0);
    source.dispose();
  });

  test("reports degraded while no relay exists", () => {
    const store = new AgentObservationStore();
    register(store, "agent-a", 1, "Research terminal UX");
    const source = sourceOver(store);
    expect(source.snapshot().degraded).toBe(true);
    source.dispose();
  });

  test("advances a private revision once per coalesced notification and notifies subscribers", async () => {
    const store = new AgentObservationStore();
    register(store, "agent-a", 1, "Research terminal UX");
    const source = sourceOver(store);
    const first = source.snapshot().revision;
    let notifications = 0;
    source.subscribe(() => { notifications += 1; });

    register(store, "agent-b", 2, "Review findings");
    register(store, "agent-c", 3, "Summarise");
    expect(source.snapshot().revision).toBe(first);
    await Promise.resolve();
    await Promise.resolve();
    expect(source.snapshot().revision).toBe(first);
    await waitForIndexRefresh();

    expect(Number(source.snapshot().revision)).toBeGreaterThan(Number(first));
    expect(source.snapshot().rows).toHaveLength(3);
    expect(notifications).toBe(1);
    source.dispose();
  });

  test("resolves only direct rendered ordinals to their owning transcript source", () => {
    const store = new AgentObservationStore();
    register(store, "agent-a", 1, "Research terminal UX");
    writePublished("agent-a", [{ ordinal: "A1", sessionId: "published-child" }]);
    const source = sourceOver(store);
    expect(source.transcriptSource(agentOrdinal("A1"))).toBe(store.transcriptSource(agentId("agent-a")));
    expect(source.transcriptSource(agentOrdinal("A1.1"))).toBeUndefined();
    expect(source.transcriptSource(agentOrdinal("A9"))).toBeUndefined();
    source.dispose();
  });

  test("populates the recursive projection synchronously without a later source event", () => {
    const store = new AgentObservationStore();
    register(store, "agent-a", 1, "Root task");
    writePublished("agent-a", [{ ordinal: "A2", sessionId: "agent-b", state: AgentState.Running }]);
    writePublished("agent-b", [{ ordinal: "A3", sessionId: "agent-c" }]);

    const source = sourceOver(store);

    expect(source.snapshot().rows.map((row) => row.ordinal)).toEqual([
      agentOrdinal("A1"), agentOrdinal("A1.2"), agentOrdinal("A1.2.3"),
    ]);
    expect(source.snapshot().rows.map((row) => Number(row.depth))).toEqual([0, 1, 2]);
    expect(Number(source.snapshot().total)).toBe(3);
    expect(source.snapshot().degraded).toBe(false);
    source.dispose();
  });

  test("degrades active roots with absent slots but not terminal roots", () => {
    const activeStore = new AgentObservationStore();
    register(activeStore, "active-root", 1, "Still running");
    const active = sourceOver(activeStore);
    expect(active.snapshot().degraded).toBe(true);
    active.dispose();

    const terminalStore = new AgentObservationStore();
    register(terminalStore, "terminal-root", 1, "Finished");
    const direct = terminalStore.directSnapshot();
    if (direct.kind !== "snapshot") throw new Error("expected snapshot fixture");
    const port: SubagentObservationPort = {
      observation: (id) => terminalStore.observation(id),
      directSnapshot: () => ({
        ...direct,
        entries: direct.entries.map((entry) => ({
          ...entry,
          observation: { ...entry.observation, lifecycleState: AgentState.Stopped, displayState: CompletionState.Completed },
          row: { ...entry.row, state: CompletionState.Completed },
        })),
      }),
      transcriptSource: (id) => terminalStore.transcriptSource(id),
      subscribe: (listener) => terminalStore.subscribe(listener),
    };
    const terminal = createAgentWidgetSource(port, { agentDir: AGENT_DIR, maxRows: MAX_WIDGET_ROWS });
    expect(terminal.snapshot().degraded).toBe(false);
    terminal.dispose();
  });

  test("reconstructs completed descendants after source recreation", () => {
    const store = new AgentObservationStore();
    register(store, "completed-root", 1, "Finished root");
    writePublished("completed-root", [{ ordinal: "A2", sessionId: "completed-child" }]);
    writePublished("completed-child", [{ ordinal: "A3", sessionId: "completed-grandchild" }]);
    const direct = store.directSnapshot();
    if (direct.kind !== "snapshot") throw new Error("expected snapshot fixture");
    const port: SubagentObservationPort = {
      observation: (id) => store.observation(id),
      directSnapshot: () => ({
        ...direct,
        entries: direct.entries.map((entry) => ({
          ...entry,
          observation: { ...entry.observation, lifecycleState: AgentState.Stopped, displayState: CompletionState.Completed },
          row: { ...entry.row, state: CompletionState.Completed },
        })),
      }),
      transcriptSource: (id) => store.transcriptSource(id),
      subscribe: (listener) => store.subscribe(listener),
    };

    const source = createAgentWidgetSource(port, { agentDir: AGENT_DIR, maxRows: MAX_WIDGET_ROWS });
    expect(source.snapshot().rows.map((row) => row.ordinal)).toEqual([
      agentOrdinal("A1"), agentOrdinal("A1.2"), agentOrdinal("A1.2.3"),
    ]);
    expect(source.transcriptSource(agentOrdinal("A1"))).toBeDefined();
    expect(source.transcriptSource(agentOrdinal("A1.2"))).toBeUndefined();
    source.dispose();

    const recreated = createAgentWidgetSource(port, { agentDir: AGENT_DIR, maxRows: MAX_WIDGET_ROWS });
    expect(recreated.snapshot().rows.map((row) => row.ordinal)).toEqual([
      agentOrdinal("A1"), agentOrdinal("A1.2"), agentOrdinal("A1.2.3"),
    ]);
    expect(recreated.transcriptSource(agentOrdinal("A1"))).toBeDefined();
    expect(recreated.transcriptSource(agentOrdinal("A1.2"))).toBeUndefined();
    recreated.dispose();
  });

  test("refreshes from snapshot-watcher changes and stops watching after disposal", async () => {
    const store = new AgentObservationStore();
    register(store, "watch-root", 1, "Root task");
    mkdirSync(observationSlotDirectory(AGENT_DIR, agentId("watch-root")), { recursive: true });
    const source = sourceOver(store);
    await waitForIndexRefresh();
    const before = source.snapshot().revision;

    writePublished("watch-root", [{ ordinal: "A1", sessionId: "watched-child" }]);
    await waitForIndexRefresh();

    expect(Number(source.snapshot().revision)).toBeGreaterThan(Number(before));
    expect(source.snapshot().rows.map((row) => row.ordinal)).toEqual([agentOrdinal("A1"), agentOrdinal("A1.1")]);
    const atDisposal = source.snapshot().revision;
    source.dispose();
    writePublished("watch-root", [{ ordinal: "A2", sessionId: "ignored-child" }]);
    await waitForIndexRefresh();
    expect(source.snapshot().revision).toBe(atDisposal);
  });

  test("honours maxRows by dropping the tail and counting it as omitted", () => {
    const store = new AgentObservationStore();
    register(store, "agent-a", 1, "One");
    register(store, "agent-b", 2, "Two");
    register(store, "agent-c", 3, "Three");
    const source = sourceOver(store, agentCount(2));
    const snapshot = source.snapshot();
    expect(snapshot.rows.map((row) => row.ordinal)).toEqual([agentOrdinal("A1"), agentOrdinal("A2")]);
    expect(Number(snapshot.total)).toBe(3);
    expect(Number(snapshot.omitted)).toBe(1);
    source.dispose();
  });

  test("contains an initial direct projection failure and tears setup down cleanly", () => {
    const diagnostics: string[] = [];
    const listeners = new Set<(change: ObservationChange) => void>();
    const port: SubagentObservationPort = {
      observation: () => undefined,
      directSnapshot: () => { throw new Error("initial projection boom"); },
      transcriptSource: () => undefined,
      subscribe: (listener) => { listeners.add(listener); return () => { listeners.delete(listener); }; },
    };

    const source = createAgentWidgetSource(port, {
      agentDir: AGENT_DIR,
      maxRows: MAX_WIDGET_ROWS,
      onDiagnostic: (code) => { diagnostics.push(code); },
    });

    expect(source.snapshot().rows).toEqual([]);
    expect(source.snapshot().degraded).toBe(true);
    expect(diagnostics).toEqual(["projection-failed"]);
    source.dispose();
    expect(listeners.size).toBe(0);
  });

  test("queued direct projection failures preserve the last good snapshot and report once", async () => {
    const store = new AgentObservationStore();
    register(store, "agent-a", 1, "Research terminal UX");
    let projectionFails = false;
    const diagnostics: string[] = [];
    const port: SubagentObservationPort = {
      observation: (id) => store.observation(id),
      directSnapshot: () => {
        if (projectionFails) throw new Error("queued projection boom");
        return store.directSnapshot();
      },
      transcriptSource: (id) => store.transcriptSource(id),
      subscribe: (listener) => store.subscribe(listener),
    };
    const source = createAgentWidgetSource(port, {
      agentDir: AGENT_DIR,
      maxRows: MAX_WIDGET_ROWS,
      onDiagnostic: (code) => { diagnostics.push(code); throw new Error("diagnostic adapter boom"); },
    });
    const lastGood = source.snapshot();

    projectionFails = true;
    register(store, "agent-b", 2, "Review findings");
    await waitForIndexRefresh();
    register(store, "agent-c", 3, "Summarise");
    await waitForIndexRefresh();

    expect(source.snapshot().rows).toEqual(lastGood.rows);
    expect(Number(source.snapshot().revision)).toBeGreaterThan(Number(lastGood.revision));
    expect(source.snapshot().degraded).toBe(true);
    expect(diagnostics).toEqual(["projection-failed"]);
    source.dispose();
  });

  test("retains the last good rows when the port becomes unavailable", async () => {
    const store = new AgentObservationStore();
    register(store, "agent-a", 1, "Research terminal UX");
    let live = true;
    const notify = new Set<(change: ObservationChange) => void>();
    const change: ObservationChange = {
      revision: agentObservationRevision(1),
      health: { kind: "healthy" },
      changed: [],
      rescanRequired: false,
    };
    const port: SubagentObservationPort = {
      observation: (id) => store.observation(id),
      directSnapshot: () => (live
        ? store.directSnapshot()
        : { kind: "unavailable", finalRevision: agentObservationRevision(1) }),
      transcriptSource: (id) => store.transcriptSource(id),
      subscribe: (listener) => { notify.add(listener); return () => { notify.delete(listener); }; },
    };
    const source = createAgentWidgetSource(port, { agentDir: AGENT_DIR, maxRows: MAX_WIDGET_ROWS });
    const before = source.snapshot().rows;
    const atRevision = source.snapshot().revision;
    expect(before).toHaveLength(1);

    live = false;
    for (const listener of notify) listener(change);
    await waitForIndexRefresh();

    const after = source.snapshot();
    expect(after.rows).toEqual(before);
    expect(after.degraded).toBe(true);
    expect(Number(after.revision)).toBeGreaterThan(Number(atRevision));
    source.dispose();
  });

  test("removes a throwing subscriber without blocking healthy subscribers", async () => {
    const store = new AgentObservationStore();
    register(store, "agent-a", 1, "Research terminal UX");
    const source = sourceOver(store);
    let throwingCalls = 0;
    let healthyCalls = 0;
    source.subscribe(() => { throwingCalls += 1; throw new Error("subscriber boom"); });
    source.subscribe(() => { healthyCalls += 1; });

    register(store, "agent-b", 2, "Review findings");
    await waitForIndexRefresh();
    register(store, "agent-c", 3, "Summarise");
    await waitForIndexRefresh();

    expect(throwingCalls).toBe(1);
    expect(healthyCalls).toBe(2);
    source.dispose();
  });

  test("keeps the first owner when duplicate source ordinals are projected", () => {
    const store = new AgentObservationStore();
    register(store, "agent-a", 1, "First owner");
    register(store, "agent-b", 2, "Duplicate owner");
    const snapshot = store.directSnapshot();
    if (snapshot.kind !== "snapshot") throw new Error("expected snapshot fixture");
    const first = snapshot.entries[0]!;
    const second = snapshot.entries[1]!;
    const port: SubagentObservationPort = {
      observation: (id) => store.observation(id),
      directSnapshot: () => ({
        ...snapshot,
        entries: [first, { ...second, row: { ...second.row, ordinal: first.row.ordinal } }],
      }),
      transcriptSource: (id) => store.transcriptSource(id),
      subscribe: () => () => {},
    };
    const source = createAgentWidgetSource(port, { agentDir: AGENT_DIR, maxRows: MAX_WIDGET_ROWS });

    expect(source.transcriptSource(agentOrdinal("A1"))).toBe(store.transcriptSource(agentId("agent-a")));
    source.dispose();
  });

  test("disposal retries a transient observation-port unsubscription failure", () => {
    const store = new AgentObservationStore();
    let attempts = 0;
    const port: SubagentObservationPort = {
      observation: (id) => store.observation(id),
      directSnapshot: () => store.directSnapshot(),
      transcriptSource: (id) => store.transcriptSource(id),
      subscribe: (listener) => {
        const unsubscribe = store.subscribe(listener);
        return () => {
          attempts += 1;
          if (attempts === 1) throw new Error("port unsubscribe boom");
          unsubscribe();
        };
      },
    };
    const source = createAgentWidgetSource(port, { agentDir: AGENT_DIR, maxRows: MAX_WIDGET_ROWS });

    expect(() => source.dispose()).toThrow("port unsubscribe boom");
    expect(() => source.dispose()).not.toThrow();
    expect(attempts).toBe(2);
  });

  test("disposal stops projecting", async () => {
    const store = new AgentObservationStore();
    register(store, "agent-a", 1, "Research terminal UX");
    const source = sourceOver(store);
    const at = source.snapshot().revision;
    source.dispose();
    register(store, "agent-b", 2, "Review findings");
    await waitForIndexRefresh();
    expect(source.snapshot().revision).toBe(at);
  });
});
