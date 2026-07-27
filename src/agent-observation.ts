import {
  AgentState,
  CompletionState,
  agentDepth,
  type AbsolutePath,
  type BoundedTranscriptJson,
  type ActivityText,
  type AgentCount,
  type AgentDepth,
  type AgentId,
  type AgentObservationRevision,
  type AgentOrdinal,
  type AgentWidgetRevision,
  type ContextLabel,
  type ContextPercent,
  type ConversationCallKey,
  type ConversationRevision,
  type ConversationTurnKey,
  type PresentationCwd,
  type SafePresentationJson,
  type ModelLabel,
  type ModelSpec,
  type RunId,
  type RunAttemptId,
  type SessionPath,
  type AgentRunKey,
  type AgentCompletion,
  type TaskLabel,
  type ThinkingLevel,
  type ToolDisplayName,
  type RpcContentIndex,
  type RpcStopReason,
  type RpcToolCallId,
  type Usage,
  type SelectedTranscriptRevision,
  type TranscriptFileName,
  type TranscriptRevision,
  type TranscriptRoute,
  type TranscriptSequence,
  type TranscriptText,
  type TranscriptAssistantGroup,
  type ConversationStopReason,
} from "./domain.ts";

export type AgentDisplayState = AgentState | CompletionState;
export type ContextObservation =
  | { readonly kind: "known"; readonly percent: ContextPercent }
  | { readonly kind: "unavailable" };
export type AgentActivity =
  | { readonly kind: "idle" }
  | { readonly kind: "responding"; readonly preview?: ActivityText }
  | { readonly kind: "thinking"; readonly preview?: ActivityText }
  | { readonly kind: "tool"; readonly tool: ToolDisplayName; readonly phase: "running" | "completed" | "failed"; readonly preview?: ActivityText }
  | { readonly kind: "unavailable"; readonly reason: "transport" | "restoration" | "projection" };

export interface AgentObservation {
  readonly agentId: AgentId;
  readonly ordinal: AgentOrdinal;
  readonly taskLabel: TaskLabel;
  readonly modelLabel: ModelLabel;
  readonly context: ContextObservation;
  readonly lifecycleState: AgentState;
  readonly displayState: AgentDisplayState;
  readonly activity: AgentActivity;
  readonly completionPendingDelivery: boolean;
  readonly revision: AgentObservationRevision;
}
export type ObservationHealthCode = "projection-failed" | "reconciliation-failed";
export type ObservationHealth = { readonly kind: "healthy" } | { readonly kind: "degraded"; readonly codes: readonly ObservationHealthCode[] };
export interface DirectAgentProjection { readonly agentId: AgentId; readonly observation: AgentObservation; readonly row: AgentRow; readonly transcriptFile?: TranscriptFileName }
export type DirectAgentSnapshotResult =
  | { readonly kind: "snapshot"; readonly revision: AgentObservationRevision; readonly health: ObservationHealth; readonly total: AgentCount; readonly omitted: AgentCount; readonly omittedActive: AgentCount; readonly entries: readonly DirectAgentProjection[] }
  | { readonly kind: "unavailable"; readonly finalRevision: AgentObservationRevision };
export interface ObservationChange { readonly revision: AgentObservationRevision; readonly health: ObservationHealth; readonly changed: readonly AgentOrdinal[]; readonly rescanRequired: boolean }
export type ObservationListener = (change: ObservationChange) => void;
export interface SubagentObservationPort {
  observation(agentId: AgentId): AgentObservation | undefined;
  directSnapshot(): DirectAgentSnapshotResult;
  transcriptSource(agentId: AgentId): TranscriptSource | undefined;
  subscribe(listener: ObservationListener): () => void;
}

export interface ObservationAgentAuthority {
  readonly agentId: AgentId;
  readonly sessionPath: SessionPath;
  readonly cwd: AbsolutePath;
  readonly model: ModelSpec;
  readonly thinkingLevel: ThinkingLevel;
}
export interface SpawnObservationInput extends ObservationAgentAuthority {
  readonly ordinal: AgentOrdinal;
  readonly assignment: string;
}
export interface AcceptedRunObservationInput {
  readonly agentId: AgentId;
  readonly runId: RunId;
  readonly attemptId: RunAttemptId;
  readonly assignment: string;
}
export interface ObservationRunAuthority {
  readonly agentId: AgentId;
  readonly state: AgentState;
  readonly runId?: RunId;
}
export interface ObservationSensitiveValues {
  readonly agentIds: ReadonlySet<AgentId>;
  readonly runIds: ReadonlySet<RunId>;
  readonly internalPaths: ReadonlySet<AbsolutePath>;
}
export interface ObservationReconciliationSnapshot {
  readonly spawnSequence: readonly AgentId[];
  readonly agents: readonly ObservationAgentAuthority[];
  readonly runs: readonly ObservationRunAuthority[];
  readonly completions: readonly AgentCompletion[];
  readonly pendingDelivery: ReadonlySet<AgentRunKey>;
  readonly acceptedAssignments: ReadonlyMap<AgentRunKey, string>;
  readonly sensitiveValues: ObservationSensitiveValues;
}

export interface AgentRow {
  readonly ordinal: AgentOrdinal;
  readonly depth: AgentDepth;
  readonly model: ModelLabel;
  readonly context: ContextLabel;
  readonly taskLabel: TaskLabel;
  readonly state: AgentDisplayState;
}
export interface AgentWidgetSnapshot { readonly revision: AgentWidgetRevision; readonly rows: readonly AgentRow[]; readonly total: AgentCount; readonly omitted: AgentCount; readonly degraded: boolean }
export interface AgentWidgetSource { snapshot(): AgentWidgetSnapshot; transcriptSource(ordinal: AgentOrdinal): SelectedTranscriptSource | undefined; subscribe(onChange: () => void): () => void }

export interface TranscriptSensitiveValues {
  readonly nativeIds: ReadonlySet<string>;
  readonly managedPathsAndNames: ReadonlySet<string>;
  /** Sticky fail-closed state: bounded history discarded at least one sensitive value. */
  readonly overflowed: boolean;
}
export interface TranscriptToolResult {
  readonly content: readonly TranscriptText[];
  readonly details?: BoundedTranscriptJson;
  readonly isError: boolean;
}
export interface TranscriptToolPresentation {
  readonly callId?: RpcToolCallId;
  readonly tool: ToolDisplayName;
  readonly phase: "running" | "completed" | "failed";
  readonly arguments?: BoundedTranscriptJson;
  readonly result?: TranscriptToolResult;
  readonly preview?: TranscriptText;
}
export type TranscriptAssistantBlock =
  | { readonly kind: "text"; readonly phase: "partial" | "final"; readonly text: TranscriptText }
  | { readonly kind: "thinking"; readonly phase: "partial" | "final"; readonly text: TranscriptText }
  | { readonly kind: "tool"; readonly presentation: TranscriptToolPresentation };
export type TranscriptItem =
  | { readonly sequence: TranscriptSequence; readonly runId: RunId; readonly kind: "user"; readonly text: TranscriptText }
  | { readonly sequence: TranscriptSequence; readonly runId?: RunId; readonly kind: "assistant"; readonly group: TranscriptAssistantGroup; readonly phase: "partial" | "final"; readonly stopReason?: ConversationStopReason; readonly blocks: readonly TranscriptAssistantBlock[] }
  | { readonly sequence: TranscriptSequence; readonly kind: "notice"; readonly code: "transport-unavailable" | "projection-unavailable" | "context-compacted" };
export interface TranscriptSnapshot {
  readonly revision: TranscriptRevision;
  readonly items: readonly TranscriptItem[];
  readonly truncatedBefore: boolean;
  readonly availability: "live" | "stopped" | "unavailable";
  readonly sensitiveValues: TranscriptSensitiveValues;
  /** Candidate child working directory; the projector alone validates and brands it. */
  readonly renderingCwd?: AbsolutePath;
}
export type TranscriptListener = (snapshot: TranscriptSnapshot) => void;
export interface TranscriptSource { snapshot(): TranscriptSnapshot; subscribe(listener: TranscriptListener): () => void }

/** A transcript source whose lifetime, display state and route validity one owner controls. */
export interface ManagedTranscriptSource extends TranscriptSource {
  /** Reports the selected row's display state; availability and run finality follow from it. */
  setDisplayState(state: AgentDisplayState): void;
  /** Reports that the capability locating this transcript no longer resolves. */
  markRouteUnavailable(): void;
  dispose(): void;
}

/**
 * A managed transcript that can also prove it read past the last byte written before the run
 * terminated. A later merge uses that proof to decide when live observation may be dropped.
 */
export interface AuthoritativeTranscriptSource extends ManagedTranscriptSource {
  postTerminalEndReached(): boolean;
}

/** One atomic view of the selected row and its conversation, published under one revision. */
export interface SelectedTranscriptSnapshot {
  readonly revision: SelectedTranscriptRevision;
  readonly transcript: TranscriptSnapshot;
  readonly row: AgentRow;
  readonly routeAvailable: boolean;
}
export interface SelectedTranscriptSource {
  snapshot(): SelectedTranscriptSnapshot;
  subscribe(listener: (snapshot: SelectedTranscriptSnapshot) => void): () => void;
}

export type ConversationToolRendering = "native-built-in" | "native-generic" | "renderer-override";

export interface ConversationToolPresentation {
  readonly callKey: ConversationCallKey;
  readonly tool: ToolDisplayName;
  readonly phase: "running" | "completed" | "failed";
  readonly arguments?: SafePresentationJson;
  readonly result?: {
    readonly content: readonly TranscriptText[];
    readonly details?: SafePresentationJson;
    readonly isError: boolean;
  };
  readonly preview?: TranscriptText;
  readonly rendering: ConversationToolRendering;
}

export type ConversationAssistantBlock =
  | { readonly kind: "text"; readonly text: TranscriptText }
  | { readonly kind: "thinking"; readonly text: TranscriptText }
  | { readonly kind: "tool"; readonly presentation: ConversationToolPresentation };

export type ConversationTurn =
  | { readonly key: ConversationTurnKey; readonly kind: "user"; readonly text: TranscriptText }
  | { readonly key: ConversationTurnKey; readonly kind: "assistant"; readonly phase: "partial" | "final"; readonly stopReason?: ConversationStopReason; readonly blocks: readonly ConversationAssistantBlock[] }
  | { readonly key: ConversationTurnKey; readonly kind: "notice"; readonly code: "transport-unavailable" | "projection-unavailable" | "context-compacted" };

export interface ConversationHeader {
  readonly ordinal: AgentOrdinal;
  readonly model: ModelLabel;
  readonly context: ContextLabel;
  readonly taskLabel: TaskLabel;
  readonly state: AgentDisplayState;
}

/** Atomic, correlation-free input to the read-only child-conversation UI. */
export interface ConversationSnapshot {
  readonly revision: ConversationRevision;
  readonly turns: readonly ConversationTurn[];
  readonly truncatedBefore: boolean;
  readonly availability: "live" | "stopped" | "unavailable";
  readonly header: ConversationHeader;
  readonly routeAvailable: boolean;
  readonly renderingCwd?: PresentationCwd;
}

export interface ManagedSelectedTranscriptSource extends SelectedTranscriptSource {
  /** Applies the latest index refresh; an absent or unequal route retains the last-known row. */
  update(current: { readonly route: TranscriptRoute; readonly row: AgentRow } | undefined): void;
  dispose(): void;
}

export interface FinalAssistantBlock {
  readonly contentIndex: RpcContentIndex;
  readonly kind: "text" | "thinking";
  readonly text: TranscriptText;
}

export type AssistantContentObservationEvent =
  | { readonly kind: "assistant-content"; readonly contentIndex: RpcContentIndex; readonly contentKind: "text" | "thinking"; readonly phase: "start" }
  | { readonly kind: "assistant-content"; readonly contentIndex: RpcContentIndex; readonly contentKind: "text" | "thinking"; readonly phase: "delta"; readonly delta: TranscriptText }
  | { readonly kind: "assistant-content"; readonly contentIndex: RpcContentIndex; readonly contentKind: "text" | "thinking"; readonly phase: "end"; readonly text: TranscriptText };

export type RpcObservationEvent =
  | { readonly kind: "prompt-accepted"; readonly text: TranscriptText }
  | { readonly kind: "assistant-start" }
  | AssistantContentObservationEvent
  | { readonly kind: "assistant-end"; readonly finalBlocks: readonly FinalAssistantBlock[]; readonly usage: Usage; readonly stopReason: RpcStopReason }
  | { readonly kind: "tool"; readonly toolCallId: RpcToolCallId; readonly tool: ToolDisplayName; readonly phase: "running" | "completed" | "failed"; readonly preview?: TranscriptText; readonly arguments?: BoundedTranscriptJson; readonly result?: TranscriptToolResult }
  | { readonly kind: "turn-end" }
  | { readonly kind: "agent-settled" }
  | { readonly kind: "compaction"; readonly phase: "start" | "end" }
  | { readonly kind: "transport-unavailable" };

export interface RpcObservationSink {
  record(event: RpcObservationEvent): void;
  bind(runId: RunId): void;
  discard(): void;
}

export interface ObservationAttemptSinkFactory {
  createAttemptSink(agentId: AgentId, attemptId: RunAttemptId): RpcObservationSink;
}

export interface TaskLabelContext {
  readonly knownAgentIds: ReadonlySet<AgentId>;
  readonly knownRunIds: ReadonlySet<RunId>;
  readonly knownInternalPaths: ReadonlySet<AbsolutePath>;
  /** Sticky fail-closed state: bounded sensitive history discarded at least one value. */
  readonly sensitiveHistoryOverflowed: boolean;
}

const CONTROL_PATTERN = /[\u0000-\u001f\u007f-\u009f\u061c\u200e-\u200f\u202a-\u202e\u2066-\u2069]/gu;
const ANSI_PATTERN = /\u001b(?:\[[0-?]*[ -/]*[@-~]|\][^\u0007]*(?:\u0007|\u001b\\))/gu;
const PATH_TOKEN_PATTERN = /(?:[A-Za-z]:[\\/]|(?:\.{0,2}|~)?[\\/])\S+|\b\S*[\\/]\S+\b/gu;
const encoder = new TextEncoder();

export function deriveTaskLabel(assignment: string, context: TaskLabelContext): TaskLabel {
  if (context.sensitiveHistoryOverflowed) return "Delegated task" as TaskLabel;
  const line = assignment.replaceAll("\r\n", "\n").split("\n")
    .find((value) => value.trim().length > 0 && !isStandaloneFence(value))?.trim() ?? "";
  const sentence = /^(.+?[.!?])(?:\s|$)/u.exec(line)?.[1] ?? line;
  let value = sentence
    .replace(ANSI_PATTERN, "")
    .replace(CONTROL_PATTERN, " ")
    .replace(/```|~~~/gu, "")
    .replace(/^\s{0,3}(?:#{1,6}|[-+*>]|\d+[.)])\s*/u, "")
    .replace(/\[([^\]]+)\]\([^)]*\)/gu, "$1")
    .replace(/[*_~`]+/gu, "")
    .replace(/[.!?]+$/u, "");
  const sensitive = [...context.knownAgentIds, ...context.knownRunIds, ...context.knownInternalPaths]
    .map(String).filter((item) => item.length > 0).sort((a, b) => b.length - a.length);
  for (const item of sensitive) value = value.replaceAll(item, "path");
  value = value.replace(PATH_TOKEN_PATTERN, "path").replace(/\s+/gu, " ").trim();
  if (isOpaque(value)) value = "";
  value = boundedPrefix(value, 80, 512).trim();
  return (value.length === 0 ? "Delegated task" : value) as TaskLabel;
}

export function deriveModelLabel(model: ModelSpec, thinking: ThinkingLevel): ModelLabel {
  const separator = model.indexOf("/");
  const id = model.slice(separator + 1);
  const suffix: Record<ThinkingLevel, string> = { off: "off", minimal: "min", low: "l", medium: "m", high: "h", xhigh: "xh", max: "max" };
  return displayText(`${id}:${suffix[thinking]}`, 1_024, "model label") as ModelLabel;
}
export function unknownModelLabel(): ModelLabel { return "model:unknown" as ModelLabel }
export function activityText(value: string): ActivityText {
  return boundedDisplayText(value, 160, 512, "activity text", true) as ActivityText;
}
export function transcriptText(value: string): TranscriptText {
  return controlSafeText(value, 8_192, "transcript text", true) as TranscriptText;
}
export function toolDisplayName(value: string): ToolDisplayName {
  return displayText(value, 256, "tool display name") as ToolDisplayName;
}
/** Sanitises untrusted external text into bounded control-free transcript text. */
export function safeTranscriptText(value: string): TranscriptText {
  return transcriptText(boundedPrefix(stripControl(value), 8_192, 8_192));
}
/** Sanitises an untrusted external tool name; an empty result names no displayable tool. */
export function trySafeToolDisplayName(value: string): ToolDisplayName | undefined {
  const bounded = boundedPrefix(stripControl(value), 256, 256).trim();
  return bounded.length === 0 ? undefined : (bounded as ToolDisplayName);
}
/** True once a display state can no longer produce further conversation of its own accord. */
export function isTerminalDisplayState(state: AgentDisplayState): boolean {
  switch (state) {
    case AgentState.Running:
    case AgentState.Settling:
    case AgentState.Stopping:
      return false;
    case AgentState.Stopped:
    case CompletionState.Completed:
    case CompletionState.Failed:
    case CompletionState.Cancelled:
      return true;
  }
}
export function contextLabel(context: ContextObservation): ContextLabel {
  if (context.kind === "unavailable") return "?%" as ContextLabel;
  const rounded = Math.round(context.percent);
  return (rounded > 999 ? "999+%" : `${rounded}%`) as ContextLabel;
}
export function deriveDisplayState(lifecycle: AgentState, completion?: CompletionState): AgentDisplayState {
  return lifecycle === AgentState.Stopped ? completion ?? AgentState.Stopped : lifecycle;
}
export function directAgentRow(observation: AgentObservation): AgentRow {
  return Object.freeze({ ordinal: observation.ordinal, depth: agentDepth(0), model: observation.modelLabel, context: contextLabel(observation.context), taskLabel: observation.taskLabel, state: observation.displayState });
}

function displayText(value: string, maxBytes: number, label: string): string {
  return controlSafeText(value, maxBytes, label, false);
}
function controlSafeText(value: string, maxBytes: number, label: string, allowEmpty: boolean): string {
  ANSI_PATTERN.lastIndex = 0; CONTROL_PATTERN.lastIndex = 0;
  const unsafe = (!allowEmpty && value.length === 0) || ANSI_PATTERN.test(value) || CONTROL_PATTERN.test(value) || encoder.encode(value).byteLength > maxBytes;
  ANSI_PATTERN.lastIndex = 0; CONTROL_PATTERN.lastIndex = 0;
  if (unsafe) throw new Error(`invalid_input: invalid ${label}`);
  return value;
}
function boundedDisplayText(value: string, maxCodePoints: number, maxBytes: number, label: string, allowEmpty = false): string {
  if ([...value].length > maxCodePoints) throw new Error(`invalid_input: invalid ${label}`);
  return controlSafeText(value, maxBytes, label, allowEmpty);
}
function stripControl(value: string): string {
  ANSI_PATTERN.lastIndex = 0; CONTROL_PATTERN.lastIndex = 0;
  const stripped = value.replace(ANSI_PATTERN, "").replace(CONTROL_PATTERN, " ");
  ANSI_PATTERN.lastIndex = 0; CONTROL_PATTERN.lastIndex = 0;
  return stripped;
}
function boundedPrefix(value: string, maxCodePoints: number, maxBytes: number): string {
  let output = ""; let points = 0; let bytes = 0;
  for (const point of value) { const pointBytes = encoder.encode(point).byteLength; if (points === maxCodePoints || bytes + pointBytes > maxBytes) break; output += point; points++; bytes += pointBytes; }
  return output;
}
function isStandaloneFence(value: string): boolean {
  return /^ {0,3}(?:`{3,}[^`]*|~{3,}.*)\s*$/u.test(value);
}
function isOpaque(value: string): boolean {
  if (value.length === 0) return true;
  if (/^[{[]|^[A-Za-z0-9_-]{20,}$|^[0-9a-f]{8,}$|^[0-9a-f]{8}-[0-9a-f-]{27,}$/iu.test(value)) return true;
  return value === "path";
}
