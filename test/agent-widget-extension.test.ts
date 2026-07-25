import { afterEach, describe, expect, test } from "bun:test";
import type { EditorComponent, TUI } from "@earendil-works/pi-tui";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import { createPiSubagentsExtension, type ExtensionController } from "../index.ts";
import createAgentWidgetExtension from "../agent-widget.ts";
import type { AgentDisplayState, AgentWidgetSnapshot, AgentWidgetSource, SubagentObservationPort } from "../src/agent-observation.ts";
import { publishObservationPort } from "../src/observation-registry.ts";
import { setAmbientStatus, onAmbientStatus } from "../src/ambient-status-lease.ts";
import {
  AgentState, agentCount, agentDepth, agentObservationRevision, agentOrdinal, agentWidgetRevision,
  type ContextLabel, type ModelLabel, type TaskLabel,
} from "../src/domain.ts";
import { extensionApiForTest, lifecycleOn, type ExtensionApiPort, type LifecycleHandler } from "./support/extension-api.ts";
import { awaitAgentSchema, sendInputSchema, spawnAgentSchema, stopAgentSchema } from "../src/tools.ts";

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

function fakeSource(options: { onSnapshot?: () => AgentWidgetSnapshot; subscribeThrows?: boolean } = {}) {
  let current = snapshotOf(0, 0);
  const listeners = new Set<() => void>();
  let disposed = 0;
  const source: AgentWidgetSource & { dispose(): void } = {
    snapshot: () => options.onSnapshot ? options.onSnapshot() : current,
    transcriptSource: () => undefined,
    subscribe: (onChange) => {
      listeners.add(onChange);
      if (options.subscribeThrows) throw new Error("subscribe boom");
      return () => { listeners.delete(onChange); };
    },
    dispose: () => { disposed += 1; },
  };
  return {
    source, disposals: () => disposed,
    emit: (next: AgentWidgetSnapshot) => { current = next; for (const listener of [...listeners]) listener(); },
    listenerCount: () => listeners.size,
  };
}

function harness(options: {
  mode?: string;
  modeError?: unknown;
  modeThrows?: boolean;
  sources?: ReadonlyArray<ReturnType<typeof fakeSource>>;
  setWidgetThrowsOn?: "mount" | "unmount";
  notifyThrows?: boolean;
  createSourceThrows?: boolean;
  editorThrowsOn?: "getEditorComponent" | "getText" | "inherited" | "setFocus" | "requestRender";
} = {}) {
  const widgets: Array<{ key: string; content: WidgetFactory | undefined }> = [];
  const notices: Array<{ message: string; type?: string }> = [];
  const focusCalls: object[] = [];
  let editorFactory: EditorFactory | undefined;
  let installed: EditorFactory | undefined;
  let component: (Record<string, unknown> & { focused?: boolean }) | undefined;
  let editorText = "";
  const inherited: string[] = [];
  const shortcuts: string[] = [];
  const tui = {
    terminal: { rows: 40, columns: 120 },
    setFocus: (target: object) => { if (options.editorThrowsOn === "setFocus") throw new Error("focus boom"); focusCalls.push(target); },
    requestRender: () => { if (options.editorThrowsOn === "requestRender") throw new Error("render boom"); },
  } as TUI;
  const ctx = {
    get mode(): string {
      if (options.modeError !== undefined) throw options.modeError;
      if (options.modeThrows) throw new Error("mode boom");
      return options.mode ?? "tui";
    },
    ui: {
      setWidget: (key: string, content: WidgetFactory | undefined) => {
        const removing = content === undefined;
        if (options.setWidgetThrowsOn === "mount" && !removing) throw new Error("mount boom");
        if (options.setWidgetThrowsOn === "unmount" && removing) throw new Error("unmount boom");
        widgets.push({ key, content });
        component = removing ? undefined : content!(tui, {});
      },
      setEditorComponent: (factory: EditorFactory | undefined) => { installed = factory; editorFactory = factory; },
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
  const handlers = new Map<string, Handler>();
  const pi = { on: (name: string, handler: Handler) => { handlers.set(name, handler); } };
  const queue = [...(options.sources ?? [fakeSource()])];
  const createSource = () => {
    if (options.createSourceThrows) throw new Error("source constructor boom");
    return (queue.shift() ?? fakeSource()).source;
  };
  createAgentWidgetExtension(pi as never, { createSource });
  handlers.get("session_start")?.({}, ctx);
  cleanups.push(() => { handlers.get("session_shutdown")?.({}, ctx); });
  const editor = installed?.(tui, {}, {});
  return {
    widgets, notices, focusCalls, inherited, shortcuts, editor,
    component: () => component, setEditorText: (value: string) => { editorText = value; },
    replaceEditorFactory: () => { editorFactory = (() => ({ render: () => [], invalidate: () => {}, getText: () => "", setText: () => {}, handleInput: () => {} })) as EditorFactory; },
    lines: () => (component?.render as ((width: number) => string[]) | undefined)?.(120) ?? [],
    start: () => handlers.get("session_start")?.({}, ctx),
    shutdown: () => handlers.get("session_shutdown")?.({}, ctx),
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
afterEach(() => { while (cleanups.length > 0) cleanups.pop()!(); setAmbientStatus(undefined); });

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
  test("unmounting while a fake selector holds focus performs no setFocus at all", () => {
    const feed = fakeSource(); const h = harness({ sources: [feed] }); publish(); feed.emit(snapshotOf(2)); h.component()!.focused = false; feed.emit(snapshotOf(0, 0)); expect(h.focusCalls).toHaveLength(0);
  });
});

describe("failure boundaries", () => {
  test("an editor accessor failure installs nothing and never reaches the registry", () => { const h = harness({ editorThrowsOn: "getEditorComponent" }); publish(); expect(h.widgets).toHaveLength(0); expect(h.notices.some((n) => n.type === "warning")).toBe(true); });
  test("a throwing source constructor mounts a stale header without escaping the registry", () => { const h = harness({ createSourceThrows: true }); expect(() => publish()).not.toThrow(); expect(h.widgets.at(-1)?.content).toBeDefined(); expect(h.lines()[0]).toBe("Subagents 0/0 · stale — source error"); expect(h.notices.some((n) => n.type === "warning")).toBe(true); });
  test("a source that throws on its first read mounts header-only with the stale suffix", () => { const feed = fakeSource({ onSnapshot: () => { throw new Error("read boom"); } }); const h = harness({ sources: [feed] }); publish(); expect(h.widgets.at(-1)?.content).toBeDefined(); expect(h.lines()[0]).toBe("Subagents 0/0 · stale — source error"); expect(h.notices.some((n) => n.type === "warning")).toBe(true); });
  test("a subscribe that throws is a source error, and a late callback cannot clear it", () => { const feed = fakeSource({ subscribeThrows: true }); const h = harness({ sources: [feed] }); publish(); expect(h.lines()[0]).toContain("stale — source error"); feed.emit(snapshotOf(4)); expect(h.lines()[0]).toContain("stale — source error"); expect(h.lines()[0]).not.toContain("4/4"); });
  test("a setWidget that throws leaves mounted false, the lease unheld, and remounts next update", () => { const feed = fakeSource(); setAmbientStatus("2 running"); const ambient = ambientRecorder(); const h = harness({ sources: [feed], setWidgetThrowsOn: "mount" }); publish(); feed.emit(snapshotOf(2)); expect(ambient.text).toBe("2 running"); expect(h.notices.some((n) => n.type === "warning")).toBe(true); expect(() => feed.emit(snapshotOf(3))).not.toThrow(); });
  test("a throwing diagnostic presenter cannot escape a guarded widget failure", () => { const feed = fakeSource(); harness({ sources: [feed], setWidgetThrowsOn: "mount", notifyThrows: true }); publish(); expect(() => feed.emit(snapshotOf(2))).not.toThrow(); });
  test("an unmount whose setWidget throws still releases the lease and clears the view", () => { const feed = fakeSource(); setAmbientStatus("2 running"); const ambient = ambientRecorder(); const h = harness({ sources: [feed], setWidgetThrowsOn: "unmount" }); publish(); feed.emit(snapshotOf(2)); expect(() => feed.emit(snapshotOf(0, 0))).not.toThrow(); expect(ambient.text).toBe("2 running"); });
  test("a session start callback contains a widget start failure", () => { expect(() => harness({ modeThrows: true })).not.toThrow(); });
  test("sanitises thrown widget errors before notifying", () => {
    const h = harness({ modeError: new Error("widget \u001b[31mboom\u001b[0m\u0000") });
    expect(h.notices).toEqual([{ message: "Subagent widget error: widget boom", type: "warning" }]);
  });
  test("a session shutdown callback contains a widget stop failure", () => {
    const feed = fakeSource(); const h = harness({ sources: [feed] }); publish(); feed.emit(snapshotOf(2));
    let throwOnFocus = true;
    Object.defineProperty(h.component()!, "focused", { get: () => {
      if (throwOnFocus) throw new Error("focused boom");
      return false;
    } });
    expect(() => h.shutdown()).not.toThrow();
    throwOnFocus = false;
    h.shutdown();
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
  test("neither mount nor unmount rethrows, so handover still subscribes to the replacement", () => { const first = fakeSource(); const second = fakeSource(); harness({ sources: [first, second], setWidgetThrowsOn: "unmount" }); const tokenA = publish(); first.emit(snapshotOf(2)); tokenA.clear(); expect(() => publish()).not.toThrow(); expect(second.listenerCount()).toBe(1); });
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
  // This option mirrors PiSubagentsExtensionOptions; startup always receives ExtensionAPI.
  startWidget?: (pi: ExtensionAPI) => void;
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
  const api: ExtensionApiPort = {
    // The host accepts generic ToolDefinition values; this fake records only their observable fields.
    // ToolDefinition has no string index signature, so the fake receives object and narrows locally.
    registerTool: ((tool: object) => {
      const entry = tool as Record<string, unknown>;
      log.push(`tool:${String(entry.name)}`);
      registered.push(entry);
    }) as ExtensionApiPort["registerTool"],
    on: lifecycleOn(handlers, () => {
      if (options.onThrowsOnce === true && !onThrew) {
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
  const factory = options.omitStartWidget === true
    ? createPiSubagentsExtension(base)
    : createPiSubagentsExtension({
        ...base,
        startWidget: (pi: ExtensionAPI) => { log.push("startWidget"); options.startWidget?.(pi); },
      });
  factory(extensionApiForTest(api));
  const ctx: StartupContext = {
    notices: [],
    ui: { setStatus: () => {}, notify: (message: string) => { ctx.notices.push(message); } },
  };
  return {
    log, diagnostics, registered, ctx,
    tools: () => log.filter((entry) => entry.startsWith("tool:")),
    handlerNames: () => [...handlers].flatMap(([name, list]) => list.map(() => name)),
    start: async () => { for (const handler of handlers.get("session_start") ?? []) await handler({}, ctx); },
  };
}

describe("startup integration", () => {
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

  test("installs no widget when registration is disabled", () => {
    const h = startupHarness({ registration: { enabled: false, diagnostic: "depth exhausted" } });
    expect(h.log).toHaveLength(0);
  });

  test("a throwing startup is reported on both channels and costs no tool or lifecycle handler", async () => {
    const h = startupHarness({ startWidget: () => { throw new Error("widget boom"); } });
    expect(h.tools()).toHaveLength(4);
    expect(h.diagnostics).toEqual(["Subagent widget unavailable: widget boom"]);
    expect(h.ctx.notices).toHaveLength(0);
    await h.start();
    expect(h.ctx.notices).toEqual(["Subagent widget unavailable: widget boom"]);
    // Pi's public ToolDefinition contract requires a raw string toolCallId; no repository brand is compatible.
    // Recording through ExtensionApiPort erases this concrete tool's schema and context-only parameters.
    const spawn = h.registered.find((tool) => tool.name === "spawn_agent") as
      { execute(id: string, input: object, signal: AbortSignal): Promise<{ content: ReadonlyArray<{ text: string }> }> };
    const result = await spawn.execute("call-1", {}, new AbortController().signal);
    expect(result.content[0]?.text).toBe("spawn_agent");
    expect(h.handlerNames()).toEqual([
      "session_start", "session_start", "session_before_tree", "session_tree",
      "session_before_switch", "session_before_fork", "session_shutdown",
    ]);
  });

  test("sanitises thrown startup errors before diagnostics and notifications", async () => {
    const h = startupHarness({ startWidget: () => { throw new Error("widget \u001b[31mboom\u001b[0m\u0000"); } });
    expect(h.diagnostics).toEqual(["Subagent widget unavailable: widget boom"]);
    await h.start();
    expect(h.ctx.notices).toEqual(["Subagent widget unavailable: widget boom"]);
  });

  test("a failed fallback notification registration does not escape core installation", () => {
    let h: ReturnType<typeof startupHarness> | undefined;
    expect(() => {
      h = startupHarness({ startWidget: () => { throw new Error("widget boom"); }, onThrowsOnce: true });
    }).not.toThrow();
    expect(h!.tools()).toHaveLength(4);
    expect(h!.handlerNames()).toEqual([
      "session_start", "session_before_tree", "session_tree", "session_before_switch", "session_before_fork", "session_shutdown",
    ]);
  });

  test("a throwing startup diagnostic leaves tools and lifecycle available", async () => {
    let h: ReturnType<typeof startupHarness> | undefined;
    expect(() => {
      h = startupHarness({ startWidget: () => { throw new Error("widget boom"); }, diagnosticThrows: true });
    }).not.toThrow();
    expect(h!.tools()).toHaveLength(4);
    expect(h!.handlerNames()).toEqual([
      "session_start", "session_start", "session_before_tree", "session_tree",
      "session_before_switch", "session_before_fork", "session_shutdown",
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
    expect(h.widgets).toHaveLength(2);
  });
});
