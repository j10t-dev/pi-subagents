import { describe, expect, test } from "bun:test";

import { agentId } from "../src/domain.ts";
import type { AgentId } from "../src/domain.ts";
import { createHash } from "node:crypto";
import type {
  WireExtensionUIDialog as WireExtensionUIRequest,
  WireExtensionUINotification,
} from "../src/rpc-wire.ts";
import { UIForwarder, type ExtensionUIContextLike } from "../src/ui-forwarder.ts";

const AGENT_A = agentId("agent-a");
const AGENT_B = agentId("agent-b");

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

function confirm(id: string, title = id.toUpperCase()): WireExtensionUIRequest {
  return { type: "extension_ui_request", method: "confirm", id, title, message: `Confirm ${id}?` };
}

function missingSignalTypeFixture(): void {
  const broker = new UIForwarder({ hasUI: true, ui: {
    select: async () => undefined,
    confirm: async () => false,
    input: async () => undefined,
    editor: async () => undefined,
    notify: () => {},
    setStatus: () => {},
    setWidget: () => {},
  } });
  // @ts-expect-error `forward` must require an owning run signal.
  void broker.forward(AGENT_A, confirm("missing-signal"));
}

function controlledUI(overrides: Partial<ExtensionUIContextLike> = {}): ExtensionUIContextLike {
  return {
    select: async () => undefined,
    confirm: async () => true,
    input: async () => undefined,
    editor: async () => undefined,
    notify: () => {},
    setStatus: () => {},
    setWidget: () => {},
    ...overrides,
  };
}

function forward(
  broker: UIForwarder,
  owner: AgentId,
  request: WireExtensionUIRequest,
  controller = new AbortController(),
) {
  return broker.forward(owner, request, controller.signal);
}

describe("UIForwarder broker", () => {
  test("serialises dialogs in FIFO order across agents", async () => {
    const firstEntered = deferred<void>();
    const releaseFirst = deferred<void>();
    const order: string[] = [];
    let active = 0;
    let peak = 0;
    const broker = new UIForwarder({ hasUI: true, ui: controlledUI({
      confirm: async (title) => {
        active += 1;
        peak = Math.max(peak, active);
        order.push(title);
        if (order.length === 1) { firstEntered.resolve(); await releaseFirst.promise; }
        active -= 1;
        return true;
      },
    }) });
    const a = new AbortController();
    const b = new AbortController();

    const first = broker.forward(AGENT_A, confirm("a", "A"), a.signal);
    await firstEntered.promise;
    const second = broker.forward(AGENT_B, confirm("b", "B"), b.signal);
    expect(order).toHaveLength(1);
    releaseFirst.resolve();

    await expect(Promise.all([first, second])).resolves.toHaveLength(2);
    expect(peak).toBe(1);
    expect(order).toEqual(["[agent-a] A", "[agent-b] B"]);
  });

  test("preserves same-agent FIFO order", async () => {
    const firstEntered = deferred<void>();
    const releaseFirst = deferred<void>();
    const order: string[] = [];
    const broker = new UIForwarder({ hasUI: true, ui: controlledUI({ confirm: async (title) => {
      order.push(title);
      if (order.length === 1) { firstEntered.resolve(); await releaseFirst.promise; }
      return true;
    } }) });

    const first = forward(broker, AGENT_A, confirm("first", "First"));
    await firstEntered.promise;
    const second = forward(broker, AGENT_A, confirm("second", "Second"));
    expect(order).toEqual(["[agent-a] First"]);
    releaseFirst.resolve();

    await Promise.all([first, second]);
    expect(order).toEqual(["[agent-a] First", "[agent-a] Second"]);
  });

  test("isolates a rejected parent operation and continues with the next request", async () => {
    const order: string[] = [];
    const broker = new UIForwarder({ hasUI: true, ui: controlledUI({ confirm: async (title) => {
      order.push(title);
      if (order.length === 1) throw new Error("dialog failed");
      return true;
    } }) });

    const first = forward(broker, AGENT_A, confirm("failed", "Failed"));
    const second = forward(broker, AGENT_B, confirm("next", "Next"));

    await expect(first).resolves.toEqual({ type: "extension_ui_response", id: "failed", cancelled: true });
    await expect(second).resolves.toEqual({ type: "extension_ui_response", id: "next", confirmed: true });
    expect(order).toEqual(["[agent-a] Failed", "[agent-b] Next"]);
  });

  test("returns immediate correlated cancellation without invoking absent UI", async () => {
    let invoked = false;
    const broker = new UIForwarder({ hasUI: false, ui: controlledUI({ confirm: async () => { invoked = true; return true; } }) });

    await expect(forward(broker, AGENT_A, confirm("no-ui"))).resolves.toEqual({
      type: "extension_ui_response", id: "no-ui", cancelled: true,
    });
    expect(invoked).toBeFalse();
  });

  test("aborting a queued request settles it immediately and never displays it", async () => {
    const entered = deferred<void>();
    const release = deferred<void>();
    const shown: string[] = [];
    const broker = new UIForwarder({ hasUI: true, ui: controlledUI({ confirm: async (title) => {
      shown.push(title);
      if (shown.length === 1) { entered.resolve(); await release.promise; }
      return true;
    } }) });
    const queuedController = new AbortController();
    const active = forward(broker, AGENT_A, confirm("active", "Active"));
    await entered.promise;
    const queued = broker.forward(AGENT_B, confirm("queued", "Queued"), queuedController.signal);

    queuedController.abort();
    await expect(queued).resolves.toEqual({ type: "extension_ui_response", id: "queued", cancelled: true });
    expect(shown).toEqual(["[agent-a] Active"]);
    release.resolve();
    await active;
  });

  for (const method of ["select", "confirm", "input"] as const) {
    test(`aborting an active ${method} is observable on the options signal`, async () => {
      const entered = deferred<AbortSignal>();
      const request: WireExtensionUIRequest = method === "select"
        ? { type: "extension_ui_request", method, id: method, title: "Choose", options: ["one"], timeout: 50 }
        : method === "confirm"
          ? { type: "extension_ui_request", method, id: method, title: "Confirm", message: "Proceed?", timeout: 50 }
          : { type: "extension_ui_request", method, id: method, title: "Input", placeholder: "Value", timeout: 50 };
      const waitForAbort = async (_title: string, _value: string[] | string | undefined, opts?: { signal?: AbortSignal }): Promise<never> => {
        if (opts?.signal === undefined) throw new Error("missing signal");
        entered.resolve(opts.signal);
        await new Promise<void>((resolve) => opts.signal!.addEventListener("abort", () => resolve(), { once: true }));
        throw new Error("cancelled by signal");
      };
      const ui = controlledUI({
        select: (title, options, opts) => waitForAbort(title, options, opts),
        confirm: (title, message, opts) => waitForAbort(title, message, opts),
        input: (title, placeholder, opts) => waitForAbort(title, placeholder, opts),
      });
      const broker = new UIForwarder({ hasUI: true, ui });
      const controller = new AbortController();
      const outcome = broker.forward(AGENT_A, request, controller.signal);
      const signal = await entered.promise;

      controller.abort();

      expect(signal.aborted).toBeTrue();
      await expect(outcome).resolves.toEqual({ type: "extension_ui_response", id: method, cancelled: true });
    });
  }

  test("skips an editor cancelled before its turn", async () => {
    const entered = deferred<void>();
    const release = deferred<void>();
    let editors = 0;
    const broker = new UIForwarder({ hasUI: true, ui: controlledUI({
      confirm: async () => { entered.resolve(); await release.promise; return true; },
      editor: async () => { editors++; return "edited"; },
    }) });
    const controller = new AbortController();
    const active = forward(broker, AGENT_A, confirm("active"));
    await entered.promise;
    const editor = broker.forward(AGENT_B, { type: "extension_ui_request", method: "editor", id: "editor", title: "Edit", prefill: "text" }, controller.signal);

    controller.abort();
    await expect(editor).resolves.toEqual({ type: "extension_ui_response", id: "editor", cancelled: true });
    release.resolve();
    await active;
    expect(editors).toBe(0);
  });

  test("discards an active editor value when its run is cancelled", async () => {
    const entered = deferred<void>();
    const release = deferred<string | undefined>();
    const broker = new UIForwarder({ hasUI: true, ui: controlledUI({ editor: async () => { entered.resolve(); return release.promise; } }) });
    const controller = new AbortController();
    const outcome = broker.forward(AGENT_A, { type: "extension_ui_request", method: "editor", id: "editor-active", title: "Edit" }, controller.signal);
    await entered.promise;

    controller.abort();
    release.resolve("must be discarded");

    await expect(outcome).resolves.toEqual({ type: "extension_ui_response", id: "editor-active", cancelled: true });
  });

  test("close settles all queued requests while an active editor remains unresolved", async () => {
    const entered = deferred<void>();
    const release = deferred<string | undefined>();
    const broker = new UIForwarder({ hasUI: true, ui: controlledUI({ editor: async () => { entered.resolve(); return release.promise; } }) });
    const active = forward(broker, AGENT_A, { type: "extension_ui_request", method: "editor", id: "active-editor", title: "Edit" });
    await entered.promise;
    const queuedA = forward(broker, AGENT_A, confirm("queued-a"));
    const queuedB = forward(broker, AGENT_B, confirm("queued-b"));

    broker.close();

    await expect(Promise.all([queuedA, queuedB])).resolves.toEqual([
      { type: "extension_ui_response", id: "queued-a", cancelled: true },
      { type: "extension_ui_response", id: "queued-b", cancelled: true },
    ]);
    release.resolve("late");
    await expect(active).resolves.toEqual({ type: "extension_ui_response", id: "active-editor", cancelled: true });
  });

  test("close signals an active abort-aware dialog", async () => {
    const entered = deferred<AbortSignal>();
    const broker = new UIForwarder({ hasUI: true, ui: controlledUI({ confirm: async (_title, _message, opts) => {
      if (opts?.signal === undefined) throw new Error("missing signal");
      entered.resolve(opts.signal);
      await new Promise<void>((resolve) => opts.signal!.addEventListener("abort", () => resolve(), { once: true }));
      throw new Error("closed");
    } }) });
    const outcome = forward(broker, AGENT_A, confirm("active"));
    const signal = await entered.promise;

    broker.close();

    expect(signal.aborted).toBeTrue();
    await expect(outcome).resolves.toEqual({ type: "extension_ui_response", id: "active", cancelled: true });
  });

  test("relays notifications and cleans scoped resources", () => {
    const notifications: Array<[string, string | undefined]> = [];
    const statuses: Array<[string, string | undefined]> = [];
    const widgets: Array<[string, string[] | undefined, { placement?: "aboveEditor" | "belowEditor" } | undefined]> = [];
    const broker = new UIForwarder({ hasUI: true, ui: controlledUI({
      notify: (message, type) => notifications.push([message, type]),
      setStatus: (key, text) => statuses.push([key, text]),
      setWidget: (key, lines, options) => widgets.push([key, lines, options]),
    }) });
    const controller = new AbortController();
    const notification = { type: "extension_ui_request", id: "n", method: "notify", message: "done", notifyType: "warning" } satisfies WireExtensionUINotification;
    const status = { type: "extension_ui_request", id: "s", method: "setStatus", statusKey: "build", statusText: "running" } satisfies WireExtensionUINotification;
    const widget = { type: "extension_ui_request", id: "w", method: "setWidget", widgetKey: "jobs", widgetLines: ["one"], widgetPlacement: "belowEditor" } satisfies WireExtensionUINotification;
    broker.forwardNotification(AGENT_A, notification, controller.signal);
    broker.forwardNotification(AGENT_A, status, controller.signal);
    broker.forwardNotification(AGENT_A, widget, controller.signal);
    const statusKey = expectedParentKey(AGENT_A, "build");
    const widgetKey = expectedParentKey(AGENT_A, "jobs");
    expect(notifications).toEqual([["[agent-a] done", "warning"]]);
    expect(statuses).toEqual([[statusKey, "running"]]);
    expect(widgets).toEqual([[widgetKey, ["one"], { placement: "belowEditor" }]]);
    controller.abort();
    expect(statuses).toEqual([[statusKey, "running"], [statusKey, undefined]]);
    expect(widgets).toEqual([[widgetKey, ["one"], { placement: "belowEditor" }], [widgetKey, undefined, undefined]]);
  });

  test("defaults an omitted notify severity to info", () => {
    const calls: Array<[string, string | undefined]> = [];
    const broker = new UIForwarder({ hasUI: true, ui: controlledUI({ notify: (message, type) => calls.push([message, type]) }) });

    broker.forwardNotification(AGENT_A, { type: "extension_ui_request", id: "notify", method: "notify", message: "done" }, new AbortController().signal);

    expect(calls).toEqual([["[agent-a] done", "info"]]);
  });

  test("defaults an omitted widget placement to aboveEditor", () => {
    const calls: Array<[string, string[] | undefined, { placement?: "aboveEditor" | "belowEditor" } | undefined]> = [];
    const broker = new UIForwarder({ hasUI: true, ui: controlledUI({ setWidget: (key, lines, options) => calls.push([key, lines, options]) }) });

    broker.forwardNotification(AGENT_A, { type: "extension_ui_request", id: "widget", method: "setWidget", widgetKey: "jobs", widgetLines: ["one"] }, new AbortController().signal);

    expect(calls).toEqual([[expectedParentKey(AGENT_A, "jobs"), ["one"], { placement: "aboveEditor" }]]);
  });

  test("successful explicit resource clears relinquish ownership", () => {
    const statuses: Array<[string, string | undefined]> = [];
    const widgets: Array<[string, string[] | undefined]> = [];
    const broker = new UIForwarder({ hasUI: true, ui: controlledUI({
      setStatus: (key, text) => statuses.push([key, text]),
      setWidget: (key, lines) => widgets.push([key, lines]),
    }) });
    const controller = new AbortController();

    broker.forwardNotification(AGENT_A, { type: "extension_ui_request", id: "status-set", method: "setStatus", statusKey: "build", statusText: "running" }, controller.signal);
    broker.forwardNotification(AGENT_A, { type: "extension_ui_request", id: "widget-set", method: "setWidget", widgetKey: "jobs", widgetLines: ["one"] }, controller.signal);
    broker.forwardNotification(AGENT_A, { type: "extension_ui_request", id: "status-clear", method: "setStatus", statusKey: "build" }, controller.signal);
    broker.forwardNotification(AGENT_A, { type: "extension_ui_request", id: "widget-clear", method: "setWidget", widgetKey: "jobs" }, controller.signal);
    controller.abort();

    expect(statuses).toEqual([[expectedParentKey(AGENT_A, "build"), "running"], [expectedParentKey(AGENT_A, "build"), undefined]]);
    expect(widgets).toEqual([[expectedParentKey(AGENT_A, "jobs"), ["one"]], [expectedParentKey(AGENT_A, "jobs"), undefined]]);
  });

  test("failed explicit clear remains owned for one terminal cleanup", () => {
    const key = expectedParentKey(AGENT_A, "build");
    const calls: Array<[string, string | undefined]> = [];
    let failClear = true;
    const broker = new UIForwarder({ hasUI: true, ui: controlledUI({ setStatus: (actualKey, text) => {
      calls.push([actualKey, text]);
      if (text === undefined && failClear) { failClear = false; throw new Error("clear failed"); }
    } }) });
    const controller = new AbortController();

    broker.forwardNotification(AGENT_A, { type: "extension_ui_request", id: "set", method: "setStatus", statusKey: "build", statusText: "running" }, controller.signal);
    broker.forwardNotification(AGENT_A, { type: "extension_ui_request", id: "clear", method: "setStatus", statusKey: "build" }, controller.signal);
    controller.abort();

    expect(calls).toEqual([[key, "running"], [key, undefined], [key, undefined]]);
  });

  test("cleanup continues after one resource clear throws", () => {
    const calls: string[] = [];
    const broker = new UIForwarder({ hasUI: true, ui: controlledUI({
      setStatus: (key, text) => { calls.push(`status:${key}:${text}`); throw new Error("status clear failed"); },
      setWidget: (key, lines) => calls.push(`widget:${key}:${lines === undefined ? "clear" : "set"}`),
    }) });
    const controller = new AbortController();

    broker.forwardNotification(AGENT_A, { type: "extension_ui_request", id: "status", method: "setStatus", statusKey: "build", statusText: "running" }, controller.signal);
    broker.forwardNotification(AGENT_A, { type: "extension_ui_request", id: "widget", method: "setWidget", widgetKey: "jobs", widgetLines: ["one"] }, controller.signal);
    controller.abort();

    expect(calls).toContain(`widget:${expectedParentKey(AGENT_A, "jobs")}:clear`);
  });

  test("removes aborted scope bookkeeping before a later scope reuses its resource key", () => {
    const key = expectedParentKey(AGENT_A, "build");
    const calls: Array<[string, string | undefined]> = [];
    const broker = new UIForwarder({ hasUI: true, ui: controlledUI({ setStatus: (actualKey, text) => calls.push([actualKey, text]) }) });
    const first = new AbortController();
    const second = new AbortController();

    broker.forwardNotification(AGENT_A, { type: "extension_ui_request", id: "first", method: "setStatus", statusKey: "build", statusText: "one" }, first.signal);
    first.abort();
    broker.forwardNotification(AGENT_A, { type: "extension_ui_request", id: "second", method: "setStatus", statusKey: "build", statusText: "two" }, second.signal);
    second.abort();

    expect(calls).toEqual([[key, "one"], [key, undefined], [key, "two"], [key, undefined]]);
  });

  test("close clears every scope and repeated close is harmless", () => {
    const statuses: Array<[string, string | undefined]> = [];
    const widgets: Array<[string, string[] | undefined]> = [];
    const broker = new UIForwarder({ hasUI: true, ui: controlledUI({
      setStatus: (key, text) => statuses.push([key, text]), setWidget: (key, lines) => widgets.push([key, lines]),
    }) });
    const a = new AbortController();
    const b = new AbortController();

    broker.forwardNotification(AGENT_A, { type: "extension_ui_request", id: "status", method: "setStatus", statusKey: "build", statusText: "running" }, a.signal);
    broker.forwardNotification(AGENT_B, { type: "extension_ui_request", id: "widget", method: "setWidget", widgetKey: "jobs", widgetLines: ["one"] }, b.signal);
    broker.close();
    broker.close();

    expect(statuses).toEqual([[expectedParentKey(AGENT_A, "build"), "running"], [expectedParentKey(AGENT_A, "build"), undefined]]);
    expect(widgets).toEqual([[expectedParentKey(AGENT_B, "jobs"), ["one"]], [expectedParentKey(AGENT_B, "jobs"), undefined]]);
  });

  test("closed and already-aborted notifications do no UI work", () => {
    const calls: string[] = [];
    const broker = new UIForwarder({ hasUI: true, ui: controlledUI({ notify: (message) => calls.push(message) }) });
    const aborted = new AbortController();
    aborted.abort();

    broker.forwardNotification(AGENT_A, { type: "extension_ui_request", id: "aborted", method: "notify", message: "no" }, aborted.signal);
    broker.close();
    broker.forwardNotification(AGENT_A, { type: "extension_ui_request", id: "closed", method: "notify", message: "no" }, new AbortController().signal);

    expect(calls).toEqual([]);
  });

  test("title and editor-text notifications do no UI work", () => {
    let calls = 0;
    const broker = new UIForwarder({ hasUI: true, ui: controlledUI({
      notify: () => { calls++; }, setStatus: () => { calls++; }, setWidget: () => { calls++; },
    }) });
    const signal = new AbortController().signal;

    broker.forwardNotification(AGENT_A, { type: "extension_ui_request", id: "title", method: "setTitle", title: "child" }, signal);
    broker.forwardNotification(AGENT_A, { type: "extension_ui_request", id: "editor", method: "set_editor_text", text: "draft" }, signal);

    expect(calls).toBe(0);
  });

  test("a pending dialog does not delay notifications", async () => {
    const entered = deferred<void>();
    const release = deferred<boolean>();
    const notifications: string[] = [];
    const broker = new UIForwarder({ hasUI: true, ui: controlledUI({
      confirm: async () => { entered.resolve(); return release.promise; },
      notify: (message) => notifications.push(message),
    }) });
    const controller = new AbortController();
    const dialog = broker.forward(AGENT_A, confirm("dialog"), controller.signal);
    await entered.promise;

    broker.forwardNotification(AGENT_A, { type: "extension_ui_request", id: "notify", method: "notify", message: "now" }, controller.signal);
    expect(notifications).toEqual(["[agent-a] now"]);
    release.resolve(true);
    await dialog;
  });

  test("repeated close and post-close forwarding are safe correlated cancellations", async () => {
    const broker = new UIForwarder({ hasUI: true, ui: controlledUI() });
    broker.close();
    broker.close();

    await expect(forward(broker, AGENT_A, confirm("post-close"))).resolves.toEqual({
      type: "extension_ui_response", id: "post-close", cancelled: true,
    });
  });
});

function expectedParentKey(agent: AgentId, childKey: string): string {
  return `pi-subagents:${createHash("sha256").update(agent).update("\0").update(childKey).digest("hex").slice(0, 24)}`;
}
