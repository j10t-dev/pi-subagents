import { describe, expect, test } from "bun:test";

import {
  MAX_WATCH_RETRY_INTERVAL_MS,
  WATCH_FALLBACK_INTERVAL_MS,
} from "../src/constants.ts";
import { agentId, milliseconds, type AbsolutePath, type AgentId, type Milliseconds } from "../src/domain.ts";
import {
  createSnapshotWatcher,
  type SnapshotWatchClock,
  type SnapshotWatchFactory,
  type SnapshotWatchHandle,
} from "../src/snapshot-watcher.ts";

const AGENT_DIR = "/agent" as AbsolutePath;
const CHILD = agentId("child");

class FakeClock implements SnapshotWatchClock {
  private time = 0;
  private nextId = 0;
  readonly intervals = new Map<number, { readonly callback: () => void; readonly delay: Milliseconds; next: number }>();

  now(): number { return this.time; }

  setInterval(callback: () => void, delay: Milliseconds): () => void {
    const id = this.nextId++;
    this.intervals.set(id, { callback, delay, next: this.time + Number(delay) });
    return () => { this.intervals.delete(id); };
  }

  advance(duration: Milliseconds): void {
    const target = this.time + Number(duration);
    while (true) {
      const next = [...this.intervals.values()].reduce<number | undefined>(
        (earliest, interval) => interval.next <= target && (earliest === undefined || interval.next < earliest)
          ? interval.next : earliest,
        undefined,
      );
      if (next === undefined) break;
      this.time = next;
      for (const interval of [...this.intervals.values()]) {
        if (interval.next !== this.time) continue;
        interval.next += Number(interval.delay);
        interval.callback();
      }
    }
    this.time = target;
  }
}

type WatchOutcome = "success" | "ENOENT" | "EACCES";

class FakeHandle implements SnapshotWatchHandle {
  closed = false;
  private readonly listeners = new Map<"change" | "error" | "close", Array<() => void>>();

  close(): void {
    this.closed = true;
    this.emit("close");
  }

  on(event: "change" | "error" | "close", listener: () => void): void {
    const listeners = this.listeners.get(event) ?? [];
    listeners.push(listener);
    this.listeners.set(event, listeners);
  }

  emit(event: "change" | "error" | "close"): void {
    for (const listener of this.listeners.get(event) ?? []) listener();
  }
}

class FakeWatchFactory implements SnapshotWatchFactory {
  readonly attempts: AgentId[] = [];
  readonly handles = new Map<AgentId, FakeHandle[]>();
  private readonly outcomes = new Map<AgentId, WatchOutcome[]>();

  queue(id: AgentId, ...outcomes: WatchOutcome[]): void {
    this.outcomes.set(id, [...(this.outcomes.get(id) ?? []), ...outcomes]);
  }

  watch(directory: AbsolutePath): SnapshotWatchHandle {
    const id = agentId(directory.split("/").at(-2)!);
    this.attempts.push(id);
    const outcome = this.outcomes.get(id)?.shift() ?? "success";
    if (outcome !== "success") throw Object.assign(new Error(outcome), { code: outcome });
    const handle = new FakeHandle();
    const handles = this.handles.get(id) ?? [];
    handles.push(handle);
    this.handles.set(id, handles);
    return handle;
  }

  latest(id: AgentId): FakeHandle {
    const handle = this.handles.get(id)?.at(-1);
    if (handle === undefined) throw new Error(`no live handle for ${id}`);
    return handle;
  }
}

function fixture() {
  const clock = new FakeClock();
  const watches = new FakeWatchFactory();
  const changes: string[] = [];
  const diagnostics: string[] = [];
  const watcher = createSnapshotWatcher({
    agentDir: AGENT_DIR,
    onChange: () => { changes.push("change"); },
    diagnostic: (code) => { diagnostics.push(code); },
    watchFactory: watches,
    clock,
  });
  return { clock, watches, changes, diagnostics, watcher };
}

describe("SnapshotWatcher", () => {
  test("refreshes exactly once for every due missing-slot retry, including successful attachment", () => {
    const { clock, watches, changes, diagnostics, watcher } = fixture();
    watches.queue(CHILD, "ENOENT", "ENOENT", "ENOENT", "ENOENT", "ENOENT", "ENOENT", "success");

    watcher.track([CHILD]);
    expect(changes).toEqual([]);
    expect(Number(MAX_WATCH_RETRY_INTERVAL_MS)).toBe(30_000);
    for (const [index, delay] of [2_000, 4_000, 8_000, 16_000, 30_000].entries()) {
      clock.advance(milliseconds(delay));
      expect(changes).toHaveLength(index + 1);
      expect(diagnostics).toEqual([]);
    }
    clock.advance(MAX_WATCH_RETRY_INTERVAL_MS);

    expect(watches.attempts).toEqual([CHILD, CHILD, CHILD, CHILD, CHILD, CHILD, CHILD]);
    expect(changes).toHaveLength(6);
    expect(diagnostics).toEqual([]);
    expect(clock.intervals.size).toBe(0);
  });

  test("resets pending backoff when a slot leaves and later re-enters tracking", () => {
    const { clock, watches, watcher } = fixture();
    watches.queue(CHILD, "ENOENT", "ENOENT", "ENOENT");

    watcher.track([CHILD]);
    clock.advance(milliseconds(2_000));
    watcher.track([]);
    expect(clock.intervals.size).toBe(0);
    watcher.track([CHILD]);
    clock.advance(milliseconds(1_999));
    expect(watches.attempts).toHaveLength(3);
    clock.advance(milliseconds(1));

    expect(watches.attempts).toHaveLength(4);
  });

  test.each(["error", "close"] as const)("returns a live %s handle to pending and recovers through retry", (event) => {
    const { clock, watches, changes, watcher } = fixture();
    watches.queue(CHILD, "success", "ENOENT", "success");

    watcher.track([CHILD]);
    watches.latest(CHILD).emit("change");
    watches.latest(CHILD).emit(event);
    expect(changes).toEqual(["change", "change"]);
    expect(clock.intervals.size).toBe(1);

    clock.advance(milliseconds(2_000));
    clock.advance(milliseconds(4_000));

    expect(changes).toEqual(["change", "change", "change", "change"]);
    expect(clock.intervals.size).toBe(0);
  });

  test("uses one fixed fallback interval for unavailable watching and reports it once", () => {
    const { clock, watches, changes, diagnostics, watcher } = fixture();
    watches.queue(CHILD, "EACCES");

    watcher.track([CHILD]);
    expect(diagnostics).toEqual(["watch_unavailable"]);
    expect(clock.intervals.size).toBe(1);
    clock.advance(WATCH_FALLBACK_INTERVAL_MS);
    clock.advance(WATCH_FALLBACK_INTERVAL_MS);

    expect(watches.attempts).toEqual([CHILD]);
    expect(changes).toEqual(["change", "change"]);
    watcher.track([]);
    expect(clock.intervals.size).toBe(0);
  });

  test("dispose releases a live handle and the shared pending/unavailable interval", () => {
    const pending = agentId("pending");
    const unavailable = agentId("unavailable");
    const { clock, watches, changes, watcher } = fixture();
    watches.queue(CHILD, "success");
    watches.queue(pending, "ENOENT");
    watches.queue(unavailable, "EACCES");

    watcher.track([CHILD, pending, unavailable]);
    expect(clock.intervals.size).toBe(1);
    expect(watches.latest(CHILD).closed).toBe(false);

    watcher.dispose();
    const attemptsAtDispose = [...watches.attempts];
    const changesAtDispose = [...changes];
    clock.advance(MAX_WATCH_RETRY_INTERVAL_MS);

    expect(watches.latest(CHILD).closed).toBe(true);
    expect(clock.intervals.size).toBe(0);
    expect(watches.attempts).toEqual(attemptsAtDispose);
    expect(changes).toEqual(changesAtDispose);
  });

  test("closes dropped live handles and contains consumer callback failures", () => {
    const unavailable = agentId("unavailable");
    const clock = new FakeClock();
    const watches = new FakeWatchFactory();
    watches.queue(CHILD, "success");
    watches.queue(unavailable, "EACCES");
    const watcher = createSnapshotWatcher({
      agentDir: AGENT_DIR,
      onChange: () => { throw new Error("consumer failure"); },
      diagnostic: () => { throw new Error("consumer failure"); },
      watchFactory: watches,
      clock,
    });

    expect(() => watcher.track([CHILD, unavailable])).not.toThrow();
    expect(() => watches.latest(CHILD).emit("change")).not.toThrow();
    expect(() => clock.advance(WATCH_FALLBACK_INTERVAL_MS)).not.toThrow();
    watcher.track([]);

    expect(watches.latest(CHILD).closed).toBe(true);
    expect(clock.intervals.size).toBe(0);
  });
});

