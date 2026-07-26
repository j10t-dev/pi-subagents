import { constants } from "node:fs";
import { open, type FileHandle } from "node:fs/promises";
import { watch } from "node:fs";
import { join } from "node:path";

import {
  isTerminalDisplayState,
  safeTranscriptText,
  trySafeToolDisplayName,
  type AgentDisplayState,
  type AuthoritativeTranscriptSource,
  type TranscriptItem,
  type TranscriptListener,
  type TranscriptSnapshot,
} from "./agent-observation.ts";
import { createCoalescer } from "./coalescer.ts";
import {
  MAX_RPC_RECORD_BYTES,
  MAX_SESSION_RECOVERY_BYTES,
  MAX_TRANSCRIPT_SOURCE_BYTES,
  MAX_TRANSCRIPT_SOURCE_ITEMS,
  STATE_DIR_NAME,
  TRANSCRIPT_FALLBACK_INTERVAL_MS,
  TRANSCRIPT_REFRESH_WINDOW_MS,
} from "./constants.ts";
import {
  AgentState,
  fileByteLength,
  fileDevice,
  fileInode,
  fileOffset,
  milliseconds,
  runId,
  transcriptPathSegment,
  transcriptRevision,
  transcriptSequence,
  utf8Bytes,
  type AbsolutePath,
  type FileByteLength,
  type FileDevice,
  type FileInode,
  type FileOffset,
  type Milliseconds,
  type SessionEntryId,
  type TranscriptFileName,
  type TranscriptPathSegment,
  type TranscriptRoute,
  type Utf8Bytes,
} from "./domain.ts";
import {
  decodeTranscriptSessionEntry,
  decodeTranscriptSessionHeader,
  type TranscriptSessionEntryRecord,
} from "./schemas.ts";
import { TranscriptDiagnosticCode } from "./widget-diagnostics.ts";

/** Everything a stat can prove about a transcript without trusting the pathname that opened it. */
export interface TranscriptFileIdentity {
  readonly device: FileDevice;
  readonly inode: FileInode;
  readonly size: FileByteLength;
  readonly regular: boolean;
}

/**
 * An open directory. Only its own kind is observable: a directory is a traversal step, never a
 * source of content, so it deliberately exposes less than a read handle.
 */
export interface TranscriptDirectoryHandle {
  stat(): Promise<{ readonly directory: boolean }>;
  close(): Promise<void>;
}

export interface TranscriptReadHandle {
  stat(): Promise<TranscriptFileIdentity>;
  read(position: FileOffset, maximum: Utf8Bytes): Promise<Uint8Array>;
  close(): Promise<void>;
}

/**
 * Descriptor-relative filesystem seam. Every component is opened relative to an already-open
 * parent handle and never followed through a symlink, so no implementation can prove a component
 * by pathname and then reopen it by pathname.
 */
export interface TranscriptFileSystem {
  openRootDirectoryNoFollow(path: AbsolutePath): Promise<TranscriptDirectoryHandle>;
  openDirectoryNoFollow(
    parent: TranscriptDirectoryHandle,
    segment: TranscriptPathSegment,
  ): Promise<TranscriptDirectoryHandle>;
  openReadOnlyNoFollow(
    parent: TranscriptDirectoryHandle,
    fileName: TranscriptFileName,
  ): Promise<TranscriptReadHandle>;
}

export interface TranscriptWatch {
  dispose(): void;
}

export interface TranscriptFileWatcherFactory {
  /** Watches the owner's sessions directory; observation only, never a source of content. */
  watch(directory: AbsolutePath, onChange: () => void, onUnavailable: () => void): TranscriptWatch;
}

export interface TranscriptScheduledTask {
  cancel(): void;
}

export interface TranscriptRefreshClock {
  /** One-shot unref'd timer; repetition is built by re-arming, never by an interval. */
  schedule(delay: Milliseconds, callback: () => void): TranscriptScheduledTask;
}

export interface SessionTranscriptSourceDependencies {
  readonly agentDir: AbsolutePath;
  /** Receives bounded static codes only; exception text, paths and IDs never reach it. */
  readonly onDiagnostic: (code: TranscriptDiagnosticCode) => void;
  readonly filesystem: TranscriptFileSystem;
  readonly watcher: TranscriptFileWatcherFactory;
  readonly clock: TranscriptRefreshClock;
}

const READ_CHUNK_BYTES = 256 * 1024;
const HEADER_CHUNK_BYTES = 8 * 1024;
const SESSIONS_DIR_NAME = "sessions";
const LINE_FEED = 0x0a;
const EMPTY_BYTES: Uint8Array = new Uint8Array(0);
const decoder = new TextDecoder();
const encoder = new TextEncoder();

/**
 * Reads one child session's authoritative JSONL and projects its active conversation branch.
 *
 * The source is the only reader of Pi's own session files: it opens the owner partition
 * descriptor-relative, validates the session header, frames complete LF-terminated records and
 * rebuilds the branch from the latest bounded suffix. It never writes, and it never treats
 * display state as proof that a run has finished.
 */
export function createSessionTranscriptSource(
  route: TranscriptRoute,
  dependencies: SessionTranscriptSourceDependencies,
): AuthoritativeTranscriptSource {
  const deps = dependencies;
  const listeners = new Set<TranscriptListener>();
  const report = (code: TranscriptDiagnosticCode): void => {
    try {
      deps.onDiagnostic(code);
    } catch {
      // A diagnostic sink cannot prevent later refreshes.
    }
  };

  let disposed = false;
  let refreshing = false;
  let pending = false;
  let revision = 0;
  let published: TranscriptSnapshot = frozenSnapshot(0, [], false, "live");
  let displayState: AgentDisplayState = AgentState.Running;
  let terminalGeneration = 0;
  /** Set by any file event; a change seen after termination means the run may not have ended. */
  let changedSinceTerminal = false;
  let endReached = false;
  let everDetached = false;
  let routeAvailable = true;

  const reader = createBranchReader(route, deps);
  let watch: TranscriptWatch | undefined;
  let poll: TranscriptScheduledTask | undefined;
  let fallbackReported = false;

  const coalescer = createCoalescer(
    () => { requestRefresh(); },
    {
      schedule: (callback, delay) => {
        const task = deps.clock.schedule(milliseconds(delay), callback);
        return () => { task.cancel() };
      },
    },
    TRANSCRIPT_REFRESH_WINDOW_MS,
  );

  function requestRefresh(): void {
    if (disposed) return;
    if (refreshing) { pending = true; return }
    refreshing = true;
    void refreshOnce().finally(() => {
      refreshing = false;
      if (pending) { pending = false; requestRefresh() }
    });
  }

  async function refreshOnce(): Promise<void> {
    const generation = terminalGeneration;
    const terminalAtStart = isTerminalDisplayState(displayState);
    const result = await reader.read();
    if (disposed) return;
    if (result.kind === "failed") {
      const proofChanged = clearEndReached();
      report(result.code);
      publish(published.items, published.truncatedBefore, "unavailable", proofChanged);
      return;
    }
    const proofBefore = endReached;
    if (result.rebuilt) endReached = false;
    const terminalNow = isTerminalDisplayState(displayState);
    const proved = terminalAtStart
      && terminalNow
      && generation === terminalGeneration
      && !changedSinceTerminal
      && !pending
      && routeAvailable
      && !result.rebuilt;
    endReached = proved;
    publish(result.items, result.truncatedBefore, terminalNow ? "stopped" : "live", proofBefore !== endReached);
  }

  function clearEndReached(): boolean {
    if (!endReached) return false;
    endReached = false;
    return true;
  }

  function publish(
    items: readonly TranscriptItem[],
    truncatedBefore: boolean,
    availability: TranscriptSnapshot["availability"],
    force = false,
  ): void {
    const first = revision === 0;
    if (!first && !force && !changed(published, items, truncatedBefore, availability)) return;
    revision += 1;
    published = frozenSnapshot(revision, items, truncatedBefore, availability);
    notify();
  }

  function notify(): void {
    for (const listener of [...listeners]) {
      if (!listeners.has(listener)) continue;
      try {
        const result: unknown = listener(published);
        // A listener that defers its work cannot be awaited by a serial refresh.
        if (isThenable(result)) listeners.delete(listener);
      } catch {
        listeners.delete(listener);
      }
    }
    if (listeners.size === 0) detach();
  }

  function attach(): void {
    if (disposed || watch !== undefined || poll !== undefined) return;
    if (!tryInstallWatch()) startPolling();
  }

  /** Installs a directory watch, reporting whether the observation seam is now live. */
  function tryInstallWatch(): boolean {
    if (disposed) return false;
    if (watch !== undefined) return true;
    try {
      watch = deps.watcher.watch(reader.sessionsDirectory, onFileEvent, onWatchLost);
      return true;
    } catch {
      return false;
    }
  }

  function detach(): void {
    const installed = watch;
    watch = undefined;
    if (installed !== undefined) {
      try { installed.dispose() } catch { /* a released watch cannot fail the projection */ }
    }
    poll?.cancel();
    poll = undefined;
    everDetached = true;
    reader.forget();
  }

  function onFileEvent(): void {
    if (disposed) return;
    changedSinceTerminal = true;
    const proofChanged = clearEndReached();
    if (proofChanged) publish(published.items, published.truncatedBefore, published.availability, true);
    coalescer.request();
  }

  function onWatchLost(): void {
    if (disposed || watch === undefined) return;
    const installed = watch;
    watch = undefined;
    try { installed.dispose() } catch { /* the watch is already unusable */ }
    startPolling();
  }

  /** Re-arms a one-shot fallback poll that also retries the watch until it is reinstalled. */
  function startPolling(): void {
    if (disposed || poll !== undefined) return;
    if (!fallbackReported) {
      fallbackReported = true;
      report(TranscriptDiagnosticCode.WatchFallback);
    }
    poll = deps.clock.schedule(TRANSCRIPT_FALLBACK_INTERVAL_MS, () => {
      poll = undefined;
      if (disposed) return;
      if (!tryInstallWatch()) startPolling();
      // Polling is already rate limited by its own delay, so it refreshes without coalescing.
      changedSinceTerminal = true;
      const proofChanged = clearEndReached();
      if (proofChanged) publish(published.items, published.truncatedBefore, published.availability, true);
      requestRefresh();
    });
  }

  requestRefresh();

  return {
    snapshot: (): TranscriptSnapshot => published,
    subscribe: (listener: TranscriptListener): (() => void) => {
      if (disposed) return () => {};
      const wasDormant = listeners.size === 0;
      listeners.add(listener);
      if (wasDormant) {
        attach();
        // A dormant source stops reading, so a re-subscription must rebuild from the file.
        if (everDetached) requestRefresh();
      }
      return () => {
        if (!listeners.delete(listener)) return;
        if (listeners.size === 0) detach();
      };
    },
    setDisplayState: (state: AgentDisplayState): void => {
      if (disposed || state === displayState) return;
      const wasTerminal = isTerminalDisplayState(displayState);
      displayState = state;
      if (isTerminalDisplayState(state)) {
        if (wasTerminal) return;
        terminalGeneration += 1;
        changedSinceTerminal = false;
        const proofChanged = clearEndReached();
        if (proofChanged) publish(published.items, published.truncatedBefore, published.availability, true);
        coalescer.request();
        return;
      }
      const proofChanged = clearEndReached();
      publish(
        published.items,
        published.truncatedBefore,
        published.availability === "unavailable" ? "unavailable" : "live",
        proofChanged,
      );
    },
    markRouteUnavailable: (): void => {
      if (disposed) return;
      const proofChanged = clearEndReached();
      if (proofChanged) publish(published.items, published.truncatedBefore, published.availability, true);
      if (!routeAvailable) return;
      routeAvailable = false;
      report(TranscriptDiagnosticCode.RouteUnavailable);
    },
    postTerminalEndReached: (): boolean => endReached,
    dispose: (): void => {
      if (disposed) return;
      disposed = true;
      listeners.clear();
      detach();
      coalescer.dispose();
    },
  };
}

// --- Bounded branch reading ------------------------------------------------

type ReadResult =
  | { readonly kind: "read"; readonly items: readonly TranscriptItem[]; readonly truncatedBefore: boolean; readonly rebuilt: boolean }
  | { readonly kind: "failed"; readonly code: TranscriptDiagnosticCode };

interface BranchReader {
  readonly sessionsDirectory: AbsolutePath;
  read(): Promise<ReadResult>;
  /** Drops the retained suffix so the next read rebuilds from the file itself. */
  forget(): void;
}

/**
 * Owns the retained byte tail and decoded entry suffix for one route. Every read revalidates the
 * traversal, the regular-file identity and the session header before any byte is interpreted.
 */
function createBranchReader(route: TranscriptRoute, deps: SessionTranscriptSourceDependencies): BranchReader {
  const segments = pathSegments(route);
  const sessionsDirectory = join(
    deps.agentDir,
    STATE_DIR_NAME,
    route.ownerSessionId,
    SESSIONS_DIR_NAME,
  ) as AbsolutePath;

  let identity: TranscriptFileIdentity | undefined;
  let consumed = 0;
  let tail: Uint8Array = EMPTY_BYTES;
  let entries: TranscriptSessionEntryRecord[] = [];
  let truncated = false;

  function forget(): void {
    identity = undefined;
    consumed = 0;
    tail = EMPTY_BYTES;
    entries = [];
    truncated = false;
  }

  async function read(): Promise<ReadResult> {
    if (segments === undefined) return { kind: "failed", code: TranscriptDiagnosticCode.ReadRefused };
    const opened: { close(): Promise<void> }[] = [];
    try {
      let parent = await deps.filesystem.openRootDirectoryNoFollow(deps.agentDir);
      opened.push(parent);
      if (!(await parent.stat()).directory) {
        return { kind: "failed", code: TranscriptDiagnosticCode.ReadRefused };
      }
      for (const segment of segments) {
        const child = await deps.filesystem.openDirectoryNoFollow(parent, segment);
        opened.push(child);
        if (!(await child.stat()).directory) {
          return { kind: "failed", code: TranscriptDiagnosticCode.ReadRefused };
        }
        parent = child;
      }
      const file = await deps.filesystem.openReadOnlyNoFollow(parent, route.fileName);
      opened.push(file);
      const stat = await file.stat();
      if (!stat.regular) return { kind: "failed", code: TranscriptDiagnosticCode.ReadRefused };
      return await readFile(file, stat);
    } catch {
      // Traversal, stat and header failures are indistinguishable to the projection: the
      // transcript is simply unreadable, and no exception detail may escape.
      return { kind: "failed", code: TranscriptDiagnosticCode.ReadRefused };
    } finally {
      for (const handle of opened.reverse()) {
        try { await handle.close() } catch { /* a leaked descriptor is contained */ }
      }
    }
  }

  async function readFile(file: TranscriptReadHandle, stat: TranscriptFileIdentity): Promise<ReadResult> {
    const size = Number(stat.size);
    // The header is revalidated on every refresh, not only on a rebuild: it is the only proof
    // that this handle still holds a transcript belonging to the routed child session.
    const header = await readHeader(file, size);
    if ("kind" in header) return header;
    // Header revalidation and the suffix share one authoritative recovery budget. The header
    // read may have consumed a whole chunk past its LF, so charge every inspected byte.
    const recoveryBytes = Math.max(0, Number(MAX_SESSION_RECOVERY_BYTES) - header.inspectedBytes);
    const rebuilt = !sameFile(identity, stat) || size < consumed;
    // A stable descriptor does not make an arbitrarily large append safe to acquire. Once the
    // unread range would exceed this refresh's remaining span, drop retained branch state and
    // recover only the bounded final suffix.
    const rebuildForLargeAppend = !rebuilt && size - consumed > recoveryBytes;
    const rebuilding = rebuilt || rebuildForLargeAppend;
    if (rebuilding) {
      forget();
      identity = stat;
    }
    const start = rebuilding ? Math.max(0, size - recoveryBytes) : consumed;
    let position = start;
    let carry = rebuilding ? EMPTY_BYTES : tail;
    // A bounded rebuild starts mid-record, so everything before the first framing byte is dropped
    // without ever being retained: the discarded prefix may be far larger than one record.
    let discardPrefix = rebuilding && start > 0;
    if (discardPrefix) truncated = true;

    while (position < size) {
      const chunk = await file.read(
        fileOffset(position),
        utf8Bytes(Math.min(READ_CHUNK_BYTES, size - position)),
      );
      if (chunk.byteLength === 0) break;
      position += chunk.byteLength;
      let scan = chunk;
      if (discardPrefix) {
        const boundary = chunk.indexOf(LINE_FEED);
        if (boundary < 0) continue;
        discardPrefix = false;
        scan = chunk.subarray(boundary + 1);
      } else {
        scan = concat(carry, chunk);
      }
      let lineStart = 0;
      for (let index = 0; index < scan.byteLength; index += 1) {
        if (scan[index] !== LINE_FEED) continue;
        const accepted = accept(scan.subarray(lineStart, index));
        lineStart = index + 1;
        if (accepted !== undefined) return accepted;
      }
      carry = scan.slice(lineStart);
      if (carry.byteLength > Number(MAX_RPC_RECORD_BYTES)) {
        return { kind: "failed", code: TranscriptDiagnosticCode.Oversized };
      }
    }
    consumed = position;
    tail = carry;
    const projection = projectBranch(entries, truncated);
    return { kind: "read", items: projection.items, truncatedBefore: projection.truncatedBefore, rebuilt: rebuilding };
  }

  /** Reads the leading record and proves it names this route's child session. */
  async function readHeader(
    file: TranscriptReadHandle,
    size: number,
  ): Promise<ReadResult | { readonly inspectedBytes: number }> {
    let position = 0;
    let recordBytes = 0;
    const parts: Uint8Array[] = [];
    while (position < size) {
      const chunk = await file.read(
        fileOffset(position),
        utf8Bytes(Math.min(HEADER_CHUNK_BYTES, size - position)),
      );
      if (chunk.byteLength === 0) break;
      position += chunk.byteLength;
      const end = chunk.indexOf(LINE_FEED);
      const lineBytes = end < 0 ? chunk.byteLength : end;
      if (recordBytes + lineBytes > Number(MAX_RPC_RECORD_BYTES)) {
        return { kind: "failed", code: TranscriptDiagnosticCode.Oversized };
      }
      parts.push(chunk.subarray(0, lineBytes));
      recordBytes += lineBytes;
      if (end >= 0) {
        const header = decodeRecord(concatParts(parts, recordBytes), decodeTranscriptSessionHeader);
        return header !== undefined && header.sessionId === route.childSessionId
          ? { inspectedBytes: position }
          : { kind: "failed", code: TranscriptDiagnosticCode.ReadRefused };
      }
    }
    // An empty or headerless file names no session and cannot be attributed to this route.
    return { kind: "failed", code: TranscriptDiagnosticCode.ReadRefused };
  }

  /** Applies one complete record, returning a failure when it cannot be accepted whole. */
  function accept(record: Uint8Array): ReadResult | undefined {
    if (record.byteLength > Number(MAX_RPC_RECORD_BYTES)) {
      return { kind: "failed", code: TranscriptDiagnosticCode.Oversized };
    }
    if (record.byteLength === 0) return undefined;
    const value = parseJson(record);
    if (value === undefined) return { kind: "failed", code: TranscriptDiagnosticCode.Malformed };
    if (decodeTranscriptSessionHeader(value) !== undefined) return undefined;
    const entry = decodeTranscriptSessionEntry(value);
    if (entry === undefined) return { kind: "failed", code: TranscriptDiagnosticCode.Malformed };
    entries.push(entry);
    if (entries.length > MAX_TRANSCRIPT_SOURCE_ITEMS) {
      entries = entries.slice(entries.length - MAX_TRANSCRIPT_SOURCE_ITEMS);
      truncated = true;
    }
    return undefined;
  }

  return { sessionsDirectory, read, forget };
}

/** Validates the two route-derived directory components; an invalid one refuses the source. */
function pathSegments(route: TranscriptRoute): readonly TranscriptPathSegment[] | undefined {
  const segments = [STATE_DIR_NAME, route.ownerSessionId, SESSIONS_DIR_NAME].map(segmentOrUndefined);
  return segments.every((segment) => segment !== undefined) ? segments : undefined;
}

/** Two stats describe the same file only when both device and inode match. */
function sameFile(current: TranscriptFileIdentity | undefined, next: TranscriptFileIdentity): boolean {
  return current !== undefined && current.device === next.device && current.inode === next.inode;
}

// --- Branch projection -----------------------------------------------------

interface BranchProjection {
  readonly items: readonly TranscriptItem[];
  readonly truncatedBefore: boolean;
}

/**
 * Walks the retained suffix from its latest entry back through parent IDs, then projects the
 * reversed path. A run is correlated only by a retained user entry; a leading tail whose user
 * entry fell outside the suffix stays uncorrelated rather than borrowing another entry's ID.
 */
function projectBranch(entries: readonly TranscriptSessionEntryRecord[], truncated: boolean): BranchProjection {
  const retained = new Map<SessionEntryId, TranscriptSessionEntryRecord>();
  for (const entry of entries) retained.set(entry.id, entry);

  const branch: TranscriptSessionEntryRecord[] = [];
  let cursor = entries.at(-1);
  let truncatedBefore = truncated;
  while (cursor !== undefined) {
    branch.push(cursor);
    const parentId = cursor.parentId;
    if (parentId === null) break;
    const parent = retained.get(parentId);
    if (parent === undefined) { truncatedBefore = true; break }
    cursor = parent;
  }
  branch.reverse();

  const items: TranscriptItem[] = [];
  const toolPositions = new Map<string, number>();
  let currentRun: SessionEntryId | undefined;
  for (const entry of branch) {
    if (entry.kind === "non-conversation") continue;
    if (entry.kind === "compaction") {
      items.push({ sequence: transcriptSequence(items.length), kind: "notice", code: "context-compacted" });
      continue;
    }
    const message = entry.message;
    if (message.role === "non-conversation") continue;
    if (message.role === "user") {
      currentRun = entry.id;
      items.push({
        sequence: transcriptSequence(items.length),
        runId: runId(entry.id),
        kind: "user",
        text: safeTranscriptText(joinText(message.content)),
      });
      continue;
    }
    if (message.role === "assistant") {
      for (const block of message.content) {
        if (block.kind === "text" || block.kind === "thinking") {
          items.push({
            sequence: transcriptSequence(items.length),
            ...(currentRun === undefined ? {} : { runId: runId(currentRun) }),
            kind: block.kind === "text" ? "assistant" : "thinking",
            phase: "final",
            text: safeTranscriptText(block.text),
          });
          continue;
        }
        if (block.kind !== "tool-call") continue;
        const tool = trySafeToolDisplayName(block.tool);
        if (tool === undefined) continue;
        toolPositions.set(block.callId, items.length);
        items.push({
          sequence: transcriptSequence(items.length),
          ...(currentRun === undefined ? {} : { runId: runId(currentRun) }),
          kind: "tool",
          tool,
          phase: "running",
        });
      }
      continue;
    }
    const position = toolPositions.get(message.callId);
    if (position === undefined) continue;
    const call = items[position];
    if (call === undefined || call.kind !== "tool") continue;
    const preview = safeTranscriptText(joinText(message.content));
    items[position] = {
      ...call,
      phase: message.error ? "failed" : "completed",
      ...(preview.length === 0 ? {} : { preview }),
    };
  }

  return evictToBounds(items, truncatedBefore);
}

/** Drops complete oldest items until the retained item and byte bounds hold. */
function evictToBounds(items: readonly TranscriptItem[], truncatedBefore: boolean): BranchProjection {
  let first = Math.max(0, items.length - MAX_TRANSCRIPT_SOURCE_ITEMS);
  let bytes = 0;
  for (let index = items.length - 1; index >= first; index -= 1) {
    bytes += itemBytes(items[index]);
    if (bytes > MAX_TRANSCRIPT_SOURCE_BYTES) { first = index + 1; break }
  }
  return {
    items: Object.freeze(items.slice(first)),
    truncatedBefore: truncatedBefore || first > 0,
  };
}

function itemBytes(item: TranscriptItem | undefined): number {
  return item === undefined ? 0 : encoder.encode(JSON.stringify(item)).byteLength;
}

function joinText(content: readonly { readonly kind: string; readonly text?: string }[]): string {
  return content
    .filter((block) => block.kind === "text" && block.text !== undefined)
    .map((block) => block.text ?? "")
    .join(" ");
}

// --- Framing helpers -------------------------------------------------------

function decodeRecord<T>(record: Uint8Array, decode: (value: unknown) => T | undefined): T | undefined {
  const value = parseJson(record);
  return value === undefined ? undefined : decode(value);
}

function parseJson(record: Uint8Array): unknown {
  try {
    return JSON.parse(decoder.decode(record)) as unknown;
  } catch {
    return undefined;
  }
}

function concat(left: Uint8Array, right: Uint8Array): Uint8Array {
  if (left.byteLength === 0) return right;
  if (right.byteLength === 0) return left;
  const combined = new Uint8Array(left.byteLength + right.byteLength);
  combined.set(left);
  combined.set(right, left.byteLength);
  return combined;
}

function concatParts(parts: readonly Uint8Array[], length: number): Uint8Array {
  const combined = new Uint8Array(length);
  let offset = 0;
  for (const part of parts) {
    combined.set(part, offset);
    offset += part.byteLength;
  }
  return combined;
}

function segmentOrUndefined(value: string): TranscriptPathSegment | undefined {
  try {
    return transcriptPathSegment(value);
  } catch {
    return undefined;
  }
}

function frozenSnapshot(
  value: number,
  items: readonly TranscriptItem[],
  truncatedBefore: boolean,
  availability: TranscriptSnapshot["availability"],
): TranscriptSnapshot {
  return Object.freeze({ revision: transcriptRevision(value), items, truncatedBefore, availability });
}

function changed(
  current: TranscriptSnapshot,
  items: readonly TranscriptItem[],
  truncatedBefore: boolean,
  availability: TranscriptSnapshot["availability"],
): boolean {
  return current.availability !== availability
    || current.truncatedBefore !== truncatedBefore
    || !sameItems(current.items, items);
}

/**
 * Every refresh reprojects the whole branch, so a fresh array is not evidence of a change.
 * Items are compared field by field to keep unchanged refreshes from churning the revision.
 */
function sameItems(current: readonly TranscriptItem[], next: readonly TranscriptItem[]): boolean {
  if (current.length !== next.length) return false;
  return current.every((item, index) => {
    const other = next[index];
    if (other === undefined || item.kind !== other.kind) return false;
    if (item.kind === "notice") return other.kind === "notice" && item.code === other.code;
    if (item.kind === "tool") {
      return other.kind === "tool"
        && item.tool === other.tool
        && item.phase === other.phase
        && item.preview === other.preview
        && item.runId === other.runId;
    }
    return (other.kind === "user" || other.kind === "assistant" || other.kind === "thinking")
      && item.text === other.text
      && item.runId === other.runId;
  });
}

function isThenable(value: unknown): boolean {
  return typeof value === "object" && value !== null
    && typeof (value as { then?: unknown }).then === "function";
}

// --- Production adapters ---------------------------------------------------

/**
 * Opens each component relative to its already-open parent through `/proc/self/fd`. The procfs
 * component is anchored to the parent inode, so a rename between opens cannot redirect the
 * traversal, and there is no pathname fallback when procfs is unavailable.
 */
export function createNodeTranscriptFileSystem(): TranscriptFileSystem {
  const directoryHandle = (handle: FileHandle): TranscriptDirectoryHandle => ({
    fd: handle.fd,
    stat: async () => ({ directory: (await handle.stat()).isDirectory() }),
    close: () => handle.close(),
  } as TranscriptDirectoryHandle & { readonly fd: number });

  const readHandle = (handle: FileHandle): TranscriptReadHandle => ({
    stat: async () => {
      const stat = await handle.stat();
      return {
        device: fileDevice(stat.dev),
        inode: fileInode(stat.ino),
        size: fileByteLength(stat.isFile() ? stat.size : 0),
        regular: stat.isFile(),
      };
    },
    read: async (position, maximum) => {
      const length = Number(maximum);
      const buffer = new Uint8Array(length);
      const { bytesRead } = await handle.read(buffer, 0, length, Number(position));
      return buffer.subarray(0, bytesRead);
    },
    close: () => handle.close(),
  });

  const descriptorOf = (parent: TranscriptDirectoryHandle): number => {
    const fd = (parent as { readonly fd?: number }).fd;
    if (fd === undefined) throw new Error("invalid_state: transcript directory handle is not open");
    return fd;
  };

  return {
    openRootDirectoryNoFollow: async (path) => directoryHandle(
      await open(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW),
    ),
    openDirectoryNoFollow: async (parent, segment) => directoryHandle(await open(
      `/proc/self/fd/${descriptorOf(parent)}/${segment}`,
      constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
    )),
    openReadOnlyNoFollow: async (parent, fileName) => readHandle(await open(
      `/proc/self/fd/${descriptorOf(parent)}/${fileName}`,
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    )),
  };
}

/** Watches the owner's sessions directory. Watching observes change; it never reads content. */
export function createNodeTranscriptFileWatcherFactory(): TranscriptFileWatcherFactory {
  return {
    watch: (directory, onChange, onUnavailable) => {
      const watcher = watch(directory, { persistent: false });
      watcher.on("change", onChange);
      watcher.on("rename", onChange);
      watcher.on("error", onUnavailable);
      watcher.on("close", onUnavailable);
      return { dispose: () => { watcher.close() } };
    },
  };
}

export function createNodeTranscriptRefreshClock(): TranscriptRefreshClock {
  return {
    schedule: (delay, callback) => {
      const timer = setTimeout(callback, Number(delay));
      timer.unref();
      return { cancel: () => { clearTimeout(timer) } };
    },
  };
}
