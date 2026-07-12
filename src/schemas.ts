import { Type } from "typebox";
import type { Static } from "typebox";
import { Value } from "typebox/value";

import {
  AgentErrorCode,
  AgentEventType,
  CancellationReason,
  CompletionState,
} from "./domain.ts";
import type { Usage } from "./domain.ts";
import { MAX_COMPLETION_OUTPUT_BYTES, MAX_ERROR_MESSAGE_BYTES } from "./constants.ts";

const literalUnion = <const T extends readonly string[]>(values: T) =>
  Type.Union(values.map((value) => Type.Literal(value)));
const Exact = { additionalProperties: false } as const;

const AgentIdSchema = Type.String({ pattern: "^[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?$", maxLength: 256 });
const RunIdSchema = Type.String({ pattern: "^[0-9a-f]{8}$" });
const AbsolutePathSchema = Type.String({ pattern: "^(?:/|[A-Za-z]:[\\\\/])", maxLength: 4_096 });
const NonnegativeNumberSchema = Type.Number({ minimum: 0, maximum: Number.MAX_VALUE });

// --- Shared value schemas ---------------------------------------------

export const ThinkingLevelSchema = literalUnion([
  "off",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
] as const);

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

// Compile-time tripwire: breaks `bun tsc --noEmit` if `UsageSchema` ever drifts
// from Pi's real `Usage` shape (imported into domain.ts as the source of truth).
type _UsageSchemaMatchesPiUsage = Static<typeof UsageSchema> extends Usage
  ? Usage extends Static<typeof UsageSchema>
    ? true
    : never
  : never;
const _usageSchemaMatchesPiUsage: _UsageSchemaMatchesPiUsage = true;
void _usageSchemaMatchesPiUsage;

export const AgentErrorCodeSchema = literalUnion(Object.values(AgentErrorCode));

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
  reason: literalUnion(Object.values(CancellationReason)),
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
  reason: literalUnion(Object.values(CancellationReason)),
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
