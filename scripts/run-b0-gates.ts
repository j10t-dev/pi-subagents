#!/usr/bin/env bun
/** Runs both B0 spikes against both Pi versions and writes b0-feasibility-matrix.json. */
import { spawnSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import type { B0Matrix, GateResult, PiVersion, RawOutcome } from "./b0-matrix.ts";
import { parseOutcome } from "./focus-spike-protocol.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const VERSIONS: readonly PiVersion[] = ["0.80.6", "0.80.10"];
const LOCAL_CLI = join(HERE, "..", "node_modules", "@earendil-works", "pi-coding-agent", "dist", "cli.js");

const raw: { focusPrimary: RawOutcome[]; focusFallback: RawOutcome[]; rpcRelay: RawOutcome[] } = {
  focusPrimary: [], focusFallback: [], rpcRelay: [],
};

/**
 * Resolve the version the binary for `version` actually reports. Never trust the requested label:
 * if the global `pi` is not the expected build, the whole matrix is meaningless, so fail loudly.
 */
function verifiedVersionOf(version: PiVersion): string {
  const argv = version === "0.80.6" ? ["node", LOCAL_CLI, "--version"] : ["pi", "--version"];
  const result = spawnSync(argv[0]!, argv.slice(1), { encoding: "utf-8", timeout: 15_000 });
  const reported = `${result.stdout ?? ""}${result.stderr ?? ""}`.trim();
  if (!reported.includes(version)) {
    throw new Error(`version mismatch: requested ${version} but binary reports "${reported}"`);
  }
  return reported;
}

function runSpike(script: string, args: readonly string[]): string {
  // A per-spike timeout means a hung Pi yields a NOT-RUN gate, never a wedged orchestrator. The
  // spikes have their own ~8-30s internal deadlines; this is the outer backstop.
  const result = spawnSync("bun", [join(HERE, script), ...args], { encoding: "utf-8", timeout: 90_000 });
  if (result.error !== undefined) return `SPIKE_ERROR: ${result.error.message}`;
  return `${result.stdout ?? ""}${result.stderr ?? ""}`.trim();
}

function focusResult(version: PiVersion, mode: "primary" | "fallback"): GateResult {
  const output = runSpike("run-focus-spike.ts", ["--pi", version, "--mode", mode]);
  raw[mode === "primary" ? "focusPrimary" : "focusFallback"].push({
    version, verifiedVersion: verifiedVersionOf(version), line: output,
  });
  try { return parseOutcome(output).supported ? "supported" : "unsupported"; }
  catch { return "not-run"; }
}

function relayResult(version: PiVersion): GateResult {
  const output = runSpike("run-relay-spike.ts", ["--pi", version]);
  raw.rpcRelay.push({ version, verifiedVersion: verifiedVersionOf(version), line: output });
  if (output.includes("RPC_RELAY_SUPPORTED")) return "supported";
  if (output.includes("RPC_RELAY_UNSUPPORTED")) return "unsupported";
  return "not-run";
}

function perVersion(fn: (v: PiVersion) => GateResult): Record<PiVersion, GateResult> {
  return { "0.80.6": fn("0.80.6"), "0.80.10": fn("0.80.10") };
}

const matrix: B0Matrix = {
  versions: VERSIONS,
  gates: {
    focusPrimary: perVersion((v) => focusResult(v, "primary")),
    focusFallback: perVersion((v) => focusResult(v, "fallback")),
    rpcRelay: perVersion(relayResult),
  },
  raw,
};

writeFileSync(join(HERE, "..", "b0-feasibility-matrix.json"), `${JSON.stringify(matrix, null, 2)}\n`);
process.stderr.write(`${JSON.stringify(matrix, null, 2)}\n`);
