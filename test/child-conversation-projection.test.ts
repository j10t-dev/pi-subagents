import { describe, expect, test } from "bun:test";

import type {
  AgentDisplayState,
  AgentRow,
  ConversationAssistantBlock,
  ConversationToolPresentation,
  ConversationToolRendering,
  ConversationTurn,
  SelectedTranscriptSnapshot,
  TranscriptAssistantBlock,
  TranscriptItem,
} from "../src/agent-observation.ts";
import { projectConversationSnapshot } from "../src/agent-widget/conversation-projection.ts";
import {
  AgentState,
  agentDepth,
  agentOrdinal,
  runId,
  selectedTranscriptRevision,
  transcriptAssistantGroup,
  transcriptRevision,
  transcriptSequence,
  type AbsolutePath,
  type ContextLabel,
  type ModelLabel,
  type TaskLabel,
  type ToolDisplayName,
  type TranscriptText,
} from "../src/domain.ts";
import { admitBoundedTranscriptJson } from "../src/schemas.ts";

function text(value: string): TranscriptText { return value as TranscriptText }
function tool(value: string): ToolDisplayName { return value as ToolDisplayName }
function json(value: Record<string, string>) {
  const admitted = admitBoundedTranscriptJson(value);
  if (admitted === undefined) throw new Error("test fixture JSON rejected");
  return admitted;
}
function textBlock(value: string): TranscriptAssistantBlock { return { kind: "text", phase: "final", text: text(value) } }
function thinkingBlock(value: string): TranscriptAssistantBlock { return { kind: "thinking", phase: "final", text: text(value) } }
function toolBlock(name: string, argumentsValue?: Record<string, string>, preview?: string): TranscriptAssistantBlock {
  return {
    kind: "tool",
    presentation: {
      tool: tool(name), phase: "completed",
      ...(argumentsValue === undefined ? {} : { arguments: json(argumentsValue) }),
      ...(preview === undefined ? {} : { preview: text(preview) }),
    },
  };
}
function userItem(index: number, nativeRun: string, value: string): TranscriptItem {
  return { sequence: transcriptSequence(index), runId: runId(nativeRun), kind: "user", text: text(value) };
}
function assistantItem(
  index: number,
  nativeRun: string | undefined,
  group: number,
  phase: "partial" | "final",
  stopReason: "toolUse" | undefined,
  blocks: readonly TranscriptAssistantBlock[],
): TranscriptItem {
  return {
    sequence: transcriptSequence(index), ...(nativeRun === undefined ? {} : { runId: runId(nativeRun) }),
    kind: "assistant", group: transcriptAssistantGroup(group), phase,
    ...(stopReason === undefined ? {} : { stopReason }), blocks,
  };
}
function selectedWith(
  items: readonly TranscriptItem[],
  options: {
    readonly renderingCwd?: string;
    readonly sensitiveValues?: { readonly nativeIds: ReadonlySet<string>; readonly managedPathsAndNames: ReadonlySet<string> };
  } = {},
): SelectedTranscriptSnapshot {
  const row: AgentRow = {
    ordinal: agentOrdinal("A1.2"), depth: agentDepth(1), model: "luna:h" as ModelLabel,
    context: "42%" as ContextLabel, taskLabel: "Research" as TaskLabel,
    state: AgentState.Running as AgentDisplayState,
  };
  return {
    revision: selectedTranscriptRevision(73),
    transcript: {
      revision: transcriptRevision(61), items, truncatedBefore: false, availability: "live",
      sensitiveValues: options.sensitiveValues ?? { nativeIds: new Set<string>(), managedPathsAndNames: new Set<string>() },
      ...(options.renderingCwd === undefined ? {} : { renderingCwd: options.renderingCwd as AbsolutePath }),
    },
    row, routeAvailable: true,
  };
}
function toolOf(projected: ReturnType<typeof projectConversationSnapshot>): ConversationToolPresentation {
  const turn = projected.turns[0];
  if (turn === undefined || turn.kind !== "assistant") throw new Error("test fixture has no assistant turn");
  const block = turn.blocks[0];
  if (block === undefined || block.kind !== "tool") throw new Error("test fixture has no tool block");
  return block.presentation;
}

describe("projectConversationSnapshot", () => {
  test("an assistant item becomes one turn preserving block order and stop reason", () => {
    const projected = projectConversationSnapshot(selectedWith([
      userItem(0, "aaaaaaaa", "Ask"),
      assistantItem(1, "aaaaaaaa", 0, "final", "toolUse", [
        thinkingBlock("plan"), textBlock("reading"), toolBlock("read", { file: "/home/child/a.ts" }, "line one"),
      ]),
    ], { renderingCwd: "/home/child" }));

    expect(projected.turns.map((turn) => turn.kind)).toEqual(["user", "assistant"]);
    const assistant = projected.turns[1] as Extract<ConversationTurn, { readonly kind: "assistant" }>;
    expect(assistant.blocks.map((block) => block.kind)).toEqual(["thinking", "text", "tool"]);
    expect(assistant.stopReason).toBe("toolUse");
  });

  test("synthetic keys are revision-local and carry no native identity", () => {
    const projected = projectConversationSnapshot(selectedWith([
      userItem(0, "aaaaaaaa", "Ask"),
      assistantItem(1, "aaaaaaaa", 0, "final", undefined, [toolBlock("read", { file: "/home/child/a.ts" })]),
    ]));
    const assistant = projected.turns[1] as Extract<ConversationTurn, { readonly kind: "assistant" }>;
    const toolBlockValue = assistant.blocks[0] as Extract<ConversationAssistantBlock, { readonly kind: "tool" }>;
    const serialised = JSON.stringify(projected);
    expect(String(toolBlockValue.presentation.callKey)).toBe(`c:${Number(projected.revision)}:1:0`);
    expect(serialised).not.toContain("aaaaaaaa");
    expect(serialised).not.toContain("call-1");
  });

  test.each([
    ["read", "native-built-in"], ["bash", "native-built-in"], ["edit", "native-built-in"],
    ["write", "native-built-in"], ["grep", "native-built-in"], ["find", "native-built-in"],
    ["ls", "native-built-in"], ["spawn_agent", "native-generic"], ["mcp__server__thing", "native-generic"],
  ] as const)("%s selects %s rendering when its data validates", (name, rendering) => {
    const projected = projectConversationSnapshot(selectedWith([
      assistantItem(0, undefined, 0, "final", undefined, [toolBlock(name, { file: "/home/child/a.ts" }, "ok")]),
    ], { renderingCwd: "/home/child" }));
    expect(toolOf(projected).rendering).toBe(rendering as ConversationToolRendering);
  });

  test.each([
    ["no working directory", {}, { file: "/home/child/a.ts" }],
    ["absent arguments", { renderingCwd: "/home/child" }, undefined],
  ] as const)("a recognised built-in falls back to the renderer override with %s", (_label, options, argumentsValue) => {
    const projected = projectConversationSnapshot(selectedWith([
      assistantItem(0, undefined, 0, "final", undefined, [toolBlock("read", argumentsValue, "ok")]),
    ], options));
    expect(toolOf(projected).rendering).toBe("renderer-override");
  });

  test("rich JSON containing a merged sensitive value is rejected whole and downgrades the rendering", () => {
    const projected = projectConversationSnapshot(selectedWith([
      assistantItem(0, undefined, 0, "final", undefined, [
        toolBlock("read", { file: "/state/pi-subagents/aaaaaaaa/sessions/child.jsonl" }, "ok"),
      ]),
    ], {
      renderingCwd: "/home/child",
      sensitiveValues: { nativeIds: new Set(["aaaaaaaa"]), managedPathsAndNames: new Set(["child.jsonl"]) },
    }));
    const projectedTool = toolOf(projected);
    expect(projectedTool.arguments).toBeUndefined();
    expect(projectedTool.rendering).toBe("renderer-override");
    expect(projectedTool.preview).toBeDefined();
  });

  test("a working directory inside a managed root or naming a sensitive value is refused", () => {
    const refused = projectConversationSnapshot(selectedWith([], {
      renderingCwd: "/state/pi-subagents/aaaaaaaa",
      sensitiveValues: { nativeIds: new Set(["aaaaaaaa"]), managedPathsAndNames: new Set(["/state/pi-subagents"]) },
    }));
    expect(refused.renderingCwd).toBeUndefined();
  });

  test("the header copies only presentation-safe row fields", () => {
    const projected = projectConversationSnapshot(selectedWith([]));
    expect(Object.keys(projected.header).sort()).toEqual(["context", "model", "ordinal", "state", "taskLabel"]);
  });
});
