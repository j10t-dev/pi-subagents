#!/usr/bin/env node
// Command-driven fake RPC child fixture, selected by FAKE_RPC_SCENARIO.
//
// Speaks a deterministic subset of Pi's RPC wire protocol: JSONL commands on stdin
// (get_entries, prompt, abort, extension_ui_response), JSONL responses/events on stdout.
// Used by rpc-client.test.ts and ui-spike.test.ts as the "child" side of the transport, so
// none of those tests need to spawn a real Pi process.

import { createInterface } from "node:readline";
import { appendFileSync, existsSync } from "node:fs";
import { join } from "node:path";

const scenario = process.env.FAKE_RPC_SCENARIO ?? "normal";
const handshakeDir = process.env.FAKE_RPC_HANDSHAKE_DIR;
const launchMarker = process.env.FAKE_RPC_LAUNCH_MARKER;
const commandMarker = process.env.FAKE_RPC_COMMAND_MARKER;
const terminationMarker = process.env.FAKE_RPC_TERMINATION_MARKER;
if (launchMarker !== undefined) appendFileSync(launchMarker, "started\n");
if (terminationMarker !== undefined) process.on("SIGTERM", () => {
  appendFileSync(terminationMarker, "terminated\n");
  process.exit(0);
});

let finalAssistant;
let hasSettled = false;
let oversizedResponseSent = false;
let promptedMessage;

function write(record) {
  if (record?.type === "message_end") finalAssistant = record.message;
  if (record?.type === "agent_settled") hasSettled = true;
  process.stdout.write(`${JSON.stringify(record)}\n`);
}

function respond(command, id, extra) {
  write({ id, type: "response", command, success: true, ...extra });
}

function respondFailure(command, id, error) {
  write({ id, type: "response", command, success: false, error });
}

function assistantMessage(text, usageOverrides = {}) {
  return {
    role: "assistant",
    content: text.length > 0 ? [{ type: "text", text }] : [],
    api: "messages",
    provider: "anthropic",
    model: "fake",
    usage: {
      input: 1,
      output: 1,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 2,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      ...usageOverrides,
    },
    stopReason: "stop",
    timestamp: Date.now(),
  };
}

function emitTurn(text, { deltas = [text] } = {}) {
  write({ type: "message_start", message: assistantMessage("") });
  let index = 0;
  for (const delta of deltas) {
    write({
      type: "message_update",
      message: assistantMessage(""),
      assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta, partial: assistantMessage("") },
    });
    index += delta.length;
  }
  void index;
  write({ type: "message_end", message: assistantMessage(text) });
  write({ type: "agent_settled" });
}

const rl = createInterface({ input: process.stdin, terminal: false });

rl.on("line", (line) => {
  if (line.trim().length === 0) return;
  let command;
  try {
    command = JSON.parse(line);
  } catch {
    return;
  }

  switch (command.type) {
    case "set_model":
    case "set_thinking_level":
      if (commandMarker !== undefined) appendFileSync(commandMarker, `${command.type}:${command.type === "set_model" ? `${command.provider}/${command.modelId}` : command.level}\n`);
      respond(command.type, command.id, {});
      return;
    case "get_session_stats":
      if (scenario === "stats-command-mismatch") {
        respond("get_entries", command.id, { data: { entries: [], leafId: null } });
        return;
      }
      if (scenario === "stats-unknown-command") {
        respond("future_command", command.id, {});
        return;
      }
      if (scenario === "stats-missing-data") {
        write({ type: "response", command: "get_session_stats", id: command.id, success: true });
        return;
      }
      if (scenario === "stats-oversized-response") {
        write({ type: "response", command: "get_session_stats", id: command.id, success: true, data: "x".repeat(16 * 1024 * 1024 + 1) });
        return;
      }
      if (scenario === "stats-malformed-usage") {
        respond("get_session_stats", command.id, { data: {
          sessionId: process.env.FAKE_RPC_AGENT_ID,
          sessionFile: process.env.FAKE_RPC_SESSION_PATH,
          contextUsage: { tokens: "invalid", contextWindow: 200, percent: 37 },
        } });
        return;
      }
      respond("get_session_stats", command.id, { data: {
        ...(scenario === "stats-absent-identity" ? {} : {
          sessionId: process.env.FAKE_RPC_AGENT_ID,
          sessionFile: process.env.FAKE_RPC_SESSION_PATH,
        }),
        userMessages: 1,
        assistantMessages: 1,
        cost: 99,
        contextUsage: { tokens: 74, contextWindow: 200, percent: 37 },
      } });
      return;
    case "get_entries":
      if (scenario === "pending-command") return;
      if (scenario === "exit-pending-get-entries") {
        // Two-way file handshake: announce the outstanding evidence request, then exit without
        // ever answering it once the test releases us.
        appendFileSync(join(handshakeDir, "get-entries-received"), "received\n");
        const release = setInterval(() => {
          if (!existsSync(join(handshakeDir, "release-pending-get-entries"))) return;
          clearInterval(release);
          process.exit(0);
        }, 5);
        return;
      }
      if (!oversizedResponseSent && scenario.startsWith("oversized-response-")) {
        oversizedResponseSent = true;
        const huge = "x".repeat(16 * 1024 * 1024 + 1);
        if (scenario === "oversized-response-known") process.stdout.write(`${JSON.stringify({ type: "response", id: command.id, command: "get_entries", payload: huge })}\n`);
        if (scenario === "oversized-response-missing") process.stdout.write(`${JSON.stringify({ type: "response", command: "get_entries", payload: huge })}\n`);
        if (scenario === "oversized-response-overlong") process.stdout.write(`${JSON.stringify({ type: "response", id: "i".repeat(600), command: "get_entries", payload: huge })}\n`);
        if (scenario === "oversized-response-truncated") process.stdout.write(`{"payload":"${huge}","type":"response","id":"unterminated\n`);
        if (scenario === "oversized-response-unidentified") process.stdout.write(`${JSON.stringify({ payload: huge })}\n`);
        return;
      }
      if (command.since === "ffffffff") {
        respondFailure("get_entries", command.id, `Entry not found: ${command.since}`);
        return;
      }
      if (scenario === "entries-with-leaf") {
        respond("get_entries", command.id, { data: { entries: [], leafId: "bbbbbbbb" } });
        return;
      }
      if (scenario === "entries-malformed-leaf") {
        respond("get_entries", command.id, { data: { entries: [], leafId: "not-an-entry" } });
        return;
      }
      const assignment = promptedMessage === undefined
        ? []
        : [{ type: "message", id: scenario === "observation-two-runs" && promptedMessage.includes("two") ? "cafebabe" : "deadbeef",
          message: { role: "user", content: promptedMessage } }];
      const entries = scenario === "settlement-invalid-usage" && hasSettled
        ? [
          { type: "message", id: "assistant-valid", message: assistantMessage("valid") },
          { type: "message", id: "assistant-invalid", message: assistantMessage("invalid", { input: -1 }) },
        ]
        : hasSettled && finalAssistant !== undefined ? [...assignment, { type: "message", id: "assistant-final", message: finalAssistant }] : assignment;
      respond("get_entries", command.id, { data: { entries, leafId: null } });
      return;
    case "abort":
      respond("abort", command.id, {});
      if (scenario === "abort") {
        write({ type: "agent_settled" });
      }
      return;
    case "extension_ui_response":
      if (commandMarker !== undefined) appendFileSync(commandMarker, `extension_ui_response:${JSON.stringify(command)}\n`);
      pendingUiResolvers.get(command.id)?.();
      pendingUiResolvers.delete(command.id);
      return;
    case "prompt":
      promptedMessage = command.message;
      if (commandMarker !== undefined) appendFileSync(commandMarker, `prompt:${command.message}\n`);
      if (scenario === "agent-start-before-ack") {
        write({ type: "agent_start" });
        respond("prompt", command.id, {});
        return;
      }
      if (scenario === "exit-immediate") {
        // Acknowledge, then die without agent_settled and without answering any later request.
        respond("prompt", command.id, {});
        process.stdout.write("", () => process.exit(0));
        return;
      }
      if (scenario === "agent-start-after-ack") {
        respond("prompt", command.id, {});
        setImmediate(() => write({ type: "agent_start" }));
        return;
      }
      respond("prompt", command.id, {});
      write({ type: "agent_start" });
      setTimeout(runScenario, 10);
      return;
    default:
      return;
  }
});

const pendingUiResolvers = new Map();

function runScenario() {
  switch (scenario) {
    case "settled-error": {
      const message = { ...assistantMessage("failed"), stopReason: "error", errorMessage: "provider failed" };
      write({ type: "message_end", message }); write({ type: "agent_settled" }); break;
    }
    case "settled-length": {
      const message = { ...assistantMessage("limited"), stopReason: "length" };
      write({ type: "message_end", message }); write({ type: "agent_settled" }); break;
    }
    case "settled-aborted": {
      const message = { ...assistantMessage(""), stopReason: "aborted" };
      write({ type: "message_end", message }); write({ type: "agent_settled" }); break;
    }
    case "incomplete-tool-use": {
      const message = { ...assistantMessage(""), content: [{ type: "toolCall", id: "call-1", name: "x", arguments: {} }], stopReason: "toolUse" };
      write({ type: "message_end", message }); write({ type: "agent_settled" }); break;
    }
    case "observation-two-runs": {
      const runLabel = promptedMessage?.includes("two") ? "two" : "one";
      const final = assistantMessage(`observed run ${runLabel}`);
      write({ type: "compaction_start", reason: "threshold" });
      write({ type: "compaction_end", reason: "threshold", result: null, aborted: false, willRetry: false });
      write({ type: "message_start", message: assistantMessage("") });
      write({ type: "message_update", message: assistantMessage(""), assistantMessageEvent: {
        type: "text_delta", contentIndex: 0, delta: `observed run ${runLabel}`, partial: assistantMessage(""),
      } });
      write({ type: "tool_execution_start", toolCallId: "call-1", toolName: "read", args: { path: "/not-copied" } });
      write({ type: "tool_execution_end", toolCallId: "call-1", toolName: "read", result: { content: [], details: {} }, isError: false });
      write({ type: "message_end", message: final });
      write({ type: "turn_end", message: final, toolResults: [] });
      write({ type: "agent_settled" });
      break;
    }
    case "activity-context": {
      const final = { ...assistantMessage("answer"), stopReason: "toolUse" };
      const records = [
        { type: "message_start", message: assistantMessage("") },
        { type: "message_update", message: assistantMessage(""), assistantMessageEvent: { type: "thinking_delta", contentIndex: 0, delta: "plan", partial: assistantMessage("") } },
        { type: "message_update", message: assistantMessage(""), assistantMessageEvent: { type: "text_delta", contentIndex: 1, delta: "answer", partial: assistantMessage("") } },
        { type: "tool_execution_start", toolCallId: "call-1", toolName: "read", args: { path: "/initial" } },
        { type: "tool_execution_update", toolCallId: "call-1", toolName: "read", args: { path: "/not-copied" } },
        { type: "tool_execution_end", toolCallId: "call-1", toolName: "read", result: { content: [{ type: "text", text: "not-copied" }], details: {} }, isError: false },
        { type: "message_end", message: final },
        { type: "turn_end", message: final, toolResults: [] },
        { type: "agent_settled" },
      ];
      const emitNext = () => {
        const record = records.shift();
        if (record === undefined) return;
        write(record);
        setTimeout(emitNext, 100);
      };
      emitNext();
      break;
    }
    case "long-observation": {
      const longDelta = "🙂".repeat(2_048);
      const longToolName = "读".repeat(80);
      write({ type: "message_start", message: assistantMessage("") });
      write({ type: "message_update", message: assistantMessage(""), assistantMessageEvent: {
        type: "text_delta", contentIndex: 0, delta: longDelta, partial: assistantMessage(""),
      } });
      write({ type: "message_update", message: assistantMessage(""), assistantMessageEvent: {
        type: "text_delta", contentIndex: 0, delta: "saturated", partial: assistantMessage(""),
      } });
      write({ type: "tool_execution_start", toolCallId: "long-call", toolName: longToolName, args: {} });
      const release = setInterval(() => {
        if (handshakeDir === undefined || !existsSync(join(handshakeDir, "release-long-observation"))) return;
        clearInterval(release);
        write({ type: "tool_execution_end", toolCallId: "long-call", toolName: longToolName, result: {}, isError: false });
        write({ type: "message_end", message: assistantMessage(longDelta) });
        write({ type: "agent_settled" });
      }, 5);
      break;
    }
    case "normal":
      emitTurn("hello world", { deltas: ["hello", " world"] });
      break;
    case "settled-exit":
      emitTurn("hello world", { deltas: ["hello", " world"] });
      setTimeout(() => process.exit(0), 20);
      break;
    case "delayed-protocol-loss":
      setTimeout(() => {
        write({ type: "message_end", message: assistantMessage("original binding") });
        write({ type: "message_end", message: { role: "assistant" } });
        write({ type: "agent_settled" });
      }, 20);
      break;
    case "chunked": {
      const payload = `${JSON.stringify({ type: "message_start", message: assistantMessage("") })}\n`;
      const bytes = Buffer.from(payload, "utf-8");
      let i = 0;
      const step = () => {
        if (i >= bytes.length) {
          write({
            type: "message_update",
            message: assistantMessage(""),
            assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "chunked", partial: assistantMessage("") },
          });
          write({ type: "message_end", message: assistantMessage("chunked") });
          write({ type: "agent_settled" });
          return;
        }
        process.stdout.write(bytes.subarray(i, i + 1));
        i += 1;
        setImmediate(step);
      };
      step();
      break;
    }
    case "unicode-separators":
      emitTurn("line sep end", { deltas: ["line sep end"] });
      break;
    case "malformed":
      write({ type: "message_start", message: assistantMessage("") });
      process.stdout.write("not valid json at all\n");
      write({ type: "message_end", message: assistantMessage("recovered after malformed") });
      write({ type: "agent_settled" });
      break;
    case "captured-transport-exception": {
      const captured = `captured-transport-state:${"s".repeat(30_000)}`;
      write({ type: "message_end", message: assistantMessage("x".repeat(50_000)) });
      process.stdout.write(`not-json:${captured}\n`);
      process.exit(1);
      break;
    }
    case "oversized": {
      const huge = "x".repeat(16 * 1024 * 1024 + 1);
      write({ type: "message_start", message: assistantMessage("") });
      process.stdout.write(`${JSON.stringify({ type: "model_change", value: huge })}\n`);
      write({ type: "message_end", message: assistantMessage("after oversized") });
      write({ type: "agent_settled" });
      break;
    }
    case "oversized-message-update": {
      const huge = "x".repeat(16 * 1024 * 1024 + 1);
      write({ type: "message_start", message: assistantMessage("") });
      process.stdout.write(`${JSON.stringify({
        toolPayload: huge,
        assistantMessageEvent: {
          partial: assistantMessage(""),
          delta: "untrusted streamed delta",
          contentIndex: 0,
          type: "text_delta",
        },
        message: assistantMessage(""),
        type: "message_update",
      })}\n`);
      write({ type: "message_end", message: assistantMessage("authoritative recovered output") });
      write({ type: "agent_settled" });
      break;
    }
    case "context-cumulative": {
      write({ type: "message_start", message: assistantMessage("") });
      const chunk = "x".repeat(1024 * 1024);
      for (let index = 0; index < 24; index++) {
        write({ type: "message_update", message: assistantMessage(""),
          assistantMessageEvent: { type: "metadata", payload: chunk, index } });
      }
      const huge = "y".repeat(16 * 1024 * 1024 + 1);
      process.stdout.write(`${JSON.stringify({ type: "tool_execution_end", toolCallId: "huge-tool", result: huge })}\n`);
      write({ type: "message_end", message: assistantMessage("authoritative after cumulative flood") });
      write({ type: "agent_settled" });
      break;
    }
    case "oversized-ui": {
      const huge = "u".repeat(16 * 1024 * 1024 + 1);
      process.stdout.write(`${JSON.stringify({ type: "extension_ui_request", id: "huge-ui", method: "confirm", title: huge, message: huge })}\n`);
      break;
    }
    case "poison-text-end":
      write({ type: "message_start", message: assistantMessage("") });
      write({
        type: "message_update",
        message: assistantMessage(""),
        assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "trusted delta", partial: assistantMessage("") },
      });
      write({
        type: "message_update",
        message: assistantMessage(""),
        assistantMessageEvent: {
          type: "text_end",
          contentIndex: 0,
          content: "POISONED_TEXT_END_CONTENT",
          partial: assistantMessage("POISONED_PARTIAL"),
        },
      });
      write({ type: "message_end", message: assistantMessage("authoritative final") });
      write({ type: "agent_settled" });
      break;
    case "malformed-ordinary":
      write({ type: "ordinary_event", malformed: { unexpected: true } });
      emitTurn("recovered ordinary");
      break;
    case "protocol-loss": {
      write({ type: "message_end", message: assistantMessage("stale") });
      write({ type: "message_end", message: { role: "assistant" } });
      write({ type: "agent_settled" });
      break;
    }
    case "overflowed-aggregate-usage": {
      write({ type: "message_end", message: assistantMessage("one", { input: Number.MAX_VALUE }) });
      write({ type: "message_end", message: assistantMessage("two", { input: Number.MAX_VALUE }) });
      break;
    }
    case "settlement-invalid-usage":
    case "exit-pending-get-entries":
      write({ type: "agent_settled" });
      break;
    case "multi-turn-usage": {
      write({ type: "message_end", message: assistantMessage("one", { cacheWrite1h: 3, reasoning: 5 }) });
      write({ type: "message_end", message: assistantMessage("two", { cacheWrite1h: 7 }) });
      write({ type: "message_end", message: assistantMessage("three", { reasoning: 11 }) });
      write({ type: "agent_settled" });
      break;
    }
    case "multi-turn-usage-undefined": {
      write({ type: "message_end", message: assistantMessage("one") });
      write({ type: "message_end", message: assistantMessage("two") });
      write({ type: "agent_settled" });
      break;
    }
    case "ui-notifications": {
      write({ type: "extension_ui_request", id: "notify", method: "notify", message: "done", notifyType: "warning" });
      write({ type: "extension_ui_request", id: "status", method: "setStatus", statusKey: "build", statusText: "running" });
      write({ type: "extension_ui_request", id: "widget", method: "setWidget", widgetKey: "jobs", widgetLines: ["one"] });
      write({ type: "extension_ui_request", id: "title", method: "setTitle", title: "ignored" });
      write({ type: "extension_ui_request", id: "editor", method: "set_editor_text", text: "ignored" });
      emitTurn("notifications");
      break;
    }
    case "ui-resource-settled":
      write({ type: "extension_ui_request", id: "status", method: "setStatus", statusKey: "build", statusText: "running" });
      write({ type: "extension_ui_request", id: "widget", method: "setWidget", widgetKey: "jobs", widgetLines: ["one"] });
      emitTurn("resources");
      break;
    case "ui-resource-abort":
      write({ type: "extension_ui_request", id: "status", method: "setStatus", statusKey: "build", statusText: "running" });
      write({ type: "extension_ui_request", id: "widget", method: "setWidget", widgetKey: "jobs", widgetLines: ["one"] });
      break;
    case "ui-resource-pending":
      write({ type: "extension_ui_request", id: "status", method: "setStatus", statusKey: "build", statusText: "running" });
      write({ type: "extension_ui_request", id: "widget", method: "setWidget", widgetKey: "jobs", widgetLines: ["one"] });
      break;
    case "ui-resource-crash":
      write({ type: "extension_ui_request", id: "status", method: "setStatus", statusKey: "build", statusText: "running" });
      write({ type: "extension_ui_request", id: "widget", method: "setWidget", widgetKey: "jobs", widgetLines: ["one"] });
      setTimeout(() => process.exit(1), 10);
      break;
    case "ui-resource-malformed":
      write({ type: "extension_ui_request", id: "status", method: "setStatus", statusKey: "build", statusText: "running" });
      write({ type: "extension_ui_request", id: "widget", method: "setWidget", widgetKey: "jobs", widgetLines: ["one"] });
      process.stdout.write(`${JSON.stringify({ type: "extension_ui_request", id: "bad-widget", method: "setWidget", widgetKey: "bad", widgetLines: [1] })}\n`);
      break;
    case "ui": {
      write({ type: "message_start", message: assistantMessage("") });
      const id = "ui-request-1";
      write({ type: "extension_ui_request", id, method: "confirm", title: "Confirm?", message: "proceed?" });
      pendingUiResolvers.set(id, () => {
        write({ type: "message_end", message: assistantMessage("confirmed") });
        write({ type: "agent_settled" });
      });
      break;
    }
    case "crash":
      write({ type: "message_start", message: assistantMessage("") });
      process.exitCode = 1;
      process.exit(1);
      break;
    case "abort":
      write({ type: "message_start", message: assistantMessage("") });
      break;
    case "stderr-flood":
      for (let i = 0; i < 1000; i++) {
        process.stderr.write(`stderr line ${i} ${"x".repeat(200)}\n`);
      }
      emitTurn("after flood", { deltas: ["after flood"] });
      break;
    case "stderr-single-chunk":
      process.stderr.write(`OLDEST-STDERR-START${"x".repeat(50_100)}NEWEST-STDERR-END`);
      emitTurn("after stderr chunk", { deltas: ["after stderr chunk"] });
      break;
    default:
      emitTurn("unknown scenario", { deltas: ["unknown scenario"] });
  }
}

process.stdin.resume();
