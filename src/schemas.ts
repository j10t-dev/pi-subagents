import { Type } from "typebox";
import type { Static, TLiteral, TSchema, TUnion } from "typebox";
import { Value } from "typebox/value";

import {
  AgentErrorCode,
  AgentEventType,
  CancellationReason,
  CompletionState,
  THINKING_LEVELS,
  agentId,
  milliseconds,
  sessionEntryId,
  uiRequestId,
} from "./domain.ts";
import type {
  AgentId,
  BoundedTranscriptJson,
  Milliseconds,
  ReadonlyJsonValue,
  SafePresentationJson,
  SessionEntryId,
  ThinkingLevel,
  UIRequestId,
  Usage,
} from "./domain.ts";
import {
  MAX_COMPLETION_OUTPUT_BYTES,
  MAX_ERROR_MESSAGE_BYTES,
  MAX_MAX_DEPTH,
  MAX_TRANSCRIPT_SOURCE_ITEMS,
  MAX_TOOL_JSON_BYTES,
  MAX_TOOL_JSON_DEPTH,
  MAX_TOOL_JSON_NODES,
  MAX_TOOL_JSON_STRING_BYTES,
} from "./constants.ts";

type LiteralSchemas<T extends readonly string[]> = {
  -readonly [K in keyof T]: TLiteral<T[K]>;
};

/**
 * Union of string literals that preserves each literal in the resulting `Static<>` type.
 * `Type.Union` alone widens a mapped array to `TSchema[]`, which would degrade the static
 * type to `string`; the mapped tuple keeps the precise union.
 */
export const literalUnion = <const T extends readonly string[]>(values: T): TUnion<LiteralSchemas<T>> =>
  Type.Union(values.map((value) => Type.Literal(value)) as TSchema[]) as TUnion<LiteralSchemas<T>>;

/**
 * Union derived from an enum-like `const` object, so adding a member updates the schema
 * automatically instead of requiring a hand-maintained literal list.
 *
 * `Object.values` yields an array rather than a tuple, so the `LiteralSchemas` mapping used by
 * `literalUnion` cannot apply here — annotating the result as `TUnion<TLiteral<...>[]>` makes
 * `Static<>` collapse to `never`. `Type.Unsafe` instead states the static type directly while the
 * wrapped value stays a real runtime union, so validation and the emitted JSON schema are
 * unchanged. The tripwires below prove the declared type still matches the domain union.
 */
export const enumLiteralUnion = <const T extends Record<string, string>>(members: T) =>
  Type.Unsafe<T[keyof T]>(
    Type.Union(Object.values(members).map((value) => Type.Literal(value)) as TSchema[]),
  );

const Exact = { additionalProperties: false } as const;

const AgentIdSchema = Type.String({ pattern: "^[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?$", maxLength: 256 });
const RunIdSchema = Type.String({ pattern: "^[0-9a-f]{8}$" });
const AbsolutePathSchema = Type.String({ pattern: "^(?:/|[A-Za-z]:[\\\\/])", maxLength: 4_096 });
const NonnegativeNumberSchema = Type.Number({ minimum: 0, maximum: Number.MAX_VALUE });

// --- Shared value schemas ---------------------------------------------

export const ThinkingLevelSchema = literalUnion(THINKING_LEVELS);

export const CostSchema = Type.Object({
  input: NonnegativeNumberSchema,
  output: NonnegativeNumberSchema,
  cacheRead: NonnegativeNumberSchema,
  cacheWrite: NonnegativeNumberSchema,
  total: NonnegativeNumberSchema,
});

export const UsageSchema = Type.Object({
  input: NonnegativeNumberSchema,
  output: NonnegativeNumberSchema,
  cacheRead: NonnegativeNumberSchema,
  cacheWrite: NonnegativeNumberSchema,
  cacheWrite1h: Type.Optional(NonnegativeNumberSchema),
  reasoning: Type.Optional(NonnegativeNumberSchema),
  totalTokens: NonnegativeNumberSchema,
  cost: CostSchema,
});

export const AgentUsageSchema = Type.Object({
  turns: Type.Integer({ minimum: 0 }),
  usage: UsageSchema,
});

export const AssistantMessageSchema = Type.Object({
  role: Type.Literal("assistant"),
  content: Type.Array(Type.Record(Type.String(), Type.Unknown())),
  usage: UsageSchema,
  stopReason: Type.String(),
  errorMessage: Type.Optional(Type.String()),
  timestamp: Type.Optional(Type.Number()),
});
export type WireAssistantMessage = Static<typeof AssistantMessageSchema>;

export const AssistantContentEventSchema = Type.Union([
  Type.Object({ type: literalUnion(["text_start", "thinking_start"]), contentIndex: Type.Integer({ minimum: 0 }) }),
  Type.Object({ type: literalUnion(["text_delta", "thinking_delta"]), contentIndex: Type.Integer({ minimum: 0 }), delta: Type.String() }),
  Type.Object({ type: literalUnion(["text_end", "thinking_end"]), contentIndex: Type.Integer({ minimum: 0 }), content: Type.String() }),
]);

export const ToolObservationEventSchema = Type.Union([
  Type.Object({ type: Type.Literal("tool_execution_start"), toolCallId: Type.String({ minLength: 1, maxLength: 256 }), toolName: Type.String({ minLength: 1, maxLength: 256 }) }),
  Type.Object({ type: Type.Literal("tool_execution_update"), toolCallId: Type.String({ minLength: 1, maxLength: 256 }), toolName: Type.String({ minLength: 1, maxLength: 256 }) }),
  Type.Object({ type: Type.Literal("tool_execution_end"), toolCallId: Type.String({ minLength: 1, maxLength: 256 }), toolName: Type.String({ minLength: 1, maxLength: 256 }), isError: Type.Boolean() }),
]);

export const TurnEndObservationSchema = Type.Object({ type: Type.Literal("turn_end") });
export const CompactionObservationSchema = Type.Union([
  Type.Object({ type: Type.Literal("compaction_start"), reason: Type.String() }),
  Type.Object({ type: Type.Literal("compaction_end"), reason: Type.String() }),
]);

export const SessionStatsDataSchema = Type.Object({
  sessionId: Type.String(),
  sessionFile: Type.String(),
  contextUsage: Type.Optional(Type.Object({
    tokens: Type.Union([NonnegativeNumberSchema, Type.Null()]),
    contextWindow: Type.Number({ exclusiveMinimum: 0 }),
    percent: Type.Union([NonnegativeNumberSchema, Type.Null()]),
  })),
});
export type WireSessionStatsData = Static<typeof SessionStatsDataSchema>;

const CorrelationIdSchema = Type.String({ minLength: 1 });
const MillisecondsDtoSchema = Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER });

const SelectUIRequestSchema = Type.Object({
  type: Type.Literal("extension_ui_request"), id: CorrelationIdSchema,
  method: Type.Literal("select"), title: Type.String(),
  options: Type.Array(Type.String()), timeout: Type.Optional(MillisecondsDtoSchema),
});
const ConfirmUIRequestSchema = Type.Object({
  type: Type.Literal("extension_ui_request"), id: CorrelationIdSchema,
  method: Type.Literal("confirm"), title: Type.String(), message: Type.String(),
  timeout: Type.Optional(MillisecondsDtoSchema),
});
const InputUIRequestSchema = Type.Object({
  type: Type.Literal("extension_ui_request"), id: CorrelationIdSchema,
  method: Type.Literal("input"), title: Type.String(),
  placeholder: Type.Optional(Type.String()), timeout: Type.Optional(MillisecondsDtoSchema),
});
const EditorUIRequestSchema = Type.Object({
  type: Type.Literal("extension_ui_request"), id: CorrelationIdSchema,
  method: Type.Literal("editor"), title: Type.String(),
  prefill: Type.Optional(Type.String()),
});
export const ExtensionUIDialogSchema = Type.Union([
  SelectUIRequestSchema, ConfirmUIRequestSchema, InputUIRequestSchema, EditorUIRequestSchema,
]);

const NotifyUIRequestSchema = Type.Object({
  type: Type.Literal("extension_ui_request"), id: CorrelationIdSchema,
  method: Type.Literal("notify"), message: Type.String(),
  notifyType: Type.Optional(literalUnion(["info", "warning", "error"])),
});
const SetStatusUIRequestSchema = Type.Object({
  type: Type.Literal("extension_ui_request"), id: CorrelationIdSchema,
  method: Type.Literal("setStatus"), statusKey: Type.String(),
  statusText: Type.Optional(Type.String()),
});
const SetWidgetUIRequestSchema = Type.Object({
  type: Type.Literal("extension_ui_request"), id: CorrelationIdSchema,
  method: Type.Literal("setWidget"), widgetKey: Type.String(),
  widgetLines: Type.Optional(Type.Array(Type.String())),
  widgetPlacement: Type.Optional(literalUnion(["aboveEditor", "belowEditor"])),
});
const SetTitleUIRequestSchema = Type.Object({
  type: Type.Literal("extension_ui_request"), id: CorrelationIdSchema,
  method: Type.Literal("setTitle"), title: Type.String(),
});
const SetEditorTextUIRequestSchema = Type.Object({
  type: Type.Literal("extension_ui_request"), id: CorrelationIdSchema,
  method: Type.Literal("set_editor_text"), text: Type.String(),
});
export const ExtensionUINotificationSchema = Type.Union([
  NotifyUIRequestSchema, SetStatusUIRequestSchema, SetWidgetUIRequestSchema,
  SetTitleUIRequestSchema, SetEditorTextUIRequestSchema,
]);

type WithUIRequestId<T extends { id: string }> = T extends T
  ? Omit<T, "id" | "timeout"> & { readonly id: UIRequestId } &
      (T extends { timeout?: number } ? { readonly timeout?: Milliseconds } : object)
  : never;

type ExtensionUIDialogDto = Static<typeof ExtensionUIDialogSchema>;
type ExtensionUINotificationDto = Static<typeof ExtensionUINotificationSchema>;

export type WireExtensionUIDialog = WithUIRequestId<ExtensionUIDialogDto>;
export type WireExtensionUINotification = WithUIRequestId<ExtensionUINotificationDto>;

export function brandUIDialog(value: ExtensionUIDialogDto): WireExtensionUIDialog {
  const id = uiRequestId(value.id);
  switch (value.method) {
    case "select": {
      const { timeout, ...dialog } = value;
      return { ...dialog, id, ...(timeout === undefined ? {} : { timeout: milliseconds(timeout) }) };
    }
    case "confirm": {
      const { timeout, ...dialog } = value;
      return { ...dialog, id, ...(timeout === undefined ? {} : { timeout: milliseconds(timeout) }) };
    }
    case "input": {
      const { timeout, ...dialog } = value;
      return { ...dialog, id, ...(timeout === undefined ? {} : { timeout: milliseconds(timeout) }) };
    }
    case "editor": return { ...value, id };
  }
}

export function brandUINotification(
  value: ExtensionUINotificationDto,
): WireExtensionUINotification {
  const id = uiRequestId(value.id);
  switch (value.method) {
    case "notify": return { ...value, id };
    case "setStatus": return { ...value, id };
    case "setWidget": return { ...value, id };
    case "setTitle": return { ...value, id };
    case "set_editor_text": return { ...value, id };
  }
}

// Compile-time tripwire: breaks `bun tsc --noEmit` if `UsageSchema` ever drifts
// from Pi's real `Usage` shape (imported into domain.ts as the source of truth).
type _UsageSchemaMatchesPiUsage = Static<typeof UsageSchema> extends Usage
  ? Usage extends Static<typeof UsageSchema>
    ? true
    : never
  : never;
const _usageSchemaMatchesPiUsage: _UsageSchemaMatchesPiUsage = true;
void _usageSchemaMatchesPiUsage;

export const AgentErrorCodeSchema = enumLiteralUnion(AgentErrorCode);

export const CancellationReasonSchema = enumLiteralUnion(CancellationReason);

// Compile-time tripwires: break `bun tsc --noEmit` if a schema's static type ever stops
// matching its domain union exactly — in either direction. A one-way `extends` would not
// catch the union widening to `string`, which is the regression these guard against.
type _MutuallyAssignable<A, B> = A extends B ? (B extends A ? true : never) : never;

const _agentErrorCodeSchemaMatchesDomain: _MutuallyAssignable<
  Static<typeof AgentErrorCodeSchema>,
  AgentErrorCode
> = true;
void _agentErrorCodeSchemaMatchesDomain;

const _cancellationReasonSchemaMatchesDomain: _MutuallyAssignable<
  Static<typeof CancellationReasonSchema>,
  CancellationReason
> = true;
void _cancellationReasonSchemaMatchesDomain;

const _thinkingLevelSchemaMatchesDomain: _MutuallyAssignable<
  Static<typeof ThinkingLevelSchema>,
  ThinkingLevel
> = true;
void _thinkingLevelSchemaMatchesDomain;

export const AgentErrorSchema = Type.Object({
  code: AgentErrorCodeSchema,
  message: Type.String({ maxLength: MAX_ERROR_MESSAGE_BYTES }),
  diagnosticsPath: Type.Optional(AbsolutePathSchema),
});

export const CompletionOutputSchema = Type.Object({
  text: Type.String({ maxLength: MAX_COMPLETION_OUTPUT_BYTES }),
  originalBytes: Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER }),
  retainedBytes: Type.Integer({ minimum: 0, maximum: MAX_COMPLETION_OUTPUT_BYTES }),
  truncated: Type.Boolean(),
});

const CompletionBaseFields = {
  agentId: AgentIdSchema,
  runId: RunIdSchema,
  output: CompletionOutputSchema,
  outputPath: AbsolutePathSchema,
  transcriptPath: AbsolutePathSchema,
  usage: Type.Optional(AgentUsageSchema),
};

export const CompletedCompletionSchema = Type.Object({
  ...CompletionBaseFields,
  state: Type.Literal(CompletionState.Completed),
}, Exact);

export const FailedCompletionSchema = Type.Object({
  ...CompletionBaseFields,
  state: Type.Literal(CompletionState.Failed),
  error: AgentErrorSchema,
}, Exact);

export const CancelledCompletionSchema = Type.Object({
  ...CompletionBaseFields,
  state: Type.Literal(CompletionState.Cancelled),
  reason: CancellationReasonSchema,
}, Exact);

export const AgentCompletionSchema = Type.Union([
  CompletedCompletionSchema,
  FailedCompletionSchema,
  CancelledCompletionSchema,
]);

// --- Persisted event payload schemas -----------------------------------

export const SpawnedPayloadSchema = Type.Object({
  agentId: Type.String(),
  sessionPath: Type.String(),
  cwd: Type.String(),
  provider: Type.String(),
  modelId: Type.String(),
  thinkingLevel: ThinkingLevelSchema,
  tools: Type.Array(Type.String()),
}, Exact);

export const RunLaunchRequestedPayloadV1Schema = Type.Object({
  agentId: Type.String(),
  previousLeafId: Type.Union([Type.String(), Type.Null()]),
  attemptId: Type.String(),
  containmentReceiptPath: Type.String(),
}, Exact);

export const ContainmentDescriptorSchema = Type.Object({
  backend: Type.Literal("cgroup-v2"),
  scopePath: AbsolutePathSchema,
}, Exact);

export const RunLaunchRequestedPayloadV2Schema = Type.Object({
  agentId: Type.String(),
  previousLeafId: Type.Union([Type.String(), Type.Null()]),
  attemptId: Type.String(),
  containmentReceiptPath: Type.String(),
  containment: ContainmentDescriptorSchema,
}, Exact);

/** Current launch payload schema. */
export const RunLaunchRequestedPayloadSchema = RunLaunchRequestedPayloadV2Schema;

export const RunStartedPayloadSchema = Type.Object({
  agentId: Type.String(),
  runId: Type.String(),
  attemptId: Type.String(),
}, Exact);

export const RunStoppingPayloadSchema = Type.Object({
  agentId: Type.String(),
  runId: Type.String(),
  reason: CancellationReasonSchema,
  containmentReceiptPath: Type.String(),
}, Exact);

export const RunCompletedPayloadSchema = AgentCompletionSchema;

export const PersistedAgentEventV1Schema = Type.Union([
  Type.Object({ schemaVersion: Type.Literal(1), eventType: Type.Literal(AgentEventType.Spawned), payload: SpawnedPayloadSchema }, Exact),
  Type.Object({ schemaVersion: Type.Literal(1), eventType: Type.Literal(AgentEventType.RunLaunchRequested), payload: RunLaunchRequestedPayloadV1Schema }, Exact),
  Type.Object({ schemaVersion: Type.Literal(1), eventType: Type.Literal(AgentEventType.RunStarted), payload: RunStartedPayloadSchema }, Exact),
  Type.Object({ schemaVersion: Type.Literal(1), eventType: Type.Literal(AgentEventType.RunStopping), payload: RunStoppingPayloadSchema }, Exact),
  Type.Object({ schemaVersion: Type.Literal(1), eventType: Type.Literal(AgentEventType.RunCompleted), payload: RunCompletedPayloadSchema }, Exact),
]);

export const PersistedAgentEventV2Schema = Type.Union([
  Type.Object({ schemaVersion: Type.Literal(2), eventType: Type.Literal(AgentEventType.Spawned), payload: SpawnedPayloadSchema }, Exact),
  Type.Object({ schemaVersion: Type.Literal(2), eventType: Type.Literal(AgentEventType.RunLaunchRequested), payload: RunLaunchRequestedPayloadV2Schema }, Exact),
  Type.Object({ schemaVersion: Type.Literal(2), eventType: Type.Literal(AgentEventType.RunStarted), payload: RunStartedPayloadSchema }, Exact),
  Type.Object({ schemaVersion: Type.Literal(2), eventType: Type.Literal(AgentEventType.RunStopping), payload: RunStoppingPayloadSchema }, Exact),
  Type.Object({ schemaVersion: Type.Literal(2), eventType: Type.Literal(AgentEventType.RunCompleted), payload: RunCompletedPayloadSchema }, Exact),
]);

export const PersistedAgentEventSchema = Type.Union([
  PersistedAgentEventV1Schema,
  PersistedAgentEventV2Schema,
]);

export type SpawnedPayloadDto = Static<typeof SpawnedPayloadSchema>;
export type RunLaunchRequestedPayloadV1Dto = Static<typeof RunLaunchRequestedPayloadV1Schema>;
export type RunLaunchRequestedPayloadV2Dto = Static<typeof RunLaunchRequestedPayloadV2Schema>;
export type RunStartedPayloadDto = Static<typeof RunStartedPayloadSchema>;
export type RunStoppingPayloadDto = Static<typeof RunStoppingPayloadSchema>;
export type AgentCompletionDto = Static<typeof AgentCompletionSchema>;
export type PersistedAgentEventDto = Static<typeof PersistedAgentEventSchema>;

/**
 * Decodes an `unknown` custom-entry payload into a `PersistedAgentEventDto`. Throws when the
 * value does not match the versioned envelope schema; callers convert that failure into a
 * bounded diagnostic rather than propagating the raw value.
 */
export function decodePersistedAgentEvent(value: unknown): PersistedAgentEventDto {
  if (!Value.Check(PersistedAgentEventSchema, value)) {
    throw new Error("invalid_input: value does not match the persisted agent event schema");
  }
  return value;
}

// --- Settings schema -----------------------------------------------------

export const SubagentSettingsSchema = Type.Object({
  maxConcurrentRuns: Type.Optional(Type.Integer({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER })),
  maxDepth: Type.Optional(Type.Integer({ minimum: 0, maximum: MAX_MAX_DEPTH })),
  cgroupRoot: Type.Optional(Type.String()),
});

export type SubagentSettingsDto = Static<typeof SubagentSettingsSchema>;

export const SettingsDocumentSchema = Type.Object({
  subagents: Type.Optional(SubagentSettingsSchema),
});

export type SettingsDocumentDto = Static<typeof SettingsDocumentSchema>;

// --- Pi session transcript schemas ---------------------------------------

/**
 * Structural decoding of Pi's own session JSONL. These schemas deliberately narrow external
 * records instead of importing the installed session-manager declarations: a transcript on disk
 * may have been written by another Pi build, so compatibility must be proved from the bytes.
 * Extra properties are tolerated; only the fields this projection reads are validated.
 */
export interface TranscriptSessionHeaderRecord {
  readonly version: 2 | 3;
  readonly sessionId: AgentId;
}

export type TranscriptSessionContentRecord =
  | { readonly kind: "text" | "thinking"; readonly text: string }
  | { readonly kind: "tool-call"; readonly callId: string; readonly tool: string }
  | { readonly kind: "ignored" };

export type TranscriptSessionMessageRecord =
  | { readonly role: "user"; readonly content: readonly TranscriptSessionContentRecord[] }
  | { readonly role: "assistant"; readonly content: readonly TranscriptSessionContentRecord[] }
  | {
      readonly role: "tool-result";
      readonly callId: string;
      readonly tool: string;
      readonly content: readonly TranscriptSessionContentRecord[];
      readonly error: boolean;
    }
  | { readonly role: "non-conversation" };

export type TranscriptSessionEntryRecord =
  | {
      readonly id: SessionEntryId;
      readonly parentId: SessionEntryId | null;
      readonly kind: "message";
      readonly message: TranscriptSessionMessageRecord;
    }
  | {
      readonly id: SessionEntryId;
      readonly parentId: SessionEntryId | null;
      readonly kind: "compaction";
      readonly firstKeptEntryId?: SessionEntryId;
      readonly retainedTailPresent: boolean;
    }
  | { readonly id: SessionEntryId; readonly parentId: SessionEntryId | null; readonly kind: "non-conversation" };

const SessionEntryIdSchema = Type.String({ pattern: "^[0-9a-f]{8}$" });
const NativeCorrelationSchema = Type.String({ minLength: 1, maxLength: 4_096 });
const EntryLineageSchema = {
  id: SessionEntryIdSchema,
  parentId: Type.Union([SessionEntryIdSchema, Type.Null()]),
} as const;

/** Only transcript formats with native entry IDs are available to the conversation view. */
export const TranscriptSessionHeaderSchema = Type.Object({
  type: Type.Literal("session"),
  id: AgentIdSchema,
  version: Type.Union([Type.Literal(2), Type.Literal(3)]),
});

const TextContentSchema = Type.Object({ type: Type.Literal("text"), text: Type.String() });
const ThinkingContentSchema = Type.Object({ type: Type.Literal("thinking"), thinking: Type.String() });
const ToolCallContentSchema = Type.Object({
  type: Type.Literal("toolCall"),
  id: NativeCorrelationSchema,
  name: NativeCorrelationSchema,
});

const TranscriptUserMessageSchema = Type.Object({
  role: Type.Literal("user"),
  content: Type.Union([
    Type.String(),
    Type.Array(Type.Unknown(), { maxItems: MAX_TRANSCRIPT_SOURCE_ITEMS }),
  ]),
});
const TranscriptAssistantMessageSchema = Type.Object({
  role: Type.Literal("assistant"),
  content: Type.Array(Type.Unknown(), { maxItems: MAX_TRANSCRIPT_SOURCE_ITEMS }),
});
const TranscriptToolResultMessageSchema = Type.Object({
  role: Type.Literal("toolResult"),
  toolCallId: NativeCorrelationSchema,
  toolName: NativeCorrelationSchema,
  content: Type.Array(Type.Unknown(), { maxItems: MAX_TRANSCRIPT_SOURCE_ITEMS }),
  isError: Type.Optional(Type.Boolean()),
});
const TranscriptOtherMessageSchema = Type.Object({ role: Type.String() });
const CONVERSATION_ROLES = new Set(["user", "assistant", "toolResult"]);

const TranscriptMessageEntrySchema = Type.Object({
  type: Type.Literal("message"),
  ...EntryLineageSchema,
  message: Type.Unknown(),
});
/** Both compaction forms: one names the first kept entry, the other carries a retained tail. */
const TranscriptCompactionEntrySchema = Type.Object({
  type: Type.Literal("compaction"),
  ...EntryLineageSchema,
  summary: Type.Optional(Type.String()),
  firstKeptEntryId: Type.Optional(SessionEntryIdSchema),
  retainedTail: Type.Optional(Type.Array(Type.Unknown(), { maxItems: MAX_TRANSCRIPT_SOURCE_ITEMS })),
});
const TranscriptOtherEntrySchema = Type.Object({ type: Type.String(), ...EntryLineageSchema });
const KNOWN_ENTRY_TYPES = new Set(["message", "compaction"]);

/** Decodes one complete session header record; an unsupported version is not a header. */
export function decodeTranscriptSessionHeader(value: unknown): TranscriptSessionHeaderRecord | undefined {
  if (!Value.Check(TranscriptSessionHeaderSchema, value)) return undefined;
  return { version: value.version, sessionId: agentId(value.id) };
}

/** Decodes one complete session entry record; a malformed record is rejected as a whole. */
export function decodeTranscriptSessionEntry(value: unknown): TranscriptSessionEntryRecord | undefined {
  if (Value.Check(TranscriptMessageEntrySchema, value)) {
    const message = decodeTranscriptSessionMessage(value.message);
    if (message === undefined) return undefined;
    return { ...lineageOf(value), kind: "message", message };
  }
  if (Value.Check(TranscriptCompactionEntrySchema, value)) {
    const firstKept = value.firstKeptEntryId;
    return {
      ...lineageOf(value),
      kind: "compaction",
      ...(firstKept === undefined ? {} : { firstKeptEntryId: sessionEntryId(firstKept) }),
      retainedTailPresent: value.retainedTail !== undefined,
    };
  }
  if (Value.Check(TranscriptOtherEntrySchema, value)) {
    // A record that names a known kind but failed that kind's schema is malformed, not foreign.
    return KNOWN_ENTRY_TYPES.has(value.type)
      ? undefined
      : { ...lineageOf(value), kind: "non-conversation" };
  }
  return undefined;
}

function lineageOf(entry: { readonly id: string; readonly parentId: string | null }): {
  readonly id: SessionEntryId;
  readonly parentId: SessionEntryId | null;
} {
  return {
    id: sessionEntryId(entry.id),
    parentId: entry.parentId === null ? null : sessionEntryId(entry.parentId),
  };
}

function decodeTranscriptSessionMessage(value: unknown): TranscriptSessionMessageRecord | undefined {
  if (Value.Check(TranscriptUserMessageSchema, value)) {
    const content = typeof value.content === "string"
      ? [{ kind: "text", text: value.content } as const]
      : value.content.map(decodeTranscriptSessionContent);
    return { role: "user", content };
  }
  if (Value.Check(TranscriptAssistantMessageSchema, value)) {
    return { role: "assistant", content: value.content.map(decodeTranscriptSessionContent) };
  }
  if (Value.Check(TranscriptToolResultMessageSchema, value)) {
    return {
      role: "tool-result",
      callId: value.toolCallId,
      tool: value.toolName,
      content: value.content.map(decodeTranscriptSessionContent),
      error: value.isError === true,
    };
  }
  // A conversation role that failed its own schema is malformed, not a foreign record kind.
  if (Value.Check(TranscriptOtherMessageSchema, value) && !CONVERSATION_ROLES.has(value.role)) {
    return { role: "non-conversation" };
  }
  return undefined;
}

function decodeTranscriptSessionContent(value: unknown): TranscriptSessionContentRecord {
  if (Value.Check(TextContentSchema, value)) return { kind: "text", text: value.text };
  if (Value.Check(ThinkingContentSchema, value)) return { kind: "thinking", text: value.thinking };
  if (Value.Check(ToolCallContentSchema, value)) return { kind: "tool-call", callId: value.id, tool: value.name };
  return { kind: "ignored" };
}

const JSON_CONTROL_PATTERN = /[\u0000-\u001f\u007f-\u009f\u00ad\u200b-\u200f\u202a-\u202e\u2066-\u2069]/u;

/**
 * Narrows an external tool argument or details value into bounded, frozen, cycle-free JSON.
 *
 * Admission is total: a value that breaches any limit is rejected whole, because a partially
 * rewritten value could present an invalid shape to a Pi built-in renderer.
 */
export function admitBoundedTranscriptJson(value: unknown): BoundedTranscriptJson | undefined {
  try {
    const budget = { nodes: 0, bytes: 0 };
    const seen = new Set<object>();
    const admitted = admitJsonValue(value, 0, budget, seen);
    if (admitted === undefined) return undefined;
    const serialised = JSON.stringify(admitted.value);
    if (serialised === undefined || new TextEncoder().encode(serialised).byteLength > MAX_TOOL_JSON_BYTES) {
      return undefined;
    }
    return admitted.value as BoundedTranscriptJson;
  } catch {
    return undefined;
  }
}

/**
 * Proves bounded JSON contains no merged sensitive value in any object key or string value.
 * A single occurrence rejects the whole value; nothing is redacted in place.
 */
export function admitSafePresentationJson(
  value: BoundedTranscriptJson,
  sensitive: ReadonlySet<string>,
): SafePresentationJson | undefined {
  if (sensitive.size === 0) return value as ReadonlyJsonValue as SafePresentationJson;
  return containsSensitive(value, sensitive) ? undefined : (value as ReadonlyJsonValue as SafePresentationJson);
}

interface AdmittedJson { readonly value: ReadonlyJsonValue }

function admitJsonValue(
  value: unknown,
  depth: number,
  budget: { nodes: number; bytes: number },
  seen: Set<object>,
): AdmittedJson | undefined {
  if (depth > MAX_TOOL_JSON_DEPTH) return undefined;
  budget.nodes += 1;
  if (budget.nodes > MAX_TOOL_JSON_NODES) return undefined;
  if (value === null || typeof value === "boolean") {
    budget.bytes += 5;
    return budget.bytes > MAX_TOOL_JSON_BYTES ? undefined : { value };
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) return undefined;
    budget.bytes += String(value).length;
    return budget.bytes > MAX_TOOL_JSON_BYTES ? undefined : { value };
  }
  if (typeof value === "string") return admitJsonString(value, budget);
  if (Array.isArray(value)) {
    if (!hasOnlyJsonOwnProperties(value, true)) return undefined;
    if (seen.has(value)) return undefined;
    seen.add(value);
    const items: ReadonlyJsonValue[] = [];
    for (const item of value) {
      const admitted = admitJsonValue(item, depth + 1, budget, seen);
      if (admitted === undefined) return undefined;
      items.push(admitted.value);
    }
    seen.delete(value);
    return { value: Object.freeze(items) };
  }
  if (typeof value === "object") {
    const source = value as Record<string, unknown>;
    if (!hasOnlyJsonOwnProperties(source, false)) return undefined;
    if (seen.has(source)) return undefined;
    seen.add(source);
    const result: Record<string, ReadonlyJsonValue> = {};
    for (const key of Object.keys(source)) {
      const admittedKey = admitJsonString(key, budget);
      if (admittedKey === undefined) return undefined;
      const admitted = admitJsonValue(source[key], depth + 1, budget, seen);
      if (admitted === undefined) return undefined;
      result[key] = admitted.value;
    }
    seen.delete(source);
    return { value: Object.freeze(result) };
  }
  // `undefined`, functions and symbols have no JSON presentation.
  return undefined;
}

function hasOnlyJsonOwnProperties(value: object, array: boolean): boolean {
  if (!array) {
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) return false;
  }
  for (const key of Reflect.ownKeys(value)) {
    if (array && key === "length") continue;
    if (typeof key !== "string") return false;
    if (array && !/^(?:0|[1-9][0-9]*)$/u.test(key)) return false;
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (descriptor === undefined || !("value" in descriptor) || !descriptor.enumerable) return false;
  }
  return true;
}

function admitJsonString(value: string, budget: { nodes: number; bytes: number }): AdmittedJson | undefined {
  if (JSON_CONTROL_PATTERN.test(value)) return undefined;
  const bytes = new TextEncoder().encode(value).byteLength;
  if (bytes > MAX_TOOL_JSON_STRING_BYTES) return undefined;
  budget.bytes += bytes;
  return budget.bytes > MAX_TOOL_JSON_BYTES ? undefined : { value };
}

function containsSensitive(value: ReadonlyJsonValue, sensitive: ReadonlySet<string>): boolean {
  if (typeof value === "string") return [...sensitive].some((item) => item.length > 0 && value.includes(item));
  if (Array.isArray(value)) return value.some((item) => containsSensitive(item, sensitive));
  if (typeof value === "object" && value !== null) {
    const record = value as { readonly [key: string]: ReadonlyJsonValue };
    return Object.keys(record).some(
      (key) =>
        [...sensitive].some((item) => item.length > 0 && key.includes(item))
        || containsSensitive(record[key]!, sensitive),
    );
  }
  return false;
}
