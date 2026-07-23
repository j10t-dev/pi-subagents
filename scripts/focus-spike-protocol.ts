/** Deterministic helpers for the Gate A editor/board focus-transfer spike. */

export type FocusKey = "up" | "down" | "enter" | "escape";

const KEY_BYTES: Readonly<Record<FocusKey, string>> = {
  up: "\x1b[A",
  down: "\x1b[B",
  enter: "\r",
  escape: "\x1b",
};

export function encodeKey(name: FocusKey): string {
  return KEY_BYTES[name];
}

/** Throws unless `expected` appears as an in-order subsequence of `events`. */
export function assertOrdered(events: readonly string[], expected: readonly string[]): void {
  let cursor = 0;
  for (const event of events) {
    if (event === expected[cursor]) cursor += 1;
    if (cursor === expected.length) return;
  }
  throw new Error(
    `focus event ordering mismatch: wanted subsequence ${JSON.stringify(expected)} in ${JSON.stringify(events)}`,
  );
}

export type FocusMechanism = "primary" | "fallback";
export interface FocusOutcome {
  readonly mechanism: FocusMechanism;
  readonly supported: boolean;
}

const OUTCOME_PATTERN = /FOCUS_TRANSFER_(PRIMARY|FALLBACK)_(SUPPORTED|UNSUPPORTED)/;

export function parseOutcome(stdout: string): FocusOutcome {
  const match = OUTCOME_PATTERN.exec(stdout);
  if (match === null) throw new Error(`no focus outcome label found in output: ${stdout.slice(0, 200)}`);
  return {
    mechanism: match[1] === "PRIMARY" ? "primary" : "fallback",
    supported: match[2] === "SUPPORTED",
  };
}
