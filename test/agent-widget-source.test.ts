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
