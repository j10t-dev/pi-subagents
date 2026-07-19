import { Type } from "typebox";
import type { Static, TLiteral, TSchema, TUnion } from "typebox";
import { Value } from "typebox/value";

import {
  AgentErrorCode,
  AgentEventType,
  CancellationReason,
  CompletionState,
  THINKING_LEVELS,
} from "./domain.ts";
import type { ThinkingLevel, Usage } from "./domain.ts";
import { MAX_COMPLETION_OUTPUT_BYTES, MAX_ERROR_MESSAGE_BYTES } from "./constants.ts";

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

const CorrelationIdSchema = Type.String({ minLength: 1 });

const SelectUIRequestSchema = Type.Object({
  type: Type.Literal("extension_ui_request"), id: CorrelationIdSchema,
  method: Type.Literal("select"), title: Type.String(),
  options: Type.Array(Type.String()), timeout: Type.Optional(Type.Number()),
});
const ConfirmUIRequestSchema = Type.Object({
  type: Type.Literal("extension_ui_request"), id: CorrelationIdSchema,
  method: Type.Literal("confirm"), title: Type.String(), message: Type.String(),
  timeout: Type.Optional(Type.Number()),
});
const InputUIRequestSchema = Type.Object({
  type: Type.Literal("extension_ui_request"), id: CorrelationIdSchema,
  method: Type.Literal("input"), title: Type.String(),
  placeholder: Type.Optional(Type.String()), timeout: Type.Optional(Type.Number()),
});
const EditorUIRequestSchema = Type.Object({
  type: Type.Literal("extension_ui_request"), id: CorrelationIdSchema,
  method: Type.Literal("editor"), title: Type.String(),
  prefill: Type.Optional(Type.String()),
});
export const ExtensionUIDialogSchema = Type.Union([
  SelectUIRequestSchema, ConfirmUIRequestSchema, InputUIRequestSchema, EditorUIRequestSchema,
]);
export type WireExtensionUIDialog = Static<typeof ExtensionUIDialogSchema>;

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
export type WireExtensionUINotification = Static<typeof ExtensionUINotificationSchema>;

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
  maxConcurrentRuns: Type.Optional(Type.Integer({ minimum: 1 })),
  cgroupRoot: Type.Optional(Type.String()),
});

export type SubagentSettingsDto = Static<typeof SubagentSettingsSchema>;

export const SettingsDocumentSchema = Type.Object({
  subagents: Type.Optional(SubagentSettingsSchema),
});

export type SettingsDocumentDto = Static<typeof SettingsDocumentSchema>;
