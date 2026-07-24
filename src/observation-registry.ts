import type { SubagentObservationPort } from "./agent-observation.ts";

export interface ObservationPublication {
  clear(): void;
}

interface CurrentPublication {
  readonly token: symbol;
  readonly port: SubagentObservationPort;
}

const listeners = new Set<(port: SubagentObservationPort | undefined) => void>();
let current: CurrentPublication | undefined;

export function publishObservationPort(port: SubagentObservationPort): ObservationPublication {
  const token = Symbol("observation-publication");
  current = { token, port };
  notify(port);
  let cleared = false;
  return {
    clear: () => {
      if (cleared) return;
      cleared = true;
      if (current?.token !== token) return;
      current = undefined;
      notify(undefined);
    },
  };
}

export function onObservationPort(
  listener: (port: SubagentObservationPort | undefined) => void,
): () => void {
  listeners.add(listener);
  invoke(listener, current?.port);
  let active = true;
  return () => {
    if (!active) return;
    active = false;
    listeners.delete(listener);
  };
}

function notify(port: SubagentObservationPort | undefined): void {
  for (const listener of [...listeners]) {
    if (listeners.has(listener)) invoke(listener, port);
  }
}

function invoke(
  listener: (port: SubagentObservationPort | undefined) => void,
  port: SubagentObservationPort | undefined,
): void {
  try {
    const returned = listener(port);
    if (isThenable(returned)) {
      listeners.delete(listener);
      void Promise.resolve(returned).catch(() => undefined);
    }
  } catch {
    listeners.delete(listener);
  }
}

function isThenable(value: void): value is never {
  return typeof value === "object" && value !== null && "then" in value;
}
