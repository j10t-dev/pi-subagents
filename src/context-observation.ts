import { contextPercent, type RunId, type Usage } from "./domain.ts";
import type { ContextObservation, RpcObservationEvent } from "./agent-observation.ts";

export interface SessionStatsResult {
  readonly contextUsage?: {
    readonly tokens: number | null;
    readonly contextWindow: number;
    readonly percent: number | null;
  };
}

export interface ContextStatsCommand {
  getSessionStats(): Promise<SessionStatsResult>;
}

export interface ContextObservationService {
  observe(event: RpcObservationEvent): void;
  reset(runId: RunId): void;
  dispose(): void;
}

export function createContextObservationService(
  command: ContextStatsCommand,
  publish: (runId: RunId, value: ContextObservation) => void,
): ContextObservationService {
  let currentRun: RunId | undefined;
  let contextWindow: number | undefined;
  let shortcutPercent: number | undefined;
  let trailingContext = true;
  let inFlight = false;
  let dirty = false;
  let followUp = false;
  let generation = 0;
  let disposed = false;

  const emit = (value: ContextObservation): void => {
    if (disposed || currentRun === undefined) return;
    try { publish(currentRun, Object.freeze(value)); } catch { /* observation is non-authoritative */ }
  };

  const pull = (): void => {
    if (disposed || currentRun === undefined) return;
    if (inFlight) {
      if (!followUp) dirty = true;
      return;
    }
    inFlight = true;
    const requestGeneration = generation;
    let request: Promise<SessionStatsResult>;
    try { request = command.getSessionStats(); }
    catch { complete(requestGeneration, undefined); return; }
    void Promise.resolve(request).then(
      (result) => complete(requestGeneration, result),
      () => complete(requestGeneration, undefined),
    );
  };

  const complete = (requestGeneration: number, result: SessionStatsResult | undefined): void => {
    if (disposed) return;
    inFlight = false;
    if (requestGeneration === generation) {
      const usage = validUsage(result);
      if (usage === undefined) {
        contextWindow = undefined;
        shortcutPercent = undefined;
        emit({ kind: "unavailable" });
      } else {
        contextWindow = usage.contextWindow;
        shortcutPercent = undefined;
        emit({ kind: "known", percent: contextPercent(usage.percent) });
      }
    }
    if (dirty) {
      dirty = false;
      followUp = true;
      pull();
    } else {
      followUp = false;
    }
  };

  return {
    reset(runId): void {
      if (disposed) return;
      currentRun = runId;
      generation++;
      contextWindow = undefined;
      shortcutPercent = undefined;
      trailingContext = true;
      dirty = false;
      followUp = false;
      emit({ kind: "unavailable" });
    },
    observe(event): void {
      if (disposed || currentRun === undefined) return;
      switch (event.kind) {
        case "assistant-end": {
          const calculatedTokens = shortcutTokens(event.usage);
          shortcutPercent = (event.stopReason === "stop" || event.stopReason === "length") &&
            calculatedTokens !== undefined && contextWindow !== undefined
            ? Math.min(100, Math.max(0, calculatedTokens / contextWindow * 100))
            : undefined;
          trailingContext = false;
          return;
        }
        case "turn-end":
          if (shortcutPercent !== undefined && !trailingContext) {
            emit({ kind: "known", percent: contextPercent(shortcutPercent) });
            shortcutPercent = undefined;
          } else pull();
          trailingContext = true;
          return;
        case "compaction":
          generation++;
          dirty = false;
          followUp = false;
          contextWindow = undefined;
          shortcutPercent = undefined;
          trailingContext = true;
          emit({ kind: "unavailable" });
          return;
        case "prompt-accepted":
        case "assistant-start":
        case "assistant-content":
        case "tool":
          trailingContext = true;
          shortcutPercent = undefined;
          return;
        case "agent-settled":
          return;
        case "transport-unavailable":
          generation++;
          emit({ kind: "unavailable" });
          disposed = true;
          currentRun = undefined;
          dirty = false;
          return;
      }
    },
    dispose(): void {
      if (disposed) return;
      disposed = true;
      generation++;
      currentRun = undefined;
      dirty = false;
    },
  };
}

function shortcutTokens(usage: Usage): number | undefined {
  if (Number.isFinite(usage.totalTokens) && usage.totalTokens > 0) return usage.totalTokens;
  const fallback = usage.input + usage.output + usage.cacheRead + usage.cacheWrite;
  return Number.isFinite(fallback) && fallback > 0 ? fallback : undefined;
}

function validUsage(result: SessionStatsResult | undefined): { readonly contextWindow: number; readonly percent: number } | undefined {
  const usage = result?.contextUsage;
  if (usage === undefined || usage.tokens === null || usage.percent === null) return undefined;
  if (!Number.isFinite(usage.tokens) || usage.tokens < 0 || !Number.isFinite(usage.contextWindow) || usage.contextWindow <= 0 ||
      !Number.isFinite(usage.percent) || usage.percent < 0) return undefined;
  return { contextWindow: usage.contextWindow, percent: usage.percent };
}
