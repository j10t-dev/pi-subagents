import type {
  AgentRow,
  AgentWidgetSnapshot,
  DirectAgentSnapshotResult,
  AgentWidgetSource,
  SubagentObservationPort,
  TranscriptSource,
} from "../agent-observation.ts";
import {
  agentCount,
  agentWidgetRevision,
  type AbsolutePath,
  type AgentCount,
  type AgentId,
  type AgentOrdinal,
} from "../domain.ts";

export interface AgentWidgetSourceDeps {
  /** Unused by the direct source; taken so recursive-relay replaces the body without touching wiring. */
  readonly agentDir: AbsolutePath;
  readonly maxRows: AgentCount;
  /** Receives a bounded code once when direct projection fails; the adapter is contained. */
  readonly onDiagnostic?: (code: string) => void;
}

/**
 * Direct-pass-through `AgentWidgetSource` over B1's bounded direct snapshot. Reads no filesystem
 * slots, discovers nothing, and knows no descendants: every row is a direct child at depth 0 with
 * B1's ordinal verbatim. recursive-relay replaces this body behind the same signature.
 */
export function createAgentWidgetSource(
  port: SubagentObservationPort,
  deps: AgentWidgetSourceDeps,
): AgentWidgetSource & { dispose(): void } {
  const listeners = new Set<() => void>();
  const limit = Number(deps.maxRows);
  let owners = new Map<AgentOrdinal, AgentId>();
  let revision = 0;
  let scheduled = false;
  let disposed = false;
  let portUnsubscribed = false;
  let projectionFailureReported = false;
  let current: AgentWidgetSnapshot = {
    revision: agentWidgetRevision(0),
    rows: [],
    total: agentCount(0),
    omitted: agentCount(0),
    degraded: true,
  };

  const reportProjectionFailure = (): void => {
    if (projectionFailureReported) return;
    projectionFailureReported = true;
    try { deps.onDiagnostic?.("projection-failed"); } catch { /* diagnostic adapter boundary */ }
  };

  const project = (): AgentWidgetSnapshot => {
    let result: DirectAgentSnapshotResult;
    try {
      result = port.directSnapshot();
    } catch {
      reportProjectionFailure();
      return { ...current, revision: agentWidgetRevision(revision), degraded: true };
    }
    if (result.kind === "unavailable") {
      // A disposed store or a lost transport is not a statement that the children are gone.
      // Retain the last good rows and report incompleteness rather than asserting an empty tree.
      return { ...current, revision: agentWidgetRevision(revision), degraded: true };
    }
    const rows: AgentRow[] = [];
    const nextOwners = new Map<AgentOrdinal, AgentId>();
    for (const entry of result.entries) {
      if (rows.length >= limit) break;
      rows.push(entry.row);
      // The model retains the first row for a duplicate ordinal, so transcript correlation must
      // retain that same row's owner rather than silently following a later duplicate.
      if (!nextOwners.has(entry.row.ordinal)) nextOwners.set(entry.row.ordinal, entry.agentId);
    }
    owners = nextOwners;
    return {
      revision: agentWidgetRevision(revision),
      rows,
      total: result.total,
      omitted: agentCount(Math.max(0, Number(result.total) - rows.length)),
      degraded: true,
    };
  };

  const refresh = (): void => {
    if (disposed) return;
    revision += 1;
    current = project();
    for (const listener of [...listeners]) {
      if (!listeners.has(listener)) continue;
      try {
        listener();
      } catch {
        // A queued source refresh is an isolation boundary. Remove a throwing subscriber so it
        // cannot escape another microtask or block healthy subscribers on later revisions.
        listeners.delete(listener);
      }
    }
  };

  const unsubscribePort = port.subscribe(() => {
    if (disposed || scheduled) return;
    scheduled = true;
    queueMicrotask(() => {
      scheduled = false;
      refresh();
    });
  });

  refresh();

  return {
    snapshot: (): AgentWidgetSnapshot => current,
    transcriptSource: (ordinal: AgentOrdinal): TranscriptSource | undefined => {
      const owner = owners.get(ordinal);
      return owner === undefined ? undefined : port.transcriptSource(owner);
    },
    subscribe: (onChange: () => void): (() => void) => {
      listeners.add(onChange);
      return () => { listeners.delete(onChange); };
    },
    dispose: (): void => {
      disposed = true;
      listeners.clear();
      if (portUnsubscribed) return;
      unsubscribePort();
      portUnsubscribed = true;
    },
  };
}
