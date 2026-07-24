import { describe, expect, test } from "bun:test";
import type { SubagentObservationPort } from "../src/agent-observation.ts";
import { onObservationPort, publishObservationPort } from "../src/observation-registry.ts";

function port(name: string): SubagentObservationPort {
  void name;
  return {
    observation: () => undefined,
    directSnapshot: () => ({ kind: "unavailable", finalRevision: 0 as never }),
    transcriptSource: () => undefined,
    subscribe: () => () => {},
  };
}

describe("observation registry", () => {
  test("replays the current port and ignores stale clear tokens", () => {
    const seen: Array<SubagentObservationPort | undefined> = [];
    const first = publishObservationPort(port("first"));
    const unsubscribe = onObservationPort((value) => seen.push(value));
    const secondPort = port("second");
    const second = publishObservationPort(secondPort);
    first.clear();
    expect(seen.at(-1)).toBe(secondPort);
    second.clear();
    expect(seen.at(-1)).toBeUndefined();
    unsubscribe();
  });

  test("throwing and thenable listeners are removed without blocking publication", () => {
    const calls: string[] = [];
    onObservationPort(() => { calls.push("throw"); throw new Error("fault"); });
    onObservationPort(() => { calls.push("thenable"); return Promise.resolve() as never; });
    const publication = publishObservationPort(port("one"));
    publication.clear();
    expect(calls).toEqual(["throw", "thenable"]);
  });
});
