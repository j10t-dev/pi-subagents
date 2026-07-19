import { describe, expect, test } from "bun:test";

import { agentId } from "../src/domain.ts";
import type { WireExtensionUIDialog as WireExtensionUIRequest } from "../src/schemas.ts";
import { UIForwarder } from "../src/ui-forwarder.ts";
import type { ExtensionUIContextLike } from "../src/ui-forwarder.ts";

// Gated by the real-Pi spike in scripts/run-ui-spike.ts: two consecutive real-Pi runs
// each produced DIRECT_UI_FORWARDING_SUPPORTED, so ui-forwarder.ts forwards extension UI
// requests directly to ctx.ui from asynchronous child-RPC callbacks rather than queuing them
// for a later agent_settled drain.

const RUN_SIGNAL = new AbortController().signal;

function fakeUi(overrides: Partial<ExtensionUIContextLike> = {}): ExtensionUIContextLike {
  return {
    select: async () => undefined,
    confirm: async () => false,
    input: async () => undefined,
    editor: async () => undefined,
    notify: () => {},
    setStatus: () => {},
    setWidget: () => {},
    ...overrides,
  };
}

describe("UIForwarder (direct forwarding, per real-Pi spike result)", () => {
  test("forwards a select request and reports the chosen value", async () => {
    const ui = fakeUi({ select: async (_title, options) => options[1] });
    const forwarder = new UIForwarder({ hasUI: true, ui });
    const request: WireExtensionUIRequest = {
      type: "extension_ui_request",
      id: "req-1",
      method: "select",
      title: "Pick one",
      options: ["a", "b"],
    };
    const outcome = await forwarder.forward(agentId("agent-1"), request, RUN_SIGNAL);
    expect(outcome).toEqual({ type: "extension_ui_response", id: "req-1", value: "b" });
  });

  test("reports cancellation as cancelled:true rather than a value", async () => {
    const forwarder = new UIForwarder({ hasUI: true, ui: fakeUi() });
    const request: WireExtensionUIRequest = {
      type: "extension_ui_request",
      id: "req-2",
      method: "select",
      title: "Pick one",
      options: ["a", "b"],
    };
    const outcome = await forwarder.forward(agentId("agent-1"), request, RUN_SIGNAL);
    expect(outcome).toEqual({ type: "extension_ui_response", id: "req-2", cancelled: true });
  });

  test("forwards a confirm request and reports the boolean result", async () => {
    const ui = fakeUi({ confirm: async () => true });
    const forwarder = new UIForwarder({ hasUI: true, ui });
    const request: WireExtensionUIRequest = {
      type: "extension_ui_request",
      id: "req-3",
      method: "confirm",
      title: "Proceed?",
      message: "Are you sure?",
    };
    const outcome = await forwarder.forward(agentId("agent-1"), request, RUN_SIGNAL);
    expect(outcome).toEqual({ type: "extension_ui_response", id: "req-3", confirmed: true });
  });

  test("forwards an input request and reports the typed value", async () => {
    const ui = fakeUi({ input: async () => "typed value" });
    const forwarder = new UIForwarder({ hasUI: true, ui });
    const request: WireExtensionUIRequest = {
      type: "extension_ui_request",
      id: "req-4",
      method: "input",
      title: "Name?",
    };
    const outcome = await forwarder.forward(agentId("agent-1"), request, RUN_SIGNAL);
    expect(outcome).toEqual({ type: "extension_ui_response", id: "req-4", value: "typed value" });
  });

  test("forwards an editor request and reports the edited value", async () => {
    const calls: Array<[string, string | undefined]> = [];
    const ui = fakeUi({
      editor: async (title, prefill) => {
        calls.push([title, prefill]);
        return "edited value";
      },
    });
    const forwarder = new UIForwarder({ hasUI: true, ui });
    const request: WireExtensionUIRequest = {
      type: "extension_ui_request",
      id: "req-5",
      method: "editor",
      title: "Edit",
    };
    const outcome = await forwarder.forward(agentId("agent-1"), request, RUN_SIGNAL);
    expect(outcome).toEqual({ type: "extension_ui_response", id: "req-5", value: "edited value" });
    expect(calls).toEqual([["[agent-1] Edit", undefined]]);
  });

  test("reports editor cancellation when the parent editor is cancelled", async () => {
    const forwarder = new UIForwarder({ hasUI: true, ui: fakeUi() });
    const outcome = await forwarder.forward(agentId("agent-1"), {
      type: "extension_ui_request",
      id: "req-editor-cancel",
      method: "editor",
      title: "Edit",
      prefill: "original",
    }, RUN_SIGNAL);
    expect(outcome).toEqual({ type: "extension_ui_response", id: "req-editor-cancel", cancelled: true });
  });

  test("cancels every request immediately when the parent context has no UI", async () => {
    const forwarder = new UIForwarder({ hasUI: false, ui: fakeUi() });
    const request: WireExtensionUIRequest = {
      type: "extension_ui_request",
      id: "req-6",
      method: "confirm",
      title: "Proceed?",
      message: "no ui here",
    };
    const outcome = await forwarder.forward(agentId("agent-1"), request, RUN_SIGNAL);
    expect(outcome).toEqual({ type: "extension_ui_response", id: "req-6", cancelled: true });
  });

  test("labels the dialog title with the owning agent id", async () => {
    const seenTitles: string[] = [];
    const ui = fakeUi({
      confirm: async (title) => {
        seenTitles.push(title);
        return true;
      },
    });
    const forwarder = new UIForwarder({ hasUI: true, ui });
    const request: WireExtensionUIRequest = {
      type: "extension_ui_request",
      id: "req-7",
      method: "confirm",
      title: "Proceed?",
      message: "msg",
    };
    await forwarder.forward(agentId("agent-42"), request, RUN_SIGNAL);
    expect(seenTitles[0]).toContain("agent-42");
    expect(seenTitles[0]).toContain("Proceed?");
  });

  test("serialises simultaneous dialogs from different agents one at a time", async () => {
    const order: string[] = [];
    let resolveFirst: (() => void) | undefined;
    const ui = fakeUi({
      confirm: async (title) => {
        order.push(`start:${title}`);
        if (resolveFirst === undefined) {
          await new Promise<void>((resolve) => {
            resolveFirst = resolve;
          });
        }
        order.push(`end:${title}`);
        return true;
      },
    });
    const forwarder = new UIForwarder({ hasUI: true, ui });
    const requestA: WireExtensionUIRequest = {
      type: "extension_ui_request",
      id: "req-a",
      method: "confirm",
      title: "A",
      message: "m",
    };
    const requestB: WireExtensionUIRequest = {
      type: "extension_ui_request",
      id: "req-b",
      method: "confirm",
      title: "B",
      message: "m",
    };
    const first = forwarder.forward(agentId("agent-1"), requestA, RUN_SIGNAL);
    const second = forwarder.forward(agentId("agent-2"), requestB, RUN_SIGNAL);
    await Promise.resolve();
    await Promise.resolve();
    expect(order).toEqual(["start:[agent-1] A"]);
    resolveFirst?.();
    await Promise.all([first, second]);
    expect(order).toEqual(["start:[agent-1] A", "end:[agent-1] A", "start:[agent-2] B", "end:[agent-2] B"]);
  });
});
