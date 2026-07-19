import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

/** The exact `ExtensionAPI` surface the extension suites exercise. */
export type ExtensionApiPort = Pick<ExtensionAPI,
  "registerTool" | "on" | "appendEntry" | "sendMessage" |
  "getThinkingLevel" | "getActiveTools">;

export type LifecycleHandler<Context> = (event: object, context: Context) => Promise<void> | void;

/** Adapts the intentionally partial host fake; unused ExtensionAPI methods are absent. */
export function extensionApiForTest(api: ExtensionApiPort): ExtensionAPI {
  return api as ExtensionAPI;
}

/** The tests only dispatch lifecycle events; this narrows Pi's overloaded host callback API once. */
export function lifecycleOn<Context>(handlers: Map<string, Array<LifecycleHandler<Context>>>): ExtensionApiPort["on"] {
  const register = (name: string, handler: LifecycleHandler<Context>): void => {
    handlers.set(name, [...(handlers.get(name) ?? []), handler]);
  };
  // Pi's `on` is an overload set keyed on event name; no single function type is assignable to it,
  // so the one adaptation lives here rather than at each suite's fake.
  return register as unknown as ExtensionApiPort["on"];
}
