import type { AgentDisplayState, AgentRow, AgentWidgetSnapshot } from "../src/agent-observation.ts";
import {
  AgentState,
  agentCount,
  agentDepth,
  agentOrdinal,
  agentWidgetRevision,
  type ContextLabel,
  type ModelLabel,
  type TaskLabel,
} from "../src/domain.ts";

function row(ordinal: string): AgentRow {
  return {
    ordinal: agentOrdinal(ordinal),
    depth: agentDepth(0),
    model: "luna:h" as ModelLabel,
    context: "42%" as ContextLabel,
    taskLabel: "Research terminal UX" as TaskLabel,
    state: AgentState.Running as AgentDisplayState,
  };
}

function snapshot(rows: readonly AgentRow[]): AgentWidgetSnapshot {
  return {
    revision: agentWidgetRevision(1),
    rows,
    total: agentCount(rows.length),
    omitted: agentCount(0),
    degraded: false,
  };
}

import { describe, expect, test } from "bun:test";
import { TUI, type Terminal } from "@earendil-works/pi-tui";
import { Theme, type ThemeColor } from "@earendil-works/pi-coding-agent";

import { AgentWidgetComponent } from "../src/agent-widget/component.ts";
import { emptyModel, replaceRows, selectFirst, type AgentWidgetModel } from "../src/agent-widget/model.ts";
import type { AgentWidgetView } from "../src/agent-widget/render.ts";

const DOWN = "\u001b[B";
const UP = "\u001b[A";
const ESCAPE = "\u001b";

class FakeTerminal implements Terminal {
  private currentColumns: number;
  private currentRows: number;

  constructor(rows: number, columns: number) {
    this.currentRows = rows;
    this.currentColumns = columns;
  }

  get columns(): number {
    return this.currentColumns;
  }

  get rows(): number {
    return this.currentRows;
  }

  get kittyProtocolActive(): boolean {
    return false;
  }

  setRows(rows: number): void {
    this.currentRows = rows;
  }

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

const testForegroundColours: Record<ThemeColor, string> = {
  accent: "#000000", border: "#000000", borderAccent: "#000000", borderMuted: "#000000",
  success: "#000000", error: "#000000", warning: "#000000", muted: "#000000", dim: "#000000",
  text: "#000000", thinkingText: "#000000", userMessageText: "#000000", customMessageText: "#000000",
  customMessageLabel: "#000000", toolTitle: "#000000", toolOutput: "#000000", mdHeading: "#000000",
  mdLink: "#000000", mdLinkUrl: "#000000", mdCode: "#000000", mdCodeBlock: "#000000",
  mdCodeBlockBorder: "#000000", mdQuote: "#000000", mdQuoteBorder: "#000000", mdHr: "#000000",
  mdListBullet: "#000000", toolDiffAdded: "#000000", toolDiffRemoved: "#000000", toolDiffContext: "#000000",
  syntaxComment: "#000000", syntaxKeyword: "#000000", syntaxFunction: "#000000", syntaxVariable: "#000000",
  syntaxString: "#000000", syntaxNumber: "#000000", syntaxType: "#000000", syntaxOperator: "#000000",
  syntaxPunctuation: "#000000", thinkingOff: "#000000", thinkingMinimal: "#000000", thinkingLow: "#000000",
  thinkingMedium: "#000000", thinkingHigh: "#000000", thinkingXhigh: "#000000", thinkingMax: "#000000",
  bashMode: "#000000",
};

type TestThemeBg = "selectedBg" | "userMessageBg" | "customMessageBg" | "toolPendingBg" | "toolSuccessBg" | "toolErrorBg";

const testBackgroundColours: Record<TestThemeBg, string> = {
  selectedBg: "#000000", userMessageBg: "#000000", customMessageBg: "#000000",
  toolPendingBg: "#000000", toolSuccessBg: "#000000", toolErrorBg: "#000000",
};

function testTheme(): Theme {
  return new Theme(testForegroundColours, testBackgroundColours, "truecolor");
}

function createTui(terminal: Terminal): TUI {
  return new TUI(terminal);
}

function harness(rows: readonly AgentRow[], terminalRows = 40) {
  const terminal = new FakeTerminal(terminalRows, 120);
  const tui = createTui(terminal);
  let view: AgentWidgetView = { model: replaceRows(emptyModel(), snapshot(rows)), sourceError: false, navigationLost: false };
  const shortcuts: string[] = [];
  const opened: string[] = [];
  let returnedFocus = 0;
  const component = new AgentWidgetComponent(
    tui,
    testTheme(),
    () => view,
    (next: AgentWidgetModel) => { view = { ...view, model: next }; },
    () => { returnedFocus += 1; },
    (ordinal) => { opened.push(String(ordinal)) },
    (data: string) => { shortcuts.push(data); return true; },
    (_error: unknown) => {},
  );
  return {
    component,
    shortcuts,
    opened,
    replace: (rows: readonly AgentRow[]) => { view = { ...view, model: replaceRows(view.model, snapshot(rows)) } },
    selected: () => view.model.selected,
    returnedFocus: () => returnedFocus,
    setTerminalRows: (rows: number) => { terminal.setRows(rows); },
  };
}

describe("AgentWidgetComponent", () => {
  test("enterFromEditor selects the first row and rowCount reports the model", () => {
    const h = harness([row("A1"), row("A2")]);
    expect(Number(h.component.rowCount())).toBe(2);
    h.component.enterFromEditor();
    expect(h.selected()).toBe(agentOrdinal("A1"));
  });

  test("Down and Up move the selection without wrapping", () => {
    const h = harness([row("A1"), row("A2")]);
    h.component.enterFromEditor();
    h.component.handleInput(DOWN);
    expect(h.selected()).toBe(agentOrdinal("A2"));
    expect(h.returnedFocus()).toBe(0);
    h.component.handleInput(DOWN);
    expect(h.selected()).toBe(agentOrdinal("A2"));
    expect(h.returnedFocus()).toBe(0);
    h.component.handleInput(UP);
    expect(h.selected()).toBe(agentOrdinal("A1"));
    expect(h.returnedFocus()).toBe(0);
  });

  test("Up from the first row and Escape both return focus and clear the marker", () => {
    for (const key of [UP, ESCAPE]) {
      const h = harness([row("A1"), row("A2")]);
      h.component.enterFromEditor();
      h.component.handleInput(key);
      expect(h.returnedFocus()).toBe(1);
      expect(h.selected()).toBe(undefined);
    }
  });

  test("Enter opens only the currently selected ordinal", () => {
    const h = harness([row("A1"), row("A2")]);
    h.component.handleInput("\r");
    expect(h.opened).toEqual([]);

    h.component.enterFromEditor();
    h.component.handleInput("\r");
    expect(h.opened).toEqual(["A1"]);
    expect(h.shortcuts).toEqual([]);
    expect(h.selected()).toBe(agentOrdinal("A1"));

    h.replace([]);
    h.component.handleInput("\r");
    expect(h.opened).toEqual(["A1"]);
  });

  test("a throwing conversation opener is reported and contained", () => {
    const boom = new Error("open boom");
    const reported: unknown[] = [];
    const view: AgentWidgetView = {
      model: selectFirst(replaceRows(emptyModel(), snapshot([row("A1")]))),
      sourceError: false, navigationLost: false,
    };
    const component = new AgentWidgetComponent(
      createTui(new FakeTerminal(40, 120)), testTheme(), () => view, () => {}, () => {},
      () => { throw boom }, () => false, (error: unknown) => { reported.push(error) },
    );

    expect(() => component.handleInput("\r")).not.toThrow();
    expect(reported).toEqual([boom]);
  });

  test("an unhandled key reaches onExtensionShortcut and is then dropped", () => {
    const h = harness([row("A1")]);
    h.component.enterFromEditor();
    h.component.handleInput("x");
    expect(h.shortcuts).toEqual(["x"]);
  });

  test("render recomputes the row budget from the terminal on every frame", () => {
    const rows = Array.from({ length: 8 }, (_, index) => row(`A${index + 1}`));
    const h = harness(rows, 40);
    expect(h.component.render(120)).toHaveLength(1 + 8);
    h.setTerminalRows(12);
    expect(h.component.render(120)).toHaveLength(1 + 3);
  });

  test("dispose is idempotent and cannot throw", () => {
    const h = harness([row("A1")]);
    expect(() => { h.component.dispose(); h.component.dispose(); }).not.toThrow();
  });

  test("view failures return safe render, count, input and entry fallbacks", () => {
    const boom = new Error("view boom");
    const reported: unknown[] = [];
    const tui = createTui(new FakeTerminal(40, 120));
    const component = new AgentWidgetComponent(
      tui, testTheme(), () => { throw boom; }, () => {}, () => {}, () => {}, () => false,
      (error: unknown) => { reported.push(error); },
    );
    expect(component.render(120)).toEqual([]);
    expect(Number(component.rowCount())).toBe(0);
    expect(() => component.handleInput("x")).not.toThrow();
    expect(() => component.enterFromEditor()).not.toThrow();
    expect(reported).toHaveLength(4);
  });

  test("a throwing model setter is reported and contained", () => {
    const boom = new Error("model boom");
    const reported: unknown[] = [];
    const view: AgentWidgetView = {
      model: replaceRows(emptyModel(), snapshot([row("A1")])),
      sourceError: false, navigationLost: false,
    };
    const tui = createTui(new FakeTerminal(40, 120));
    const component = new AgentWidgetComponent(
      tui, testTheme(), () => view, () => { throw boom; }, () => {}, () => {}, () => false,
      (error: unknown) => { reported.push(error); },
    );
    expect(() => component.enterFromEditor()).not.toThrow();
    expect(reported).toEqual([boom]);
  });

  test("a throwing focus callback is reported and contained", () => {
    const boom = new Error("focus boom");
    const reported: unknown[] = [];
    const view: AgentWidgetView = {
      model: selectFirst(replaceRows(emptyModel(), snapshot([row("A1")]))),
      sourceError: false, navigationLost: false,
    };
    const tui = createTui(new FakeTerminal(40, 120));
    const component = new AgentWidgetComponent(
      tui, testTheme(), () => view, () => {}, () => { throw boom; }, () => {}, () => false,
      (error: unknown) => { reported.push(error); },
    );
    expect(() => component.handleInput(UP)).not.toThrow();
    expect(reported).toEqual([boom]);
  });

  test("a throwing shortcut callback is reported and contained", () => {
    const boom = new Error("shortcut boom");
    const reported: unknown[] = [];
    const view: AgentWidgetView = {
      model: replaceRows(emptyModel(), snapshot([row("A1")])),
      sourceError: false, navigationLost: false,
    };
    const tui = createTui(new FakeTerminal(40, 120));
    const component = new AgentWidgetComponent(
      tui, testTheme(), () => view, () => {}, () => {}, () => {}, () => { throw boom; },
      (error: unknown) => { reported.push(error); },
    );
    expect(() => component.handleInput("x")).not.toThrow();
    expect(reported).toEqual([boom]);
  });

  test("a throwing TUI render request is reported and contained", () => {
    const boom = new Error("render boom");
    const reported: unknown[] = [];
    const tui = createTui(new FakeTerminal(40, 120));
    tui.requestRender = () => { throw boom; };
    const component = new AgentWidgetComponent(
      tui, testTheme(), () => { throw new Error("unused"); }, () => {}, () => {}, () => {}, () => false,
      (error: unknown) => { reported.push(error); },
    );
    expect(() => component.invalidate()).not.toThrow();
    expect(reported).toEqual([boom]);
  });

  test("a throwing reporter is contained", () => {
    const boom = new Error("boom");
    let reportedError: unknown;
    const tui = createTui(new FakeTerminal(40, 120));
    const component = new AgentWidgetComponent(
      tui, testTheme(), () => { throw boom; }, () => {}, () => {}, () => {}, () => false,
      (error: unknown) => {
        reportedError = error;
        throw new Error("report boom");
      },
    );
    expect(component.render(120)).toEqual([]);
    expect(reportedError).toBe(boom);
    expect(() => component.enterFromEditor()).not.toThrow();
  });
});
