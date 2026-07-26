import type {
  AgentDisplayState,
  AuthoritativeTranscriptSource,
  ManagedTranscriptSource,
  TranscriptItem,
  TranscriptListener,
  TranscriptSnapshot,
  TranscriptSource,
} from "./agent-observation.ts";
import {
  transcriptRevision,
  transcriptSequence,
  type TranscriptRevision,
} from "./domain.ts";
import {
  MAX_TRANSCRIPT_SOURCE_BYTES,
  MAX_TRANSCRIPT_SOURCE_ITEMS,
} from "./constants.ts";

/**
 * Combines a durable child-session branch with the root-local live projection for a direct child.
 * Durable segments win only once a later durable user message or explicit end-of-file proof makes
 * them final; until then the live run is the sole representation of that run.
 */
export function createMergedTranscriptSource(
  authoritative: AuthoritativeTranscriptSource,
  live?: TranscriptSource,
): ManagedTranscriptSource {
  const listeners = new Set<TranscriptListener>();
  let revision: TranscriptRevision = transcriptRevision(0);
  let disposed = false;
  let unsubscribeAuthoritative: (() => void) | undefined;
  let unsubscribeLive: (() => void) | undefined;
  let current = buildSnapshot(revision, authoritative, live);

  function rebuild(): void {
    if (disposed) return;
    const next = buildSnapshot(transcriptRevision(Number(revision) + 1), authoritative, live);
    if (sameSnapshot(current, next)) return;
    revision = next.revision;
    current = next;
    for (const listener of [...listeners]) {
      if (!listeners.has(listener)) continue;
      try {
        const result = listener(current);
        if (isThenable(result)) {
          listeners.delete(listener);
          void Promise.resolve(result).catch(() => undefined);
        }
      } catch {
        listeners.delete(listener);
      }
    }
    if (listeners.size === 0) detach();
  }

  function attach(): void {
    if (disposed) return;
    if (unsubscribeAuthoritative === undefined) unsubscribeAuthoritative = authoritative.subscribe(rebuild);
    if (live !== undefined && unsubscribeLive === undefined) unsubscribeLive = live.subscribe(rebuild);
    // Input revisions may have changed while this source was dormant.
    rebuild();
  }

  function detach(): void {
    const releaseAuthoritative = unsubscribeAuthoritative;
    unsubscribeAuthoritative = undefined;
    releaseAuthoritative?.();
    const releaseLive = unsubscribeLive;
    unsubscribeLive = undefined;
    releaseLive?.();
  }

  return {
    snapshot: (): TranscriptSnapshot => {
      // While dormant we own no input subscriptions; sampling here makes the current display
      // state available without inventing a background reader or masking an input read failure.
      if (!disposed && listeners.size === 0) {
        const next = buildSnapshot(transcriptRevision(Number(revision) + 1), authoritative, live);
        if (!sameSnapshot(current, next)) { revision = next.revision; current = next; }
      }
      return current;
    },
    subscribe: (listener: TranscriptListener): (() => void) => {
      if (disposed) return () => {};
      const dormant = listeners.size === 0;
      listeners.add(listener);
      if (dormant) attach();
      return () => {
        if (!listeners.delete(listener)) return;
        if (listeners.size === 0) detach();
      };
    },
    setDisplayState: (state: AgentDisplayState): void => { if (!disposed) authoritative.setDisplayState(state); },
    markRouteUnavailable: (): void => {
      if (disposed) return;
      authoritative.markRouteUnavailable();
      managed(live)?.markRouteUnavailable();
      rebuild();
    },
    dispose: (): void => {
      if (disposed) return;
      disposed = true;
      listeners.clear();
      detach();
      let failure: unknown;
      for (const source of [authoritative, managed(live)]) {
        if (source === undefined) continue;
        try { source.dispose(); } catch (cause) { failure ??= cause; }
      }
      if (failure !== undefined) throw failure;
    },
  };
}

interface RunSegment {
  readonly runId: NonNullable<Extract<TranscriptItem, { readonly kind: "user" }>["runId"]>;
  readonly items: readonly TranscriptItem[];
  readonly final: boolean;
}
type AuthoritativePart =
  | { readonly kind: "leading"; readonly items: readonly TranscriptItem[]; readonly final: boolean }
  | { readonly kind: "run"; readonly segment: RunSegment }
  | { readonly kind: "notice"; readonly item: TranscriptItem };

function buildSnapshot(
  revision: TranscriptRevision,
  authoritative: AuthoritativeTranscriptSource,
  live: TranscriptSource | undefined,
): TranscriptSnapshot {
  const durable = authoritative.snapshot();
  const observed = live?.snapshot();
  const selected: TranscriptItem[] = durable.availability === "unavailable"
    ? [...(observed?.items ?? durable.items)]
    : mergeDurable(durable.items, authoritative.postTerminalEndReached(), observed?.items, live !== undefined);
  const bounded = bound(selected, durable.truncatedBefore || observed?.truncatedBefore === true);
  return freezeSnapshot(revision, bounded.items, bounded.truncatedBefore, availability(durable, observed));
}

function mergeDurable(
  authoritative: readonly TranscriptItem[],
  ended: boolean,
  live: readonly TranscriptItem[] | undefined,
  hasLive: boolean,
): TranscriptItem[] {
  const parts = segmentAuthoritative(authoritative, ended);
  const liveByRun = new Map<string, readonly TranscriptItem[]>();
  let latestLive: readonly TranscriptItem[] | undefined;
  for (const segment of segmentLive(live ?? [])) {
    liveByRun.set(segment.runId, segment.items);
    latestLive = segment.items;
  }
  const result: TranscriptItem[] = [];
  const liveRunEmitted = new Set<string>();
  let liveLeadingEmitted = false;
  for (const part of parts) {
    if (part.kind === "notice") {
      result.push(part.item);
      continue;
    }
    if (part.kind === "leading") {
      if (part.final || !hasLive || latestLive === undefined) result.push(...part.items);
      else if (!liveLeadingEmitted) {
        result.push(...latestLive);
        liveLeadingEmitted = true;
      }
      continue;
    }
    if (part.segment.final || !hasLive) {
      result.push(...part.segment.items);
      continue;
    }
    const replacement = liveByRun.get(part.segment.runId);
    if (replacement !== undefined && !liveRunEmitted.has(part.segment.runId)) {
      result.push(...replacement);
      liveRunEmitted.add(part.segment.runId);
    }
  }
  return result;
}

function segmentAuthoritative(items: readonly TranscriptItem[], ended: boolean): readonly AuthoritativePart[] {
  const parts: AuthoritativePart[] = [];
  let leading: TranscriptItem[] = [];
  let current: TranscriptItem[] | undefined;
  let currentRun: RunSegment["runId"] | undefined;
  const flushLeading = (): void => {
    if (leading.length === 0) return;
    parts.push({ kind: "leading", items: leading, final: false });
    leading = [];
  };
  const flushRun = (): void => {
    if (current === undefined || currentRun === undefined) return;
    parts.push({ kind: "run", segment: { runId: currentRun, items: current, final: false } });
    current = undefined;
  };
  for (const item of items) {
    if (item.kind === "notice") {
      flushLeading();
      // A notice is not conversation content. Flush the preceding run chunk before it, but keep
      // its run identity so post-notice assistant/tool items remain correlated with that user.
      flushRun();
      parts.push({ kind: "notice", item });
      continue;
    }
    if (item.kind === "user") {
      flushLeading();
      flushRun();
      currentRun = item.runId;
      current = [item];
      continue;
    }
    if (currentRun === undefined) leading.push(item);
    else {
      current ??= [];
      current.push(item);
    }
  }
  flushLeading();
  flushRun();

  let laterRun: RunSegment["runId"] | undefined;
  for (let index = parts.length - 1; index >= 0; index -= 1) {
    const part = parts[index]!;
    if (part.kind === "run") {
      parts[index] = { kind: "run", segment: { ...part.segment, final: ended || (laterRun !== undefined && laterRun !== part.segment.runId) } };
      laterRun ??= part.segment.runId;
    } else if (part.kind === "leading") {
      parts[index] = { ...part, final: ended || laterRun !== undefined };
    }
  }
  return parts;
}

function segmentLive(items: readonly TranscriptItem[]): readonly RunSegment[] {
  const segments: RunSegment[] = [];
  let current: TranscriptItem[] | undefined;
  let run: RunSegment["runId"] | undefined;
  for (const item of items) {
    if (item.kind === "user") {
      if (current !== undefined && run !== undefined) segments.push({ runId: run, items: current, final: false });
      run = item.runId;
      current = [item];
    } else if (current !== undefined) {
      current.push(item);
    }
  }
  if (current !== undefined && run !== undefined) segments.push({ runId: run, items: current, final: false });
  return segments;
}

function availability(durable: TranscriptSnapshot, live: TranscriptSnapshot | undefined): TranscriptSnapshot["availability"] {
  if (durable.availability === "unavailable") return live?.availability ?? "unavailable";
  if (live?.availability === "unavailable") return durable.availability;
  return durable.availability;
}

function bound(items: readonly TranscriptItem[], truncatedBefore: boolean): { readonly items: readonly TranscriptItem[]; readonly truncatedBefore: boolean } {
  let first = Math.max(0, items.length - MAX_TRANSCRIPT_SOURCE_ITEMS);
  let bytes = 0;
  for (let index = items.length - 1; index >= first; index -= 1) {
    bytes += new TextEncoder().encode(JSON.stringify(items[index])).byteLength;
    if (bytes > Number(MAX_TRANSCRIPT_SOURCE_BYTES)) { first = index + 1; break; }
  }
  return { items: items.slice(first), truncatedBefore: truncatedBefore || first > 0 };
}

function freezeSnapshot(
  revision: TranscriptRevision,
  items: readonly TranscriptItem[],
  truncatedBefore: boolean,
  availability: TranscriptSnapshot["availability"],
): TranscriptSnapshot {
  return Object.freeze({
    revision,
    items: Object.freeze(items.map((item, index) => Object.freeze({ ...item, sequence: transcriptSequence(index) }) as TranscriptItem)),
    truncatedBefore,
    availability,
  });
}

function sameSnapshot(left: TranscriptSnapshot, right: TranscriptSnapshot): boolean {
  return left.availability === right.availability
    && left.truncatedBefore === right.truncatedBefore
    && sameItems(left.items, right.items);
}

function sameItems(left: readonly TranscriptItem[], right: readonly TranscriptItem[]): boolean {
  return left.length === right.length && left.every((item, index) => JSON.stringify(item) === JSON.stringify(right[index]));
}

function managed(source: TranscriptSource | undefined): ManagedTranscriptSource | undefined {
  return source !== undefined && "setDisplayState" in source && "markRouteUnavailable" in source && "dispose" in source
    ? source as ManagedTranscriptSource
    : undefined;
}

function isThenable(value: unknown): boolean {
  return typeof value === "object" && value !== null && typeof (value as { readonly then?: unknown }).then === "function";
}
