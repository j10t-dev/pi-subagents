/**
 * Minimal validated subset of Pi's RPC wire protocol.
 *
 * Only responses for commands this extension issues, lifecycle/message events needed for
 * output and usage recovery, `agent_settled`, and the extension UI requests this extension can
 * forward are validated in detail. Anything else with a recognized `type` string is treated as
 * an ignored ordinary event. A value that matches one of the categories above but fails detailed
 * validation is a `protocol_error` — it is never partially trusted.
 *
 * Types are imported from the package root only; internal package paths would bind
 * this module to Pi's internal implementation layout instead of its published surface.
 */
import { Type } from "typebox";
import type { Static, TLiteral, TSchema, TUnion } from "typebox";
import { Value } from "typebox/value";

import { UsageSchema } from "./schemas.ts";

type LiteralSchemas<T extends readonly string[]> = {
  -readonly [K in keyof T]: TLiteral<T[K]>;
};

const literalUnion = <const T extends readonly string[]>(values: T): TUnion<LiteralSchemas<T>> =>
  Type.Union(values.map((value) => Type.Literal(value)) as TSchema[]) as TUnion<LiteralSchemas<T>>;

// --- Commands this extension issues, and their correlated responses -------

const RECOGNIZED_COMMANDS = [
  "get_state",
  "get_entries",
  "prompt",
  "set_model",
  "set_thinking_level",
  "abort",
] as const;
export type RecognizedRpcCommand = (typeof RECOGNIZED_COMMANDS)[number];

const CorrelationIdSchema = Type.String({ minLength: 1 });

const ResponseBase = {
  id: CorrelationIdSchema,
  type: Type.Literal("response"),
  success: Type.Literal(true),
} as const;

const GetEntriesDataSchema = Type.Object({
  entries: Type.Array(Type.Unknown()),
  leafId: Type.Union([Type.String(), Type.Null()]),
});
const SuccessResponseSchema = Type.Union([
  Type.Object({ ...ResponseBase, command: Type.Literal("get_entries"), data: GetEntriesDataSchema }),
  Type.Object({ ...ResponseBase, command: Type.Literal("get_state"), data: Type.Unknown() }),
  Type.Object({ ...ResponseBase, command: Type.Literal("prompt"), data: Type.Optional(Type.Unknown()) }),
  Type.Object({ ...ResponseBase, command: Type.Literal("set_model"), data: Type.Optional(Type.Unknown()) }),
  Type.Object({ ...ResponseBase, command: Type.Literal("set_thinking_level"), data: Type.Optional(Type.Unknown()) }),
  Type.Object({ ...ResponseBase, command: Type.Literal("abort"), data: Type.Optional(Type.Unknown()) }),
]);

const FailureResponseSchema = Type.Object({
  id: CorrelationIdSchema,
  type: Type.Literal("response"),
  command: literalUnion(RECOGNIZED_COMMANDS),
  success: Type.Literal(false),
  error: Type.String(),
});

const ResponseSchema = Type.Union([SuccessResponseSchema, FailureResponseSchema]);

// --- Assistant message shape (only the fields output/usage recovery need) -

const TextContentSchema = Type.Object({
  type: Type.Literal("text"),
  text: Type.String(),
});

const AssistantMessageSchema = Type.Object({
  role: Type.Literal("assistant"),
  content: Type.Array(Type.Record(Type.String(), Type.Unknown())),
  usage: UsageSchema,
  stopReason: Type.String(),
  errorMessage: Type.Optional(Type.String()),
  timestamp: Type.Optional(Type.Number()),
});
export type WireAssistantMessage = Static<typeof AssistantMessageSchema>;

const MessageStartEventSchema = Type.Object({
  type: Type.Literal("message_start"),
  message: AssistantMessageSchema,
});

const TextDeltaSchema = Type.Object({
  type: Type.Literal("text_delta"),
  contentIndex: Type.Integer({ minimum: 0 }),
  delta: Type.String(),
});

const MessageUpdateEventSchema = Type.Object({
  type: Type.Literal("message_update"),
  message: AssistantMessageSchema,
  assistantMessageEvent: Type.Unknown(),
});

const REQUIRED_MESSAGE_UPDATE_EVENT_KINDS: ReadonlySet<string> = new Set(["text_delta"]);

const MessageEndEventSchema = Type.Object({
  type: Type.Literal("message_end"),
  message: AssistantMessageSchema,
});

const AgentSettledEventSchema = Type.Object({
  type: Type.Literal("agent_settled"),
});

const AgentStartEventSchema = Type.Object(
  { type: Type.Literal("agent_start") },
  { additionalProperties: false },
);

// --- Extension UI requests this extension can forward or must cancel ------

const SelectUIRequestSchema = Type.Object({
  type: Type.Literal("extension_ui_request"),
  id: CorrelationIdSchema,
  method: Type.Literal("select"),
  title: Type.String(),
  options: Type.Array(Type.String()),
  timeout: Type.Optional(Type.Number()),
});

const ConfirmUIRequestSchema = Type.Object({
  type: Type.Literal("extension_ui_request"),
  id: CorrelationIdSchema,
  method: Type.Literal("confirm"),
  title: Type.String(),
  message: Type.String(),
  timeout: Type.Optional(Type.Number()),
});

const InputUIRequestSchema = Type.Object({
  type: Type.Literal("extension_ui_request"),
  id: CorrelationIdSchema,
  method: Type.Literal("input"),
  title: Type.String(),
  placeholder: Type.Optional(Type.String()),
  timeout: Type.Optional(Type.Number()),
});

// Pi exposes editor on the public `ExtensionContext.ui`; no internal import is needed.
const EditorUIRequestSchema = Type.Object({
  type: Type.Literal("extension_ui_request"),
  id: CorrelationIdSchema,
  method: Type.Literal("editor"),
  title: Type.String(),
  prefill: Type.Optional(Type.String()),
});

const ExtensionUIDialogSchema = Type.Union([
  SelectUIRequestSchema,
  ConfirmUIRequestSchema,
  InputUIRequestSchema,
  EditorUIRequestSchema,
]);
export type WireExtensionUIDialog = Static<typeof ExtensionUIDialogSchema>;

const NotifyUIRequestSchema = Type.Object({
  type: Type.Literal("extension_ui_request"),
  id: CorrelationIdSchema,
  method: Type.Literal("notify"),
  message: Type.String(),
  notifyType: Type.Optional(literalUnion(["info", "warning", "error"] as const)),
});
const SetStatusUIRequestSchema = Type.Object({
  type: Type.Literal("extension_ui_request"),
  id: CorrelationIdSchema,
  method: Type.Literal("setStatus"),
  statusKey: Type.String(),
  statusText: Type.Optional(Type.String()),
});
const SetWidgetUIRequestSchema = Type.Object({
  type: Type.Literal("extension_ui_request"),
  id: CorrelationIdSchema,
  method: Type.Literal("setWidget"),
  widgetKey: Type.String(),
  widgetLines: Type.Optional(Type.Array(Type.String())),
  widgetPlacement: Type.Optional(literalUnion(["aboveEditor", "belowEditor"] as const)),
});
const SetTitleUIRequestSchema = Type.Object({
  type: Type.Literal("extension_ui_request"),
  id: CorrelationIdSchema,
  method: Type.Literal("setTitle"),
  title: Type.String(),
});
const SetEditorTextUIRequestSchema = Type.Object({
  type: Type.Literal("extension_ui_request"),
  id: CorrelationIdSchema,
  method: Type.Literal("set_editor_text"),
  text: Type.String(),
});
const ExtensionUINotificationSchema = Type.Union([
  NotifyUIRequestSchema,
  SetStatusUIRequestSchema,
  SetWidgetUIRequestSchema,
  SetTitleUIRequestSchema,
  SetEditorTextUIRequestSchema,
]);
export type WireExtensionUINotification = Static<typeof ExtensionUINotificationSchema>;

// --- Discriminant recognition (before detailed validation) ----------------

const REQUIRED_KINDS: ReadonlySet<string> = new Set([
  "response",
  "message_start",
  "message_update",
  "message_end",
  "agent_settled",
  "agent_start",
  "extension_ui_request",
]);
const RecordDiscriminantSchema = Type.Object({ type: Type.String() });

function decode<T extends TSchema>(schema: T, value: unknown): Static<T> | undefined {
  if (!Value.Check(schema, value)) {
    return undefined;
  }
  try {
    return Value.Decode(schema, value);
  } catch {
    return undefined;
  }
}

// --- Public result type -----------------------------------------------------

export type RpcInboundRecord =
  | { kind: "response"; id: string; command: RecognizedRpcCommand; success: true; data?: unknown }
  | { kind: "response"; id: string; command: RecognizedRpcCommand; success: false; error: string }
  | { kind: "message_start"; message: WireAssistantMessage }
  | { kind: "text_delta"; contentIndex: number; delta: string }
  | { kind: "message_update_other" }
  | { kind: "message_end"; message: WireAssistantMessage }
  | { kind: "agent_settled" }
  | { kind: "agent_start" }
  | { kind: "extension_ui_dialog"; request: WireExtensionUIDialog }
  | { kind: "extension_ui_notification"; request: WireExtensionUINotification }
  | { kind: "ignored" };

export type RpcWireResult = { ok: true; record: RpcInboundRecord } | { ok: false; reason: string };

/**
 * Classifies and validates one decoded JSON record from the RPC wire. Never trusts a record
 * that matches a required discriminant but fails detailed schema validation: that case is
 * reported as `ok: false` (a transport `protocol_error`), not silently downgraded to `ignored`.
 */
export function classifyInboundRecord(value: unknown): RpcWireResult {
  const discriminant = decode(RecordDiscriminantSchema, value);
  if (discriminant === undefined) {
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      return { ok: false, reason: "rpc record is not a JSON object" };
    }
    return { ok: false, reason: "rpc record has no string type field" };
  }
  const { type } = discriminant;
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return { ok: false, reason: "rpc record is not a JSON object" };
  }

  if (!REQUIRED_KINDS.has(type)) {
    return { ok: true, record: { kind: "ignored" } };
  }

  switch (type) {
    case "response": {
      const response = decode(ResponseSchema, value);
      if (response === undefined) {
        return { ok: false, reason: "malformed rpc response record" };
      }
      return response.success
        ? { ok: true, record: { kind: "response", id: response.id, command: response.command, success: true, data: response.data } }
        : { ok: true, record: { kind: "response", id: response.id, command: response.command, success: false, error: response.error } };
    }
    case "message_start": {
      const role = inboundMessageRole(value);
      if (role !== undefined && role !== "assistant") return { ok: true, record: { kind: "ignored" } };
      const event = decode(MessageStartEventSchema, value);
      if (event === undefined) {
        return { ok: false, reason: "malformed message_start record" };
      }
      return { ok: true, record: { kind: "message_start", message: event.message } };
    }
    case "message_update": {
      const update = decode(MessageUpdateEventSchema, value);
      if (update === undefined) {
        return { ok: false, reason: "malformed message_update record" };
      }
      const eventDiscriminant = decode(RecordDiscriminantSchema, update.assistantMessageEvent);
      if (eventDiscriminant === undefined) {
        return { ok: false, reason: "malformed message_update assistant event" };
      }
      const eventType = eventDiscriminant.type;
      if (eventType === "text_delta") {
        const textDelta = decode(TextDeltaSchema, update.assistantMessageEvent);
        if (textDelta === undefined) {
          return { ok: false, reason: "malformed required text_delta event" };
        }
        return { ok: true, record: { kind: "text_delta", contentIndex: textDelta.contentIndex, delta: textDelta.delta } };
      }
      if (REQUIRED_MESSAGE_UPDATE_EVENT_KINDS.has(eventType)) {
        return { ok: false, reason: `malformed required ${eventType} event` };
      }
      return { ok: true, record: { kind: "message_update_other" } };
    }
    case "message_end": {
      const role = inboundMessageRole(value);
      if (role !== undefined && role !== "assistant") return { ok: true, record: { kind: "ignored" } };
      const event = decode(MessageEndEventSchema, value);
      if (event === undefined) {
        return { ok: false, reason: "malformed message_end record" };
      }
      return { ok: true, record: { kind: "message_end", message: event.message } };
    }
    case "agent_settled": {
      if (decode(AgentSettledEventSchema, value) === undefined) {
        return { ok: false, reason: "malformed agent_settled record" };
      }
      return { ok: true, record: { kind: "agent_settled" } };
    }
    case "agent_start": {
      if (decode(AgentStartEventSchema, value) === undefined) {
        return { ok: false, reason: "malformed agent_start event" };
      }
      return { ok: true, record: { kind: "agent_start" } };
    }
    case "extension_ui_request": {
      const dialog = decode(ExtensionUIDialogSchema, value);
      if (dialog !== undefined) return { ok: true, record: { kind: "extension_ui_dialog", request: dialog } };
      const notification = decode(ExtensionUINotificationSchema, value);
      if (notification !== undefined) return { ok: true, record: { kind: "extension_ui_notification", request: notification } };
      return { ok: false, reason: "malformed extension_ui_request record" };
    }
    default:
      return { ok: true, record: { kind: "ignored" } };
  }
}

function inboundMessageRole(value: object): string | undefined {
  if (!("message" in value)) return undefined;
  const message = value.message;
  if (typeof message !== "object" || message === null || Array.isArray(message) || !("role" in message)) return undefined;
  return typeof message.role === "string" ? message.role : undefined;
}
