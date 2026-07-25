#!/usr/bin/env bun
/** Real-Pi Gate B relay-startup + snapshot-discovery spike in --mode rpc. */
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createInterface } from "node:readline";

import { agentId, milliseconds, type Milliseconds } from "../src/domain.ts";
import { absolutePath } from "../src/paths.ts";
import { readKnownChildSnapshots, type ObservationSnapshot } from "../src/observation-snapshot-path.ts";
import { runtimeEvidenceLine } from "./b0-orchestration.ts";
import { detectPiRuntime, piExecutable } from "./pi-runtime-target.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const PACKAGE_DIR = join(HERE, "..");

function argValue(flag: string, fallback: string): string {
  const index = process.argv.indexOf(flag);
  return index === -1 ? fallback : (process.argv[index + 1] ?? fallback);
}

function relayUnsupported(reason: string): never {
  const message = `RPC_RELAY_UNSUPPORTED: ${reason}`;
  console.log(message);
  throw new Error(message);
}

async function main(): Promise<void> {
  const target = detectPiRuntime(piExecutable(argValue("--pi", "pi")));
  console.log(runtimeEvidenceLine(target.detectedVersion));
  const workDir = mkdtempSync(join(tmpdir(), "pi-relay-spike-"));
  const agentDir = absolutePath(join(workDir, "agent"));
  const sessionDir = join(workDir, "session");
  const extensionsDir = join(agentDir, "extensions");
  mkdirSync(extensionsDir, { recursive: true });
  mkdirSync(sessionDir, { recursive: true });
  symlinkSync(PACKAGE_DIR, join(extensionsDir, "pi-subagents"));

  const args = [
    "--mode", "rpc", "--session-dir", sessionDir,
    "--offline", "--no-context-files", "--no-skills", "--no-prompt-templates", "--approve",
  ];
  const child = spawn(target.executable, args, {
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
    await sleep(milliseconds(1_000));
    child.stdin.write(`${JSON.stringify({ type: "get_state" })}\n`);
    await waitUntil(() => sessionId !== undefined, milliseconds(10_000));
    if (sessionId === undefined) relayUnsupported(`no sessionId from get_state; stderr=${stderr.slice(0, 300)}`);

    // revision 1 is written from session_start and needs no model turn: it alone proves autoload
    // + RPC non-tool init. Prompt to attempt the revision-2 (turn_end) bump; offline may refuse a
    // turn, which is acceptable — we assert revision >= 1 and record whether >= 2 was reached.
    child.stdin.write(`${JSON.stringify({ type: "prompt", message: "reply with the single word ok" })}\n`);

    const childId = agentId(sessionId);
    let best: ObservationSnapshot | undefined;
    let lastSkip: string | undefined;
    const deadline = Date.now() + milliseconds(30_000);
    while (Date.now() < deadline) {
      const result = readKnownChildSnapshots(agentDir, [childId]);
      const snap = result.snapshots.get(childId);
      if (snap !== undefined) { best = snap; if (snap.revision >= 2) break; }
      else lastSkip = result.skipped.get(childId);
      await sleep(milliseconds(100));
    }
    if (best === undefined) {
      relayUnsupported(`relay did not publish a discoverable snapshot for ${sessionId} (last skip reason: ${lastSkip ?? "none"})`);
    }
    // Negative control: an unknown session id must NOT be discovered.
    if (readKnownChildSnapshots(agentDir, [agentId("definitely-not-a-child")]).snapshots.size !== 0) {
      relayUnsupported("discovery returned an unknown-id snapshot");
    }
    const snapshotWire = {
      sessionId: best.sessionId,
      incarnation: best.incarnation,
      revision: best.revision,
      total: best.total,
      omitted: best.omitted,
      degraded: best.degraded,
      agents: best.agents,
    };
    process.stderr.write(`relay snapshot: ${JSON.stringify(snapshotWire)}\n`);
    console.log(`RPC_RELAY_SUPPORTED revision=${best.revision}`);
  } finally {
    try { child.stdin.write(`${JSON.stringify({ type: "shutdown" })}\n`); } catch { /* stdin may be closed */ }
    child.kill("SIGTERM");
    await new Promise<void>((resolve) => {
      const shutdownTimeout = milliseconds(2_000);
      const timer = setTimeout(() => { child.kill("SIGKILL"); resolve(); }, shutdownTimeout);
      child.once("exit", () => { clearTimeout(timer); resolve(); });
    });
    rl.close();
    rmSync(workDir, { recursive: true, force: true });
  }
}

async function waitUntil(predicate: () => boolean, timeoutMs: Milliseconds): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await sleep(milliseconds(50));
  }
}

function sleep(duration: Milliseconds): Promise<void> {
  return Bun.sleep(duration);
}

await main();
