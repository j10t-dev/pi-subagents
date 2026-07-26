import { describe, expect, test } from "bun:test";

import type {
  AgentDisplayState,
  AuthoritativeTranscriptSource,
  ManagedTranscriptSource,
  TranscriptItem,
  TranscriptListener,
  TranscriptSnapshot,
  TranscriptSource,
} from "../src/agent-observation.ts";
import { toolDisplayName, transcriptText } from "../src/agent-observation.ts";
import { createMergedTranscriptSource } from "../src/merged-transcript-source.ts";
import {
  AgentState,
  runId,
  transcriptRevision,
  transcriptSequence,
  type RunId,
} from "../src/domain.ts";

const firstRun = runId("11111111");
const currentRun = runId("22222222");
function user(run: RunId, text: string): TranscriptItem {
  return Object.freeze({ sequence: transcriptSequence(0), runId: run, kind: "user", text: transcriptText(text) });
}
function assistant(run: RunId | undefined, text: string): TranscriptItem {
  return Object.freeze({ sequence: transcriptSequence(1), ...(run === undefined ? {} : { runId: run }), kind: "assistant", phase: "final", text: transcriptText(text) });
}
function tool(run: RunId, sequence: number): TranscriptItem {
  return Object.freeze({ sequence: transcriptSequence(sequence), runId: run, kind: "tool", tool: toolDisplayName("read"), phase: "completed" });
}
function notice(): TranscriptItem {
  return Object.freeze({ sequence: transcriptSequence(2), kind: "notice", code: "context-compacted" });
}
function runItems(run: RunId, text: string): readonly TranscriptItem[] { return [user(run, `prompt ${text}`), assistant(run, text)]; }
function items(source: TranscriptSource): readonly TranscriptItem[] { return source.snapshot().items; }
function expectTranscript(actual: readonly TranscriptItem[], expected: readonly TranscriptItem[]): void {
  expect(actual.map((item) => ({ ...item, sequence: 0 }))).toEqual(expected.map((item) => ({ ...item, sequence: 0 })));
}

function runtimeThenableListener(create: () => unknown): TranscriptListener {
  const listener = () => create();
  return listener as TranscriptListener;
}

class MutableSource implements TranscriptSource {
  readonly listeners = new Set<TranscriptListener>();
  private revision = 0;
  private current: TranscriptSnapshot;

  constructor(initial: readonly TranscriptItem[] = [], availability: TranscriptSnapshot["availability"] = "live") {
    this.current = snapshot(this.revision, initial, false, availability);
  }

  snapshot(): TranscriptSnapshot { return this.current }
  subscribe(listener: TranscriptListener): () => void {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }
  emit(next: readonly TranscriptItem[], options: Partial<Pick<TranscriptSnapshot, "availability" | "truncatedBefore">> = {}): void {
    this.revision += 1;
    this.current = snapshot(this.revision, next, options.truncatedBefore ?? this.current.truncatedBefore, options.availability ?? this.current.availability);
    for (const listener of [...this.listeners]) listener(this.current);
  }
}

class MutableAuthoritativeSource extends MutableSource implements AuthoritativeTranscriptSource {
  private proof = false;
  setDisplayState(_state: AgentDisplayState): void {}
  markRouteUnavailable(): void { this.emit(this.snapshot().items, { availability: "unavailable" }); }
  postTerminalEndReached(): boolean { return this.proof }
  proveEnd(): void { this.proof = true; this.emit(this.snapshot().items); }
  dispose(): void { this.listeners.clear(); }
}

function snapshot(revision: number, next: readonly TranscriptItem[], truncatedBefore: boolean, availability: TranscriptSnapshot["availability"]): TranscriptSnapshot {
  return Object.freeze({ revision: transcriptRevision(revision), items: Object.freeze([...next]), truncatedBefore, availability });
}

describe("createMergedTranscriptSource", () => {
  test("replaces a final authoritative segment wholesale instead of combining same-run live items", () => {
    const authoritative = new MutableAuthoritativeSource([...runItems(firstRun, "committed first"), user(currentRun, "prompt live current")]);
    const live = new MutableSource(runItems(currentRun, "live current"));
    const merged = createMergedTranscriptSource(authoritative, live);

    expectTranscript(items(merged), [...runItems(firstRun, "committed first"), ...runItems(currentRun, "live current")]);
    authoritative.emit([...runItems(firstRun, "committed first"), ...runItems(currentRun, "committed current")]);
    authoritative.proveEnd();

    expectTranscript(items(merged), [...runItems(firstRun, "committed first"), ...runItems(currentRun, "committed current")]);
  });

  test.each([
    ["retains a leading uncorrelated authoritative tail without a live source", [assistant(undefined, "tail")]],
    ["keeps a leading tail final when a retained user follows it", [assistant(undefined, "tail"), ...runItems(firstRun, "first")]],
    ["keeps a segment final when another authoritative user follows it", [...runItems(firstRun, "first"), ...runItems(currentRun, "current")]],
  ])("%s", (_name, authoritativeItems) => {
    const authoritative = new MutableAuthoritativeSource(authoritativeItems);
    const merged = createMergedTranscriptSource(authoritative);
    expectTranscript(items(merged), authoritativeItems);
  });

  test("keeps authoritative notices in source order around replaced run segments", () => {
    const authoritative = new MutableAuthoritativeSource([
      user(firstRun, "first"), notice(), assistant(firstRun, "authoritative first"), notice(),
      user(currentRun, "current"), assistant(currentRun, "authoritative current"), notice(),
    ]);
    const live = new MutableSource(runItems(currentRun, "live current"));
    const merged = createMergedTranscriptSource(authoritative, live);

    expectTranscript(items(merged), [
      user(firstRun, "first"), notice(), assistant(firstRun, "authoritative first"), notice(),
      ...runItems(currentRun, "live current"), notice(),
    ]);
  });

  test("replaces a notice-split leading tail with one live run", () => {
    const authoritative = new MutableAuthoritativeSource([
      assistant(undefined, "durable prefix"), notice(), assistant(undefined, "durable suffix"),
    ]);
    const live = new MutableSource(runItems(currentRun, "live current"));
    const merged = createMergedTranscriptSource(authoritative, live);

    expectTranscript(items(merged), [...runItems(currentRun, "live current"), notice()]);
  });

  test("prefers a direct live run over an uncorrelated latest authoritative tail before proof", () => {
    const authoritative = new MutableAuthoritativeSource([assistant(undefined, "durable tail")]);
    const live = new MutableSource(runItems(currentRun, "live current"));
    const merged = createMergedTranscriptSource(authoritative, live);
    expectTranscript(items(merged), runItems(currentRun, "live current"));
  });

  test("replaces an uncorrelated latest tail after proof only when it has no later retained user", () => {
    const authoritative = new MutableAuthoritativeSource([assistant(undefined, "durable tail")]);
    const live = new MutableSource(runItems(currentRun, "live current"));
    const merged = createMergedTranscriptSource(authoritative, live);
    authoritative.proveEnd();
    expectTranscript(items(merged), [assistant(undefined, "durable tail")]);
  });

  test("does not finalise the latest matching run while the live source remains live", () => {
    const authoritative = new MutableAuthoritativeSource(runItems(currentRun, "durable partial"));
    const live = new MutableSource(runItems(currentRun, "live current"));
    const merged = createMergedTranscriptSource(authoritative, live);
    expectTranscript(items(merged), runItems(currentRun, "live current"));
  });

  test("does not treat terminal display state as post-terminal EOF proof", () => {
    const authoritative = new MutableAuthoritativeSource(runItems(currentRun, "durable partial"));
    const live = new MutableSource(runItems(currentRun, "live current"));
    const merged = createMergedTranscriptSource(authoritative, live);
    merged.setDisplayState(AgentState.Stopped);
    expectTranscript(items(merged), runItems(currentRun, "live current"));
  });

  test("uses a proof-only authoritative revision to replace the current live run", () => {
    const authoritative = new MutableAuthoritativeSource(runItems(currentRun, "durable current"));
    const live = new MutableSource(runItems(currentRun, "live current"));
    const merged = createMergedTranscriptSource(authoritative, live);
    const revision = merged.snapshot().revision;
    authoritative.proveEnd();
    expectTranscript(items(merged), runItems(currentRun, "durable current"));
    expect(Number(merged.snapshot().revision)).toBeGreaterThan(Number(revision));
  });

  test("retains identical text from different runs", () => {
    const authoritative = new MutableAuthoritativeSource([...runItems(firstRun, "same"), ...runItems(currentRun, "same")]);
    const merged = createMergedTranscriptSource(authoritative);
    expectTranscript(items(merged).filter((item) => item.kind === "assistant"), [assistant(firstRun, "same"), assistant(currentRun, "same")]);
  });

  test("does not combine unequal text from a final same-run authoritative segment", () => {
    const authoritative = new MutableAuthoritativeSource([...runItems(firstRun, "authoritative"), ...runItems(currentRun, "latest")]);
    const live = new MutableSource([...runItems(firstRun, "live mismatch"), ...runItems(currentRun, "live")]);
    const merged = createMergedTranscriptSource(authoritative, live);
    expectTranscript(items(merged), [...runItems(firstRun, "authoritative"), ...runItems(currentRun, "live")]);
  });

  test("does not deduplicate tool items by sequence or incidental identifiers", () => {
    const authoritative = new MutableAuthoritativeSource([user(firstRun, "prompt"), tool(firstRun, 7), tool(firstRun, 99), ...runItems(currentRun, "latest")]);
    const merged = createMergedTranscriptSource(authoritative);
    expectTranscript(items(merged).filter((item) => item.kind === "tool"), [tool(firstRun, 7), tool(firstRun, 99)]);
  });

  test("retains valid authoritative history when that source becomes unavailable beside live data", () => {
    const authoritative = new MutableAuthoritativeSource([
      ...runItems(firstRun, "committed"),
      ...runItems(currentRun, "durable current"),
    ]);
    const live = new MutableSource(runItems(currentRun, "live current"));
    const merged = createMergedTranscriptSource(authoritative, live);

    authoritative.emit(authoritative.snapshot().items, { availability: "unavailable" });

    expectTranscript(items(merged), [
      ...runItems(firstRun, "committed"),
      ...runItems(currentRun, "live current"),
    ]);
  });

  test("appends the latest live run once when authoritative segmentation does not contain it", () => {
    const authoritative = new MutableAuthoritativeSource(runItems(firstRun, "committed"));
    const live = new MutableSource(runItems(currentRun, "live current"));
    const merged = createMergedTranscriptSource(authoritative, live);

    expectTranscript(items(merged), [
      ...runItems(firstRun, "committed"),
      ...runItems(currentRun, "live current"),
    ]);
  });

  test("retains a valid current live run when the authoritative source becomes unavailable", () => {
    const authoritative = new MutableAuthoritativeSource(runItems(firstRun, "committed"));
    const live = new MutableSource(runItems(currentRun, "live"));
    const merged = createMergedTranscriptSource(authoritative, live);
    authoritative.emit([], { availability: "unavailable" });
    expectTranscript(items(merged), runItems(currentRun, "live"));
  });

  test("retains a latest unproved authoritative run when live becomes unavailable and empty", () => {
    const authoritative = new MutableAuthoritativeSource([
      ...runItems(firstRun, "committed"),
      ...runItems(currentRun, "unproved current"),
    ]);
    const live = new MutableSource(runItems(currentRun, "live"));
    const merged = createMergedTranscriptSource(authoritative, live);

    live.emit([], { availability: "unavailable" });

    expectTranscript(items(merged), [
      ...runItems(firstRun, "committed"),
      ...runItems(currentRun, "unproved current"),
    ]);
  });

  test("retains committed authoritative runs when the live source becomes unavailable", () => {
    const authoritative = new MutableAuthoritativeSource([...runItems(firstRun, "committed"), ...runItems(currentRun, "committed current")]);
    const live = new MutableSource(runItems(currentRun, "live"));
    const merged = createMergedTranscriptSource(authoritative, live);
    authoritative.proveEnd();
    live.emit([], { availability: "unavailable" });
    expectTranscript(items(merged), [...runItems(firstRun, "committed"), ...runItems(currentRun, "committed current")]);
  });

  test("propagates truncation and bounds the merged snapshot", () => {
    const authoritative = new MutableAuthoritativeSource(runItems(firstRun, "committed"));
    const live = new MutableSource(runItems(currentRun, "live"));
    const merged = createMergedTranscriptSource(authoritative, live);
    authoritative.emit(authoritative.snapshot().items, { truncatedBefore: true });
    expect(merged.snapshot().truncatedBefore).toBeTrue();
    expect(Object.isFrozen(merged.snapshot().items)).toBeTrue();
  });

  test("subscribes lazily and emits one immutable revision per input revision", () => {
    const authoritative = new MutableAuthoritativeSource([...runItems(firstRun, "committed"), user(currentRun, "prompt live")]);
    const live = new MutableSource(runItems(currentRun, "live"));
    const merged = createMergedTranscriptSource(authoritative, live);
    expect(authoritative.listeners.size).toBe(0);
    expect(live.listeners.size).toBe(0);
    let notifications = 0;
    const unsubscribe = merged.subscribe((next) => { notifications += 1; expect(Object.isFrozen(next)).toBeTrue(); });
    expect(authoritative.listeners.size).toBe(1);
    expect(live.listeners.size).toBe(1);
    live.emit(runItems(currentRun, "next"));
    expect(notifications).toBe(1);
    unsubscribe();
    expect(authoritative.listeners.size).toBe(0);
    expect(live.listeners.size).toBe(0);
  });

  test("contains a rejecting thenable listener", async () => {
    const authoritative = new MutableAuthoritativeSource(runItems(firstRun, "committed"));
    const merged = createMergedTranscriptSource(authoritative);
    let rejectionHandled = false;
    merged.subscribe(runtimeThenableListener(() => ({
      then: (_resolve: (value: unknown) => void, reject: (reason: unknown) => void) => {
        rejectionHandled = true;
        reject(new Error("listener rejection"));
      },
    })));

    authoritative.emit([...runItems(firstRun, "committed"), ...runItems(currentRun, "current")]);
    await Promise.resolve();
    expect(rejectionHandled).toBeTrue();
  });

  test("removes throwing and thenable listeners without blocking healthy listeners", () => {
    const authoritative = new MutableAuthoritativeSource(runItems(firstRun, "committed"));
    const merged = createMergedTranscriptSource(authoritative);
    let healthy = 0;
    merged.subscribe(() => { throw new Error("listener failure"); });
    merged.subscribe(runtimeThenableListener(() => Promise.resolve()));
    merged.subscribe(() => { healthy += 1; });
    authoritative.emit([...runItems(firstRun, "committed"), ...runItems(currentRun, "current")]);
    authoritative.emit([...runItems(firstRun, "committed"), ...runItems(currentRun, "next")]);
    expect(healthy).toBe(2);
    expect(authoritative.listeners.size).toBe(1);
  });

  test("releases each input subscription and managed source on disposal", () => {
    const authoritative = new MutableAuthoritativeSource();
    const live = new MutableManagedSource();
    const merged = createMergedTranscriptSource(authoritative, live);
    merged.subscribe(() => {});
    merged.dispose();
    expect(authoritative.listeners.size).toBe(0);
    expect(live.listeners.size).toBe(0);
    expect(live.disposed).toBeTrue();
  });
});

class MutableManagedSource extends MutableSource implements ManagedTranscriptSource {
  disposed = false;
  setDisplayState(_state: AgentDisplayState): void {}
  markRouteUnavailable(): void { this.emit(this.snapshot().items, { availability: "unavailable" }); }
  dispose(): void { this.disposed = true; this.listeners.clear(); }
}
