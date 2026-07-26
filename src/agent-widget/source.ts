import type {
  AgentWidgetSnapshot,
  AgentWidgetSource,
  SubagentObservationPort,
  TranscriptSource,
} from "../agent-observation.ts";
import { createCoalescer } from "../coalescer.ts";
import {
  INDEX_REFRESH_WINDOW_MS,
  MAX_WATCH_RETRY_INTERVAL_MS,
  WATCH_FALLBACK_INTERVAL_MS,
} from "../constants.ts";
import type { AgentCount, AgentId, AgentOrdinal, AbsolutePath } from "../domain.ts";
import { createRecursiveAgentIndex } from "../recursive-agent-index.ts";
import { createSnapshotWatcher } from "../snapshot-watcher.ts";

export interface AgentWidgetSourceDeps {
  readonly agentDir: AbsolutePath;
  /** Identity of the session owning the direct rows, injected by the aggregator. */
  readonly rootSessionId: AgentId;
  readonly maxRows: AgentCount;
  /** Receives bounded index and watcher diagnostic codes; the adapters are contained. */
  readonly onDiagnostic?: (code: string) => void;
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
    transcriptSource: (ordinal: AgentOrdinal): TranscriptSource | undefined => {
      // Only a direct child's transcript is served by the local observation port; a nested route
      // names a descendant this session does not observe.
      const route = index.transcriptRoute(ordinal);
      return route === undefined || !route.direct ? undefined : port.transcriptSource(route.childSessionId);
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
