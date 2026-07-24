import { randomUUID } from "node:crypto";
import { isAbsolute } from "node:path";

import type { ResolveCliModelResult, SessionEntry } from "@earendil-works/pi-coding-agent";

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
export type UIRequestId = Brand<string, "UIRequestId">;
export type RunAttemptId = Brand<string, "RunAttemptId">;
export type ProviderId = Brand<string, "ProviderId">;
export type ModelId = Brand<string, "ModelId">;
export type ToolName = Brand<string, "ToolName">;
export type ModelSpec = Brand<string, "PiCliModelSpec">;
export type AbsolutePath = Brand<string, "AbsolutePath">;
export type CgroupScopePath = AbsolutePath & Brand<string, "CgroupScopePath">;
export type ObservationSnapshotPath = AbsolutePath & Brand<string, "ObservationSnapshotPath">;
export type SessionPath = AbsolutePath & Brand<string, "ContainedSessionFile">;
export type OutputPath = AbsolutePath & Brand<string, "OutputFileLocation">;
export type CommittedOutputPath = OutputPath & Brand<string, "CommittedOutputFile">;
export type DiagnosticsPath = AbsolutePath & Brand<string, "DiagnosticsFileLocation">;
export type ContainmentReceiptPath = AbsolutePath & Brand<string, "ContainmentReceiptLocation">;
export type VerifiedContainmentReceiptPath = ContainmentReceiptPath &
  Brand<string, "VerifiedContainmentReceipt">;
export type Milliseconds = Brand<number, "Milliseconds">;
export type Utf8Bytes = Brand<number, "Utf8Bytes">;
export type Utf16CodeUnitOffset = Brand<number, "Utf16CodeUnitOffset">;
export type DelegationDepth = Brand<number, "DelegationDepth">;
export type RunCapacity = Brand<number, "RunCapacity">;
export type ProcessCount = Brand<number, "ProcessCount">;
export type ProcessId = Brand<number, "ProcessId">;
export type ProcessGroupId = Brand<number, "ProcessGroupId">;
export type ObservationRevision = Brand<number, "ObservationRevision">;

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

export function createRpcRequestId(): RpcRequestId {
  return rpcRequestId(randomUUID());
}

export function rpcRequestId(value: string): RpcRequestId {
  if (value.length === 0) {
    throw new Error("protocol_error: rpc request id must be non-empty");
  }
  return value as RpcRequestId;
}

export function uiRequestId(value: string): UIRequestId {
  if (value.length === 0) {
    throw new Error("protocol_error: ui request id must be non-empty");
  }
  return value as UIRequestId;
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

const ASCII_CONTROL_PATTERN = /[\u0000-\u001f\u007f]/u;
const MAX_TOOL_NAME_BYTES = 256;

export function providerId(value: string): ProviderId {
  if (value.length === 0 || value.trim() !== value || value.includes("/") || ASCII_CONTROL_PATTERN.test(value)) {
    throw new Error(`invalid_input: invalid provider id: ${JSON.stringify(value)}`);
  }
  return value as ProviderId;
}

export function modelId(value: string): ModelId {
  if (value.length === 0 || value.trim() !== value || ASCII_CONTROL_PATTERN.test(value)) {
    throw new Error(`invalid_input: invalid model id: ${JSON.stringify(value)}`);
  }
  return value as ModelId;
}

export function toolName(value: string): ToolName {
  if (value.length === 0 || new TextEncoder().encode(value).byteLength > MAX_TOOL_NAME_BYTES ||
      ASCII_CONTROL_PATTERN.test(value)) {
    throw new Error(`invalid_input: invalid tool name: ${JSON.stringify(value)}`);
  }
  return value as ToolName;
}

export function modelSpecFrom(provider: ProviderId, model: ModelId): ModelSpec {
  return `${provider}/${model}` as ModelSpec;
}

export function modelSpec(value: string): ModelSpec {
  const slash = value.indexOf("/");
  if (slash === -1) {
    throw new Error("invalid_input: model spec must contain provider and model id");
  }
  return modelSpecFrom(providerId(value.slice(0, slash)), modelId(value.slice(slash + 1)));
}

export function modelSpecParts(value: ModelSpec): { readonly provider: ProviderId; readonly modelId: ModelId } {
  const slash = value.indexOf("/");
  return {
    provider: providerId(value.slice(0, slash)),
    modelId: modelId(value.slice(slash + 1)),
  };
}

export function milliseconds(value: number): Milliseconds {
  requireNonnegativeSafeInteger(value, "milliseconds");
  return value as Milliseconds;
}

export function utf8Bytes(value: number): Utf8Bytes {
  requireNonnegativeSafeInteger(value, "byte count");
  return value as Utf8Bytes;
}

export function utf16CodeUnitOffset(value: number): Utf16CodeUnitOffset {
  requireNonnegativeSafeInteger(value, "UTF-16 code unit offset");
  return value as Utf16CodeUnitOffset;
}

export function delegationDepth(value: number): DelegationDepth {
  requireNonnegativeSafeInteger(value, "delegation depth");
  return value as DelegationDepth;
}

export function nextDelegationDepth(value: DelegationDepth): DelegationDepth {
  return delegationDepth(value + 1);
}

export function runCapacity(value: number): RunCapacity {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new Error(`invalid_input: run capacity must be a positive safe integer: ${value}`);
  }
  return value as RunCapacity;
}

export function processCount(value: number): ProcessCount {
  requireNonnegativeSafeInteger(value, "process count");
  return value as ProcessCount;
}

export function processId(value: number): ProcessId {
  requirePositiveSafeInteger(value, "process id");
  return value as ProcessId;
}

export function processGroupId(value: number): ProcessGroupId {
  requirePositiveSafeInteger(value, "process group id");
  return value as ProcessGroupId;
}

export function observationRevision(value: number): ObservationRevision {
  requireNonnegativeSafeInteger(value, "observation revision");
  return value as ObservationRevision;
}

function requirePositiveSafeInteger(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new Error(`invalid_input: ${label} must be a positive safe integer: ${value}`);
  }
}

function requireNonnegativeSafeInteger(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`invalid_input: ${label} must be a non-negative safe integer: ${value}`);
  }
}

/** Maximum UTF-8 bytes retained per persisted or model-visible error message. */
export const MAX_ERROR_MESSAGE_BYTES = utf8Bytes(10_000);

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

export interface RestorableCompletionBase extends Omit<CompletionBase, "outputPath"> {
  outputPath: OutputPath;
}

export type RestorableAgentCompletion =
  | (RestorableCompletionBase & { state: typeof CompletionState.Completed })
  | (RestorableCompletionBase & { state: typeof CompletionState.Failed; error: AgentError })
  | (RestorableCompletionBase & {
      state: typeof CompletionState.Cancelled;
      reason: CancellationReason;
    });

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
export function truncateUtf8(text: string, maxBytes: Utf8Bytes): CompletionOutput {
  const encoded = new TextEncoder().encode(text);
  const originalBytes = utf8Bytes(encoded.byteLength);
  if (originalBytes <= maxBytes) {
    return {
      text,
      originalBytes,
      retainedBytes: originalBytes,
      truncated: false,
    };
  }
  const prefix = encoded.subarray(0, maxBytes);
  const decoded = new TextDecoder("utf-8", { fatal: false }).decode(prefix, { stream: true });
  const retainedBytes = utf8Bytes(new TextEncoder().encode(decoded).byteLength);
  return {
    text: decoded,
    originalBytes,
    retainedBytes,
    truncated: true,
  };
}

/** Keeps the newest complete UTF-8 code points within `maxBytes`. */
export function retainUtf8Tail(text: string, maxBytes: Utf8Bytes): string {
  const encoded = new TextEncoder().encode(text);
  if (encoded.byteLength <= maxBytes) return text;
  let start = encoded.byteLength - maxBytes;
  while (start < encoded.byteLength && (encoded[start]! & 0xc0) === 0x80) start++;
  return new TextDecoder("utf-8", { fatal: true }).decode(encoded.subarray(start));
}

// --- Persisted lifecycle event payloads ------------------------------

export interface SpawnedPayload {
  agentId: AgentId;
  sessionPath: SessionPath;
  cwd: AbsolutePath;
  provider: ProviderId;
  modelId: ModelId;
  thinkingLevel: ThinkingLevel;
  tools: readonly ToolName[];
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
