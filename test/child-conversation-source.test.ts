import { describe, expect, test } from "bun:test";

import type {
  AgentDisplayState,
  AgentRow,
  ManagedTranscriptSource,
  TranscriptListener,
  TranscriptSnapshot,
} from "../src/agent-observation.ts";
import { createSelectedTranscriptSource } from "../src/agent-widget/conversation-source.ts";
import {
  AgentState,
  CompletionState,
  agentDepth,
  agentId,
  agentOrdinal,
  transcriptFileName,
  transcriptRevision,
  type ContextLabel,
  type ModelLabel,
  type TaskLabel,
  type TranscriptRoute,
} from "../src/domain.ts";

const ROUTE: TranscriptRoute = Object.freeze({
  ownerSessionId: agentId("owner-session"),
  childSessionId: agentId("child-session"),
  fileName: transcriptFileName("child-session.jsonl"),
  direct: true,
});

function row(options: {
  readonly ordinal?: string;
  readonly state?: AgentDisplayState;
  readonly taskLabel?: string;
} = {}): AgentRow {
  return Object.freeze({
    ordinal: agentOrdinal(options.ordinal ?? "A1.2"),
    depth: agentDepth(1),
    model: "luna:h" as ModelLabel,
    context: "42%" as ContextLabel,
    taskLabel: (options.taskLabel ?? "Research terminal UX") as TaskLabel,
    state: options.state ?? AgentState.Running,
  });
}

function snapshotAt(revision: number): TranscriptSnapshot {
  return Object.freeze({
    revision: transcriptRevision(revision),
    items: [],
    truncatedBefore: false,
    availability: "live" as const,
  });
}

class FakeManagedTranscriptSource implements ManagedTranscriptSource {
  readonly displayStates: AgentDisplayState[] = [];
  routeLosses = 0;
  disposals = 0;
  private readonly listeners = new Set<TranscriptListener>();
  private current = snapshotAt(1);

  get subscribers(): number { return this.listeners.size }

  snapshot(): TranscriptSnapshot { return this.current }

  subscribe(listener: TranscriptListener): () => void {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener) };
  }

  setDisplayState(state: AgentDisplayState): void { this.displayStates.push(state) }

  markRouteUnavailable(): void { this.routeLosses += 1 }

  dispose(): void { this.disposals += 1 }

  publish(next: TranscriptSnapshot): void {
    this.current = next;
    for (const listener of [...this.listeners]) listener(next);
  }
}

function selectedOver(options: { readonly ordinal?: string } = {}): {
  readonly transcript: FakeManagedTranscriptSource;
  readonly source: ReturnType<typeof createSelectedTranscriptSource>;
  readonly initialRow: AgentRow;
} {
  const transcript = new FakeManagedTranscriptSource();
  const initialRow = row(options);
  const source = createSelectedTranscriptSource(
    agentOrdinal(options.ordinal ?? "A1.2"),
    ROUTE,
    initialRow,
    transcript,
  );
  return { transcript, source, initialRow };
}

describe("createSelectedTranscriptSource", () => {
  test("publishes the initial row, transcript and route availability together", () => {
    const { source, transcript, initialRow } = selectedOver();

    expect(source.snapshot()).toMatchObject({
      row: initialRow,
      transcript: transcript.snapshot(),
      routeAvailable: true,
    });
    expect(transcript.displayStates).toEqual([AgentState.Running]);
    source.dispose();
  });

  test("an equal route updates the row state in one revision", () => {
    const { source, transcript } = selectedOver();
    const before = source.snapshot().revision;
    let notifications = 0;
    source.subscribe(() => { notifications += 1 });

    const updated = row({ state: CompletionState.Completed, taskLabel: "Updated task" });
    source.update({ route: { ...ROUTE }, row: updated });

    expect(Number(source.snapshot().revision)).toBeGreaterThan(Number(before));
    expect(source.snapshot()).toMatchObject({ row: updated, routeAvailable: true });
    expect(transcript.displayStates.at(-1)).toBe(CompletionState.Completed);
    expect(transcript.routeLosses).toBe(0);
    expect(notifications).toBe(1);
    source.dispose();
  });

  test("an absent route retains the prior row and transcript and reports route loss", () => {
    const { source, transcript, initialRow } = selectedOver();
    const publishedTranscript = transcript.snapshot();

    source.update(undefined);

    expect(source.snapshot()).toMatchObject({
      row: initialRow,
      transcript: publishedTranscript,
      routeAvailable: false,
    });
    expect(transcript.routeLosses).toBe(1);
    expect(transcript.displayStates).toEqual([AgentState.Running]);
    source.dispose();
  });

  test.each([
    ["owner session", { ownerSessionId: agentId("other-owner") }],
    ["child session", { childSessionId: agentId("other-child") }],
    ["file name", { fileName: transcriptFileName("other-child.jsonl") }],
    ["directness", { direct: false }],
  ] as const)("an unequal %s retains the prior row and reports route loss", (_name, difference) => {
    const { source, transcript, initialRow } = selectedOver();

    source.update({ route: { ...ROUTE, ...difference }, row: row({ taskLabel: "Reused slot" }) });

    expect(source.snapshot()).toMatchObject({ row: initialRow, routeAvailable: false });
    expect(transcript.routeLosses).toBe(1);
    expect(transcript.displayStates).toEqual([AgentState.Running]);
    source.dispose();
  });

  test("never switches to a reused ordinal", () => {
    const { source, transcript, initialRow } = selectedOver({ ordinal: "A1.2" });

    source.update({ route: { ...ROUTE }, row: row({ ordinal: "A1.3" }) });

    expect(source.snapshot()).toMatchObject({ row: initialRow, routeAvailable: false });
    expect(transcript.routeLosses).toBe(1);
    source.dispose();
  });

  test("subscribes to the managed transcript only while it has subscribers", () => {
    const { source, transcript } = selectedOver();
    expect(transcript.subscribers).toBe(0);

    const first = source.subscribe(() => {});
    const second = source.subscribe(() => {});
    expect(transcript.subscribers).toBe(1);

    first();
    expect(transcript.subscribers).toBe(1);
    second();
    expect(transcript.subscribers).toBe(0);
    source.dispose();
  });

  test("publishes a transcript change as one selected revision", () => {
    const { source, transcript } = selectedOver();
    const revisions: number[] = [];
    source.subscribe((snapshot) => { revisions.push(Number(snapshot.revision)) });

    const next = snapshotAt(2);
    transcript.publish(next);

    expect(revisions).toHaveLength(1);
    expect(source.snapshot()).toMatchObject({ transcript: next, routeAvailable: true });
    source.dispose();
  });

  test("adopts the current transcript when a subscriber arrives after a dormant change", () => {
    const { source, transcript } = selectedOver();
    transcript.publish(snapshotAt(3));

    let notifications = 0;
    source.subscribe(() => { notifications += 1 });

    expect(source.snapshot().transcript).toEqual(snapshotAt(3));
    expect(notifications).toBe(1);
    source.dispose();
  });

  test("removes throwing subscribers without blocking healthy ones", () => {
    const { source, transcript } = selectedOver();
    let throwing = 0;
    let healthy = 0;
    source.subscribe(() => { throwing += 1; throw new Error("subscriber boom") });
    source.subscribe(() => { healthy += 1 });

    transcript.publish(snapshotAt(2));
    transcript.publish(snapshotAt(3));

    expect(throwing).toBe(1);
    expect(healthy).toBe(2);
    source.dispose();
  });

  test("disposal releases the transcript and is idempotent", () => {
    const { source, transcript } = selectedOver();
    source.subscribe(() => {});

    source.dispose();
    source.dispose();

    expect(transcript.disposals).toBe(1);
    expect(transcript.subscribers).toBe(0);
  });
});
