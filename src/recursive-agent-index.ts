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
  type TranscriptFileName,
  type TranscriptRoute,
} from "./domain.ts";
import {
  readKnownChildSnapshots,
  type KnownChildSnapshots,
  type ObservationRow,
  type ObservationSnapshot,
  type SnapshotSkipReason,
} from "./observation-snapshot-path.ts";
import type { SnapshotWatcher } from "./snapshot-watcher.ts";

export const MAX_WALK_DEPTH: AgentDepth = agentDepth(8);

export interface RecursiveAgentIndex {
  setWatcher(watcher: SnapshotWatcher): void;
  refresh(): void;
  snapshot(): AgentWidgetSnapshot;
  transcriptRoute(ordinal: AgentOrdinal): TranscriptRoute | undefined;
  dispose(): void;
}

export interface RecursiveAgentIndexDependencies {
  readonly agentDir: AbsolutePath;
  /** Identity of the session owning the direct rows; never inferred from a composed ordinal. */
  readonly rootSessionId: AgentId;
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

interface TraversalCandidate {
  readonly owner: AgentId;
  /** Session whose partition holds this candidate's transcript: the root, or the publishing parent. */
  readonly ownerSessionId: AgentId;
  readonly parent: AdmittedNode | undefined;
  readonly node: AdmittedNode;
  readonly localOrdinal: AgentOrdinal;
  readonly ownerState: AgentDisplayState;
  readonly transcriptFile: TranscriptFileName | undefined;
}

class ManagedRecursiveAgentIndex implements RecursiveAgentIndex {
  private readonly readSlots: NonNullable<RecursiveAgentIndexDependencies["readKnownChildSnapshots"]>;
  private retained = new Map<AgentId, RetainedSlot>();
  private routes = new Map<AgentOrdinal, TranscriptRoute>();
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
    const ownerQueue: AdmittedNode[] = [];
    const tracked = new Set<AgentId>();
    const seen = new Set<AgentId>();
    const nextRoutes = new Map<AgentOrdinal, TranscriptRoute>();
    const nextRetained = new Map<AgentId, RetainedSlot>();
    const maximumRows = Math.min(Number(this.dependencies.maxRows), Number(MAX_WIDGET_ROWS));
    let admittedCount = 0;
    let total = Number(direct.total);
    let degraded = direct.health.kind === "degraded" || Number(direct.omittedActive) > 0;

    const directCandidates: TraversalCandidate[] = [];
    for (const entry of direct.entries) {
      directCandidates.push({
        owner: entry.agentId,
        ownerSessionId: this.dependencies.rootSessionId,
        parent: undefined,
        node: { sessionId: entry.agentId, row: entry.row, children: [] },
        localOrdinal: entry.row.ordinal,
        ownerState: entry.row.state,
        transcriptFile: entry.transcriptFile,
      });
    }
    const directAdmission = selectLevelCandidates(directCandidates, maximumRows - admittedCount);
    if (directAdmission.rejected) degraded = true;
    admittedCount += admitCandidates(
      directAdmission.candidates,
      roots,
      ownerQueue,
      seen,
      tracked,
      nextRoutes,
    );

    let levelStart = 0;
    while (levelStart < ownerQueue.length) {
      if (admittedCount >= maximumRows) {
        preserveRetainedUnprocessedOwners(this.retained, nextRetained, ownerQueue, levelStart);
        degraded = true;
        break;
      }
      const levelEnd = ownerQueue.length;
      const candidates: TraversalCandidate[] = [];
      for (let cursor = levelStart; cursor < levelEnd; cursor += 1) {
        const parent = ownerQueue[cursor]!;
        let result: KnownChildSnapshots;
        try {
          result = this.readSlots(this.dependencies.agentDir, [parent.sessionId]);
        } catch {
          degraded = true;
          continue;
        }
        const incoming = result.snapshots.get(parent.sessionId);
        const terminal = isTerminal(parent.row.state);
        const retained = this.retained.get(parent.sessionId);
        let selected: ObservationSnapshot | undefined;
        if (incoming !== undefined) {
          selected = incoming;
          if (retained !== undefined && retained.snapshot.incarnation === incoming.incarnation &&
              Number(incoming.revision) < Number(retained.snapshot.revision)) {
            selected = retained.snapshot;
            degraded = true;
          }
          nextRetained.set(parent.sessionId, { snapshot: selected });
          if (terminal) tracked.add(parent.sessionId);
        } else if (terminal) {
          const reason = result.skipped.get(parent.sessionId);
          if (reason === "missing-directory") continue;
          selected = retained?.snapshot;
          if (reason === undefined || reason !== "missing-file" || selected !== undefined) degraded = true;
          if (selected !== undefined) nextRetained.set(parent.sessionId, { snapshot: selected });
          if (reason !== undefined && !isUnsafeSkip(reason) && isReplaceableTerminalSkip(reason)) {
            tracked.add(parent.sessionId);
          }
        } else {
          degraded = true;
          continue;
        }
        if (selected === undefined) continue;
        if (selected.degraded) degraded = true;
        const addition = saturatingAdd(total, Number(selected.total));
        total = addition.value;
        if (addition.saturated) degraded = true;

        for (const child of selected.agents) {
          if (terminal && !isTerminal(child.state)) degraded = true;
          const candidate = childCandidate(parent, selected.sessionId, child, seen);
          if (candidate === undefined) {
            degraded = true;
            continue;
          }
          candidates.push(candidate);
        }
      }
      const admission = selectLevelCandidates(candidates, maximumRows - admittedCount);
      if (admission.rejected) degraded = true;
      admittedCount += admitCandidates(
        admission.candidates,
        roots,
        ownerQueue,
        seen,
        tracked,
        nextRoutes,
      );
      if (admittedCount >= maximumRows && ownerQueue.length > levelEnd) {
        preserveRetainedUnprocessedOwners(this.retained, nextRetained, ownerQueue, levelEnd);
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
    this.routes = nextRoutes;
    try {
      this.watcher?.track([...tracked]);
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

  transcriptRoute(ordinal: AgentOrdinal): TranscriptRoute | undefined {
    return this.routes.get(ordinal);
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.retained.clear();
    this.routes.clear();
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

function preserveRetainedUnprocessedOwners(
  retained: ReadonlyMap<AgentId, RetainedSlot>,
  nextRetained: Map<AgentId, RetainedSlot>,
  ownerQueue: readonly AdmittedNode[],
  firstUnprocessed: number,
): void {
  for (let cursor = firstUnprocessed; cursor < ownerQueue.length; cursor += 1) {
    const owner = ownerQueue[cursor]!.sessionId;
    const previous = retained.get(owner);
    if (previous !== undefined) nextRetained.set(owner, previous);
  }
}

function admitCandidates(
  candidates: readonly TraversalCandidate[],
  roots: AdmittedNode[],
  ownerQueue: AdmittedNode[],
  seen: Set<AgentId>,
  tracked: Set<AgentId>,
  nextRoutes: Map<AgentOrdinal, TranscriptRoute>,
): number {
  for (const candidate of candidates) {
    seen.add(candidate.owner);
    ownerQueue.push(candidate.node);
    if (!isTerminal(candidate.ownerState)) tracked.add(candidate.owner);
  }
  for (const candidate of [...candidates].sort(compareCandidatesByLocalOrdinal)) {
    if (candidate.parent === undefined) roots.push(candidate.node);
    else candidate.parent.children.push(candidate.node);
    const route = candidate.transcriptFile === undefined ? undefined : Object.freeze({
      ownerSessionId: candidate.ownerSessionId,
      childSessionId: candidate.node.sessionId,
      fileName: candidate.transcriptFile,
      direct: candidate.parent === undefined,
    });
    if (route !== undefined && !nextRoutes.has(candidate.node.row.ordinal)) {
      nextRoutes.set(candidate.node.row.ordinal, route);
    }
  }
  return candidates.length;
}

function childCandidate(
  parent: AdmittedNode,
  ownerSessionId: AgentId,
  child: ObservationRow,
  seen: ReadonlySet<AgentId>,
): TraversalCandidate | undefined {
  const depth = Number(parent.row.depth) + 1;
  if (depth >= Number(MAX_WALK_DEPTH) || seen.has(child.sessionId)) return undefined;
  const ordinal = composeOrdinal(parent.row.ordinal, child.ordinal);
  if (ordinal === undefined) return undefined;
  return {
    owner: child.sessionId,
    ownerSessionId,
    parent,
    node: {
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
    },
    localOrdinal: child.ordinal,
    ownerState: child.state,
    transcriptFile: child.transcriptFile,
  };
}

function selectLevelCandidates(
  candidates: readonly TraversalCandidate[],
  remainingRows: number,
): { readonly candidates: readonly TraversalCandidate[]; readonly rejected: boolean } {
  const active = candidates.filter((candidate) => !isTerminal(candidate.ownerState));
  const terminal = candidates
    .filter((candidate) => isTerminal(candidate.ownerState))
    .sort((left, right) => compareLocalOrdinals(right.localOrdinal, left.localOrdinal));
  const admitted: TraversalCandidate[] = [];
  const admittedOwners = new Set<AgentId>();
  let rejected = false;
  for (const candidate of [...active, ...terminal]) {
    if (admitted.length >= remainingRows || admittedOwners.has(candidate.owner)) {
      rejected = true;
      continue;
    }
    admittedOwners.add(candidate.owner);
    admitted.push(candidate);
  }
  return { candidates: admitted, rejected };
}

function compareCandidatesByLocalOrdinal(left: TraversalCandidate, right: TraversalCandidate): number {
  return compareLocalOrdinals(left.localOrdinal, right.localOrdinal);
}

function compareLocalOrdinals(left: AgentOrdinal, right: AgentOrdinal): number {
  const leftDigits = left.slice(1);
  const rightDigits = right.slice(1);
  if (leftDigits.length !== rightDigits.length) return leftDigits.length - rightDigits.length;
  return leftDigits < rightDigits ? -1 : leftDigits > rightDigits ? 1 : 0;
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
  }
}

function isUnsafeSkip(reason: SnapshotSkipReason): boolean {
  switch (reason) {
    case "invalid-session-id":
    case "escapes-managed-root":
      return true;
    case "missing-directory":
    case "missing-file":
    case "not-a-regular-file":
    case "unreadable":
    case "oversized":
    case "malformed":
    case "session-id-mismatch":
      return false;
  }
}

function isReplaceableTerminalSkip(reason: SnapshotSkipReason): boolean {
  switch (reason) {
    case "missing-file":
    case "not-a-regular-file":
    case "unreadable":
    case "oversized":
    case "malformed":
    case "session-id-mismatch":
      return true;
    case "invalid-session-id":
    case "missing-directory":
    case "escapes-managed-root":
      return false;
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
