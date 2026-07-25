import { describe, expect, test } from "bun:test";
import { createContextObservationService, type SessionStatsResult } from "../src/context-observation.ts";
import { contextPercent, rpcStopReason, runId, type RunId, type Usage } from "../src/domain.ts";
import type { ContextObservation, RpcObservationEvent } from "../src/agent-observation.ts";
import { deferred } from "./support/async.ts";

const R1 = runId("deadbeef");
const flush = () => Promise.resolve().then(() => Promise.resolve()).then(() => Promise.resolve());
const stats = (percent: number): SessionStatsResult => ({ contextUsage: { tokens: percent * 2, contextWindow: 200, percent } });
const usage = (tokens: number): Usage => ({ input: tokens, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: tokens + 1, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } });
const assistantEnd = (reason: string, tokens = 100): RpcObservationEvent => ({ kind: "assistant-end", finalBlocks: [], usage: usage(tokens), stopReason: rpcStopReason(reason) });

describe("ContextObservationService", () => {
  test("reset publishes unavailable", () => {
    const values: Array<readonly [RunId, ContextObservation]> = [];
    const service = createContextObservationService({ getSessionStats: async () => stats(10) }, (run, value) => values.push([run, value]));
    service.reset(R1);
    expect(values).toEqual([[R1, { kind: "unavailable" }]]);
  });

  test("coalesces eligible boundaries to one request plus one dirty follow-up", async () => {
    const first = deferred<SessionStatsResult>();
    let calls = 0;
    const values: ContextObservation[] = [];
    const service = createContextObservationService({ getSessionStats: async () => ++calls === 1 ? first.promise : stats(20) }, (_run, value) => values.push(value));
    service.reset(R1);
    service.observe({ kind: "turn-end" });
    service.observe({ kind: "turn-end" });
    service.observe({ kind: "turn-end" });
    expect(calls).toBe(1);
    first.resolve(stats(10));
    await flush();
    expect(calls).toBe(2);
    expect(values.at(-1)).toEqual({ kind: "known", percent: contextPercent(20) });
  });

  test.each([
    ["absent usage", {}],
    ["null tokens", { contextUsage: { tokens: null, contextWindow: 200, percent: null } }],
    ["non-positive window", { contextUsage: { tokens: 10, contextWindow: 0, percent: 5 } }],
    ["invalid percentage", { contextUsage: { tokens: 10, contextWindow: 200, percent: Number.NaN } }],
  ] as const)("projects unavailable for %s", async (_name, result) => {
    const published: ContextObservation[] = [];
    const service = createContextObservationService({ getSessionStats: async () => result }, (_run, value) => published.push(value));
    service.reset(R1); service.observe({ kind: "turn-end" }); await flush();
    expect(published.at(-1)).toEqual({ kind: "unavailable" });
  });

  test("recovers after a rejected request", async () => {
    let calls = 0; const values: ContextObservation[] = [];
    const service = createContextObservationService({ getSessionStats: async () => { if (++calls === 1) throw new Error("lost"); return stats(30); } }, (_run, value) => values.push(value));
    service.reset(R1); service.observe({ kind: "turn-end" }); await flush();
    expect(values.at(-1)).toEqual({ kind: "unavailable" });
    service.observe({ kind: "turn-end" }); await flush();
    expect(values.at(-1)).toEqual({ kind: "known", percent: contextPercent(30) });
  });

  test.each(["stop", "length"] as const)("uses safe assistant usage shortcut for %s", async (reason) => {
    let calls = 0; const values: ContextObservation[] = [];
    const service = createContextObservationService({ getSessionStats: async () => { calls++; return stats(25); } }, (_run, value) => values.push(value));
    service.reset(R1); service.observe({ kind: "turn-end" }); await flush();
    service.observe(assistantEnd(reason)); service.observe({ kind: "turn-end" }); await flush();
    expect(calls).toBe(1);
    expect(values.at(-1)).toEqual({ kind: "known", percent: contextPercent(50.5) });
  });

  test("prefers validated totalTokens, clamps the shortcut percentage, and avoids polling", async () => {
    let calls = 0;
    const values: ContextObservation[] = [];
    const service = createContextObservationService({ getSessionStats: async () => { calls++; return stats(25); } }, (_run, value) => values.push(value));
    service.reset(R1); service.observe({ kind: "turn-end" }); await flush();
    service.observe({ kind: "assistant-end", finalBlocks: [], stopReason: rpcStopReason("stop"), usage: {
      input: 300, output: 200, cacheRead: 100, cacheWrite: 50, totalTokens: 250,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    } });
    service.observe({ kind: "turn-end" }); await flush();
    expect(calls).toBe(1);
    expect(values.at(-1)).toEqual({ kind: "known", percent: contextPercent(100) });
  });

  test("falls back to all token components when totalTokens is zero", async () => {
    let calls = 0;
    const values: ContextObservation[] = [];
    const service = createContextObservationService({ getSessionStats: async () => { calls++; return stats(25); } }, (_run, value) => values.push(value));
    service.reset(R1); service.observe({ kind: "turn-end" }); await flush();
    service.observe({ kind: "assistant-end", finalBlocks: [], stopReason: rpcStopReason("stop"), usage: {
      input: 20, output: 10, cacheRead: 5, cacheWrite: 5, totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    } });
    service.observe({ kind: "turn-end" }); await flush();
    expect(calls).toBe(1);
    expect(values.at(-1)).toEqual({ kind: "known", percent: contextPercent(20) });
  });

  test("polls when totalTokens and every component are zero", async () => {
    let calls = 0;
    const values: ContextObservation[] = [];
    const service = createContextObservationService({ getSessionStats: async () => stats(++calls * 25) }, (_run, value) => values.push(value));
    service.reset(R1); service.observe({ kind: "turn-end" }); await flush();
    service.observe({ kind: "assistant-end", finalBlocks: [], stopReason: rpcStopReason("length"), usage: {
      input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    } });
    service.observe({ kind: "turn-end" }); await flush();
    expect(calls).toBe(2);
    expect(values.at(-1)).toEqual({ kind: "known", percent: contextPercent(50) });
  });

  test("falls back to input, output, cache read and cache write when totalTokens is invalid", async () => {
    let calls = 0;
    const values: ContextObservation[] = [];
    const service = createContextObservationService({ getSessionStats: async () => { calls++; return stats(25); } }, (_run, value) => values.push(value));
    service.reset(R1); service.observe({ kind: "turn-end" }); await flush();
    service.observe({ kind: "assistant-end", finalBlocks: [], stopReason: rpcStopReason("length"), usage: {
      input: 20, output: 10, cacheRead: 5, cacheWrite: 5, totalTokens: Number.NaN,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    } });
    service.observe({ kind: "turn-end" }); await flush();
    expect(calls).toBe(1);
    expect(values.at(-1)).toEqual({ kind: "known", percent: contextPercent(20) });
  });

  test.each(["toolUse", "future_reason"] as const)("pulls stats after %s", async (reason) => {
    let calls = 0;
    const service = createContextObservationService({ getSessionStats: async () => stats(++calls * 10) }, () => {});
    service.reset(R1); service.observe({ kind: "turn-end" }); await flush();
    service.observe(assistantEnd(reason)); service.observe({ kind: "turn-end" }); await flush();
    expect(calls).toBe(2);
  });

  test("compaction invalidation suppresses an older stats completion", async () => {
    const pending = deferred<SessionStatsResult>(); const values: ContextObservation[] = [];
    const service = createContextObservationService({ getSessionStats: () => pending.promise }, (_run, value) => values.push(value));
    service.reset(R1); service.observe({ kind: "turn-end" }); service.observe({ kind: "compaction", phase: "start" });
    pending.resolve(stats(90)); await flush();
    expect(values.at(-1)).toEqual({ kind: "unavailable" });
  });

  test("transport loss publishes unavailable and suppresses late stats", async () => {
    const pending = deferred<SessionStatsResult>(); const values: ContextObservation[] = [];
    const service = createContextObservationService({ getSessionStats: () => pending.promise }, (_run, value) => values.push(value));
    service.reset(R1); service.observe({ kind: "turn-end" }); service.observe({ kind: "transport-unavailable" });
    pending.resolve(stats(90)); await flush();
    expect(values.at(-1)).toEqual({ kind: "unavailable" });
  });

  test("compaction invalidates shortcut evidence and disposal suppresses late stats", async () => {
    const pending = deferred<SessionStatsResult>(); const values: ContextObservation[] = [];
    const service = createContextObservationService({ getSessionStats: () => pending.promise }, (_run, value) => values.push(value));
    service.reset(R1); service.observe({ kind: "turn-end" }); service.observe({ kind: "compaction", phase: "start" });
    expect(values.at(-1)).toEqual({ kind: "unavailable" });
    service.dispose(); pending.resolve(stats(90)); await flush();
    expect(values.at(-1)).toEqual({ kind: "unavailable" });
  });
});
