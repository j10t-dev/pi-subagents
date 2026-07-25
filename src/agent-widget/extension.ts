import {
  CustomEditor,
  getAgentDir,
  type ExtensionAPI,
  type ExtensionContext,
  type ExtensionFactory,
} from "@earendil-works/pi-coding-agent";
import { Key, matchesKey, type EditorComponent, type TUI } from "@earendil-works/pi-tui";

import type { SubagentObservationPort } from "../agent-observation.ts";
import { acquireStatusLease, type StatusLease } from "../ambient-status-lease.ts";
import { createCoalescer, type Coalescer } from "../coalescer.ts";
import { parseExtensionLaunchContext, type ExtensionLaunchContext } from "../delegation-policy.ts";
import { agentId, milliseconds, type AbsolutePath } from "../domain.ts";
import { createObservationRelay, type ObservationRelay } from "../observation-relay.ts";
import { AgentWidgetComponent } from "./component.ts";
import { clearSelection, emptyModel, replaceRows, type AgentWidgetModel } from "./model.ts";
import type { AgentWidgetView } from "./render.ts";
import { createAgentWidgetSource } from "./source.ts";
import { MAX_WIDGET_ROWS } from "../constants.ts";
import type { WidgetTraceEvent } from "../domain.ts";
import { onObservationPort } from "../observation-registry.ts";
import { absolutePath } from "../paths.ts";
import {
  WidgetDiagnosticCode,
  widgetDiagnostic,
  type WidgetDiagnosticCode as WidgetDiagnosticCodeValue,
} from "../widget-diagnostics.ts";

const WIDGET_KEY = "pi-subagents-agents";
const RENDER_COALESCE_WINDOW_MS = milliseconds(50);

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
  readonly createSource?: (port: SubagentObservationPort, onDiagnostic: (code: string) => void) => WidgetSource;
  readonly subscribePort?: typeof onObservationPort;
  readonly createRelay?: typeof createObservationRelay;
  readonly createCoalescer?: typeof createCoalescer;
  readonly launchContext?: ExtensionLaunchContext;
  readonly agentDir?: AbsolutePath;
  /** Gate-only observation seam. Production supplies no trace dependency. */
  readonly trace?: (event: WidgetTraceEvent) => void;
}

const productionCreateSource = (port: SubagentObservationPort, onDiagnostic: (code: string) => void): WidgetSource =>
  createAgentWidgetSource(port, {
    agentDir: absolutePath(getAgentDir()),
    maxRows: MAX_WIDGET_ROWS,
    onDiagnostic,
  });

const productionDeps: AgentWidgetDeps = { createSource: productionCreateSource };

function sourceDiagnosticCode(code: string): WidgetDiagnosticCodeValue {
  return code === WidgetDiagnosticCode.WatchUnavailable
    ? WidgetDiagnosticCode.WatchUnavailable
    : WidgetDiagnosticCode.SourceFailed;
}

type AgentWidgetExtensionFactory = ExtensionFactory & ((pi: ExtensionAPI, deps?: AgentWidgetDeps) => void);
type WidgetCleanup = () => boolean;

const createAgentWidgetExtension: AgentWidgetExtensionFactory = (pi: ExtensionAPI, deps: AgentWidgetDeps = productionDeps) => {
  let stop: WidgetCleanup | undefined;
  const reported = new Set<WidgetDiagnosticCodeValue>();
  pi.on("session_shutdown", (_event, ctx) => {
    const previous = stop;
    try {
      if (previous === undefined || previous()) stop = undefined;
    } catch {
      notifyOnce(ctx, WidgetDiagnosticCode.LifecycleFailed, reported);
    }
  });
  pi.on("session_start", (_event, ctx) => {
    const previous = stop;
    try {
      if (previous !== undefined && !previous()) return;
      stop = start(ctx, deps, reported);
    } catch {
      notifyOnce(ctx, WidgetDiagnosticCode.LifecycleFailed, reported);
    }
  });
};

function notifyOnce(
  ctx: ExtensionContext,
  code: WidgetDiagnosticCodeValue,
  reported: Set<WidgetDiagnosticCodeValue>,
): void {
  if (reported.has(code)) return;
  reported.add(code);
  try { ctx.ui.notify(widgetDiagnostic(code), "warning"); } catch { /* diagnostic boundary */ }
}

export default createAgentWidgetExtension;

function emptyView(): AgentWidgetView {
  return { model: emptyModel(), sourceError: false, navigationLost: false };
}

function start(
  ctx: ExtensionContext,
  deps: AgentWidgetDeps,
  reported: Set<WidgetDiagnosticCodeValue>,
): WidgetCleanup {
  const launchContext = deps.launchContext ?? parseExtensionLaunchContext(process.env);
  if (launchContext.kind !== "root") return startPublisher(ctx, deps, reported);
  if (ctx.mode !== "tui") return () => true;
  return startAggregator(ctx, deps, reported);
}

function startPublisher(
  ctx: ExtensionContext,
  deps: AgentWidgetDeps,
  reported: Set<WidgetDiagnosticCodeValue>,
): WidgetCleanup {
  const report = (code: WidgetDiagnosticCodeValue): void => { notifyOnce(ctx, code, reported); };
  const relay: ObservationRelay = (deps.createRelay ?? createObservationRelay)({
    agentDir: deps.agentDir ?? absolutePath(getAgentDir()),
    sessionId: agentId(ctx.sessionManager.getSessionId()),
    diagnostic: report,
  });
  const coalescer: Coalescer = (deps.createCoalescer ?? createCoalescer)(() => relay.flush());
  let stopping = false;
  let relayDisposed = false;
  let coalescerDisposed = false;
  let unsubscribeRegistry: (() => void) | undefined;
  let unsubscribePort: (() => void) | undefined;

  const releasePort = (): boolean => {
    const pending = unsubscribePort;
    if (pending === undefined) return true;
    try {
      pending();
      if (unsubscribePort === pending) unsubscribePort = undefined;
      return true;
    } catch {
      report(WidgetDiagnosticCode.SourceFailed);
      return false;
    }
  };
  const releaseRegistry = (): boolean => {
    const pending = unsubscribeRegistry;
    if (pending === undefined) return true;
    try {
      pending();
      if (unsubscribeRegistry === pending) unsubscribeRegistry = undefined;
      return true;
    } catch {
      report(WidgetDiagnosticCode.RegistryFailed);
      return false;
    }
  };
  const requestFlush = (): void => {
    relay.markDirty();
    coalescer.request();
  };
  const onPortChange = (): void => {
    if (!stopping) requestFlush();
  };
  const onRegistryPort = (port: SubagentObservationPort | undefined): void => {
    if (stopping) return;
    const released = releasePort();
    relay.setPort(port);
    if (port === undefined) return;
    if (released) {
      try { unsubscribePort = port.subscribe(onPortChange); }
      catch { report(WidgetDiagnosticCode.SourceFailed); }
    }
    requestFlush();
  };

  // This is intentionally the first publisher work: even a portless descendant owns its empty slot.
  requestFlush();
  try {
    unsubscribeRegistry = (deps.subscribePort ?? onObservationPort)(onRegistryPort);
  } catch {
    report(WidgetDiagnosticCode.RegistryFailed);
  }

  return (): boolean => {
    if (!stopping) stopping = true;
    if (!coalescerDisposed) {
      try { coalescer.dispose(); coalescerDisposed = true; }
      catch { report(WidgetDiagnosticCode.LifecycleFailed); }
    }
    if (!relayDisposed) {
      try { relay.dispose(); relayDisposed = true; }
      catch { report(WidgetDiagnosticCode.LifecycleFailed); }
    }
    const registryReleased = releaseRegistry();
    const portReleased = releasePort();
    return coalescerDisposed
      && relayDisposed
      && registryReleased
      && portReleased
      && unsubscribeRegistry === undefined
      && unsubscribePort === undefined;
  };
}

function startAggregator(
  ctx: ExtensionContext,
  deps: AgentWidgetDeps,
  reported: Set<WidgetDiagnosticCodeValue>,
): WidgetCleanup {

  let widget: AgentWidgetComponent | undefined;
  let editorRef: EditorComponent | undefined;
  let tuiRef: TUI | undefined;
  let installedFactory: EditorFactory | undefined;
  let navigationLost = false;
  let view = emptyView();
  let widgetRegistrationPending = false;
  let editorRestorePending = false;
  let stopping = false;
  let generation = 0;
  let currentSource: WidgetSource | undefined;
  let unsubscribeRows: (() => void) | undefined;
  let unsubscribePort: (() => void) | undefined;
  let renderCoalescer: Coalescer | undefined;
  let lease: StatusLease | undefined;

  const report = (code: WidgetDiagnosticCodeValue): void => { notifyOnce(ctx, code, reported); };
  const guard = <T>(
    operation: () => T,
    code: WidgetDiagnosticCodeValue = WidgetDiagnosticCode.ComponentFailed,
  ): T | undefined => {
    try { return operation(); } catch { report(code); return undefined; }
  };
  const trace = (event: WidgetTraceEvent): void => {
    if (deps.trace !== undefined) guard(() => deps.trace?.(event), WidgetDiagnosticCode.TraceFailed);
  };
  const acquire = (): void => { if (lease === undefined) lease = guard(acquireStatusLease, WidgetDiagnosticCode.StatusFailed); };
  const release = (): boolean => {
    const held = lease;
    if (held === undefined) return true;
    try {
      held.release();
      if (lease === held) lease = undefined;
      return true;
    } catch {
      report(WidgetDiagnosticCode.StatusFailed);
      return false;
    }
  };
  const cancelScheduledRender = (): void => {
    renderCoalescer?.dispose();
    renderCoalescer = undefined;
  };
  const scheduleRender = (forGeneration: number): void => {
    if (renderCoalescer !== undefined) {
      renderCoalescer.request();
      return;
    }
    const coalescer = (deps.createCoalescer ?? createCoalescer)(() => {
      if (renderCoalescer === coalescer) renderCoalescer = undefined;
      if (forGeneration === generation) guard(() => widget?.invalidate());
    }, undefined, RENDER_COALESCE_WINDOW_MS);
    renderCoalescer = coalescer;
    coalescer.request();
  };

  const editorLive = (): boolean => {
    if (installedFactory === undefined) return false;
    const live = guard(() => ctx.ui.getEditorComponent() === installedFactory, WidgetDiagnosticCode.EditorFailed) === true;
    if (!live && !navigationLost) {
      navigationLost = true;
      report(WidgetDiagnosticCode.EditorReplaced);
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
      trace("editor-refocused");
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
  const unmount = (): boolean => {
    view = emptyView();
    if (widgetRegistrationPending) {
      const registeredWidget = widget;
      // Focus ownership is an independent, fallible Pi boundary. Failure to read it must not skip
      // removal or any other independently retryable cleanup operation.
      if (guard(() => registeredWidget?.focused === true, WidgetDiagnosticCode.ComponentFailed) === true) {
        guard(returnFocusToEditor, WidgetDiagnosticCode.EditorFailed);
      }
      const removed = guard(
        () => { ctx.ui.setWidget(WIDGET_KEY, undefined); return true; },
        WidgetDiagnosticCode.UnmountFailed,
      ) === true;
      if (!removed) return false;
      widget = undefined;
      tuiRef = undefined;
      widgetRegistrationPending = false;
    }
    return release();
  };
  const mount = (): void => {
    if (widgetRegistrationPending) return;
    // Pi may register the widget and then throw. Claim cleanup ownership before crossing that
    // boundary, and retain it until an explicit removal succeeds.
    widgetRegistrationPending = true;
    acquire();
    try {
      ctx.ui.setWidget(WIDGET_KEY, (tui, theme) => {
        tuiRef = tui;
        widget = new AgentWidgetComponent(
          tui,
          theme,
          currentView,
          applyModel,
          returnFocusToEditor,
          forwardShortcut,
          () => report(WidgetDiagnosticCode.ComponentFailed),
        );
        return widget;
      }, { placement: "belowEditor" });
    } catch {
      report(WidgetDiagnosticCode.MountFailed);
      unmount();
    }
  };
  const unsubscribeFromRows = (): boolean => {
    const pending = unsubscribeRows;
    if (pending === undefined) return true;
    try {
      pending();
      if (unsubscribeRows === pending) unsubscribeRows = undefined;
      return true;
    } catch {
      report(WidgetDiagnosticCode.SourceFailed);
      return false;
    }
  };
  const disposeSource = (): boolean => {
    const pending = currentSource;
    if (pending === undefined) return true;
    try {
      pending.dispose();
      if (currentSource === pending) currentSource = undefined;
      return true;
    } catch {
      report(WidgetDiagnosticCode.SourceFailed);
      return false;
    }
  };
  const unsubscribeFromRegistry = (): boolean => {
    const pending = unsubscribePort;
    if (pending === undefined) return true;
    try {
      pending();
      if (unsubscribePort === pending) unsubscribePort = undefined;
      return true;
    } catch {
      report(WidgetDiagnosticCode.RegistryFailed);
      return false;
    }
  };
  const restoreEditor = (): boolean => {
    if (!editorRestorePending) return true;
    try {
      ctx.ui.setEditorComponent(previous);
      editorRestorePending = false;
      return true;
    } catch {
      report(WidgetDiagnosticCode.EditorFailed);
      return false;
    }
  };
  const onRows = (source: WidgetSource, forGeneration: number): void => {
    if (forGeneration !== generation) return;
    try {
      view = { ...view, model: replaceRows(view.model, source.snapshot()), sourceError: false };
    } catch {
      view = { ...view, sourceError: true };
      report(WidgetDiagnosticCode.SourceFailed);
    }
    if (Number(view.model.total) === 0 && !view.sourceError) unmount();
    else { mount(); scheduleRender(forGeneration); }
  };

  let previous: EditorFactory | undefined;
  try { previous = ctx.ui.getEditorComponent(); }
  catch { report(WidgetDiagnosticCode.EditorFailed); return () => true; }
  const factory: EditorFactory = (tui, theme, keybindings) => {
    const editor = previous?.(tui, theme, keybindings) ?? new CustomEditor(tui, theme, keybindings);
    try {
      const inherited = editor.handleInput.bind(editor);
      editor.handleInput = (data: string): void => {
        guard(() => {
          if (matchesKey(data, Key.down) && canTransferFocus() && editor.getText().length === 0 && Number(widget?.rowCount() ?? 0) > 0) {
            widget?.enterFromEditor();
            tui.setFocus(widget!);
            tui.requestRender();
            trace("widget-focused");
            return;
          }
          if (matchesKey(data, Key.down) && editor.getText().length > 0) trace("native-arrow");
          inherited(data);
        });
      };
      editorRef = editor;
    } catch {
      report(WidgetDiagnosticCode.EditorFailed);
      navigationLost = true;
      editorRef = undefined;
    }
    return editor;
  };
  installedFactory = factory;
  editorRestorePending = true;
  if (guard(
    () => { ctx.ui.setEditorComponent(factory); return true; },
    WidgetDiagnosticCode.EditorFailed,
  ) !== true) {
    navigationLost = true;
    installedFactory = undefined;
  }

  const subscribePort = deps.subscribePort ?? onObservationPort;
  unsubscribePort = guard(() => subscribePort((port) => {
    guard(() => {
      if (stopping) return;
      generation += 1;
      const mine = generation;
      cancelScheduledRender();
      const rowsReleased = unsubscribeFromRows();
      const sourceReleased = disposeSource();
      const widgetReleased = unmount();
      if (!rowsReleased || !sourceReleased || !widgetReleased || port === undefined) return;
      const createSource = deps.createSource ?? productionCreateSource;
      const source = guard(
        () => createSource(port, (code) => report(sourceDiagnosticCode(code))),
        WidgetDiagnosticCode.SourceFailed,
      );
      currentSource = source;
      if (source === undefined) {
        view = { ...view, sourceError: true };
        mount();
        guard(() => widget?.invalidate());
        return;
      }
      unsubscribeRows = guard(
        () => source.subscribe(() => guard(() => onRows(source, mine), WidgetDiagnosticCode.SourceFailed)),
        WidgetDiagnosticCode.SourceFailed,
      );
      onRows(source, mine);
      if (unsubscribeRows === undefined) {
        generation += 1;
        view = { ...view, sourceError: true };
        if (!widgetRegistrationPending) mount();
        guard(() => widget?.invalidate());
      }
    });
  }));

  return (): boolean => {
    if (!stopping) {
      stopping = true;
      generation += 1;
      cancelScheduledRender();
    }
    const registryReleased = unsubscribeFromRegistry();
    const rowsReleased = unsubscribeFromRows();
    const sourceReleased = disposeSource();
    const widgetReleased = unmount();
    const editorRestored = restoreEditor();
    return registryReleased
      && rowsReleased
      && sourceReleased
      && widgetReleased
      && editorRestored
      && unsubscribePort === undefined
      && unsubscribeRows === undefined
      && currentSource === undefined
      && !widgetRegistrationPending
      && lease === undefined
      && !editorRestorePending;
  };
}

