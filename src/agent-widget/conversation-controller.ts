import type { KeybindingsManager, Theme } from "@earendil-works/pi-coding-agent";
import type { OverlayHandle, OverlayOptions, TUI } from "@earendil-works/pi-tui";

import type {
  AgentWidgetSource,
  SelectedTranscriptSnapshot,
  SelectedTranscriptSource,
} from "../agent-observation.ts";
import { createCoalescer, type Coalescer } from "../coalescer.ts";
import type { AgentOrdinal } from "../domain.ts";
import { WidgetDiagnosticCode, type WidgetDiagnosticCode as WidgetDiagnosticCodeValue } from "../widget-diagnostics.ts";
import { ChildConversationComponent } from "./conversation-component.ts";
import { createChildConversationModel } from "./conversation-model.ts";
import { projectConversationSnapshot } from "./conversation-projection.ts";

export const childConversationOverlayOptions: Readonly<OverlayOptions> = Object.freeze({
  width: "100%",
  maxHeight: "100%",
  row: 0,
  col: 0,
  margin: 0,
});

export interface ChildConversationController {
  open(ordinal: AgentOrdinal): void;
  close(): void;
  dispose(): void;
}

export interface ChildConversationControllerOptions {
  readonly source: () => AgentWidgetSource | undefined;
  readonly tui: TUI;
  readonly theme: Theme;
  readonly keybindings: KeybindingsManager;
  readonly onDiagnostic: (code: WidgetDiagnosticCodeValue) => void;
  readonly createCoalescer?: typeof createCoalescer;
}

/** Owns at most one selected source, fullscreen component and retained overlay handle. */
export function createChildConversationController(
  options: ChildConversationControllerOptions,
): ChildConversationController {
  let disposed = false;
  let generation = 0;
  let source: SelectedTranscriptSource | undefined;
  let unsubscribe: (() => void) | undefined;
  let coalescer: Coalescer | undefined;
  let component: ChildConversationComponent | undefined;
  let overlayHandle: OverlayHandle | undefined;
  let latest: SelectedTranscriptSnapshot | undefined;
  let unavailableReported = false;

  const report = (code: WidgetDiagnosticCodeValue): void => {
    try { options.onDiagnostic(code) } catch { /* diagnostic boundary */ }
  };
  const contain = (operation: () => void, code: WidgetDiagnosticCodeValue): void => {
    try { operation() } catch { report(code) }
  };

  const controller: ChildConversationController = {
    open: (ordinal): void => {
      if (disposed || source !== undefined || component !== undefined || overlayHandle !== undefined) return;
      let selected: SelectedTranscriptSource | undefined;
      try { selected = options.source()?.transcriptSource(ordinal) }
      catch { report(WidgetDiagnosticCode.SourceFailed); return }
      if (selected === undefined) {
        if (!unavailableReported) {
          unavailableReported = true;
          report(WidgetDiagnosticCode.ConversationUnavailable);
        }
        return;
      }

      generation += 1;
      const mine = generation;
      source = selected;
      try {
        latest = selected.snapshot();
        const model = createChildConversationModel(projectConversationSnapshot(latest));
        component = new ChildConversationComponent(options.tui, options.theme, options.keybindings, model, {
          close: controller.close,
          report: () => report(WidgetDiagnosticCode.ComponentFailed),
        });
        overlayHandle = options.tui.showOverlay(component, childConversationOverlayOptions);
        coalescer = (options.createCoalescer ?? createCoalescer)(() => {
          if (disposed || mine !== generation || component === undefined || latest === undefined) return;
          contain(
            () => component?.setConversation(projectConversationSnapshot(latest!)),
            WidgetDiagnosticCode.ComponentFailed,
          );
        });
        unsubscribe = selected.subscribe((snapshot) => {
          if (disposed || mine !== generation) return;
          latest = snapshot;
          coalescer?.request();
        });
      } catch {
        report(WidgetDiagnosticCode.ComponentFailed);
        controller.close();
      }
    },

    close: (): void => {
      if (source === undefined && component === undefined && overlayHandle === undefined && unsubscribe === undefined && coalescer === undefined) return;
      generation += 1;
      latest = undefined;

      const heldHandle = overlayHandle;
      overlayHandle = undefined;
      if (heldHandle !== undefined) contain(() => heldHandle.hide(), WidgetDiagnosticCode.ComponentFailed);

      const heldComponent = component;
      component = undefined;
      if (heldComponent !== undefined) contain(() => heldComponent.dispose(), WidgetDiagnosticCode.ComponentFailed);

      const heldCoalescer = coalescer;
      coalescer = undefined;
      if (heldCoalescer !== undefined) contain(() => heldCoalescer.dispose(), WidgetDiagnosticCode.ComponentFailed);

      const heldUnsubscribe = unsubscribe;
      unsubscribe = undefined;
      if (heldUnsubscribe !== undefined) contain(() => heldUnsubscribe(), WidgetDiagnosticCode.SourceFailed);
      source = undefined;
    },

    dispose: (): void => {
      if (disposed) return;
      disposed = true;
      controller.close();
    },
  };

  return controller;
}
