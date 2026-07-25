import { watch } from "node:fs";

import { MAX_WATCH_RETRY_INTERVAL_MS, WATCH_FALLBACK_INTERVAL_MS } from "./constants.ts";
import type { AbsolutePath, AgentId, Milliseconds } from "./domain.ts";
import { observationSlotDirectory } from "./observation-snapshot-path.ts";
import { WidgetDiagnosticCode, type WidgetDiagnosticCode as WidgetDiagnosticCodeValue } from "./widget-diagnostics.ts";

/** Signals changes to observation slots supplied by the recursive index; it owns no lifecycle state. */
export interface SnapshotWatcher {
  track(sessionIds: readonly AgentId[]): void;
  dispose(): void;
}

/** Minimal watch handle boundary, deliberately limited to the events this projection consumes. */
export interface SnapshotWatchHandle {
  close(): void;
  on(event: "change" | "error" | "close", listener: () => void): void;
}

/** Typed watch seam; production delegates directly to `node:fs.watch`. */
export interface SnapshotWatchFactory {
  watch(directory: AbsolutePath): SnapshotWatchHandle;
}

/** Typed repeating-clock seam. The returned function owns exactly one interval registration. */
export interface SnapshotWatchClock {
  now(): number;
  setInterval(callback: () => void, delay: Milliseconds): () => void;
}

export interface SnapshotWatcherDependencies {
  readonly agentDir: AbsolutePath;
  readonly onChange: () => void;
  /** Preferred bounded diagnostic adapter. */
  readonly onDiagnostic?: (code: WidgetDiagnosticCodeValue) => void;
  /** Backwards-compatible bounded diagnostic adapter. */
  readonly diagnostic?: (code: WidgetDiagnosticCodeValue) => void;
  readonly retryInterval?: Milliseconds;
  readonly maxRetryInterval?: Milliseconds;
  readonly watchFactory?: SnapshotWatchFactory;
  readonly clock?: SnapshotWatchClock;
}

type SlotState = WatchingSlot | PendingSlot | UnavailableSlot;

interface WatchingSlot {
  readonly kind: "watching";
  readonly handle: SnapshotWatchHandle;
}

interface PendingSlot {
  readonly kind: "pending";
  readonly delay: Milliseconds;
  readonly dueAt: number;
}

interface UnavailableSlot {
  readonly kind: "unavailable";
}

const productionWatchFactory: SnapshotWatchFactory = {
  watch: (directory) => watch(directory),
};

const productionClock: SnapshotWatchClock = {
  now: () => Date.now(),
  setInterval: (callback, delay) => {
    const timer = setInterval(callback, Number(delay));
    timer.unref();
    return () => { clearInterval(timer); };
  },
};

export function createSnapshotWatcher(dependencies: SnapshotWatcherDependencies): SnapshotWatcher {
  return new ManagedSnapshotWatcher(dependencies);
}

class ManagedSnapshotWatcher implements SnapshotWatcher {
  private readonly watchFactory: SnapshotWatchFactory;
  private readonly clock: SnapshotWatchClock;
  private readonly retryInterval: Milliseconds;
  private readonly maxRetryInterval: Milliseconds;
  private readonly onDiagnostic: (code: WidgetDiagnosticCodeValue) => void;
  private readonly slots = new Map<AgentId, SlotState>();
  private cancelInterval: (() => void) | undefined;
  private unavailableReported = false;
  private disposed = false;

  constructor(private readonly dependencies: SnapshotWatcherDependencies) {
    this.watchFactory = dependencies.watchFactory ?? productionWatchFactory;
    this.clock = dependencies.clock ?? productionClock;
    this.retryInterval = dependencies.retryInterval ?? WATCH_FALLBACK_INTERVAL_MS;
    this.maxRetryInterval = dependencies.maxRetryInterval ?? MAX_WATCH_RETRY_INTERVAL_MS;
    this.onDiagnostic = dependencies.onDiagnostic ?? dependencies.diagnostic ?? (() => {});
  }

  track(sessionIds: readonly AgentId[]): void {
    if (this.disposed) return;
    const wanted = new Set(sessionIds);
    for (const [sessionId, state] of this.slots) {
      if (wanted.has(sessionId)) continue;
      this.slots.delete(sessionId);
      if (state.kind === "watching") this.close(state.handle);
    }
    for (const sessionId of wanted) {
      if (!this.slots.has(sessionId)) this.attach(sessionId);
    }
    this.updateInterval();
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.cancelInterval?.();
    this.cancelInterval = undefined;
    const liveHandles = [...this.slots.values()]
      .filter((state): state is WatchingSlot => state.kind === "watching")
      .map((state) => state.handle);
    this.slots.clear();
    for (const handle of liveHandles) this.close(handle);
  }

  private attach(sessionId: AgentId): void {
    if (this.disposed) return;
    const prior = this.slots.get(sessionId);
    let handle: SnapshotWatchHandle;
    try {
      handle = this.watchFactory.watch(observationSlotDirectory(this.dependencies.agentDir, sessionId));
    } catch (error) {
      this.attachFailed(sessionId, prior, error);
      return;
    }

    const watching: WatchingSlot = { kind: "watching", handle };
    this.slots.set(sessionId, watching);
    try {
      handle.on("change", () => { this.changed(sessionId, handle); });
      handle.on("error", () => { this.failedLiveHandle(sessionId, handle); });
      handle.on("close", () => { this.failedLiveHandle(sessionId, handle); });
    } catch (error) {
      this.slots.delete(sessionId);
      this.close(handle);
      this.attachFailed(sessionId, prior, error);
      return;
    }
    this.notifyChange();
    this.updateInterval();
  }

  private attachFailed(sessionId: AgentId, prior: SlotState | undefined, error: unknown): void {
    if (this.disposed) return;
    if (isMissing(error)) {
      const delay = prior?.kind === "pending" ? doubledDelay(prior.delay, this.maxRetryInterval) : this.retryInterval;
      this.slots.set(sessionId, { kind: "pending", delay, dueAt: this.clock.now() + Number(delay) });
    } else {
      this.slots.set(sessionId, { kind: "unavailable" });
      this.reportUnavailable();
    }
    this.updateInterval();
  }

  private changed(sessionId: AgentId, handle: SnapshotWatchHandle): void {
    const state = this.slots.get(sessionId);
    if (state?.kind !== "watching" || state.handle !== handle) return;
    this.notifyChange();
  }

  private failedLiveHandle(sessionId: AgentId, handle: SnapshotWatchHandle): void {
    const state = this.slots.get(sessionId);
    if (this.disposed || state?.kind !== "watching" || state.handle !== handle) return;
    const delay = this.retryInterval;
    this.slots.set(sessionId, { kind: "pending", delay, dueAt: this.clock.now() + Number(delay) });
    this.close(handle);
    this.updateInterval();
  }

  private tick(): void {
    if (this.disposed) return;
    const now = this.clock.now();
    for (const [sessionId, state] of [...this.slots]) {
      if (state.kind === "unavailable") this.notifyChange();
      else if (state.kind === "pending" && state.dueAt <= now) this.attach(sessionId);
    }
    this.updateInterval();
  }

  private updateInterval(): void {
    const requiresInterval = [...this.slots.values()].some((state) => state.kind !== "watching");
    if (requiresInterval && this.cancelInterval === undefined) {
      this.cancelInterval = this.clock.setInterval(() => {
        try { this.tick(); } catch { /* a later interval must remain usable */ }
      }, this.retryInterval);
    } else if (!requiresInterval && this.cancelInterval !== undefined) {
      this.cancelInterval();
      this.cancelInterval = undefined;
    }
  }


  private notifyChange(): void {
    try { this.dependencies.onChange(); } catch { /* projection consumers cannot break watch state */ }
  }

  private reportUnavailable(): void {
    if (this.unavailableReported) return;
    this.unavailableReported = true;
    try { this.onDiagnostic(WidgetDiagnosticCode.WatchUnavailable); } catch { /* diagnostic boundary */ }
  }

  private close(handle: SnapshotWatchHandle): void {
    try { handle.close(); } catch { /* handle ownership ends even when close rejects */ }
  }
}

function doubledDelay(delay: Milliseconds, maximum: Milliseconds): Milliseconds {
  return Math.min(Number(delay) * 2, Number(maximum)) as Milliseconds;
}

function isMissing(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}
