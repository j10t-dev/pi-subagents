import { describe, expect, test } from "bun:test";

import {
  toolDisplayName,
  transcriptText,
  type AgentDisplayState,
  type AuthoritativeTranscriptSource,
} from "../src/agent-observation.ts";
import {
  MAX_RPC_RECORD_BYTES,
  MAX_SESSION_RECOVERY_BYTES,
  MAX_TRANSCRIPT_SOURCE_BYTES,
  MAX_TRANSCRIPT_SOURCE_ITEMS,
  TRANSCRIPT_FALLBACK_INTERVAL_MS,
  TRANSCRIPT_REFRESH_WINDOW_MS,
} from "../src/constants.ts";
import {
  AgentState,
  CompletionState,
  agentId,
  fileByteLength,
  fileDevice,
  fileInode,
  runId,
  sessionEntryId,
  transcriptFileName,
  transcriptRevision,
  type AbsolutePath,
  type FileOffset,
  type Milliseconds,
  type TranscriptFileName,
  type TranscriptPathSegment,
  type TranscriptRoute,
  type Utf8Bytes,
} from "../src/domain.ts";
import { decodeTranscriptSessionEntry, decodeTranscriptSessionHeader } from "../src/schemas.ts";
import {
  createSessionTranscriptSource,
  type TranscriptDirectoryHandle,
  type TranscriptFileSystem,
  type TranscriptReadHandle,
  type TranscriptFileWatcherFactory,
  type TranscriptRefreshClock,
  type TranscriptScheduledTask,
  type TranscriptWatch,
} from "../src/session-transcript-source.ts";
import { WidgetDiagnosticCode } from "../src/widget-diagnostics.ts";
import { testAbsolutePath } from "./support/brands.ts";

// --- Fixtures --------------------------------------------------------------

const AGENT_DIR = testAbsolutePath("/tmp/pi-subagents-test/agent-dir");
const OWNER = "owner-session";
const CHILD = "child-session";
const FILE = "child-session.jsonl";
const ROUTE: TranscriptRoute = Object.freeze({
  ownerSessionId: agentId(OWNER),
  childSessionId: agentId(CHILD),
  fileName: transcriptFileName(FILE),
  direct: true,
});

const encoder = new TextEncoder();

function header(id = CHILD, version?: number): string {
  return JSON.stringify({
    type: "session",
    ...(version === undefined ? {} : { version }),
    id,
    timestamp: "2026-01-01T00:00:00.000Z",
    cwd: "/tmp",
  });
}

function messageEntry(id: string, parentId: string | null, message: unknown): string {
  return JSON.stringify({ type: "message", id, parentId, timestamp: "t", message });
}

function userMessage(content: unknown): unknown {
  return { role: "user", content, timestamp: 1 };
}

function assistantMessage(content: readonly unknown[]): unknown {
  return { role: "assistant", content, model: "m", provider: "p", stopReason: "stop", timestamp: 1 };
}

function toolResultMessage(toolCallId: string, toolName: string, text: string, isError = false): unknown {
  return { role: "toolResult", toolCallId, toolName, content: [{ type: "text", text }], isError, timestamp: 1 };
}

function jsonl(...records: readonly string[]): string {
  return records.length === 0 ? "" : `${records.join("\n")}\n`;
}

/** Header plus one complete question/answer run using every projected content kind. */
function conversationText(): string {
  return jsonl(
    header(),
    messageEntry("11111111", null, userMessage("question")),
    messageEntry("22222222", "11111111", assistantMessage([
      { type: "thinking", thinking: "reason" },
      { type: "text", text: "answer" },
      { type: "toolCall", id: "call-1", name: "read", arguments: {} },
    ])),
    messageEntry("33333333", "22222222", toolResultMessage("call-1", "read", "file contents")),
  );
}

// --- Deterministic adapters ------------------------------------------------

interface FakeDirectory { readonly kind: "directory"; readonly entries: Map<string, FakeNode> }
interface FakeFile { kind: "file"; bytes: Uint8Array; identity: number }
interface FakeSymlink { readonly kind: "symlink" }
interface FakeFifo { readonly kind: "fifo" }
type FakeNode = FakeDirectory | FakeFile | FakeSymlink | FakeFifo;

function directory(): FakeDirectory {
  return { kind: "directory", entries: new Map<string, FakeNode>() };
}

function failure(code: string): Error {
  return Object.assign(new Error(code), { code });
}

class FakeTranscriptFileSystem implements TranscriptFileSystem {
  readonly root = directory();
  /** Every traversal component observed, proving traversal never rejoins a pathname. */
  readonly segments: string[] = [];
  readonly reads: { readonly position: number; readonly length: number }[] = [];
  descriptorTraversalAvailable = true;
  /** Serves at most this many bytes per read so split code points are exercised. */
  maxReadBytes = Number.POSITIVE_INFINITY;
  failNextRead: string | undefined;
  bytesServed = 0;
  private readonly nodes = new WeakMap<TranscriptDirectoryHandle, FakeNode>();
  private nextIdentity = 1;
  private started = 0;
  private liveHandles = 0;
  private nextReadPause: { readonly begin: () => void; readonly wait: Promise<void> } | undefined;

  /** Handles opened and not yet closed; every settled refresh must return to zero. */
  get openHandles(): number { return this.liveHandles }

  /** Pauses exactly one read after it is requested, exposing a deterministic in-flight boundary. */
  pauseNextRead(): { readonly started: Promise<void>; readonly release: () => void } {
    let begin: (() => void) | undefined;
    let release: (() => void) | undefined;
    const started = new Promise<void>((resolve) => { begin = resolve });
    const wait = new Promise<void>((resolve) => { release = resolve });
    this.nextReadPause = { begin: () => { begin?.() }, wait };
    return { started, release: () => { release?.() } };
  }

  createTranscript(text: string): void {
    this.ensureSessions(OWNER).entries.set(FILE, {
      kind: "file",
      bytes: encoder.encode(text),
      identity: this.nextIdentity++,
    });
  }

  appendBytes(bytes: Uint8Array): void {
    const file = this.file(FILE);
    const combined = new Uint8Array(file.bytes.byteLength + bytes.byteLength);
    combined.set(file.bytes);
    combined.set(bytes, file.bytes.byteLength);
    file.bytes = combined;
  }

  append(text: string): void {
    this.appendBytes(encoder.encode(text));
  }

  /** Atomic replacement: same name, new inode. */
  replace(text: string): void {
    this.ensureSessions(OWNER).entries.set(FILE, {
      kind: "file",
      bytes: encoder.encode(text),
      identity: this.nextIdentity++,
    });
  }

  shrink(bytes: number): void {
    const file = this.file(FILE);
    file.bytes = file.bytes.slice(0, bytes);
  }

  replaceNode(name: string, node: FakeNode): void {
    this.ensureSessions(OWNER).entries.set(name, node);
  }

  /** Replaces a traversal component so a pathname-based reopen would resolve elsewhere. */
  swapComponent(component: "pi-subagents" | "owner" | "sessions", node: FakeNode): void {
    if (component === "pi-subagents") { this.root.entries.set("pi-subagents", node); return }
    const managed = this.root.entries.get("pi-subagents");
    if (managed?.kind !== "directory") throw new Error("fixture: managed root missing");
    if (component === "owner") { managed.entries.set(OWNER, node); return }
    const owner = managed.entries.get(OWNER);
    if (owner?.kind !== "directory") throw new Error("fixture: owner partition missing");
    owner.entries.set("sessions", node);
  }

  file(name: string): FakeFile {
    const node = this.ensureSessions(OWNER).entries.get(name);
    if (node?.kind !== "file") throw new Error(`fixture: no transcript named ${name}`);
    return node;
  }

  async openRootDirectoryNoFollow(_path: AbsolutePath): Promise<TranscriptDirectoryHandle> {
    return this.operation(() => this.directoryHandle(this.root));
  }

  async openDirectoryNoFollow(
    parent: TranscriptDirectoryHandle,
    segment: TranscriptPathSegment,
  ): Promise<TranscriptDirectoryHandle> {
    this.segments.push(String(segment));
    return this.operation(() => this.directoryHandle(this.child(parent, String(segment))));
  }

  async openReadOnlyNoFollow(
    parent: TranscriptDirectoryHandle,
    fileName: TranscriptFileName,
  ): Promise<TranscriptReadHandle> {
    this.segments.push(String(fileName));
    return this.operation(() => this.readHandle(this.child(parent, String(fileName))));
  }

  /** Settles every queued read chain, then proves no further work was started. */
  async settleReads(): Promise<void> {
    for (let attempt = 0; attempt < 500; attempt += 1) {
      const before = this.started;
      await new Promise((resolve) => { setTimeout(resolve, 0); });
      if (this.started === before) return;
    }
    throw new Error("fake filesystem never settled");
  }

  /** Resolves one component relative to an open handle; a pathname is never reassembled. */
  private child(parent: TranscriptDirectoryHandle, segment: string): FakeNode {
    if (!this.descriptorTraversalAvailable) throw failure("ENOSYS");
    const node = this.nodes.get(parent);
    if (node === undefined) throw failure("EBADF");
    if (node.kind !== "directory") throw failure("ENOTDIR");
    const child = node.entries.get(segment);
    if (child === undefined) throw failure("ENOENT");
    if (child.kind === "symlink") throw failure("ELOOP");
    return child;
  }

  private ensureSessions(owner: string): FakeDirectory {
    const managed = this.ensureDirectory(this.root, "pi-subagents");
    return this.ensureDirectory(this.ensureDirectory(managed, owner), "sessions");
  }

  private ensureDirectory(parent: FakeDirectory, name: string): FakeDirectory {
    const existing = parent.entries.get(name);
    if (existing?.kind === "directory") return existing;
    const created = directory();
    parent.entries.set(name, created);
    return created;
  }

  private directoryHandle(node: FakeNode): TranscriptDirectoryHandle {
    this.liveHandles += 1;
    let closed = false;
    const handle: TranscriptDirectoryHandle = {
      stat: async () => this.operation(() => ({ directory: node.kind === "directory" })),
      close: async () => this.operation(() => {
        if (closed) return;
        closed = true;
        this.liveHandles -= 1;
      }),
    };
    this.nodes.set(handle, node);
    return handle;
  }

  private readHandle(node: FakeNode): TranscriptReadHandle {
    this.liveHandles += 1;
    let closed = false;
    return {
      stat: async () => this.operation(() => ({
        device: fileDevice(1),
        inode: fileInode(node.kind === "file" ? node.identity : 0),
        size: fileByteLength(node.kind === "file" ? node.bytes.byteLength : 0),
        regular: node.kind === "file",
      })),
      read: async (position: FileOffset, maximum: Utf8Bytes) => {
        const start = Number(position);
        const length = Number(maximum);
        this.reads.push({ position: start, length });
        const pause = this.nextReadPause;
        this.nextReadPause = undefined;
        if (pause !== undefined) {
          pause.begin();
          await pause.wait;
        }
        return this.operation(() => {
          const pendingFailure = this.failNextRead;
          if (pendingFailure !== undefined) { this.failNextRead = undefined; throw failure(pendingFailure) }
          if (node.kind !== "file") throw failure("EBADF");
          const served = node.bytes.slice(start, start + Math.min(length, this.maxReadBytes));
          this.bytesServed += served.byteLength;
          return served;
        });
      },
      close: async () => this.operation(() => {
        if (closed) return;
        closed = true;
        this.liveHandles -= 1;
      }),
    };
  }

  private async operation<T>(action: () => T): Promise<T> {
    this.started += 1;
    await Promise.resolve();
    return action();
  }
}

class FakeWatchHandle implements TranscriptWatch {
  closed = 0;

  constructor(
    private readonly onChange: () => void,
    private readonly onUnavailable: () => void,
  ) {}

  dispose(): void { this.closed += 1 }

  emit(event: "change" | "error" | "close"): void {
    if (event === "change") { this.onChange(); return }
    this.onUnavailable();
  }
}

class FakeWatchFactory implements TranscriptFileWatcherFactory {
  readonly handles: FakeWatchHandle[] = [];
  readonly directories: string[] = [];
  attempts = 0;
  failing = false;

  watch(directory_: AbsolutePath, onChange: () => void, onUnavailable: () => void): TranscriptWatch {
    this.attempts += 1;
    this.directories.push(String(directory_));
    if (this.failing) throw failure("ENOSYS");
    const handle = new FakeWatchHandle(onChange, onUnavailable);
    this.handles.push(handle);
    return handle;
  }

  get live(): FakeWatchHandle {
    const handle = this.handles.at(-1);
    if (handle === undefined) throw new Error("fixture: no watch handle");
    return handle;
  }
}

interface FakeTimer {
  readonly due: number;
  readonly delay: number;
  readonly callback: () => void;
}

class FakeClock implements TranscriptRefreshClock {
  private readonly timers = new Map<number, FakeTimer>();
  private nextTimer = 1;
  private current = 0;

  get pending(): number { return this.timers.size }

  /** Fallback polling is a re-armed one-shot, so it is counted by its delay, not by kind. */
  get fallbackTimers(): number {
    return [...this.timers.values()]
      .filter((timer) => timer.delay === Number(TRANSCRIPT_FALLBACK_INTERVAL_MS)).length;
  }

  schedule(delay: Milliseconds, callback: () => void): TranscriptScheduledTask {
    const id = this.nextTimer++;
    this.timers.set(id, { due: this.current + Number(delay), delay: Number(delay), callback });
    return { cancel: () => { this.timers.delete(id) } };
  }

  advance(by: number): void {
    this.current += by;
    for (const [id, timer] of [...this.timers]) {
      if (timer.due > this.current) continue;
      this.timers.delete(id);
      timer.callback();
    }
  }
}

interface Harness {
  readonly filesystem: FakeTranscriptFileSystem;
  readonly watchFactory: FakeWatchFactory;
  readonly clock: FakeClock;
  readonly diagnostics: string[];
  readonly source: AuthoritativeTranscriptSource;
  /** Drives one coalesced watch-event refresh to completion. */
  refresh(): Promise<void>;
  dispose(): void;
}

/** Builds the adapters over `text`, starts the source and (by default) holds one subscriber. */
function startedOver(text: string, options: {
  readonly displayState?: AgentDisplayState;
  readonly subscribe?: boolean;
} = {}): Harness {
  const filesystem = new FakeTranscriptFileSystem();
  const watchFactory = new FakeWatchFactory();
  const clock = new FakeClock();
  const diagnostics: string[] = [];
  filesystem.createTranscript(text);
  const source = createSessionTranscriptSource(ROUTE, {
    agentDir: AGENT_DIR,
    filesystem,
    watcher: watchFactory,
    clock,
    onDiagnostic: (code) => { diagnostics.push(code) },
  });
  if (options.displayState !== undefined) source.setDisplayState(options.displayState);
  const unsubscribe = options.subscribe === false ? undefined : source.subscribe(() => {});
  return {
    filesystem,
    watchFactory,
    clock,
    diagnostics,
    source,
    refresh: async (): Promise<void> => {
      watchFactory.live.emit("change");
      clock.advance(Number(TRANSCRIPT_REFRESH_WINDOW_MS));
      await filesystem.settleReads();
    },
    dispose: (): void => {
      unsubscribe?.();
      source.dispose();
    },
  };
}

// --- Structural decoding ---------------------------------------------------

describe("decodeTranscriptSessionHeader", () => {
  test.each([
    ["version 1 omitting the field", { type: "session", id: CHILD }, 1],
    ["version 1 stating the field", { type: "session", id: CHILD, version: 1 }, 1],
    ["version 2", { type: "session", id: CHILD, version: 2 }, 2],
    ["version 3", { type: "session", id: CHILD, version: 3 }, 3],
  ] as const)("decodes %s", (_name, value, version) => {
    expect(decodeTranscriptSessionHeader(value)).toEqual({ version, sessionId: agentId(CHILD) });
  });

  test.each([
    ["an entry record", { type: "message", id: "11111111", parentId: null }],
    ["an unsupported future version", { type: "session", id: CHILD, version: 4 }],
    ["a non-integer version", { type: "session", id: CHILD, version: 1.5 }],
    ["a malformed session id", { type: "session", id: "-not-valid-" }],
    ["a missing session id", { type: "session" }],
    ["a non-record", "session"],
  ])("rejects %s", (_name, value) => {
    expect(decodeTranscriptSessionHeader(value)).toBeUndefined();
  });
});

describe("decodeTranscriptSessionEntry", () => {
  test("decodes string user content as one text block", () => {
    expect(decodeTranscriptSessionEntry(JSON.parse(messageEntry("11111111", null, userMessage("question")))))
      .toEqual({
        id: sessionEntryId("11111111"),
        parentId: null,
        kind: "message",
        message: { role: "user", content: [{ kind: "text", text: "question" }] },
      });
  });

  test("decodes block-array user content and ignores images", () => {
    const value: unknown = JSON.parse(messageEntry("11111111", null, userMessage([
      { type: "text", text: "look" },
      { type: "image", data: "AAAA", mimeType: "image/png" },
    ])));
    expect(decodeTranscriptSessionEntry(value)).toMatchObject({
      message: { role: "user", content: [{ kind: "text", text: "look" }, { kind: "ignored" }] },
    });
  });

  test("preserves ordered assistant text, thinking and tool calls", () => {
    const value: unknown = JSON.parse(messageEntry("22222222", "11111111", assistantMessage([
      { type: "thinking", thinking: "reason" },
      { type: "text", text: "answer" },
      { type: "toolCall", id: "call-1", name: "read", arguments: {} },
    ])));
    expect(decodeTranscriptSessionEntry(value)).toEqual({
      id: sessionEntryId("22222222"),
      parentId: sessionEntryId("11111111"),
      kind: "message",
      message: {
        role: "assistant",
        content: [
          { kind: "thinking", text: "reason" },
          { kind: "text", text: "answer" },
          { kind: "tool-call", callId: "call-1", tool: "read" },
        ],
      },
    });
  });

  test.each([
    ["successful", false],
    ["error", true],
  ])("decodes a %s tool result", (_name, isError) => {
    const value: unknown = JSON.parse(
      messageEntry("33333333", "22222222", toolResultMessage("call-1", "read", "out", isError)),
    );
    expect(decodeTranscriptSessionEntry(value)).toMatchObject({
      message: {
        role: "tool-result",
        callId: "call-1",
        tool: "read",
        error: isError,
        content: [{ kind: "text", text: "out" }],
      },
    });
  });

  test.each([
    ["a custom entry", { type: "custom", id: "44444444", parentId: "33333333", customType: "x", data: {} }],
    ["a model change", { type: "model_change", id: "44444444", parentId: "33333333", provider: "p", modelId: "m" }],
    ["a label", { type: "label", id: "44444444", parentId: "33333333", targetId: "11111111", label: "x" }],
    ["an unknown future type", { type: "future_entry", id: "44444444", parentId: "33333333" }],
  ])("structurally accepts %s as non-conversation", (_name, value) => {
    expect(decodeTranscriptSessionEntry(value)).toEqual({
      id: sessionEntryId("44444444"),
      parentId: sessionEntryId("33333333"),
      kind: "non-conversation",
    });
  });

  test.each([
    ["a custom message role", "custom"],
    ["a notification role", "notification"],
    ["the migrated hook message role", "hookMessage"],
  ])("treats %s as a non-conversation message", (_name, role) => {
    expect(decodeTranscriptSessionEntry(JSON.parse(messageEntry("55555555", null, { role, content: "x" }))))
      .toMatchObject({ kind: "message", message: { role: "non-conversation" } });
  });

  test("decodes the compaction form carrying a first kept entry id", () => {
    expect(decodeTranscriptSessionEntry({
      type: "compaction", id: "66666666", parentId: "11111111",
      summary: "summarised history", firstKeptEntryId: "22222222", tokensBefore: 10,
    })).toEqual({
      id: sessionEntryId("66666666"),
      parentId: sessionEntryId("11111111"),
      kind: "compaction",
      firstKeptEntryId: sessionEntryId("22222222"),
      retainedTailPresent: false,
    });
  });

  test("decodes the compaction form carrying a retained tail", () => {
    expect(decodeTranscriptSessionEntry({
      type: "compaction", id: "66666666", parentId: "11111111",
      summary: "summarised history", retainedTail: [{ role: "user", content: "kept" }],
    })).toEqual({
      id: sessionEntryId("66666666"),
      parentId: sessionEntryId("11111111"),
      kind: "compaction",
      retainedTailPresent: true,
    });
  });

  test.each([
    ["a missing entry id", { type: "message", parentId: null, message: { role: "user", content: "x" } }],
    ["a non-native entry id", { type: "message", id: "not-hex", parentId: null, message: { role: "user", content: "x" } }],
    ["a non-native parent id", { type: "message", id: "11111111", parentId: "zzzz", message: { role: "user", content: "x" } }],
    ["a missing parent field", { type: "message", id: "11111111", message: { role: "user", content: "x" } }],
    ["a malformed user content type", { type: "message", id: "11111111", parentId: null, message: { role: "user", content: 7 } }],
    ["a malformed assistant content type", { type: "message", id: "11111111", parentId: null, message: { role: "assistant", content: "text" } }],
    ["a tool result without a call id", { type: "message", id: "11111111", parentId: null, message: { role: "toolResult", toolName: "read", content: [], isError: false } }],
    ["a malformed first kept entry id", { type: "compaction", id: "66666666", parentId: null, summary: "s", firstKeptEntryId: "zz" }],
    ["a non-array retained tail", { type: "compaction", id: "66666666", parentId: null, summary: "s", retainedTail: "kept" }],
    ["a non-record", 7],
  ])("rejects %s", (_name, value) => {
    expect(decodeTranscriptSessionEntry(value)).toBeUndefined();
  });
});

// --- Active-branch acquisition ---------------------------------------------

describe("createSessionTranscriptSource", () => {
  test("publishes revision zero while the initial read is pending, then the active branch", async () => {
    const started = startedOver(conversationText());

    expect(started.source.snapshot()).toMatchObject({ revision: transcriptRevision(0), items: [] });
    await started.filesystem.settleReads();

    expect(started.source.snapshot()).toMatchObject({
      items: [
        { runId: runId("11111111"), kind: "user", text: transcriptText("question") },
        { runId: runId("11111111"), kind: "thinking", phase: "final", text: transcriptText("reason") },
        { runId: runId("11111111"), kind: "assistant", phase: "final", text: transcriptText("answer") },
        { runId: runId("11111111"), kind: "tool", phase: "completed", tool: toolDisplayName("read") },
      ],
      availability: "live",
      truncatedBefore: false,
    });
    expect(Number(started.source.snapshot().revision)).toBeGreaterThan(0);
    expect(started.filesystem.openHandles).toBe(0);
    started.dispose();
  });

  test("marks a failed tool result and ignores an unmatched one", async () => {
    const started = startedOver(jsonl(
      header(),
      messageEntry("11111111", null, userMessage("question")),
      messageEntry("22222222", "11111111", assistantMessage([
        { type: "toolCall", id: "call-1", name: "read", arguments: {} },
      ])),
      messageEntry("33333333", "22222222", toolResultMessage("call-1", "read", "boom", true)),
      messageEntry("44444444", "33333333", toolResultMessage("call-absent", "read", "ignored")),
    ));
    await started.filesystem.settleReads();

    const items = started.source.snapshot().items;
    expect(items).toHaveLength(2);
    expect(items[1]).toMatchObject({
      kind: "tool",
      phase: "failed",
      tool: toolDisplayName("read"),
      preview: transcriptText("boom"),
    });
    started.dispose();
  });

  test("follows the latest appended leaf when the branch moves", async () => {
    const started = startedOver(jsonl(
      header(),
      messageEntry("11111111", null, userMessage("first")),
      messageEntry("22222222", "11111111", assistantMessage([{ type: "text", text: "first answer" }])),
    ));
    await started.filesystem.settleReads();
    expect(started.source.snapshot().items.map((item) => item.kind)).toEqual(["user", "assistant"]);

    started.filesystem.append(jsonl(
      messageEntry("33333333", "11111111", assistantMessage([{ type: "text", text: "second answer" }])),
    ));
    await started.refresh();

    expect(started.source.snapshot().items).toMatchObject([
      { kind: "user", text: transcriptText("first") },
      { kind: "assistant", text: transcriptText("second answer") },
    ]);
    started.dispose();
  });

  test("marks a branch whose ancestor is unavailable as truncated without fabricating a run", async () => {
    const started = startedOver(jsonl(
      header(),
      messageEntry("22222222", "11111111", assistantMessage([{ type: "text", text: "orphaned answer" }])),
    ));
    await started.filesystem.settleReads();

    expect(started.source.snapshot().truncatedBefore).toBe(true);
    expect(started.source.snapshot().items).toHaveLength(1);
    expect(started.source.snapshot().items[0]).not.toHaveProperty("runId");
    started.dispose();
  });

  test("renders history either side of a compaction once behind a single notice", async () => {
    const started = startedOver(jsonl(
      header(),
      messageEntry("11111111", null, userMessage("before")),
      messageEntry("22222222", "11111111", assistantMessage([{ type: "text", text: "before answer" }])),
      JSON.stringify({
        type: "compaction", id: "66666666", parentId: "22222222",
        summary: "never displayed", firstKeptEntryId: "22222222", tokensBefore: 9,
      }),
      messageEntry("77777777", "66666666", userMessage("after")),
    ));
    await started.filesystem.settleReads();

    expect(started.source.snapshot().items).toMatchObject([
      { kind: "user", text: transcriptText("before") },
      { kind: "assistant", text: transcriptText("before answer") },
      { kind: "notice", code: "context-compacted" },
      { kind: "user", text: transcriptText("after") },
    ]);
    expect(JSON.stringify(started.source.snapshot().items)).not.toContain("never displayed");
    started.dispose();
  });

  test("describes an unavailable pre-compaction ancestor with truncation only", async () => {
    const started = startedOver(jsonl(
      header(),
      JSON.stringify({
        type: "compaction", id: "66666666", parentId: "22222222",
        summary: "never displayed", retainedTail: [{ role: "user", content: "kept" }],
      }),
      messageEntry("77777777", "66666666", userMessage("after")),
    ));
    await started.filesystem.settleReads();

    expect(started.source.snapshot().truncatedBefore).toBe(true);
    expect(started.source.snapshot().items).toMatchObject([
      { kind: "notice", code: "context-compacted" },
      { kind: "user", text: transcriptText("after") },
    ]);
    expect(JSON.stringify(started.source.snapshot().items)).not.toContain("kept");
    started.dispose();
  });

  test("omits the run only from a leading tail whose user entry fell outside the bounded suffix", async () => {
    const records = [header(), messageEntry("11111111", null, userMessage("oldest"))];
    let parent = "11111111";
    for (let index = 0; index < MAX_TRANSCRIPT_SOURCE_ITEMS + 20; index += 1) {
      const id = (index + 0x20000000).toString(16).padStart(8, "0");
      records.push(messageEntry(id, parent, assistantMessage([{ type: "text", text: `answer ${index}` }])));
      parent = id;
    }
    const started = startedOver(jsonl(...records));
    await started.filesystem.settleReads();

    const snapshot = started.source.snapshot();
    expect(snapshot.truncatedBefore).toBe(true);
    expect(snapshot.items.length).toBeLessThanOrEqual(MAX_TRANSCRIPT_SOURCE_ITEMS);
    expect(snapshot.items.every((item) => !("runId" in item))).toBe(true);
    started.dispose();
  });

  test("evicts multibyte projected text by encoded UTF-8 bytes", async () => {
    const records = [header()];
    let parent: string | null = null;
    for (let index = 0; index < MAX_TRANSCRIPT_SOURCE_ITEMS; index += 1) {
      const id = (index + 0x20000000).toString(16).padStart(8, "0");
      records.push(messageEntry(id, parent, assistantMessage([{ type: "text", text: "界".repeat(1_024) }])));
      parent = id;
    }
    const started = startedOver(jsonl(...records));
    await started.filesystem.settleReads();

    const retainedBytes = started.source.snapshot().items
      .reduce((total, item) => total + encoder.encode(JSON.stringify(item)).byteLength, 0);
    expect(retainedBytes).toBeLessThanOrEqual(Number(MAX_TRANSCRIPT_SOURCE_BYTES));
    expect(started.source.snapshot().truncatedBefore).toBe(true);
    started.dispose();
  });

  // --- Framing and path hardening ------------------------------------------

  test("retains an incomplete tail and a code point split across reads", async () => {
    const trailing = encoder.encode(
      messageEntry("22222222", "11111111", assistantMessage([{ type: "text", text: "café" }])),
    );
    const split = trailing.byteLength - 3;
    const started = startedOver(jsonl(header(), messageEntry("11111111", null, userMessage("question"))));
    started.filesystem.maxReadBytes = 7;
    await started.filesystem.settleReads();
    expect(started.source.snapshot().items).toHaveLength(1);

    started.filesystem.appendBytes(trailing.subarray(0, split));
    await started.refresh();
    expect(started.source.snapshot().items).toHaveLength(1);

    started.filesystem.appendBytes(trailing.subarray(split));
    started.filesystem.append("\n");
    await started.refresh();

    expect(started.source.snapshot().items).toMatchObject([
      { kind: "user" },
      { kind: "assistant", text: transcriptText("café") },
    ]);
    started.dispose();
  });

  test("refuses a completed malformed record atomically and retains the last valid items", async () => {
    const started = startedOver(conversationText());
    await started.filesystem.settleReads();
    const valid = started.source.snapshot().items;

    started.filesystem.append("{not json\n");
    await started.refresh();

    expect(started.source.snapshot().items).toEqual(valid);
    expect(started.source.snapshot().availability).toBe("unavailable");
    expect(started.diagnostics).toContain(WidgetDiagnosticCode.TranscriptMalformed);
    started.dispose();
  });

  test("refuses a record above the ordinary record bound", async () => {
    const started = startedOver(conversationText());
    await started.filesystem.settleReads();

    started.filesystem.append(`${JSON.stringify({
      type: "message", id: "44444444", parentId: "33333333",
      message: userMessage("x".repeat(Number(MAX_RPC_RECORD_BYTES) + 16)),
    })}\n`);
    await started.refresh();

    expect(started.source.snapshot().availability).toBe("unavailable");
    expect(started.diagnostics).toContain(WidgetDiagnosticCode.TranscriptOversized);
    started.dispose();
  });

  test("refuses a completed header above the ordinary record bound before decoding it", async () => {
    const oversizedHeader = JSON.stringify({
      type: "session",
      id: CHILD,
      padding: "x".repeat(Number(MAX_RPC_RECORD_BYTES) + 16),
    });
    const started = startedOver(jsonl(oversizedHeader, messageEntry("11111111", null, userMessage("question"))));
    await started.filesystem.settleReads();

    expect(started.source.snapshot().availability).toBe("unavailable");
    expect(started.diagnostics).toContain(WidgetDiagnosticCode.TranscriptOversized);
    started.dispose();
  });

  test("rebuilds from a bounded suffix when a valid append exceeds the recovery span", async () => {
    const started = startedOver(conversationText());
    await started.filesystem.settleReads();
    const records: string[] = [];
    let parent = "33333333";
    for (let index = 0; index < 4_200; index += 1) {
      const id = (index + 0x30000000).toString(16).padStart(8, "0");
      records.push(messageEntry(id, parent, assistantMessage([{ type: "text", text: "x".repeat(8_192) }])));
      parent = id;
    }
    started.filesystem.bytesServed = 0;
    started.filesystem.append(jsonl(...records));
    await started.refresh();

    expect(started.filesystem.bytesServed).toBeLessThanOrEqual(Number(MAX_SESSION_RECOVERY_BYTES));
    expect(started.source.snapshot().truncatedBefore).toBe(true);
    expect(started.source.snapshot().items.at(-1)).toMatchObject({ kind: "assistant" });
    started.dispose();
  });

  test("inspects no more than the authoritative recovery span", async () => {
    const filler = "f".repeat(Number(MAX_SESSION_RECOVERY_BYTES) + 8 * 1024 * 1024);
    const started = startedOver(`${header()}\n${filler}\n${jsonl(
      messageEntry("11111111", null, userMessage("late question")),
      messageEntry("22222222", "11111111", assistantMessage([{ type: "text", text: "late answer" }])),
    )}`);
    await started.filesystem.settleReads();

    const size = started.filesystem.file(FILE).bytes.byteLength;
    expect(started.filesystem.bytesServed).toBeLessThan(size);
    expect(started.filesystem.bytesServed)
      .toBeLessThanOrEqual(Number(MAX_SESSION_RECOVERY_BYTES));
    expect(started.source.snapshot().items).toMatchObject([
      { kind: "user", text: transcriptText("late question") },
      { kind: "assistant", text: transcriptText("late answer") },
    ]);
    expect(started.source.snapshot().truncatedBefore).toBe(true);
    started.dispose();
  });

  test.each([
    ["a symlinked managed root", "pi-subagents"],
    ["a symlinked owner partition", "owner"],
    ["a symlinked sessions directory", "sessions"],
  ] as const)("refuses %s", async (_name, component) => {
    const started = startedOver(conversationText());
    await started.filesystem.settleReads();

    started.filesystem.swapComponent(component, { kind: "symlink" });
    await started.refresh();

    expect(started.source.snapshot().availability).toBe("unavailable");
    expect(started.diagnostics).toContain(WidgetDiagnosticCode.TranscriptReadRefused);
    started.dispose();
  });

  test("refuses a non-directory sessions component", async () => {
    const started = startedOver(conversationText());
    await started.filesystem.settleReads();

    started.filesystem.swapComponent("sessions", { kind: "file", bytes: new Uint8Array(0), identity: 99 });
    await started.refresh();

    expect(started.source.snapshot().availability).toBe("unavailable");
    started.dispose();
  });

  test("refuses a transcript that is not a regular file", async () => {
    const started = startedOver(conversationText());
    await started.filesystem.settleReads();

    started.filesystem.replaceNode(FILE, { kind: "fifo" });
    await started.refresh();

    expect(started.source.snapshot().availability).toBe("unavailable");
    started.dispose();
  });

  test("refuses a transcript whose header names another session", async () => {
    const started = startedOver(jsonl(
      header("another-session"),
      messageEntry("11111111", null, userMessage("question")),
    ));
    await started.filesystem.settleReads();

    expect(started.source.snapshot()).toMatchObject({ items: [], availability: "unavailable" });
    expect(started.diagnostics).toContain(WidgetDiagnosticCode.TranscriptReadRefused);
    started.dispose();
  });

  test("refuses the source when descriptor-relative traversal is unavailable", async () => {
    const started = startedOver(conversationText());
    started.filesystem.descriptorTraversalAvailable = false;
    await started.filesystem.settleReads();

    expect(started.source.snapshot().availability).toBe("unavailable");
    expect(Number(started.source.snapshot().revision)).toBeGreaterThan(0);
    expect(started.diagnostics).toContain(WidgetDiagnosticCode.TranscriptReadRefused);
    started.dispose();
  });

  test("traverses only validated separator-free segments below the agent directory", async () => {
    const started = startedOver(conversationText());
    await started.filesystem.settleReads();

    expect(started.filesystem.segments).toEqual(["pi-subagents", OWNER, "sessions", FILE]);
    expect(started.filesystem.segments.every((segment) => !segment.includes("/"))).toBe(true);
    started.dispose();
  });

  test("rebuilds from a replacement and from a shrunken file", async () => {
    const started = startedOver(conversationText());
    await started.filesystem.settleReads();
    expect(started.source.snapshot().items).toHaveLength(4);

    started.filesystem.replace(jsonl(header(), messageEntry("99999999", null, userMessage("replaced"))));
    await started.refresh();
    expect(started.source.snapshot().items).toMatchObject([{ kind: "user", text: transcriptText("replaced") }]);

    started.filesystem.append(jsonl(
      messageEntry("aaaaaaaa", "99999999", assistantMessage([{ type: "text", text: "extra" }])),
    ));
    await started.refresh();
    expect(started.source.snapshot().items).toHaveLength(2);

    started.filesystem.shrink(started.filesystem.file(FILE).bytes.byteLength - 40);
    await started.refresh();
    expect(started.source.snapshot().items).toMatchObject([{ kind: "user", text: transcriptText("replaced") }]);
    started.dispose();
  });

  // --- Scheduling and lifetime ---------------------------------------------

  test("coalesces multiple watch events into one refresh", async () => {
    const started = startedOver(conversationText());
    await started.filesystem.settleReads();
    const before = started.filesystem.reads.length;

    started.watchFactory.live.emit("change");
    started.watchFactory.live.emit("change");
    started.watchFactory.live.emit("change");
    expect(started.filesystem.reads.length).toBe(before);

    started.clock.advance(Number(TRANSCRIPT_REFRESH_WINDOW_MS));
    await started.filesystem.settleReads();
    const afterFirst = started.filesystem.reads.length;
    expect(afterFirst).toBeGreaterThan(before);

    started.clock.advance(Number(TRANSCRIPT_REFRESH_WINDOW_MS));
    await started.filesystem.settleReads();
    expect(started.filesystem.reads.length).toBe(afterFirst);
    started.dispose();
  });

  test("allows one active refresh plus at most one pending refresh", async () => {
    const started = startedOver(conversationText());
    for (let event = 0; event < 5; event += 1) {
      started.watchFactory.live.emit("change");
      started.clock.advance(Number(TRANSCRIPT_REFRESH_WINDOW_MS));
    }
    await started.filesystem.settleReads();

    const opens = started.filesystem.segments.filter((segment) => segment === FILE).length;
    expect(opens).toBeGreaterThanOrEqual(1);
    expect(opens).toBeLessThanOrEqual(2);
    started.dispose();
  });

  test("polls only after watch loss and cancels polling once the watch recovers", async () => {
    const started = startedOver(conversationText());
    await started.filesystem.settleReads();
    expect(started.clock.fallbackTimers).toBe(0);

    started.watchFactory.failing = true;
    started.watchFactory.live.emit("error");
    expect(started.clock.fallbackTimers).toBe(1);
    expect(started.diagnostics).toContain(WidgetDiagnosticCode.TranscriptWatchFallback);
    const attemptsAtLoss = started.watchFactory.attempts;

    const before = started.filesystem.reads.length;
    started.clock.advance(Number(TRANSCRIPT_FALLBACK_INTERVAL_MS));
    await started.filesystem.settleReads();
    expect(started.filesystem.reads.length).toBeGreaterThan(before);
    expect(started.watchFactory.attempts).toBeGreaterThan(attemptsAtLoss);

    started.watchFactory.failing = false;
    started.clock.advance(Number(TRANSCRIPT_FALLBACK_INTERVAL_MS));
    await started.filesystem.settleReads();
    expect(started.clock.fallbackTimers).toBe(0);
    expect(started.diagnostics.filter((code) => code === WidgetDiagnosticCode.TranscriptWatchFallback))
      .toHaveLength(1);
    started.dispose();
  });

  test("removes throwing and thenable subscribers without blocking healthy ones", async () => {
    const started = startedOver(conversationText());
    await started.filesystem.settleReads();
    let throwing = 0;
    let thenable = 0;
    let healthy = 0;
    started.source.subscribe(() => { throwing += 1; throw new Error("subscriber boom") });
    started.source.subscribe(() => {
      thenable += 1;
      return { then: () => {} };
    });
    started.source.subscribe(() => { healthy += 1 });

    started.filesystem.append(jsonl(messageEntry("44444444", "33333333", userMessage("next"))));
    await started.refresh();
    started.filesystem.append(jsonl(messageEntry("55555555", "44444444", userMessage("later"))));
    await started.refresh();

    expect(throwing).toBe(1);
    expect(thenable).toBe(1);
    expect(healthy).toBe(2);
    started.dispose();
  });

  test("owns no watch with zero subscribers, keeps one dormant snapshot and resumes by rebuilding", async () => {
    const started = startedOver(conversationText(), { subscribe: false });
    await started.filesystem.settleReads();
    expect(started.watchFactory.handles).toHaveLength(0);

    const unsubscribe = started.source.subscribe(() => {});
    expect(started.watchFactory.handles).toHaveLength(1);
    unsubscribe();
    expect(started.watchFactory.live.closed).toBe(1);
    expect(started.clock.pending).toBe(0);
    expect(started.source.snapshot().items).toHaveLength(4);

    started.filesystem.append(jsonl(messageEntry("44444444", "33333333", userMessage("resumed"))));
    started.source.subscribe(() => {});
    await started.filesystem.settleReads();

    expect(started.watchFactory.handles).toHaveLength(2);
    expect(started.source.snapshot().items.at(-1))
      .toMatchObject({ kind: "user", text: transcriptText("resumed") });
    expect(started.filesystem.openHandles).toBe(0);
    started.dispose();
  });

  test("disposal is idempotent and releases every adapter", async () => {
    const started = startedOver(conversationText());
    await started.filesystem.settleReads();

    started.source.dispose();
    started.source.dispose();

    expect(started.watchFactory.live.closed).toBeGreaterThanOrEqual(1);
    expect(started.clock.pending).toBe(0);
    expect(started.filesystem.openHandles).toBe(0);
  });

  // --- Post-terminal end-of-file proof --------------------------------------

  test("proves end of file only for a refresh requested after the terminal transition", async () => {
    const started = startedOver(conversationText(), { displayState: AgentState.Running });
    await started.filesystem.settleReads();
    expect(started.source.postTerminalEndReached()).toBe(false);

    started.source.setDisplayState(CompletionState.Completed);
    expect(started.source.postTerminalEndReached()).toBe(false);
    started.clock.advance(Number(TRANSCRIPT_REFRESH_WINDOW_MS));
    await started.filesystem.settleReads();

    expect(started.source.postTerminalEndReached()).toBe(true);
    expect(started.source.snapshot().availability).toBe("stopped");
    started.dispose();
  });

  test("publishes live availability immediately when a completed source becomes active", async () => {
    const started = startedOver(conversationText(), { displayState: AgentState.Running });
    await started.filesystem.settleReads();
    started.source.setDisplayState(CompletionState.Completed);
    started.clock.advance(Number(TRANSCRIPT_REFRESH_WINDOW_MS));
    await started.filesystem.settleReads();
    expect(started.source.snapshot().availability).toBe("stopped");
    expect(started.source.postTerminalEndReached()).toBe(true);

    started.source.setDisplayState(AgentState.Running);

    expect(started.source.snapshot().availability).toBe("live");
    expect(started.source.postTerminalEndReached()).toBe(false);
    started.dispose();
  });

  test("retains unavailable availability when a failed terminal source becomes active", async () => {
    const started = startedOver(conversationText(), { displayState: AgentState.Running });
    await started.filesystem.settleReads();
    started.source.setDisplayState(CompletionState.Completed);
    started.filesystem.failNextRead = "EIO";
    started.clock.advance(Number(TRANSCRIPT_REFRESH_WINDOW_MS));
    await started.filesystem.settleReads();
    expect(started.source.snapshot().availability).toBe("unavailable");

    started.source.setDisplayState(AgentState.Running);

    expect(started.source.snapshot().availability).toBe("unavailable");
    await started.refresh();
    expect(started.source.snapshot().availability).toBe("live");
    started.dispose();
  });

  test("publishes live availability when a terminal refresh becomes active in flight", async () => {
    const started = startedOver(conversationText(), { displayState: AgentState.Running });
    await started.filesystem.settleReads();
    started.source.setDisplayState(CompletionState.Completed);
    const pausedRead = started.filesystem.pauseNextRead();
    started.clock.advance(Number(TRANSCRIPT_REFRESH_WINDOW_MS));
    await pausedRead.started;

    started.source.setDisplayState(AgentState.Running);
    pausedRead.release();
    await started.filesystem.settleReads();

    expect(started.source.snapshot().availability).toBe("live");
    expect(started.source.postTerminalEndReached()).toBe(false);
    started.dispose();
  });

  test("publishes no revision when a refresh reprojects an unchanged branch", async () => {
    const started = startedOver(conversationText());
    await started.filesystem.settleReads();
    const before = started.source.snapshot().revision;
    let notifications = 0;
    started.source.subscribe(() => { notifications += 1 });

    await started.refresh();
    await started.refresh();

    expect(started.source.snapshot().revision).toBe(before);
    expect(notifications).toBe(0);
    started.dispose();
  });

  test("publishes a fresh revision when only the end-of-file proof changes", async () => {
    const started = startedOver(conversationText(), { displayState: AgentState.Running });
    await started.filesystem.settleReads();
    const before = started.source.snapshot().revision;
    let notifications = 0;
    started.source.subscribe(() => { notifications += 1 });

    started.source.setDisplayState(CompletionState.Completed);
    started.clock.advance(Number(TRANSCRIPT_REFRESH_WINDOW_MS));
    await started.filesystem.settleReads();

    expect(Number(started.source.snapshot().revision)).toBeGreaterThan(Number(before));
    expect(notifications).toBeGreaterThanOrEqual(1);
    started.dispose();
  });

  test("revises proof-only clear and re-establishment without transcript changes", async () => {
    const started = startedOver(conversationText(), { displayState: AgentState.Running });
    await started.filesystem.settleReads();
    started.source.setDisplayState(CompletionState.Completed);
    started.clock.advance(Number(TRANSCRIPT_REFRESH_WINDOW_MS));
    await started.filesystem.settleReads();
    expect(started.source.postTerminalEndReached()).toBe(true);
    const provedRevision = started.source.snapshot().revision;
    let notifications = 0;
    started.source.subscribe(() => { notifications += 1 });

    started.source.setDisplayState(AgentState.Running);

    expect(started.source.postTerminalEndReached()).toBe(false);
    expect(Number(started.source.snapshot().revision)).toBeGreaterThan(Number(provedRevision));

    const clearedRevision = started.source.snapshot().revision;
    started.source.setDisplayState(CompletionState.Completed);
    started.clock.advance(Number(TRANSCRIPT_REFRESH_WINDOW_MS));
    await started.filesystem.settleReads();

    expect(started.source.postTerminalEndReached()).toBe(true);
    expect(Number(started.source.snapshot().revision)).toBeGreaterThan(Number(clearedRevision));
    expect(notifications).toBe(2);
    started.dispose();
  });

  test("withholds proof when the final append arrives before the coalesced refresh settles", async () => {
    const started = startedOver(conversationText(), { displayState: AgentState.Running });
    await started.filesystem.settleReads();

    started.source.setDisplayState(CompletionState.Completed);
    started.filesystem.append(jsonl(messageEntry("44444444", "33333333", userMessage("final append"))));
    await started.refresh();

    expect(started.source.snapshot().items.at(-1))
      .toMatchObject({ kind: "user", text: transcriptText("final append") });
    expect(started.source.postTerminalEndReached()).toBe(false);

    started.source.setDisplayState(AgentState.Running);
    started.source.setDisplayState(CompletionState.Completed);
    started.clock.advance(Number(TRANSCRIPT_REFRESH_WINDOW_MS));
    await started.filesystem.settleReads();
    expect(started.source.postTerminalEndReached()).toBe(true);
    started.dispose();
  });

  test.each([
    ["an active display state", (source: AuthoritativeTranscriptSource) => { source.setDisplayState(AgentState.Running) }],
    ["route loss", (source: AuthoritativeTranscriptSource) => { source.markRouteUnavailable() }],
  ] as const)("clears the proof on %s", async (_name, invalidate) => {
    const started = startedOver(conversationText(), { displayState: AgentState.Running });
    await started.filesystem.settleReads();
    started.source.setDisplayState(CompletionState.Completed);
    started.clock.advance(Number(TRANSCRIPT_REFRESH_WINDOW_MS));
    await started.filesystem.settleReads();
    expect(started.source.postTerminalEndReached()).toBe(true);

    invalidate(started.source);

    expect(started.source.postTerminalEndReached()).toBe(false);
    started.dispose();
  });

  test("clears the proof on a read failure and restores it only after a whole successful read", async () => {
    const started = startedOver(conversationText(), { displayState: AgentState.Running });
    await started.filesystem.settleReads();
    started.source.setDisplayState(CompletionState.Completed);
    started.clock.advance(Number(TRANSCRIPT_REFRESH_WINDOW_MS));
    await started.filesystem.settleReads();
    expect(started.source.postTerminalEndReached()).toBe(true);

    started.filesystem.failNextRead = "EIO";
    await started.refresh();
    expect(started.source.snapshot().availability).toBe("unavailable");
    expect(started.source.postTerminalEndReached()).toBe(false);

    started.source.setDisplayState(AgentState.Running);
    started.source.setDisplayState(CompletionState.Completed);
    started.clock.advance(Number(TRANSCRIPT_REFRESH_WINDOW_MS));
    await started.filesystem.settleReads();
    expect(started.source.snapshot().availability).toBe("stopped");
    expect(started.source.postTerminalEndReached()).toBe(true);
    started.dispose();
  });

  test("re-proves the end of file only after rebuilding a replaced transcript", async () => {
    const started = startedOver(conversationText(), { displayState: AgentState.Running });
    await started.filesystem.settleReads();
    started.source.setDisplayState(CompletionState.Completed);
    started.clock.advance(Number(TRANSCRIPT_REFRESH_WINDOW_MS));
    await started.filesystem.settleReads();
    expect(started.source.postTerminalEndReached()).toBe(true);

    started.filesystem.replace(jsonl(header(), messageEntry("99999999", null, userMessage("replaced"))));
    await started.refresh();

    expect(started.source.snapshot().items).toMatchObject([{ kind: "user", text: transcriptText("replaced") }]);
    expect(started.source.postTerminalEndReached()).toBe(false);
    started.dispose();
  });
});
