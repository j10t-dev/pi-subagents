import type { ExtensionFactory } from "@earendil-works/pi-coding-agent";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import type { Api, AssistantMessage, Context, Message, Model, ToolCall } from "@earendil-works/pi-ai";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { Type } from "typebox";

let callSequence = 0;
let hangAfterSetsid = false;
const setsidFixturePath = process.env.MOCK_SETSID_FIXTURE_PATH;
const setsidPath = process.env.MOCK_SETSID_PATH;
const setsidPidPath = process.env.MOCK_SETSID_PID_PATH;
const confirmationTimeoutMs = Number(process.env.MOCK_CONFIRM_TIMEOUT_MS ?? 100);
const childLaunchDir = process.env.MOCK_PROVIDER_CHILD_LAUNCH_DIR;

if (process.env.PI_SUBAGENT_CHILD === "1" && childLaunchDir !== undefined) {
  writeFileSync(join(childLaunchDir, `${process.pid}.json`), JSON.stringify({ pid: process.pid, argv: process.argv }));
}

const factory: ExtensionFactory = (pi) => {
  if (process.env.PI_SUBAGENT_CHILD === "1") {
    const identityFixture = process.env.MOCK_CHILD_IDENTITY_FIXTURE;
    const inputOrderPath = process.env.MOCK_CHILD_INPUT_ORDER_PATH;
    if (identityFixture !== undefined || inputOrderPath !== undefined) {
      const recordInputComplete = (): void => {
        if (inputOrderPath !== undefined) writeFileSync(inputOrderPath, "input-complete\n", { flag: "a" });
      };
      pi.on("input", async (event) => {
        if (event.source !== "rpc") {
          recordInputComplete();
          return { action: "continue" };
        }
        if (identityFixture === "transform") {
          recordInputComplete();
          return { action: "transform", text: `transformed:${event.text}` };
        }
        if (identityFixture === "inject") pi.sendUserMessage(`competing:${event.text}`);
        recordInputComplete();
        return { action: "continue" };
      });
    }
    if (inputOrderPath !== undefined) {
      pi.on("agent_start", () => {
        writeFileSync(inputOrderPath, "agent-start\n", { flag: "a" });
      });
    }
  }
  pi.registerTool({
    name: "mock_child_extension",
    label: "Mock child extension",
    description: "Proves an unrelated extension remains active in a subagent child.",
    parameters: Type.Object({ confirm: Type.Optional(Type.Boolean()) }),
    execute: async (_id, params, _signal, _update, context) => {
      const confirmed = params.confirm === true
        ? await context.ui.confirm("Mock child confirmation", "Continue?", { timeout: confirmationTimeoutMs })
        : false;
      return { content: [{ type: "text", text: confirmed ? "confirmed" : "active" }], details: { confirmed } };
    },
  });
  pi.registerProvider("mock-provider", {
    name: "Deterministic mock provider",
    baseUrl: "http://127.0.0.1:0",
    apiKey: "unused",
    api: "anthropic-messages",
    models: [{
      id: "mock-model",
      name: "Mock model",
      reasoning: true,
      input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 100_000,
      maxTokens: 4_096,
    }, {
      id: "luna",
      name: "Legacy persistence fixture model",
      reasoning: true,
      input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 100_000,
      maxTokens: 4_096,
    }, {
      id: "plain-model",
      name: "Plain mock model",
      reasoning: false,
      input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 100_000,
      maxTokens: 4_096,
    }, ...(process.env.PI_SUBAGENT_CHILD === "1" ? [{
      id: "new-model",
      name: "Child-only custom fallback model",
      reasoning: true,
      input: ["text" as const],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 100_000,
      maxTokens: 4_096,
    }] : [])],
    streamSimple: (model: Model<Api>, context: Context) => scripted(model, context),
  });
};

function scripted(model: Model<Api>, context: Context): ReturnType<typeof createAssistantMessageEventStream> {
  const stream = createAssistantMessageEventStream();
  const prompt = lastUserText(context.messages);
  const result = lastToolResultText(context.messages);
  if (process.env.PI_SUBAGENT_CHILD === "1" && prompt.includes("NESTED_DELEGATION")) {
    const toolResultCount = context.messages.filter((item) => item.role === "toolResult").length;
    if (toolResultCount === 0) {
      emitTool(stream, model.id, "spawn_agent", { task: "REPORT_TOOLS" });
    } else if (toolResultCount === 1) {
      emitTool(stream, model.id, "receive_agent", { timeoutMs: 10_000 });
    } else {
      emitText(stream, model.id, JSON.stringify({
        childTools: context.tools?.map((tool) => tool.name).sort() ?? [],
        grandchildReceive: parseFixtureProtocolRecord(result ?? "{}"),
      }));
    }
  } else if (result !== undefined) {
    if (hangAfterSetsid) {
      const initial = message(model.id, [], "stop");
      stream.push({ type: "start", partial: initial });
    } else emitText(stream, model.id, result);
  } else if (prompt.startsWith("CALL_SPAWN_TASK|")) {
    const [, task = "CHILD_COMPLETE", requestedModel = "", requestedCwd = "", requestedTools = ""] = prompt.split("|");
    emitTool(stream, model.id, "spawn_agent", {
      task,
      ...(requestedModel.length === 0 ? {} : { model: requestedModel }),
      ...(requestedCwd.length === 0 ? {} : { cwd: requestedCwd }),
      ...(requestedTools.length === 0 ? {} : { tools: requestedTools === "<none>" ? [] : requestedTools.split(",") }),
    });
  } else if (prompt.startsWith("CALL_SEND|")) {
    const [, agentId, message = "CHILD_COMPLETE"] = prompt.split("|");
    emitTool(stream, model.id, "send_input", { agentId: agentId ?? "missing", message });
  } else if (prompt.startsWith("CALL_STOP|")) {
    const [, agentId] = prompt.split("|");
    emitTool(stream, model.id, "stop_agent", { agentIds: [agentId ?? "missing"] });
  } else if (prompt.includes("CALL_SPAWN")) {
    emitTool(stream, model.id, "spawn_agent", { task: "CHILD_COMPLETE" });
  } else if (prompt.includes("CALL_RECEIVE")) {
    emitTool(stream, model.id, "receive_agent", { timeoutMs: 10_000 });
  } else if (prompt.includes("CHILD_CONFIRM")) {
    emitTool(stream, model.id, "mock_child_extension", { confirm: true });
  } else if (prompt.includes("REPORT_TOOLS")) {
    emitText(stream, model.id, JSON.stringify(context.tools?.map((tool) => tool.name).sort() ?? []));
  } else if (prompt.includes("REPORT_SPAWN_SCHEMA")) {
    const spawn = context.tools?.find((tool) => tool.name === "spawn_agent");
    emitText(stream, model.id, JSON.stringify(spawn === undefined
      ? null
      : { description: spawn.description, parameters: spawn.parameters }));
  } else if (prompt.includes("REPORT_CONTEXT")) {
    emitText(stream, model.id, context.systemPrompt ?? "");
  } else if (prompt.includes("REPORT_PROCESS")) {
    emitText(stream, model.id, JSON.stringify({ cwd: process.cwd(), argv: process.argv }));
  } else if (prompt.startsWith("<conversation>")) {
    emitText(stream, model.id, "deterministic compaction summary");
  } else if (prompt.includes("NEEDS_CONTEXT")) {
    emitText(stream, model.id, "NEEDS_CONTEXT");
  } else if (prompt.includes("CHILD_SETSID_HANG")) {
    if (setsidFixturePath === undefined || setsidPath === undefined || setsidPidPath === undefined) {
      throw new Error("setsid mock fixture paths are required");
    }
    hangAfterSetsid = true;
    emitTool(stream, model.id, "bash", {
      command: [process.execPath, setsidFixturePath, setsidPidPath, setsidPath].map((value) => JSON.stringify(value)).join(" "),
    });
  } else if (prompt.includes("CHILD_HANG")) {
    const initial = message(model.id, [], "stop");
    stream.push({ type: "start", partial: initial });
  } else if (prompt.includes("CHILD_COMPLETE")) {
    const assignments = context.messages.filter((item) => item.role === "user").map((item) =>
      typeof item.content === "string" ? item.content : item.content.filter((part) => part.type === "text").map((part) => part.text).join(""));
    emitText(stream, model.id, `child-complete:${assignments.join(">")}`);
  } else {
    emitText(stream, model.id, `echo:${prompt}`);
  }
  return stream;
}

type FixtureProtocolValue = string | number | boolean | null | FixtureProtocolRecord | readonly FixtureProtocolValue[];
type FixtureProtocolRecord = { readonly [key: string]: FixtureProtocolValue };

function parseFixtureProtocolRecord(text: string): FixtureProtocolRecord {
  let value: unknown;
  try { value = JSON.parse(text); } catch { return {}; }
  return isFixtureProtocolRecord(value) ? value : {};
}

function isFixtureProtocolRecord(value: unknown): value is FixtureProtocolRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value) &&
    Object.values(value).every(isFixtureProtocolValue);
}

function isFixtureProtocolValue(value: unknown): value is FixtureProtocolValue {
  return value === null || typeof value === "string" || typeof value === "number" ||
    typeof value === "boolean" || Array.isArray(value) && value.every(isFixtureProtocolValue) ||
    isFixtureProtocolRecord(value);
}

function emitText(stream: ReturnType<typeof createAssistantMessageEventStream>, modelId: string, text: string): void {
  const initial = message(modelId, [], "stop");
  stream.push({ type: "start", partial: initial });
  stream.push({ type: "text_start", contentIndex: 0, partial: initial });
  const final = message(modelId, [{ type: "text", text }], "stop", Math.max(1, Math.ceil(text.length / 4)));
  stream.push({ type: "text_delta", contentIndex: 0, delta: text, partial: final });
  stream.push({ type: "text_end", contentIndex: 0, content: text, partial: final });
  stream.push({ type: "done", reason: "stop", message: final });
}

function emitTool(
  stream: ReturnType<typeof createAssistantMessageEventStream>,
  modelId: string,
  name: string,
  args: Record<string, string | number | boolean | string[]>,
): void {
  const initial = message(modelId, [], "toolUse");
  const call: ToolCall = { type: "toolCall", id: `mock-call-${++callSequence}`, name, arguments: args };
  const final = message(modelId, [call], "toolUse");
  stream.push({ type: "start", partial: initial });
  stream.push({ type: "toolcall_start", contentIndex: 0, partial: initial });
  stream.push({ type: "toolcall_end", contentIndex: 0, toolCall: call, partial: final });
  stream.push({ type: "done", reason: "toolUse", message: final });
}

function message(
  modelId: string,
  content: AssistantMessage["content"],
  stopReason: AssistantMessage["stopReason"],
  outputTokens = 1,
): AssistantMessage {
  return {
    role: "assistant",
    content,
    api: "anthropic-messages",
    provider: "mock-provider",
    model: modelId,
    usage: { input: 1, output: outputTokens, cacheRead: 0, cacheWrite: 0, totalTokens: outputTokens + 1,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
    stopReason,
    timestamp: Date.now(),
  };
}

function lastUserText(messages: readonly Message[]): string {
  for (let index = messages.length - 1; index >= 0; index--) {
    const candidate = messages[index];
    if (candidate?.role !== "user") continue;
    if (typeof candidate.content === "string") return candidate.content;
    return candidate.content.filter((part) => part.type === "text").map((part) => part.text).join("");
  }
  return "";
}

function lastToolResultText(messages: readonly Message[]): string | undefined {
  const candidate = messages.at(-1);
  if (candidate?.role !== "toolResult") return undefined;
  return candidate.content.filter((part) => part.type === "text").map((part) => part.text).join("");
}

export default factory;
