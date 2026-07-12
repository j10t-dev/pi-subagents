import { describe, expect, test } from "bun:test";
import type { AgentSessionEvent } from "@earendil-works/pi-coding-agent";
import type {
  RpcExtensionUIRequest,
  RpcExtensionUIResponse,
  RpcResponse,
} from "@earendil-works/pi-coding-agent";

import { classifyInboundRecord } from "../src/rpc-wire.ts";
import type { WireExtensionUINotification } from "../src/rpc-wire.ts";

function assistantMessage(overrides: Record<string, unknown> = {}) {
  return {
    role: "assistant",
    content: [{ type: "text", text: "hello" }],
    api: "messages",
    provider: "anthropic",
    model: "claude",
    usage: {
      input: 1,
      output: 1,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 2,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: "stop",
    timestamp: Date.now(),
    ...overrides,
  };
}

describe("classifyInboundRecord", () => {
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
        ? { type, message: assistantMessage({ usage }), assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "hi" } }
        : { type, message: assistantMessage({ usage }) };
      expect(classifyInboundRecord(event).ok).toBe(false);
    }
  });

  test.each(["message_start", "message_update", "message_end"] as const)("accepts optional usage fields on %s", (type) => {
    const message = assistantMessage({ usage: {
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
    if (result.ok) expect(result.record.kind).toBe("message_start");
  });

  test("ignores Pi user message boundaries while retaining strict assistant validation", () => {
    for (const type of ["message_start", "message_end"] as const) {
      const result = classifyInboundRecord({ type, message: { role: "user", content: [{ type: "text", text: "assignment" }], timestamp: Date.now() } });
      expect(result).toEqual({ ok: true, record: { kind: "ignored" } });
    }
  });

  test("classifies a text_delta inside message_update", () => {
    const result = classifyInboundRecord({
      type: "message_update",
      message: assistantMessage(),
      assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "hi", partial: assistantMessage() },
    });
    expect(result.ok).toBe(true);
    if (result.ok && result.record.kind === "text_delta") {
      expect(result.record.delta).toBe("hi");
      expect(result.record.contentIndex).toBe(0);
    } else {
      throw new Error("expected text_delta");
    }
  });

  test("classifies a non-text_delta message_update as message_update_other", () => {
    const result = classifyInboundRecord({
      type: "message_update",
      message: assistantMessage(),
      assistantMessageEvent: { type: "thinking_delta", contentIndex: 0, delta: "hmm", partial: assistantMessage() },
    });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.record.kind).toBe("message_update_other");
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
    if (result.ok) expect(result.record.kind).toBe("message_end");
  });

  test("classifies agent_settled", () => {
    const result = classifyInboundRecord({ type: "agent_settled" });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.record.kind).toBe("agent_settled");
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
  id: "notify-1",
  method: "notify",
  message: "done",
  notifyType: "warning",
} satisfies WireExtensionUINotification;
void _wireNotifyFixture;

const _wireWidgetFixture = {
  type: "extension_ui_request",
  id: "widget-1",
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
