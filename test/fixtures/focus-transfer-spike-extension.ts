/**
 * Real-Pi Gate A focus-transfer spike fixture (subagent-ui-ux B0).
 *
 * PI_FOCUS_SPIKE_MODE selects the mechanism under test:
 * - "primary":  a CustomEditor intercepts bare Down from an EMPTY editor and calls
 *               handle.focus() on a PERSISTENT bottom-anchored overlay board (both editor and
 *               board stay visible). Up on the board's first row calls handle.unfocus(),
 *               returning input to the editor without closing the board. Non-empty editors keep
 *               native arrow behaviour.
 * - "fallback": a registerShortcut("alt+g") opens the board as a MODAL ctx.ui.custom() that
 *               closes on return; no bare-arrow interception. Degraded mechanism.
 *
 * alt+t opens a self-owned modal "selector" that records ownership of its own Down — the
 * non-vacuous interference control.
 *
 * NOTE (reconciled empirically against the current global Pi API): pi.registerShortcut() does NOT override a
 * default keybinding — a shortcut bound to an already-bound key (e.g. ctrl+g = app.editor.external,
 * ctrl+t = thinking toggle) never fires; the built-in action wins. The spike therefore binds
 * default-free keys alt+t / alt+g (sent as ESC-prefixed bytes "\x1bt"/"\x1bg"). See docs/keybindings.md.
 *
 * Uses ONLY documented public APIs (docs/tui.md): setEditorComponent, CustomEditor,
 * ctx.ui.custom() + onHandle + handle.focus()/unfocus(), setWidget, registerShortcut.
 * No private focusedComponent access.
 *
 * Reconciled against the installed global Pi .d.ts:
 * - CustomEditor(tui, theme, keybindings, options?) — 4-arg constructor, tui first.
 * - ctx.ui.getEditorComponent(): EditorFactory | undefined — returns the FACTORY, invoked here
 *   to build the composed base instance (not a component instance as an earlier draft assumed).
 * - ctx.ui.custom(factory, { overlay, overlayOptions, onHandle }) — onHandle is a top-level
 *   sibling of overlayOptions; OverlayHandle exposes focus()/unfocus()/hide()/setHidden().
 * - Component requires invalidate(): void — SpikeBoard/SpikeSelector implement it.
 */
import { appendFileSync } from "node:fs";

import { CustomEditor, type ExtensionFactory } from "@earendil-works/pi-coding-agent";
import type { OverlayHandle } from "@earendil-works/pi-tui";

const RESULT_FILE = process.env.PI_FOCUS_SPIKE_RESULT_FILE;
const MODE = process.env.PI_FOCUS_SPIKE_MODE === "fallback" ? "fallback" : "primary";

let sequence = 0;
function record(line: string): void {
  if (RESULT_FILE === undefined) return;
  appendFileSync(RESULT_FILE, `${++sequence} ${line}\n`);
}

const KEY_UP = "\x1b[A";
const KEY_DOWN = "\x1b[B";

/**
 * Minimal board component. `render(width)` returns string[] per the pi-tui Component contract
 * (docs/tui.md Pattern 7 shows `render(width): string[]`). Up/Down move the selection without
 * wrapping; Up on the first row invokes `onReturn` (which unfocuses the overlay) but does NOT
 * close it — the board stays mounted.
 */
class SpikeBoard {
  private selected = 0;
  private readonly rows = ["A1 board row one", "A1 board row two"];

  constructor(private readonly onReturn: () => void) {}

  render(_width: number): string[] {
    // BOARD_MARKER is unique to this overlay (the display-only belowEditor widget never renders it),
    // so the runner can prove the mounted board was actually on screen, not just the widget.
    return ["Subagents overlay board [BOARD_MARKER]", ...this.rows.map((row, i) => `${i === this.selected ? "> " : "  "}${row}`)];
  }

  invalidate(): void {}

  handleInput(data: string): void {
    if (data === KEY_UP) {
      if (this.selected === 0) { record("board_up_from_first_unfocuses"); this.onReturn(); return; }
      this.selected -= 1; record(`board_select=${this.selected}`); return;
    }
    if (data === KEY_DOWN) {
      if (this.selected < this.rows.length - 1) this.selected += 1;
      record(`board_select=${this.selected}`);
    }
  }
}

/** Self-owned modal selector: proves a focused component consumes its own Down (interference). */
class SpikeSelector {
  constructor(private readonly done: () => void) {}
  render(_width: number): string[] { return ["spike selector", "  down to test ownership"]; }
  invalidate(): void {}
  handleInput(data: string): void {
    if (data === KEY_DOWN) { record("spike_selector_down"); return; }
    if (data === "\x1b") { record("spike_selector_closed"); this.done(); }
  }
}

const factory: ExtensionFactory = (pi) => {
  pi.on("session_start", (_event, ctx) => {
    if (ctx.mode !== "tui") return;

    // Display-only widget standing in for the eventual agent board; not a focus target. Its
    // presence in the PTY log confirms setWidget(...belowEditor) renders on the current Pi API.
    ctx.ui.setWidget("focus-spike-board", ["Subagents", "  A1 board row one"], { placement: "belowEditor" });

    // Self-owned interference control, available in both modes.
    pi.registerShortcut("alt+t", {
      description: "Open spike selector (interference control)",
      handler: () => { record("spike_selector_opened"); void ctx.ui.custom<void>((_t, _th, _kb, done) => new SpikeSelector(() => done(undefined))); },
    });

    if (MODE === "fallback") {
      pi.registerShortcut("alt+g", {
        description: "Open subagent board (modal)",
        handler: () => {
          record("shortcut_triggered");
          void (async () => {
            record("board_opened");
            await ctx.ui.custom<void>((_t, _th, _kb, done) => new SpikeBoard(() => done(undefined))); // modal: onReturn === done
            record("board_closed");
          })();
        },
      });
      record("fixture_ready mode=fallback");
      return;
    }

    // primary: prove custom-editor COMPOSITION (design §Focus rules mandates it). First install a
    // BASE custom editor, then capture its FACTORY with getEditorComponent() and compose the
    // transfer wrapper OVER a fresh base instance — delegating all non-transfer input and rendering
    // to the base rather than replacing it. The base records a sentinel so the runner can prove
    // delegation reached it.
    ctx.ui.setEditorComponent((tui, theme, keybindings) =>
      new (class extends CustomEditor {
        override handleInput(data: string): void {
          if (data === "!") { record("base_editor_delegated"); return; } // sentinel: not inserted
          super.handleInput(data);
        }
      })(tui, theme, keybindings),
    );
    // getEditorComponent() returns the currently-installed editor FACTORY (EditorFactory | undefined);
    // the wrapper invokes it to build the composed base and hands non-transfer keys to it.
    const capturedBaseFactory = ctx.ui.getEditorComponent();
    if (capturedBaseFactory === undefined) {
      // Per the design, a non-composable editor surface is a Gate A stop, not a silent replace.
      record("composition_unsupported getEditorComponent_returned_undefined");
      return;
    }

    // Open a PERSISTENT bottom-anchored overlay board; capture its handle; start it unfocused so
    // the editor owns input. The wrapper transfers focus to it on empty-Down.
    let boardHandle: OverlayHandle | undefined;
    void ctx.ui.custom<void>(
      (_t, _th, _kb, _done) => new SpikeBoard(() => boardHandle?.unfocus()),
      {
        overlay: true,
        overlayOptions: { anchor: "bottom-center" },
        // onHandle is a top-level sibling of overlayOptions (per types.d.ts). Start unfocused so the
        // editor owns input at session start; the wrapper transfers focus in on empty-Down.
        onHandle: (handle) => { boardHandle = handle; handle.unfocus(); },
      },
    );

    ctx.ui.setEditorComponent((tui, theme, keybindings) => {
      const base = capturedBaseFactory(tui, theme, keybindings); // compose over a fresh base instance
      return new (class extends CustomEditor {
        override handleInput(data: string): void {
          // Emptiness is read from the COMPOSED base, since that holds the real buffer.
          const composedEmpty = base.getText().length === 0;
          if (data === KEY_DOWN && composedEmpty) {
            record("editor_down_empty_focuses_board");
            boardHandle?.focus();
            record("board_focused");
            return;
          }
          if (data === KEY_DOWN) { record("editor_down_nonempty_native"); base.handleInput(data); return; }
          // App-level keys (extension shortcuts) must route through the MOUNTED wrapper: it is the
          // only app-wired editor, whereas a factory-built base instance has no onExtensionShortcut
          // wiring. Give the wrapper's app layer first refusal, then delegate the rest (text, `!`,
          // ctrl+u editing keys) to the composed base. onExtensionShortcut is a documented public
          // CustomEditor member (see custom-editor.d.ts).
          if (this.onExtensionShortcut?.(data) === true) return;
          base.handleInput(data); // compose: delegate every non-transfer, non-shortcut key to the base editor
        }
        override render(width: number): string[] { return base.render(width); } // show the composed editor
      })(tui, theme, keybindings);
    });
    record("fixture_ready mode=primary");
  });
};

export default factory;
