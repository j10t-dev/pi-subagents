import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, test } from "bun:test";

import {
  focusResult,
  relayResult,
  spikeExecutionFromResult,
  type SpikeProcessResult,
} from "../scripts/b0-orchestration.ts";
import { evaluateB0Report, type B0Report } from "../scripts/b0-report.ts";
import { detectGlobalPi, type PiVersionProbeResult } from "../scripts/pi-runtime-target.ts";

test("active B0 scripts contain no local CLI fallback or version-selection flag", () => {
  for (const file of ["run-b0-gates.ts", "run-focus-spike.ts", "run-relay-spike.ts"]) {
    const source = readFileSync(join(import.meta.dir, "..", "scripts", file), "utf-8");
    expect(source).not.toContain("LOCAL_CLI");
    expect(source).not.toContain('argValue("--pi"');
  }
});

function processResult(overrides: Partial<SpikeProcessResult> = {}): SpikeProcessResult {
  return {
    status: 0,
    signal: null,
    stdout: "",
    stderr: "",
    ...overrides,
  };
}

test("a non-zero spike cannot supply supported evidence", () => {
  const execution = spikeExecutionFromResult(processResult({
    status: 1,
    stdout: "FOCUS_TRANSFER_PRIMARY_SUPPORTED",
  }));
  expect(focusResult(execution, "primary")).toBe("not-run");
});

test.each([
  processResult({ signal: "SIGTERM", status: null }),
  processResult({ status: null, error: new Error("timed out") }),
])("a terminated or failed spike is not-run", (result) => {
  expect(relayResult(spikeExecutionFromResult(result))).toBe("not-run");
});

test("a focus label for the wrong mechanism is not-run", () => {
  const execution = spikeExecutionFromResult(processResult({
    stdout: "FOCUS_TRANSFER_FALLBACK_SUPPORTED",
  }));
  expect(focusResult(execution, "primary")).toBe("not-run");
});

test("malformed completed output is not-run", () => {
  const execution = spikeExecutionFromResult(processResult({ stdout: "no labelled evidence" }));
  expect(focusResult(execution, "primary")).toBe("not-run");
  expect(relayResult(execution)).toBe("not-run");
});

test.each([
  "FOCUS_TRANSFER_PRIMARY_SUPPORTED\nFOCUS_TRANSFER_PRIMARY_UNSUPPORTED: failed assertion",
  "FOCUS_TRANSFER_PRIMARY_SUPPORTED\nFOCUS_TRANSFER_PRIMARY_SUPPORTED",
  "diagnostic: FOCUS_TRANSFER_PRIMARY_SUPPORTED was observed before the spike failed",
])("focus classification rejects contradictory, duplicate, or embedded evidence", (stdout) => {
  const execution = spikeExecutionFromResult(processResult({ stdout }));
  expect(focusResult(execution, "primary")).toBe("not-run");
});

test.each([
  "RPC_RELAY_SUPPORTED revision=1\nRPC_RELAY_UNSUPPORTED: failed assertion",
  "RPC_RELAY_SUPPORTED revision=1\nRPC_RELAY_SUPPORTED revision=2",
  "diagnostic: RPC_RELAY_SUPPORTED was observed before the spike failed",
])("relay classification rejects contradictory, duplicate, or embedded evidence", (stdout) => {
  const execution = spikeExecutionFromResult(processResult({ stdout }));
  expect(relayResult(execution)).toBe("not-run");
});

test("captured diagnostics are valid UTF-8 and bounded", () => {
  const execution = spikeExecutionFromResult(processResult({ stdout: "£".repeat(30_000) }));
  expect(Buffer.byteLength(execution.output, "utf-8")).toBeLessThanOrEqual(50_000);
  expect(execution.output).toEndWith("\n[output truncated]");
  expect(execution.output).not.toContain("�");
});

test("a truncated focus execution is not-run despite its surviving supported line", () => {
  const execution = spikeExecutionFromResult(processResult({
    stdout: `FOCUS_TRANSFER_PRIMARY_SUPPORTED\n${"£".repeat(30_000)}`,
  }));
  expect(execution.truncated).toBeTrue();
  expect(focusResult(execution, "primary")).toBe("not-run");
});

test("a truncated relay execution is not-run despite its surviving supported line", () => {
  const execution = spikeExecutionFromResult(processResult({
    stdout: `RPC_RELAY_SUPPORTED revision=1\n${"£".repeat(30_000)}`,
  }));
  expect(execution.truncated).toBeTrue();
  expect(relayResult(execution)).toBe("not-run");
});

test.each([
  "FOCUS_TRANSFER_PRIMARY_SUPPORTED: reason",
  "FOCUS_TRANSFER_PRIMARY_UNSUPPORTED",
  " FOCUS_TRANSFER_PRIMARY_SUPPORTED",
  "FOCUS_TRANSFER_PRIMARY_SUPPORTED ",
  "FOCUS_TRANSFER_PRIMARY_UNSUPPORTED: reason ",
])("focus classification rejects evidence outside its exact grammar: %s", (stdout) => {
  expect(focusResult(spikeExecutionFromResult(processResult({ stdout })), "primary")).toBe("not-run");
});

test("focus classification rejects a malformed evidence candidate beside a valid supported line", () => {
  const execution = spikeExecutionFromResult(processResult({
    stdout: "FOCUS_TRANSFER_PRIMARY_SUPPORTED\nFOCUS_TRANSFER_PRIMARY_SUPPORTED: reason",
  }));
  expect(focusResult(execution, "primary")).toBe("not-run");
});

test.each([
  "RPC_RELAY_SUPPORTED: reason",
  "RPC_RELAY_UNSUPPORTED",
  "RPC_RELAY_SUPPORTED revision=1.0",
  "RPC_RELAY_SUPPORTED revision=-1",
  " RPC_RELAY_SUPPORTED",
  "RPC_RELAY_SUPPORTED revision=1 ",
  "RPC_RELAY_UNSUPPORTED: reason ",
])("relay classification rejects evidence outside its exact grammar: %s", (stdout) => {
  expect(relayResult(spikeExecutionFromResult(processResult({ stdout })))).toBe("not-run");
});

test("relay classification rejects a malformed evidence candidate beside a valid supported line", () => {
  const execution = spikeExecutionFromResult(processResult({
    stdout: "RPC_RELAY_SUPPORTED revision=1\nRPC_RELAY_UNSUPPORTED",
  }));
  expect(relayResult(execution)).toBe("not-run");
});

function probe(result: PiVersionProbeResult) {
  return { run: () => result };
}

describe("global Pi target discovery", () => {
  test("brands a non-empty version reported by global Pi", () => {
    const target = detectGlobalPi(probe({ status: 0, stdout: "pi test-current\n", stderr: "" }));
    expect(target).toEqual({
      executable: "pi" as typeof target.executable,
      detectedVersion: "pi test-current" as typeof target.detectedVersion,
    });
  });

  test.each([
    [{ status: 1, stdout: "", stderr: "failed" }, "exited with status 1: failed"],
    [{ status: 0, stdout: "  ", stderr: "" }, "returned an empty version"],
    [{ status: null, stdout: "", stderr: "", signal: "SIGTERM" }, "timed out or was terminated by SIGTERM"],
    [{ status: null, stdout: "", stderr: "", error: new Error("spawn pi ENOENT") }, "spawn pi ENOENT"],
  ] satisfies readonly (readonly [PiVersionProbeResult, string])[])(
    "rejects an unusable probe result",
    (result, message) => expect(() => detectGlobalPi(probe(result))).toThrow(message),
  );
});

function report(overrides: Partial<B0Report["gates"]> = {}): B0Report {
  const detectedVersion = "pi test-current" as B0Report["detectedVersion"];
  const gates = {
    focusPrimary: "supported",
    focusFallback: "supported",
    rpcRelay: "supported",
    ...overrides,
  } as const;
  return {
    executable: "pi" as B0Report["executable"],
    detectedVersion,
    gates,
    raw: {
      focusPrimary: { detectedVersion, line: `FOCUS_TRANSFER_PRIMARY_${gates.focusPrimary.toUpperCase()}` },
      focusFallback: { detectedVersion, line: `FOCUS_TRANSFER_FALLBACK_${gates.focusFallback.toUpperCase()}` },
      rpcRelay: { detectedVersion, line: `RPC_RELAY_${gates.rpcRelay.toUpperCase()}` },
    },
  };
}

describe("B0 latest-runtime report", () => {
  test("passes when every gate is supported", () => {
    expect(evaluateB0Report(report())).toEqual({ decision: "go" });
  });

  test.each([
    ["focusPrimary", "unsupported", "primary bare-arrow focus transfer unsupported"],
    ["focusFallback", "unsupported", "fallback shortcut focus transfer unsupported"],
    ["rpcRelay", "unsupported", "RPC relay unsupported"],
    ["rpcRelay", "not-run", "RPC relay not-run"],
  ] as const)("fails closed for %s=%s", (gate, result, message) => {
    const decision = evaluateB0Report(report({ [gate]: result }));
    expect(decision.decision).toBe("stop");
    if (decision.decision === "stop") expect(decision.blockers.join("\n")).toContain(message);
  });

  test("rejects raw evidence from a different detected runtime", () => {
    const value = report();
    const mismatched = {
      ...value,
      raw: {
        ...value.raw,
        rpcRelay: { ...value.raw.rpcRelay, detectedVersion: "pi other-runtime" as B0Report["detectedVersion"] },
      },
    };
    expect(evaluateB0Report(mismatched)).toEqual({
      decision: "stop",
      blockers: ["RPC relay evidence runtime does not match pi test-current"],
    });
  });
});
