import { createHash } from "node:crypto";

import type { AgentId, Milliseconds, UIRequestId } from "./domain.ts";
import type {
  WireExtensionUIDialog,
  WireExtensionUINotification,
} from "./schemas.ts";

export interface ExtensionUIDialogOptionsLike {
  signal?: AbortSignal;
  timeout?: Milliseconds;
}

export interface ExtensionUIContextLike {
  select(
    title: string,
    options: string[],
    opts?: ExtensionUIDialogOptionsLike,
  ): Promise<string | undefined>;
  confirm(
    title: string,
    message: string,
    opts?: ExtensionUIDialogOptionsLike,
  ): Promise<boolean>;
  input(
    title: string,
    placeholder?: string,
    opts?: ExtensionUIDialogOptionsLike,
  ): Promise<string | undefined>;
  editor(title: string, prefill?: string): Promise<string | undefined>;
  notify(message: string, type?: "info" | "warning" | "error"): void;
  setStatus(key: string, text: string | undefined): void;
  setWidget(
    key: string,
    lines: string[] | undefined,
    options?: { placement?: "aboveEditor" | "belowEditor" },
  ): void;
}

export interface UIForwarderContext {
  hasUI: boolean;
  ui: ExtensionUIContextLike;
}

export type UIForwardOutcome =
  | { type: "extension_ui_response"; id: UIRequestId; value: string }
  | { type: "extension_ui_response"; id: UIRequestId; confirmed: boolean }
  | { type: "extension_ui_response"; id: UIRequestId; cancelled: true };

interface QueuedDialog {
  readonly agentId: AgentId;
  readonly request: WireExtensionUIDialog;
  readonly signal: AbortSignal;
  readonly resolve: (outcome: UIForwardOutcome) => void;
  settled: boolean;
  removeAbortListener?: () => void;
}

interface UIResourceScope {
  readonly agentId: AgentId;
  readonly signal: AbortSignal;
  readonly statuses: Set<string>;
  readonly widgets: Set<string>;
  removeAbortListener: () => void;
  closed: boolean;
}

export class UIForwarder {
  private readonly pending: QueuedDialog[] = [];
  private readonly scopes = new Map<AbortSignal, UIResourceScope>();
  private readonly closeController = new AbortController();
  private current: QueuedDialog | undefined;
  private active = false;
  private closed = false;

  constructor(private readonly parent: UIForwarderContext) {}

  forward(
    agentId: AgentId,
    request: WireExtensionUIDialog,
    signal: AbortSignal,
  ): Promise<UIForwardOutcome> {
    if (!this.parent.hasUI || this.closed || signal.aborted) {
      return Promise.resolve(cancelled(request.id));
    }

    return new Promise<UIForwardOutcome>((resolve) => {
      const entry: QueuedDialog = {
        agentId,
        request,
        signal,
        resolve,
        settled: false,
      };
      const onAbort = (): void => {
        if (entry.settled || this.current === entry) return;
        const index = this.pending.indexOf(entry);
        if (index >= 0) this.pending.splice(index, 1);
        this.settle(entry, cancelled(entry.request.id));
        void this.pump();
      };
      signal.addEventListener("abort", onAbort, { once: true });
      entry.removeAbortListener = () => signal.removeEventListener("abort", onAbort);
      this.pending.push(entry);
      void this.pump();
    });
  }

  forwardNotification(
    agentId: AgentId,
    request: WireExtensionUINotification,
    signal: AbortSignal,
  ): void {
    if (!this.parent.hasUI || this.closed || signal.aborted) return;

    try {
      switch (request.method) {
        case "notify":
          this.parent.ui.notify(
            `[${agentId}] ${request.message}`,
            request.notifyType ?? "info",
          );
          return;
        case "setTitle":
        case "set_editor_text":
          return;
        case "setStatus": {
          const scope = this.scopeFor(agentId, signal);
          const key = parentResourceKey(agentId, request.statusKey);
          scope.statuses.add(key);
          this.parent.ui.setStatus(key, request.statusText);
          if (request.statusText === undefined) scope.statuses.delete(key);
          return;
        }
        case "setWidget": {
          const scope = this.scopeFor(agentId, signal);
          const key = parentResourceKey(agentId, request.widgetKey);
          scope.widgets.add(key);
          if (request.widgetLines === undefined) {
            this.parent.ui.setWidget(key, undefined);
          } else {
            this.parent.ui.setWidget(key, request.widgetLines, {
              placement: request.widgetPlacement ?? "aboveEditor",
            });
          }
          if (request.widgetLines === undefined) scope.widgets.delete(key);
          return;
        }
      }
    } catch {
      // Parent UI failures must not escape the RPC dispatch boundary.
    }
  }

  close(): void {
    if (this.closed) return;

    this.closed = true;
    this.closeController.abort();
    for (const entry of this.pending) {
      if (!entry.settled) this.settle(entry, cancelled(entry.request.id));
    }
    this.pending.length = 0;
    for (const scope of [...this.scopes.values()]) {
      this.cleanupScope(scope);
    }
  }

  private scopeFor(agentId: AgentId, signal: AbortSignal): UIResourceScope {
    const existing = this.scopes.get(signal);
    if (existing !== undefined) return existing;

    const scope: UIResourceScope = {
      agentId,
      signal,
      statuses: new Set(),
      widgets: new Set(),
      removeAbortListener: () => {},
      closed: false,
    };
    const onAbort = (): void => this.cleanupScope(scope);
    signal.addEventListener("abort", onAbort, { once: true });
    scope.removeAbortListener = () => signal.removeEventListener("abort", onAbort);
    this.scopes.set(signal, scope);
    if (signal.aborted) this.cleanupScope(scope);
    return scope;
  }

  private cleanupScope(scope: UIResourceScope): void {
    if (scope.closed) return;

    scope.closed = true;
    scope.removeAbortListener();
    this.scopes.delete(scope.signal);
    for (const key of scope.statuses) {
      try {
        this.parent.ui.setStatus(key, undefined);
      } catch {}
    }
    for (const key of scope.widgets) {
      try {
        this.parent.ui.setWidget(key, undefined);
      } catch {}
    }
    scope.statuses.clear();
    scope.widgets.clear();
  }

  private async pump(): Promise<void> {
    if (this.active) return;

    this.active = true;
    try {
      while (this.pending.length > 0) {
        const entry = this.pending.shift()!;
        if (entry.settled) continue;
        if (this.closed || entry.signal.aborted) {
          this.settle(entry, cancelled(entry.request.id));
          continue;
        }

        this.current = entry;
        let outcome: UIForwardOutcome;
        try {
          outcome = await this.dispatch(entry);
        } catch {
          outcome = cancelled(entry.request.id);
        } finally {
          this.current = undefined;
        }
        this.settle(
          entry,
          this.closed || entry.signal.aborted
            ? cancelled(entry.request.id)
            : outcome,
        );
      }
    } finally {
      this.active = false;
    }
  }

  private settle(entry: QueuedDialog, outcome: UIForwardOutcome): void {
    if (entry.settled) return;

    entry.settled = true;
    entry.removeAbortListener?.();
    entry.resolve(outcome);
  }

  private async dispatch(entry: QueuedDialog): Promise<UIForwardOutcome> {
    const { request } = entry;
    const label = `[${entry.agentId}] ${request.title}`;
    const signal = AbortSignal.any([entry.signal, this.closeController.signal]);
    const opts: ExtensionUIDialogOptionsLike = {
      signal,
      ...("timeout" in request && request.timeout !== undefined
        ? { timeout: request.timeout }
        : {}),
    };

    switch (request.method) {
      case "select": {
        const value = await this.parent.ui.select(label, request.options, opts);
        return value === undefined
          ? cancelled(request.id)
          : { type: "extension_ui_response", id: request.id, value };
      }
      case "confirm":
        return {
          type: "extension_ui_response",
          id: request.id,
          confirmed: await this.parent.ui.confirm(label, request.message, opts),
        };
      case "input": {
        const value = await this.parent.ui.input(label, request.placeholder, opts);
        return value === undefined
          ? cancelled(request.id)
          : { type: "extension_ui_response", id: request.id, value };
      }
      case "editor": {
        if (signal.aborted) return cancelled(request.id);
        const value = await this.parent.ui.editor(label, request.prefill);
        if (signal.aborted) return cancelled(request.id);
        return value === undefined
          ? cancelled(request.id)
          : { type: "extension_ui_response", id: request.id, value };
      }
    }
  }
}

function cancelled(id: UIRequestId): UIForwardOutcome {
  return { type: "extension_ui_response", id, cancelled: true };
}

function parentResourceKey(agentId: AgentId, childKey: string): string {
  const digest = createHash("sha256")
    .update(agentId)
    .update("\0")
    .update(childKey)
    .digest("hex")
    .slice(0, 24);
  return `pi-subagents:${digest}`;
}
