import { closeSync, constants as fsConstants, fstatSync, openSync, readSync } from "node:fs";
import { join } from "node:path";

import { STATE_DIR_NAME } from "./constants.ts";
import type { AgentId } from "./domain.ts";
import { realContainedPath } from "./paths.ts";

/** Maximum bytes read for one relay snapshot; oversized files are ignored. */
export const MAX_SNAPSHOT_BYTES = 64 * 1024;

export interface ObservationRowV1 {
  readonly ordinal: string;
  readonly state: string;
  readonly taskLabel: string;
}

export interface ObservationSnapshotV1 {
  readonly version: 1;
  readonly sessionId: string;
  readonly revision: number;
  readonly agents: readonly ObservationRowV1[];
}

/**
 * Why a known child's snapshot was not returned. `invalid-session-id`, `escapes-managed-root` and
 * `not-a-regular-file` are refusals — the slot is being actively rejected — while the rest are
 * ordinary states a healthy child passes through. Keeping them apart is what lets a caller tell
 * "this child has not published yet" from "this child's slot is being refused".
 */
export type SnapshotSkipReason =
  | "invalid-session-id"
  | "missing"
  | "escapes-managed-root"
  | "not-a-regular-file"
  | "unreadable"
  | "oversized"
  | "malformed"
  | "session-id-mismatch";

export interface KnownChildSnapshots {
  readonly snapshots: ReadonlyMap<AgentId, ObservationSnapshotV1>;
  /** One entry per requested id that yielded no snapshot. Diagnostic only; safe to ignore. */
  readonly skipped: ReadonlyMap<AgentId, SnapshotSkipReason>;
}

/**
 * Managed snapshot location for one owner session:
 *   <agentDir>/pi-subagents/<ownerSessionId>/ui/observation-v1.json
 *
 * `agentId()` has already enforced Pi's lexical rule for session ids, but brands are erased at
 * runtime, so the path-critical subset is re-checked here against a caller that cast a raw string.
 */
export function observationSnapshotPath(agentDir: string, ownerSessionId: AgentId): string {
  if (ownerSessionId.length === 0 || /[/\\]/.test(ownerSessionId) || ownerSessionId === "." || ownerSessionId === "..") {
    throw new Error(`invalid owner session id for snapshot path: ${JSON.stringify(ownerSessionId)}`);
  }
  return join(agentDir, STATE_DIR_NAME, ownerSessionId, "ui", "observation-v1.json");
}

/**
 * Reads snapshots only for the supplied known child session ids. Never scans directories, and
 * never throws: an unusable snapshot is reported in `skipped` with the reason it was passed over,
 * so a caller can render what it has and still log why a slot was refused.
 */
export function readKnownChildSnapshots(
  agentDir: string,
  knownChildSessionIds: readonly AgentId[],
): KnownChildSnapshots {
  const snapshots = new Map<AgentId, ObservationSnapshotV1>();
  const skipped = new Map<AgentId, SnapshotSkipReason>();
  for (const sessionId of knownChildSessionIds) {
    const outcome = readOne(agentDir, sessionId);
    if (outcome.ok) snapshots.set(sessionId, outcome.snapshot);
    else skipped.set(sessionId, outcome.reason);
  }
  return { snapshots, skipped };
}

type ReadOutcome =
  | { readonly ok: true; readonly snapshot: ObservationSnapshotV1 }
  | { readonly ok: false; readonly reason: SnapshotSkipReason };

type BoundedRead =
  | { readonly ok: true; readonly text: string }
  | { readonly ok: false; readonly reason: SnapshotSkipReason };

function readOne(agentDir: string, sessionId: AgentId): ReadOutcome {
  let path: string;
  try {
    path = observationSnapshotPath(agentDir, sessionId);
  } catch {
    return { ok: false, reason: "invalid-session-id" };
  }

  // Managed-root containment: reject any slot whose real (symlink-resolved) path escapes
  // <agentDir>/pi-subagents. Without this a symlinked child directory or snapshot file could
  // redirect the read outside the managed root. realContainedPath raises ENOENT while nothing has
  // been written yet, and a containment error once something has — different facts, so report them
  // as different reasons.
  try {
    realContainedPath(join(agentDir, STATE_DIR_NAME), path);
  } catch (error) {
    return { ok: false, reason: isMissing(error) ? "missing" : "escapes-managed-root" };
  }

  const read = readBounded(path);
  if (!read.ok) return read;
  let parsed: unknown;
  try {
    parsed = JSON.parse(read.text);
  } catch {
    return { ok: false, reason: "malformed" };
  }
  if (!isSnapshot(parsed)) return { ok: false, reason: "malformed" };
  if (parsed.sessionId !== sessionId) return { ok: false, reason: "session-id-mismatch" };
  return { ok: true, snapshot: parsed };
}

/**
 * Reads at most MAX_SNAPSHOT_BYTES bytes in a single bounded pass. No stat-then-read gap: the byte
 * cap is enforced by the read length itself, so a file that grows after opening cannot be
 * over-read.
 */
function readBounded(path: string): BoundedRead {
  let fd = -1;
  try {
    // O_NOFOLLOW closes the TOCTOU gap after the realpath containment check: if the final component
    // is swapped for a symlink between check and open, the open fails (ELOOP) rather than following
    // it. O_NONBLOCK stops a FIFO planted at the path (the slot directory is written by a same-user
    // child) from blocking open(2) forever waiting for a writer; it is a no-op for a regular file.
    fd = openSync(path, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW | fsConstants.O_NONBLOCK);
    // Only regular files are snapshots. FIFOs, devices and directories are refused rather than read
    // from, since a non-regular file can block or stream indefinitely.
    if (!fstatSync(fd).isFile()) return { ok: false, reason: "not-a-regular-file" };
    const buffer = Buffer.allocUnsafe(MAX_SNAPSHOT_BYTES + 1);
    const bytesRead = readSync(fd, buffer, 0, buffer.length, 0);
    if (bytesRead > MAX_SNAPSHOT_BYTES) return { ok: false, reason: "oversized" };
    return { ok: true, text: buffer.toString("utf-8", 0, bytesRead) };
  } catch (error) {
    // ENOENT here means the file vanished between the containment check and the open. Anything else
    // (ELOOP from a swapped symlink, EACCES, EMFILE) is genuinely unreadable.
    return { ok: false, reason: isMissing(error) ? "missing" : "unreadable" };
  } finally {
    if (fd >= 0) closeSync(fd);
  }
}

function isMissing(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}

function isSnapshot(value: unknown): value is ObservationSnapshotV1 {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Record<string, unknown>;
  return (
    candidate.version === 1 &&
    typeof candidate.sessionId === "string" &&
    typeof candidate.revision === "number" &&
    Array.isArray(candidate.agents) &&
    candidate.agents.every(isRow)
  );
}

function isRow(value: unknown): value is ObservationRowV1 {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Record<string, unknown>;
  return (
    typeof candidate.ordinal === "string" &&
    typeof candidate.state === "string" &&
    typeof candidate.taskLabel === "string"
  );
}
