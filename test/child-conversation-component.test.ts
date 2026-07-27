import { describe, expect, test } from "bun:test";
import { initTheme, Theme, ToolExecutionComponent, type KeybindingsManager as AppKeybindingsManager, type ThemeColor } from "@earendil-works/pi-coding-agent";
import { KeybindingsManager, TUI, TUI_KEYBINDINGS, visibleWidth, type Terminal } from "@earendil-works/pi-tui";

import type { AgentDisplayState, ConversationAssistantBlock, ConversationSnapshot, ConversationTurn } from "../src/agent-observation.ts";
import { ChildConversationComponent } from "../src/agent-widget/conversation-component.ts";
import {
  createChildConversationModel,
  toggleConversationThinking,
  toggleConversationTools,
} from "../src/agent-widget/conversation-model.ts";
import { createPiConversationAdapter, type PiConversationAdapterFactories } from "../src/agent-widget/conversation-native-adapter.ts";
import { renderChildConversation } from "../src/agent-widget/conversation-render.ts";
import {
  AgentState, agentOrdinal, conversationCallKey, conversationRevision, conversationTurnKey,
  renderWidth, terminalRows, tryPresentationCwd,
  type ContextLabel, type ModelLabel, type PresentationCwd, type SafePresentationJson, type TaskLabel,
  type ToolDisplayName, type TranscriptText,
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
initTheme(undefined, false);
const theme = new Theme(foreground, background, "truecolor");

function safeJson(value: object): SafePresentationJson { return value as SafePresentationJson }
function presentationCwd(value: string): PresentationCwd {
  const cwd = tryPresentationCwd(value);
  if (cwd === undefined) throw new Error("invalid test presentation cwd");
  return cwd;
}

function conversation(revision = 1): ConversationSnapshot {
  const r = conversationRevision(revision);
  const assistantBlocks: readonly ConversationAssistantBlock[] = [
    { kind: "thinking", text: "private thought" as TranscriptText },
    { kind: "tool", presentation: {
      callKey: conversationCallKey(r, 0, 1), tool: "read" as ToolDisplayName,
      phase: "completed",
      arguments: safeJson({ path: "/home/child/a.ts" }),
      result: { content: ["expanded preview" as TranscriptText], isError: false },
      rendering: "native-built-in",
    } },
  ];
  const turns: readonly ConversationTurn[] = [
    { key: conversationTurnKey(r, 0), kind: "assistant", phase: "final", blocks: assistantBlocks },
    ...Array.from({ length: 30 }, (_, index): ConversationTurn => ({
      key: conversationTurnKey(r, index + 1), kind: "user", text: `line ${index}` as TranscriptText,
    })),
  ];
  return Object.freeze({
    revision: r, turns: Object.freeze(turns), truncatedBefore: false, availability: "live",
    header: Object.freeze({
      ordinal: agentOrdinal("A1.2"), model: "luna:h" as ModelLabel,
      context: "42%" as ContextLabel, taskLabel: "Task" as TaskLabel,
      state: AgentState.Running as AgentDisplayState,
    }),
    routeAvailable: true,
    renderingCwd: presentationCwd("/home/child"),
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

interface VisibilityState {
  readonly thinkingVisible: boolean;
  readonly toolsExpanded: boolean;
}

function maximumOffsets(
  rows: number,
  states: readonly VisibilityState[],
  snapshot: ConversationSnapshot = conversation(),
): readonly number[] {
  const terminal = new MutableTerminal(rows);
  const tui = new TUI(terminal);
  const adapter = createPiConversationAdapter({ tui, theme });
  return states.map((state) => {
    let model = createChildConversationModel(snapshot);
    if (!state.thinkingVisible) model = toggleConversationThinking(model);
    if (state.toolsExpanded) model = toggleConversationTools(model);
    const rendered = renderChildConversation(model, theme, renderWidth(80), terminalRows(rows), adapter);
    return Math.max(0, Number(rendered.layout.contentLines) - Number(rendered.layout.viewportLines));
  });
}

function maximumOffset(rows: number, state: VisibilityState): number {
  return maximumOffsets(rows, [state])[0]!;
}

function viewportLines(rows: number): number {
  return Math.max(0, rows - 4);
}

function expectOffset(frame: string, expected: number): void {
  if (expected === 0) {
    expect(frame).toContain("following");
    expect(frame).not.toContain("paused ·");
    return;
  }
  expect(frame).toContain(`paused · ${expected} lines from tail`);
}

function harness(rows = 12, adapterFactories?: Partial<PiConversationAdapterFactories>) {
  const terminal = new MutableTerminal(rows);
  const tui = new TUI(terminal);
  let renders = 0;
  tui.requestRender = () => { renders += 1 };
  let closes = 0;
  const reports: unknown[] = [];
  const component = new ChildConversationComponent(
    tui, theme, keybindings(), createChildConversationModel(conversation()),
    {
      close: () => { closes += 1 }, report: (error) => { reports.push(error) },
      ...(adapterFactories === undefined ? {} : { adapterFactories }),
    },
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

  test("renders conversation turns through native Pi components", () => {
    const h = harness(12);
    const frame = Bun.stripANSI(h.component.render(80).join("\n"));

    expect(frame).toContain("line 29");
    expect(frame).not.toContain("You · line 29");
  });

  test("applies exact line, page, top, tail and toggle transitions with one render request each", () => {
    const rows = 10;
    const h = harness(rows);
    const state = () => Bun.stripANSI(h.component.render(80).join("\n"));
    const expectedMaximums = maximumOffsets(rows, [
      { thinkingVisible: true, toolsExpanded: false },
      { thinkingVisible: false, toolsExpanded: false },
      { thinkingVisible: false, toolsExpanded: true },
    ]);
    const visibleCollapsed = expectedMaximums[0]!;
    const hiddenCollapsed = expectedMaximums[1]!;
    const hiddenExpanded = expectedMaximums[2]!;

    expectOffset(state(), 0);
    const baselineRenders = h.renders();
    h.component.handleInput("g");
    expectOffset(state(), visibleCollapsed);
    expect(state()).toContain("private thought");
    expect(state()).not.toContain("expanded preview");

    h.component.handleInput("t");
    expectOffset(state(), hiddenCollapsed);
    expect(state()).not.toContain("private thought");
    h.component.handleInput("o");
    expectOffset(state(), Math.min(hiddenCollapsed!, hiddenExpanded!));
    expect(state()).toContain("expanded preview");
    h.component.handleInput("G");
    expectOffset(state(), 0);

    h.component.handleInput("k"); expectOffset(state(), 1);
    h.component.handleInput("j"); expectOffset(state(), 0);
    h.component.handleInput("u"); expectOffset(state(), Math.min(viewportLines(rows), hiddenExpanded));
    h.component.handleInput("d"); expectOffset(state(), 0);
    h.component.handleInput("g"); expectOffset(state(), hiddenExpanded);
    h.component.handleInput("G"); expectOffset(state(), 0);
    expect(h.renders()).toBe(baselineRenders + 10);

    h.component.handleInput("z");
    expect(h.renders()).toBe(baselineRenders + 10);
    h.component.handleInput("x");
    expect(h.closes()).toBe(1);
  });

  test.each([
    {
      name: "thinking",
      setup: [] as const,
      toggle: "t",
      before: { thinkingVisible: true, toolsExpanded: false },
      after: { thinkingVisible: false, toolsExpanded: false },
    },
    {
      name: "tools",
      setup: ["o"] as const,
      toggle: "o",
      before: { thinkingVisible: true, toolsExpanded: true },
      after: { thinkingVisible: true, toolsExpanded: false },
    },
  ])("clamps to the exact native-body maximum after the $name toggle", ({ setup, toggle, before, after }) => {
    const rows = 10;
    const h = harness(rows);
    const state = () => Bun.stripANSI(h.component.render(80).join("\n"));
    state();
    const [, expectedBefore, clamped] = maximumOffsets(rows, [
      { thinkingVisible: true, toolsExpanded: false },
      before,
      after,
    ]);
    for (const key of setup) h.component.handleInput(key);
    h.component.handleInput("g");
    expectOffset(state(), expectedBefore!);

    h.component.handleInput(toggle);
    expectOffset(state(), clamped!);
    h.component.handleInput("j");
    expectOffset(state(), Math.max(0, clamped! - 1));
  });

  test("clamps to the exact resized native-body maximum before the next Down movement", () => {
    const initialRows = 10;
    const resizedRows = 20;
    const visibility = { thinkingVisible: true, toolsExpanded: false };
    const h = harness(initialRows);
    const state = () => Bun.stripANSI(h.component.render(80).join("\n"));
    state();
    h.component.handleInput("g");
    expectOffset(state(), maximumOffset(initialRows, visibility));

    h.terminal.rows = resizedRows;
    const resized = maximumOffset(resizedRows, visibility);
    expectOffset(state(), resized);
    h.component.handleInput("j");
    expectOffset(state(), Math.max(0, resized - 1));
  });

  test("snapshot replacement preserves the exact offset and requests only native rebuild plus apply renders", () => {
    const h = harness(10);
    const state = () => Bun.stripANSI(h.component.render(80).join("\n"));
    expectOffset(state(), 0);
    h.component.handleInput("k");
    expectOffset(state(), 1);
    const before = h.renders();

    h.component.setConversation(conversation(2));

    expectOffset(state(), 1);
    expect(h.renders()).toBe(before + 2);
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

  test("an item-level native updater failure does not poison subsequent component renders", () => {
    const h = harness(50, {
      createToolExecution: (...args) => {
        const component = new ToolExecutionComponent(...args);
        component.setExpanded = () => { throw new Error("tool toggle fault"); };
        return component;
      },
    });

    h.component.handleInput("g");
    for (const action of [() => undefined, () => h.component.handleInput("o")]) {
      action();
      const frame = Bun.stripANSI(h.component.render(80).join("\n"));
      expect(frame).toContain("Item unavailable");
      expect(frame).toContain("private thought");
    }
    expect(h.reports).toEqual([]);
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
