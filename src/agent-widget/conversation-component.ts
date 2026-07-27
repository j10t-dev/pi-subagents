import type { KeybindingsManager, Theme } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth, type Component, type TUI } from "@earendil-works/pi-tui";

import type { ConversationSnapshot } from "../agent-observation.ts";
import { renderWidth, terminalRows } from "../domain.ts";
import {
  clampConversationLayout,
  moveConversation,
  replaceConversation,
  toggleConversationThinking,
  toggleConversationTools,
  type ChildConversationModel,
  type ConversationMovement,
} from "./conversation-model.ts";
import {
  createPiConversationAdapter,
  type PiConversationAdapter,
  type PiConversationAdapterFactories,
} from "./conversation-native-adapter.ts";
import { renderChildConversation, type ChildConversationRender } from "./conversation-render.ts";

export interface ChildConversationComponentOptions {
  readonly close: () => void;
  readonly report: (error: unknown) => void;
  /** Native adapter compatibility seam; production uses the package-root constructors. */
  readonly adapterFactories?: Partial<PiConversationAdapterFactories>;
}

/** Full-terminal, read-only child-conversation component. */
export class ChildConversationComponent implements Component {
  private model: ChildConversationModel;
  private disposed = false;
  private failed = false;
  private lastWidth: number | undefined;
  private readonly adapter: PiConversationAdapter;

  constructor(
    private readonly tui: TUI,
    private readonly theme: Theme,
    private readonly keybindings: KeybindingsManager,
    model: ChildConversationModel,
    private readonly options: ChildConversationComponentOptions,
  ) {
    this.model = model;
    this.adapter = createPiConversationAdapter({
      tui,
      theme,
      ...(options.adapterFactories === undefined ? {} : { factories: options.adapterFactories }),
    });
  }

  render(width: number): string[] {
    const safeWidth = renderWidth(width);
    const rows = terminalRows(this.tui.terminal.rows);
    this.lastWidth = Number(safeWidth);
    if (this.disposed || this.failed) return this.fallback(safeWidth, rows);
    return this.guard(() => {
      const reconciled = this.reconcile(this.model);
      this.model = reconciled.model;
      return this.cover(reconciled.rendered, safeWidth, rows);
    }, () => this.fallback(safeWidth, rows));
  }

  handleInput(data: string): void {
    if (this.disposed) return;
    this.guard(() => {
      if (this.keybindings.matches(data, "tui.select.cancel")) {
        this.options.close();
        return;
      }
      if (this.keybindings.matches(data, "tui.editor.cursorUp")) return this.move("up");
      if (this.keybindings.matches(data, "tui.editor.cursorDown")) return this.move("down");
      if (this.keybindings.matches(data, "tui.editor.pageUp")) return this.move("page-up");
      if (this.keybindings.matches(data, "tui.editor.pageDown")) return this.move("page-down");
      if (this.keybindings.matches(data, "app.thinking.toggle")) {
        this.apply(this.reconcile(toggleConversationThinking(this.model)).model);
        return;
      }
      if (this.keybindings.matches(data, "app.tools.expand")) {
        this.apply(this.reconcile(toggleConversationTools(this.model)).model);
        return;
      }
      if (data === "g") return this.move("top");
      if (data === "G") return this.move("tail");
      // A focused read-only fullscreen consumes every unrelated input.
    }, () => undefined);
  }

  setConversation(conversation: ConversationSnapshot): void {
    if (this.disposed) return;
    this.guard(() => {
      const provisional = Object.freeze({ ...this.model, conversation });
      const rendered = this.layoutFor(provisional);
      this.apply(replaceConversation(this.model, conversation, rendered.layout));
    }, () => undefined);
  }

  invalidate(): void {
    if (this.disposed) return;
    this.guard(() => {
      this.adapter.invalidate();
      this.tui.requestRender();
    }, () => undefined);
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.failed = true;
    this.guard(() => { this.adapter.dispose() }, () => undefined);
  }

  private move(movement: ConversationMovement): void {
    const reconciled = this.reconcile(this.model);
    this.apply(moveConversation(reconciled.model, movement, reconciled.rendered.layout));
  }

  private reconcile(model: ChildConversationModel): {
    readonly model: ChildConversationModel;
    readonly rendered: ChildConversationRender;
  } {
    const first = this.layoutFor(model);
    const reconciled = clampConversationLayout(model, first.layout);
    if (reconciled.lineOffset === model.lineOffset && reconciled.following === model.following) {
      return { model, rendered: first };
    }
    return { model: reconciled, rendered: this.layoutFor(reconciled) };
  }

  private layoutFor(model: ChildConversationModel): ChildConversationRender {
    const width = renderWidth(this.lastWidth ?? this.tui.terminal.columns);
    return renderChildConversation(
      model,
      this.theme,
      width,
      terminalRows(this.tui.terminal.rows),
      this.adapter,
    );
  }

  private apply(next: ChildConversationModel): void {
    this.model = next;
    this.tui.requestRender();
  }

  private cover(rendered: ChildConversationRender, width: ReturnType<typeof renderWidth>, rows: ReturnType<typeof terminalRows>): string[] {
    const result = rendered.lines.slice(0, Number(rows)).map((line) => this.pad(line, Number(width)));
    while (result.length < Number(rows)) result.push(this.pad("", Number(width)));
    return result;
  }

  private pad(line: string, width: number): string {
    const bounded = truncateToWidth(line, width, "");
    const missing = Math.max(0, width - visibleWidth(bounded));
    return bounded + (missing === 0 ? "" : this.theme.fg("text", " ".repeat(missing)));
  }

  private fallback(width: ReturnType<typeof renderWidth>, rows: ReturnType<typeof terminalRows>): string[] {
    return Array.from({ length: Number(rows) }, () => " ".repeat(Number(width)));
  }

  private guard<T>(operation: () => T, fallback: () => T): T {
    try {
      return operation();
    } catch (error: unknown) {
      this.failed = true;
      try { this.options.report(error) } catch { /* no lower-risk diagnostic channel */ }
      return fallback();
    }
  }
}
