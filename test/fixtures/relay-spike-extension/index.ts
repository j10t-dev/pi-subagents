/**
 * Real-Pi Gate B relay-startup fixture (subagent-ui-ux B0), globally autoloaded.
 *
 * Proves that a separately-loaded optional extension runs its NON-TOOL initialisation
 * inside an `--mode rpc` descendant and can publish a versioned owner-only snapshot to the
 * managed path. Writes on session_start (revision 1) and re-writes after the first turn
 * settles (revision 2). Headless: no widgets, no custom UI, no tools. Self-contained: no
 * imports from the extension's own src tree.
 */
import { mkdirSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { getAgentDir, type ExtensionFactory } from "@earendil-works/pi-coding-agent";

const MARKER = process.env.PI_SUBAGENT_CHILD; // set by the managed launcher on descendants

// Duplicated from src/observation-snapshot-path.ts by design (see Step 1 rationale).
function snapshotPath(sessionId: string): string {
  return join(getAgentDir(), "pi-subagents", sessionId, "ui", "observation-v1.json");
}

function publish(sessionId: string, revision: number): void {
  if (sessionId.length === 0 || /[/\\]/.test(sessionId)) return;
  const snapshot = {
    version: 1,
    sessionId,
    revision,
    agents: [{ ordinal: "A1", state: "running", taskLabel: "relay spike" }],
  };
  const finalPath = snapshotPath(sessionId);
  mkdirSync(join(getAgentDir(), "pi-subagents", sessionId, "ui"), { recursive: true, mode: 0o700 });
  const tempPath = `${finalPath}.${process.pid}.tmp`;
  writeFileSync(tempPath, JSON.stringify(snapshot), { mode: 0o600 });
  renameSync(tempPath, finalPath); // atomic replace within the managed root
}

const factory: ExtensionFactory = (pi) => {
  // Only descendants publish; a root board would render instead. Guarding on the managed
  // marker mirrors the real relay's "marked descendant runs headlessly" rule.
  if (MARKER !== "1") return;

  pi.on("session_start", (_event, ctx) => {
    const sessionId = ctx.sessionManager.getSessionId();
    if (typeof sessionId === "string") publish(sessionId, 1);
  });
  pi.on("turn_end", (_event, ctx) => {
    const sessionId = ctx.sessionManager.getSessionId();
    if (typeof sessionId === "string") publish(sessionId, 2);
  });
};

export default factory;
