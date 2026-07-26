import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import type {
  AgentDisplayState,
  AgentRow,
  DirectAgentProjection,
  DirectAgentSnapshotResult,
  SubagentObservationPort,
} from "../src/agent-observation.ts";
import { MAX_WIDGET_ROWS } from "../src/constants.ts";
import { AgentState, CompletionState } from "../src/domain.ts";
import {
  agentCount,
  agentDepth,
  contextPercent,
  agentId,
  agentObservationRevision,
  agentOrdinal,
  incarnationId,
  observationRevision,
  type AbsolutePath,
  type AgentCount,
  type AgentId,
  type ContextLabel,
  type IncarnationId,
  type ModelLabel,
  type TaskLabel,
} from "../src/domain.ts";
import { createObservationRelay } from "../src/observation-relay.ts";
import {
  encodeObservationSnapshot,
  MAX_SNAPSHOT_BYTES,
  observationSlotDirectory,
  observationSnapshotPath,
  readKnownChildSnapshots,
  type KnownChildSnapshots,
  type ObservationRow,
  type ObservationSnapshot,
  type SnapshotSkipReason,
} from "../src/observation-snapshot-path.ts";
import { absolutePath } from "../src/paths.ts";
import {
  createRecursiveAgentIndex,
  MAX_WALK_DEPTH,
  type RecursiveAgentIndexDependencies,
} from "../src/recursive-agent-index.ts";
import type { SnapshotWatcher } from "../src/snapshot-watcher.ts";

let agentDir: AbsolutePath;

beforeEach(() => {
  agentDir = absolutePath(mkdtempSync(join(tmpdir(), "recursive-agent-index-")));
});

afterEach(() => {
  rmSync(agentDir, { recursive: true, force: true });
});

class FakePort implements SubagentObservationPort {
  result: DirectAgentSnapshotResult;
  failure: Error | undefined;

  constructor(result: DirectAgentSnapshotResult) {
    this.result = result;
  }

  observation(): undefined { return undefined; }
  directSnapshot(): DirectAgentSnapshotResult {
    if (this.failure !== undefined) throw this.failure;
    return this.result;
  }
  transcriptSource(): undefined { return undefined; }
  subscribe(): () => void { return () => {}; }
}

class FakeWatcher implements SnapshotWatcher {
  readonly calls: AgentId[][] = [];
  disposed = false;

  track(sessionIds: readonly AgentId[]): void {
    this.calls.push([...sessionIds]);
  }

  dispose(): void {
    this.disposed = true;
  }
}

function displayRow(ordinal: string, state: AgentDisplayState = AgentState.Running, label = ordinal): AgentRow {
  return {
    ordinal: agentOrdinal(ordinal),
    depth: agentDepth(0),
    model: "model:h" as ModelLabel,
    context: "42%" as ContextLabel,
    taskLabel: label as TaskLabel,
    state,
  };
}

function projection(
  id: string,
  ordinal: string,
  state: AgentDisplayState = AgentState.Running,
  label = ordinal,
): DirectAgentProjection {
  const agent = agentId(id);
  const safeLabel = label as TaskLabel;
  const lifecycleState = state === AgentState.Running || state === AgentState.Settling ||
    state === AgentState.Stopping || state === AgentState.Stopped ? state : AgentState.Stopped;
  return {
    agentId: agent,
    observation: {
      agentId: agent,
      ordinal: agentOrdinal(ordinal),
      taskLabel: safeLabel,
      modelLabel: "model:h" as ModelLabel,
      context: { kind: "known", percent: contextPercent(42) },
      lifecycleState,
      displayState: state,
      activity: { kind: "idle" },
      completionPendingDelivery: false,
      revision: agentObservationRevision(1),
    },
    row: displayRow(ordinal, state, label),
  };
}

function direct(
  entries: readonly DirectAgentProjection[],
  options: {
    readonly total?: number;
    readonly omittedActive?: number;
    readonly degraded?: boolean;
  } = {},
): DirectAgentSnapshotResult {
  const total = options.total ?? entries.length;
  return {
    kind: "snapshot",
    revision: agentObservationRevision(1),
    health: options.degraded ? { kind: "degraded", codes: ["projection-failed"] } : { kind: "healthy" },
    total: agentCount(total),
    omitted: agentCount(total - entries.length),
    omittedActive: agentCount(options.omittedActive ?? 0),
    entries,
  };
}

function observationRow(
  ordinal: string,
  id: string,
  state: AgentDisplayState = AgentState.Running,
  label = ordinal,
): ObservationRow {
  return {
    ordinal: agentOrdinal(ordinal),
    sessionId: agentId(id),
    model: "model:h" as ModelLabel,
    context: "42%" as ContextLabel,
    taskLabel: label as TaskLabel,
    state,
  };
}

function snapshot(
  owner: AgentId,
  agents: readonly ObservationRow[],
  options: {
    readonly incarnation?: IncarnationId;
    readonly revision?: number;
    readonly total?: number;
    readonly degraded?: boolean;
  } = {},
): ObservationSnapshot {
  const total = options.total ?? agents.length;
  return {
    sessionId: owner,
    incarnation: options.incarnation ?? incarnationId("inc-1"),
    revision: observationRevision(options.revision ?? 1),
    total: agentCount(total),
    omitted: agentCount(total - agents.length),
    degraded: options.degraded ?? false,
    agents,
  };
}

function writeSnapshot(value: ObservationSnapshot): void {
  mkdirSync(observationSlotDirectory(agentDir, value.sessionId), { recursive: true });
  const encoded = encodeObservationSnapshot(value);
  if (!encoded.ok) throw new Error("snapshot fixture exceeded codec bound");
  writeFileSync(observationSnapshotPath(agentDir, value.sessionId), encoded.text);
}

function fixture(
  result: DirectAgentSnapshotResult,
  options: {
    readonly maxRows?: number;
    readonly readKnownChildSnapshots?: RecursiveAgentIndexDependencies["readKnownChildSnapshots"];
  } = {},
) {
  const port = new FakePort(result);
  const watcher = new FakeWatcher();
  const changes: string[] = [];
  const diagnostics: string[] = [];
  const dependencies: RecursiveAgentIndexDependencies = {
    agentDir,
    maxRows: agentCount(options.maxRows ?? 200),
    onChange: () => { changes.push("change"); },
    onDiagnostic: (code) => { diagnostics.push(code); },
    ...(options.readKnownChildSnapshots === undefined
      ? {}
      : { readKnownChildSnapshots: options.readKnownChildSnapshots }),
  };
  const index = createRecursiveAgentIndex(port, dependencies);
  index.setWatcher(watcher);
  return { index, port, watcher, changes, diagnostics };
}

function ordinals(rows: readonly AgentRow[]): string[] {
  return rows.map((row) => String(row.ordinal));
}

describe("RecursiveAgentIndex", () => {
  test("composes a real relay-written root, child and grandchild tree", () => {
    const child = agentId("child");
    const grandchild = agentId("grandchild");
    const relay = createObservationRelay({
      agentDir,
      sessionId: child,
      incarnation: incarnationId("relay-inc"),
      diagnostic: () => {},
    });
    relay.setPort(new FakePort(direct([projection(grandchild, "A2", AgentState.Running)])));
    relay.flush();
    writeSnapshot(snapshot(grandchild, [observationRow("A1", "great-grandchild", CompletionState.Completed)]));

    const { index } = fixture(direct([projection(child, "A1")]));
    index.refresh();

    expect(ordinals(index.snapshot().rows)).toEqual(["A1", "A1.2", "A1.2.1"]);
    expect(index.snapshot().rows.map((row) => Number(row.depth))).toEqual([0, 1, 2]);
    expect(index.snapshot()).toMatchObject({ total: agentCount(3), omitted: agentCount(0), degraded: false });
    relay.dispose();
  });

  test("rejects a composed publisher ordinal before it collides with a nested direct path", () => {
    const root = agentId("collision-root");
    const directChild = agentId("collision-child");
    writeSnapshot(snapshot(root, [
      observationRow("A2", directChild),
      observationRow("A2.1", "composed-collision", CompletionState.Completed),
    ]));
    writeSnapshot(snapshot(directChild, [
      observationRow("A1", "nested-collision", CompletionState.Completed),
    ]));

    const { index } = fixture(direct([projection(root, "A1")]));
    index.refresh();

    expect(ordinals(index.snapshot().rows)).toEqual(["A1"]);
    expect(index.snapshot()).toMatchObject({ total: agentCount(1), omitted: agentCount(0), degraded: true });
  });

  test("admits depth MAX_WALK_DEPTH - 1, cuts MAX_WALK_DEPTH and guards cycles and overlong ordinals", () => {
    expect(Number(MAX_WALK_DEPTH)).toBe(8);
    const root = agentId("depth-0");
    for (let depth = 0; depth < Number(MAX_WALK_DEPTH); depth += 1) {
      const owner = agentId(`depth-${depth}`);
      const next = depth === Number(MAX_WALK_DEPTH) - 1 ? "depth-cut" : `depth-${depth + 1}`;
      writeSnapshot(snapshot(owner, [observationRow("A1", next)]));
    }
    const { index, watcher } = fixture(direct([projection(root, "A1")]));
    index.refresh();

    expect(index.snapshot().rows).toHaveLength(Number(MAX_WALK_DEPTH));
    expect(index.snapshot().rows.at(-1)?.depth).toBe(agentDepth(Number(MAX_WALK_DEPTH) - 1));
    expect(index.snapshot()).toMatchObject({ total: agentCount(9), omitted: agentCount(1), degraded: true });
    expect(watcher.calls.at(-1)).toEqual(Array.from({ length: 8 }, (_, depth) => agentId(`depth-${depth}`)));

    const cycleRoot = agentId("cycle-root");
    const longRoot = agentId("long-root");
    writeSnapshot(snapshot(cycleRoot, [observationRow("A1", "cycle-root")]));
    const longLocalOrdinal = `A${"1".repeat(127)}`;
    writeSnapshot(snapshot(longRoot, [observationRow(longLocalOrdinal, "too-long")]));
    const second = fixture(direct([projection(cycleRoot, "A1"), projection(longRoot, "A2")]));
    second.index.refresh();
    expect(ordinals(second.index.snapshot().rows)).toEqual(["A1", "A2"]);
    expect(second.index.snapshot()).toMatchObject({ total: agentCount(4), omitted: agentCount(2), degraded: true });
    expect(second.watcher.calls.at(-1)).toEqual([cycleRoot, longRoot]);
  });

  test("cuts active direct subtrees before first-level reads when direct rows exactly fill the budget", () => {
    const left = agentId("direct-budget-left");
    const right = agentId("direct-budget-right");
    let phase: "full" | "room" = "full";
    const reads: AgentId[] = [];
    const reader: typeof readKnownChildSnapshots = (_root, ids) => {
      reads.push(...ids);
      const revision = phase === "full" ? 5 : 4;
      const label = phase === "full" ? "must-not-retain" : "fresh-lower-revision";
      return {
        snapshots: new Map(ids.map((owner) => [owner, snapshot(owner, [
          observationRow("A1", `${owner}-child`, CompletionState.Completed, label),
        ], { incarnation: incarnationId("direct-budget-inc"), revision })])),
        skipped: new Map(),
      };
    };
    const { index, port, watcher } = fixture(
      direct([projection(left, "A1"), projection(right, "A2")]),
      { maxRows: 2, readKnownChildSnapshots: reader },
    );

    index.refresh();

    expect(ordinals(index.snapshot().rows)).toEqual(["A1", "A2"]);
    expect(index.snapshot()).toMatchObject({ total: agentCount(2), omitted: agentCount(0), degraded: true });
    expect(reads).toEqual([]);
    expect(watcher.calls.at(-1)).toEqual([left, right]);

    phase = "room";
    port.result = direct([projection(left, "A1")]);
    index.refresh();

    expect(reads).toEqual([left]);
    expect(index.snapshot().rows[1]?.taskLabel).toBe("fresh-lower-revision" as TaskLabel);
    expect(index.snapshot().degraded).toBe(true);
    expect(watcher.calls.at(-1)).toEqual([left]);
  });

  test("degrades when an admitted terminal direct publisher is unread at the exact row budget", () => {
    const terminal = agentId("terminal-direct-budget");
    const reads: AgentId[] = [];
    const reader: typeof readKnownChildSnapshots = (_root, ids) => {
      reads.push(...ids);
      return { snapshots: new Map(), skipped: new Map() };
    };
    const { index } = fixture(
      direct([projection(terminal, "A1", CompletionState.Completed)]),
      { maxRows: 1, readKnownChildSnapshots: reader },
    );

    index.refresh();

    expect(ordinals(index.snapshot().rows)).toEqual(["A1"]);
    expect(index.snapshot()).toMatchObject({ total: agentCount(1), omitted: agentCount(0), degraded: true });
    expect(reads).toEqual([]);
  });

  test("finishes current-level accounting but does not read the next BFS level after exhausting the row budget", () => {
    const left = agentId("left");
    const right = agentId("right");
    const leftDeep = agentId("left-deep");
    const rejected = agentId("rejected");
    writeSnapshot(snapshot(left, [
      observationRow("A1", leftDeep),
      observationRow("A2", "left-leaf", CompletionState.Completed),
    ]));
    writeSnapshot(snapshot(right, [observationRow("A1", "right-leaf", CompletionState.Completed)]));
    writeSnapshot(snapshot(leftDeep, [observationRow("A1", rejected)]));
    writeSnapshot(snapshot(rejected, [observationRow("A1", "must-not-read")]));
    const readBatches: AgentId[][] = [];
    const reader: typeof readKnownChildSnapshots = (root, ids) => {
      readBatches.push([...ids]);
      return readKnownChildSnapshots(root, ids);
    };
    const { index, watcher } = fixture(
      direct([projection(left, "A1"), projection(right, "A2")]),
      { maxRows: 5, readKnownChildSnapshots: reader },
    );
    index.refresh();

    expect(ordinals(index.snapshot().rows)).toEqual(["A1", "A1.1", "A1.2", "A2", "A2.1"]);
    expect(index.snapshot()).toMatchObject({ total: agentCount(5), omitted: agentCount(0), degraded: true });
    expect(readBatches.flat()).toEqual([left, right]);
    expect(readBatches.flat()).not.toContain(leftDeep);
    expect(readBatches.flat()).not.toContain(rejected);
    expect(watcher.calls.at(-1)).toEqual([left, right, leftDeep]);
    expect(watcher.calls.at(-1)!.length).toBeLessThanOrEqual(5);
    expect(new Set(readBatches.flat()).size).toBeLessThanOrEqual(5);
  });

  test("degrades when an unread terminal next-level owner exactly fills the budget", () => {
    const root = agentId("exact-budget-root");
    writeSnapshot(snapshot(root, [
      observationRow("A1", "exact-budget-leaf", CompletionState.Completed),
    ]));
    const { index } = fixture(direct([projection(root, "A1")]), { maxRows: 2 });

    index.refresh();

    expect(ordinals(index.snapshot().rows)).toEqual(["A1", "A1.1"]);
    expect(index.snapshot()).toMatchObject({ total: agentCount(2), omitted: agentCount(0), degraded: true });
  });

  test("clamps an oversized dependency budget to MAX_WIDGET_ROWS across admission and retention", () => {
    const owners = Array.from({ length: Number(MAX_WIDGET_ROWS) + 1 }, (_, index) => agentId(`bounded-${index + 1}`));
    let phase = 1;
    const reads: AgentId[] = [];
    const reader: typeof readKnownChildSnapshots = (_root, ids) => {
      reads.push(...ids);
      const directOwners = new Set(owners);
      return {
        snapshots: new Map(ids.flatMap((owner) => directOwners.has(owner)
          ? [[owner, snapshot(owner, [
            observationRow("A1", `${owner}-leaf`, CompletionState.Completed, phase === 1 ? "old" : "new"),
          ], { incarnation: incarnationId("bounded-inc"), revision: phase === 1 ? 5 : 4 })] as const]
          : [])),
        skipped: new Map(ids.flatMap((owner) => directOwners.has(owner)
          ? []
          : [[owner, "missing-directory"]] as const)),
      };
    };
    const { index, port, watcher } = fixture(
      direct(owners.map((owner, index) => projection(owner, `A${index + 1}`))),
      { maxRows: Number(MAX_WIDGET_ROWS) + 1, readKnownChildSnapshots: reader },
    );

    index.refresh();
    expect(index.snapshot().rows).toHaveLength(Number(MAX_WIDGET_ROWS));
    expect(reads).toHaveLength(0);
    expect(watcher.calls.at(-1)).toHaveLength(Number(MAX_WIDGET_ROWS));
    expect(reads).not.toContain(owners.at(-1));
    expect(watcher.calls.at(-1)).not.toContain(owners.at(-1));

    phase = 2;
    port.result = direct([projection(owners.at(-1)!, "A1")]);
    index.refresh();
    expect(index.snapshot().rows[1]?.taskLabel).toBe("new" as TaskLabel);
    expect(index.snapshot().degraded).toBe(false);
  });

  test.each([
    ["degraded direct health", direct([projection("root", "A1")], { degraded: true })],
    ["active direct omission", direct([projection("root", "A1")], { total: 2, omittedActive: 1 })],
  ] as const)("degrades for %s", (_name, result) => {
    const { index } = fixture(result);
    index.refresh();
    expect(index.snapshot().degraded).toBe(true);
  });

  test("prioritises active children over earlier terminal children within the row bound", () => {
    const root = agentId("priority-root");
    const activeTwo = agentId("priority-active-two");
    const activeFour = agentId("priority-active-four");
    const reads: AgentId[] = [];
    writeSnapshot(snapshot(root, [
      observationRow("A1", "priority-terminal-one", CompletionState.Completed),
      observationRow("A2", activeTwo, AgentState.Running),
      observationRow("A3", "priority-terminal-three", CompletionState.Completed),
      observationRow("A4", activeFour, AgentState.Running),
    ]));
    const reader: typeof readKnownChildSnapshots = (rootDir, ids) => {
      reads.push(...ids);
      return readKnownChildSnapshots(rootDir, ids);
    };
    const { index, watcher } = fixture(direct([projection(root, "A1")]), {
      maxRows: 3,
      readKnownChildSnapshots: reader,
    });

    index.refresh();

    expect(ordinals(index.snapshot().rows)).toEqual(["A1", "A1.2", "A1.4"]);
    expect(index.snapshot()).toMatchObject({ total: agentCount(5), omitted: agentCount(2), degraded: true });
    expect(reads).toEqual([root]);
    expect(watcher.calls.at(-1)).toEqual([root, activeTwo, activeFour]);
  });

  test("admits contended active children in source order while emitting ordinal order", () => {
    const root = agentId("active-source-order-root");
    const activeFour = agentId("active-source-order-four");
    const activeTwo = agentId("active-source-order-two");
    const activeThree = agentId("active-source-order-three");
    const reads: AgentId[] = [];
    writeSnapshot(snapshot(root, [
      observationRow("A1", "active-source-order-terminal", CompletionState.Completed),
      observationRow("A4", activeFour, AgentState.Running),
      observationRow("A2", activeTwo, AgentState.Running),
      observationRow("A3", activeThree, AgentState.Running),
    ]));
    const reader: typeof readKnownChildSnapshots = (rootDir, ids) => {
      reads.push(...ids);
      return readKnownChildSnapshots(rootDir, ids);
    };
    const { index, watcher } = fixture(direct([projection(root, "A1")]), {
      maxRows: 3,
      readKnownChildSnapshots: reader,
    });

    index.refresh();

    expect(ordinals(index.snapshot().rows)).toEqual(["A1", "A1.2", "A1.4"]);
    expect(index.snapshot()).toMatchObject({ total: agentCount(5), omitted: agentCount(2), degraded: true });
    expect(reads).toEqual([root]);
    expect(watcher.calls.at(-1)).toEqual([root, activeFour, activeTwo]);
    expect(reads).not.toContain(activeThree);
    expect(watcher.calls.at(-1)).not.toContain(activeThree);
    expect(index.snapshot().rows).toHaveLength(3);
    expect(reads.length).toBeLessThanOrEqual(3);
    expect(watcher.calls.at(-1)!.length).toBeLessThanOrEqual(3);
  });

  test("admits A10 over A9 for one bounded terminal slot", () => {
    const root = agentId("terminal-numeric-recency-root");
    writeSnapshot(snapshot(root, [
      observationRow("A9", "terminal-numeric-recency-nine", CompletionState.Completed),
      observationRow("A10", "terminal-numeric-recency-ten", CompletionState.Completed),
    ]));
    const { index, watcher } = fixture(direct([projection(root, "A1")]), { maxRows: 2 });

    index.refresh();

    expect(ordinals(index.snapshot().rows)).toEqual(["A1", "A1.10"]);
    expect(index.snapshot()).toMatchObject({ total: agentCount(3), omitted: agentCount(1), degraded: true });
    expect(watcher.calls.at(-1)).toEqual([root]);
  });

  test("keeps retained terminal fallback isolated from rejected active owners", () => {
    const root = agentId("terminal-fallback-bound-root");
    const admittedNine = agentId("terminal-fallback-active-nine");
    const admittedTen = agentId("terminal-fallback-active-ten");
    const rejected = agentId("terminal-fallback-rejected-active");
    const reads: AgentId[] = [];
    let fallback = false;
    const reader: typeof readKnownChildSnapshots = (_root, ids) => {
      reads.push(...ids);
      if (!ids.includes(root)) {
        return {
          snapshots: new Map(),
          skipped: new Map(ids.map((owner) => [owner, "missing-directory"] as const)),
        };
      }
      if (fallback) {
        return { snapshots: new Map(), skipped: new Map([[root, "malformed"]]) };
      }
      return {
        snapshots: new Map([[root, snapshot(root, [
          observationRow("A9", admittedNine, AgentState.Running, "admitted-nine"),
          observationRow("A10", admittedTen, AgentState.Running, "admitted-ten"),
          observationRow("A1", rejected, AgentState.Running, "rejected"),
        ])]]),
        skipped: new Map(),
      };
    };
    const { index, watcher } = fixture(
      direct([projection(root, "A1", CompletionState.Completed)]),
      { maxRows: 3, readKnownChildSnapshots: reader },
    );

    index.refresh();
    fallback = true;
    index.refresh();

    expect(ordinals(index.snapshot().rows)).toEqual(["A1", "A1.9", "A1.10"]);
    expect(index.snapshot().rows.map((row) => row.taskLabel)).toEqual([
      "A1" as TaskLabel,
      "admitted-nine" as TaskLabel,
      "admitted-ten" as TaskLabel,
    ]);
    expect(index.snapshot().rows.slice(1).map((row) => row.state)).toEqual([
      AgentState.Running,
      AgentState.Running,
    ]);
    expect(index.snapshot()).toMatchObject({ total: agentCount(4), omitted: agentCount(1), degraded: true });
    expect(reads).toEqual([root, root]);
    expect(reads).not.toContain(admittedNine);
    expect(reads).not.toContain(admittedTen);
    expect(reads).not.toContain(rejected);
    expect(watcher.calls).toEqual([[root, admittedNine, admittedTen], [root, admittedNine, admittedTen]]);
    expect(watcher.calls.flat()).not.toContain(rejected);
    expect(ordinals(index.snapshot().rows)).not.toContain("A1.1");
    expect(index.snapshot().rows).toHaveLength(3);
    expect(reads.length).toBeLessThanOrEqual(3);
    expect(watcher.calls.at(-1)!.length).toBeLessThanOrEqual(3);
  });

  test("admits recent terminal children but emits them in local ordinal order", () => {
    const root = agentId("terminal-recency-root");
    const reads: AgentId[] = [];
    writeSnapshot(snapshot(root, [
      observationRow("A1", "terminal-recency-one", CompletionState.Completed),
      observationRow("A2", "terminal-recency-two", CompletionState.Completed),
      observationRow("A3", "terminal-recency-three", CompletionState.Completed),
      observationRow("A4", "terminal-recency-four", CompletionState.Completed),
    ]));
    const reader: typeof readKnownChildSnapshots = (rootDir, ids) => {
      reads.push(...ids);
      return readKnownChildSnapshots(rootDir, ids);
    };
    const { index, watcher } = fixture(direct([projection(root, "A1")]), {
      maxRows: 3,
      readKnownChildSnapshots: reader,
    });

    index.refresh();

    expect(ordinals(index.snapshot().rows)).toEqual(["A1", "A1.3", "A1.4"]);
    expect(index.snapshot()).toMatchObject({ total: agentCount(5), omitted: agentCount(2), degraded: true });
    expect(reads).toEqual([root]);
    expect(watcher.calls.at(-1)).toEqual([root]);
  });

  test("prioritises active grandchildren at each breadth-first level", () => {
    const root = agentId("multi-level-root");
    const earlierTerminal = agentId("multi-level-earlier-terminal");
    const laterActive = agentId("multi-level-later-active");
    const activeOne = agentId("multi-level-active-one");
    const activeTwo = agentId("multi-level-active-two");
    const reads: AgentId[] = [];
    writeSnapshot(snapshot(root, [
      observationRow("A1", earlierTerminal, CompletionState.Completed),
      observationRow("A2", laterActive, AgentState.Running),
    ]));
    writeSnapshot(snapshot(earlierTerminal, [
      observationRow("A1", "multi-level-terminal-one", CompletionState.Completed),
      observationRow("A2", "multi-level-terminal-two", CompletionState.Completed),
    ]));
    writeSnapshot(snapshot(laterActive, [
      observationRow("A1", activeOne, AgentState.Running),
      observationRow("A2", activeTwo, AgentState.Running),
    ]));
    const reader: typeof readKnownChildSnapshots = (rootDir, ids) => {
      reads.push(...ids);
      return readKnownChildSnapshots(rootDir, ids);
    };
    const { index, watcher } = fixture(direct([projection(root, "A1")]), {
      maxRows: 5,
      readKnownChildSnapshots: reader,
    });

    index.refresh();

    expect(ordinals(index.snapshot().rows)).toEqual(["A1", "A1.1", "A1.2", "A1.2.1", "A1.2.2"]);
    expect(index.snapshot()).toMatchObject({ total: agentCount(7), omitted: agentCount(2), degraded: true });
    expect(reads).toEqual([root, laterActive, earlierTerminal]);
    expect(watcher.calls.at(-1)).toEqual([root, laterActive, earlierTerminal, activeOne, activeTwo]);
  });

  test("propagates publisher totals and degradation", () => {
    const root = agentId("root");
    writeSnapshot(snapshot(root, [observationRow("A1", "leaf", CompletionState.Completed)], {
      total: 3,
      degraded: true,
    }));
    const { index } = fixture(direct([projection(root, "A1")]));
    index.refresh();
    expect(index.snapshot()).toMatchObject({ total: agentCount(4), omitted: agentCount(2), degraded: true });
  });

  test("saturates count arithmetic and degrades", () => {
    const root = agentId("root");
    writeSnapshot(snapshot(root, [], { total: 1 }));
    const { index } = fixture(direct([projection(root, "A1", CompletionState.Completed)], {
      total: Number.MAX_SAFE_INTEGER,
    }));
    index.refresh();
    expect(index.snapshot()).toMatchObject({
      total: agentCount(Number.MAX_SAFE_INTEGER),
      omitted: agentCount(Number.MAX_SAFE_INTEGER - 1),
      degraded: true,
    });
  });

  test.each(["missing-directory", "malformed", "unreadable", "oversized", "session-id-mismatch"] as const)(
    "keeps an active parent without inventing descendants for an unusable %s slot",
    (failure) => {
      const root = agentId(`root-${failure}`);
      const path = observationSnapshotPath(agentDir, root);
      if (failure !== "missing-directory") mkdirSync(observationSlotDirectory(agentDir, root), { recursive: true });
      if (failure === "malformed") writeFileSync(path, "{");
      if (failure === "unreadable") {
        writeFileSync(path, "{}");
        chmodSync(path, 0o000);
      }
      if (failure === "oversized") writeFileSync(path, "x".repeat(Number(MAX_SNAPSHOT_BYTES) + 1));
      if (failure === "session-id-mismatch") {
        const wrong = snapshot(agentId("different-owner"), []);
        const encoded = encodeObservationSnapshot(wrong);
        if (!encoded.ok) throw new Error("unexpected fixture encoding failure");
        writeFileSync(path, encoded.text);
      }
      const { index, watcher } = fixture(direct([projection(root, "A1")]));
      index.refresh();
      if (failure === "unreadable") chmodSync(path, 0o600);

      expect(ordinals(index.snapshot().rows)).toEqual(["A1"]);
      expect(index.snapshot()).toMatchObject({ total: agentCount(1), omitted: agentCount(0), degraded: true });
      expect(watcher.calls.at(-1)).toEqual([root]);
    },
  );

  test.each([
    AgentState.Stopped,
    CompletionState.Completed,
    CompletionState.Failed,
    CompletionState.Cancelled,
  ] as const)("reconstructs valid terminal state %s slots", (state) => {
    const terminal = agentId(`terminal-${state}`);
    const terminalChild = agentId(`terminal-${state}-child`);
    writeSnapshot(snapshot(terminal, [observationRow("A1", terminalChild, CompletionState.Completed)]));
    const reads: AgentId[] = [];
    const reader: typeof readKnownChildSnapshots = (root, ids) => {
      reads.push(...ids);
      return readKnownChildSnapshots(root, ids);
    };
    const { index, watcher } = fixture(direct([projection(terminal, "A1", state)]), {
      maxRows: 3,
      readKnownChildSnapshots: reader,
    });
    index.refresh();

    expect(ordinals(index.snapshot().rows)).toEqual(["A1", "A1.1"]);
    expect(index.snapshot()).toMatchObject({ total: agentCount(2), omitted: agentCount(0), degraded: false });
    expect(reads).toEqual([terminal, terminalChild]);
    expect(watcher.calls.at(-1)).toEqual([terminal]);
  });

  test.each([
    ["missing-directory", false, []],
    ["missing-file", false, [agentId("terminal-missing-file")]],
    ["malformed", true, [agentId("terminal-malformed")]],
    ["unreadable", true, [agentId("terminal-unreadable")]],
    ["oversized", true, [agentId("terminal-oversized")]],
    ["session-id-mismatch", true, [agentId("terminal-session-id-mismatch")]],
    ["not-a-regular-file", true, [agentId("terminal-not-a-regular-file")]],
    ["invalid-session-id", true, []],
    ["escapes-managed-root", true, []],
  ] as const)("classifies terminal %s slots without retained data", (reason, expectedDegraded, expectedTracked) => {
    const owner = agentId(`terminal-${reason}`);
    const reader: typeof readKnownChildSnapshots = (_root, ids) => ({
      snapshots: new Map(),
      skipped: new Map(ids.map((id) => [id, reason] as const)),
    });
    const { index, watcher } = fixture(
      direct([projection(owner, "A1", CompletionState.Completed)]),
      { readKnownChildSnapshots: reader },
    );

    index.refresh();

    expect(ordinals(index.snapshot().rows)).toEqual(["A1"]);
    expect(index.snapshot()).toMatchObject({ total: agentCount(1), omitted: agentCount(0), degraded: expectedDegraded });
    expect(watcher.calls.at(-1)).toEqual([...expectedTracked]);
  });

  test.each([
    "missing-file",
    "not-a-regular-file",
    "unreadable",
    "oversized",
    "malformed",
    "session-id-mismatch",
    "invalid-session-id",
    "escapes-managed-root",
  ] as const)("retains a terminal revision through a %s replacement failure", (reason) => {
    const owner = agentId(`retained-${reason}`);
    let result: KnownChildSnapshots = {
      snapshots: new Map([[owner, snapshot(owner, [observationRow("A1", "retained-child", CompletionState.Completed)], {
        revision: 5,
      })]]),
      skipped: new Map(),
    };
    const reader: typeof readKnownChildSnapshots = (_root, ids) => ids.includes(owner)
      ? result
      : { snapshots: new Map(), skipped: new Map(ids.map((id) => [id, "missing-directory"] as const)) };
    const { index, watcher } = fixture(
      direct([projection(owner, "A1", CompletionState.Completed)]),
      { readKnownChildSnapshots: reader },
    );

    index.refresh();
    result = { snapshots: new Map(), skipped: new Map([[owner, reason]]) };
    index.refresh();

    expect(ordinals(index.snapshot().rows)).toEqual(["A1", "A1.1"]);
    expect(index.snapshot()).toMatchObject({ total: agentCount(2), omitted: agentCount(0), degraded: true });
    expect(watcher.calls.at(-1)).toEqual(
      reason === "invalid-session-id" || reason === "escapes-managed-root" ? [] : [owner],
    );
  });

  test("retains a terminal revision when a same-incarnation snapshot regresses", () => {
    const owner = agentId("retained-stale-revision");
    let result: KnownChildSnapshots = {
      snapshots: new Map([[owner, snapshot(owner, [observationRow("A1", "revision-five", CompletionState.Completed, "revision-five")], {
        incarnation: incarnationId("terminal-inc"), revision: 5,
      })]]),
      skipped: new Map(),
    };
    const reader: typeof readKnownChildSnapshots = (_root, ids) => ids.includes(owner)
      ? result
      : { snapshots: new Map(), skipped: new Map(ids.map((id) => [id, "missing-directory"] as const)) };
    const { index } = fixture(
      direct([projection(owner, "A1", CompletionState.Completed)]),
      { readKnownChildSnapshots: reader },
    );

    index.refresh();
    result = {
      snapshots: new Map([[owner, snapshot(owner, [observationRow("A1", "revision-four", CompletionState.Completed, "revision-four")], {
        incarnation: incarnationId("terminal-inc"), revision: 4,
      })]]),
      skipped: new Map(),
    };
    index.refresh();

    expect(index.snapshot().rows[1]?.taskLabel).toBe("revision-five" as TaskLabel);
    expect(index.snapshot().degraded).toBe(true);
  });

  test("preserves an active child published by a terminal ancestor and marks the projection degraded", () => {
    const owner = agentId("terminal-active-ancestor");
    const child = agentId("terminal-active-child");
    const grandchild = agentId("terminal-active-grandchild");
    const reader: typeof readKnownChildSnapshots = (_root, ids) => ({
      snapshots: new Map(ids.flatMap((id) => {
        if (id === owner) return [[owner, snapshot(owner, [observationRow("A1", child, AgentState.Running)])]];
        if (id === child) return [[child, snapshot(child, [observationRow("A1", grandchild, CompletionState.Completed)])]];
        return [];
      })),
      skipped: new Map(ids.filter((id) => id !== owner && id !== child).map((id) => [id, "missing-directory"] as const)),
    });
    const { index, watcher } = fixture(
      direct([projection(owner, "A1", CompletionState.Completed)]),
      { readKnownChildSnapshots: reader },
    );

    index.refresh();

    expect(ordinals(index.snapshot().rows)).toEqual(["A1", "A1.1", "A1.1.1"]);
    expect(index.snapshot().rows[1]?.state).toBe(AgentState.Running);
    expect(index.snapshot().degraded).toBe(true);
    expect(watcher.calls.at(-1)).toEqual([owner, child]);
  });

  test("contains malformed and unsafe terminal subtrees without admitting unvalidated rows", () => {
    const malformed = agentId("terminal-malformed-row");
    const unsafe = agentId("terminal-unsafe-slot");
    const reader: typeof readKnownChildSnapshots = (_root, ids) => ({
      snapshots: new Map(),
      skipped: new Map(ids.map((id): readonly [AgentId, SnapshotSkipReason] => [
        id,
        id === malformed ? "malformed" : "escapes-managed-root",
      ])),
    });
    const { index, watcher } = fixture(
      direct([
        projection(malformed, "A1", CompletionState.Completed),
        projection(unsafe, "A2", CompletionState.Completed),
      ]),
      { readKnownChildSnapshots: reader },
    );

    index.refresh();

    expect(ordinals(index.snapshot().rows)).toEqual(["A1", "A2"]);
    expect(index.snapshot()).toMatchObject({ total: agentCount(2), omitted: agentCount(0), degraded: true });
    expect(watcher.calls.at(-1)).toEqual([malformed]);
  });

  test("preserves terminal cycle, depth and row bounds", () => {
    const cycle = agentId("terminal-cycle");
    writeSnapshot(snapshot(cycle, [observationRow("A1", cycle, CompletionState.Completed)]));
    const cycleIndex = fixture(direct([projection(cycle, "A1", CompletionState.Completed)]));
    cycleIndex.index.refresh();
    expect(ordinals(cycleIndex.index.snapshot().rows)).toEqual(["A1"]);
    expect(cycleIndex.index.snapshot()).toMatchObject({ total: agentCount(2), omitted: agentCount(1), degraded: true });

    const depthRoot = agentId("terminal-depth-0");
    for (let depth = 0; depth < Number(MAX_WALK_DEPTH); depth += 1) {
      const owner = agentId(`terminal-depth-${depth}`);
      const child = agentId(`terminal-depth-${depth + 1}`);
      writeSnapshot(snapshot(owner, [observationRow("A1", child, CompletionState.Completed)]));
    }
    const depthIndex = fixture(direct([projection(depthRoot, "A1", CompletionState.Completed)]));
    depthIndex.index.refresh();
    expect(depthIndex.index.snapshot().rows).toHaveLength(Number(MAX_WALK_DEPTH));
    expect(depthIndex.index.snapshot().rows.at(-1)?.depth).toBe(agentDepth(Number(MAX_WALK_DEPTH) - 1));
    expect(depthIndex.index.snapshot()).toMatchObject({ total: agentCount(9), omitted: agentCount(1), degraded: true });

    const bounded = agentId("terminal-row-bound");
    writeSnapshot(snapshot(bounded, Array.from({ length: Number(MAX_WIDGET_ROWS) }, (_, index) =>
      observationRow(`A${index + 1}`, `terminal-row-${index + 1}`, CompletionState.Completed),
    )));
    const boundedReads: AgentId[] = [];
    const boundedReader: typeof readKnownChildSnapshots = (rootDir, ids) => {
      boundedReads.push(...ids);
      return readKnownChildSnapshots(rootDir, ids);
    };
    const boundedIndex = fixture(
      direct([projection(bounded, "A1", CompletionState.Completed)]),
      { maxRows: Number(MAX_WIDGET_ROWS), readKnownChildSnapshots: boundedReader },
    );
    boundedIndex.index.refresh();
    expect(boundedIndex.index.snapshot().rows).toHaveLength(Number(MAX_WIDGET_ROWS));
    expect(boundedIndex.index.snapshot()).toMatchObject({
      total: agentCount(Number(MAX_WIDGET_ROWS) + 1),
      omitted: agentCount(1),
      degraded: true,
    });
    expect(boundedReads).toEqual([bounded]);
    expect(boundedIndex.watcher.calls.at(-1)).toEqual([bounded]);
    expect(boundedReads.length).toBeLessThanOrEqual(Number(MAX_WIDGET_ROWS));
    expect(boundedIndex.watcher.calls.at(-1)!.length).toBeLessThanOrEqual(Number(MAX_WIDGET_ROWS));
  });

  test("reconstructs a completed three-level tree after fresh index creation", () => {
    const parent = agentId("completed-parent");
    const child = agentId("completed-child");
    writeSnapshot(snapshot(parent, [observationRow("A2", child, CompletionState.Completed)]));
    writeSnapshot(snapshot(child, [observationRow("A3", "completed-grandchild", CompletionState.Completed)]));
    const directProjection = direct([projection(parent, "A1", CompletionState.Completed)]);

    const first = fixture(directProjection);
    first.index.refresh();
    const second = fixture(directProjection);
    second.index.refresh();

    for (const index of [first.index, second.index]) {
      expect(ordinals(index.snapshot().rows)).toEqual(["A1", "A1.2", "A1.2.3"]);
      expect(index.snapshot().rows.map((row) => Number(row.depth))).toEqual([0, 1, 2]);
      expect(index.snapshot()).toMatchObject({ total: agentCount(3), omitted: agentCount(0), degraded: false });
    }
  });

  test.each([
    [AgentState.Running, true],
    [AgentState.Settling, true],
    [AgentState.Stopping, true],
    [AgentState.Stopped, false],
    [CompletionState.Completed, false],
    [CompletionState.Failed, false],
    [CompletionState.Cancelled, false],
  ] as const)("uses exhaustive state semantics for %s", (state, active) => {
    const child = agentId(`state-${state}`);
    const reads: AgentId[] = [];
    const reader = (root: AbsolutePath, ids: readonly AgentId[]): KnownChildSnapshots => {
      reads.push(...ids);
      return readKnownChildSnapshots(root, ids);
    };
    const { index, watcher } = fixture(direct([projection(child, "A1", state)]), {
      readKnownChildSnapshots: reader,
    });
    index.refresh();

    expect(reads).toEqual([child]);
    expect(watcher.calls.at(-1)).toEqual(active ? [child] : []);
    expect(index.snapshot().degraded).toBe(active);
  });

  test("applies the incarnation and revision matrix without unusable fallback", () => {
    const owner = agentId("revision-owner");
    const oldIncarnation = incarnationId("old-inc");
    const newIncarnation = incarnationId("new-inc");
    let outcome: KnownChildSnapshots = {
      snapshots: new Map([[owner, snapshot(owner, [observationRow("A1", "old-leaf", CompletionState.Completed, "old")], {
        incarnation: oldIncarnation,
        revision: 5,
      })]]),
      skipped: new Map(),
    };
    const reader: typeof readKnownChildSnapshots = (_root, ids) => ids.includes(owner)
      ? outcome
      : {
        snapshots: new Map(),
        skipped: new Map(ids.map((id) => [id, "missing-directory"] as const)),
      };
    const { index, port } = fixture(direct([projection(owner, "A1")]), { readKnownChildSnapshots: reader });

    index.refresh();
    expect(index.snapshot().rows[1]?.taskLabel).toBe("old" as TaskLabel);

    outcome = { snapshots: new Map([[owner, snapshot(owner, [observationRow("A1", "new-leaf", CompletionState.Completed, "new")], {
      incarnation: newIncarnation,
      revision: 1,
    })]]), skipped: new Map() };
    index.refresh();
    expect(index.snapshot().rows[1]?.taskLabel).toBe("new" as TaskLabel);
    expect(index.snapshot().degraded).toBe(false);

    outcome = { snapshots: new Map([[owner, snapshot(owner, [observationRow("A1", "greater-leaf", CompletionState.Completed, "greater")], {
      incarnation: newIncarnation,
      revision: 2,
    })]]), skipped: new Map() };
    index.refresh();
    expect(index.snapshot().rows[1]?.taskLabel).toBe("greater" as TaskLabel);
    expect(index.snapshot().degraded).toBe(false);

    outcome = { snapshots: new Map([[owner, snapshot(owner, [observationRow("A1", "equal-leaf", CompletionState.Completed, "equal")], {
      incarnation: newIncarnation,
      revision: 2,
    })]]), skipped: new Map() };
    index.refresh();
    expect(index.snapshot().rows[1]?.taskLabel).toBe("equal" as TaskLabel);
    expect(index.snapshot().degraded).toBe(false);

    outcome = { snapshots: new Map([[owner, snapshot(owner, [observationRow("A1", "regressed-leaf", CompletionState.Completed, "regressed")], {
      incarnation: newIncarnation,
      revision: 0,
    })]]), skipped: new Map() };
    index.refresh();
    expect(index.snapshot().rows[1]?.taskLabel).toBe("equal" as TaskLabel);
    expect(index.snapshot().degraded).toBe(true);

    outcome = { snapshots: new Map(), skipped: new Map([[owner, "malformed"]]) };
    index.refresh();
    expect(ordinals(index.snapshot().rows)).toEqual(["A1"]);
    expect(index.snapshot()).toMatchObject({ total: agentCount(1), omitted: agentCount(0), degraded: true });

    outcome = { snapshots: new Map([[owner, snapshot(owner, [observationRow("A1", "first-seen", CompletionState.Completed, "first-seen")], {
      incarnation: newIncarnation,
      revision: 0,
    })]]), skipped: new Map() };
    index.refresh();
    expect(index.snapshot().rows[1]?.taskLabel).toBe("first-seen" as TaskLabel);
    expect(index.snapshot().degraded).toBe(false);

    port.result = direct([projection(owner, "A1", CompletionState.Completed)]);
    index.refresh();
    port.result = direct([projection(owner, "A1")]);
    outcome = { snapshots: new Map([[owner, snapshot(owner, [observationRow("A1", "after-prune", CompletionState.Completed, "after-prune")], {
      incarnation: newIncarnation,
      revision: 0,
    })]]), skipped: new Map() };
    index.refresh();
    expect(index.snapshot().rows[1]?.taskLabel).toBe("after-prune" as TaskLabel);
    expect(index.snapshot().degraded).toBe(false);
  });

  test("resolves ownership for direct rows only", () => {
    const owner = agentId("owner");
    writeSnapshot(snapshot(owner, [observationRow("A1", "descendant", CompletionState.Completed)]));
    const { index } = fixture(direct([projection(owner, "A1")]));
    index.refresh();

    expect(index.ownerOf(agentOrdinal("A1"))).toBe(owner);
    expect(index.ownerOf(agentOrdinal("A1.1"))).toBeUndefined();
    expect(index.ownerOf(agentOrdinal("A9"))).toBeUndefined();
  });

  test("retains prior roots through unavailable and thrown projection failures", () => {
    const owner = agentId("owner");
    const { index, port, diagnostics, changes } = fixture(direct([projection(owner, "A1", CompletionState.Completed)]));
    index.refresh();
    const good = index.snapshot();

    port.result = { kind: "unavailable", finalRevision: agentObservationRevision(2) };
    index.refresh();
    expect(index.snapshot()).toMatchObject({ rows: good.rows, total: good.total, omitted: good.omitted, degraded: true });
    expect(Number(index.snapshot().revision)).toBe(Number(good.revision) + 1);
    expect(diagnostics).toEqual([]);

    port.failure = new Error("projection failed");
    index.refresh();
    index.refresh();
    expect(index.snapshot().rows).toEqual(good.rows);
    expect(diagnostics).toEqual(["projection-failed"]);
    expect(changes).toHaveLength(4);
  });

  test("contains initial projection and callback failures, then disposal makes refresh inert", () => {
    const port = new FakePort(direct([]));
    port.failure = new Error("initial projection failed");
    const diagnostics: string[] = [];
    const watcher = new FakeWatcher();
    const index = createRecursiveAgentIndex(port, {
      agentDir,
      maxRows: agentCount(2),
      onChange: () => { throw new Error("callback failed"); },
      onDiagnostic: (code) => { diagnostics.push(code); throw new Error("diagnostic failed"); },
    });
    index.setWatcher(watcher);

    expect(() => index.refresh()).not.toThrow();
    expect(index.snapshot()).toMatchObject({ rows: [], total: agentCount(0), omitted: agentCount(0), degraded: true });
    expect(index.snapshot().revision).toBeDefined();
    expect(diagnostics).toEqual(["projection-failed"]);
    const at = index.snapshot();

    index.dispose();
    port.failure = undefined;
    port.result = direct([projection("later", "A1")]);
    index.refresh();
    expect(index.snapshot()).toBe(at);
    expect(watcher.disposed).toBe(true);
  });
});
