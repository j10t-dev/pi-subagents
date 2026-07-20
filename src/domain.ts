import { randomUUID } from "node:crypto";
import { isAbsolute } from "node:path";

import type { ResolveCliModelResult, SessionEntry } from "@earendil-works/pi-coding-agent";

import { MAX_ERROR_MESSAGE_BYTES } from "./constants.ts";
import type { ContainmentDescriptor } from "./containment.ts";

// --- Brands ---------------------------------------------------------------

declare const brand: unique symbol;
export type Brand<T, TName extends string> = T & {
  readonly [brand]: { readonly [K in TName]: true };
};

export type AgentId = Brand<string, "PiSessionId">;
export type SessionEntryId = Brand<string, "PiSessionEntryId">;
export type RunId = SessionEntryId & Brand<string, "AssignmentUserMessageEntryId">;
export type RpcRequestId = Brand<string, "RpcRequestId">;
export type RunAttemptId = Brand<string, "RunAttemptId">;
export type ModelSpec = Brand<string, "PiCliModelSpec">;
export type AbsolutePath = Brand<string, "AbsolutePath">;
export type SessionPath = AbsolutePath & Brand<string, "ContainedSessionFile">;
export type OutputPath = AbsolutePath & Brand<string, "OutputFileLocation">;
export type CommittedOutputPath = OutputPath & Brand<string, "CommittedOutputFile">;
export type DiagnosticsPath = AbsolutePath & Brand<string, "DiagnosticsFileLocation">;
export type ContainmentReceiptPath = AbsolutePath & Brand<string, "ContainmentReceiptLocation">;
export type VerifiedContainmentReceiptPath = ContainmentReceiptPath &
  Brand<string, "VerifiedContainmentReceipt">;
export type Milliseconds = Brand<number, "Milliseconds">;
export type Utf8Bytes = Brand<number, "Utf8Bytes">;

/** Canonical identity for state belonging to one agent run. Native entry IDs are session-local. */
export type AgentRunKey = Brand<string, "AgentRunKey">;

export function agentRunKey(agent: AgentId, run: RunId): AgentRunKey {
  return `${agent}\u0000${run}` as AgentRunKey;
}

const SESSION_ID_PATTERN = /^[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?$/;
const MAX_SESSION_ID_BYTES = 256;
/** Pi generates entry IDs as `randomUUID().slice(0, 8)`: 8 lowercase hex characters. */
const SESSION_ENTRY_ID_PATTERN = /^[0-9a-f]{8}$/;

/** Brands a native `SessionManager.getSessionId()` value, matching Pi's own lexical rule. */
export function agentId(value: string): AgentId {
  if (new TextEncoder().encode(value).byteLength > MAX_SESSION_ID_BYTES || !SESSION_ID_PATTERN.test(value)) {
    throw new Error(`invalid_agent: not a valid Pi session id: ${JSON.stringify(value)}`);
  }
  return value as AgentId;
}

/** Brands a native `SessionEntry["id"]` value. */
export function sessionEntryId(value: string): SessionEntryId {
  if (!SESSION_ENTRY_ID_PATTERN.test(value)) {
    throw new Error(`invalid_agent: not a valid Pi session entry id: ${JSON.stringify(value)}`);
  }
  return value as SessionEntryId;
}

/** Brands a native session-entry ID already proven to be an assignment user-message entry. */
export function runId(value: string): RunId {
  return sessionEntryId(value) as RunId;
}

interface EntryLike {
  readonly id: string;
  readonly type: string;
  readonly message?: { readonly role: string };
}

/**
 * Extracts a candidate `RunId` from a session entry, or `undefined` if the entry is not a
 * user-authored message entry. Callers additionally prove "first after cursor" during folding.
 */
export function runIdFromEntry(entry: EntryLike): RunId | undefined {
  if (entry.type !== "message" || entry.message === undefined) {
    return undefined;
  }
  if (entry.message.role !== "user") {
    return undefined;
  }
  if (!SESSION_ENTRY_ID_PATTERN.test(entry.id)) {
    return undefined;
  }
  return entry.id as RunId;
}

export function createRunAttemptId(): RunAttemptId {
  return randomUUID() as RunAttemptId;
}

export function runAttemptId(value: string): RunAttemptId {
  if (value.length === 0) {
    throw new Error("invalid_input: run attempt id must be non-empty");
  }
  return value as RunAttemptId;
}

/**
 * Brands a receipt path a containment verifier has already proven valid for its launch attempt.
 * The proof is the caller's; this constructor only enforces the lexical path invariant every
 * receipt location must satisfy.
 */
export function verifiedContainmentReceiptPath(path: ContainmentReceiptPath): VerifiedContainmentReceiptPath {
  const value: string = path;
  if (!isAbsolute(value) || value.includes("\0")) {
    throw new Error(`invalid_input: containment receipt path must be absolute: ${JSON.stringify(value)}`);
  }
  return path as VerifiedContainmentReceiptPath;
}

export function modelSpec(value: string): ModelSpec {
  if (value.trim().length === 0) {
    throw new Error("invalid_input: model spec must be non-empty");
  }
  return value as ModelSpec;
}

export function milliseconds(value: number): Milliseconds {
  if (!Number.isInteger(value) || value < 0) {
    throw new Error(`invalid_input: milliseconds must be a non-negative integer: ${value}`);
  }
  return value as Milliseconds;
}

export function utf8Bytes(value: number): Utf8Bytes {
  if (!Number.isInteger(value) || value < 0) {
    throw new Error(`invalid_input: byte count must be a non-negative integer: ${value}`);
  }
  return value as Utf8Bytes;
}

// --- State/completion/error/cancellation literals --------------------------

export const AgentState = {
  Running: "running",
  Settling: "settling",
  Stopping: "stopping",
  Stopped: "stopped",
} as const;
export type AgentState = (typeof AgentState)[keyof typeof AgentState];

export const CompletionState = {
  Completed: "completed",
  Failed: "failed",
  Cancelled: "cancelled",
} as const;
export type CompletionState = (typeof CompletionState)[keyof typeof CompletionState];

export const CancellationReason = {
  StopRequested: "stop_requested",
  ParentShutdown: "parent_shutdown",
} as const;
export type CancellationReason = (typeof CancellationReason)[keyof typeof CancellationReason];

export const AgentErrorCode = {
  InvalidInput: "invalid_input",
  InvalidAgent: "invalid_agent",
  InvalidState: "invalid_state",
  CapacityExceeded: "capacity_exceeded",
  SpawnFailed: "spawn_failed",
  ProtocolError: "protocol_error",
  ModelUnavailable: "model_unavailable",
  RunInterrupted: "run_interrupted",
  ProcessExited: "process_exited",
  AbortFailed: "abort_failed",
  ContainmentFailed: "containment_failed",
  TerminalPersistenceFailed: "terminal_persistence_failed",
  SessionUnavailable: "session_unavailable",
  InternalError: "internal_error",
} as const;
export type AgentErrorCode = (typeof AgentErrorCode)[keyof typeof AgentErrorCode];

export class PublicPreflightError extends Error {
  constructor(readonly code: AgentErrorCode, publicMessage: string) {
    super(truncateUtf8(`${code}: ${publicMessage}`, MAX_ERROR_MESSAGE_BYTES).text);
    this.name = "PublicPreflightError";
  }
}

export function isPublicPreflightError(value: unknown): value is PublicPreflightError {
  return value instanceof PublicPreflightError && Object.values(AgentErrorCode).includes(value.code);
}

/**
 * Stable in-process coded error: message is always `${code}: ${STABLE_ERROR_MESSAGES[code]}`.
 * Only for code-to-stable-message errors; `PublicPreflightError` keeps caller-supplied
 * public guidance and stays separate.
 */
export class CodedError extends Error {
  declare readonly code: AgentErrorCode;
  declare readonly diagnosticsPath?: DiagnosticsPath;

  constructor(code: AgentErrorCode, diagnosticsPath?: DiagnosticsPath) {
    super(truncateUtf8(`${code}: ${STABLE_ERROR_MESSAGES[code]}`, MAX_ERROR_MESSAGE_BYTES).text);
    Object.defineProperty(this, "name", { value: "CodedError", enumerable: false });
    Object.defineProperty(this, "code", { value: code, enumerable: false });
    if (diagnosticsPath !== undefined) {
      Object.defineProperty(this, "diagnosticsPath", { value: diagnosticsPath, enumerable: false });
    }
  }
}

export const AgentEventType = {
  Spawned: "spawned",
  RunLaunchRequested: "run_launch_requested",
  RunStarted: "run_started",
  RunStopping: "run_stopping",
  RunCompleted: "run_completed",
} as const;
export type AgentEventType = (typeof AgentEventType)[keyof typeof AgentEventType];

export const RestorationActionType = {
  ValidateCompletedReceipt: "validate_completed_receipt",
  ReconcileLaunch: "reconcile_launch",
  ReconcileStarted: "reconcile_started",
  ReconcileStopping: "reconcile_stopping",
} as const;
export type RestorationActionType =
  (typeof RestorationActionType)[keyof typeof RestorationActionType];

// --- Legal state transitions -------------------------------------------

const LEGAL_TRANSITIONS: ReadonlySet<string> = new Set([
  `${AgentState.Stopped}->${AgentState.Running}`,
  `${AgentState.Running}->${AgentState.Settling}`,
  `${AgentState.Running}->${AgentState.Stopping}`,
  `${AgentState.Settling}->${AgentState.Stopped}`,
  `${AgentState.Stopping}->${AgentState.Stopped}`,
]);

/** Throws `invalid_state` unless `from -> to` is a legal agent lifecycle transition. */
export function assertTransition(from: AgentState, to: AgentState): void {
  if (!LEGAL_TRANSITIONS.has(`${from}->${to}`)) {
    throw new Error(`invalid_state: cannot transition from "${from}" to "${to}"`);
  }
}

export function isLegalTransition(from: AgentState, to: AgentState): boolean {
  return LEGAL_TRANSITIONS.has(`${from}->${to}`);
}

// --- Usage, errors, completions ---------------------------------------

type PiSessionMessage = Extract<SessionEntry, { type: "message" }>["message"];
type PiAssistantMessage = Extract<PiSessionMessage, { role: "assistant" }>;

/** Pi's public assistant-usage shape, derived from coding-agent session entries. */
export type Usage = PiAssistantMessage["usage"];
export type Cost = Usage["cost"];

/** Pi's public thinking-level union, including `off`. */
export type ThinkingLevel = NonNullable<ResolveCliModelResult["thinkingLevel"]>;

/**
 * Single source of the thinking levels as runtime values. The tripwire below breaks
 * `bun tsc --noEmit` if this list ever drifts from Pi's `ThinkingLevel` union.
 */
export const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;

type _ThinkingLevelsMatchPi = (typeof THINKING_LEVELS)[number] extends ThinkingLevel
  ? ThinkingLevel extends (typeof THINKING_LEVELS)[number]
    ? true
    : never
  : never;
const _thinkingLevelsMatchPi: _ThinkingLevelsMatchPi = true;
void _thinkingLevelsMatchPi;

export interface AgentUsage {
  turns: number;
  usage: Usage;
}

export interface AgentError {
  code: AgentErrorCode;
  message: string;
  diagnosticsPath?: DiagnosticsPath;
}

export type TerminalFailureCode =
  | typeof AgentErrorCode.SpawnFailed
  | typeof AgentErrorCode.ProtocolError
  | typeof AgentErrorCode.RunInterrupted
  | typeof AgentErrorCode.ProcessExited;

/** Bounded failure provenance retained from transport observation through finalisation. */
export interface TerminalFailureCause extends AgentError {
  code: TerminalFailureCode;
}

export function terminalFailureCause(code: TerminalFailureCode): TerminalFailureCause {
  return toAgentError(code) as TerminalFailureCause;
}

export interface CompletionOutput {
  text: string;
  originalBytes: Utf8Bytes;
  retainedBytes: Utf8Bytes;
  truncated: boolean;
}

export interface CompletionBase {
  agentId: AgentId;
  runId: RunId;
  output: CompletionOutput;
  outputPath: CommittedOutputPath;
  transcriptPath: SessionPath;
  usage?: AgentUsage;
}

export interface CompletedCompletion extends CompletionBase {
  state: typeof CompletionState.Completed;
}

export interface FailedCompletion extends CompletionBase {
  state: typeof CompletionState.Failed;
  error: AgentError;
}

export interface CancelledCompletion extends CompletionBase {
  state: typeof CompletionState.Cancelled;
  reason: CancellationReason;
}

export type AgentCompletion = CompletedCompletion | FailedCompletion | CancelledCompletion;

const STABLE_ERROR_MESSAGES: Record<AgentErrorCode, string> = {
  [AgentErrorCode.InvalidInput]: "invalid input",
  [AgentErrorCode.InvalidAgent]: "unknown or unowned agent",
  [AgentErrorCode.InvalidState]: "agent is not in a valid state for this operation",
  [AgentErrorCode.CapacityExceeded]: "maximum concurrent runs exceeded",
  [AgentErrorCode.SpawnFailed]: "failed to spawn child agent",
  [AgentErrorCode.ProtocolError]: "child process protocol error",
  [AgentErrorCode.ModelUnavailable]: "requested model is unavailable",
  [AgentErrorCode.RunInterrupted]: "run was interrupted before completion",
  [AgentErrorCode.ProcessExited]: "child process exited unexpectedly",
  [AgentErrorCode.AbortFailed]: "failed to abort child run",
  [AgentErrorCode.ContainmentFailed]: "could not confirm child process termination",
  [AgentErrorCode.TerminalPersistenceFailed]: "child was contained but its terminal record could not be persisted",
  [AgentErrorCode.SessionUnavailable]: "child session is unavailable",
  [AgentErrorCode.InternalError]: "internal agent result is invalid",
};

/**
 * Builds the bounded, stable `AgentError` DTO for `code`. The stable message never contains
 * raw exception text or transport state; callers write those details only to bounded
 * diagnostics files and pass the resulting path as `diagnosticsPath`.
 */
export function toAgentError(
  code: AgentErrorCode,
  diagnosticsPath?: DiagnosticsPath,
): AgentError {
  const message = truncateUtf8(STABLE_ERROR_MESSAGES[code], MAX_ERROR_MESSAGE_BYTES).text;
  if (diagnosticsPath !== undefined) {
    return { code, message, diagnosticsPath };
  }
  return { code, message };
}

/** Converts an in-process `CodedError` to its DTO, preserving the diagnostics path. */
export function codedErrorToAgentError(error: CodedError): AgentError {
  return toAgentError(error.code, error.diagnosticsPath);
}

/**
 * Truncates `text` to a valid UTF-8 prefix of at most `maxBytes` bytes. Never splits a
 * multi-byte UTF-8 sequence.
 */
export function truncateUtf8(text: string, maxBytes: number): CompletionOutput {
  const encoded = new TextEncoder().encode(text);
  const originalBytes = encoded.byteLength;
  if (originalBytes <= maxBytes) {
    return {
      text,
      originalBytes: originalBytes as Utf8Bytes,
      retainedBytes: originalBytes as Utf8Bytes,
      truncated: false,
    };
  }
  const prefix = encoded.subarray(0, Math.max(0, maxBytes));
  const decoded = new TextDecoder("utf-8", { fatal: false }).decode(prefix, { stream: true });
  const retainedBytes = new TextEncoder().encode(decoded).byteLength;
  return {
    text: decoded,
    originalBytes: originalBytes as Utf8Bytes,
    retainedBytes: retainedBytes as Utf8Bytes,
    truncated: true,
  };
}

/** Keeps the newest complete UTF-8 code points within `maxBytes`. */
export function retainUtf8Tail(text: string, maxBytes: number): string {
  const encoded = new TextEncoder().encode(text);
  if (encoded.byteLength <= maxBytes) return text;
  let start = encoded.byteLength - Math.max(0, maxBytes);
  while (start < encoded.byteLength && (encoded[start]! & 0xc0) === 0x80) start++;
  return new TextDecoder("utf-8", { fatal: true }).decode(encoded.subarray(start));
}

// --- Persisted lifecycle event payloads ------------------------------

export interface SpawnedPayload {
  agentId: AgentId;
  sessionPath: SessionPath;
  cwd: AbsolutePath;
  provider: string;
  modelId: ModelSpec;
  thinkingLevel: ThinkingLevel;
  tools: readonly string[];
}

export interface RunLaunchRequestedPayloadV1 {
  agentId: AgentId;
  previousLeafId: SessionEntryId | null;
  attemptId: RunAttemptId;
  containmentReceiptPath: ContainmentReceiptPath;
}

export interface RunLaunchRequestedPayloadV2 extends RunLaunchRequestedPayloadV1 {
  containment: ContainmentDescriptor;
}

export type RunLaunchRequestedPayload = RunLaunchRequestedPayloadV2;

export interface RunStartedPayload {
  agentId: AgentId;
  runId: RunId;
  attemptId: RunAttemptId;
}

export interface RunStoppingPayload {
  agentId: AgentId;
  runId: RunId;
  reason: CancellationReason;
  containmentReceiptPath: ContainmentReceiptPath;
}

export type RunCompletedPayload = AgentCompletion;

export interface AgentEventPayloadMapV1 {
  [AgentEventType.Spawned]: SpawnedPayload;
  [AgentEventType.RunLaunchRequested]: RunLaunchRequestedPayloadV1;
  [AgentEventType.RunStarted]: RunStartedPayload;
  [AgentEventType.RunStopping]: RunStoppingPayload;
  [AgentEventType.RunCompleted]: RunCompletedPayload;
}

export interface AgentEventPayloadMap extends AgentEventPayloadMapV1 {
  [AgentEventType.RunLaunchRequested]: RunLaunchRequestedPayloadV2;
}

export type PersistedAgentEventV1 = {
  [K in AgentEventType]: {
    schemaVersion: 1;
    eventType: K;
    payload: AgentEventPayloadMapV1[K];
  };
}[AgentEventType];

export type PersistedAgentEventV2 = {
  [K in AgentEventType]: {
    schemaVersion: 2;
    eventType: K;
    payload: AgentEventPayloadMap[K];
  };
}[AgentEventType];

export type PersistedAgentEvent = PersistedAgentEventV1 | PersistedAgentEventV2;
