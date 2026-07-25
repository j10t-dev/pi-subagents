import { describe, expect, test } from "bun:test";

import {
  REQUIRED_EVENTS,
  classifyGate,
  screenHasAutocompleteSince,
  selectorDownWasConsumed,
  selectorIndicatorChanged,
  selectorSelectionIndicator,
  responseMarkerAppeared,
  safeGateDiagnostic,
} from "../scripts/run-widget-focus-gate.ts";

describe("widget focus gate", () => {
  test("requires submission, autocomplete and the clear action before any focus event", () => {
    expect(REQUIRED_EVENTS.slice(0, 3)).toEqual(["submitted", "autocomplete", "cleared"]);
  });

  test("accepts an in-order superset of the required events", () => {
    expect(classifyGate(["noise", ...REQUIRED_EVENTS, "noise"])).toBe("supported");
  });

  test("rejects a missing or reordered event", () => {
    expect(classifyGate(REQUIRED_EVENTS.slice(1))).toBe("unsupported");
    expect(classifyGate([...REQUIRED_EVENTS].reverse())).toBe("unsupported");
  });

  test("an empty transcript is not-run rather than unsupported", () => {
    expect(classifyGate([])).toBe("not-run");
  });

  test("requires a unique response marker after Enter rather than the editor echo", () => {
    const prompt = "Reply with the uppercase form of: widgetgateproof";
    const beforeEnter = `\u001b[2K> ${prompt}`;
    const marker = "WIDGETGATEPROOF";

    expect(responseMarkerAppeared(`${beforeEnter}\u001b[2K> ${prompt}`, marker, beforeEnter.length)).toBe(false);
    expect(responseMarkerAppeared(`${beforeEnter}\u001b[2K${marker}`, marker, beforeEnter.length)).toBe(true);
    expect(responseMarkerAppeared(`${marker}${beforeEnter}\u001b[2K${marker}`, marker, beforeEnter.length)).toBe(false);
  });

  test("detects autocomplete only when a current selector frame is added after slash", () => {
    const historical = "Commands\n/help";
    expect(screenHasAutocompleteSince(`${historical}\n→ settings Open settings menu\n  (1/23)`, historical.length)).toBe(true);
    expect(screenHasAutocompleteSince(historical, historical.length)).toBe(false);
  });

  test("reads the selector selection indicator from its frame", () => {
    expect(selectorSelectionIndicator("\u001b[2K❯ settings ... (1/23)")).toBe("❯");
    expect(selectorSelectionIndicator("\u001b[2K→ settings Open settings menu\n\u001b[2K  (1/23)")).toBe("→");
    expect(selectorSelectionIndicator("\u001b[2K  settings ... (2/23)")).toBe(" ");
    expect(selectorSelectionIndicator("no selector")).toBeUndefined();
  });

  test("requires the second selector frame to change its selection indicator", () => {
    expect(selectorIndicatorChanged("❯", " ")).toBe(true);
    expect(selectorIndicatorChanged("❯", "❯")).toBe(false);
    expect(selectorIndicatorChanged("❯", undefined)).toBe(false);
  });

  test("accepts selector-owned Down despite editor native-arrow instrumentation", () => {
    expect(selectorDownWasConsumed("→", " ", ["native-arrow"])).toBe(true);
    expect(selectorDownWasConsumed("→", " ", ["widget-focused"])).toBe(false);
    expect(selectorDownWasConsumed("→", "→", [])).toBe(false);
  });

  test("reports only bounded structural diagnostics, not terminal content", () => {
    const secret = "model response with \u001b]52;c;clipboard-data\u0007 and user input";
    const diagnostic = safeGateDiagnostic("selector Down", secret.repeat(500), ["native-arrow"]);

    expect(diagnostic).toContain("phase=selector_Down");
    expect(diagnostic).toContain("outputLength=");
    expect(diagnostic).toContain("trace=native-arrow");
    expect(diagnostic).not.toContain("model response");
    expect(diagnostic).not.toContain("clipboard-data");
    expect(diagnostic).not.toContain("\u001b");
    expect(diagnostic.length).toBeLessThanOrEqual(300);
  });

  test("does not expose unknown trace content in diagnostics", () => {
    const diagnostic = safeGateDiagnostic("turn failure", "private model text", ["unknown-secret", "widget-focused"]);

    expect(diagnostic).toContain("phase=turn_failure");
    expect(diagnostic).toContain("trace=widget-focused");
    expect(diagnostic).not.toContain("private model text");
    expect(diagnostic).not.toContain("unknown-secret");
  });
});
