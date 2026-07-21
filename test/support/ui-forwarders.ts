import { UIForwarder } from "../../src/ui-forwarder.ts";

export function fakeUiForwarder(hasUI = false): UIForwarder {
  return new UIForwarder({
    hasUI,
    ui: {
      select: async () => undefined,
      confirm: async () => false,
      input: async () => undefined,
      editor: async () => undefined,
      notify: () => {},
      setStatus: () => {},
      setWidget: () => {},
    },
  });
}
