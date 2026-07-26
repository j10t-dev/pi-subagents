import { closeSync, constants as fsConstants, fstatSync, openSync, readSync } from "node:fs";
import { join } from "node:path";

import { MAX_WIDGET_ROWS, STATE_DIR_NAME } from "./constants.ts";
import {
  AgentState,
  CompletionState,
  agentCount,
  agentId,
  agentOrdinal,
  incarnationId,
  observationRevision,
  tryTranscriptFileName,
  utf8Bytes,
  type AbsolutePath,
  type AgentCount,
  type AgentId,
  type AgentOrdinal,
  type ContextLabel,
  type IncarnationId,
  type ModelLabel,
  type ObservationRevision,
  type ObservationSnapshotPath,
  type TaskLabel,
  type TranscriptFileName,
  type Utf8Bytes,
} from "./domain.ts";
import type { AgentDisplayState } from "./agent-observation.ts";
import { absolutePath, isContainedPath, realContainedPath } from "./paths.ts";

/** Maximum bytes read or encoded for one relay snapshot; oversized files are ignored. */
export const MAX_SNAPSHOT_BYTES: Utf8Bytes = utf8Bytes(64 * 1024);

export interface ObservationRow {
  readonly ordinal: AgentOrdinal;
  readonly sessionId: AgentId;
  readonly model: ModelLabel;
  readonly context: ContextLabel;
  readonly taskLabel: TaskLabel;
  readonly state: AgentDisplayState;
  /** Owner-relative transcript basename; absent when the publisher had no safe locator. */
  readonly transcriptFile?: TranscriptFileName;
}

export interface ObservationSnapshot {
  readonly sessionId: AgentId;
  readonly incarnation: IncarnationId;
  readonly revision: ObservationRevision;
  readonly total: AgentCount;
  readonly omitted: AgentCount;
  readonly degraded: boolean;
  readonly agents: readonly ObservationRow[];
}

export type EncodedObservationSnapshot =
  | { readonly ok: true; readonly text: string }
  | { readonly ok: false; readonly reason: "oversized" };

/** Encodes the complete current snapshot or refuses it; it never truncates wire data. */
export function encodeObservationSnapshot(snapshot: ObservationSnapshot): EncodedObservationSnapshot {
  const text = JSON.stringify(snapshot);
  return new TextEncoder().encode(text).byteLength <= MAX_SNAPSHOT_BYTES
    ? { ok: true, text }
    : { ok: false, reason: "oversized" };
}

/**
 * Why a known child's snapshot was not returned. `invalid-session-id`, `escapes-managed-root` and
 * `not-a-regular-file` are refusals — the slot is being actively rejected — while the rest are
 * ordinary states a healthy child passes through.
 */
export type SnapshotSkipReason =
  | "invalid-session-id"
  | "missing-directory"
  | "missing-file"
  | "escapes-managed-root"
  | "not-a-regular-file"
  | "unreadable"
  | "oversized"
  | "malformed"
  | "session-id-mismatch";

export interface KnownChildSnapshots {
  readonly snapshots: ReadonlyMap<AgentId, ObservationSnapshot>;
  readonly skipped: ReadonlyMap<AgentId, SnapshotSkipReason>;
}

/** Narrow synchronous filesystem boundary for bounded snapshot reads. */
export interface SnapshotReadFileSystem {
  open(path: ObservationSnapshotPath, flags: number): number;
  fstat(fd: number): { isFile(): boolean };
  read(fd: number, buffer: Buffer, offset: number, length: number, position: number): number;
  close(fd: number): void;
}

const productionSnapshotReadFileSystem: SnapshotReadFileSystem = {
  open: openSync,
  fstat: fstatSync,
  read: readSync,
  close: closeSync,
};

/** Shared lexical owner slot directory for relay publication and watcher reads. */
export function observationSlotDirectory(agentDir: AbsolutePath, ownerSessionId: AgentId): AbsolutePath {
  try {
    agentId(ownerSessionId);
  } catch {
    throw new Error(`invalid owner session id for snapshot path: ${JSON.stringify(ownerSessionId)}`);
  }
  const managedRoot = absolutePath(join(agentDir, STATE_DIR_NAME));
  const directory = absolutePath(join(managedRoot, ownerSessionId, "ui"));
  if (!isContainedPath(managedRoot, directory)) {
    throw new Error(`invalid owner session id for snapshot path: ${JSON.stringify(ownerSessionId)}`);
  }
  return directory;
}

/** Managed current snapshot location for one owner session. */
export function observationSnapshotPath(agentDir: AbsolutePath, ownerSessionId: AgentId): ObservationSnapshotPath {
  return provenObservationSnapshotPath(absolutePath(join(observationSlotDirectory(agentDir, ownerSessionId), "observation.json")));
}

/** Reads only supplied known slots and reports unusable slots without throwing. */
export function readKnownChildSnapshots(
  agentDir: AbsolutePath,
  knownChildSessionIds: readonly AgentId[],
  filesystem: SnapshotReadFileSystem = productionSnapshotReadFileSystem,
): KnownChildSnapshots {
  const snapshots = new Map<AgentId, ObservationSnapshot>();
  const skipped = new Map<AgentId, SnapshotSkipReason>();
  for (const sessionId of knownChildSessionIds) {
    const outcome = readOne(agentDir, sessionId, filesystem);
    if (outcome.ok) snapshots.set(sessionId, outcome.snapshot);
    else skipped.set(sessionId, outcome.reason);
  }
  return { snapshots, skipped };
}

type ReadOutcome =
  | { readonly ok: true; readonly snapshot: ObservationSnapshot }
  | { readonly ok: false; readonly reason: SnapshotSkipReason };
type BoundedRead =
  | { readonly ok: true; readonly text: string }
  | { readonly ok: false; readonly reason: SnapshotSkipReason };

function readOne(
  agentDir: AbsolutePath,
  sessionId: AgentId,
  filesystem: SnapshotReadFileSystem,
): ReadOutcome {
  let slotDirectory: AbsolutePath;
  let path: ObservationSnapshotPath;
  try {
    slotDirectory = observationSlotDirectory(agentDir, sessionId);
    path = observationSnapshotPath(agentDir, sessionId);
  } catch {
    return { ok: false, reason: "invalid-session-id" };
  }
  const managedRoot = absolutePath(join(agentDir, STATE_DIR_NAME));
  try {
    realContainedPath(managedRoot, slotDirectory);
  } catch (error) {
    return { ok: false, reason: isMissing(error) ? "missing-directory" : "escapes-managed-root" };
  }
  try {
    realContainedPath(managedRoot, path);
  } catch (error) {
    return { ok: false, reason: isMissing(error) ? "missing-file" : "escapes-managed-root" };
  }
  const read = readBounded(path, filesystem);
  if (!read.ok) return read;
  let parsed: unknown;
  try {
    parsed = JSON.parse(read.text);
  } catch {
    return { ok: false, reason: "malformed" };
  }
  const snapshot = decodeSnapshot(parsed, sessionId);
  if (snapshot === undefined) return { ok: false, reason: "malformed" };
  if (snapshot === "session-id-mismatch") return { ok: false, reason: snapshot };
  return { ok: true, snapshot };
}

/** Reads a capped amount in one pass and refuses links, FIFOs, devices and directories. */
function readBounded(path: ObservationSnapshotPath, filesystem: SnapshotReadFileSystem): BoundedRead {
  let fd: number | undefined;
  let failure: unknown;
  let outcome: BoundedRead = { ok: false, reason: "unreadable" };
  try {
    fd = filesystem.open(path, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW | fsConstants.O_NONBLOCK);
    if (!filesystem.fstat(fd).isFile()) {
      outcome = { ok: false, reason: "not-a-regular-file" };
    } else {
      const buffer = Buffer.allocUnsafe(Number(MAX_SNAPSHOT_BYTES) + 1);
      const bytesRead = filesystem.read(fd, buffer, 0, buffer.length, 0);
      outcome = bytesRead > MAX_SNAPSHOT_BYTES
        ? { ok: false, reason: "oversized" }
        : { ok: true, text: buffer.toString("utf-8", 0, bytesRead) };
    }
  } catch (error) {
    failure = error;
  } finally {
    if (fd !== undefined) {
      try { filesystem.close(fd); }
      catch (error) { failure ??= error; }
    }
  }
  return failure === undefined
    ? outcome
    : { ok: false, reason: isMissing(failure) ? "missing-file" : "unreadable" };
}

function decodeSnapshot(value: unknown, requestedSessionId: AgentId): ObservationSnapshot | "session-id-mismatch" | undefined {
  if (!isRecord(value) || typeof value.sessionId !== "string" || typeof value.incarnation !== "string" ||
      typeof value.revision !== "number" || typeof value.total !== "number" || typeof value.omitted !== "number" ||
      typeof value.degraded !== "boolean" || !Array.isArray(value.agents) || value.agents.length > MAX_WIDGET_ROWS) return undefined;
  let sessionId: AgentId;
  let incarnation: IncarnationId;
  let revision: ObservationRevision;
  let total: AgentCount;
  let omitted: AgentCount;
  try {
    sessionId = agentId(value.sessionId);
    incarnation = incarnationId(value.incarnation);
    revision = observationRevision(value.revision);
    total = agentCount(value.total);
    omitted = agentCount(value.omitted);
  } catch {
    return undefined;
  }
  const agents: ObservationRow[] = [];
  const ordinals = new Set<AgentOrdinal>();
  const sessionIds = new Set<AgentId>();
  let degraded = value.degraded;
  for (const candidate of value.agents) {
    const decoded = decodeRow(candidate);
    if (decoded === undefined || ordinals.has(decoded.row.ordinal) || sessionIds.has(decoded.row.sessionId)) return undefined;
    if (decoded.locatorRejected) degraded = true;
    ordinals.add(decoded.row.ordinal);
    sessionIds.add(decoded.row.sessionId);
    agents.push(decoded.row);
  }
  if (total < agents.length || omitted !== total - agents.length) return undefined;
  if (sessionId !== requestedSessionId) return "session-id-mismatch";
  return { sessionId, incarnation, revision, total, omitted, degraded, agents: Object.freeze(agents) };
}

interface DecodedRow {
  readonly row: ObservationRow;
  /** An unsafe optional locator is dropped and degrades the snapshot rather than the row. */
  readonly locatorRejected: boolean;
}

function decodeRow(value: unknown): DecodedRow | undefined {
  if (!isRecord(value) || typeof value.ordinal !== "string" || typeof value.sessionId !== "string" ||
      typeof value.model !== "string" || typeof value.context !== "string" ||
      typeof value.taskLabel !== "string" || typeof value.state !== "string") return undefined;
  if (!isDisplayText(value.model, 1_024) || !isDisplayText(value.taskLabel, 512) ||
      !isDisplayText(value.context, Number.POSITIVE_INFINITY) || [...value.context].length > 8 || !isDisplayState(value.state)) return undefined;
  const locator = typeof value.transcriptFile === "string" ? tryTranscriptFileName(value.transcriptFile) : undefined;
  const locatorRejected = value.transcriptFile !== undefined && locator === undefined;
  try {
    const ordinal = agentOrdinal(value.ordinal);
    if (value.ordinal.includes(".")) return undefined;
    return {
      row: {
        ordinal, sessionId: agentId(value.sessionId), model: value.model as ModelLabel,
        context: value.context as ContextLabel, taskLabel: value.taskLabel as TaskLabel, state: value.state,
        ...(locator === undefined ? {} : { transcriptFile: locator }),
      },
      locatorRejected,
    };
  } catch {
    return undefined;
  }
}

const DISPLAY_CONTROL_PATTERN = /[\u0000-\u001f\u007f-\u009f\u061c\u200e-\u200f\u202a-\u202e\u2066-\u2069]/u;
const DISPLAY_STATES = new Set<string>([...Object.values(AgentState), ...Object.values(CompletionState)]);

function isDisplayText(value: string, maximumBytes: number): boolean {
  return !DISPLAY_CONTROL_PATTERN.test(value) && new TextEncoder().encode(value).byteLength <= maximumBytes;
}
function isDisplayState(value: string): value is AgentDisplayState { return DISPLAY_STATES.has(value); }
function isRecord(value: unknown): value is Record<string, unknown> { return typeof value === "object" && value !== null && !Array.isArray(value); }
function isMissing(error: unknown): boolean { return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT"; }
function provenObservationSnapshotPath(path: AbsolutePath): ObservationSnapshotPath { return path as ObservationSnapshotPath; }
