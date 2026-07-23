#!/usr/bin/env bun
/** Real-Pi Gate A focus-transfer spike under the system script(1) PTY. */
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { assertOrdered, encodeKey, type FocusMechanism } from "./focus-spike-protocol.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURE = join(HERE, "..", "test", "fixtures", "focus-transfer-spike-extension.ts");
const LOCAL_CLI = join(HERE, "..", "node_modules", "@earendil-works", "pi-coding-agent", "dist", "cli.js");

function argValue(flag: string, fallback: string): string {
  const index = process.argv.indexOf(flag);
  return index === -1 ? fallback : (process.argv[index + 1] ?? fallback);
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

function readEvents(path: string): string[] {
  try { return readFileSync(path, "utf-8").split("\n").filter(Boolean).map((line) => line.replace(/^\d+ /, "")); }
  catch { return []; }
}

async function drive(piCommand: string[], mode: FocusMechanism, resultFile: string, logFile: string, workDir: string): Promise<string[]> {
  const child = spawn("script", ["-q", "-f", "-c", piCommand.map(shellQuote).join(" "), logFile], {
    cwd: workDir,
    env: { ...process.env, PI_FOCUS_SPIKE_RESULT_FILE: resultFile, PI_FOCUS_SPIKE_MODE: mode },
    stdio: ["pipe", "pipe", "pipe"],
  });
  let output = "";
  child.stdout.on("data", (chunk: Buffer) => { output += chunk.toString("utf-8"); });
  child.stderr.on("data", (chunk: Buffer) => { output += chunk.toString("utf-8"); });
  try {
    // Pass a getter, not the string: `output` accumulates asynchronously, so driveKeys must read
    // it lazily to see PTY bytes captured after the call began.
    return await driveKeys(child, mode, resultFile, () => output);
  } finally {
    // Always reap the PTY child, even when driveKeys throws on a timeout, so an unsupported or
    // hung Pi never leaks a process.
    child.kill("SIGTERM");
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => { child.kill("SIGKILL"); resolve(); }, 2_000);
      child.once("exit", () => { clearTimeout(timer); resolve(); });
    });
  }
}

async function driveKeys(child: ReturnType<typeof spawn>, mode: FocusMechanism, resultFile: string, getOutput: () => string): Promise<string[]> {
  // Wait for the fixture to install, then feed the keystroke script.
  await waitFor(() => readEvents(resultFile).some((event) => event.startsWith("fixture_ready")), 8_000, resultFile);

  if (mode === "primary") {
    // Interference control first (Subtask 1.4): open the SELF-OWNED spike selector (alt+t),
    // press Down (the selector must consume it -> `spike_selector_down`, NOT the editor), dismiss.
    // If the editor interceptor leaked, `editor_down_empty_focuses_board` appears now — before the
    // real transfer below — which main() flags as UNSUPPORTED. `spike_selector_down` being present
    // makes this non-vacuous: it proves another component genuinely owned input.
    // alt+t is sent ESC-prefixed ("\x1bt"); registerShortcut cannot override a default binding, so
    // the default-free alt+t is used instead of ctrl+t (which is the thinking-toggle default).
    child.stdin.write("\x1bt"); await Bun.sleep(300);          // alt+t opens the spike selector
    child.stdin.write(encodeKey("down")); await Bun.sleep(200);
    child.stdin.write(encodeKey("escape")); await Bun.sleep(300);

    // Composition proof: the `!` sentinel must reach the COMPOSED base editor (design mandates
    // custom-editor composition). `base_editor_delegated` proves the wrapper delegated via
    // getEditorComponent() rather than replacing the base outright.
    child.stdin.write("!"); await Bun.sleep(200);

    // Non-empty-editor case: type text, press Down. Must record editor_down_nonempty_native and
    // NOT focus the board. Then clear the line so the empty-editor transfer below is valid.
    child.stdin.write("some text"); await Bun.sleep(150);
    child.stdin.write(encodeKey("down")); await Bun.sleep(200);
    child.stdin.write("\x15"); await Bun.sleep(150);           // ctrl+u clears the line

    // Happy path: empty editor Down -> board focused; Down moves selection; Up back to first; Up
    // unfocuses back to the editor (board stays visible — no close). Then a final empty Down must
    // re-focus the board — this second focus PROVES input returned to the editor after unfocus,
    // rather than the board silently keeping ownership.
    for (const key of ["down", "down", "up", "up", "down"] as const) {
      child.stdin.write(encodeKey(key)); await Bun.sleep(250);
    }
    await waitFor(() => readEvents(resultFile).filter((e) => e === "board_focused").length >= 2, 8_000, resultFile);
  } else {
    child.stdin.write("\x1bg"); await Bun.sleep(300);           // alt+g opens the modal board
    // Down moves to row 2, Up back to row 1, Up returns to the editor and closes the board.
    for (const key of ["down", "up", "up"] as const) {
      child.stdin.write(encodeKey(key)); await Bun.sleep(250);
    }
    await waitFor(() => readEvents(resultFile).includes("board_closed"), 8_000, resultFile);
  }

  const events = readEvents(resultFile);
  if (events.length === 0) throw new Error(`no events recorded; output=${getOutput().slice(0, 500)}`);
  return events;
}

async function waitFor(predicate: () => boolean, timeoutMs: number, resultFile: string): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) { if (predicate()) return; await Bun.sleep(50); }
  throw new Error(`timeout; events=${JSON.stringify(readEvents(resultFile))}`);
}

async function main(): Promise<void> {
  const version = argValue("--pi", "global");
  const mode = (argValue("--mode", "primary") === "fallback" ? "fallback" : "primary") as FocusMechanism;
  const piBase = version === "0.80.6" ? ["node", LOCAL_CLI] : ["pi"];
  const piCommand = [
    ...piBase, "-e", FIXTURE, "--no-extensions",
    "--no-session", "--offline", "--no-context-files", "--no-skills",
    "--no-prompt-templates", "--no-themes", "--approve",
  ];
  const workDir = mkdtempSync(join(tmpdir(), "pi-focus-spike-"));
  const resultFile = join(workDir, "result.txt");
  const logFile = join(workDir, "script.log");
  const label = `FOCUS_TRANSFER_${mode.toUpperCase()}`;
  try {
    let events: string[];
    try {
      events = await drive(piCommand, mode, resultFile, logFile, workDir);
    } catch (error) {
      // Every exit path must emit exactly one labelled line — a timeout or crash is UNSUPPORTED
      // evidence, not an unhandled rejection with no result.
      console.log(`${label}_UNSUPPORTED: ${(error as Error).message.slice(0, 300)}`);
      return;
    }
    process.stderr.write(`ordered focus events (${version}/${mode}): ${JSON.stringify(events)}\n`);
    const expected = mode === "primary"
      ? ["fixture_ready mode=primary", "spike_selector_down", "base_editor_delegated", "editor_down_nonempty_native", "editor_down_empty_focuses_board", "board_focused", "board_up_from_first_unfocuses", "editor_down_empty_focuses_board", "board_focused"]
      : ["fixture_ready mode=fallback", "shortcut_triggered", "board_opened", "board_up_from_first_unfocuses", "board_closed"];

    if (mode === "primary") {
      // Non-vacuous interference proof: the self-owned selector must have owned its own Down.
      if (!events.includes("spike_selector_down")) {
        console.log(`${label}_UNSUPPORTED: interference control never owned input (spike_selector_down absent)`);
        return;
      }
      // Leak guard: no board focus may precede the non-empty-editor Down (i.e. nothing leaked while
      // the selector owned input or the editor held text).
      const firstFocus = events.indexOf("editor_down_empty_focuses_board");
      const nonEmpty = events.indexOf("editor_down_nonempty_native");
      if (nonEmpty === -1) { console.log(`${label}_UNSUPPORTED: non-empty-editor Down was not observed as native`); return; }
      if (firstFocus !== -1 && firstFocus < nonEmpty) {
        console.log(`${label}_UNSUPPORTED: Down focused the board while a selector or non-empty editor owned input`);
        return;
      }
      // Co-visibility proof (design: editor and mounted board visible simultaneously). The PTY
      // capture must contain the overlay board's unique marker — the display-only belowEditor
      // widget never renders it — proving the board was actually on screen alongside the editor.
      let ptyLog = "";
      try { ptyLog = readFileSync(logFile, "utf-8"); } catch { /* log absent */ }
      if (!ptyLog.includes("BOARD_MARKER")) {
        console.log(`${label}_UNSUPPORTED: mounted board never rendered (co-visibility with the editor unproven)`);
        return;
      }
    }

    try {
      assertOrdered(events, expected);
      console.log(`${label}_SUPPORTED`);
    } catch (error) {
      console.log(`${label}_UNSUPPORTED: ${(error as Error).message.slice(0, 300)}`);
    }
  } finally {
    rmSync(workDir, { recursive: true, force: true });
  }
}

await main();
