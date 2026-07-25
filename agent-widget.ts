import {
  CustomEditor,
  getAgentDir,
  type ExtensionAPI,
  type ExtensionContext,
  type ExtensionFactory,
} from "@earendil-works/pi-coding-agent";
import { Key, matchesKey, type EditorComponent, type TUI } from "@earendil-works/pi-tui";

import type { SubagentObservationPort } from "./src/agent-observation.ts";
import { acquireStatusLease, type StatusLease } from "./src/ambient-status-lease.ts";
import { AgentWidgetComponent } from "./src/agent-widget/component.ts";
import { clearSelection, emptyModel, replaceRows, type AgentWidgetModel } from "./src/agent-widget/model.ts";
import type { AgentWidgetView } from "./src/agent-widget/render.ts";
import { createAgentWidgetSource } from "./src/agent-widget/source.ts";
import { MAX_WIDGET_ROWS } from "./src/constants.ts";
import { onObservationPort } from "./src/observation-registry.ts";
import { absolutePath } from "./src/paths.ts";

const WIDGET_KEY = "pi-subagents-agents";
const RENDER_COALESCE_MS = 50;
const ANSI_SEQUENCE = /\u001b(?:\[[0-?]*[ -/]*[@-~]|\][^\u0007]*(?:\u0007|\u001b\\))/gu;
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f-\u009f]/gu;

type WidgetSource = ReturnType<typeof createAgentWidgetSource>;
type EditorFactory = NonNullable<ReturnType<ExtensionContext["ui"]["getEditorComponent"]>>;

interface ShortcutEditor {
  onExtensionShortcut?: (data: string) => boolean;
}

function shortcutTarget(editor: EditorComponent): ShortcutEditor | undefined {
  const candidate: EditorComponent & Partial<ShortcutEditor> = editor;
  return typeof candidate.onExtensionShortcut === "function" ? candidate : undefined;
}

export interface AgentWidgetDeps {
  readonly createSource: (port: SubagentObservationPort, onDiagnostic: (code: string) => void) => WidgetSource;
}

const productionDeps: AgentWidgetDeps = {
  createSource: (port, onDiagnostic) => createAgentWidgetSource(port, {
    agentDir: absolutePath(getAgentDir()),
    maxRows: MAX_WIDGET_ROWS,
    onDiagnostic,
  }),
};

type AgentWidgetExtensionFactory = ExtensionFactory & ((pi: ExtensionAPI, deps?: AgentWidgetDeps) => void);

const createAgentWidgetExtension: AgentWidgetExtensionFactory = (pi: ExtensionAPI, deps: AgentWidgetDeps = productionDeps) => {
  let stop: (() => void) | undefined;
  pi.on("session_shutdown", (_event, ctx) => {
    const previous = stop;
    stop = undefined;
    try { previous?.(); } catch (error) { reportLifecycleError(ctx, error); }
  });
  pi.on("session_start", (_event, ctx) => {
    const previous = stop;
    stop = undefined;
    try { previous?.(); stop = start(ctx, deps); } catch (error) { reportLifecycleError(ctx, error); }
  });
};

function reportLifecycleError(ctx: ExtensionContext, error: unknown): void {
  notify(ctx, `Subagent widget error: ${message(error)}`);
}

function notify(ctx: ExtensionContext, text: string): void {
  try { ctx.ui.notify(sanitisePresentation(text), "warning"); } catch { /* diagnostic boundary */ }
}

export default createAgentWidgetExtension;

function emptyView(): AgentWidgetView {
  return { model: emptyModel(), sourceError: false, navigationLost: false };
}

function start(ctx: ExtensionContext, deps: AgentWidgetDeps): () => void {
  if (ctx.mode !== "tui") return () => {};

  let widget: AgentWidgetComponent | undefined;
  let editorRef: EditorComponent | undefined;
  let tuiRef: TUI | undefined;
  let installedFactory: EditorFactory | undefined;
  let navigationLost = false;
  let view = emptyView();
  let mounted = false;
  let generation = 0;
  let currentSource: WidgetSource | undefined;
  let unsubscribeRows: (() => void) | undefined;
  let unsubscribePort: (() => void) | undefined;
  let renderTimer: ReturnType<typeof setTimeout> | undefined;
  let lease: StatusLease | undefined;

  const report = (error: unknown): void => {
    notify(ctx, `Subagent widget error: ${message(error)}`);
  };
  const guard = <T>(operation: () => T): T | undefined => {
    try { return operation(); } catch (error) { report(error); return undefined; }
  };
  const acquire = (): void => { if (lease === undefined) lease = guard(acquireStatusLease); };
  const release = (): void => {
    const held = lease;
    lease = undefined;
    if (held !== undefined) guard(() => held.release());
  };
  const cancelScheduledRender = (): void => {
    if (renderTimer !== undefined) clearTimeout(renderTimer);
    renderTimer = undefined;
  };
  const scheduleRender = (forGeneration: number): void => {
    if (renderTimer !== undefined) return;
    renderTimer = setTimeout(() => {
      renderTimer = undefined;
      if (forGeneration === generation) guard(() => widget?.invalidate());
    }, RENDER_COALESCE_MS);
  };

  const editorLive = (): boolean => {
    if (installedFactory === undefined) return false;
    const live = guard(() => ctx.ui.getEditorComponent() === installedFactory) === true;
    if (!live && !navigationLost) {
      navigationLost = true;
      guard(() => notify(ctx, "Subagent widget: another extension replaced the editor; arrow navigation unavailable."));
      editorRef = undefined;
      view = { ...view, model: clearSelection(view.model) };
      guard(() => widget?.invalidate());
    }
    return live;
  };
  const currentView = (): AgentWidgetView => {
    editorLive();
    return { ...view, navigationLost };
  };
  const canTransferFocus = (): boolean => {
    if (tuiRef === undefined) return false;
    editorLive();
    return editorRef !== undefined;
  };
  const returnFocusToEditor = (): void => {
    if (!canTransferFocus()) return;
    guard(() => {
      tuiRef!.setFocus(editorRef!);
      tuiRef!.requestRender();
    });
  };
  const forwardShortcut = (data: string): boolean => {
    if (!editorLive() || editorRef === undefined) return false;
    return guard(() => shortcutTarget(editorRef!)?.onExtensionShortcut?.(data) ?? false) ?? false;
  };
  const applyModel = (next: AgentWidgetModel): void => {
    view = { ...view, model: next };
    guard(() => widget?.invalidate());
  };
  const mount = (): void => {
    if (mounted) return;
    try {
      ctx.ui.setWidget(WIDGET_KEY, (tui, theme) => {
        tuiRef = tui;
        widget = new AgentWidgetComponent(tui, theme, currentView, applyModel, returnFocusToEditor, forwardShortcut, report);
        return widget;
      }, { placement: "belowEditor" });
    } catch (error) {
      widget = undefined;
      report(error);
      try { ctx.ui.setWidget(WIDGET_KEY, undefined); } catch (cleanupError) { report(cleanupError); }
      return;
    }
    mounted = true;
    acquire();
  };
  const unmount = (): void => {
    if (!mounted) {
      view = emptyView();
      return;
    }
    if (widget?.focused === true) returnFocusToEditor();
    widget = undefined;
    mounted = false;
    view = emptyView();
    try { guard(() => ctx.ui.setWidget(WIDGET_KEY, undefined)); } finally { release(); }
  };
  const onRows = (source: WidgetSource, forGeneration: number): void => {
    if (forGeneration !== generation) return;
    try {
      view = { ...view, model: replaceRows(view.model, source.snapshot()), sourceError: false };
    } catch (error) {
      view = { ...view, sourceError: true };
      report(error);
    }
    if (Number(view.model.total) === 0 && !view.sourceError) unmount();
    else { mount(); scheduleRender(forGeneration); }
  };

  let previous: EditorFactory | undefined;
  try { previous = ctx.ui.getEditorComponent(); } catch (error) { report(error); return () => {}; }
  const factory: EditorFactory = (tui, theme, keybindings) => {
    const editor = previous?.(tui, theme, keybindings) ?? new CustomEditor(tui, theme, keybindings);
    try {
      const inherited = editor.handleInput.bind(editor);
      editor.handleInput = (data: string): void => {
        guard(() => {
          if (matchesKey(data, Key.down) && canTransferFocus() && editor.getText().length === 0 && (widget?.rowCount() ?? 0) > 0) {
            widget?.enterFromEditor();
            tui.setFocus(widget!);
            tui.requestRender();
            return;
          }
          inherited(data);
        });
      };
      editorRef = editor;
    } catch (error) {
      report(error);
      navigationLost = true;
      editorRef = undefined;
    }
    return editor;
  };
  installedFactory = factory;
  if (guard(() => { ctx.ui.setEditorComponent(factory); return true; }) !== true) {
    navigationLost = true;
    installedFactory = undefined;
  }

  unsubscribePort = guard(() => onObservationPort((port) => {
    guard(() => {
      generation += 1;
      const mine = generation;
      cancelScheduledRender();
      guard(() => unsubscribeRows?.());
      unsubscribeRows = undefined;
      guard(() => currentSource?.dispose());
      currentSource = undefined;
      unmount();
      if (port === undefined) return;
      const source = guard(() => deps.createSource(port, (code) => guard(() => notify(ctx, `Subagent widget: ${code}`))));
      currentSource = source;
      if (source === undefined) {
        view = { ...view, sourceError: true };
        mount();
        guard(() => widget?.invalidate());
        return;
      }
      unsubscribeRows = guard(() => source.subscribe(() => guard(() => onRows(source, mine))));
      onRows(source, mine);
      if (unsubscribeRows === undefined) {
        generation += 1;
        view = { ...view, sourceError: true };
        if (!mounted) mount();
        guard(() => widget?.invalidate());
      }
    });
  }));

  return (): void => {
    generation += 1;
    cancelScheduledRender();
    guard(() => unsubscribePort?.());
    unsubscribePort = undefined;
    guard(() => unsubscribeRows?.());
    unsubscribeRows = undefined;
    guard(() => currentSource?.dispose());
    currentSource = undefined;
    unmount();
    release();
    guard(() => ctx.ui.setEditorComponent(previous));
  };
}

function message(error: unknown): string {
  try { return error instanceof Error ? error.message : String(error); } catch { return "unknown error"; }
}

function sanitisePresentation(value: string): string {
  const sanitised = value.replace(ANSI_SEQUENCE, "").replace(CONTROL_CHARACTERS, " ").replace(/\s+/gu, " ").trim();
  return sanitised === "" ? "unknown error" : sanitised;
}
