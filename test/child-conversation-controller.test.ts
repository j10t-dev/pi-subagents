import { describe, expect, test } from "bun:test";
import { Theme, type KeybindingsManager as AppKeybindingsManager, type ThemeColor } from "@earendil-works/pi-coding-agent";
import {
  KeybindingsManager, TUI, TUI_KEYBINDINGS, type Component, type Focusable,
  type OverlayHandle, type OverlayOptions, type Terminal,
} from "@earendil-works/pi-tui";

import type {
  AgentDisplayState, AgentWidgetSource, SelectedTranscriptSnapshot, SelectedTranscriptSource,
} from "../src/agent-observation.ts";
import { ChildConversationComponent } from "../src/agent-widget/conversation-component.ts";
import {
  childConversationOverlayOptions,
  createChildConversationController,
} from "../src/agent-widget/conversation-controller.ts";
import {
  AgentState, agentCount, agentDepth, agentOrdinal, agentWidgetRevision,
  runId, selectedTranscriptRevision, transcriptRevision, transcriptSequence,
  type ContextLabel, type ModelLabel, type TaskLabel, type TranscriptText,
} from "../src/domain.ts";

class FakeTerminal implements Terminal {
  columns = 120;
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

function keybindings(): AppKeybindingsManager {
  return new KeybindingsManager({
    ...TUI_KEYBINDINGS,
    "app.thinking.toggle": { defaultKeys: "ctrl+t" },
    "app.tools.expand": { defaultKeys: "ctrl+o" },
  }) as AppKeybindingsManager;
}

function selected(revision = 0): SelectedTranscriptSnapshot {
  return Object.freeze({
    revision: selectedTranscriptRevision(revision),
    transcript: Object.freeze({
      revision: transcriptRevision(revision),
      items: revision === 0 ? [] : [{
        sequence: transcriptSequence(999), runId: runId("deadbeef"), kind: "user" as const,
        text: "safe text" as TranscriptText,
      }],
      truncatedBefore: false, availability: "live" as const,
    }),
    row: Object.freeze({
      ordinal: agentOrdinal("A1"), depth: agentDepth(0), model: "luna:h" as ModelLabel,
      context: "42%" as ContextLabel, taskLabel: "Task" as TaskLabel,
      state: AgentState.Running as AgentDisplayState,
    }),
    routeAvailable: true,
  });
}

class MutableSelectedSource implements SelectedTranscriptSource {
  current = selected();
  listener: ((snapshot: SelectedTranscriptSnapshot) => void) | undefined;
  readonly log: string[];
  constructor(log: string[]) { this.log = log }
  snapshot(): SelectedTranscriptSnapshot { this.log.push("snapshot"); return this.current }
  subscribe(listener: (snapshot: SelectedTranscriptSnapshot) => void): () => void {
    this.log.push("subscribe"); this.listener = listener;
    return () => { this.log.push("unsubscribe"); this.listener = undefined };
  }
  publish(next: SelectedTranscriptSnapshot): void { this.current = next; this.listener?.(next) }
}

function widgetSource(direct: MutableSelectedSource, nested: MutableSelectedSource, opens: string[]): AgentWidgetSource {
  return {
    snapshot: () => ({ revision: agentWidgetRevision(1), rows: [], total: agentCount(0), omitted: agentCount(0), degraded: false }),
    transcriptSource: (ordinal) => {
      opens.push(String(ordinal));
      return ordinal === agentOrdinal("A1") ? direct : ordinal === agentOrdinal("A1.2") ? nested : undefined;
    },
    subscribe: () => () => {},
  };
}

function fakeHandle(name: string, log: string[]): OverlayHandle {
  let hidden = false;
  return {
    hide: () => { if (!hidden) { hidden = true; log.push(`hide:${name}`) } },
    setHidden: () => {}, isHidden: () => hidden, focus: () => {}, unfocus: () => {}, isFocused: () => !hidden,
  };
}

describe("createChildConversationController", () => {
  test("opens direct and nested sources non-blockingly with the exact fullscreen capturing options", () => {
    const log: string[] = [];
    const direct = new MutableSelectedSource(log);
    const nested = new MutableSelectedSource(log);
    const opens: string[] = [];
    const agentSource = widgetSource(direct, nested, opens);
    const tui = new TUI(new FakeTerminal());
    let component: Component | undefined;
    let options: OverlayOptions | undefined;
    let child = fakeHandle("child", log);
    tui.showOverlay = (next, nextOptions) => { log.push("overlay"); component = next; options = nextOptions; return child };
    const controller = createChildConversationController({
      tui, theme, keybindings: keybindings(),
      onDiagnostic: (code) => { log.push(`diagnostic:${code}`) },
      createCoalescer: (runner) => ({ request: runner, dispose: () => { log.push("coalescer:dispose") } }),
    });

    expect(controller.open(agentOrdinal("A1"), agentSource)).toBeUndefined();
    expect(options).toEqual(childConversationOverlayOptions);
    expect(options).toEqual({ width: "100%", maxHeight: "100%", row: 0, col: 0, margin: 0 });
    expect(Bun.stripANSI(component!.render(80).join("\n"))).toContain("Loading conversation");
    controller.open(agentOrdinal("A1.2"), agentSource);
    expect(opens).toEqual(["A1"]);

    controller.close();
    child = fakeHandle("nested", log);
    controller.open(agentOrdinal("A1.2"), agentSource);
    expect(opens).toEqual(["A1", "A1.2"]);
    controller.dispose();
  });

  test("projects coalesced snapshots and ignores late generation continuations", () => {
    const log: string[] = [];
    const direct = new MutableSelectedSource(log);
    const nested = new MutableSelectedSource(log);
    const tui = new TUI(new FakeTerminal());
    let component: ChildConversationComponent | undefined;
    let queued: (() => void) | undefined;
    tui.showOverlay = (next) => { component = next as ChildConversationComponent; return fakeHandle("child", log) };
    const agentSource = widgetSource(direct, nested, []);
    const controller = createChildConversationController({
      tui, theme, keybindings: keybindings(), onDiagnostic: () => {},
      createCoalescer: (runner) => ({ request: () => { queued = runner }, dispose: () => { queued = undefined } }),
    });
    controller.open(agentOrdinal("A1"), agentSource);

    direct.publish(selected(1));
    direct.publish(selected(2));
    expect(Bun.stripANSI(component!.render(80).join("\n"))).toContain("Loading conversation");
    queued?.();
    const rendered = Bun.stripANSI(component!.render(80).join("\n"));
    expect(rendered).toContain("safe text");
    expect(rendered).not.toContain("deadbeef");
    expect(rendered).not.toContain("999");

    const late = direct.listener;
    controller.close();
    late?.(selected(3));
    queued?.();
    expect(() => controller.close()).not.toThrow();
  });

  test("Esc hides only the retained child handle and leaves a newer sibling untouched", () => {
    const log: string[] = [];
    const direct = new MutableSelectedSource(log);
    const nested = new MutableSelectedSource(log);
    const tui = new TUI(new FakeTerminal());
    const child = fakeHandle("child", log);
    const sibling = fakeHandle("sibling", log);
    let captured: ChildConversationComponent | undefined;
    tui.showOverlay = (next) => { captured = next as ChildConversationComponent; return child };
    const agentSource = widgetSource(direct, nested, []);
    const controller = createChildConversationController({
      tui, theme, keybindings: keybindings(), onDiagnostic: () => {},
      createCoalescer: (runner) => ({ request: runner, dispose: () => {} }),
    });
    controller.open(agentOrdinal("A1"), agentSource);

    captured!.handleInput("\u001b");

    expect(log.filter((entry) => entry === "hide:child")).toHaveLength(1);
    expect(sibling.isHidden()).toBe(false);
    expect(log).not.toContain("hide:sibling");
  });

  test("hides only the retained handle once and releases resources in teardown order", () => {
    const log: string[] = [];
    const direct = new MutableSelectedSource(log);
    const nested = new MutableSelectedSource(log);
    const tui = new TUI(new FakeTerminal());
    const child = fakeHandle("child", log);
    const sibling = fakeHandle("sibling", log);
    let captured: ChildConversationComponent | undefined;
    tui.showOverlay = (next) => { captured = next as ChildConversationComponent; return child };
    tui.hideOverlay = () => { throw new Error("global hideOverlay must not be called") };
    const agentSource = widgetSource(direct, nested, []);
    const controller = createChildConversationController({
      tui, theme, keybindings: keybindings(), onDiagnostic: () => {},
      createCoalescer: (runner) => ({ request: runner, dispose: () => { log.push("coalescer:dispose") } }),
    });
    controller.open(agentOrdinal("A1"), agentSource);
    const originalDispose = captured!.dispose.bind(captured);
    captured!.dispose = () => { log.push("component:dispose"); originalDispose() };

    controller.dispose();
    controller.dispose();

    expect(log.filter((entry) => entry === "hide:child")).toHaveLength(1);
    expect(log).not.toContain("hide:sibling");
    expect(sibling.isHidden()).toBe(false);
    expect(log.indexOf("hide:child")).toBeLessThan(log.indexOf("unsubscribe"));
    expect(log.indexOf("unsubscribe")).toBeLessThan(log.indexOf("component:dispose"));
    expect(log.indexOf("unsubscribe")).toBeLessThan(log.indexOf("coalescer:dispose"));
  });

  test("reports a missing selected source once and leaves overlay focus untouched", () => {
    const diagnostics: string[] = [];
    const tui = new TUI(new FakeTerminal());
    let overlays = 0;
    tui.showOverlay = () => { overlays += 1; return fakeHandle("unused", []) };
    const unavailableSource = widgetSource(
      new MutableSelectedSource([]),
      new MutableSelectedSource([]),
      [],
    );
    const controller = createChildConversationController({
      tui, theme, keybindings: keybindings(), onDiagnostic: (code) => { diagnostics.push(code) },
    });

    controller.open(agentOrdinal("A9"), unavailableSource);
    controller.open(agentOrdinal("A9"), unavailableSource);

    expect(overlays).toBe(0);
    expect(diagnostics).toEqual(["conversation_unavailable"]);
  });

  test("the real public TUI overlay handle restores its prior focus owner", () => {
    const tui = new TUI(new FakeTerminal());
    const parent: Component & Focusable = { focused: false, render: () => ["parent"], invalidate: () => {} };
    tui.addChild(parent);
    tui.setFocus(parent);
    const direct = new MutableSelectedSource([]);
    const nested = new MutableSelectedSource([]);
    const agentSource = widgetSource(direct, nested, []);
    const controller = createChildConversationController({
      tui, theme, keybindings: keybindings(), onDiagnostic: () => {},
      createCoalescer: (runner) => ({ request: runner, dispose: () => {} }),
    });

    controller.open(agentOrdinal("A1"), agentSource);
    expect(parent.focused).toBe(false);
    controller.close();
    expect(parent.focused).toBe(true);
  });
});
