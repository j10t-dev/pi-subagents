import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import {
  AssistantMessageComponent,
  getMarkdownTheme,
  initTheme,
  parseSkillBlock,
  SkillInvocationMessageComponent,
  Theme,
  ToolExecutionComponent,
  UserMessageComponent,
  type ThemeColor,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { Container, Spacer, Text, TUI, type Component, type Terminal } from "@earendil-works/pi-tui";
import { Type } from "typebox";

import type {
  AgentDisplayState,
  ConversationAssistantBlock,
  ConversationSnapshot,
  ConversationToolPresentation,
  ConversationTurn,
} from "../src/agent-observation.ts";
import {
  createPiConversationAdapter,
  stripShellIntegration,
  type PiConversationAdapterFactories,
} from "../src/agent-widget/conversation-native-adapter.ts";
import {
  AgentState,
  agentOrdinal,
  conversationCallKey,
  conversationRevision,
  conversationTurnKey,
  renderWidth,
  tryPresentationCwd,
  type ContextLabel,
  type ModelLabel,
  type PresentationCwd,
  type SafePresentationJson,
  type TaskLabel,
  type ToolDisplayName,
  type TranscriptText,
} from "../src/domain.ts";

class FakeTerminal implements Terminal {
  columns = 80;
  rows = 24;
  readonly kittyProtocolActive = false;
  start(_onInput: (data: string) => void, _onResize: () => void): void {}
  stop(): void {}
  async drainInput(_maxMs?: number, _idleMs?: number): Promise<void> {}
  write(_data: string): void {}
  moveBy(_lines: number): void {}
  hideCursor(): void {}
  showCursor(): void {}
  clearLine(): void {}
  clearFromCursor(): void {}
  clearScreen(): void {}
  setTitle(_title: string): void {}
  setProgress(_active: boolean): void {}
}

const foreground: Record<ThemeColor, string> = {
  accent: "#5577ff", border: "#777777", borderAccent: "#5577ff", borderMuted: "#555555",
  success: "#00aa00", error: "#dd0000", warning: "#aa7700", muted: "#777777", dim: "#555555",
  text: "#eeeeee", thinkingText: "#999999", userMessageText: "#ffffff", customMessageText: "#eeeeee",
  customMessageLabel: "#5577ff", toolTitle: "#55aaff", toolOutput: "#aaaaaa", mdHeading: "#ffffff",
  mdLink: "#5577ff", mdLinkUrl: "#777777", mdCode: "#ffaa55", mdCodeBlock: "#eeeeee",
  mdCodeBlockBorder: "#555555", mdQuote: "#aaaaaa", mdQuoteBorder: "#555555", mdHr: "#555555",
  mdListBullet: "#5577ff", toolDiffAdded: "#00aa00", toolDiffRemoved: "#dd0000", toolDiffContext: "#777777",
  syntaxComment: "#777777", syntaxKeyword: "#5577ff", syntaxFunction: "#55aaff", syntaxVariable: "#eeeeee",
  syntaxString: "#00aa00", syntaxNumber: "#ffaa55", syntaxType: "#55aaff", syntaxOperator: "#eeeeee",
  syntaxPunctuation: "#aaaaaa", thinkingOff: "#555555", thinkingMinimal: "#777777", thinkingLow: "#888888",
  thinkingMedium: "#999999", thinkingHigh: "#aaaaaa", thinkingXhigh: "#bbbbbb", thinkingMax: "#ffffff",
  bashMode: "#ffaa55",
};
const background = {
  selectedBg: "#222244", userMessageBg: "#222222", customMessageBg: "#222222",
  toolPendingBg: "#332200", toolSuccessBg: "#113311", toolErrorBg: "#331111",
};
const theme = new Theme(foreground, background, "truecolor");
const tui = new TUI(new FakeTerminal());
const WIDTH = 80;
const options = { thinkingVisible: true, toolsExpanded: false, width: renderWidth(WIDTH) };

beforeAll(() => { initTheme(undefined, false) });
afterAll(() => { tui.stop() });

function transcriptText(value: string): TranscriptText { return value as TranscriptText }
function toolName(value: string): ToolDisplayName { return value as ToolDisplayName }
function json(value: object): SafePresentationJson { return value as SafePresentationJson }
function presentationCwd(value: string): PresentationCwd {
  const cwd = tryPresentationCwd(value);
  if (cwd === undefined) throw new Error("invalid test presentation cwd");
  return cwd;
}

function referenceLines(children: readonly Component[]): string[] {
  return children.flatMap((child) => child.render(WIDTH)).map(stripShellIntegration);
}

function presentationMessage(
  content: AssistantMessage["content"],
  stopReason: AssistantMessage["stopReason"] = "stop",
): AssistantMessage {
  return {
    role: "assistant", content, api: "presentation", provider: "presentation", model: "presentation",
    usage: {
      input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason, timestamp: 0,
  };
}

function userTurn(value: string, index = 0): ConversationTurn {
  return { key: conversationTurnKey(conversationRevision(1), index), kind: "user", text: transcriptText(value) };
}
function textBlock(value: string): ConversationAssistantBlock { return { kind: "text", text: transcriptText(value) } }
function thinkingBlock(value: string): ConversationAssistantBlock { return { kind: "thinking", text: transcriptText(value) } }
function toolPresentation(
  tool: string,
  rendering: ConversationToolPresentation["rendering"],
  overrides: Partial<ConversationToolPresentation> = {},
): ConversationToolPresentation {
  return {
    callKey: conversationCallKey(conversationRevision(1), 0, 1), tool: toolName(tool), phase: "completed",
    arguments: json(tool === "read" ? { path: "/home/child/a.ts" } : { value: "fixture" }),
    result: { content: [transcriptText("line one")], isError: false }, rendering, ...overrides,
  };
}
function assistantTurn(
  blocks: readonly ConversationAssistantBlock[],
  stopReason: Extract<ConversationTurn, { kind: "assistant" }>["stopReason"] = "stop",
): ConversationTurn {
  return { key: conversationTurnKey(conversationRevision(1), 0), kind: "assistant", phase: "final", stopReason, blocks };
}
function snapshotWith(turns: readonly ConversationTurn[], overrides: Partial<ConversationSnapshot> = {}): ConversationSnapshot {
  return Object.freeze({
    revision: conversationRevision(1), turns: Object.freeze(turns), truncatedBefore: false, availability: "live",
    header: Object.freeze({
      ordinal: agentOrdinal("A1"), model: "luna:h" as ModelLabel, context: "42%" as ContextLabel,
      taskLabel: "Task" as TaskLabel, state: AgentState.Running as AgentDisplayState,
    }),
    routeAvailable: true, ...overrides,
  });
}
function builtInSnapshot(overrides: { readonly revision?: number; readonly stopReason?: "aborted" | "error" } = {}): ConversationSnapshot {
  const presentation = toolPresentation("read", "native-built-in");
  return snapshotWith([assistantTurn([textBlock("Reading"), { kind: "tool", presentation }], overrides.stopReason ?? "toolUse")], {
    revision: conversationRevision(overrides.revision ?? 1), renderingCwd: presentationCwd("/home/child"),
  });
}
function snapshotFor(tool: string, rendering: ConversationToolPresentation["rendering"]): ConversationSnapshot {
  return snapshotWith([assistantTurn([{ kind: "tool", presentation: toolPresentation(tool, rendering) }], "toolUse")], {
    renderingCwd: presentationCwd("/home/child"),
  });
}

function genericSnapshot(cwd?: PresentationCwd): ConversationSnapshot {
  return snapshotWith([
    assistantTurn([{ kind: "tool", presentation: toolPresentation("custom_lookup", "native-generic") }], "toolUse"),
  ], cwd === undefined ? {} : { renderingCwd: cwd });
}

function referenceToolContainer(tool: ToolExecutionComponent, message: AssistantMessage): Container {
  const reference = new Container();
  reference.addChild(new AssistantMessageComponent(message, false, getMarkdownTheme(), "Thinking...", 1));
  tool.setExpanded(false);
  tool.setArgsComplete();
  tool.updateResult({ content: [{ type: "text", text: "line one" }], isError: false });
  reference.addChild(tool);
  return reference;
}

function independentFallbackDefinition(): ToolDefinition {
  return {
    name: "read",
    label: "read",
    description: "Independent read-only presentation fixture",
    parameters: Type.Object({}, { additionalProperties: true }),
    execute: () => Promise.reject(new Error("not executable")),
    renderCall: () => new Text(theme.fg("toolTitle", "read"), 1, 0),
    renderResult: (_result, _renderOptions, _renderTheme, context) => new Text(
      theme.fg(context.isError ? "error" : "toolOutput", context.isError
        ? "Result unavailable for native rendering"
        : "Result shown in bounded form"),
      1,
      0,
    ),
  };
}

describe("native Pi conversation adapter", () => {
  test("a plain user turn matches a native user component", () => {
    const adapter = createPiConversationAdapter({ tui, theme });
    expect(adapter.render(snapshotWith([userTurn("Hello **world**")]), options)).toEqual(
      referenceLines([new UserMessageComponent("Hello **world**", getMarkdownTheme(), 1)]),
    );
  });

  test("a recognised skill invocation matches Pi core composition order", () => {
    const value = '<skill name="audit" location="/skills/audit/SKILL.md">\nAudit carefully\n</skill>\n\nCheck this change';
    const parsed = parseSkillBlock(value);
    expect(parsed).not.toBeNull();
    const skill = new SkillInvocationMessageComponent(parsed!, getMarkdownTheme());
    skill.setExpanded(false);
    const reference = new Container();
    reference.addChild(skill);
    reference.addChild(new Spacer(1));
    reference.addChild(new UserMessageComponent("Check this change", getMarkdownTheme(), 1));
    const adapter = createPiConversationAdapter({ tui, theme });
    expect(adapter.render(snapshotWith([userTurn(value)]), options)).toEqual(referenceLines([reference]));
  });

  test("assistant text and thinking visibility match the native assistant component", () => {
    const message = presentationMessage([
      { type: "thinking", thinking: "planning" }, { type: "text", text: "Answer" },
    ]);
    for (const thinkingVisible of [true, false]) {
      const adapter = createPiConversationAdapter({ tui, theme });
      const reference = new AssistantMessageComponent(message, !thinkingVisible, getMarkdownTheme(), "Thinking...", 1);
      expect(adapter.render(snapshotWith([assistantTurn([thinkingBlock("planning"), textBlock("Answer")])]), {
        ...options, thinkingVisible,
      })).toEqual(referenceLines([reference]));
    }
  });

  test("a built-in tool matches independently composed native components", () => {
    const message = presentationMessage([
      { type: "text", text: "Reading" },
      { type: "toolCall", id: "c:1:0:1", name: "read", arguments: { path: "/home/child/a.ts" } },
    ], "toolUse");
    const reference = new Container();
    reference.addChild(new AssistantMessageComponent(message, false, getMarkdownTheme(), "Thinking...", 1));
    const tool = new ToolExecutionComponent("read", "c:1:0:1", { path: "/home/child/a.ts" }, { showImages: false }, undefined, tui, "/home/child");
    tool.setExpanded(false);
    tool.setArgsComplete();
    tool.updateResult({ content: [{ type: "text", text: "line one" }], isError: false });
    reference.addChild(tool);
    const adapter = createPiConversationAdapter({ tui, theme });
    expect(adapter.render(builtInSnapshot(), options)).toEqual(referenceLines([reference]));
  });

  test.each([undefined, presentationCwd("/home/child")] as const)(
    "a native-generic tool with cwd %s matches a directly composed public ToolExecutionComponent",
    (cwd) => {
      const message = presentationMessage([
        { type: "toolCall", id: "c:1:0:1", name: "custom_lookup", arguments: { value: "fixture" } },
      ], "toolUse");
      const tool = new ToolExecutionComponent(
        "custom_lookup",
        "c:1:0:1",
        { value: "fixture" },
        { showImages: false },
        undefined,
        tui,
        cwd === undefined ? "" : String(cwd),
      );
      const reference = referenceToolContainer(tool, message);

      expect(createPiConversationAdapter({ tui, theme }).render(genericSnapshot(cwd), options)).toEqual(
        referenceLines([reference]),
      );
    },
  );

  test("a renderer override matches a directly composed public tool with an independent definition", () => {
    const message = presentationMessage([
      { type: "toolCall", id: "c:1:0:1", name: "read", arguments: { path: "/home/child/a.ts" } },
    ], "toolUse");
    const tool = new ToolExecutionComponent(
      "read",
      "c:1:0:1",
      { path: "/home/child/a.ts" },
      { showImages: false },
      independentFallbackDefinition(),
      tui,
      "/home/child",
    );
    const reference = referenceToolContainer(tool, message);

    expect(createPiConversationAdapter({ tui, theme }).render(snapshotFor("read", "renderer-override"), options)).toEqual(
      referenceLines([reference]),
    );
  });

  test.each(["read", "bash", "edit", "write", "grep", "find", "ls"])(
    "%s uses its built-in renderer rather than the same-name fallback renderer",
    (tool) => {
      const nativeAdapter = createPiConversationAdapter({ tui, theme });
      const fallbackAdapter = createPiConversationAdapter({ tui, theme });
      expect(nativeAdapter.render(snapshotFor(tool, "native-built-in"), options).join("\n")).not.toBe(
        fallbackAdapter.render(snapshotFor(tool, "renderer-override"), options).join("\n"),
      );
    },
  );

  test("a renderer override keeps Pi's shell without exposing built-in arguments", () => {
    const adapter = createPiConversationAdapter({ tui, theme });
    const body = Bun.stripANSI(adapter.render(snapshotFor("read", "renderer-override"), options).join("\n"));
    expect(body).toContain("read");
    expect(body).not.toContain("/home/child/a.ts");
  });

  test("aborted and errored turns inject an error result into each tool card", () => {
    for (const stopReason of ["aborted", "error"] as const) {
      const adapter = createPiConversationAdapter({ tui, theme });
      const body = Bun.stripANSI(adapter.render(builtInSnapshot({ stopReason }), options).join("\n")).toLowerCase();
      expect(body).toContain(stopReason === "aborted" ? "aborted" : "error");
    }
  });

  test("removes 7-bit and C1 OSC 133 forms with every terminator and preserves trailing styling", () => {
    const sgr = "\u001b[31mred\u001b[0m";
    const osc8 = "\u001b]8;;https://example.test\u0007link\u001b]8;;\u0007";
    const input = [
      "a\u001b]133;A\u0007",
      "b\u009d133;B;payload\u001b\\",
      "c\u001b]133;C;payload\u009c",
      "d\u009d133;D;0;payload\u0007",
      `e${sgr}${osc8}f`,
    ].join("");

    expect(stripShellIntegration(input)).toBe(`abcde${sgr}${osc8}f`);
  });

  test("fails closed for unterminated 7-bit and C1 OSC 133 forms", () => {
    expect(stripShellIntegration("before\u001b]133;Z;unterminated secret")).toBe("before");
    expect(stripShellIntegration("before\u009d133;;payload unterminated secret")).toBe("before");
  });

  test("rendered output contains no OSC 133 sequence at any width", () => {
    const adapter = createPiConversationAdapter({ tui, theme });
    const poisoned = snapshotWith([userTurn("safe\u001b]133;D;payload\u0007text")]);
    for (const width of [20, 40, 80, 200]) {
      expect(adapter.render(poisoned, { ...options, width: renderWidth(width) }).join("\n")).not.toContain("\u001b]133;");
    }
  });

  test("toggles and width changes update components in place; revisions and invalidation rebuild", () => {
    const adapter = createPiConversationAdapter({ tui, theme });
    const snapshot = builtInSnapshot();
    adapter.render(snapshot, options);
    const first = adapter.constructionCount;
    adapter.render(snapshot, { ...options, toolsExpanded: true, width: renderWidth(60) });
    expect(adapter.constructionCount).toBe(first);
    adapter.render(builtInSnapshot({ revision: 2 }), options);
    expect(adapter.constructionCount).toBeGreaterThan(first);
    const rebuilt = adapter.constructionCount;
    adapter.invalidate();
    adapter.render(snapshot, options);
    expect(adapter.constructionCount).toBeGreaterThan(rebuilt);
  });

  test("image blocks never reach ToolExecutionComponent.updateResult", () => {
    const original = ToolExecutionComponent.prototype.updateResult;
    const observed: Parameters<ToolExecutionComponent["updateResult"]>[0][] = [];
    ToolExecutionComponent.prototype.updateResult = function (result, isPartial): void {
      observed.push(result);
      original.call(this, result, isPartial);
    };
    try {
      createPiConversationAdapter({ tui, theme }).render(builtInSnapshot(), options);
      expect(observed.length).toBeGreaterThan(0);
      expect(observed.flatMap((result) => result.content).every((block) => block.type === "text")).toBe(true);
    } finally {
      ToolExecutionComponent.prototype.updateResult = original;
    }
  });

  test.each([
    ["skill parsing", { parseSkillBlock: () => { throw new Error("parse fault"); } }],
    ["message construction", { createUserMessage: () => { throw new Error("user constructor fault"); } }],
  ] as const)("%s failure degrades only the affected turn during construction", (_label, factories) => {
    const turns: readonly ConversationTurn[] = [
      { key: conversationTurnKey(conversationRevision(1), 0), kind: "notice", code: "context-compacted" },
      userTurn("poison", 1),
      { key: conversationTurnKey(conversationRevision(1), 2), kind: "notice", code: "transport-unavailable" },
    ];
    const body = Bun.stripANSI(createPiConversationAdapter({
      tui, theme, factories: factories as Partial<PiConversationAdapterFactories>,
    }).render(snapshotWith(turns), options).join("\n"));
    expect(body).toContain("Context compacted");
    expect(body).toContain("Item unavailable");
    expect(body).toContain("Transport unavailable");
  });

  test.each(["tool definition", "tool component", "tool state"] as const)(
    "%s failure degrades only the affected tool while sibling turns remain",
    (failure) => {
      const factories: Partial<PiConversationAdapterFactories> = failure === "tool definition"
        ? { createPresentationToolDefinition: () => { throw new Error("definition fault"); } }
        : failure === "tool component"
          ? { createToolExecution: () => { throw new Error("tool constructor fault"); } }
          : { createToolExecution: (...args) => {
            const component = new ToolExecutionComponent(...args);
            component.setArgsComplete = () => { throw new Error("state fault"); };
            return component;
          } };
      const poison = toolPresentation("read", "renderer-override");
      const turns: readonly ConversationTurn[] = [
        { key: conversationTurnKey(conversationRevision(1), 0), kind: "notice", code: "context-compacted" },
        assistantTurn([{ kind: "tool", presentation: poison }], "toolUse"),
        { key: conversationTurnKey(conversationRevision(1), 2), kind: "notice", code: "transport-unavailable" },
      ];
      const body = Bun.stripANSI(createPiConversationAdapter({ tui, theme, factories }).render(snapshotWith(turns, {
        renderingCwd: presentationCwd("/home/child"),
      }), options).join("\n"));
      expect(body).toContain("Context compacted");
      expect(body).toContain("Item unavailable");
      expect(body).toContain("Transport unavailable");
    },
  );

  test.each(["assistant", "skill", "tool"] as const)(
    "%s in-place updater failure replaces only its item and remains contained on subsequent renders",
    (kind) => {
      const factories: Partial<PiConversationAdapterFactories> = kind === "assistant"
        ? { createAssistantMessage: (...args) => {
          const component = new AssistantMessageComponent(...args);
          component.setHideThinkingBlock = () => { throw new Error("assistant toggle fault"); };
          return component;
        } }
        : kind === "skill"
          ? { createSkillInvocation: (...args) => {
            const component = new SkillInvocationMessageComponent(...args);
            component.setExpanded = () => { throw new Error("skill toggle fault"); };
            return component;
          } }
          : { createToolExecution: (...args) => {
            const component = new ToolExecutionComponent(...args);
            component.setExpanded = () => { throw new Error("tool toggle fault"); };
            return component;
          } };
      const affected = kind === "assistant"
        ? assistantTurn([textBlock("assistant poison")])
        : kind === "skill"
          ? userTurn('<skill name="audit" location="/skills/audit/SKILL.md">\nAudit\n</skill>\n\nCheck')
          : assistantTurn([{ kind: "tool", presentation: toolPresentation("read", "native-built-in") }], "toolUse");
      const snapshot = snapshotWith([
        { key: conversationTurnKey(conversationRevision(1), 0), kind: "notice", code: "context-compacted" },
        affected,
        { key: conversationTurnKey(conversationRevision(1), 2), kind: "notice", code: "transport-unavailable" },
      ], { renderingCwd: presentationCwd("/home/child") });
      const adapter = createPiConversationAdapter({ tui, theme, factories });

      for (const renderOptions of [options, { ...options, thinkingVisible: false, toolsExpanded: true }]) {
        const body = Bun.stripANSI(adapter.render(snapshot, renderOptions).join("\n"));
        expect(body).toContain("Context compacted");
        expect(body).toContain("Item unavailable");
        expect(body).toContain("Transport unavailable");
      }
    },
  );

  test("one native component render failure degrades only that item", () => {
    const original = UserMessageComponent.prototype.render;
    UserMessageComponent.prototype.render = function (_width: number): string[] { throw new Error("poison") };
    try {
      const turns: readonly ConversationTurn[] = [
        { key: conversationTurnKey(conversationRevision(1), 0), kind: "notice", code: "context-compacted" },
        userTurn("poison", 1),
        { key: conversationTurnKey(conversationRevision(1), 2), kind: "notice", code: "transport-unavailable" },
      ];
      const body = Bun.stripANSI(createPiConversationAdapter({ tui, theme }).render(snapshotWith(turns), options).join("\n"));
      expect(body).toContain("Context compacted");
      expect(body).toContain("Item unavailable");
      expect(body).toContain("Transport unavailable");
    } finally {
      UserMessageComponent.prototype.render = original;
    }
  });

  test("dispose is idempotent and prevents retained components from rendering", () => {
    const adapter = createPiConversationAdapter({ tui, theme });
    adapter.render(builtInSnapshot(), options);
    adapter.dispose();
    adapter.dispose();
    expect(adapter.render(builtInSnapshot(), options)).toEqual([]);
  });
});
