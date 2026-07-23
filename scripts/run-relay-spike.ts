#!/usr/bin/env bun
/** Real-Pi Gate B relay-startup + snapshot-discovery spike in --mode rpc. */
import { spawn } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createInterface } from "node:readline";

import { agentId } from "../src/domain.ts";
import { readKnownChildSnapshots, type ObservationSnapshotV1 } from "../src/observation-snapshot-path.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURE_DIR = join(HERE, "..", "test", "fixtures", "relay-spike-extension");
const LOCAL_CLI = join(HERE, "..", "node_modules", "@earendil-works", "pi-coding-agent", "dist", "cli.js");

function argValue(flag: string, fallback: string): string {
  const index = process.argv.indexOf(flag);
  return index === -1 ? fallback : (process.argv[index + 1] ?? fallback);
}

async function main(): Promise<void> {
  const version = argValue("--pi", "global");
  const workDir = mkdtempSync(join(tmpdir(), "pi-relay-spike-"));
  const agentDir = join(workDir, "agent");
  const sessionDir = join(workDir, "session");
  const extDir = join(agentDir, "extensions", "relay-spike");
  mkdirSync(extDir, { recursive: true });
  mkdirSync(sessionDir, { recursive: true });
  // The fixture is self-contained (no src import), so copy only the fixture into the autoload dir.
  cpSync(FIXTURE_DIR, extDir, { recursive: true });

  const piBase = version === "0.80.6" ? ["node", LOCAL_CLI] : ["pi"];
  const args = [
    ...piBase.slice(1), "--mode", "rpc", "--session-dir", sessionDir,
    "--offline", "--no-context-files", "--no-skills", "--no-prompt-templates", "--approve",
  ];
  const child = spawn(piBase[0]!, args, {
    cwd: workDir,
    env: {
      ...process.env,
      PI_CODING_AGENT_DIR: agentDir,
      PI_SUBAGENT_CHILD: "1",
      PI_SUBAGENT_DEPTH: "1",
      PI_SUBAGENT_MAX_DEPTH: "2",
      PI_SUBAGENT_MAX_CONCURRENT_RUNS: "1",
    },
    stdio: ["pipe", "pipe", "pipe"],
  });

  // sessionId comes from the get_state response `data.sessionId` (rpc.md #get_state). The
  // prompt response carries no session id.
  let sessionId: string | undefined;
  const rl = createInterface({ input: child.stdout });
  rl.on("line", (line) => {
    try {
      const message = JSON.parse(line) as { command?: string; data?: { sessionId?: string } };
      if (message.command === "get_state" && typeof message.data?.sessionId === "string") {
        sessionId = message.data.sessionId;
      }
    } catch { /* non-JSON banner line */ }
  });
  let stderr = "";
  child.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString("utf-8"); });

  // Everything after spawn runs under a single finally so no exit path — success, UNSUPPORTED,
  // or a thrown error — leaks the RPC child or the temp dir.
  try {
    await Bun.sleep(1000);
    child.stdin.write(`${JSON.stringify({ type: "get_state" })}\n`);
    await waitUntil(() => sessionId !== undefined, 10_000);
    if (sessionId === undefined) { console.log(`RPC_RELAY_UNSUPPORTED: no sessionId from get_state; stderr=${stderr.slice(0, 300)}`); return; }

    // revision 1 is written from session_start and needs no model turn: it alone proves autoload
    // + RPC non-tool init. Prompt to attempt the revision-2 (turn_end) bump; offline may refuse a
    // turn, which is acceptable — we assert revision >= 1 and record whether >= 2 was reached.
    child.stdin.write(`${JSON.stringify({ type: "prompt", message: "reply with the single word ok" })}\n`);

    const childId = agentId(sessionId);
    let best: ObservationSnapshotV1 | undefined;
    let lastSkip: string | undefined;
    const deadline = Date.now() + 30_000;
    while (Date.now() < deadline) {
      const result = readKnownChildSnapshots(agentDir, [childId]);
      const snap = result.snapshots.get(childId);
      if (snap !== undefined) { best = snap; if (snap.revision >= 2) break; }
      else lastSkip = result.skipped.get(childId);
      await Bun.sleep(100);
    }
    if (best === undefined) { console.log(`RPC_RELAY_UNSUPPORTED: relay did not publish a discoverable snapshot for ${sessionId} (last skip reason: ${lastSkip ?? "none"})`); return; }
    // Negative control: an unknown session id must NOT be discovered.
    if (readKnownChildSnapshots(agentDir, [agentId("definitely-not-a-child")]).snapshots.size !== 0) {
      console.log(`RPC_RELAY_UNSUPPORTED: discovery returned an unknown-id snapshot`); return;
    }
    process.stderr.write(`relay snapshot: ${JSON.stringify(best)}\n`);
    console.log(`RPC_RELAY_SUPPORTED revision=${best.revision}`);
  } finally {
    try { child.stdin.write(`${JSON.stringify({ type: "shutdown" })}\n`); } catch { /* stdin may be closed */ }
    child.kill("SIGTERM");
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => { child.kill("SIGKILL"); resolve(); }, 2_000);
      child.once("exit", () => { clearTimeout(timer); resolve(); });
    });
    rl.close();
    rmSync(workDir, { recursive: true, force: true });
  }
}

async function waitUntil(predicate: () => boolean, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) { if (predicate()) return; await Bun.sleep(50); }
}

await main();
