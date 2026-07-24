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
import type { Static, TSchema } from "typebox";
import { Value } from "typebox/value";

import {
  AssistantContentEventSchema,
  AssistantMessageSchema,
  brandUIDialog,
  brandUINotification,
  CompactionObservationSchema,
  ExtensionUIDialogSchema,
  ExtensionUINotificationSchema,
  literalUnion,
  ToolObservationEventSchema,
  TurnEndObservationSchema,
} from "./schemas.ts";
import { rpcContentIndex, rpcRequestId, rpcStopReason, rpcToolCallId, truncateUtf8, utf8Bytes, type RpcRequestId } from "./domain.ts";
import { toolDisplayName, transcriptText, type FinalAssistantBlock } from "./agent-observation.ts";
import type {
  WireAssistantMessage,
  WireExtensionUIDialog,
  WireExtensionUINotification,
} from "./schemas.ts";

// --- Commands this extension issues, and their correlated responses -------

const RECOGNIZED_COMMANDS = [
  "get_state",
  "get_entries",
  "prompt",
  "set_model",
  "set_thinking_level",
  "abort",
  "get_session_stats",
] as const;
export type RecognizedRpcCommand = (typeof RECOGNIZED_COMMANDS)[number];

const MAX_CORRELATION_ID_BYTES = 512;
const CorrelationIdSchema = Type.String({ minLength: 1, maxLength: MAX_CORRELATION_ID_BYTES });

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
  Type.Object({ ...ResponseBase, command: Type.Literal("get_session_stats"), data: Type.Unknown() }),
]);

const FailureResponseSchema = Type.Object({
  id: CorrelationIdSchema,
  type: Type.Literal("response"),
  command: literalUnion(RECOGNIZED_COMMANDS),
  success: Type.Literal(false),
  error: Type.String(),
});

const ResponseSchema = Type.Union([SuccessResponseSchema, FailureResponseSchema]);

// --- Assistant messages and UI requests use schemas owned by schemas.ts ------

const MessageStartEventSchema = Type.Object({
  type: Type.Literal("message_start"),
  message: AssistantMessageSchema,
});

const MessageUpdateEventSchema = Type.Object({
  type: Type.Literal("message_update"),
  message: AssistantMessageSchema,
  assistantMessageEvent: Type.Unknown(),
});

const REQUIRED_MESSAGE_UPDATE_EVENT_KINDS: ReadonlySet<string> = new Set([
  "text_start", "text_delta", "text_end", "thinking_start", "thinking_delta", "thinking_end",
]);

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

// --- Discriminant recognition (before detailed validation) ----------------

const REQUIRED_KINDS: ReadonlySet<string> = new Set([
  "response",
  "message_start",
  "message_update",
  "message_end",
  "agent_settled",
  "agent_start",
  "turn_end",
  "tool_execution_start",
  "tool_execution_update",
  "tool_execution_end",
  "compaction_start",
  "compaction_end",
  "extension_ui_request",
]);
const RecordDiscriminantSchema = Type.Object({ type: Type.String() });

function decode<T extends TSchema>(schema: T, value: unknown): Static<T> | undefined {
  try {
    if (!Value.Check(schema, value)) return undefined;
    return Value.Decode(schema, value);
  } catch {
    return undefined;
  }
}

// --- Public result type -----------------------------------------------------

export type RpcInboundRecord =
  | { kind: "response"; id: RpcRequestId; command: RecognizedRpcCommand; success: true; data?: unknown }
  | { kind: "response"; id: RpcRequestId; command: RecognizedRpcCommand; success: false; error: string }
  | { kind: "assistant-start"; message: WireAssistantMessage }
  | { kind: "assistant-content"; contentIndex: ReturnType<typeof rpcContentIndex>; contentKind: "text" | "thinking"; phase: "start" | "delta" | "end"; text?: ReturnType<typeof transcriptText>; outputText?: string }
  | { kind: "message_update_other" }
  | { kind: "assistant-end"; message: WireAssistantMessage; finalBlocks: readonly FinalAssistantBlock[]; usage: WireAssistantMessage["usage"]; stopReason: ReturnType<typeof rpcStopReason> }
  | { kind: "tool"; toolCallId: ReturnType<typeof rpcToolCallId>; tool: ReturnType<typeof toolDisplayName>; phase: "running" | "completed" | "failed" }
  | { kind: "turn-end" }
  | { kind: "compaction"; phase: "start" | "end" }
  | { kind: "agent-settled" }
  | { kind: "agent_start" }
  | { kind: "extension_ui_dialog"; request: WireExtensionUIDialog }
  | { kind: "extension_ui_notification"; request: WireExtensionUINotification }
  | { kind: "ignored" };

export type RpcWireResult = { ok: true; record: RpcInboundRecord } | { ok: false; reason: string };
export interface InboundResponseCorrelation { readonly type: "response"; readonly id: RpcRequestId }

/**
 * Extracts only the bounded fields needed to identify a pending response before strict decoding.
 * This remains total for untrusted objects, including proxies and throwing accessors.
 */
export function extractInboundResponseCorrelation(value: unknown): InboundResponseCorrelation | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  try {
    const candidate = value as { readonly type?: unknown; readonly id?: unknown };
    const type = candidate.type;
    const id = candidate.id;
    if (type !== "response" || typeof id !== "string" || id.length === 0 || id.length > MAX_CORRELATION_ID_BYTES) return undefined;
    if (new TextEncoder().encode(id).byteLength > MAX_CORRELATION_ID_BYTES) return undefined;
    return Object.freeze({ type: "response", id: rpcRequestId(id) });
  } catch {
    return undefined;
  }
}

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
      const correlation = extractInboundResponseCorrelation(value);
      if (response === undefined || correlation === undefined) {
        return { ok: false, reason: "malformed rpc response record" };
      }
      return response.success
        ? { ok: true, record: { kind: "response", id: correlation.id, command: response.command, success: true, data: response.data } }
        : { ok: true, record: { kind: "response", id: correlation.id, command: response.command, success: false, error: response.error } };
    }
    case "message_start": {
      const role = inboundMessageRole(value);
      if (role !== undefined && role !== "assistant") return { ok: true, record: { kind: "ignored" } };
      const event = decode(MessageStartEventSchema, value);
      if (event === undefined) {
        return { ok: false, reason: "malformed message_start record" };
      }
      return { ok: true, record: { kind: "assistant-start", message: event.message } };
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
      if (REQUIRED_MESSAGE_UPDATE_EVENT_KINDS.has(eventType)) {
        const content = decode(AssistantContentEventSchema, update.assistantMessageEvent);
        if (content === undefined) return { ok: false, reason: `malformed required ${eventType} event` };
        try {
          const contentKind = content.type.startsWith("text_") ? "text" as const : "thinking" as const;
          const phase = content.type.endsWith("_start") ? "start" as const : content.type.endsWith("_delta") ? "delta" as const : "end" as const;
          const rawText = "delta" in content ? content.delta : "content" in content ? content.content : undefined;
          return { ok: true, record: { kind: "assistant-content", contentIndex: rpcContentIndex(content.contentIndex), contentKind, phase,
            ...(rawText === undefined ? {} : { text: boundedObservationText(rawText) }),
            ...(content.type === "text_delta" ? { outputText: content.delta } : {}) } };
        } catch { return { ok: false, reason: `malformed required ${eventType} event` }; }
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
      try {
        const finalBlocks: FinalAssistantBlock[] = [];
        for (let index = 0; index < event.message.content.length; index++) {
          const block = event.message.content[index]!;
          if (block.type === "text") {
            if (typeof block.text !== "string") throw new Error("invalid text block");
            finalBlocks.push({ contentIndex: rpcContentIndex(index), kind: "text", text: boundedObservationText(block.text) });
          } else if (block.type === "thinking") {
            if (typeof block.thinking !== "string") throw new Error("invalid thinking block");
            finalBlocks.push({ contentIndex: rpcContentIndex(index), kind: "thinking", text: boundedObservationText(block.thinking) });
          }
        }
        return { ok: true, record: { kind: "assistant-end", message: event.message, finalBlocks: Object.freeze(finalBlocks), usage: event.message.usage, stopReason: rpcStopReason(event.message.stopReason) } };
      } catch { return { ok: false, reason: "malformed message_end observation fields" }; }
    }
    case "agent_settled": {
      if (decode(AgentSettledEventSchema, value) === undefined) {
        return { ok: false, reason: "malformed agent_settled record" };
      }
      return { ok: true, record: { kind: "agent-settled" } };
    }
    case "turn_end": {
      if (decode(TurnEndObservationSchema, value) === undefined) return { ok: false, reason: "malformed turn_end record" };
      return { ok: true, record: { kind: "turn-end" } };
    }
    case "tool_execution_start":
    case "tool_execution_update":
    case "tool_execution_end": {
      const event = decode(ToolObservationEventSchema, value);
      if (event === undefined) return { ok: false, reason: `malformed ${type} record` };
      try { return { ok: true, record: { kind: "tool", toolCallId: rpcToolCallId(event.toolCallId), tool: toolDisplayName(event.toolName),
        phase: event.type === "tool_execution_end" ? (event.isError ? "failed" : "completed") : "running" } }; }
      catch { return { ok: false, reason: `malformed ${type} observation fields` }; }
    }
    case "compaction_start":
    case "compaction_end": {
      if (decode(CompactionObservationSchema, value) === undefined) return { ok: false, reason: `malformed ${type} record` };
      return { ok: true, record: { kind: "compaction", phase: type === "compaction_start" ? "start" : "end" } };
    }
    case "agent_start": {
      if (decode(AgentStartEventSchema, value) === undefined) {
        return { ok: false, reason: "malformed agent_start event" };
      }
      return { ok: true, record: { kind: "agent_start" } };
    }
    case "extension_ui_request": {
      const dialog = decode(ExtensionUIDialogSchema, value);
      if (dialog !== undefined) return { ok: true, record: { kind: "extension_ui_dialog", request: brandUIDialog(dialog) } };
      const notification = decode(ExtensionUINotificationSchema, value);
      if (notification !== undefined) return { ok: true, record: { kind: "extension_ui_notification", request: brandUINotification(notification) } };
      return { ok: false, reason: "malformed extension_ui_request record" };
    }
    default:
      return { ok: true, record: { kind: "ignored" } };
  }
}

export function boundedObservationText(value: string): ReturnType<typeof transcriptText> {
  const safe = value.replace(/[\u0000-\u001f\u007f-\u009f\u061c\u200e-\u200f\u202a-\u202e\u2066-\u2069]/gu, " ");
  return transcriptText(truncateUtf8(safe, utf8Bytes(8_192)).text);
}

function inboundMessageRole(value: object): string | undefined {
  if (!("message" in value)) return undefined;
  const message = value.message;
  if (typeof message !== "object" || message === null || Array.isArray(message) || !("role" in message)) return undefined;
  return typeof message.role === "string" ? message.role : undefined;
}
