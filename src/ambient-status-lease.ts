/**
 * Process-local arbitration of the ambient `pi-subagents` status line. Imports neither the
 * controller nor any TUI type: core publishes its status through here, and a presenter that is
 * visibly replacing that status — the agent widget — holds a lease while it does.
 *
 * Both extension load orders converge because acquisition and release each replay current state.
 */

export interface StatusLease {
  release(): void;
}

const listeners = new Set<(text: string | undefined) => void>();
const leases = new Set<symbol>();
let fallback: string | undefined;

/** Core's latest status text. Retained even while suppressed, so release can restore it. */
export function setAmbientStatus(text: string | undefined): void {
  fallback = text;
  if (leases.size === 0) notify(text);
}

export function onAmbientStatus(listener: (text: string | undefined) => void): () => void {
  listeners.add(listener);
  invoke(listener, leases.size === 0 ? fallback : undefined);
  return () => { listeners.delete(listener); };
}

export function acquireStatusLease(): StatusLease {
  const token = Symbol("ambient-status-lease");
  const held = leases.size > 0;
  leases.add(token);
  if (!held) notify(undefined);
  let released = false;
  return {
    release: (): void => {
      if (released) return;
      released = true;
      leases.delete(token);
      if (leases.size === 0) notify(fallback);
    },
  };
}

function notify(text: string | undefined): void {
  for (const listener of [...listeners]) {
    if (listeners.has(listener)) invoke(listener, text);
  }
}

function invoke(listener: (text: string | undefined) => void, text: string | undefined): void {
  // A throwing presenter must not strand the others or reach core's status call site.
  try { listener(text); } catch { listeners.delete(listener); }
}
