import { describe, expect, test } from "bun:test";
import { initTheme, Theme, type ThemeColor } from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";

import type { AgentDisplayState, ConversationItem, ConversationSnapshot } from "../src/agent-observation.ts";
import { createChildConversationModel, toggleConversationThinking, toggleConversationTools } from "../src/agent-widget/conversation-model.ts";
import { renderChildConversation } from "../src/agent-widget/conversation-render.ts";
import {
  AgentState, agentDepth, agentOrdinal, conversationItemKey, conversationRevision, renderWidth, terminalRows,
  type ContextLabel, type ModelLabel, type TaskLabel, type ToolDisplayName, type TranscriptText,
} from "../src/domain.ts";

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
initTheme(undefined, false);
const theme = new Theme(foreground, background, "truecolor");

type ConversationItemWithoutKey = ConversationItem extends infer Item
  ? Item extends ConversationItem ? Omit<Item, "key"> : never
  : never;

function item(index: number, value: ConversationItemWithoutKey): ConversationItem {
  return { key: conversationItemKey(conversationRevision(1), index), ...value } as ConversationItem;
}

function snapshot(options: Partial<ConversationSnapshot> = {}): ConversationSnapshot {
  return Object.freeze({
    revision: conversationRevision(1),
    items: Object.freeze([
      item(0, { kind: "user", text: "ASCII question 界 e\u0301" as TranscriptText }),
      item(1, { kind: "thinking", phase: "partial", text: "considering options" as TranscriptText }),
      item(2, { kind: "assistant", phase: "partial", text: "## Answer\n\n**Markdown** response 界" as TranscriptText }),
      item(3, { kind: "tool", tool: "read" as ToolDisplayName, phase: "running", preview: "first preview line\nsecond preview line" as TranscriptText }),
      item(4, { kind: "tool", tool: "write" as ToolDisplayName, phase: "completed" }),
      item(5, { kind: "tool", tool: "bash" as ToolDisplayName, phase: "failed" }),
      item(6, { kind: "notice", code: "context-compacted" }),
      item(7, { kind: "notice", code: "transport-unavailable" }),
      item(8, { kind: "notice", code: "projection-unavailable" }),
    ]),
    truncatedBefore: true,
    availability: "live" as const,
    row: Object.freeze({
      ordinal: agentOrdinal("A1.2"), depth: agentDepth(1), model: "luna:h" as ModelLabel,
      context: "42%" as ContextLabel, taskLabel: "Research terminal UX ".repeat(20) as TaskLabel,
      state: AgentState.Running as AgentDisplayState,
    }),
    routeAvailable: true,
    ...options,
  });
}

describe("renderChildConversation", () => {
  test("renders the complete Pi-styled grammar and local visibility states", () => {
    let model = createChildConversationModel(snapshot());
    model = toggleConversationTools(model);
    const rendered = renderChildConversation(model, theme, renderWidth(160), terminalRows(40));
    const plain = Bun.stripANSI(rendered.lines.join("\n"));

    expect(plain).toContain("A1.2 · luna:h · 42% · running");
    expect(plain).toContain("Research terminal UX");
    expect(plain).toContain("Live conversation");
    expect(plain).toContain("Earlier source history omitted");
    expect(plain).toContain("You · ASCII question 界 é");
    expect(plain).toContain("Thinking · partial · considering options");
    expect(plain).toContain("Answer");
    expect(plain).toContain("Tool · read · running");
    expect(plain).toContain("first preview line");
    expect(plain).toContain("Tool · write · completed");
    expect(plain).toContain("Tool · bash · failed");
    expect(plain).toContain("Context compacted");
    expect(plain).toContain("Transport unavailable");
    expect(plain).toContain("Projection unavailable");
    expect(plain).toContain("following · ↑/↓ line · PgUp/PgDn page · g/G top/tail · Ctrl+T thinking · Ctrl+O tools · Esc close");

    model = toggleConversationThinking(model);
    const hidden = Bun.stripANSI(renderChildConversation(model, theme, renderWidth(160), terminalRows(40)).lines.join("\n"));
    expect(hidden).not.toContain("considering options");
  });

  test.each([
    [1, ["A", "R", "L", "f"]],
    [2, ["A1", "Re", "Li", "fo"]],
    [20, ["A1.2 · luna:h · 42% ", "Research terminal UX", "Live conversation", "following · ↑/↓ line"]],
  ] as const)("preserves the required header, status and footer concessions at width %i", (width, expected) => {
    const rendered = renderChildConversation(
      createChildConversationModel(snapshot()), theme, renderWidth(width), terminalRows(30),
    );
    const plain = rendered.lines.map(Bun.stripANSI);
    expect([plain[0], plain[1], plain[2], plain.at(-1)]).toEqual([...expected]);
  });

  test.each([1, 2, 20, 80, 160])("bounds every ASCII, CJK, combining and ANSI line at width %i", (width) => {
    const rendered = renderChildConversation(createChildConversationModel(snapshot()), theme, renderWidth(width), terminalRows(30));
    expect(rendered.lines.every((line) => visibleWidth(line) <= width)).toBe(true);
    expect(rendered.transcriptLines.every((line) => visibleWidth(line) <= width)).toBe(true);
  });

  test.each([
    [0, "Loading conversation"],
    [1, "Live conversation"],
  ] as const)("renders revision %i status", (revision, status) => {
    const rendered = renderChildConversation(
      createChildConversationModel(snapshot({ revision: conversationRevision(revision) })),
      theme, renderWidth(80), terminalRows(12),
    );
    expect(Bun.stripANSI(rendered.lines.join("\n"))).toContain(status);
  });

  test.each([
    [{ availability: "stopped" as const }, "Stopped conversation"],
    [{ availability: "unavailable" as const }, "Conversation unavailable"],
    [{ routeAvailable: false }, "Route unavailable · retained content"],
  ])("renders source status %#", (difference, status) => {
    const rendered = renderChildConversation(
      createChildConversationModel(snapshot(difference)), theme, renderWidth(80), terminalRows(12),
    );
    expect(Bun.stripANSI(rendered.lines.join("\n"))).toContain(status);
  });

  test("caps transcript layout at 4,096 tail rows with one omitted-beginning marker", () => {
    const long = Array.from({ length: 5_000 }, (_, index) => `line-${index}`).join("\n") as TranscriptText;
    const conversation = snapshot({
      truncatedBefore: false,
      items: [item(0, { kind: "assistant", phase: "final", text: long })],
    });

    const rendered = renderChildConversation(
      createChildConversationModel(conversation), theme, renderWidth(40), terminalRows(5_000),
    );
    const plain = rendered.transcriptLines.map(Bun.stripANSI);

    expect(rendered.transcriptLines.length).toBe(4_096);
    expect(plain.filter((line) => line.includes("Visual beginning omitted"))).toHaveLength(1);
    expect(plain.at(-1)).toContain("line-4999");
  });
});
