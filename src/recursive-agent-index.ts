import { MAX_WIDGET_ROWS } from "./constants.ts";
import type {
  AgentDisplayState,
  AgentRow,
  AgentWidgetSnapshot,
  SubagentObservationPort,
} from "./agent-observation.ts";
import {
  AgentState,
  CompletionState,
  agentCount,
  agentDepth,
  agentWidgetRevision,
  tryAgentOrdinal,
  type AbsolutePath,
  type AgentCount,
  type AgentDepth,
  type AgentId,
  type AgentOrdinal,
} from "./domain.ts";
import {
  readKnownChildSnapshots,
  type KnownChildSnapshots,
  type ObservationSnapshot,
} from "./observation-snapshot-path.ts";
import type { SnapshotWatcher } from "./snapshot-watcher.ts";

export const MAX_WALK_DEPTH: AgentDepth = agentDepth(8);

export interface RecursiveAgentIndex {
  setWatcher(watcher: SnapshotWatcher): void;
  refresh(): void;
  snapshot(): AgentWidgetSnapshot;
  ownerOf(ordinal: AgentOrdinal): AgentId | undefined;
  dispose(): void;
}

export interface RecursiveAgentIndexDependencies {
  readonly agentDir: AbsolutePath;
  readonly maxRows: AgentCount;
  readonly readKnownChildSnapshots?: (
    agentDir: AbsolutePath,
    knownChildSessionIds: readonly AgentId[],
  ) => KnownChildSnapshots;
  readonly onChange: () => void;
  readonly onDiagnostic?: (code: "projection-failed") => void;
}

export function createRecursiveAgentIndex(
  port: SubagentObservationPort,
  dependencies: RecursiveAgentIndexDependencies,
): RecursiveAgentIndex {
  return new ManagedRecursiveAgentIndex(port, dependencies);
}

interface AdmittedNode {
  readonly sessionId: AgentId;
  readonly row: AgentRow;
  readonly children: AdmittedNode[];
}

interface RetainedSlot {
  readonly snapshot: ObservationSnapshot;
}

class ManagedRecursiveAgentIndex implements RecursiveAgentIndex {
  private readonly readSlots: NonNullable<RecursiveAgentIndexDependencies["readKnownChildSnapshots"]>;
  private retained = new Map<AgentId, RetainedSlot>();
  private owners = new Map<AgentOrdinal, AgentId>();
  private watcher: SnapshotWatcher | undefined;
  private revision = 0;
  private projectionFailureReported = false;
  private disposed = false;
  private current: AgentWidgetSnapshot = {
    revision: agentWidgetRevision(0),
    rows: [],
    total: agentCount(0),
    omitted: agentCount(0),
    degraded: true,
  };

  constructor(
    private readonly port: SubagentObservationPort,
    private readonly dependencies: RecursiveAgentIndexDependencies,
  ) {
    this.readSlots = dependencies.readKnownChildSnapshots ?? readKnownChildSnapshots;
  }

  setWatcher(watcher: SnapshotWatcher): void {
    if (this.disposed) {
      this.disposeWatcher(watcher);
      return;
    }
    if (this.watcher !== undefined && this.watcher !== watcher) this.disposeWatcher(this.watcher);
    this.watcher = watcher;
  }

  refresh(): void {
    if (this.disposed) return;
    this.revision += 1;

    let direct;
    try {
      direct = this.port.directSnapshot();
    } catch {
      this.reportProjectionFailure();
      this.retainRootsAsDegraded();
      this.notifyChange();
      return;
    }
    if (direct.kind === "unavailable") {
      this.retainRootsAsDegraded();
      this.notifyChange();
      return;
    }

    const roots: AdmittedNode[] = [];
    const activeQueue: AdmittedNode[] = [];
    const tracked: AgentId[] = [];
    const seen = new Set<AgentId>();
    const nextOwners = new Map<AgentOrdinal, AgentId>();
    const nextRetained = new Map<AgentId, RetainedSlot>();
    const maximumRows = Math.min(Number(this.dependencies.maxRows), Number(MAX_WIDGET_ROWS));
    let admittedCount = 0;
    let total = Number(direct.total);
    let degraded = direct.health.kind === "degraded" || Number(direct.omittedActive) > 0;

    for (const entry of direct.entries) {
      if (admittedCount >= maximumRows) {
        degraded = true;
        continue;
      }
      if (seen.has(entry.agentId)) {
        degraded = true;
        continue;
      }
      const node: AdmittedNode = { sessionId: entry.agentId, row: entry.row, children: [] };
      roots.push(node);
      seen.add(entry.agentId);
      admittedCount += 1;
      if (!nextOwners.has(entry.row.ordinal)) nextOwners.set(entry.row.ordinal, entry.agentId);
      if (!isTerminal(entry.row.state)) {
        activeQueue.push(node);
        tracked.push(entry.agentId);
      }
    }

    let levelStart = 0;
    while (levelStart < activeQueue.length) {
      if (admittedCount >= maximumRows) {
        degraded = true;
        break;
      }
      const levelEnd = activeQueue.length;
      for (let cursor = levelStart; cursor < levelEnd; cursor += 1) {
        const parent = activeQueue[cursor]!;
        let result: KnownChildSnapshots;
        try {
          result = this.readSlots(this.dependencies.agentDir, [parent.sessionId]);
        } catch {
          degraded = true;
          continue;
        }
        const incoming = result.snapshots.get(parent.sessionId);
        if (incoming === undefined) {
          degraded = true;
          continue;
        }

        const retained = this.retained.get(parent.sessionId);
        let selected = incoming;
        if (retained !== undefined && retained.snapshot.incarnation === incoming.incarnation &&
            Number(incoming.revision) < Number(retained.snapshot.revision)) {
          selected = retained.snapshot;
          degraded = true;
        }
        nextRetained.set(parent.sessionId, { snapshot: selected });
        if (selected.degraded) degraded = true;
        const addition = saturatingAdd(total, Number(selected.total));
        total = addition.value;
        if (addition.saturated) degraded = true;

        for (const child of selected.agents) {
          const depth = Number(parent.row.depth) + 1;
          if (depth >= Number(MAX_WALK_DEPTH) || admittedCount >= maximumRows || seen.has(child.sessionId)) {
            degraded = true;
            continue;
          }
          const ordinal = composeOrdinal(parent.row.ordinal, child.ordinal);
          if (ordinal === undefined) {
            degraded = true;
            continue;
          }
          const node: AdmittedNode = {
            sessionId: child.sessionId,
            row: {
              ordinal,
              depth: agentDepth(depth),
              model: child.model,
              context: child.context,
              taskLabel: child.taskLabel,
              state: child.state,
            },
            children: [],
          };
          parent.children.push(node);
          seen.add(child.sessionId);
          admittedCount += 1;
          if (!isTerminal(child.state)) {
            activeQueue.push(node);
            tracked.push(child.sessionId);
          }
        }
      }
      if (admittedCount >= maximumRows && activeQueue.length > levelEnd) {
        degraded = true;
        break;
      }
      levelStart = levelEnd;
    }

    const rows: AgentRow[] = [];
    for (const root of roots) emitPreOrder(root, rows);
    if (total < rows.length) {
      total = rows.length;
      degraded = true;
    }
    const omitted = agentCount(total - rows.length);
    this.retained = nextRetained;
    this.owners = nextOwners;
    try {
      this.watcher?.track(tracked);
    } catch {
      degraded = true;
    }
    this.current = {
      revision: agentWidgetRevision(this.revision),
      rows,
      total: agentCount(total),
      omitted,
      degraded,
    };
    this.notifyChange();
  }

  snapshot(): AgentWidgetSnapshot {
    return this.current;
  }

  ownerOf(ordinal: AgentOrdinal): AgentId | undefined {
    return this.owners.get(ordinal);
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.retained.clear();
    this.owners.clear();
    const watcher = this.watcher;
    this.watcher = undefined;
    if (watcher !== undefined) this.disposeWatcher(watcher);
  }

  private retainRootsAsDegraded(): void {
    this.current = {
      ...this.current,
      revision: agentWidgetRevision(this.revision),
      degraded: true,
    };
  }

  private reportProjectionFailure(): void {
    if (this.projectionFailureReported) return;
    this.projectionFailureReported = true;
    try {
      this.dependencies.onDiagnostic?.("projection-failed");
    } catch {
      // Diagnostics cannot break observation projection.
    }
  }

  private notifyChange(): void {
    try {
      this.dependencies.onChange();
    } catch {
      // The owner callback is an isolation boundary.
    }
  }

  private disposeWatcher(watcher: SnapshotWatcher): void {
    try {
      watcher.dispose();
    } catch {
      // Watch ownership ends even if the adapter rejects disposal.
    }
  }
}

function isTerminal(state: AgentDisplayState): boolean {
  switch (state) {
    case AgentState.Running:
    case AgentState.Settling:
    case AgentState.Stopping:
      return false;
    case AgentState.Stopped:
    case CompletionState.Completed:
    case CompletionState.Failed:
    case CompletionState.Cancelled:
      return true;
    default: {
      const exhaustive: never = state;
      return exhaustive;
    }
  }
}

function composeOrdinal(parent: AgentOrdinal, local: AgentOrdinal): AgentOrdinal | undefined {
  return tryAgentOrdinal(`${parent}.${local.slice(1)}`);
}

function emitPreOrder(node: AdmittedNode, rows: AgentRow[]): void {
  rows.push(node.row);
  for (const child of node.children) emitPreOrder(child, rows);
}

function saturatingAdd(left: number, right: number): { readonly value: number; readonly saturated: boolean } {
  if (right > Number.MAX_SAFE_INTEGER - left) {
    return { value: Number.MAX_SAFE_INTEGER, saturated: true };
  }
  return { value: left + right, saturated: false };
}
