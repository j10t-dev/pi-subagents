import { RELAY_FLUSH_WINDOW_MS } from "./constants.ts";
import type { Milliseconds } from "./domain.ts";

/** Deferred, single-window work scheduler. */
export interface Coalescer {
  request(): void;
  dispose(): void;
}

/** Test seam for the production unref'd timeout. */
export interface CoalescerTimer {
  schedule(callback: () => void, delay: number): () => void;
}

const productionTimer: CoalescerTimer = {
  schedule: (callback, delay) => {
    const timer = setTimeout(callback, delay);
    timer.unref();
    return () => { clearTimeout(timer); };
  },
};

export function createCoalescer(
  runner: () => void,
  timer: CoalescerTimer = productionTimer,
  delay: Milliseconds = RELAY_FLUSH_WINDOW_MS,
): Coalescer {
  let cancel: (() => void) | undefined;
  let disposed = false;
  const run = (): void => {
    cancel = undefined;
    try { runner(); } catch { /* later requests must remain usable */ }
  };
  return {
    request: () => {
      if (disposed || cancel !== undefined) return;
      cancel = timer.schedule(run, Number(delay));
    },
    dispose: () => {
      if (disposed) return;
      disposed = true;
      cancel?.();
      cancel = undefined;
    },
  };
}
