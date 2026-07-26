import type {
  AgentWidgetSnapshot,
  AgentWidgetSource,
  ManagedSelectedTranscriptSource,
  SelectedTranscriptSource,
  SubagentObservationPort,
} from "../agent-observation.ts";
import { createCoalescer } from "../coalescer.ts";
import {
  INDEX_REFRESH_WINDOW_MS,
  MAX_WATCH_RETRY_INTERVAL_MS,
  WATCH_FALLBACK_INTERVAL_MS,
} from "../constants.ts";
import type { AgentCount, AgentId, AgentOrdinal, AbsolutePath } from "../domain.ts";
import { createRecursiveAgentIndex } from "../recursive-agent-index.ts";
import {
  createNodeTranscriptFileSystem,
  createNodeTranscriptFileWatcherFactory,
  createNodeTranscriptRefreshClock,
  createSessionTranscriptSource,
  type TranscriptFileSystem,
  type TranscriptFileWatcherFactory,
  type TranscriptRefreshClock,
} from "../session-transcript-source.ts";
import { createSnapshotWatcher } from "../snapshot-watcher.ts";
import { createSelectedTranscriptSource } from "./conversation-source.ts";

export interface AgentWidgetSourceDeps {
  readonly agentDir: AbsolutePath;
  /** Identity of the session owning the direct rows, injected by the aggregator. */
  readonly rootSessionId: AgentId;
  readonly maxRows: AgentCount;
  /** Receives bounded index and watcher diagnostic codes; the adapters are contained. */
  readonly onDiagnostic?: (code: string) => void;
  /** Transcript acquisition seams; production adapters are used when they are not injected. */
  readonly transcriptFileSystem?: TranscriptFileSystem;
  readonly transcriptWatcher?: TranscriptFileWatcherFactory;
  readonly transcriptClock?: TranscriptRefreshClock;
}

/**
 * Owns the root widget's recursive projection. Direct observation changes and descendant-slot
 * watcher signals share the index refresh coalescer; the initial projection is synchronous.
 */
export function createAgentWidgetSource(
  port: SubagentObservationPort,
  deps: AgentWidgetSourceDeps,
): AgentWidgetSource & { dispose(): void } {
  const listeners = new Set<() => void>();
  let current: AgentWidgetSnapshot;

  const index = createRecursiveAgentIndex(port, {
    agentDir: deps.agentDir,
    rootSessionId: deps.rootSessionId,
    maxRows: deps.maxRows,
    onChange: () => {
      current = index.snapshot();
      updateSelection();
      for (const listener of [...listeners]) {
        if (!listeners.has(listener)) continue;
        try {
          listener();
        } catch {
          // A projection subscriber cannot prevent later source revisions.
          listeners.delete(listener);
        }
      }
    },
    ...(deps.onDiagnostic === undefined ? {} : { onDiagnostic: deps.onDiagnostic }),
  });
  current = index.snapshot();
  let selected: { readonly ordinal: AgentOrdinal; readonly source: ManagedSelectedTranscriptSource } | undefined;

  /** Re-binds the open conversation to the freshly projected rows, if one is open. */
  function updateSelection(): void {
    const open = selected;
    if (open === undefined) return;
    const route = index.transcriptRoute(open.ordinal);
    const row = current.rows.find((candidate) => candidate.ordinal === open.ordinal);
    open.source.update(route === undefined || row === undefined ? undefined : { route, row });
  }

  const coalescer = createCoalescer(() => index.refresh(), undefined, INDEX_REFRESH_WINDOW_MS);
  const watcher = createSnapshotWatcher({
    agentDir: deps.agentDir,
    onChange: coalescer.request,
    retryInterval: WATCH_FALLBACK_INTERVAL_MS,
    maxRetryInterval: MAX_WATCH_RETRY_INTERVAL_MS,
    onDiagnostic: deps.onDiagnostic ?? (() => {}),
  });
  index.setWatcher(watcher);
  let unsubscribePort: (() => void) | undefined = port.subscribe(coalescer.request);
  index.refresh();

  return {
    snapshot: (): AgentWidgetSnapshot => current,
    transcriptSource: (ordinal: AgentOrdinal): SelectedTranscriptSource | undefined => {
      if (selected?.ordinal === ordinal) return selected.source;
      // The authoritative reader resolves any routed ordinal, direct or nested: the route names
      // the owning session's partition, which this session can traverse for itself.
      const selectedRoute = index.transcriptRoute(ordinal);
      const selectedRow = current.rows.find((row) => row.ordinal === ordinal);
      if (selectedRoute === undefined || selectedRow === undefined) return undefined;
      selected?.source.dispose();
      const source = createSelectedTranscriptSource(
        ordinal,
        selectedRoute,
        selectedRow,
        createSessionTranscriptSource(selectedRoute, {
          agentDir: deps.agentDir,
          onDiagnostic: deps.onDiagnostic ?? (() => {}),
          filesystem: deps.transcriptFileSystem ?? createNodeTranscriptFileSystem(),
          watcher: deps.transcriptWatcher ?? createNodeTranscriptFileWatcherFactory(),
          clock: deps.transcriptClock ?? createNodeTranscriptRefreshClock(),
        }),
      );
      selected = { ordinal, source };
      return source;
    },
    subscribe: (onChange: () => void): (() => void) => {
      listeners.add(onChange);
      return () => { listeners.delete(onChange); };
    },
    dispose: (): void => {
      listeners.clear();
      let failure: Error | undefined;
      const contain = (operation: () => void): void => {
        try {
          operation();
        } catch (error) {
          failure ??= error instanceof Error ? error : new Error(String(error), { cause: error });
        }
      };
      const openSelection = selected;
      selected = undefined;
      if (openSelection !== undefined) contain(() => { openSelection.source.dispose(); });
      const pendingPortUnsubscribe = unsubscribePort;
      if (pendingPortUnsubscribe !== undefined) {
        contain(() => {
          pendingPortUnsubscribe();
          if (unsubscribePort === pendingPortUnsubscribe) unsubscribePort = undefined;
        });
      }
      contain(() => watcher.dispose());
      contain(() => coalescer.dispose());
      contain(() => index.dispose());
      if (failure !== undefined) throw failure;
    },
  };
}
