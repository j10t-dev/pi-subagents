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
function json(value: unknown) {
  const admitted = admitBoundedTranscriptJson(value);
  if (admitted === undefined) throw new Error("test fixture JSON rejected");
  return admitted;
}
function textBlock(value: string): TranscriptAssistantBlock { return { kind: "text", phase: "final", text: text(value) } }
function thinkingBlock(value: string): TranscriptAssistantBlock { return { kind: "thinking", phase: "final", text: text(value) } }
function toolBlock(
  name: string,
  argumentsValue?: unknown,
  preview?: string,
  result?: { readonly content: readonly string[]; readonly details?: unknown; readonly isError?: boolean },
): TranscriptAssistantBlock {
  return {
    kind: "tool",
    presentation: {
      tool: tool(name), phase: "completed",
      ...(argumentsValue === undefined ? {} : { arguments: json(argumentsValue) }),
      ...(preview === undefined ? {} : { preview: text(preview) }),
      ...(result === undefined ? {} : { result: {
        content: result.content.map(text),
        ...(result.details === undefined ? {} : { details: json(result.details) }),
        isError: result.isError ?? false,
      } }),
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
    readonly sensitiveValues?: { readonly nativeIds: ReadonlySet<string>; readonly managedPathsAndNames: ReadonlySet<string>; readonly overflowed: boolean };
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
      sensitiveValues: options.sensitiveValues ?? { nativeIds: new Set<string>(), managedPathsAndNames: new Set<string>(), overflowed: false },
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

function validArguments(name: string): unknown {
  switch (name) {
    case "read": return { path: "/home/child/a.ts" };
    case "bash": return { command: "printf ok" };
    case "edit": return { path: "/home/child/a.ts", edits: [{ oldText: "a", newText: "b" }] };
    case "write": return { path: "/home/child/a.ts", content: "text" };
    case "grep": return { pattern: "todo" };
    case "find": return { pattern: "*.ts" };
    case "ls": return {};
    default: throw new Error("unknown built-in fixture");
  }
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
    ["read", { path: "/home/child/a.ts" }, undefined],
    ["bash", { command: "printf ok" }, { fullOutputPath: "/home/child/bash.log" }],
    ["edit", { path: "/home/child/a.ts", edits: [{ oldText: "a", newText: "b" }] }, { diff: "-a +b", patch: "patch" }],
    ["write", { path: "/home/child/a.ts", content: "text" }, undefined],
    ["grep", { pattern: "todo" }, { matchLimitReached: 4, linesTruncated: false }],
    ["find", { pattern: "*.ts" }, { resultLimitReached: 4 }],
    ["ls", {}, { entryLimitReached: 4 }],
  ] as const)("%s selects native built-in rendering for compatible public presentation data", (name, argumentsValue, details) => {
    const projected = projectConversationSnapshot(selectedWith([
      assistantItem(0, undefined, 0, "final", undefined, [toolBlock(name, argumentsValue, "ok", {
        content: ["ok"], ...(details === undefined ? {} : { details }),
      })]),
    ], { renderingCwd: "/home/child" }));
    expect(toolOf(projected).rendering).toBe("native-built-in" as ConversationToolRendering);
  });

  test.each(["spawn_agent", "mcp__server__thing"])("%s selects native generic rendering", (name) => {
    const projected = projectConversationSnapshot(selectedWith([
      assistantItem(0, undefined, 0, "final", undefined, [toolBlock(name, { value: "safe" }, "ok")]),
    ], { renderingCwd: "/home/child" }));
    expect(toolOf(projected).rendering).toBe("native-generic");
  });

  test.each([
    ["read", { offset: 1 }],
    ["bash", { timeout: 1 }],
    ["edit", { path: "/home/child/a.ts", edits: [{ oldText: "a" }] }],
    ["write", { path: "/home/child/a.ts" }],
    ["grep", { path: "/home/child" }],
    ["find", { limit: 4 }],
    ["ls", { limit: "many" }],
  ] as const)("%s selects renderer override for incompatible arguments", (name, argumentsValue) => {
    const projected = projectConversationSnapshot(selectedWith([
      assistantItem(0, undefined, 0, "final", undefined, [toolBlock(name, argumentsValue, "ok", { content: ["ok"] })]),
    ], { renderingCwd: "/home/child" }));
    expect(toolOf(projected).rendering).toBe("renderer-override");
  });

  test.each([
    ["read", { truncation: { truncated: "yes" } }],
    ["bash", { fullOutputPath: 3 }],
    ["edit", { diff: "only" }],
    ["write", { unexpected: true }],
    ["grep", { linesTruncated: "yes" }],
    ["find", { resultLimitReached: "many" }],
    ["ls", { entryLimitReached: "many" }],
  ] as const)("%s selects renderer override for incompatible admitted details", (name, details) => {
    const projected = projectConversationSnapshot(selectedWith([
      assistantItem(0, undefined, 0, "final", undefined, [toolBlock(name, validArguments(name), "ok", { content: ["ok"], details })]),
    ], { renderingCwd: "/home/child" }));
    expect(toolOf(projected).rendering).toBe("renderer-override");
  });

  test.each(["read", "bash", "edit", "write", "grep", "find", "ls"])(
    "%s selects renderer override when a completed result is missing or empty",
    (name) => {
      for (const result of [undefined, { content: [] as string[] }]) {
        const projected = projectConversationSnapshot(selectedWith([
          assistantItem(0, undefined, 0, "final", undefined, [toolBlock(name, validArguments(name), "ok", result)]),
        ], { renderingCwd: "/home/child" }));
        expect(toolOf(projected).rendering).toBe("renderer-override");
      }
    },
  );

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
      sensitiveValues: { nativeIds: new Set(["aaaaaaaa"]), managedPathsAndNames: new Set(["child.jsonl"]), overflowed: false },
    }));
    const projectedTool = toolOf(projected);
    expect(projectedTool.arguments).toBeUndefined();
    expect(projectedTool.rendering).toBe("renderer-override");
    expect(projectedTool.preview).toBeDefined();
  });

  test("rejected built-in details select renderer override rather than reaching a native renderer", () => {
    const projected = projectConversationSnapshot(selectedWith([
      assistantItem(0, undefined, 0, "final", undefined, [toolBlock("read", { path: "/home/child/a.ts" }, "ok", {
        content: ["ok"], details: { source: "entry-cross-source" },
      })]),
    ], {
      renderingCwd: "/home/child",
      sensitiveValues: { nativeIds: new Set(["entry-cross-source"]), managedPathsAndNames: new Set(), overflowed: false },
    }));
    const presentation = toolOf(projected);
    expect(presentation.result?.details).toBeUndefined();
    expect(presentation.rendering).toBe("renderer-override");
  });

  test.each([
    ["tool-call ID", "call-cross-source", "nativeIds"],
    ["agent ID", "agent-cross-source", "nativeIds"],
    ["run ID", "run-cross-source", "nativeIds"],
    ["managed path", "/state/pi-subagents/managed", "managedPathsAndNames"],
  ] as const)("omits whole rich and text values containing a cross-source %s", (_label, sensitiveValue, setName) => {
    const sensitiveValues = {
      nativeIds: new Set<string>(), managedPathsAndNames: new Set<string>(), overflowed: false,
    };
    sensitiveValues[setName].add(sensitiveValue);
    const projected = projectConversationSnapshot(selectedWith([
      assistantItem(0, undefined, 0, "final", undefined, [toolBlock("read", {
        path: `/home/child/${sensitiveValue}/argument`,
      }, `preview ${sensitiveValue} suffix`, {
        content: ["safe result", `result ${sensitiveValue} suffix`],
        details: { source: `detail ${sensitiveValue} suffix` },
      })]),
    ], { renderingCwd: "/home/child", sensitiveValues }));
    const presentation = toolOf(projected);
    expect(presentation.arguments).toBeUndefined();
    expect(presentation.result?.details).toBeUndefined();
    expect(presentation.result?.content).toEqual([text("safe result")]);
    expect(presentation.preview).toBeUndefined();
    expect(JSON.stringify(projected)).not.toContain(sensitiveValue);
  });

  test("sensitive-history overflow suppresses every rich tool field and downgrades built-ins", () => {
    const projected = projectConversationSnapshot(selectedWith([
      assistantItem(0, undefined, 0, "final", undefined, [toolBlock("read", { path: "/home/child/safe.ts" }, "safe preview", {
        content: ["safe result"], details: { source: "safe detail" },
      })]),
      assistantItem(1, undefined, 1, "final", undefined, [toolBlock("extension_tool", { value: "safe" }, "safe generic preview", {
        content: ["safe generic result"], details: { source: "safe generic detail" },
      })]),
    ], {
      renderingCwd: "/home/child",
      sensitiveValues: { nativeIds: new Set(), managedPathsAndNames: new Set(), overflowed: true },
    }));

    for (const turn of projected.turns) {
      if (turn.kind !== "assistant") continue;
      const presentation = (turn.blocks[0] as Extract<ConversationAssistantBlock, { readonly kind: "tool" }>).presentation;
      expect(presentation.arguments).toBeUndefined();
      expect(presentation.result).toBeUndefined();
      expect(presentation.preview).toBeUndefined();
      expect(presentation.rendering).toBe("renderer-override");
    }
  });

  test("a working directory inside a managed root or naming a sensitive value is refused", () => {
    const refused = projectConversationSnapshot(selectedWith([], {
      renderingCwd: "/state/pi-subagents/aaaaaaaa",
      sensitiveValues: { nativeIds: new Set(["aaaaaaaa"]), managedPathsAndNames: new Set(["/state/pi-subagents"]), overflowed: false },
    }));
    expect(refused.renderingCwd).toBeUndefined();
  });

  test("the header copies only presentation-safe row fields", () => {
    const projected = projectConversationSnapshot(selectedWith([]));
    expect(Object.keys(projected.header).sort()).toEqual(["context", "model", "ordinal", "state", "taskLabel"]);
  });
});
