import type { DetectedPiVersion, PiExecutable } from "./pi-runtime-target.ts";

export type GateResult = "supported" | "unsupported" | "not-run";

export interface RawOutcome {
  readonly detectedVersion: DetectedPiVersion | null;
  readonly output: string;
}

export interface B0Report {
  readonly executable: PiExecutable;
  readonly detectedVersion: DetectedPiVersion;
  readonly gates: {
    readonly focusPrimary: GateResult;
    readonly focusFallback: GateResult;
    readonly rpcRelay: GateResult;
  };
  readonly raw: {
    readonly focusPrimary: RawOutcome;
    readonly focusFallback: RawOutcome;
    readonly rpcRelay: RawOutcome;
  };
}

export type B0Decision =
  | { readonly decision: "go" }
  | { readonly decision: "stop"; readonly blockers: readonly string[] };

export function evaluateB0Report(report: B0Report): B0Decision {
  const blockers: string[] = [];
  checkEvidenceRuntime("primary focus", report.raw.focusPrimary, report, blockers);
  checkEvidenceRuntime("fallback focus", report.raw.focusFallback, report, blockers);
  checkEvidenceRuntime("RPC relay", report.raw.rpcRelay, report, blockers);
  if (blockers.length > 0) return { decision: "stop", blockers };

  if (report.gates.focusPrimary !== "supported") {
    blockers.push(
      `primary bare-arrow focus transfer ${report.gates.focusPrimary} on ${report.detectedVersion}: ` +
      "B3 must stop for an explicit design decision; the shortcut fallback is a candidate, not an automatic go",
    );
  }
  if (report.gates.focusFallback !== "supported") {
    blockers.push(`fallback shortcut focus transfer ${report.gates.focusFallback} on ${report.detectedVersion}`);
  }
  if (report.gates.rpcRelay !== "supported") {
    blockers.push(`RPC relay ${report.gates.rpcRelay} on ${report.detectedVersion}`);
  }
  return blockers.length === 0 ? { decision: "go" } : { decision: "stop", blockers };
}

function checkEvidenceRuntime(
  label: string,
  outcome: RawOutcome,
  report: B0Report,
  blockers: string[],
): void {
  if (outcome.detectedVersion !== report.detectedVersion) {
    blockers.push(`${label} evidence runtime does not match ${report.detectedVersion}`);
  }
}
