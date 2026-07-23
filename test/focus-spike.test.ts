import { describe, expect, test } from "bun:test";

import { assertOrdered, encodeKey, parseOutcome } from "../scripts/focus-spike-protocol.ts";

describe("focus-spike-protocol", () => {
  test("encodeKey maps arrow and control keys to raw terminal bytes", () => {
    expect(encodeKey("up")).toBe("\x1b[A");
    expect(encodeKey("down")).toBe("\x1b[B");
    expect(encodeKey("enter")).toBe("\r");
    expect(encodeKey("escape")).toBe("\x1b");
  });

  test("assertOrdered accepts an in-order subsequence", () => {
    expect(() =>
      assertOrdered(["a", "x", "b", "y", "c"], ["a", "b", "c"]),
    ).not.toThrow();
  });

  test("assertOrdered rejects a missing or out-of-order event", () => {
    expect(() => assertOrdered(["a", "c", "b"], ["a", "b", "c"])).toThrow(/ordering/);
    expect(() => assertOrdered(["a", "b"], ["a", "b", "c"])).toThrow(/ordering/);
  });

  test("parseOutcome reads the labelled spike result for each mechanism", () => {
    expect(parseOutcome("noise\nFOCUS_TRANSFER_PRIMARY_SUPPORTED\n")).toEqual({
      mechanism: "primary",
      supported: true,
    });
    expect(parseOutcome("FOCUS_TRANSFER_PRIMARY_UNSUPPORTED")).toEqual({
      mechanism: "primary",
      supported: false,
    });
    expect(parseOutcome("FOCUS_TRANSFER_FALLBACK_SUPPORTED")).toEqual({
      mechanism: "fallback",
      supported: true,
    });
  });

  test("parseOutcome throws when no label is present", () => {
    expect(() => parseOutcome("nothing here")).toThrow(/no focus outcome/i);
  });
});
