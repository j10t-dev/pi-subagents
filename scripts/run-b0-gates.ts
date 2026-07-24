#!/usr/bin/env bun
/** Runs B0 spikes against the detected global Pi runtime and writes b0-feasibility-report.json. */
import { spawnSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  focusResult,
  relayResult,
  spikeExecutionFromResult,
  type SpikeExecution,
} from "./b0-orchestration.ts";
import { evaluateB0Report, type B0Report, type RawOutcome } from "./b0-report.ts";
import { detectGlobalPi } from "./pi-runtime-target.ts";

const HERE = dirname(fileURLToPath(import.meta.url));

function runSpike(script: string, args: readonly string[]): SpikeExecution {
  return spikeExecutionFromResult(spawnSync("bun", [join(HERE, script), ...args], {
    encoding: "utf-8",
    timeout: 90_000,
  }));
}

const target = detectGlobalPi();

function rawOutcome(execution: SpikeExecution): RawOutcome {
  return { detectedVersion: target.detectedVersion, line: execution.output };
}

const primary = runSpike("run-focus-spike.ts", ["--mode", "primary"]);
const fallback = runSpike("run-focus-spike.ts", ["--mode", "fallback"]);
const relay = runSpike("run-relay-spike.ts", []);

const report: B0Report = {
  ...target,
  gates: {
    focusPrimary: focusResult(primary, "primary"),
    focusFallback: focusResult(fallback, "fallback"),
    rpcRelay: relayResult(relay),
  },
  raw: {
    focusPrimary: rawOutcome(primary),
    focusFallback: rawOutcome(fallback),
    rpcRelay: rawOutcome(relay),
  },
};

const decision = evaluateB0Report(report);
writeFileSync(join(HERE, "..", "b0-feasibility-report.json"), `${JSON.stringify(report, null, 2)}\n`);
process.stderr.write(`${JSON.stringify({ report, decision }, null, 2)}\n`);
if (decision.decision === "stop") process.exitCode = 1;
