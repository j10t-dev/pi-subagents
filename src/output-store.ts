import { appendFileSync, closeSync, existsSync, fstatSync, openSync, readSync, unlinkSync, writeFileSync } from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import { Type } from "typebox";
import { Value } from "typebox/value";

import {
  truncateUtf8,
  retainUtf8Tail,
  utf8Bytes,
  type AbsolutePath,
  type AgentCompletion,
  type CommittedOutputPath,
  type CompletionOutput,
  type OutputPath,
  type RestorableAgentCompletion,
  type RunAttemptId,
  type RunId,
  type SessionPath,
  type Utf8Bytes,
} from "./domain.ts";
import type { WireAssistantMessage } from "./schemas.ts";
import { MAX_COMPLETION_OUTPUT_BYTES, MAX_SESSION_RECOVERY_BYTES, MAX_STDERR_TAIL_BYTES } from "./constants.ts";
import { outputPath } from "./paths.ts";
import {
  ensureDurableDirectorySync,
  publishCommittedSync,
  syncPublishedFileSync,
  systemDurableFileSystem,
  type DurableFileSystem,
} from "./durable-fs.ts";

export interface TranscriptFileSystem {
  open(path: string, flags: string): number;
  fstat(fd: number): { size: number };
  read(fd: number, buffer: Buffer, offset: number, length: number, position: number): number;
  close(fd: number): void;
}

export interface OutputStoreOptions {
  workDir: AbsolutePath;
  maxOutputBytes?: Utf8Bytes;
  maxTailBytes?: Utf8Bytes;
  maxRecoveryBytes?: Utf8Bytes;
  durableFileSystem?: DurableFileSystem;
  transcriptFileSystem?: TranscriptFileSystem;
}

export interface RecoveryFailure { recovered: false; reason: string }
export interface RecoverySuccess { recovered: true; output: CompletionOutput }
export type RecoveryResult = RecoveryFailure | RecoverySuccess;

interface PublicationEvidence {
  readonly digest: string;
  readonly byteLength: Utf8Bytes;
  readonly output: CompletionOutput;
}

interface PendingPublication extends PublicationEvidence {
  destination: OutputPath;
  renamed: boolean;
}

interface RunRecord {
  destination: OutputPath;
  candidatePath: string | undefined;
  output: CompletionOutput;
  pendingPublication: PendingPublication | undefined;
  lastPublication: PublicationEvidence | undefined;
  transportIncomplete: boolean;
  transportLossDetected: boolean;
}

interface AttemptRecord {
  candidatePath: string | undefined;
  output: CompletionOutput;
  finalised: boolean;
  transportIncomplete: boolean;
  transportLossDetected: boolean;
}

type AuthoritativeProjection =
  | { kind: "found"; text: string; output: CompletionOutput }
  | { kind: "empty"; text: ""; output: CompletionOutput }
  | { kind: "failure"; reason: string };

const EMPTY_OUTPUT: CompletionOutput = {
  text: "",
  originalBytes: utf8Bytes(0),
  retainedBytes: utf8Bytes(0),
  truncated: false,
};

/** Tracks candidate output separately from crash-durable authoritative sidecars. */
export class OutputStore {
  private readonly workDir: AbsolutePath;
  private readonly maxOutputBytes: Utf8Bytes;
  private readonly maxRecoveryBytes: Utf8Bytes;
  private readonly durableFileSystem: DurableFileSystem;
  private readonly transcriptFileSystem: TranscriptFileSystem;
  private readonly attempts = new Map<RunAttemptId, AttemptRecord>();
  private readonly runs = new Map<RunId, RunRecord>();
  private readonly promotableRuns = new Set<RunId>();
  private stderrTail = "";
  private diagnosticsTail = "";
  private readonly maxTailBytes: Utf8Bytes;
  private stagingDirectoryReady = false;

  constructor(options: OutputStoreOptions) {
    this.workDir = options.workDir;
    this.maxOutputBytes = options.maxOutputBytes ?? MAX_COMPLETION_OUTPUT_BYTES;
    this.maxTailBytes = options.maxTailBytes ?? MAX_STDERR_TAIL_BYTES;
    this.maxRecoveryBytes = options.maxRecoveryBytes ?? MAX_SESSION_RECOVERY_BYTES;
    this.durableFileSystem = options.durableFileSystem ?? systemDurableFileSystem;
    this.transcriptFileSystem = options.transcriptFileSystem ?? systemTranscriptFileSystem;
  }

  beginAttempt(attemptId: RunAttemptId): void {
    if (this.attempts.has(attemptId)) throw new Error(`invalid_state: run attempt ${attemptId} already exists`);
    const candidatePath = this.createCandidatePath(attemptId);
    this.attempts.set(attemptId, { candidatePath, output: EMPTY_OUTPUT, finalised: false, transportIncomplete: true, transportLossDetected: false });
  }

  onAttemptMessageStart(attemptId: RunAttemptId, _message: WireAssistantMessage): void {
    const attempt = this.requireAttempt(attemptId);
    if (attempt.candidatePath === undefined) attempt.candidatePath = this.createCandidatePath(attemptId);
    writeCandidate(attempt.candidatePath, "");
    attempt.finalised = false;
    attempt.output = EMPTY_OUTPUT;
    attempt.transportIncomplete = true;
  }

  onAttemptTextDelta(attemptId: RunAttemptId, _contentIndex: number, delta: string): void {
    const attempt = this.requireAttempt(attemptId);
    if (attempt.candidatePath === undefined) attempt.candidatePath = this.createCandidatePath(attemptId);
    appendOwnerOnlySync(attempt.candidatePath, delta);
  }

  onAttemptMessageEnd(attemptId: RunAttemptId, message: WireAssistantMessage): void {
    const attempt = this.requireAttempt(attemptId);
    const text = extractAssistantText(message);
    if (attempt.candidatePath === undefined) attempt.candidatePath = this.createCandidatePath(attemptId);
    writeCandidate(attempt.candidatePath, text);
    attempt.output = truncateUtf8(text, this.maxOutputBytes);
    attempt.finalised = true;
    attempt.transportIncomplete = attempt.transportLossDetected;
  }

  recoverAttemptMessage(attemptId: RunAttemptId, message: WireAssistantMessage): void {
    const attempt = this.requireAttempt(attemptId);
    const text = extractAssistantText(message);
    if (attempt.candidatePath === undefined) attempt.candidatePath = this.createCandidatePath(attemptId);
    writeCandidate(attempt.candidatePath, text);
    attempt.output = truncateUtf8(text, this.maxOutputBytes);
    attempt.finalised = true;
    attempt.transportLossDetected = false;
    attempt.transportIncomplete = false;
  }

  markAttemptTransportIncomplete(attemptId: RunAttemptId): void {
    const attempt = this.requireAttempt(attemptId);
    attempt.transportLossDetected = true;
    attempt.transportIncomplete = true;
  }

  /** Transfers attempt ownership into an addressable run without claiming durable publication. */
  adoptRun(attemptId: RunAttemptId, runId: RunId, ownershipTransferred?: () => void): OutputPath {
    if (this.runs.has(runId)) throw new Error(`invalid_state: run ${runId} is already bound`);
    const attempt = this.requireAttempt(attemptId);
    const destination = outputPath(this.workDir, `${runId}.committed`);
    const run: RunRecord = {
      destination,
      candidatePath: undefined,
      output: EMPTY_OUTPUT,
      pendingPublication: undefined,
      lastPublication: undefined,
      transportIncomplete: true,
      transportLossDetected: true,
    };
    this.runs.set(runId, run);
    run.candidatePath = attempt.candidatePath;
    attempt.candidatePath = undefined;
    this.attempts.delete(attemptId);
    ownershipTransferred?.();

    const candidateBytes = attempt.finalised && run.candidatePath !== undefined
      ? this.durableFileSystem.readFile(run.candidatePath)
      : Buffer.alloc(0);
    const output = attempt.finalised ? attempt.output : EMPTY_OUTPUT;
    run.pendingPublication = pending(destination, candidateBytes, output, false);
    run.transportIncomplete = attempt.transportIncomplete;
    run.transportLossDetected = attempt.transportLossDetected;
    if (attempt.finalised) this.promotableRuns.add(runId);
    return destination;
  }

  /** Publishes the initial empty or finalised pre-bind projection after identity is aligned. */
  publishInitial(runId: RunId): CommittedOutputPath {
    const run = this.requireRun(runId);
    const staged = run.candidatePath === undefined ? undefined : this.durableFileSystem.readFile(run.candidatePath);
    if (this.promotableRuns.has(runId) && staged !== undefined && run.pendingPublication !== undefined && matches(run.pendingPublication, staged)) {
      const committed = this.publishAuthoritative(run, { promotionSource: run.candidatePath! }, run.pendingPublication.output);
      this.promotableRuns.delete(runId);
      return committed;
    }
    const partialCandidate = run.candidatePath;
    run.candidatePath = undefined;
    try {
      return this.publishAuthoritative(run, { data: "" }, EMPTY_OUTPUT);
    } finally {
      run.candidatePath = partialCandidate;
    }
  }

  /** Compatibility boundary for direct store users; RPC binding uses the explicit two phases. */
  bindRun(attemptId: RunAttemptId, runId: RunId): CommittedOutputPath {
    this.adoptRun(attemptId, runId);
    return this.publishInitial(runId);
  }

  restoreRun(runId: RunId): OutputPath {
    const existing = this.runs.get(runId);
    if (existing !== undefined) return existing.destination;
    const destination = outputPath(this.workDir, `${runId}.committed`);
    this.runs.set(runId, {
      destination,
      candidatePath: undefined,
      output: EMPTY_OUTPUT,
      pendingPublication: undefined,
      lastPublication: undefined,
      transportIncomplete: true,
      transportLossDetected: true,
    });
    return destination;
  }

  onMessageStart(runId: RunId, _message: WireAssistantMessage): void {
    const run = this.requireRun(runId);
    this.removeCandidate(run);
    run.candidatePath = this.createCandidatePath(runId);
    run.transportIncomplete = true;
  }

  onTextDelta(runId: RunId, _contentIndex: number, delta: string): void {
    const run = this.requireRun(runId);
    if (run.candidatePath === undefined) run.candidatePath = this.createCandidatePath(runId);
    appendOwnerOnlySync(run.candidatePath, delta);
  }

  onMessageEnd(runId: RunId, message: WireAssistantMessage): void {
    const run = this.requireRun(runId);
    this.publishAuthoritative(run, { data: extractAssistantText(message) }, truncateUtf8(extractAssistantText(message), this.maxOutputBytes));
  }

  recoverMessage(runId: RunId, message: WireAssistantMessage): void {
    const run = this.requireRun(runId);
    const text = extractAssistantText(message);
    this.publishAuthoritative(run, { data: text }, truncateUtf8(text, this.maxOutputBytes));
    run.transportLossDetected = false;
    run.transportIncomplete = false;
  }

  markTransportIncomplete(runId: RunId): void {
    const run = this.requireRun(runId);
    run.transportLossDetected = true;
    run.transportIncomplete = true;
  }

  currentOutput(runId: RunId): { output: CompletionOutput; transportIncomplete: boolean } {
    const run = this.requireRun(runId);
    return { output: run.output, transportIncomplete: run.transportIncomplete };
  }

  discardPartial(id: RunAttemptId | RunId): void {
    const attempt = getByStringIdentity(this.attempts, id);
    if (attempt !== undefined) {
      if (attempt.finalised) return;
      if (attempt.candidatePath !== undefined) removeIfPresent(attempt.candidatePath);
      attempt.candidatePath = undefined;
      attempt.output = EMPTY_OUTPUT;
      attempt.finalised = false;
      attempt.transportIncomplete = true;
      return;
    }
    const run = getByStringIdentity(this.runs, id);
    if (run !== undefined) this.removeCandidate(run);
  }

  recover(runId: RunId, sessionPath: SessionPath): RecoveryResult {
    const projection = this.projectTranscript(runId, sessionPath);
    if (projection.kind === "failure") return { recovered: false, reason: projection.reason };
    try {
      const run = this.requireRun(runId);
      this.publishAuthoritative(run, { data: projection.text }, projection.output);
      run.transportLossDetected = false;
      run.transportIncomplete = false;
      return { recovered: true, output: run.output };
    } catch (error) {
      return { recovered: false, reason: boundedReason(error) };
    }
  }

  restoreCompletion(
    candidate: RestorableAgentCompletion,
    transcriptPath: SessionPath,
  ): AgentCompletion {
    const expected = outputPath(this.workDir, `${candidate.runId}.committed`);
    if (normalisedOutputDestination(candidate.outputPath, this.durableFileSystem) !==
        normalisedOutputDestination(expected, this.durableFileSystem)) {
      throw new Error("output_error: restored completion destination does not match its managed output path");
    }

    const destinationBytes = readIfPresent(expected, this.durableFileSystem);
    if (destinationBytes !== undefined && completionEvidenceMatches(candidate.output, destinationBytes, this.maxOutputBytes)) {
      try {
        syncPublishedFileSync(expected, this.durableFileSystem);
        return withRestoredOutput(
          candidate,
          candidate.output,
          committedAfterDurablePublication(expected),
        );
      } catch (error) {
        throw outputError(error);
      }
    }

    this.restoreRun(candidate.runId);
    const durable = this.ensureDurable(candidate.runId, transcriptPath);
    return withRestoredOutput(candidate, durable.output, durable.committedPath);
  }

  ensureDurable(runId: RunId, transcriptPath: SessionPath): { output: CompletionOutput; committedPath: CommittedOutputPath } {
    const run = this.requireRun(runId);
    if (!run.transportIncomplete && run.pendingPublication !== undefined) {
      const destinationBytes = readIfPresent(run.destination, this.durableFileSystem);
      if (destinationBytes !== undefined && matches(run.pendingPublication, destinationBytes)) {
        try {
          syncPublishedFileSync(run.destination, this.durableFileSystem);
          const evidence = publicationEvidence(run.pendingPublication);
          run.output = evidence.output;
          run.lastPublication = evidence;
          run.pendingPublication = undefined;
          this.removeCandidate(run);
          return {
            output: run.output,
            committedPath: committedAfterDurablePublication(run.destination),
          };
        } catch (error) {
          throw outputError(error);
        }
      }
    }

    if (!run.transportIncomplete && run.pendingPublication === undefined && run.lastPublication !== undefined) {
      const destinationBytes = readIfPresent(run.destination, this.durableFileSystem);
      if (destinationBytes !== undefined && matches(run.lastPublication, destinationBytes)) {
        try {
          syncPublishedFileSync(run.destination, this.durableFileSystem);
          return {
            output: run.lastPublication.output,
            committedPath: committedAfterDurablePublication(run.destination),
          };
        } catch (error) {
          throw outputError(error);
        }
      }
    }

    const projection = this.projectTranscript(runId, transcriptPath);
    if (projection.kind === "failure") throw new Error(`output_error: ${projection.reason}`);
    try {
      const committedPath = this.publishAuthoritative(run, { data: projection.text }, projection.output);
      run.transportLossDetected = false;
      run.transportIncomplete = false;
      return { output: run.output, committedPath };
    } catch (error) {
      throw outputError(error);
    }
  }

  appendStderr(chunk: string): void { this.stderrTail = retainUtf8Tail(this.stderrTail + chunk, this.maxTailBytes); }
  getStderrTail(): string { return this.stderrTail; }
  appendDiagnostics(message: string): void { this.diagnosticsTail = retainUtf8Tail(this.diagnosticsTail + message, this.maxTailBytes); }
  getDiagnosticsTail(): string { return this.diagnosticsTail; }

  private publishAuthoritative(
    run: RunRecord,
    source: { data: string } | { promotionSource: string },
    output: CompletionOutput,
  ): CommittedOutputPath {
    const bytes = "data" in source ? Buffer.from(source.data) : this.durableFileSystem.readFile(source.promotionSource);
    run.pendingPublication = pending(run.destination, bytes, output, false);
    try {
      publishCommittedSync({ destination: run.destination, ...source }, this.durableFileSystem);
    } catch (error) {
      const visible = readIfPresent(run.destination, this.durableFileSystem);
      if (visible !== undefined && run.pendingPublication !== undefined && matches(run.pendingPublication, visible)) {
        run.pendingPublication.renamed = true;
      }
      throw error;
    }
    run.output = output;
    run.lastPublication = publicationEvidence(run.pendingPublication);
    run.pendingPublication = undefined;
    this.removeCandidate(run);
    run.transportIncomplete = run.transportLossDetected;
    return committedAfterDurablePublication(run.destination);
  }

  private projectTranscript(runId: RunId, sessionPath: SessionPath): AuthoritativeProjection {
    const tail = readTailBounded(sessionPath, this.maxRecoveryBytes, this.transcriptFileSystem);
    if (tail.kind === "failure") return tail;
    if (tail.bytes.length === 0) return { kind: "failure", reason: "session file is empty" };
    if (tail.bytes.at(-1) !== 0x0a) return { kind: "failure", reason: "session file has an incomplete trailing record" };
    const records = parseCompleteRecords(tail.bytes, tail.startsAtByteZero);
    if (records.kind === "failure") return records;
    const cursorIndex = records.records.findIndex((record) => isRunCursorEntry(record, runId));
    if (cursorIndex < 0) return { kind: "failure", reason: `no matching assignment cursor within the last ${this.maxRecoveryBytes} bytes` };
    let text: string | undefined;
    for (let index = cursorIndex + 1; index < records.records.length; index++) {
      const record = records.records[index];
      if (isAssignmentCursorEntry(record)) {
        if (text === undefined) return { kind: "empty", text: "", output: EMPTY_OUTPUT };
        break;
      }
      const assistant = tryExtractAssistantEntryText(record);
      if (assistant !== undefined) text = assistant;
    }
    if (text === undefined) return { kind: "empty", text: "", output: EMPTY_OUTPUT };
    return { kind: "found", text, output: truncateUtf8(text, this.maxOutputBytes) };
  }

  private requireRun(runId: RunId): RunRecord {
    const run = this.runs.get(runId);
    if (run === undefined) throw new Error(`invalid_state: unknown or unbound run ${runId}`);
    return run;
  }

  private requireAttempt(attemptId: RunAttemptId): AttemptRecord {
    const attempt = this.attempts.get(attemptId);
    if (attempt === undefined) throw new Error(`invalid_state: unknown run attempt ${attemptId}`);
    return attempt;
  }

  private removeCandidate(run: RunRecord): void {
    if (run.candidatePath === undefined) return;
    try { removeIfPresent(run.candidatePath); }
    catch { /* obsolete staging cleanup cannot invalidate a durable publication */ }
    run.candidatePath = undefined;
  }

  private createCandidatePath(id: RunAttemptId | RunId): string {
    if (!this.stagingDirectoryReady) {
      ensureDurableDirectorySync(this.workDir, this.durableFileSystem);
      this.stagingDirectoryReady = true;
    }
    const path = outputPath(this.workDir, `.${id}-${randomUUID()}.candidate`);
    writeCandidate(path, "");
    return path;
  }
}

const TextContentSchema = Type.Object({ type: Type.Literal("text"), text: Type.String() });
const RecoveredAssistantMessageSchema = Type.Object({
  role: Type.Literal("assistant"),
  content: Type.Array(Type.Union([TextContentSchema, Type.Record(Type.String(), Type.Unknown())])),
});
const AssistantSessionEntrySchema = Type.Object({ type: Type.Literal("message"), id: Type.String(), message: RecoveredAssistantMessageSchema });
const CursorEntrySchema = Type.Object({ type: Type.Literal("message"), id: Type.String(), message: Type.Object({ role: Type.Literal("user") }) });

function isRunCursorEntry(value: unknown, runId: RunId): boolean {
  if (!Value.Check(CursorEntrySchema, value)) return false;
  return Value.Decode(CursorEntrySchema, value).id === runId;
}
function isAssignmentCursorEntry(value: unknown): boolean { return Value.Check(CursorEntrySchema, value); }
function tryExtractAssistantEntryText(value: unknown): string | undefined {
  if (!Value.Check(AssistantSessionEntrySchema, value)) return undefined;
  return extractAssistantText(Value.Decode(AssistantSessionEntrySchema, value).message);
}
function extractAssistantText(message: { content: readonly Record<string, unknown>[] }): string {
  let text = "";
  for (const item of message.content) if (Value.Check(TextContentSchema, item)) text += item.text;
  return text;
}

const systemTranscriptFileSystem: TranscriptFileSystem = {
  open: openSync,
  fstat: fstatSync,
  read: readSync,
  close: closeSync,
};

function readTailBounded(path: string, maxBytes: Utf8Bytes, fs: TranscriptFileSystem):
  | { kind: "success"; bytes: Buffer; startsAtByteZero: boolean }
  | { kind: "failure"; reason: string } {
  let fd: number;
  try { fd = fs.open(path, "r"); }
  catch { return { kind: "failure", reason: "session file is unreadable" }; }

  let result:
    | { kind: "success"; bytes: Buffer; startsAtByteZero: boolean }
    | { kind: "failure"; reason: string };
  try {
    const rawSize = fs.fstat(fd).size;
    if (!Number.isSafeInteger(rawSize) || rawSize < 0) throw new Error("invalid session file size");
    const size = utf8Bytes(rawSize);
    const readLength = Math.min(size, maxBytes);
    const start = size - readLength;
    const allocation = Buffer.alloc(readLength);
    let offset = 0;
    while (offset < readLength) {
      const rawBytesRead = fs.read(fd, allocation, offset, readLength - offset, start + offset);
      if (!Number.isSafeInteger(rawBytesRead) || rawBytesRead < 0 || rawBytesRead > readLength - offset) {
        throw new Error("invalid session read length");
      }
      const bytesRead = utf8Bytes(rawBytesRead);
      if (bytesRead === 0) break;
      offset += bytesRead;
    }
    result = { kind: "success", bytes: allocation.subarray(0, offset), startsAtByteZero: start === 0 };
  } catch {
    result = { kind: "failure", reason: "session file is unreadable" };
  }

  try { fs.close(fd); }
  catch {
    if (result.kind === "success") return { kind: "failure", reason: "session file could not be closed" };
  }
  return result;
}

function parseCompleteRecords(tail: Buffer, startsAtByteZero: boolean):
  | { kind: "success"; records: unknown[] }
  | { kind: "failure"; reason: string } {
  const records: unknown[] = [];
  let start = startsAtByteZero ? 0 : tail.indexOf(0x0a) + 1;
  if (start === 0 && !startsAtByteZero) return { kind: "failure", reason: "bounded transcript window contains no complete record" };
  for (let end = start; end < tail.length; end++) {
    if (tail[end] !== 0x0a) continue;
    let bytes = tail.subarray(start, end);
    if (bytes.at(-1) === 0x0d) bytes = bytes.subarray(0, -1);
    start = end + 1;
    if (bytes.length === 0) continue;
    try {
      const line = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
      records.push(JSON.parse(line));
    } catch {
      return { kind: "failure", reason: "session file contains invalid UTF-8 or JSONL" };
    }
  }
  return { kind: "success", records };
}

function pending(destination: OutputPath, bytes: Uint8Array, output: CompletionOutput, renamed: boolean): PendingPublication {
  return { destination, digest: digest(bytes), byteLength: utf8Bytes(bytes.byteLength), output, renamed };
}

function publicationEvidence(publication: PublicationEvidence): PublicationEvidence {
  return Object.freeze({
    digest: publication.digest,
    byteLength: publication.byteLength,
    output: Object.freeze({ ...publication.output }),
  });
}

/** Called only after file fsync and containing-directory fsync have succeeded. */
function committedAfterDurablePublication(destination: OutputPath): CommittedOutputPath {
  return destination as CommittedOutputPath;
}

function digest(bytes: Uint8Array): string { return createHash("sha256").update(bytes).digest("hex"); }
function matches(publication: PublicationEvidence, bytes: Uint8Array): boolean {
  return bytes.byteLength === publication.byteLength && digest(bytes) === publication.digest;
}
/** Map lookup is safe across string brands: a mismatched identity simply has no entry. */
function getByStringIdentity<K extends string, V>(map: ReadonlyMap<K, V>, key: string): V | undefined {
  return map.get(key as K);
}

function readIfPresent(path: string, fs: DurableFileSystem): Buffer | undefined {
  try { return fs.readFile(path); } catch { return undefined; }
}

function normalisedOutputDestination(path: OutputPath, fs: DurableFileSystem): string {
  return fs.exists(path) ? fs.realpath(path) : path;
}

function completionEvidenceMatches(
  expected: CompletionOutput,
  bytes: Uint8Array,
  maxOutputBytes: Utf8Bytes,
): boolean {
  if (bytes.byteLength !== expected.originalBytes) return false;
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return false;
  }
  const projected = truncateUtf8(text, maxOutputBytes);
  return projected.text === expected.text &&
    projected.originalBytes === expected.originalBytes &&
    projected.retainedBytes === expected.retainedBytes &&
    projected.truncated === expected.truncated;
}

function withRestoredOutput(
  candidate: RestorableAgentCompletion,
  output: CompletionOutput,
  outputPath: CommittedOutputPath,
): AgentCompletion {
  return { ...candidate, output, outputPath };
}

function writeCandidate(path: string, data: string): void { writeFileSync(path, data, { mode: 0o600 }); }
function appendOwnerOnlySync(path: string, data: string): void { appendFileSync(path, data, { encoding: "utf8", mode: 0o600 }); }
function removeIfPresent(path: string): void { if (existsSync(path)) unlinkSync(path); }
function boundedReason(error: unknown): string {
  return retainUtf8Tail(error instanceof Error ? error.message : String(error), utf8Bytes(512));
}
function outputError(error: unknown): Error { return new Error(`output_error: ${boundedReason(error)}`); }
