import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";

import { evaluateB0Matrix, type B0Matrix } from "../scripts/b0-matrix.ts";

const MATRIX_PATH = join(import.meta.dir, "..", "b0-feasibility-matrix.json");

describe("B0 feasibility gate", () => {
  test("evaluateB0Matrix passes when every gate is supported on both versions", () => {
    const matrix: B0Matrix = {
      versions: ["0.80.6", "0.80.10"],
      gates: {
        focusPrimary: { "0.80.6": "supported", "0.80.10": "supported" },
        focusFallback: { "0.80.6": "supported", "0.80.10": "supported" },
        rpcRelay: { "0.80.6": "supported", "0.80.10": "supported" },
      },
    };
    expect(evaluateB0Matrix(matrix)).toEqual({ decision: "go" });
  });

  test("primary bare-arrow failure is a stop even when the shortcut fallback works", () => {
    // The design mandates B3 stop for a design decision when the documented interaction fails; a
    // working shortcut fallback is a candidate for that decision, not an automatic go.
    const matrix: B0Matrix = {
      versions: ["0.80.6", "0.80.10"],
      gates: {
        focusPrimary: { "0.80.6": "unsupported", "0.80.10": "unsupported" },
        focusFallback: { "0.80.6": "supported", "0.80.10": "supported" },
        rpcRelay: { "0.80.6": "supported", "0.80.10": "supported" },
      },
    };
    const decision = evaluateB0Matrix(matrix);
    expect(decision.decision).toBe("stop");
    if (decision.decision !== "stop") throw new Error("unreachable");
    expect(decision.blockers.length).toBe(2); // one per active version
    expect(decision.blockers[0]).toContain("primary bare-arrow focus transfer unsupported on 0.80.6");
    expect(decision.blockers[0]).toContain("stop for an explicit");
  });

  test("an unresolved unsupported gate is a stop", () => {
    const matrix: B0Matrix = {
      versions: ["0.80.6", "0.80.10"],
      gates: {
        focusPrimary: { "0.80.6": "supported", "0.80.10": "supported" },
        focusFallback: { "0.80.6": "supported", "0.80.10": "supported" },
        rpcRelay: { "0.80.6": "supported", "0.80.10": "unsupported" },
      },
    };
    expect(evaluateB0Matrix(matrix)).toEqual({
      decision: "stop",
      blockers: ["rpcRelay unsupported on 0.80.10"],
    });
  });

  test("an unsupported shortcut fallback is a hard blocker even when the primary works", () => {
    // The fallback is the escape hatch the design leans on; an unresolved UNSUPPORTED there must
    // not pass silently just because the primary transfer happens to work.
    const matrix: B0Matrix = {
      versions: ["0.80.6", "0.80.10"],
      gates: {
        focusPrimary: { "0.80.6": "supported", "0.80.10": "supported" },
        focusFallback: { "0.80.6": "unsupported", "0.80.10": "unsupported" },
        rpcRelay: { "0.80.6": "supported", "0.80.10": "supported" },
      },
    };
    const decision = evaluateB0Matrix(matrix);
    expect(decision.decision).toBe("stop");
    if (decision.decision !== "stop") throw new Error("unreachable");
    expect(decision.blockers.length).toBe(2); // one per active version
    expect(decision.blockers[0]).toContain("fallback shortcut focus transfer unsupported on 0.80.6");
    expect(decision.blockers[1]).toContain("fallback shortcut focus transfer unsupported on 0.80.10");
  });

  test("a not-run gate is a stop and is never reported as unsupported", () => {
    // An unmeasured gate and a measured failure are different facts. The blocker text is the
    // auditable output of the gate, so it must carry the status actually recorded.
    const matrix: B0Matrix = {
      versions: ["0.80.6", "0.80.10"],
      gates: {
        focusPrimary: { "0.80.6": "not-run", "0.80.10": "supported" },
        focusFallback: { "0.80.6": "supported", "0.80.10": "not-run" },
        rpcRelay: { "0.80.6": "supported", "0.80.10": "supported" },
      },
    };
    const decision = evaluateB0Matrix(matrix);
    expect(decision.decision).toBe("stop");
    if (decision.decision !== "stop") throw new Error("unreachable");
    expect(decision.blockers.length).toBe(2);
    expect(decision.blockers[0]).toContain("primary bare-arrow focus transfer not-run on 0.80.6");
    expect(decision.blockers[1]).toBe("fallback shortcut focus transfer not-run on 0.80.10");
    for (const blocker of decision.blockers) expect(blocker).not.toContain("unsupported");
  });

  test("an unsupported floor is a go only when the minimum version is explicitly raised", () => {
    const matrix: B0Matrix = {
      versions: ["0.80.6", "0.80.10"],
      gates: {
        focusPrimary: { "0.80.6": "supported", "0.80.10": "supported" },
        focusFallback: { "0.80.6": "supported", "0.80.10": "supported" },
        rpcRelay: { "0.80.6": "unsupported", "0.80.10": "supported" },
      },
      minimumVersionRaised: { to: "0.80.10", reason: "rpc relay autoload requires 0.80.10" },
    };
    expect(evaluateB0Matrix(matrix)).toEqual({ decision: "go" });
  });

  test("the committed matrix on this branch is a go backed by verified real-run evidence", () => {
    const matrix = JSON.parse(readFileSync(MATRIX_PATH, "utf-8")) as B0Matrix;

    // The decision must be go...
    expect(evaluateB0Matrix(matrix).decision).toBe("go");

    // ...AND it must be backed by real evidence, not a hand-written status string. Both exact
    // versions must be present, and every gate must carry raw outcomes whose verified binary
    // version and labelled line corroborate the reduced gate result.
    expect([...matrix.versions].sort()).toEqual(["0.80.10", "0.80.6"]);
    const raw = matrix.raw;
    if (raw === undefined) throw new Error("committed matrix has no raw evidence");

    const gates = [
      { name: "focusPrimary", outcomes: raw.focusPrimary, reduced: matrix.gates.focusPrimary, token: "FOCUS_TRANSFER_PRIMARY" },
      { name: "focusFallback", outcomes: raw.focusFallback, reduced: matrix.gates.focusFallback, token: "FOCUS_TRANSFER_FALLBACK" },
      { name: "rpcRelay", outcomes: raw.rpcRelay, reduced: matrix.gates.rpcRelay, token: "RPC_RELAY" },
    ] as const;

    for (const gate of gates) {
      if (gate.outcomes === undefined) throw new Error(`gate ${gate.name} has no raw outcomes`);
      for (const version of matrix.versions) {
        const outcome = gate.outcomes.find((o) => o.version === version);
        if (outcome === undefined) throw new Error(`gate ${gate.name} missing raw outcome for ${version}`);
        // The binary that actually ran must be the version claimed.
        expect(outcome.verifiedVersion).toContain(version);
        // The labelled line must corroborate the reduced status (no silent upgrade to "supported").
        const reduced = gate.reduced[version];
        if (reduced === "supported") expect(outcome.line).toContain(`${gate.token}_SUPPORTED`);
        if (reduced === "unsupported") expect(outcome.line).toContain(`${gate.token}_UNSUPPORTED`);
      }
    }
  });
});
