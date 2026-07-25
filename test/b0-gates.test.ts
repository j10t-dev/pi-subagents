import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, test } from "bun:test";

import {
  focusResult,
  relayResult,
  runtimeEvidenceLine,
  spikeExecutionFromResult,
  type SpikeProcessResult,
} from "../scripts/b0-orchestration.ts";
import { evaluateB0Report, type B0Report } from "../scripts/b0-report.ts";
import {
  detectGlobalPi,
  detectedPiVersion,
  piExecutable,
  type PiVersionProbeResult,
} from "../scripts/pi-runtime-target.ts";

test("active B0 spikes await the selected Pi executable without a local fallback", () => {
  const gateSource = readFileSync(join(import.meta.dir, "..", "scripts", "run-b0-gates.ts"), "utf-8");
  expect(gateSource).not.toContain("LOCAL_CLI");
  expect(gateSource).toContain('"--pi", target.executable');
  for (const file of ["run-focus-spike.ts", "run-relay-spike.ts"]) {
    const source = readFileSync(join(import.meta.dir, "..", "scripts", file), "utf-8");
    expect(source).not.toContain("LOCAL_CLI");
    expect(source).toContain('argValue("--pi"');
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

test("relay unsupported diagnostics throw rather than let the spike exit successfully", () => {
  const source = readFileSync(join(import.meta.dir, "..", "scripts", "run-relay-spike.ts"), "utf-8");
  expect(source).toContain('function relayUnsupported(reason: string): never');
  expect(source.match(/relayUnsupported\(/g)).toHaveLength(4);
  expect(source).not.toContain("RPC_RELAY_UNSUPPORTED: no sessionId from get_state; stderr=${stderr.slice(0, 300)}`); return");
  expect(source).not.toContain("RPC_RELAY_UNSUPPORTED: relay did not publish a discoverable snapshot for ${sessionId} (last skip reason: ${lastSkip ?? \"none\"})`); return");
  expect(source).not.toContain("RPC_RELAY_UNSUPPORTED: discovery returned an unknown-id snapshot`); return");
});

test("a non-zero spike cannot supply supported evidence", () => {
  const execution = spikeExecutionFromResult(processResult({
    status: 1,
    stdout: "FOCUS_TRANSFER_PRIMARY_SUPPORTED",
  }));
  expect(focusResult(execution, "primary")).toBe("not-run");
});

test("spike execution carries the runtime version reported by the spike", () => {
  const version = detectedPiVersion("pi test-current");
  const execution = spikeExecutionFromResult(processResult({
    stdout: `${runtimeEvidenceLine(version)}\nRPC_RELAY_SUPPORTED revision=1\n`,
  }));
  expect(execution.detectedVersion).toBe(version);
});

test.each([
  "RPC_RELAY_SUPPORTED revision=1\n",
  'PI_RUNTIME_VERSION "pi one"\nPI_RUNTIME_VERSION "pi two"\nRPC_RELAY_SUPPORTED revision=1\n',
  "PI_RUNTIME_VERSION not-json\nRPC_RELAY_SUPPORTED revision=1\n",
])("missing, duplicate, or malformed runtime evidence remains unproven", (stdout) => {
  expect(spikeExecutionFromResult(processResult({ stdout })).detectedVersion).toBeUndefined();
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
      focusPrimary: { detectedVersion, output: `FOCUS_TRANSFER_PRIMARY_${gates.focusPrimary.toUpperCase()}` },
      focusFallback: { detectedVersion, output: `FOCUS_TRANSFER_FALLBACK_${gates.focusFallback.toUpperCase()}` },
      rpcRelay: { detectedVersion, output: `RPC_RELAY_${gates.rpcRelay.toUpperCase()}` },
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
        rpcRelay: { ...value.raw.rpcRelay, detectedVersion: detectedPiVersion("pi other-runtime") },
      },
    };
    expect(evaluateB0Report(mismatched)).toEqual({
      decision: "stop",
      blockers: ["RPC relay evidence runtime does not match pi test-current"],
    });
  });

  test("rejects a gate whose spike did not report its runtime", () => {
    const value = report();
    expect(evaluateB0Report({
      ...value,
      raw: { ...value.raw, rpcRelay: { ...value.raw.rpcRelay, detectedVersion: null } },
    })).toEqual({
      decision: "stop",
      blockers: ["RPC relay evidence runtime does not match pi test-current"],
    });
  });
});

test("Pi executable identities reject empty or NUL-containing values", () => {
  expect(piExecutable("pi") as string).toBe("pi");
  expect(() => piExecutable("")).toThrow(/Pi executable/);
  expect(() => piExecutable("pi\0other")).toThrow(/Pi executable/);
});
