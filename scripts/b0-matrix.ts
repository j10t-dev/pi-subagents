/** B0 feasibility matrix schema and go/no-go evaluation. */

export type GateResult = "supported" | "unsupported" | "not-run";
export type PiVersion = "0.80.6" | "0.80.10";
export type PerVersion = Readonly<Record<PiVersion, GateResult>>;

/** Verbatim spike output, retained so the matrix is auditable evidence, not a summary. */
export interface RawOutcome {
  readonly version: PiVersion;
  /** `pi --version` as actually reported by the binary that ran (not the requested label). */
  readonly verifiedVersion: string;
  /**
   * The spike's captured output verbatim, starting with its labelled outcome line (e.g.
   * `RPC_RELAY_SUPPORTED revision=1`). May span several lines when the spike also emitted
   * supporting evidence, such as the relay snapshot it round-tripped.
   */
  readonly line: string;
}

export interface B0Matrix {
  readonly versions: readonly PiVersion[];
  readonly gates: {
    readonly focusPrimary: PerVersion;
    readonly focusFallback: PerVersion;
    readonly rpcRelay: PerVersion;
  };
  /** Every raw labelled spike line, keyed by gate — the evidence behind the reduced gate results. */
  readonly raw?: {
    readonly focusPrimary?: readonly RawOutcome[];
    readonly focusFallback?: readonly RawOutcome[];
    readonly rpcRelay?: readonly RawOutcome[];
  };
  /** Informational only (feeds the report); does NOT affect the go/stop decision — a fallback-only
   *  result is always a stop escalating a design decision, never a note-driven go. */
  readonly notes?: { readonly focusMechanism?: "primary" | "fallback" };
  readonly minimumVersionRaised?: { readonly to: PiVersion; readonly reason: string };
}

export type B0Decision =
  | { readonly decision: "go" }
  | { readonly decision: "stop"; readonly blockers: readonly string[] };

const VERSIONS: readonly PiVersion[] = ["0.80.6", "0.80.10"];

export function evaluateB0Matrix(matrix: B0Matrix): B0Decision {
  const blockers: string[] = [];
  const raisedFloor = matrix.minimumVersionRaised?.to;
  const active: readonly PiVersion[] =
    raisedFloor === "0.80.10" ? ["0.80.10"] : VERSIONS;

  // The design's load-bearing interaction IS the primary bare-arrow, composable-custom-editor
  // transfer (design §"Focus rules"). If it is unsupported on any active version, the design
  // mandates that B3 STOP for an explicit design decision — the shortcut fallback is a candidate
  // for that decision, not an automatic go. So the fallback result is recorded as evidence but
  // never converts a primary failure into a go here.
  // Blocker wording carries the gate's actual status verbatim, so a "not-run" gate is never
  // reported as "unsupported" — an unmeasured gate and a measured failure are different facts.
  for (const version of active) {
    const status = matrix.gates.focusPrimary[version];
    if (status !== "supported") {
      blockers.push(
        `primary bare-arrow focus transfer ${status} on ${version}: B3 must stop for an explicit ` +
        `design decision (design §Focus rules); the shortcut fallback (focusFallback=${matrix.gates.focusFallback[version]}) ` +
        `is a candidate for that decision, not an automatic go`,
      );
    }
  }

  // The fallback is the escape hatch the design leans on when the primary transfer is in doubt, so
  // an unresolved UNSUPPORTED there is a hard blocker in its own right and must never pass silently.
  for (const version of active) {
    const status = matrix.gates.focusFallback[version];
    if (status !== "supported") {
      blockers.push(`fallback shortcut focus transfer ${status} on ${version}`);
    }
  }

  for (const version of active) {
    const status = matrix.gates.rpcRelay[version];
    if (status !== "supported") {
      blockers.push(`rpcRelay ${status} on ${version}`);
    }
  }

  return blockers.length === 0 ? { decision: "go" } : { decision: "stop", blockers };
}
