import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "bun:test";
import {
  KeybindingsManager, TUI_KEYBINDINGS, type Component, type EditorComponent,
  type OverlayHandle, type TUI,
} from "@earendil-works/pi-tui";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import { createPiSubagentsExtension, type ExtensionController } from "../index.ts";
import createAgentWidgetExtension, { type AgentWidgetDeps } from "../src/agent-widget/extension.ts";
import { createChildConversationController } from "../src/agent-widget/conversation-controller.ts";
import type {
  AgentDisplayState, AgentObservation, AgentWidgetSnapshot, AgentWidgetSource,
  ObservationChange, SelectedTranscriptSource, SubagentObservationPort,
} from "../src/agent-observation.ts";
import { AgentObservationStore } from "../src/agent-observation-store.ts";
import { onObservationPort, publishObservationPort } from "../src/observation-registry.ts";
import { observationSnapshotPath, readKnownChildSnapshots } from "../src/observation-snapshot-path.ts";
import { RELAY_FLUSH_WINDOW_MS } from "../src/constants.ts";
import { parseExtensionLaunchContext } from "../src/delegation-policy.ts";
import { setAmbientStatus, onAmbientStatus } from "../src/ambient-status-lease.ts";
import {
  AgentState, agentCount, agentDepth, agentId, agentObservationRevision, agentOrdinal, agentWidgetRevision,
  contextPercent, directAgentOrdinal, modelSpec, observationRevision, selectedTranscriptRevision,
  transcriptRevision,
  type AgentId, type ContextLabel, type ModelLabel, type TaskLabel,
} from "../src/domain.ts";
import { extensionApiForTest, lifecycleOn, type ExtensionApiPort, type LifecycleHandler } from "./support/extension-api.ts";
import { awaitAgentSchema, sendInputSchema, spawnAgentSchema, stopAgentSchema } from "../src/tools.ts";
import { testAbsolutePath, testSessionPath } from "./support/brands.ts";

const DOWN = "\u001b[B";
const UP = "\u001b[A";

type WidgetFactory = (tui: TUI, theme: object) => Record<string, unknown>;
type EditorFactory = (tui: TUI, theme: object, keybindings: object) => EditorComponent;
type Handler = (event: object, context: object) => void;

function snapshotOf(count: number, total = count): AgentWidgetSnapshot {
  return {
    revision: agentWidgetRevision(1),
    rows: Array.from({ length: count }, (_, index) => ({
      ordinal: agentOrdinal(`A${index + 1}`), depth: agentDepth(0), model: "luna:h" as ModelLabel,
      context: "42%" as ContextLabel, taskLabel: "Research terminal UX" as TaskLabel,
      state: AgentState.Running as AgentDisplayState,
    })),
    total: agentCount(total), omitted: agentCount(Math.max(0, total - count)), degraded: true,
  };
}

function loadingConversationSource(): SelectedTranscriptSource {
  const selected = Object.freeze({
    revision: selectedTranscriptRevision(0),
    transcript: Object.freeze({
      revision: transcriptRevision(0), items: [], truncatedBefore: false, availability: "live" as const,
      sensitiveValues: { nativeIds: new Set<string>(), managedPathsAndNames: new Set<string>() },
    }),
    row: snapshotOf(1).rows[0]!,
    routeAvailable: true,
  });
  return { snapshot: () => selected, subscribe: () => () => {} };
}

function fakeSource(options: {
  onSnapshot?: () => AgentWidgetSnapshot;
  transcriptSource?: AgentWidgetSource["transcriptSource"];
  subscribeThrows?: boolean;
  unsubscribeFailures?: number;
  disposeFailures?: number;
} = {}) {
  let current = snapshotOf(0, 0);
  const listeners = new Set<() => void>();
  let unsubscribeFailures = options.unsubscribeFailures ?? 0;
  let disposeFailures = options.disposeFailures ?? 0;
  let unsubscribeAttempts = 0;
  let disposalAttempts = 0;
  const source: AgentWidgetSource & { dispose(): void } = {
    snapshot: () => options.onSnapshot ? options.onSnapshot() : current,
    transcriptSource: options.transcriptSource ?? (() => undefined),
    subscribe: (onChange) => {
      listeners.add(onChange);
      if (options.subscribeThrows) throw new Error("subscribe boom");
      return () => {
        unsubscribeAttempts += 1;
        if (unsubscribeFailures > 0) { unsubscribeFailures -= 1; throw new Error("unsubscribe boom"); }
        listeners.delete(onChange);
      };
    },
    dispose: () => {
      disposalAttempts += 1;
      if (disposeFailures > 0) { disposeFailures -= 1; throw new Error("dispose boom"); }
    },
  };
  return {
    source, disposals: () => disposalAttempts, unsubscribeAttempts: () => unsubscribeAttempts,
    emit: (next: AgentWidgetSnapshot) => { current = next; for (const listener of [...listeners]) listener(); },
    listenerCount: () => listeners.size,
  };
}

function harness(options: {
  mode?: string;
  modeError?: Error;
  modeThrows?: boolean;
  sources?: ReadonlyArray<ReturnType<typeof fakeSource>>;
  setWidgetThrowsOn?: "mount" | "unmount";
  mountThrowsAfterRegistration?: boolean;
  unmountFailures?: number;
  editorRestoreFailures?: number;
  registryUnsubscribeFailures?: number;
  notifyThrows?: boolean;
  createSourceThrows?: boolean;
  sourceDiagnostic?: string;
  createCoalescer?: NonNullable<AgentWidgetDeps["createCoalescer"]>;
  createConversationController?: NonNullable<AgentWidgetDeps["createConversationController"]>;
  editorThrowsOn?: "getEditorComponent" | "getText" | "inherited" | "setFocus" | "requestRender";
  trace?: (event: string) => void;
} = {}) {
  const widgets: Array<{ key: string; content: WidgetFactory | undefined }> = [];
  const notices: Array<{ message: string; type?: string }> = [];
  const focusCalls: object[] = [];
  let editorFactory: EditorFactory | undefined;
  let installed: EditorFactory | undefined;
  let inheritedFactory: EditorFactory | undefined;
  let unmountFailures = options.unmountFailures ?? 0;
  let editorRestoreFailures = options.editorRestoreFailures ?? 0;
  let editorRestoreAttempts = 0;
  let registryUnsubscribeFailures = options.registryUnsubscribeFailures ?? 0;
  let registryUnsubscribeAttempts = 0;
  let component: (Record<string, unknown> & { focused?: boolean }) | undefined;
  let editorText = "";
  const inherited: string[] = [];
  const shortcuts: string[] = [];
  const callbackTheme = {};
  const callbackKeybindings = new KeybindingsManager({
    ...TUI_KEYBINDINGS,
    "app.thinking.toggle": { defaultKeys: "ctrl+t" },
    "app.tools.expand": { defaultKeys: "ctrl+o" },
  });
  const overlayEntries: Array<{ readonly component: Component; readonly handle: OverlayHandle; readonly hides: () => number }> = [];
  const showOverlay = (overlayComponent: Component): OverlayHandle => {
    let hidden = false;
    let hides = 0;
    const handle: OverlayHandle = {
      hide: () => { if (!hidden) { hidden = true; hides += 1 } },
      setHidden: (next) => { hidden = next }, isHidden: () => hidden,
      focus: () => {}, unfocus: () => {}, isFocused: () => !hidden,
    };
    overlayEntries.push({ component: overlayComponent, handle, hides: () => hides });
    return handle;
  };
  const tui = {
    terminal: { rows: 40, columns: 120 },
    showOverlay,
    setFocus: (target: object) => { if (options.editorThrowsOn === "setFocus") throw new Error("focus boom"); focusCalls.push(target); },
    requestRender: () => { if (options.editorThrowsOn === "requestRender") throw new Error("render boom"); },
  } as TUI;
  const ctx = {
    get mode(): string {
      if (options.modeError !== undefined) throw options.modeError;
      if (options.modeThrows) throw new Error("mode boom");
      return options.mode ?? "tui";
    },
    sessionManager: { getSessionId: () => "aggregator-session" },
    ui: {
      setWidget: (key: string, content: WidgetFactory | undefined) => {
        const removing = content === undefined;
        if (options.setWidgetThrowsOn === "mount" && !removing) throw new Error("mount boom");
        if (options.setWidgetThrowsOn === "unmount" && removing) throw new Error("unmount boom");
        if (removing && unmountFailures > 0) { unmountFailures -= 1; throw new Error("unmount boom"); }
        widgets.push({ key, content });
        component = removing ? undefined : content!(tui, callbackTheme);
        if (!removing && options.mountThrowsAfterRegistration === true) throw new Error("post-registration mount boom");
      },
      setEditorComponent: (factory: EditorFactory | undefined) => {
        if (factory === inheritedFactory) {
          editorRestoreAttempts += 1;
          if (editorRestoreFailures > 0) { editorRestoreFailures -= 1; throw new Error("editor restore boom"); }
        }
        installed = factory;
        editorFactory = factory;
      },
      getEditorComponent: () => {
        if (options.editorThrowsOn === "getEditorComponent") throw new Error("editor accessor boom");
        return editorFactory;
      },
      notify: (message: string, type?: string) => {
        if (options.notifyThrows) throw new Error("notify boom");
        notices.push(type === undefined ? { message } : { message, type });
      },
      setStatus: () => {},
    },
  };
  editorFactory = (() => ({
    handleInput: (data: string) => { if (options.editorThrowsOn === "inherited") throw new Error("input boom"); inherited.push(data); },
    getText: () => { if (options.editorThrowsOn === "getText") throw new Error("text boom"); return editorText; },
    setText: () => {}, render: () => [], invalidate: () => {},
    onExtensionShortcut: (data: string) => { shortcuts.push(data); return true; },
  })) as EditorFactory;
  inheritedFactory = editorFactory;
  const handlers = new Map<string, Handler>();
  const pi = { on: (name: string, handler: Handler) => { handlers.set(name, handler); } };
  const queue = [...(options.sources ?? [fakeSource()])];
  const rootSessionIds: AgentId[] = [];
  const createSource: NonNullable<AgentWidgetDeps["createSource"]> = (_port, rootSessionId, onDiagnostic) => {
    rootSessionIds.push(rootSessionId);
    if (options.createSourceThrows) throw new Error("source constructor boom");
    if (options.sourceDiagnostic !== undefined) onDiagnostic(options.sourceDiagnostic);
    return (queue.shift() ?? fakeSource()).source;
  };
  createAgentWidgetExtension(pi as never, {
    launchContext: parseExtensionLaunchContext({}),
    createSource,
    subscribePort: (listener) => {
      const unsubscribe = onObservationPort(listener);
      return () => {
        registryUnsubscribeAttempts += 1;
        if (registryUnsubscribeFailures > 0) {
          registryUnsubscribeFailures -= 1;
          throw new Error("registry unsubscribe boom");
        }
        unsubscribe();
      };
    },
    ...(options.createCoalescer === undefined ? {} : { createCoalescer: options.createCoalescer }),
    ...(options.createConversationController === undefined ? {} : { createConversationController: options.createConversationController }),
    ...(options.trace === undefined ? {} : { trace: options.trace }),
  });
  handlers.get("session_start")?.({}, ctx);
  cleanups.push(() => { handlers.get("session_shutdown")?.({}, ctx); });
  const editor = installed?.(tui, callbackTheme, callbackKeybindings);
  return {
    widgets, notices, focusCalls, inherited, shortcuts, editor, rootSessionIds,
    callbackValues: { tui, theme: callbackTheme, keybindings: callbackKeybindings },
    overlayEntries,
    showSiblingOverlay: () => showOverlay({ render: () => ["sibling"], invalidate: () => {} }),
    component: () => component, setEditorText: (value: string) => { editorText = value; }, editorText: () => editorText,
    replaceEditorFactory: () => { editorFactory = (() => ({ render: () => [], invalidate: () => {}, getText: () => "", setText: () => {}, handleInput: () => {} })) as EditorFactory; },
    lines: () => (component?.render as ((width: number) => string[]) | undefined)?.(120) ?? [],
    start: () => handlers.get("session_start")?.({}, ctx),
    shutdown: () => handlers.get("session_shutdown")?.({}, ctx),
    editorRestored: () => editorFactory === inheritedFactory,
    editorRestoreAttempts: () => editorRestoreAttempts,
    registryUnsubscribeAttempts: () => registryUnsubscribeAttempts,
  };
}

const cleanups: Array<() => void> = [];
function publish(port: Partial<SubagentObservationPort> = {}) {
  const token = publishObservationPort({
    observation: () => undefined,
    directSnapshot: () => ({ kind: "unavailable", finalRevision: agentObservationRevision(1) }),
    transcriptSource: () => undefined, subscribe: () => () => {}, ...port,
  });
  cleanups.push(() => token.clear());
  return token;
}
function ambientRecorder(): { text: string | undefined } {
  const state: { text: string | undefined } = { text: undefined };
  cleanups.push(onAmbientStatus((text) => { state.text = text; }));
  return state;
}

function publisherPort(label: string, options: { readonly unsubscribeFailures?: number } = {}) {
  const listeners = new Set<(change: ObservationChange) => void>();
  let unsubscribeFailures = options.unsubscribeFailures ?? 0;
  let unsubscribeAttempts = 0;
  const id = agentId("publisher-child");
  const observation: AgentObservation = {
    agentId: id, ordinal: agentOrdinal("A1"), taskLabel: label as TaskLabel, modelLabel: "luna:h" as ModelLabel,
    context: { kind: "known", percent: contextPercent(42) }, lifecycleState: AgentState.Running,
    displayState: AgentState.Running as AgentDisplayState, activity: { kind: "idle" }, completionPendingDelivery: false,
    revision: agentObservationRevision(1),
  };
  const port: SubagentObservationPort = {
    observation: () => observation,
    directSnapshot: () => ({
      kind: "snapshot", revision: agentObservationRevision(1), health: { kind: "healthy" },
      total: agentCount(1), omitted: agentCount(0), omittedActive: agentCount(0),
      entries: [{
        agentId: id,
        observation,
        row: {
          ordinal: agentOrdinal("A1"), depth: agentDepth(0), model: "luna:h" as ModelLabel,
          context: "42%" as ContextLabel, taskLabel: label as TaskLabel, state: AgentState.Running as AgentDisplayState,
        },
      }],
    }),
    transcriptSource: () => undefined,
    subscribe: (listener) => {
      listeners.add(listener);
      return () => {
        unsubscribeAttempts += 1;
        if (unsubscribeFailures > 0) {
          unsubscribeFailures -= 1;
          throw new Error("publisher port unsubscribe");
        }
        listeners.delete(listener);
      };
    },
  };
  return {
    port,
    emit: () => {
      const change: ObservationChange = {
        revision: agentObservationRevision(2), health: { kind: "healthy" }, changed: [], rescanRequired: true,
      };
      for (const listener of listeners) listener(change);
    },
    listenerCount: () => listeners.size,
    unsubscribeAttempts: () => unsubscribeAttempts,
  };
}

function publisherFor(
  launchContext: ReturnType<typeof parseExtensionLaunchContext>,
  mode: string,
  options: { readonly replay?: SubagentObservationPort; readonly registryUnsubscribeFailures?: number } = {},
) {
  const agentDir = testAbsolutePath(mkdtempSync(join(tmpdir(), "publisher-widget-")));
  const sessionId = agentId("publisher-session");
  const handlers = new Map<string, Handler>();
  const uiCalls: string[] = [];
  let registryListener: ((port: SubagentObservationPort | undefined) => void) | undefined;
  let registryUnsubscribeFailures = options.registryUnsubscribeFailures ?? 0;
  let registryUnsubscribeAttempts = 0;
  const pi = { on: (name: string, handler: Handler) => { handlers.set(name, handler); } };
  const context = {
    mode,
    sessionManager: { getSessionId: () => String(sessionId) },
    ui: {
      setWidget: () => { uiCalls.push("widget"); }, setEditorComponent: () => { uiCalls.push("editor"); },
      getEditorComponent: () => { uiCalls.push("editor-read"); return undefined; },
      notify: () => { uiCalls.push("notify"); }, setStatus: () => { uiCalls.push("status"); },
    },
  };
  const deps: AgentWidgetDeps = {
    launchContext,
    agentDir,
    subscribePort: (listener) => {
      registryListener = listener;
      listener(options.replay);
      return () => {
        registryUnsubscribeAttempts += 1;
        if (registryUnsubscribeFailures > 0) { registryUnsubscribeFailures -= 1; throw new Error("registry unsubscribe"); }
      };
    },
  };
  createAgentWidgetExtension(pi as never, deps);
  handlers.get("session_start")?.({}, context);
  return {
    uiCalls,
    published: () => readKnownChildSnapshots(agentDir, [sessionId]).snapshots.get(sessionId),
    bytes: () => readFileSync(observationSnapshotPath(agentDir, sessionId), "utf8"),
    arrive: (port: SubagentObservationPort | undefined) => { registryListener?.(port); },
    shutdown: () => { handlers.get("session_shutdown")?.({}, context); },
    registryUnsubscribeAttempts: () => registryUnsubscribeAttempts,
    dispose: () => { handlers.get("session_shutdown")?.({}, context); rmSync(agentDir, { recursive: true, force: true }); },
  };
}
afterEach(() => { while (cleanups.length > 0) cleanups.pop()!(); setAmbientStatus(undefined); });

describe("publisher roles", () => {
  test("every managed descendant publishes while a non-TUI root remains inert", async () => {
    const descendants = [
      parseExtensionLaunchContext({ PI_SUBAGENT_CHILD: "1", PI_SUBAGENT_DEPTH: "1", PI_SUBAGENT_MAX_DEPTH: "2", PI_SUBAGENT_MAX_CONCURRENT_RUNS: "1" }),
      parseExtensionLaunchContext({ PI_SUBAGENT_CHILD: "1" }),
      parseExtensionLaunchContext({ PI_SUBAGENT_CHILD: "broken" }),
    ];
    const publishers = descendants.map((context) => publisherFor(context, "rpc"));
    const root = publisherFor(parseExtensionLaunchContext({}), "rpc");
    try {
      await Bun.sleep(Number(RELAY_FLUSH_WINDOW_MS) + 30);
      for (const publisher of publishers) expect(publisher.published()).toMatchObject({ agents: [], total: 0 });
      expect(root.published()).toBeUndefined();
      expect(root.uiCalls).toEqual([]);
    } finally {
      for (const publisher of publishers) publisher.dispose();
      root.dispose();
    }
  });

  test("defers relay writes, upgrades arrivals, coalesces changes, and preserves withdrawn slots", async () => {
    const context = parseExtensionLaunchContext({ PI_SUBAGENT_CHILD: "1", PI_SUBAGENT_DEPTH: "1", PI_SUBAGENT_MAX_DEPTH: "2", PI_SUBAGENT_MAX_CONCURRENT_RUNS: "1" });
    const port = publisherPort("updated task");
    const h = publisherFor(context, "rpc");
    try {
      expect(h.published()).toBeUndefined();
      await Bun.sleep(Number(RELAY_FLUSH_WINDOW_MS) + 30);
      expect(h.published()).toMatchObject({ revision: 1, agents: [] });
      expect(h.uiCalls).toEqual([]);

      h.arrive(port.port);
      expect(h.uiCalls).toEqual([]);
      expect(h.published()).toMatchObject({ revision: 1, agents: [] });
      await Bun.sleep(Number(RELAY_FLUSH_WINDOW_MS) + 30);
      expect(h.published()).toMatchObject({ revision: 2, agents: [{ taskLabel: "updated task" }] });

      port.emit(); port.emit(); port.emit();
      await Bun.sleep(Number(RELAY_FLUSH_WINDOW_MS) + 30);
      expect(h.published()?.revision).toBe(observationRevision(3));
      const prior = h.bytes();
      h.arrive(undefined);
      await Bun.sleep(Number(RELAY_FLUSH_WINDOW_MS) + 30);
      expect(h.bytes()).toBe(prior);
    } finally {
      h.dispose();
    }
  });

  test("handover subscribes the new publisher port when old unsubscription fails and retries both cleanups", async () => {
    const context = parseExtensionLaunchContext({ PI_SUBAGENT_CHILD: "1" });
    const first = publisherPort("first task", { unsubscribeFailures: 1 });
    const second = publisherPort("second task");
    const h = publisherFor(context, "rpc");
    try {
      h.arrive(first.port);
      await Bun.sleep(Number(RELAY_FLUSH_WINDOW_MS) + 30);
      expect(first.listenerCount()).toBe(1);

      h.arrive(second.port);
      expect(second.listenerCount()).toBe(1);
      await Bun.sleep(Number(RELAY_FLUSH_WINDOW_MS) + 30);
      const handoverRevision = h.published()!.revision;

      first.emit();
      await Bun.sleep(Number(RELAY_FLUSH_WINDOW_MS) + 30);
      expect(h.published()!.revision).toBe(handoverRevision);

      second.emit();
      await Bun.sleep(Number(RELAY_FLUSH_WINDOW_MS) + 30);
      expect(Number(h.published()!.revision)).toBe(Number(handoverRevision) + 1);

      h.shutdown();
      expect(first.unsubscribeAttempts()).toBe(2);
      expect(second.unsubscribeAttempts()).toBe(1);
      expect(first.listenerCount()).toBe(0);
      expect(second.listenerCount()).toBe(0);
    } finally {
      h.dispose();
    }
  });

  test("replay shares the initial publication window and shutdown retries registry cleanup", async () => {
    const context = parseExtensionLaunchContext({ PI_SUBAGENT_CHILD: "1" });
    const port = publisherPort("restored task");
    const h = publisherFor(context, "rpc", { replay: port.port, registryUnsubscribeFailures: 1 });
    try {
      expect(h.published()).toBeUndefined();
      await Bun.sleep(Number(RELAY_FLUSH_WINDOW_MS) + 30);
      expect(h.published()).toMatchObject({ revision: 1, agents: [{ taskLabel: "restored task" }] });
      h.shutdown();
      h.shutdown();
      expect(h.registryUnsubscribeAttempts()).toBe(2);
    } finally {
      h.dispose();
    }
  });
});

describe("aggregator render scheduling", () => {
  test("uses a 50 ms coalescer for render bursts and disposes it on shutdown", () => {
    const feed = fakeSource();
    const windows: number[] = [];
    let requests = 0;
    let disposals = 0;
    const createCoalescer: NonNullable<AgentWidgetDeps["createCoalescer"]> = (_runner, _timer, delay?) => {
      windows.push(Number(delay));
      return {
        request: () => { requests += 1; },
        dispose: () => { disposals += 1; },
      };
    };
    const h = harness({ sources: [feed], createCoalescer });

    publish();
    feed.emit(snapshotOf(2));
    feed.emit(snapshotOf(3));

    expect(windows).toEqual([50]);
    expect(requests).toBe(2);
    h.shutdown();
    expect(disposals).toBe(1);
  });
});

describe("mount and unmount", () => {
  test("mounts on the first non-zero total and acquires the lease", () => {
    const feed = fakeSource(); setAmbientStatus("2 running"); const ambient = ambientRecorder(); const h = harness({ sources: [feed] }); publish(); feed.emit(snapshotOf(2));
    expect(h.widgets.at(-1)?.key).toBe("pi-subagents-agents"); expect(h.widgets.at(-1)?.content).toBeDefined(); expect(ambient.text).toBe(undefined);
  });
  test("unmounts at a healthy zero total, returning focus first and releasing the lease", () => {
    const feed = fakeSource(); setAmbientStatus("2 running"); const ambient = ambientRecorder(); const h = harness({ sources: [feed] }); publish(); feed.emit(snapshotOf(2)); const mounted = h.component()!; mounted.focused = true; feed.emit(snapshotOf(0, 0));
    expect(h.widgets.at(-1)?.content).toBe(undefined); expect(h.focusCalls).toHaveLength(1); expect(ambient.text).toBe("2 running");
  });
  test("stays mounted header-only when the total is non-zero but every row is omitted", () => {
    const feed = fakeSource(); const h = harness({ sources: [feed] }); publish(); feed.emit(snapshotOf(0, 7)); expect(h.widgets.at(-1)?.content).toBeDefined(); expect(h.lines()).toEqual(["Subagents 0/7 · 7 omitted · incomplete"]);
  });
  test("remounts when agents return, through the same source subscription", () => {
    const feed = fakeSource(); const h = harness({ sources: [feed] }); publish(); feed.emit(snapshotOf(1)); const subscribers = feed.listenerCount(); feed.emit(snapshotOf(0, 0)); feed.emit(snapshotOf(1)); expect(h.widgets.at(-1)?.content).toBeDefined(); expect(feed.listenerCount()).toBe(subscribers);
  });
  test("creates the aggregator source with the branded root session identity", () => {
    const h = harness(); publish();
    expect(h.rootSessionIds).toEqual([agentId("aggregator-session")]);
  });
  test("unmounting while a fake selector holds focus performs no setFocus at all", () => {
    const feed = fakeSource(); const h = harness({ sources: [feed] }); publish(); feed.emit(snapshotOf(2)); h.component()!.focused = false; feed.emit(snapshotOf(0, 0)); expect(h.focusCalls).toHaveLength(0);
  });
});

describe("failure boundaries", () => {
  test("an editor accessor failure installs nothing and never reaches the registry", () => { const h = harness({ editorThrowsOn: "getEditorComponent" }); publish(); expect(h.widgets).toHaveLength(0); expect(h.notices.some((n) => n.type === "warning")).toBe(true); });
  test("a throwing source constructor mounts a stale header without escaping the registry", () => { const h = harness({ createSourceThrows: true }); expect(() => publish()).not.toThrow(); expect(h.widgets.at(-1)?.content).toBeDefined(); expect(h.lines()[0]).toBe("Subagents 0/0 · stale — source error"); expect(h.notices.some((n) => n.type === "warning")).toBe(true); });
  test("a source that throws on its first read mounts header-only with the stale suffix", () => { const feed = fakeSource({ onSnapshot: () => { throw new Error("read boom"); } }); const h = harness({ sources: [feed] }); publish(); expect(h.widgets.at(-1)?.content).toBeDefined(); expect(h.lines()[0]).toBe("Subagents 0/0 · stale — source error"); expect(h.notices.some((n) => n.type === "warning")).toBe(true); });
  test("maps watch_unavailable directly instead of collapsing it to source_failed", () => {
    const h = harness({ sourceDiagnostic: "watch_unavailable" });
    publish();
    expect(h.notices).toEqual([{ message: "Agent observation file watching is unavailable.", type: "warning" }]);
  });
  test("preserves projection-failed as the source_failed diagnostic", () => {
    const h = harness({ sourceDiagnostic: "projection-failed" });
    publish();
    expect(h.notices).toEqual([{ message: "Subagent widget data unavailable (source_failed).", type: "warning" }]);
  });
  test("a subscribe that throws is a source error, and a late callback cannot clear it", () => { const feed = fakeSource({ subscribeThrows: true }); const h = harness({ sources: [feed] }); publish(); expect(h.lines()[0]).toContain("stale — source error"); feed.emit(snapshotOf(4)); expect(h.lines()[0]).toContain("stale — source error"); expect(h.lines()[0]).not.toContain("4/4"); });
  test("a setWidget that throws leaves mounted false, the lease unheld, and reports its failure class once", () => {
    const feed = fakeSource(); setAmbientStatus("2 running"); const ambient = ambientRecorder();
    const h = harness({ sources: [feed], setWidgetThrowsOn: "mount" }); publish();
    feed.emit(snapshotOf(2));
    expect(ambient.text).toBe("2 running");
    expect(() => feed.emit(snapshotOf(3))).not.toThrow();
    expect(h.notices).toEqual([{ message: "Subagent widget unavailable (mount_failed).", type: "warning" }]);
  });
  test("a throwing diagnostic presenter cannot escape a guarded widget failure", () => { const feed = fakeSource(); harness({ sources: [feed], setWidgetThrowsOn: "mount", notifyThrows: true }); publish(); expect(() => feed.emit(snapshotOf(2))).not.toThrow(); });
  test("an unmount failure retains the lease until widget removal succeeds", () => { const feed = fakeSource(); setAmbientStatus("2 running"); const ambient = ambientRecorder(); harness({ sources: [feed], unmountFailures: 1 }); publish(); feed.emit(snapshotOf(2)); expect(() => feed.emit(snapshotOf(0, 0))).not.toThrow(); expect(ambient.text).toBeUndefined(); feed.emit(snapshotOf(0, 0)); expect(ambient.text).toBe("2 running"); });
  test("a failed widget removal remains registered and is retried on the next cleanup", () => {
    const feed = fakeSource();
    setAmbientStatus("2 running");
    const ambient = ambientRecorder();
    const h = harness({ sources: [feed], unmountFailures: 1 });
    publish();
    feed.emit(snapshotOf(2));

    feed.emit(snapshotOf(0, 0));
    expect(h.widgets.at(-1)?.content).toBeDefined();
    expect(ambient.text).toBeUndefined();
    feed.emit(snapshotOf(0, 0));

    expect(h.widgets.at(-1)?.content).toBeUndefined();
    expect(ambient.text).toBe("2 running");
  });
  test("a shutdown retries a previously failed widget removal", () => {
    const feed = fakeSource();
    const h = harness({ sources: [feed], unmountFailures: 1 });
    publish();
    feed.emit(snapshotOf(2));

    h.shutdown();
    expect(h.widgets.at(-1)?.content).toBeDefined();
    h.shutdown();

    expect(h.widgets.at(-1)?.content).toBeUndefined();
  });
  test("shutdown retains and retries only unfinished editor restoration", () => {
    const feed = fakeSource();
    const h = harness({ sources: [feed], editorRestoreFailures: 1 });
    publish();

    h.shutdown();
    expect(h.editorRestored()).toBe(false);
    h.shutdown();

    expect(h.editorRestored()).toBe(true);
    expect(h.editorRestoreAttempts()).toBe(2);
    expect(feed.disposals()).toBe(1);
  });
  test("shutdown retains registry unsubscription after a transient failure", () => {
    const feed = fakeSource();
    const h = harness({ sources: [feed], registryUnsubscribeFailures: 1 });
    publish();

    h.shutdown();
    h.shutdown();

    expect(h.registryUnsubscribeAttempts()).toBe(2);
    expect(feed.disposals()).toBe(1);
  });
  test("shutdown retains source disposal after a transient failure", () => {
    const feed = fakeSource({ disposeFailures: 1 });
    const h = harness({ sources: [feed] });
    publish();

    h.shutdown();
    h.shutdown();

    expect(feed.disposals()).toBe(2);
    expect(feed.unsubscribeAttempts()).toBe(1);
  });
  test("shutdown retains row unsubscription after a transient failure", () => {
    const feed = fakeSource({ unsubscribeFailures: 1 });
    const h = harness({ sources: [feed] });
    publish();

    h.shutdown();
    h.shutdown();

    expect(feed.unsubscribeAttempts()).toBe(2);
    expect(feed.disposals()).toBe(1);
  });
  test("post-registration mount failure retains ambiguous widget cleanup", () => {
    const feed = fakeSource();
    const h = harness({ sources: [feed], mountThrowsAfterRegistration: true, unmountFailures: 1 });
    publish();
    feed.emit(snapshotOf(2));
    expect(h.widgets.at(-1)?.content).toBeDefined();

    h.shutdown();

    expect(h.widgets.at(-1)?.content).toBeUndefined();
  });
  test("a session start callback contains a widget start failure", () => { expect(() => harness({ modeThrows: true })).not.toThrow(); });
  test("reports a bounded allow-listed lifecycle diagnostic without exception details", () => {
    const secret = "/private/session/agent-native-id";
    const h = harness({ modeError: new Error(`${secret}\u001b[31mboom\u001b[0m\u0000`) });
    expect(h.notices).toEqual([{ message: "Subagent widget unavailable (lifecycle_failed).", type: "warning" }]);
    expect(h.notices[0]!.message).not.toContain(secret);
    expect(h.notices[0]!.message.length).toBeLessThanOrEqual(100);
  });
  test("a focused accessor failure still restores widget, lease, editor and registry", () => {
    const feed = fakeSource();
    setAmbientStatus("2 running");
    const ambient = ambientRecorder();
    const h = harness({ sources: [feed] });
    publish();
    feed.emit(snapshotOf(2));
    Object.defineProperty(h.component()!, "focused", { get: () => { throw new Error("focused boom"); } });

    expect(() => h.shutdown()).not.toThrow();

    expect(h.widgets.at(-1)?.content).toBeUndefined();
    expect(ambient.text).toBe("2 running");
    expect(h.editorRestored()).toBe(true);
    const widgetCalls = h.widgets.length;
    publish();
    expect(h.widgets).toHaveLength(widgetCalls);
  });
  test("a failed shutdown registration leaves no resource-creating start handler", () => {
    const handlers = new Map<string, Array<LifecycleHandler<StartupContext>>>();
    let registrations = 0;
    const pi = {
      on: lifecycleOn(handlers, () => {
        registrations += 1;
        if (registrations === 2) throw new Error("registration boom");
      }),
    } satisfies Pick<ExtensionAPI, "on">;

    // The widget uses only `on`; this is the one structural adaptation to its public Pi boundary.
    expect(() => createAgentWidgetExtension(pi as ExtensionAPI)).toThrow("registration boom");
    expect([...handlers.keys()]).toEqual(["session_shutdown"]);
  });
});

describe("handover and generations", () => {
  test("handover disposes the prior source and never shows its rows under the replacement", () => { const first = fakeSource(); const second = fakeSource(); const h = harness({ sources: [first, second] }); const tokenA = publish(); first.emit(snapshotOf(3)); expect(h.lines()[0]).toContain("3/3"); tokenA.clear(); expect(first.disposals()).toBe(1); expect(h.widgets.at(-1)?.content).toBe(undefined); publish(); second.emit(snapshotOf(1)); expect(h.lines()[0]).toContain("1/1"); expect(h.lines().join("\u000A")).not.toContain("3/3"); });
  test("a callback from a superseded generation is dropped without touching the view", () => { const first = fakeSource(); const second = fakeSource(); const h = harness({ sources: [first, second] }); const tokenA = publish(); first.emit(snapshotOf(3)); tokenA.clear(); publish(); second.emit(snapshotOf(1)); first.emit(snapshotOf(9)); expect(h.lines()[0]).toContain("1/1"); });
  test("handover retries transient widget removal before subscribing to the replacement", () => { const first = fakeSource(); const second = fakeSource(); harness({ sources: [first, second], unmountFailures: 1 }); const tokenA = publish(); first.emit(snapshotOf(2)); tokenA.clear(); expect(() => publish()).not.toThrow(); expect(second.listenerCount()).toBe(1); });
  test("shutdown unsubscribes from the registry, so a later publication reaches no ctx.ui", () => { const feed = fakeSource(); const h = harness({ sources: [feed, fakeSource()] }); publish(); feed.emit(snapshotOf(2)); const before = h.widgets.length; h.shutdown(); expect(h.widgets.length).toBe(before + 1); expect(h.widgets.at(-1)?.content).toBe(undefined); publish(); expect(h.widgets.length).toBe(before + 1); });
  test("a non-TUI mode mounts nothing and touches no ctx.ui", () => { const h = harness({ mode: "rpc", sources: [fakeSource()] }); publish(); expect(h.widgets).toHaveLength(0); expect(h.editor).toBe(undefined); expect(h.notices).toHaveLength(0); });
});

describe("editor composition and focus", () => {
  test("Down from an empty editor focuses the widget; a non-empty editor keeps native behaviour", () => { const feed = fakeSource(); const h = harness({ sources: [feed] }); publish(); feed.emit(snapshotOf(2)); h.editor!.handleInput(DOWN); expect(h.focusCalls).toEqual([h.component()!]); expect(h.inherited).toHaveLength(0); h.setEditorText("hello"); h.editor!.handleInput(DOWN); expect(h.inherited).toEqual([DOWN]); });
  test("zero rows keeps native Down even with an empty editor", () => { const feed = fakeSource(); const h = harness({ sources: [feed] }); publish(); feed.emit(snapshotOf(0, 3)); h.editor!.handleInput(DOWN); expect(h.inherited).toEqual([DOWN]); expect(h.focusCalls).toHaveLength(0); });
  test("a foreign getEditorComponent emits exactly one diagnostic and latches the suffix", () => { const feed = fakeSource(); const h = harness({ sources: [feed] }); publish(); feed.emit(snapshotOf(2)); h.replaceEditorFactory(); h.lines(); h.lines(); h.lines(); expect(h.lines()[0]).toContain("arrow navigation unavailable"); expect(h.notices.filter((n) => n.message.includes("arrow")).length).toBe(1); });
  test("Down does not focus the widget once the identity check has failed", () => { const feed = fakeSource(); const h = harness({ sources: [feed] }); publish(); feed.emit(snapshotOf(2)); h.replaceEditorFactory(); h.editor!.handleInput(DOWN); expect(h.focusCalls).toHaveLength(0); expect(h.inherited).toEqual([DOWN]); });
  test("the latched suffix survives an unmount and remount, and the diagnostic still fires once", () => { const feed = fakeSource(); const h = harness({ sources: [feed] }); publish(); feed.emit(snapshotOf(2)); h.replaceEditorFactory(); h.lines(); feed.emit(snapshotOf(0, 0)); feed.emit(snapshotOf(2)); expect(h.lines()[0]).toContain("arrow navigation unavailable"); expect(h.notices.filter((n) => n.message.includes("arrow")).length).toBe(1); });
  test("Up from the widget's first row returns focus to the same editor instance", () => { const feed = fakeSource(); const h = harness({ sources: [feed] }); publish(); feed.emit(snapshotOf(2)); h.editor!.handleInput(DOWN); (h.component()!.handleInput as (data: string) => void)(UP); expect(h.focusCalls.at(-1)).toBe(h.editor); });
  test("Esc closes the real child overlay without changing parent selection, editor text or a newer sibling", () => {
    const selected = loadingConversationSource();
    const feed = fakeSource({ transcriptSource: () => selected });
    const h = harness({ sources: [feed], createConversationController: createChildConversationController });
    publish();
    feed.emit(snapshotOf(2));
    h.editor!.handleInput(DOWN);
    h.setEditorText("unchanged draft");
    const parentBefore = h.lines();

    (h.component()!.handleInput as (data: string) => void)("\r");
    expect(h.overlayEntries).toHaveLength(1);
    const child = h.overlayEntries[0]!;
    h.showSiblingOverlay();
    const siblingEntry = h.overlayEntries[1]!;

    child.component.handleInput?.("\u001b");

    expect(child.hides()).toBe(1);
    expect(siblingEntry.hides()).toBe(0);
    expect(h.lines()).toEqual(parentBefore);
    expect(h.editorText()).toBe("unchanged draft");
  });

  test("creates one overlay controller from callback values and preserves parent state through open and shutdown", () => {
    const feed = fakeSource();
    const lifecycle: string[] = [];
    const originalDispose = feed.source.dispose.bind(feed.source);
    feed.source.dispose = () => { lifecycle.push("source:dispose"); originalDispose() };
    const opens: string[] = [];
    const openedSources: AgentWidgetSource[] = [];
    let closeEvents = 0;
    let captured: Parameters<NonNullable<AgentWidgetDeps["createConversationController"]>>[0] | undefined;
    const h = harness({
      sources: [feed],
      createConversationController: (options) => {
        captured = options;
        return {
          open: (ordinal, source) => { opens.push(String(ordinal)); openedSources.push(source) },
          close: () => { closeEvents += 1 },
          dispose: () => { lifecycle.push("controller:dispose") },
        };
      },
    });
    publish();
    feed.emit(snapshotOf(2));

    expect(captured?.tui).toBe(h.callbackValues.tui);
    expect(captured?.theme as object | undefined).toBe(h.callbackValues.theme);
    expect(captured?.keybindings as object | undefined).toBe(h.callbackValues.keybindings);
    h.editor!.handleInput(DOWN);
    h.setEditorText("unchanged draft");
    (h.component()!.handleInput as (data: string) => void)("\r");
    expect(opens).toEqual(["A1"]);
    expect(openedSources).toEqual([feed.source]);
    expect(h.editorText()).toBe("unchanged draft");
    expect(h.widgets.at(-1)?.content).toBeDefined();

    expect(captured).not.toHaveProperty("source");
    expect(h.lines().join("\n")).toContain("A1");
    const closesBeforeShutdown = closeEvents;
    h.shutdown();
    expect(closeEvents).toBe(closesBeforeShutdown);
    expect(lifecycle).toEqual(["controller:dispose", "source:dispose"]);
  });

  test("gate tracing is supplied explicitly through dependencies", () => {
    const feed = fakeSource();
    const events: string[] = [];
    const h = harness({ sources: [feed], trace: (event) => { events.push(event); } });
    publish();
    feed.emit(snapshotOf(2));
    h.editor!.handleInput(DOWN);
    (h.component()!.handleInput as (data: string) => void)(UP);
    expect(events).toEqual(["widget-focused", "editor-refocused"]);
  });
  test("editor interception contains every widget-owned dependency failure", () => { for (const failure of ["getText", "inherited", "setFocus", "requestRender"] as const) { const feed = fakeSource(); const h = harness({ sources: [feed], editorThrowsOn: failure }); const token = publish(); feed.emit(snapshotOf(2)); if (failure === "inherited") h.setEditorText("hello"); expect(() => h.editor!.handleInput(DOWN)).not.toThrow(); expect(h.notices.some((n) => n.type === "warning")).toBe(true); token.clear(); h.shutdown(); } });
});

interface StartupContext {
  notices: string[];
  ui: { setStatus(): void; notify(message: string): void };
}

function startupController(): ExtensionController {
  return {
    restore: async () => {}, shutdown: async () => {}, status: () => "0 running · 0 ready",
    tools: () => ({
      spawn_agent: { name: "spawn_agent", description: "spawn_agent", parameters: spawnAgentSchema, execute: async () => ({ content: "spawn_agent", details: { name: "spawn_agent" } }), renderResult: () => "spawn_agent" },
      send_input: { name: "send_input", description: "send_input", parameters: sendInputSchema, execute: async () => ({ content: "send_input", details: { name: "send_input" } }), renderResult: () => "send_input" },
      await_agent: { name: "await_agent", description: "await_agent", parameters: awaitAgentSchema, execute: async () => ({ content: "await_agent", details: { name: "await_agent" } }), renderResult: () => "await_agent" },
      stop_agent: { name: "stop_agent", description: "stop_agent", parameters: stopAgentSchema, execute: async () => ({ content: "stop_agent", details: { name: "stop_agent" } }), renderResult: () => "stop_agent" },
    }),
  };
}

function startupHarness(options: {
  // These options mirror PiSubagentsExtensionOptions; startup always receives ExtensionAPI.
  startWidget?: (pi: ExtensionAPI) => void;
  loadWidget?: (log: string[]) => Promise<(pi: ExtensionAPI) => void | Promise<void>>;
  platform?: string;
  registration?: { readonly enabled: true } | { readonly enabled: false; readonly diagnostic?: string };
  diagnosticThrows?: boolean;
  onThrowsOnce?: boolean;
  omitStartWidget?: boolean;
} = {}) {
  const log: string[] = [];
  const diagnostics: string[] = [];
  const registered: Array<Record<string, unknown>> = [];
  const handlers = new Map<string, Array<LifecycleHandler<StartupContext>>>();
  let onThrew = false;
  let sessionStartRegistrations = 0;
  const api: ExtensionApiPort = {
    // The host accepts generic ToolDefinition values; this fake records only their observable fields.
    // ToolDefinition has no string index signature, so the fake receives object and narrows locally.
    registerTool: ((tool: object) => {
      const entry = tool as Record<string, unknown>;
      log.push(`tool:${String(entry.name)}`);
      registered.push(entry);
    }) as ExtensionApiPort["registerTool"],
    on: lifecycleOn(handlers, (name) => {
      if (name === "session_start") sessionStartRegistrations += 1;
      if (options.onThrowsOnce === true && !onThrew && name === "session_start" && sessionStartRegistrations === 2) {
        onThrew = true;
        throw new Error("registration boom");
      }
    }),
    appendEntry: () => {}, sendMessage: () => {},
    getThinkingLevel: () => "high", getActiveTools: () => [],
  };
  const base = {
    platform: options.platform ?? "linux",
    nodeVersion: "22.19.0",
    registration: options.registration ?? { enabled: true },
    createController: () => startupController(),
    diagnostic: (message: string) => {
      diagnostics.push(message);
      if (options.diagnosticThrows) throw new Error("diagnostic boom");
    },
  };
  const factory = options.loadWidget === undefined
    ? options.omitStartWidget === true
      ? createPiSubagentsExtension(base)
      : createPiSubagentsExtension({
          ...base,
          startWidget: (pi: ExtensionAPI) => { log.push("startWidget"); options.startWidget?.(pi); },
        })
    : createPiSubagentsExtension({
        ...base,
        loadWidget: () => options.loadWidget!(log),
      });
  const installation = factory(extensionApiForTest(api));
  const ctx: StartupContext = {
    notices: [],
    ui: { setStatus: () => {}, notify: (message: string) => { ctx.notices.push(message); } },
  };
  return {
    log, diagnostics, registered, ctx,
    tools: () => log.filter((entry) => entry.startsWith("tool:")),
    handlerNames: () => [...handlers].flatMap(([name, list]) => list.map(() => name)),
    ready: async () => { await installation; },
    start: async () => { for (const handler of handlers.get("session_start") ?? []) await handler({}, ctx); },
  };
}

describe("startup integration", () => {
  test("awaits asynchronous widget loading and startup before registering tools", async () => {
    const h = startupHarness({
      loadWidget: async (log) => {
        log.push("widget-import");
        await Promise.resolve();
        return () => { log.push("startWidget"); };
      },
    });

    expect(h.tools()).toHaveLength(0);
    await h.ready();
    expect(h.log.slice(0, 2)).toEqual(["widget-import", "startWidget"]);
    expect(h.tools()).toHaveLength(4);
    expect(h.log.indexOf("startWidget")).toBeLessThan(h.log.indexOf("tool:spawn_agent"));
  });

  test("contains an asynchronous widget import rejection and still installs core", async () => {
    const secret = "/private/widget/module.ts";
    const h = startupHarness({
      loadWidget: async () => { throw new Error(secret); },
    });

    await expect(h.ready()).resolves.toBeUndefined();
    expect(h.tools()).toHaveLength(4);
    expect(h.diagnostics).toEqual(["Subagent widget unavailable (startup_failed)."]);
    expect(h.diagnostics[0]).not.toContain(secret);
  });

  test("contains a synchronous widget loader throw and still installs core", async () => {
    let h: ReturnType<typeof startupHarness> | undefined;
    expect(() => {
      h = startupHarness({ loadWidget: () => { throw new Error("synchronous loader boom"); } });
    }).not.toThrow();

    await expect(h!.ready()).resolves.toBeUndefined();
    expect(h!.tools()).toHaveLength(4);
    expect(h!.diagnostics).toEqual(["Subagent widget unavailable (startup_failed)."]);
  });

  test("installs widget startup exactly once, before any tool is registered", () => {
    const h = startupHarness();
    expect(h.log.filter((entry) => entry === "startWidget")).toHaveLength(1);
    expect(h.log[0]).toBe("startWidget");
    expect(h.tools()).toEqual(["tool:spawn_agent", "tool:send_input", "tool:await_agent", "tool:stop_agent"]);
  });

  test("installs no widget on an unsupported platform", () => {
    const h = startupHarness({ platform: "darwin" });
    expect(h.log).toHaveLength(0);
    expect(h.diagnostics).toHaveLength(1);
  });

  test("loads and awaits the widget before disabled registration returns without controller tools", async () => {
    const h = startupHarness({
      registration: { enabled: false, diagnostic: "depth exhausted" },
      loadWidget: async (log) => {
        log.push("widget-import");
        await Promise.resolve();
        return () => { log.push("startWidget"); };
      },
    });
    expect(h.tools()).toEqual([]);
    await h.ready();
    expect(h.log).toEqual(["widget-import", "startWidget"]);
    expect(h.tools()).toEqual([]);
  });

  test("a throwing startup is reported on both channels and costs no tool installation", async () => {
    const h = startupHarness({ startWidget: () => { throw new Error("widget boom"); } });
    expect(h.tools()).toHaveLength(4);
    expect(h.diagnostics).toEqual(["Subagent widget unavailable (startup_failed)."]);
    expect(h.ctx.notices).toHaveLength(0);
    await h.start();
    expect(h.ctx.notices).toEqual(["Subagent widget unavailable (startup_failed)."]);
    // Pi's public ToolDefinition contract requires a raw string toolCallId; no repository brand is compatible.
    // Recording through ExtensionApiPort erases this concrete tool's schema and context-only parameters.
    const spawn = h.registered.find((tool) => tool.name === "spawn_agent") as
      { execute(id: string, input: object, signal: AbortSignal): Promise<{ content: ReadonlyArray<{ text: string }> }> };
    const result = await spawn.execute("call-1", {}, new AbortController().signal);
    expect(result.content[0]?.text).toBe("spawn_agent");
    expect(h.handlerNames()).toEqual([
      "session_start", "session_start", "session_start", "session_before_tree", "session_tree",
      "session_before_switch", "session_before_fork", "session_shutdown", "agent_settled",
    ]);
  });

  test("startup diagnostics expose only a bounded allow-listed failure code", async () => {
    const secret = "/private/session/native-id";
    const h = startupHarness({ startWidget: () => { throw new Error(`${secret}\u001b[31mboom\u001b[0m\u0000`); } });
    expect(h.diagnostics).toEqual(["Subagent widget unavailable (startup_failed)."]);
    await h.start();
    expect(h.ctx.notices).toEqual(["Subagent widget unavailable (startup_failed)."]);
    expect(h.ctx.notices[0]).not.toContain(secret);
    expect(h.ctx.notices[0]!.length).toBeLessThanOrEqual(100);
  });

  test("a failed fallback notification registration does not escape core installation", () => {
    let h: ReturnType<typeof startupHarness> | undefined;
    expect(() => {
      h = startupHarness({ startWidget: () => { throw new Error("widget boom"); }, onThrowsOnce: true });
    }).not.toThrow();
    expect(h!.tools()).toHaveLength(4);
    expect(h!.handlerNames()).toEqual([
      "session_start", "session_start", "session_before_tree", "session_tree", "session_before_switch", "session_before_fork", "session_shutdown", "agent_settled",
    ]);
  });

  test("a throwing startup diagnostic leaves tools and lifecycle available", async () => {
    let h: ReturnType<typeof startupHarness> | undefined;
    expect(() => {
      h = startupHarness({ startWidget: () => { throw new Error("widget boom"); }, diagnosticThrows: true });
    }).not.toThrow();
    expect(h!.tools()).toHaveLength(4);
    expect(h!.handlerNames()).toEqual([
      "session_start", "session_start", "session_start", "session_before_tree", "session_tree",
      "session_before_switch", "session_before_fork", "session_shutdown", "agent_settled",
    ]);
    await expect(h!.start()).resolves.toBeUndefined();
  });

  test("a startup-failure notification callback contains a throwing UI", async () => {
    const h = startupHarness({ startWidget: () => { throw new Error("widget boom"); } });
    h.ctx.ui.notify = () => { throw new Error("notify boom"); };
    await expect(h.start()).resolves.toBeUndefined();
  });

  test("omitting the option leaves the factory behaving exactly as before", () => {
    const h = startupHarness({ omitStartWidget: true });
    expect(h.log).toEqual(["tool:spawn_agent", "tool:send_input", "tool:await_agent", "tool:stop_agent"]);
    expect(h.diagnostics).toHaveLength(0);
  });
});

describe("lifecycle recovery", () => {
  test("a failed stop does not block the next session start", () => {
    const first = fakeSource(); const second = fakeSource(); const h = harness({ sources: [first, second] }); publish(); first.emit(snapshotOf(2));
    Object.defineProperty(h.component()!, "focused", { get: () => { throw new Error("focused boom"); } });
    expect(() => h.shutdown()).not.toThrow();
    expect(() => h.start()).not.toThrow();
    second.emit(snapshotOf(2));
    expect(h.widgets.at(-1)?.content).toBeDefined();
    expect(h.lines()[0]).toContain("2/2");
  });
});

interface CompositionContext {
  readonly label: string;
  readonly mode: "tui";
  readonly widgets: string[][];
  readonly sessionManager: { getSessionId(): string };
  isWidgetMounted(): boolean;
  readonly ui: {
    setWidget(key: string, content: WidgetFactory | undefined, options?: object): void;
    setEditorComponent(factory: EditorFactory | undefined): void;
    getEditorComponent(): EditorFactory | undefined;
    setStatus(key: string, value: string | undefined): void;
    notify(message: string, type?: string): void;
  };
}

function observedStore(name: string): AgentObservationStore {
  const store = new AgentObservationStore();
  store.registerSpawned({
    agentId: agentId(name),
    ordinal: directAgentOrdinal(1),
    assignment: name.startsWith("first") ? "Alpha observation task" : "Beta observation task",
    sessionPath: testSessionPath(`/tmp/pi-subagents-test/${name}.jsonl`),
    cwd: testAbsolutePath("/tmp/pi-subagents-test"),
    model: modelSpec("mock-provider/luna"),
    thinkingLevel: "high",
  });
  return store;
}

function compositionContext(
  label: string,
  statusEvents: Array<{ label: string; value: string | undefined; mountedLabels: readonly string[] }>,
  mountedLabels: () => readonly string[],
): CompositionContext {
  const widgets: string[][] = [];
  let widgetMounted = false;
  const tui = {
    terminal: { rows: 40, columns: 120 },
    setFocus: (_target: object) => {},
    requestRender: () => {},
  } as TUI;
  let editorFactory: EditorFactory | undefined = (() => ({
    handleInput: () => {}, getText: () => "", setText: () => {}, render: () => [], invalidate: () => {},
  })) as EditorFactory;
  return {
    label,
    mode: "tui",
    widgets,
    sessionManager: { getSessionId: () => `${label}-session` },
    isWidgetMounted: () => widgetMounted,
    ui: {
      setWidget: (_key, content) => {
        widgetMounted = content !== undefined;
        if (content === undefined) return;
        const component = content(tui, {});
        widgets.push((component.render as (width: number) => string[])(120));
      },
      setEditorComponent: (factory) => { editorFactory = factory; },
      getEditorComponent: () => editorFactory,
      setStatus: (_key, value) => { statusEvents.push({ label, value, mountedLabels: [...mountedLabels()] }); },
      notify: () => {},
    },
  };
}

describe("production composition session isolation", () => {
  test("populated replacement isolates both widget contexts and suppresses ambient fallback", async () => {
    const handlers = new Map<string, Array<LifecycleHandler<CompositionContext>>>();
    const tools: Array<Record<string, unknown>> = [];
    const api: ExtensionApiPort = {
      registerTool: ((tool: object) => {
        tools.push(tool as Record<string, unknown>);
      }) as ExtensionApiPort["registerTool"],
      on: lifecycleOn(handlers),
      appendEntry: () => {}, sendMessage: () => {}, getThinkingLevel: () => "high", getActiveTools: () => [],
    };
    const stores = [observedStore("first-agent"), observedStore("second-agent")];
    const statuses = ["agents:first", "agents:second"];
    let created = 0;
    const installation = createPiSubagentsExtension({
      platform: "linux",
      nodeVersion: "22.19.0",
      registration: { enabled: true },
      startWidget: (pi) => { createAgentWidgetExtension(pi, { launchContext: parseExtensionLaunchContext({}) }); },
      createController: () => {
        const index = created++;
        return { ...startupController(), observationPort: () => stores[index]!, status: () => statuses[index]! };
      },
      diagnostic: () => {},
    })(extensionApiForTest(api));
    await installation;
    const statusEvents: Array<{ label: string; value: string | undefined; mountedLabels: readonly string[] }> = [];
    const contexts: CompositionContext[] = [];
    const mountedLabels = (): readonly string[] => contexts.filter((context) => context.isWidgetMounted()).map((context) => context.label);
    const first = compositionContext("first", statusEvents, mountedLabels);
    contexts.push(first);
    const second = compositionContext("second", statusEvents, mountedLabels);
    contexts.push(second);
    const emitStart = async (ctx: CompositionContext): Promise<void> => {
      for (const handler of handlers.get("session_start") ?? []) await handler({}, ctx);
    };

    await emitStart(first);
    expect(first.widgets.flat().join("\u000A")).toContain("Alpha observation task");
    const firstWidgetCount = first.widgets.length;
    const transitionAt = statusEvents.length;
    await emitStart(second);

    expect(first.widgets.slice(firstWidgetCount).flat().join("\u000A")).not.toContain("Beta observation task");
    expect(second.widgets.flat().join("\u000A")).toContain("Beta observation task");
    expect(second.widgets.flat().join("\u000A")).not.toContain("Alpha observation task");
    expect(statusEvents.slice(transitionAt).filter((entry) => entry.value !== undefined)).toEqual([]);
    for (const handler of handlers.get("session_shutdown") ?? []) await handler({}, second);
  });
});
