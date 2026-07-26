import { describe, expect, test } from "bun:test";
import { initTheme, Theme, type ThemeColor } from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";

import type { AgentDisplayState, ConversationAssistantBlock, ConversationSnapshot, ConversationTurn } from "../src/agent-observation.ts";
import { createChildConversationModel, toggleConversationThinking, toggleConversationTools } from "../src/agent-widget/conversation-model.ts";
import { renderChildConversation } from "../src/agent-widget/conversation-render.ts";
import {
  AgentState, agentOrdinal, conversationCallKey, conversationRevision, conversationTurnKey, renderWidth, terminalRows,
  type ContextLabel, type ModelLabel, type TaskLabel, type ToolDisplayName, type TranscriptText,
} from "../src/domain.ts";

const foreground: Record<ThemeColor, string> = {
  accent: "#5577ff",
  border: "#777777",
  borderAccent: "#5577ff",
  borderMuted: "#555555",
  success: "#00aa00",
  error: "#dd0000",
  warning: "#aa7700",
  muted: "#777777",
  dim: "#555555",
  text: "#eeeeee",
  thinkingText: "#999999",
  userMessageText: "#ffffff",
  customMessageText: "#eeeeee",
  customMessageLabel: "#5577ff",
  toolTitle: "#55aaff",
  toolOutput: "#aaaaaa",
  mdHeading: "#ffffff",
  mdLink: "#5577ff",
  mdLinkUrl: "#777777",
  mdCode: "#ffaa55",
  mdCodeBlock: "#eeeeee",
  mdCodeBlockBorder: "#555555",
  mdQuote: "#aaaaaa",
  mdQuoteBorder: "#555555",
  mdHr: "#555555",
  mdListBullet: "#5577ff",
  toolDiffAdded: "#00aa00",
  toolDiffRemoved: "#dd0000",
  toolDiffContext: "#777777",
  syntaxComment: "#777777",
  syntaxKeyword: "#5577ff",
  syntaxFunction: "#55aaff",
  syntaxVariable: "#eeeeee",
  syntaxString: "#00aa00",
  syntaxNumber: "#ffaa55",
  syntaxType: "#55aaff",
  syntaxOperator: "#eeeeee",
  syntaxPunctuation: "#aaaaaa",
  thinkingOff: "#555555",
  thinkingMinimal: "#777777",
  thinkingLow: "#888888",
  thinkingMedium: "#999999",
  thinkingHigh: "#aaaaaa",
  thinkingXhigh: "#bbbbbb",
  thinkingMax: "#ffffff",
  bashMode: "#ffaa55",
};
const background = { selectedBg: "#222244", userMessageBg: "#222222", customMessageBg: "#222222", toolPendingBg: "#332200", toolSuccessBg: "#113311", toolErrorBg: "#331111" };
initTheme(undefined, false);
const theme = new Theme(foreground, background, "truecolor");
const OSC_133_A = "\u001b]133;A\u0007";
const OSC_133_B = "\u001b]133;B;payload\u001b\\";
const OSC_133_C = "\u001b]133;C;payload\u0007";
const OSC_133_D = "\u001b]133;D;0;payload\u001b\\";
const UNTERMINATED_OSC_133 = "\u001b]133;D;unterminated";
const OSC_8_OPEN = "\u001b]8;;https://example.test\u0007";
const OSC_8_CLOSE = "\u001b]8;;\u0007";

function text(value: string): TranscriptText { return value as TranscriptText }

function block(kind: "text" | "thinking", value: string): ConversationAssistantBlock {
  return { kind, text: text(value) };
}

function toolBlock(
  name: string,
  phase: "running" | "completed" | "failed",
  preview?: string,
): ConversationAssistantBlock {
  return {
    kind: "tool",
    presentation: {
      callKey: conversationCallKey(conversationRevision(1), 0, 0),
      tool: name as ToolDisplayName,
      phase,
      rendering: "renderer-override",
      ...(preview === undefined ? {} : { preview: text(preview) }),
    },
  };
}

function assistantTurn(index: number, blocks: readonly ConversationAssistantBlock[]): ConversationTurn {
  return {
    key: conversationTurnKey(conversationRevision(1), index),
    kind: "assistant",
    phase: "partial",
    blocks,
  };
}
function snapshotWith(turns: readonly ConversationTurn[], options: Partial<ConversationSnapshot> = {}): ConversationSnapshot {
  return Object.freeze({
    revision: conversationRevision(1),
    turns: Object.freeze(turns),
    truncatedBefore: true,
    availability: "live",
    header: Object.freeze({
      ordinal: agentOrdinal("A1.2"),
      model: "luna:h" as ModelLabel,
      context: "42%" as ContextLabel,
      taskLabel: "Research terminal UX ".repeat(20) as TaskLabel,
      state: AgentState.Running as AgentDisplayState,
    }),
    routeAvailable: true,
    ...options,
  });
}
function snapshot(options: Partial<ConversationSnapshot> = {}): ConversationSnapshot {
  const revision = conversationRevision(1);
  return snapshotWith([
    { key: conversationTurnKey(revision, 0), kind: "user", text: text("ASCII question 界 e\u0301") },
    assistantTurn(1, [
      block("thinking", "considering options"),
      block("text", "## Answer\n\n**Markdown** response 界"),
      toolBlock("read", "running", "first preview line\nsecond preview line"),
      toolBlock("write", "completed"),
      toolBlock("bash", "failed"),
    ]),
    { key: conversationTurnKey(revision, 2), kind: "notice", code: "context-compacted" },
    { key: conversationTurnKey(revision, 3), kind: "notice", code: "transport-unavailable" },
    { key: conversationTurnKey(revision, 4), kind: "notice", code: "projection-unavailable" },
  ], options);
}

describe("renderChildConversation", () => {
  test("renders the complete Pi-styled grammar and local visibility states", () => {
    let model = createChildConversationModel(snapshot());
    model = toggleConversationTools(model);
    const rendered = renderChildConversation(model, theme, renderWidth(160), terminalRows(40));
    const plain = Bun.stripANSI(rendered.lines.join("\n"));
    const expected = [
      "A1.2 · luna:h · 42% · running",
      "Research terminal UX",
      "Live conversation",
      "Earlier source history omitted",
      "You · ASCII question 界 é",
      "Thinking · considering options",
      "Answer",
      "Tool · read · running",
      "first preview line",
      "Tool · write · completed",
      "Tool · bash · failed",
      "Context compacted",
      "Transport unavailable",
      "Projection unavailable",
      "following · ↑/↓ line · PgUp/PgDn page · g/G top/tail · Ctrl+T thinking · Ctrl+O tools · Esc close",
    ];
    for (const value of expected) expect(plain).toContain(value);
    model = toggleConversationThinking(model);
    expect(Bun.stripANSI(renderChildConversation(model, theme, renderWidth(160), terminalRows(40)).lines.join("\n"))).not.toContain("considering options");
  });

  test("removes terminated and malformed OSC 133 family sequences before transcript layout", () => {
    const rendered = renderChildConversation(
      createChildConversationModel(snapshotWith([
        {
          key: conversationTurnKey(conversationRevision(1), 0),
          kind: "user",
          text: text(`user${OSC_133_A}${OSC_133_D}${OSC_8_OPEN}link${OSC_8_CLOSE} message`),
        },
        assistantTurn(1, [
          block("thinking", `thinking${OSC_133_B} message`),
          block("text", `assistant${OSC_133_C} message`),
          toolBlock("read", "completed", `preview${OSC_133_A}${OSC_133_B}${OSC_133_C}${OSC_133_D} message`),
          block("text", `malformed${UNTERMINATED_OSC_133}`),
        ]),
      ])),
      theme,
      renderWidth(12),
      terminalRows(24),
    );
    const transcript = rendered.transcriptLines.join("\n");
    const renderedLines = rendered.lines.join("\n");

    for (const sequence of [OSC_133_A, OSC_133_B, OSC_133_C, OSC_133_D]) {
      expect(transcript).not.toContain(sequence);
    }
    expect(transcript).not.toContain("\u001b]133;");
    expect(renderedLines).not.toContain("\u001b]133;");
    expect(transcript).toContain(OSC_8_OPEN);
    expect(transcript).toContain(OSC_8_CLOSE);
  });

  test.each([
    {
      path: "user text",
      turns: [{
        key: conversationTurnKey(conversationRevision(1), 0),
        kind: "user" as const,
        text: text(`user${UNTERMINATED_OSC_133}`),
      }],
      expandTools: false,
      expected: theme.fg("userMessageText", "You · user"),
    },
    {
      path: "thinking text",
      turns: [assistantTurn(0, [block("thinking", `thinking${UNTERMINATED_OSC_133}`)])],
      expandTools: false,
      expected: theme.fg("thinkingText", "Thinking · thinking"),
    },
    {
      path: "tool-preview text",
      turns: [assistantTurn(0, [toolBlock("read", "completed", `preview${UNTERMINATED_OSC_133}`)])],
      expandTools: true,
      expected: theme.fg("toolOutput", "preview"),
    },
  ])("preserves renderer-owned style boundaries after malformed OSC 133 in $path", ({ turns, expandTools, expected }) => {
    let model = createChildConversationModel(snapshotWith(turns, { truncatedBefore: false }));
    if (expandTools) model = toggleConversationTools(model);

    const transcript = renderChildConversation(model, theme, renderWidth(80), terminalRows(24)).transcriptLines;

    expect(transcript).toContain(expected);
    expect(transcript.join("\n")).not.toContain("\u001b]133;");
  });

  test("an assistant turn renders its blocks in source order with tools after their turn text", () => {
    const rendered = renderChildConversation(createChildConversationModel(snapshotWith([
      assistantTurn(0, [block("thinking", "plan"), block("text", "reading"), toolBlock("read", "completed")]),
    ])), theme, renderWidth(80), terminalRows(24));
    const body = rendered.transcriptLines.join("\n");
    expect(body.indexOf("plan")).toBeLessThan(body.indexOf("reading"));
    expect(body.indexOf("reading")).toBeLessThan(body.indexOf("Tool · read"));
  });

  test.each([
    [1, ["A", "R", "L", "f"]],
    [2, ["A1", "Re", "Li", "fo"]],
    [20, ["A1.2 · luna:h · 42% ", "Research terminal UX", "Live conversation", "following · ↑/↓ line"]],
  ] as const)("preserves the required header, status and footer concessions at width %i", (width, expected) => {
    const plain = renderChildConversation(
      createChildConversationModel(snapshot()),
      theme,
      renderWidth(width),
      terminalRows(30),
    ).lines.map(Bun.stripANSI);

    expect([plain[0], plain[1], plain[2], plain.at(-1)]).toEqual([...expected]);
  });

  test.each([1, 2, 20, 80, 160])("bounds every ASCII, CJK, combining and ANSI line at width %i", (width) => {
    const rendered = renderChildConversation(
      createChildConversationModel(snapshot()),
      theme,
      renderWidth(width),
      terminalRows(30),
    );

    expect(rendered.lines.every((line) => visibleWidth(line) <= width)).toBe(true);
    expect(rendered.transcriptLines.every((line) => visibleWidth(line) <= width)).toBe(true);
  });

  test.each([
    [0, "Loading conversation"],
    [1, "Live conversation"],
  ] as const)("renders revision %i status", (revision, status) => {
    const rendered = renderChildConversation(
      createChildConversationModel(snapshot({ revision: conversationRevision(revision) })),
      theme,
      renderWidth(80),
      terminalRows(12),
    );

    expect(Bun.stripANSI(rendered.lines.join("\n"))).toContain(status);
  });

  test.each([
    [{ availability: "stopped" as const }, "Stopped conversation"],
    [{ availability: "unavailable" as const }, "Conversation unavailable"],
    [{ routeAvailable: false }, "Route unavailable · retained content"],
  ])("renders source status %#", (difference, status) => {
    const rendered = renderChildConversation(
      createChildConversationModel(snapshot(difference)),
      theme,
      renderWidth(80),
      terminalRows(12),
    );

    expect(Bun.stripANSI(rendered.lines.join("\n"))).toContain(status);
  });
  test("caps transcript layout at 4,096 tail rows with one omitted-beginning marker", () => {
    const long = Array.from({ length: 5_000 }, (_, index) => `line-${index}`).join("\n");
    const rendered = renderChildConversation(createChildConversationModel(snapshotWith([assistantTurn(0, [block("text", long)])], { truncatedBefore: false })), theme, renderWidth(40), terminalRows(5_000));
    const plain = rendered.transcriptLines.map(Bun.stripANSI);
    expect(rendered.transcriptLines).toHaveLength(4_096); expect(plain.filter((line) => line.includes("Visual beginning omitted"))).toHaveLength(1); expect(plain.at(-1)).toContain("line-4999");
  });
});
