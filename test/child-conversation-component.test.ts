import { describe, expect, test } from "bun:test";
import { Theme, type KeybindingsManager as AppKeybindingsManager, type ThemeColor } from "@earendil-works/pi-coding-agent";
import { KeybindingsManager, TUI, TUI_KEYBINDINGS, visibleWidth, type Terminal } from "@earendil-works/pi-tui";

import type { AgentDisplayState, ConversationItem, ConversationSnapshot } from "../src/agent-observation.ts";
import { ChildConversationComponent } from "../src/agent-widget/conversation-component.ts";
import { createChildConversationModel } from "../src/agent-widget/conversation-model.ts";
import {
  AgentState, agentDepth, agentOrdinal, conversationItemKey, conversationRevision,
  type ContextLabel, type ModelLabel, type TaskLabel, type ToolDisplayName, type TranscriptText,
} from "../src/domain.ts";

class MutableTerminal implements Terminal {
  columns = 120;
  rows: number;
  readonly kittyProtocolActive = false;
  constructor(rows: number) { this.rows = rows }
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

function conversation(revision = 1): ConversationSnapshot {
  const r = conversationRevision(revision);
  const items: ConversationItem[] = [
    { key: conversationItemKey(r, 0), kind: "thinking", phase: "final", text: "private thought" as TranscriptText },
    { key: conversationItemKey(r, 1), kind: "tool", tool: "read" as ToolDisplayName, phase: "completed", preview: "expanded preview" as TranscriptText },
    ...Array.from({ length: 30 }, (_, index): ConversationItem => ({
      key: conversationItemKey(r, index + 2), kind: "user", text: `line ${index}` as TranscriptText,
    })),
  ];
  return Object.freeze({
    revision: r, items: Object.freeze(items), truncatedBefore: false, availability: "live",
    row: Object.freeze({
      ordinal: agentOrdinal("A1.2"), depth: agentDepth(1), model: "luna:h" as ModelLabel,
      context: "42%" as ContextLabel, taskLabel: "Task" as TaskLabel,
      state: AgentState.Running as AgentDisplayState,
    }),
    routeAvailable: true,
  });
}

function keybindings(): AppKeybindingsManager {
  return new KeybindingsManager({
    ...TUI_KEYBINDINGS,
    "app.thinking.toggle": { defaultKeys: "ctrl+t" },
    "app.tools.expand": { defaultKeys: "ctrl+o" },
  }, {
    "tui.editor.cursorUp": "k", "tui.editor.cursorDown": "j",
    "tui.editor.pageUp": "u", "tui.editor.pageDown": "d",
    "app.thinking.toggle": "t", "app.tools.expand": "o", "tui.select.cancel": "x",
  }) as AppKeybindingsManager;
}

function harness(rows = 12) {
  const terminal = new MutableTerminal(rows);
  const tui = new TUI(terminal);
  let renders = 0;
  tui.requestRender = () => { renders += 1 };
  let closes = 0;
  const reports: unknown[] = [];
  const component = new ChildConversationComponent(
    tui, theme, keybindings(), createChildConversationModel(conversation()),
    { close: () => { closes += 1 }, report: (error) => { reports.push(error) } },
  );
  return { component, terminal, renders: () => renders, closes: () => closes, reports };
}

describe("ChildConversationComponent", () => {
  test("covers every terminal row and supplied column after each resize", () => {
    const h = harness(12);
    for (const [rows, width] of [[12, 1], [12, 20], [5, 80], [18, 160]] as const) {
      h.terminal.rows = rows;
      const lines = h.component.render(width);
      expect(lines).toHaveLength(rows);
      expect(lines.every((line) => visibleWidth(line) === width)).toBe(true);
    }
  });

  test("uses the injected keybinding manager for every approved transition and raw g/G", () => {
    const h = harness(10);
    const state = () => Bun.stripANSI(h.component.render(80).join("\n"));
    expect(state()).toContain("following");
    h.component.handleInput("g");
    expect(state()).toContain("private thought");
    expect(state()).not.toContain("expanded preview");
    h.component.handleInput("t"); expect(state()).not.toContain("private thought");
    h.component.handleInput("o"); expect(state()).toContain("expanded preview");
    h.component.handleInput("G"); expect(state()).toContain("following");

    h.component.handleInput("k"); expect(state()).toContain("paused");
    h.component.handleInput("j"); expect(state()).toContain("following");
    h.component.handleInput("u"); expect(state()).toContain("paused");
    h.component.handleInput("d"); expect(state()).toContain("following");
    h.component.handleInput("g"); expect(state()).toContain("paused");
    h.component.handleInput("G"); expect(state()).toContain("following");
    expect(h.renders()).toBe(10);

    h.component.handleInput("z");
    expect(h.renders()).toBe(10);
    h.component.handleInput("x");
    expect(h.closes()).toBe(1);
  });

  test.each([
    ["thinking", [] as const, "t", 25, 24],
    ["tools", ["o"] as const, "o", 26, 25],
  ])("clamps a top-paused offset when the %s toggle removes visual lines", (_name, setup, toggle, clamped, afterDown) => {
    const h = harness(10);
    const state = () => Bun.stripANSI(h.component.render(80).join("\n"));
    state();
    for (const key of setup) h.component.handleInput(key);
    h.component.handleInput("g");

    h.component.handleInput(toggle);
    expect(state()).toContain(`paused · ${clamped} lines from tail`);
    h.component.handleInput("j");
    expect(state()).toContain(`paused · ${afterDown} lines from tail`);
  });

  test("clamps a top-paused offset on resize before the next Down movement", () => {
    const h = harness(10);
    const state = () => Bun.stripANSI(h.component.render(80).join("\n"));
    state();
    h.component.handleInput("g");

    h.terminal.rows = 20;
    expect(state()).toContain("paused · 16 lines from tail");
    h.component.handleInput("j");
    expect(state()).toContain("paused · 15 lines from tail");
  });

  test("snapshot replacement invalidates once and preserves component-local navigation", () => {
    const h = harness(10);
    h.component.handleInput("k");
    h.component.setConversation(conversation(2));

    expect(Bun.stripANSI(h.component.render(80).join("\n"))).toContain("paused");
    expect(h.renders()).toBe(2);
  });

  test("a throwing close callback is contained and switches to an opaque fallback", () => {
    const terminal = new MutableTerminal(7);
    const tui = new TUI(terminal);
    const closeError = new Error("close secret");
    const failures: unknown[] = [];
    let closeAttempts = 0;
    const component = new ChildConversationComponent(
      tui, theme, keybindings(), createChildConversationModel(conversation()),
      {
        close: () => { closeAttempts += 1; throw closeError },
        report: (error) => { failures.push(error) },
      },
    );

    expect(() => component.handleInput("x")).not.toThrow();
    expect(closeAttempts).toBe(1);
    expect(failures).toEqual([closeError]);
    const fallback = component.render(13);
    expect(fallback).toHaveLength(7);
    expect(fallback.every((line) => line === " ".repeat(13))).toBe(true);
  });

  test("render, input, invalidate and dispose failures are contained behind an opaque fallback", () => {
    const terminal = new MutableTerminal(7);
    const tui = new TUI(terminal);
    const failures: unknown[] = [];
    const brokenBindings = keybindings();
    brokenBindings.matches = () => { throw new Error("binding secret") };
    const component = new ChildConversationComponent(
      tui, theme, brokenBindings, createChildConversationModel(conversation()),
      { close: () => { throw new Error("close secret") }, report: (error) => { failures.push(error) } },
    );
    tui.requestRender = () => { throw new Error("render request secret") };

    expect(() => component.handleInput("k")).not.toThrow();
    expect(() => component.invalidate()).not.toThrow();
    expect(() => component.handleInput("x")).not.toThrow();
    expect(() => { component.dispose(); component.dispose(); }).not.toThrow();
    const fallback = component.render(13);
    expect(fallback).toHaveLength(7);
    expect(fallback.every((line) => visibleWidth(line) === 13)).toBe(true);
    expect(Bun.stripANSI(fallback.join(""))).not.toContain("secret");
    expect(failures.length).toBeGreaterThan(0);
  });
});
