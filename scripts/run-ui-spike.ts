#!/usr/bin/env bun
/** Real-Pi direct UI forwarding spike under the system script(1) PTY. */
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURES_DIR = join(HERE, "..", "test", "fixtures");
const MAX_REASON_BYTES = 500;

type Mode = "direct" | "broker";

function parseMode(argv: readonly string[]): Mode {
  const index = argv.indexOf("--mode");
  const mode = index === -1 ? "direct" : argv[index + 1];
  if (mode !== "direct" && mode !== "broker") throw new Error(`invalid --mode: ${mode}`);
  if (mode === "broker") {
    const drainIndex = argv.indexOf("--drain-event");
    if (argv[drainIndex + 1] !== "agent_settled") {
      throw new Error("--mode broker requires --drain-event agent_settled");
    }
  }
  return mode;
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

function readEvents(path: string): string[] {
  try {
    return readFileSync(path, "utf-8").split("\n").filter(Boolean);
  } catch {
    return [];
  }
}

function eventIndex(events: readonly string[], name: string): number {
  return events.findIndex((event) => event.replace(/^\d+ /, "").startsWith(name));
}

function bounded(value: string): string {
  return value.length > MAX_REASON_BYTES ? `${value.slice(0, MAX_REASON_BYTES)}...` : value;
}

async function run(mode: Mode, workDir: string, resultFile: string, logFile: string): Promise<string[]> {
  const piArgs = [
    "pi", "--extension", join(FIXTURES_DIR, "slow-provider-extension.ts"),
    "--extension", join(FIXTURES_DIR, "parent-ui-spike-extension.ts"),
    "--no-extensions", "--provider", "slow-fake", "--model", "slow-fake-model",
    "--no-session", "--offline", "--no-context-files", "--no-skills",
    "--no-prompt-templates", "--no-themes", "--approve",
  ];
  const child = spawn("script", ["-q", "-f", "-c", piArgs.map(shellQuote).join(" "), logFile], {
    cwd: workDir,
    env: { ...process.env, PI_UI_SPIKE_RESULT_FILE: resultFile, PI_UI_SPIKE_MODE: mode },
    stdio: ["pipe", "pipe", "pipe"],
  });
  let output = "";
  child.stdout.on("data", (chunk: Buffer) => {
    output += chunk.toString("utf-8");
    if (output.includes("confirmation to continue") && !dialogAcknowledged) {
      dialogAcknowledged = true;
      child.stdin.write("\r");
    }
  });
  child.stderr.on("data", (chunk: Buffer) => { output += chunk.toString("utf-8"); });
  let dialogAcknowledged = false;
  await Bun.sleep(1500);
  child.stdin.write("hello\r");

  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    const events = readEvents(resultFile);
    if (eventIndex(events, "agent_settled") !== -1 || eventIndex(events, "callback_error") !== -1) {
      child.kill("SIGTERM");
      await new Promise<void>((resolve) => child.once("exit", () => resolve()));
      if (!dialogAcknowledged) throw new Error("dialog was not observed in script(1) PTY output");
      return events;
    }
    await Bun.sleep(50);
  }
  child.kill("SIGTERM");
  throw new Error(`timeout waiting for settlement; events=${JSON.stringify(readEvents(resultFile))}; output=${bounded(output)}`);
}

async function main(): Promise<void> {
  const mode = parseMode(process.argv.slice(2));
  const label = mode === "direct" ? "DIRECT_UI_FORWARDING" : "BROKER_UI_FORWARDING";
  const workDir = mkdtempSync(join(tmpdir(), "pi-ui-spike-"));
  const resultFile = join(workDir, "result.txt");
  try {
    const events = await run(mode, workDir, resultFile, join(workDir, "script.log"));
    process.stderr.write(`ordered spike events: ${JSON.stringify(events)}\n`);
    const error = eventIndex(events, "callback_error");
    if (error !== -1) {
      console.log(`${label}_UNSUPPORTED: ${bounded(events[error] ?? "callback error")}`);
      return;
    }
    const opened = eventIndex(events, "dialog_opened");
    const resolved = eventIndex(events, "dialog_resolved");
    const settled = eventIndex(events, "agent_settled");
    if (opened === -1 || resolved === -1 || settled === -1) {
      throw new Error(`inconclusive event artefact: ${JSON.stringify(events)}`);
    }
    if (!(opened < resolved && resolved < settled)) {
      throw new Error(`wrong event ordering: ${JSON.stringify(events)}`);
    }
    console.log(`${label}_SUPPORTED`);
  } finally {
    rmSync(workDir, { recursive: true, force: true });
  }
}

await main();
