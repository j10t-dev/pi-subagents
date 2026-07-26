import { Key, matchesKey, type Component, type Focusable, type TUI } from "@earendil-works/pi-tui";
import type { Theme } from "@earendil-works/pi-coding-agent";

import {
  clearSelection,
  moveSelection,
  rowBudget,
  selectFirst,
  type AgentWidgetModel,
} from "./model.ts";
import { renderRows, type AgentWidgetView } from "./render.ts";
import {
  renderWidth,
  terminalRows,
  widgetRowCount,
  type AgentOrdinal,
  type WidgetRowBudget,
  type WidgetRowCount,
} from "../domain.ts";

/**
 * A view over a model the extension owns. It holds no state that must survive a remount: it reads
 * through an accessor and writes selection changes back through a setter. `focused` exists purely
 * so the extension can ask whether this component holds focus — the TUI assigns it on every
 * transition, and `TUI` exposes no focus getter.
 */
export class AgentWidgetComponent implements Component, Focusable {
  /** `Focusable`: TUI writes this on every focus change (`pi-tui/dist/tui.d.ts:43-46`). */
  focused = false;

  constructor(
    private readonly tui: TUI,
    _theme: Theme,
    private readonly view: () => AgentWidgetView,
    private readonly applyModel: (next: AgentWidgetModel) => void,
    private readonly returnFocusToEditor: () => void,
    private readonly openConversation: (ordinal: AgentOrdinal) => void,
    private readonly forwardShortcut: (data: string) => boolean,
    private readonly reportError: (error: unknown) => void,
  ) {}

  render(width: number): string[] {
    return this.guard(() => {
      // `Component.render` supplies a raw number by Pi's public interface. Brand immediately.
      const safeWidth = renderWidth(width);
      // `Terminal.rows` is also a raw public Pi adapter value. Normalise before core use.
      const rows = terminalRows(this.tui.terminal.rows);
      return renderRows(this.view(), safeWidth, rowBudget(rows));
    }, []);
  }

  handleInput(data: string): void {
    this.guard(() => {
      const view = this.view();
      // `Terminal.rows` is raw only because Pi's public terminal contract requires it.
      const budget = rowBudget(terminalRows(this.tui.terminal.rows));
      if (matchesKey(data, Key.down)) return this.move(view.model, "down", budget);
      if (matchesKey(data, Key.up)) return this.move(view.model, "up", budget);
      if (matchesKey(data, Key.escape)) return this.exit(view.model);
      if (matchesKey(data, Key.enter)) {
        if (view.model.selected !== undefined) this.openConversation(view.model.selected);
        return;
      }
      // Everything else is offered to the app's shortcut dispatcher and then dropped.
      this.forwardShortcut(data);
    }, undefined);
  }

  invalidate(): void {
    this.guard(() => this.tui.requestRender(), undefined);
  }

  dispose(): void {
    // Pi removes a widget by disposing it before deleting the entry. Teardown added later must
    // remain in this guard.
    this.guard(() => {}, undefined);
  }

  rowCount(): WidgetRowCount {
    return this.guard(() => widgetRowCount(this.view().model.rows.length), widgetRowCount(0));
  }

  enterFromEditor(): void {
    this.guard(() => this.applyModel(selectFirst(this.view().model)), undefined);
  }

  private move(model: AgentWidgetModel, direction: "up" | "down", budget: WidgetRowBudget): void {
    const result = moveSelection(model, direction, budget);
    this.applyModel(result.model);
    if (result.exit) this.returnFocusToEditor();
    this.invalidate();
  }

  private exit(model: AgentWidgetModel): void {
    this.applyModel(clearSelection(model));
    this.returnFocusToEditor();
    this.invalidate();
  }

  private guard<T>(operation: () => T, fallback: T): T {
    try {
      return operation();
    } catch (error: unknown) {
      // The reporter is another extension boundary and may itself fail. At that point there is no
      // lower-risk diagnostic channel, so contain it and preserve the public method's fallback.
      try {
        this.reportError(error);
      } catch {
        // Nothing remains to try.
      }
      return fallback;
    }
  }
}
