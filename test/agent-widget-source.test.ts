import { describe, expect, test } from "bun:test";

import { AgentObservationStore } from "../src/agent-observation-store.ts";
import type { ObservationChange, SubagentObservationPort } from "../src/agent-observation.ts";
import { createAgentWidgetSource } from "../src/agent-widget/source.ts";
import { MAX_WIDGET_ROWS } from "../src/constants.ts";
import {
  agentCount,
  agentId,
  agentObservationRevision,
  agentOrdinal,
  directAgentOrdinal,
  modelSpec,
} from "../src/domain.ts";
import { testAbsolutePath, testSessionPath } from "./support/brands.ts";

const AGENT_DIR = testAbsolutePath("/tmp/pi-subagents-test");
const flush = () => Promise.resolve().then(() => Promise.resolve());

function register(store: AgentObservationStore, name: string, position: number, assignment: string): void {
  store.registerSpawned({
    agentId: agentId(name),
    ordinal: directAgentOrdinal(position),
    assignment,
    sessionPath: testSessionPath(`/tmp/pi-subagents-test/${name}.jsonl`),
    cwd: AGENT_DIR,
    model: modelSpec("mock-provider/luna"),
    thinkingLevel: "high",
  });
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
    await flush();

    expect(Number(source.snapshot().revision)).toBeGreaterThan(Number(first));
    expect(source.snapshot().rows).toHaveLength(3);
    expect(notifications).toBe(1);
    source.dispose();
  });

  test("resolves a rendered ordinal to its owning transcript source and nothing else", () => {
    const store = new AgentObservationStore();
    register(store, "agent-a", 1, "Research terminal UX");
    const source = sourceOver(store);
    expect(source.transcriptSource(agentOrdinal("A1"))).toBe(store.transcriptSource(agentId("agent-a")));
    expect(source.transcriptSource(agentOrdinal("A9"))).toBeUndefined();
    source.dispose();
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
    await flush();
    register(store, "agent-c", 3, "Summarise");
    await flush();

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
    await flush();

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
    await flush();
    register(store, "agent-c", 3, "Summarise");
    await flush();

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
    await flush();
    expect(source.snapshot().revision).toBe(at);
  });
});
