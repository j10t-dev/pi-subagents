import { truncateUtf8, utf8Bytes } from "../src/domain.ts";
import type { GateResult } from "./b0-report.ts";
import type { FocusMechanism } from "./focus-spike-protocol.ts";

export interface SpikeProcessResult {
  readonly status: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly stdout: string;
  readonly stderr: string;
  readonly error?: Error | undefined;
}

export interface SpikeExecution {
  readonly status: "completed" | "not-run";
  readonly output: string;
  readonly truncated: boolean;
}

const MAX_SPIKE_OUTPUT_BYTES = 50_000;
const TRUNCATION_MARKER = "\n[output truncated]";
const REASON = "\\S(?:.*\\S)?";
const FOCUS_OUTCOME_LINE = new RegExp(
  `^FOCUS_TRANSFER_(PRIMARY|FALLBACK)_(?:(SUPPORTED)|(UNSUPPORTED): (${REASON}))$`,
);
const RELAY_OUTCOME_LINE = new RegExp(
  `^RPC_RELAY_(?:(SUPPORTED)(?: revision=\\d+)?|(UNSUPPORTED): (${REASON}))$`,
);

function labelledOutcome(output: string, prefix: string, pattern: RegExp): RegExpExecArray | undefined {
  const candidates = output.split(/\r?\n/).filter((line) => line.startsWith(prefix));
  if (candidates.length !== 1) return undefined;
  return pattern.exec(candidates[0]!) ?? undefined;
}

export function spikeExecutionFromResult(result: SpikeProcessResult): SpikeExecution {
  const combined = `${result.stdout ?? ""}${result.stderr ?? ""}`;
  const diagnostic = result.error === undefined
    ? combined
    : `${combined}${combined === "" ? "" : "\n"}SPIKE_ERROR: ${result.error.message}`;
  const budget = MAX_SPIKE_OUTPUT_BYTES - Buffer.byteLength(TRUNCATION_MARKER, "utf-8");
  const bounded = truncateUtf8(diagnostic, utf8Bytes(budget));
  const output = bounded.truncated ? `${bounded.text}${TRUNCATION_MARKER}` : bounded.text;
  const completed = result.error === undefined && result.signal === null && result.status === 0;
  return { status: completed ? "completed" : "not-run", output, truncated: bounded.truncated };
}

export function focusResult(
  execution: SpikeExecution,
  expectedMechanism: FocusMechanism,
): GateResult {
  if (execution.status !== "completed" || execution.truncated) return "not-run";
  const outcome = labelledOutcome(execution.output, "FOCUS_TRANSFER_", FOCUS_OUTCOME_LINE);
  if (outcome === undefined) return "not-run";
  const [mechanism, supported] = outcome.slice(1);
  if ((mechanism === "PRIMARY" ? "primary" : "fallback") !== expectedMechanism) return "not-run";
  return supported === "SUPPORTED" ? "supported" : "unsupported";
}

export function relayResult(execution: SpikeExecution): GateResult {
  if (execution.status !== "completed" || execution.truncated) return "not-run";
  const outcome = labelledOutcome(execution.output, "RPC_RELAY_", RELAY_OUTCOME_LINE);
  if (outcome === undefined) return "not-run";
  return outcome[1] === "SUPPORTED" ? "supported" : "unsupported";
}
