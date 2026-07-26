import type {
  AgentRow,
  ManagedSelectedTranscriptSource,
  ManagedTranscriptSource,
  SelectedTranscriptSnapshot,
  TranscriptSnapshot,
} from "../agent-observation.ts";
import {
  selectedTranscriptRevision,
  type AgentOrdinal,
  type TranscriptRoute,
} from "../domain.ts";

/**
 * Binds one selected agent row to the transcript it was opened against.
 *
 * The selection is pinned to the exact route captured at open time. An ordinal can be reused by a
 * later agent, so a changed route is treated as the loss of the selected conversation rather than
 * a switch: the last known row and transcript stay visible and the view is marked unavailable.
 */
export function createSelectedTranscriptSource(
  ordinal: AgentOrdinal,
  route: TranscriptRoute,
  row: AgentRow,
  transcript: ManagedTranscriptSource,
): ManagedSelectedTranscriptSource {
  const listeners = new Set<(snapshot: SelectedTranscriptSnapshot) => void>();
  let disposed = false;
  const initialTranscript = transcript.snapshot();
  let revision = Number(initialTranscript.revision) === 0 ? 0 : 1;
  let currentRow = row;
  let routeAvailable = true;
  let unsubscribe: (() => void) | undefined;
  let published: SelectedTranscriptSnapshot = frozen(revision, initialTranscript, currentRow, true);

  transcript.setDisplayState(row.state);

  function republish(next: TranscriptSnapshot): void {
    if (disposed) return;
    if (next === published.transcript
      && currentRow === published.row
      && routeAvailable === published.routeAvailable) return;
    revision += 1;
    published = frozen(revision, next, currentRow, routeAvailable);
    for (const listener of [...listeners]) {
      if (!listeners.has(listener)) continue;
      try {
        const result: unknown = listener(published);
        if (isThenable(result)) {
          listeners.delete(listener);
          void Promise.resolve(result).catch(() => undefined);
        }
      } catch {
        listeners.delete(listener);
      }
    }
  }

  function loseRoute(): void {
    if (!routeAvailable) return;
    routeAvailable = false;
    transcript.markRouteUnavailable();
    republish(transcript.snapshot());
  }

  return {
    snapshot: (): SelectedTranscriptSnapshot => published,

    subscribe: (listener) => {
      if (disposed) return () => {};
      const wasDormant = listeners.size === 0;
      listeners.add(listener);
      if (wasDormant) {
        unsubscribe = transcript.subscribe((next) => { republish(next) });
        // A change published while dormant is only observable now, so adopt it on attachment.
        republish(transcript.snapshot());
      }
      return () => {
        if (!listeners.delete(listener)) return;
        if (listeners.size > 0) return;
        unsubscribe?.();
        unsubscribe = undefined;
      };
    },

    update: (current): void => {
      if (disposed) return;
      if (current === undefined
        || current.row.ordinal !== ordinal
        || !sameRoute(current.route, route)) {
        loseRoute();
        return;
      }
      currentRow = current.row;
      transcript.setDisplayState(current.row.state);
      republish(transcript.snapshot());
    },

    dispose: (): void => {
      if (disposed) return;
      disposed = true;
      listeners.clear();
      unsubscribe?.();
      unsubscribe = undefined;
      transcript.dispose();
    },
  };
}

function isThenable(value: unknown): boolean {
  return typeof value === "object" && value !== null
    && typeof (value as { readonly then?: unknown }).then === "function";
}

function sameRoute(left: TranscriptRoute, right: TranscriptRoute): boolean {
  return left.ownerSessionId === right.ownerSessionId
    && left.childSessionId === right.childSessionId
    && left.fileName === right.fileName
    && left.direct === right.direct;
}

function frozen(
  revision: number,
  transcript: TranscriptSnapshot,
  row: AgentRow,
  routeAvailable: boolean,
): SelectedTranscriptSnapshot {
  return Object.freeze({
    revision: selectedTranscriptRevision(revision),
    transcript,
    row,
    routeAvailable,
  });
}
