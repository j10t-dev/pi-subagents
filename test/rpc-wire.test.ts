import { describe, expect, test } from "bun:test";
import type { AgentSessionEvent } from "@earendil-works/pi-coding-agent";
import type { RpcRequestId, UIRequestId, Usage } from "../src/domain.ts";
import type {
  RpcExtensionUIRequest,
  RpcExtensionUIResponse,
  RpcResponse,
} from "@earendil-works/pi-coding-agent";

import { assistantMessage as buildAssistantMessage } from "./support/messages.ts";
import { testUIRequestId } from "./support/brands.ts";
import { classifyInboundRecord, extractInboundResponseCorrelation } from "../src/rpc-wire.ts";
import type { WireExtensionUINotification } from "../src/schemas.ts";

const validUsage: Usage = {
  input: 1, output: 1, cacheRead: 0, cacheWrite: 0, cacheWrite1h: 1, reasoning: 1,
  totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};
const invalidUsageCases = [
  ["negative token", (usage: Usage) => ({ ...usage, input: -1 })],
  ["NaN token", (usage: Usage) => ({ ...usage, output: Number.NaN })],
  ["infinite token", (usage: Usage) => ({ ...usage, cacheRead: Number.POSITIVE_INFINITY })],
  ["negative optional", (usage: Usage) => ({ ...usage, reasoning: -1 })],
  ["missing totalTokens", (usage: Usage) => { const { totalTokens: _removed, ...rest } = usage; return rest; }],
  ["missing cost field", (usage: Usage) => { const { cacheWrite: _removed, ...cost } = usage.cost; return { ...usage, cost }; }],
] as const;

function assistantMessage(text = "hello", overrides: Record<string, unknown> = {}) {
  return {
    ...buildAssistantMessage(text, { usage: validUsage }),
    api: "messages",
    provider: "anthropic",
    model: "claude",
    timestamp: Date.now(),
    ...overrides,
  };
}

function requireRpcId(value: RpcRequestId): string { return value; }
function requireUIId(value: UIRequestId): string { return value; }

describe("classifyInboundRecord", () => {
  test.each(invalidUsageCases)("rejects shared invalid usage: %s", (_label, mutate) => {
    expect(classifyInboundRecord({ type: "message_end", message: assistantMessage("hello", { usage: mutate(validUsage) }) }).ok).toBe(false);
  });

  test("accepts the shared valid usage fixture", () => {
    expect(classifyInboundRecord({ type: "message_end", message: assistantMessage("hello", { usage: validUsage }) }).ok).toBe(true);
  });

  test("classifies a correlated get_entries response", () => {
    const result = classifyInboundRecord({
      id: "req-1",
      type: "response",
      command: "get_entries",
      success: true,
      data: { entries: [], leafId: null },
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.record.kind).toBe("response");
    }
  });

  test("brands validated response correlation IDs", () => {
    const result = classifyInboundRecord({
      id: "req-1", type: "response", command: "get_entries", success: true,
      data: { entries: [], leafId: null },
    });
    expect(result.ok).toBeTrue();
    if (result.ok && result.record.kind === "response") {
      expect(requireRpcId(result.record.id)).toBe("req-1");
    }
  });

  test("extracts only bounded response correlation before strict classification", () => {
    const correlation = extractInboundResponseCorrelation({ type: "response", id: "stats-1", command: "future_command" });
    expect(correlation?.type).toBe("response");
    expect(String(correlation?.id)).toBe("stats-1");
    expect(extractInboundResponseCorrelation({ type: "response", id: "x".repeat(513) })).toBeUndefined();
  });

  test("contains hostile response correlation getters", () => {
    const hostileType = { get type(): never { throw new Error("hostile type"); }, id: "stats-1" };
    const hostileId = { type: "response", get id(): never { throw new Error("hostile id"); } };
    expect(() => extractInboundResponseCorrelation(hostileType)).not.toThrow();
    expect(() => extractInboundResponseCorrelation(hostileId)).not.toThrow();
    expect(() => classifyInboundRecord(hostileType)).not.toThrow();
    expect(() => classifyInboundRecord(hostileId)).not.toThrow();
    expect(extractInboundResponseCorrelation(hostileType)).toBeUndefined();
    expect(extractInboundResponseCorrelation(hostileId)).toBeUndefined();
    expect(classifyInboundRecord(hostileType)).toMatchObject({ ok: false });
    expect(classifyInboundRecord(hostileId)).toMatchObject({ ok: false });
  });

  test("brands validated extension UI correlation IDs", () => {
    const result = classifyInboundRecord({
      type: "extension_ui_request", id: "ui-1", method: "confirm",
      title: "Confirm", message: "Proceed?",
    });
    expect(result.ok).toBeTrue();
    if (result.ok && result.record.kind === "extension_ui_dialog") {
      expect(requireUIId(result.record.request.id)).toBe("ui-1");
    }
  });

  test("classifies a failed response", () => {
    const result = classifyInboundRecord({
      id: "req-2",
      type: "response",
      command: "prompt",
      success: false,
      error: "boom",
    });
    expect(result.ok).toBe(true);
    if (result.ok && result.record.kind === "response") {
      expect(result.record.success).toBe(false);
    }
  });

  test("rejects responses without a non-empty correlation ID", () => {
    for (const response of [
      { type: "response", command: "prompt", success: true },
      { id: "", type: "response", command: "prompt", success: true },
      { type: "response", command: "prompt", success: false, error: "boom" },
      { id: "", type: "response", command: "prompt", success: false, error: "boom" },
    ]) {
      expect(classifyInboundRecord(response).ok).toBe(false);
    }
  });

  test("rejects failures for unknown commands", () => {
    expect(classifyInboundRecord({
      id: "req-unknown",
      type: "response",
      command: "future_command",
      success: false,
      error: "boom",
    }).ok).toBe(false);
  });

  test.each(["message_start", "message_update", "message_end"] as const)("rejects invalid usage on %s", (type) => {
    const invalidUsages = [
      { ...assistantMessage().usage, input: -1 },
      { ...assistantMessage().usage, output: Number.NaN },
      { ...assistantMessage().usage, cacheRead: Number.POSITIVE_INFINITY },
      (() => { const { totalTokens: _totalTokens, ...usage } = assistantMessage().usage; return usage; })(),
      { ...assistantMessage().usage, cost: { input: 0 } },
    ];
    for (const usage of invalidUsages) {
      const event = type === "message_update"
        ? { type, message: assistantMessage("hello", { usage }), assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "hi" } }
        : { type, message: assistantMessage("hello", { usage }) };
      expect(classifyInboundRecord(event).ok).toBe(false);
    }
  });

  test.each(["message_start", "message_update", "message_end"] as const)("accepts optional usage fields on %s", (type) => {
    const message = assistantMessage("hello", { usage: {
      ...assistantMessage().usage,
      cacheWrite1h: 12,
      reasoning: 8,
    } });
    const event = type === "message_update"
      ? { type, message, assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "hi" } }
      : { type, message };
    expect(classifyInboundRecord(event).ok).toBe(true);
  });

  test("classifies message_start", () => {
    const result = classifyInboundRecord({ type: "message_start", message: assistantMessage() });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.record.kind).toBe("assistant-start");
  });

  test("ignores Pi user message boundaries while retaining strict assistant validation", () => {
    for (const type of ["message_start", "message_end"] as const) {
      const result = classifyInboundRecord({ type, message: { role: "user", content: [{ type: "text", text: "assignment" }], timestamp: Date.now() } });
      expect(result).toEqual({ ok: true, record: { kind: "ignored" } });
    }
  });

  test("bounds a large observation delta without truncating authoritative output text", () => {
    const delta = "x".repeat(9_000);
    const result = classifyInboundRecord({ type: "message_update", message: assistantMessage(), assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta } });
    expect(result.ok).toBeTrue();
    if (result.ok && result.record.kind === "assistant-content" && result.record.phase === "delta") {
      expect(new TextEncoder().encode(result.record.delta).byteLength).toBeLessThanOrEqual(8_192);
      expect(result.record.outputText).toBe(delta);
    }
  });

  test("classifies a text_delta inside message_update", () => {
    const result = classifyInboundRecord({
      type: "message_update",
      message: assistantMessage(),
      assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "hi", partial: assistantMessage() },
    });
    expect(result.ok).toBe(true);
    if (result.ok && result.record.kind === "assistant-content" && result.record.phase === "delta") {
      expect(String(result.record.delta)).toBe("hi");
      expect(Number(result.record.contentIndex)).toBe(0);
    } else {
      throw new Error("expected assistant-content");
    }
  });

  test("classifies a thinking_delta as assistant content", () => {
    const result = classifyInboundRecord({
      type: "message_update",
      message: assistantMessage(),
      assistantMessageEvent: { type: "thinking_delta", contentIndex: 0, delta: "hmm", partial: assistantMessage() },
    });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.record.kind).toBe("assistant-content");
  });

  test("validates text_end carrying its final content", () => {
    const poisonedTextEnd = classifyInboundRecord({
      type: "message_update",
      message: assistantMessage("trusted delta"),
      assistantMessageEvent: {
        type: "text_end",
        contentIndex: 0,
        content: "POISONED_TEXT_END_CONTENT",
        partial: { type: "text", text: "POISONED_PARTIAL" },
      },
    });
    expect(poisonedTextEnd).toMatchObject({ ok: true, record: { kind: "assistant-content", phase: "end", text: "POISONED_TEXT_END_CONTENT" } });
    if (poisonedTextEnd.ok && poisonedTextEnd.record.kind === "assistant-content" && poisonedTextEnd.record.phase === "end") {
      expect("delta" in poisonedTextEnd.record).toBeFalse();
    }
  });

  test("rejects malformed required text_delta events instead of treating them as other updates", () => {
    for (const assistantMessageEvent of [
      { type: "text_delta", contentIndex: 0 },
      { type: "text_delta", contentIndex: -1, delta: "hi" },
      { type: "text_delta", contentIndex: 0, delta: 42 },
    ]) {
      const result = classifyInboundRecord({
        type: "message_update",
        message: assistantMessage(),
        assistantMessageEvent,
      });
      expect(result.ok).toBe(false);
    }
  });

  test("classifies message_end", () => {
    const result = classifyInboundRecord({ type: "message_end", message: assistantMessage() });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.record.kind).toBe("assistant-end");
  });

  test("classifies agent_settled", () => {
    const result = classifyInboundRecord({ type: "agent_settled" });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.record.kind).toBe("agent-settled");
  });

  test("classifies the initial agent_start barrier", () => {
    expect(classifyInboundRecord({ type: "agent_start" }))
      .toEqual({ ok: true, record: { kind: "agent_start" } });
  });

  test("rejects malformed agent_start records", () => {
    expect(classifyInboundRecord({ type: "agent_start", unexpected: true }))
      .toEqual({ ok: false, reason: expect.stringContaining("malformed agent_start") });
  });

  test("classifies extension_ui dialogs and notifications with distinct response semantics", () => {
    const dialogs = [
      { type: "extension_ui_request", id: "1", method: "select", title: "t", options: ["a"], timeout: 10 },
      { type: "extension_ui_request", id: "2", method: "confirm", title: "t", message: "m", timeout: 10 },
      { type: "extension_ui_request", id: "3", method: "input", title: "t", placeholder: "p", timeout: 10 },
      { type: "extension_ui_request", id: "4", method: "editor", title: "t", prefill: "body" },
    ] as const;
    const notifications = [
      { type: "extension_ui_request", id: "5", method: "notify", message: "done", notifyType: "warning" },
      { type: "extension_ui_request", id: "6", method: "notify", message: "default severity" },
      { type: "extension_ui_request", id: "7", method: "setStatus", statusKey: "build", statusText: "running" },
      { type: "extension_ui_request", id: "8", method: "setStatus", statusKey: "build" },
      { type: "extension_ui_request", id: "9", method: "setWidget", widgetKey: "jobs", widgetLines: ["one"], widgetPlacement: "belowEditor" },
      { type: "extension_ui_request", id: "10", method: "setWidget", widgetKey: "jobs" },
      { type: "extension_ui_request", id: "11", method: "setTitle", title: "child title" },
      { type: "extension_ui_request", id: "12", method: "set_editor_text", text: "child draft" },
    ] as const;
    for (const request of dialogs) {
      const result = classifyInboundRecord(request);
      expect(result.ok).toBe(true);
      if (result.ok) expect(result.record.kind).toBe("extension_ui_dialog");
    }
    for (const request of notifications) {
      const result = classifyInboundRecord(request);
      expect(result.ok).toBe(true);
      if (result.ok) expect(result.record.kind).toBe("extension_ui_notification");
    }
  });

  test("rejects malformed recognised extension_ui methods", () => {
    const malformed = [
      { type: "extension_ui_request", id: "", method: "notify", message: "x" },
      { type: "extension_ui_request", id: "n", method: "notify", message: "x", notifyType: "fatal" },
      { type: "extension_ui_request", id: "s", method: "setStatus", statusKey: 1 },
      { type: "extension_ui_request", id: "w", method: "setWidget", widgetKey: "k", widgetLines: [1] },
      { type: "extension_ui_request", id: "wp", method: "setWidget", widgetKey: "k", widgetPlacement: "side" },
      { type: "extension_ui_request", id: "t", method: "setTitle" },
      { type: "extension_ui_request", id: "e", method: "set_editor_text", text: 1 },
      { type: "extension_ui_request", id: "select", method: "select", title: "t", options: [1] },
      { type: "extension_ui_request", id: "confirm", method: "confirm", title: "t", message: 1 },
      { type: "extension_ui_request", id: "input", method: "input", title: 1 },
      { type: "extension_ui_request", id: "editor", method: "editor", title: 1 },
      { type: "extension_ui_request", id: "timeout", method: "confirm", title: "t", message: "m", timeout: 1.5 },
      { type: "extension_ui_request", id: "unsafe-timeout", method: "confirm", title: "t", message: "m", timeout: Number.MAX_SAFE_INTEGER + 1 },
    ];
    for (const request of malformed) expect(classifyInboundRecord(request).ok).toBeFalse();
  });

  test("ignores validated but irrelevant ordinary events", () => {
    const result = classifyInboundRecord({ type: "turn_start" });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.record.kind).toBe("ignored");
  });

  test("ignores unrecognized records with a string type", () => {
    const result = classifyInboundRecord({ type: "some_future_event", extra: 1 });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.record.kind).toBe("ignored");
  });

  test("rejects a malformed response record with protocol_error", () => {
    const result = classifyInboundRecord({ type: "response", command: "not_a_real_command", success: true });
    expect(result.ok).toBe(false);
  });

  test("rejects a malformed message_start record with protocol_error", () => {
    const result = classifyInboundRecord({ type: "message_start", message: { role: "assistant" } });
    expect(result.ok).toBe(false);
  });

  test("rejects a malformed extension_ui_request", () => {
    const result = classifyInboundRecord({ type: "extension_ui_request", id: "1", method: "select" });
    expect(result.ok).toBe(false);
  });

  test("rejects a value with no type field at all", () => {
    const result = classifyInboundRecord({ foo: "bar" });
    expect(result.ok).toBe(false);
  });

  test("rejects non-object values", () => {
    expect(classifyInboundRecord(null).ok).toBe(false);
    expect(classifyInboundRecord("string").ok).toBe(false);
    expect(classifyInboundRecord(42).ok).toBe(false);
  });

  test("admits bounded tool arguments and text-only result details", () => {
    expect(classifyInboundRecord({
      type: "tool_execution_start",
      toolCallId: "call-1",
      toolName: "read",
      args: { file: "/home/child/a.ts" },
    })).toMatchObject({ ok: true, record: { kind: "tool", phase: "running", arguments: { file: "/home/child/a.ts" } } });

    expect(classifyInboundRecord({
      type: "tool_execution_end",
      toolCallId: "call-1",
      toolName: "read",
      isError: true,
      result: {
        content: [
          { type: "image", data: "AAAA", mimeType: "image/png" },
          { type: "text", text: "line one" },
        ],
        details: { lines: 1 },
      },
    })).toMatchObject({ ok: true, record: { kind: "tool", phase: "failed", result: {
      content: ["line one"], details: { lines: 1 }, isError: true,
    } } });
  });

  test("keeps tool observations while omitting unusable rich values", () => {
    const oversized = { blob: "x".repeat(4_097) };
    const start = classifyInboundRecord({
      type: "tool_execution_start", toolCallId: "call-1", toolName: "read", args: oversized,
    });
    expect(start).toMatchObject({ ok: true, record: { kind: "tool", phase: "running" } });
    if (!start.ok || start.record.kind !== "tool") throw new Error("expected tool start");
    expect(start.record).not.toHaveProperty("arguments");

    const end = classifyInboundRecord({
      type: "tool_execution_end", toolCallId: "call-1", toolName: "read", isError: false,
      result: { content: [{ type: "image", data: "AAAA" }], details: oversized },
    });
    expect(end).toMatchObject({ ok: true, record: { kind: "tool", phase: "completed", result: {
      content: [], isError: false,
    } } });
    if (!end.ok || end.record.kind !== "tool") throw new Error("expected tool end");
    expect(end.record.result).not.toHaveProperty("details");
  });

  test.each([
    [{ type: "message_update", message: assistantMessage(), assistantMessageEvent: { type: "thinking_delta", contentIndex: 0, delta: "plan" } }, "assistant-content"],
    [{ type: "tool_execution_start", toolCallId: "call-1", toolName: "read", args: {} }, "tool"],
    [{ type: "tool_execution_update", toolCallId: "call-1", toolName: "read", args: {}, partialResult: {} }, "tool"],
    [{ type: "tool_execution_end", toolCallId: "call-1", toolName: "read", isError: false, result: {} }, "tool"],
    [{ type: "turn_end", message: assistantMessage(), toolResults: [] }, "turn-end"],
    [{ type: "compaction_start", reason: "threshold" }, "compaction"],
    [{ type: "compaction_end", reason: "threshold", result: null, aborted: false, willRetry: false }, "compaction"],
  ] as const)("validates observation event %j", (wire, kind) => {
    const result = classifyInboundRecord(wire);
    expect(result.ok && result.record.kind).toBe(kind);
  });

  test.each([
    { type: "message_update", message: assistantMessage(), assistantMessageEvent: { type: "text_delta", contentIndex: -1, delta: "x" } },
    { type: "tool_execution_start", toolCallId: "", toolName: "read", args: {} },
    { type: "tool_execution_end", toolCallId: "call-1", toolName: "read", isError: "false", result: {} },
    { type: "compaction_start", reason: 3 },
  ] as const)("rejects malformed required observation record %j", (wire) => {
    expect(classifyInboundRecord(wire)).toMatchObject({ ok: false });
  });

  test("keeps future stop reasons wire-valid and projects complete final blocks", () => {
    const result = classifyInboundRecord({
      type: "message_end",
      message: assistantMessage("", {
        stopReason: "future_reason",
        content: [{ type: "thinking", thinking: "plan" }, { type: "text", text: "answer" }],
      }),
    });
    expect(result).toMatchObject({
      ok: true,
      record: { kind: "assistant-end", stopReason: "future_reason", finalBlocks: [
        { contentIndex: 0, kind: "thinking", text: "plan" },
        { contentIndex: 1, kind: "text", text: "answer" },
      ] },
    });
  });

  test("rejects malformed final blocks and required end content", () => {
    expect(classifyInboundRecord({ type: "message_end", message: assistantMessage("", { content: [{ type: "text", text: 3 }] }) })).toMatchObject({ ok: false });
    expect(classifyInboundRecord({ type: "message_update", message: assistantMessage(), assistantMessageEvent: { type: "thinking_end", contentIndex: 0 } })).toMatchObject({ ok: false });
  });

  test("validates correlated get_session_stats success and failure", () => {
    expect(classifyInboundRecord({ type: "response", id: "stats-1", command: "get_session_stats", success: true,
      data: { sessionId: "agent-a", sessionFile: "/tmp/a.jsonl", contextUsage: { tokens: null, contextWindow: 200_000, percent: null } },
    })).toMatchObject({ ok: true, record: { kind: "response", command: "get_session_stats", success: true } });
    expect(classifyInboundRecord({ type: "response", id: "stats-2", command: "get_session_stats", success: false, error: "unavailable" }))
      .toMatchObject({ ok: true, record: { kind: "response", command: "get_session_stats", success: false } });
    expect(classifyInboundRecord({ type: "response", id: "stats-3", command: "get_session_stats", success: true, data: {} }))
      .toMatchObject({ ok: true, record: { kind: "response", command: "get_session_stats", success: true } });
  });
});

// --- Compile fixtures: assign locally constructed values to Pi's real exported wire types ----
// Imported from the package root (never `dist/modes/rpc/*`) so this breaks if those shapes drift.

const _responseFixture: RpcResponse = {
  type: "response",
  command: "get_entries",
  success: true,
  data: { entries: [], leafId: null },
};
void _responseFixture;

const _uiRequestFixture: RpcExtensionUIRequest = {
  type: "extension_ui_request",
  id: "1",
  method: "confirm",
  title: "Confirm?",
  message: "Are you sure?",
};
void _uiRequestFixture;

const _notifyRequestFixture: RpcExtensionUIRequest = {
  type: "extension_ui_request",
  id: "notify-1",
  method: "notify",
  message: "done",
  notifyType: "warning",
};
void _notifyRequestFixture;

const _statusRequestFixture: RpcExtensionUIRequest = {
  type: "extension_ui_request",
  id: "status-1",
  method: "setStatus",
  statusKey: "build",
  statusText: undefined,
};
void _statusRequestFixture;

const _widgetRequestFixture: RpcExtensionUIRequest = {
  type: "extension_ui_request",
  id: "widget-1",
  method: "setWidget",
  widgetKey: "jobs",
  widgetLines: ["one"],
  widgetPlacement: "belowEditor",
};
void _widgetRequestFixture;

const _wireNotifyFixture = {
  type: "extension_ui_request",
  id: testUIRequestId("notify-1"),
  method: "notify",
  message: "done",
  notifyType: "warning",
} satisfies WireExtensionUINotification;
void _wireNotifyFixture;

const _wireWidgetFixture = {
  type: "extension_ui_request",
  id: testUIRequestId("widget-1"),
  method: "setWidget",
  widgetKey: "jobs",
  widgetPlacement: "belowEditor",
} satisfies WireExtensionUINotification;
void _wireWidgetFixture;

const _uiResponseFixture: RpcExtensionUIResponse = {
  type: "extension_ui_response",
  id: "1",
  confirmed: true,
};
void _uiResponseFixture;

const _agentSettledFixture: AgentSessionEvent = { type: "agent_settled" };
void _agentSettledFixture;
