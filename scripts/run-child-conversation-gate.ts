#!/usr/bin/env bun
/** Real-Pi child-conversation open, navigation, toggle, close and restoration PTY gate. */
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { finished } from "node:stream/promises";
import type { Readable } from "node:stream";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { assertOrdered, encodeKey } from "./focus-spike-protocol.ts";
import { detectPiRuntime, piExecutable } from "./pi-runtime-target.ts";
import {
  CHILD_GATE_BUILTIN_SUMMARY,
  CHILD_GATE_EDITOR_TEXT,
  CHILD_GATE_NATIVE_ASSISTANT_TEXT,
  CHILD_GATE_NATIVE_USER_TEXT,
  CHILD_GATE_SENSITIVE_VALUE,
  CHILD_GATE_TOOL_PREVIEW,
} from "./child-conversation-gate-fixture.ts";
import {
  CHILD_CAPACITY_ENV,
  CHILD_DEPTH_ENV,
  CHILD_MARKER_ENV,
  CHILD_MAX_DEPTH_ENV,
} from "../src/constants.ts";

export const REQUIRED_CHILD_VIEW_EVENTS = [
  "editor-prefilled",
  "widget-focused",
  "nested-row-selected",
  "conversation-opened",
  "fullscreen-covered",
  "native-user-rendered",
  "native-assistant-rendered",
  "native-builtin-tool-rendered",
  "native-generic-tool-rendered",
  "native-override-tool-rendered",
  "native-builtin-names-asserted",
  "scrolled-up",
  "thinking-toggled",
  "tools-toggled",
  "conversation-closed",
  "editor-restored",
  "selection-restored",
  "widget-navigation-restored",
] as const;

export type ChildConversationGateOutcome = "supported" | "unsupported" | "not-run";

export function classifyChildConversationGate(events: readonly string[]): ChildConversationGateOutcome {
  if (events.length === 0) return "not-run";
  try {
    assertOrdered(events, REQUIRED_CHILD_VIEW_EVENTS);
    return "supported";
  } catch {
    return "unsupported";
  }
}

const ROWS = 24;
const COLUMNS = 80;
const EVENT_TIMEOUT_MS = 10_000;
const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURE = join(HERE, "child-conversation-gate-fixture.ts");
const ANSI_ESCAPE = /\u001b(?:\[[0-?]*[ -/]*[@-~]|\][^\u0007]*(?:\u0007|\u001b\\))/gu;
const DIAGNOSTIC_EVENTS: ReadonlySet<string> = new Set(REQUIRED_CHILD_VIEW_EVENTS);

/** Detects raw 7-bit and C1 OSC 133 shell-integration prefixes without stripping them. */
export function containsOsc133(value: string): boolean {
  return value.includes("\u001b]133;") || value.includes("\u009d133;");
}

/** Bounded failure evidence containing no terminal, editor or transcript content. */
export function safeChildGateDiagnostic(
  phase: string,
  output: string,
  events: readonly string[] = [],
): string {
  const safePhase = phase.replace(/[^a-z0-9_.-]/giu, "_").slice(0, 48);
  const controls = [...output].filter((character) => {
    const code = character.codePointAt(0) ?? 0;
    return code < 32 || code === 127;
  }).length;
  const escapes = output.match(ANSI_ESCAPE)?.length ?? 0;
  const known = new Set<string>();
  for (const event of events) {
    if (DIAGNOSTIC_EVENTS.has(event)) known.add(event);
    if (known.size === DIAGNOSTIC_EVENTS.size) break;
  }
  return `phase=${safePhase}; outputLength=${output.length}; controls=${controls}; escapes=${escapes}; events=${[...known].join(",") || "none"}`;
}

/** Minimal fixed-size terminal state used only to inspect Pi's current public TUI frame. */
export class FixedTerminalScreen {
  private readonly cells: string[][];
  private row = 0;
  private column = 0;
  private savedRow = 0;
  private savedColumn = 0;
  private wrapPending = false;
  private pending = "";

  constructor(readonly rows: number, readonly columns: number) {
    this.cells = Array.from({ length: rows }, () => Array.from({ length: columns }, () => " "));
  }

  feed(chunk: string): void {
    const input = this.pending + chunk;
    this.pending = "";
    for (let index = 0; index < input.length;) {
      const character = input[index]!;
      if (character === "\u001b") {
        const consumed = this.escape(input, index);
        if (consumed === undefined) { this.pending = input.slice(index); return; }
        index = consumed;
        continue;
      }
      if (character === "\r") { this.column = 0; this.wrapPending = false; index += 1; continue; }
      if (character === "\n") { this.wrapPending = false; this.lineFeed(); index += 1; continue; }
      if (character === "\b") { this.column = Math.max(0, this.column - 1); index += 1; continue; }
      const code = character.codePointAt(0) ?? 0;
      if (code < 32 || code === 127) { index += 1; continue; }
      const point = String.fromCodePoint(code);
      this.put(point);
      index += point.length;
    }
  }

  lines(): readonly string[] {
    return this.cells.map((line) => line.join("").replace(/\s+$/u, ""));
  }

  text(): string { return this.lines().join("\n") }

  private escape(input: string, start: number): number | undefined {
    const kind = input[start + 1];
    if (kind === undefined) return undefined;
    if (kind === "[") {
      let end = start + 2;
      while (end < input.length && !/[\x40-\x7e]/u.test(input[end]!)) end += 1;
      if (end >= input.length) return undefined;
      this.csi(input.slice(start + 2, end), input[end]!);
      return end + 1;
    }
    if (kind === "]" || kind === "_" || kind === "P" || kind === "^") {
      for (let end = start + 2; end < input.length; end += 1) {
        if (input[end] === "\u0007") return end + 1;
        if (input[end] === "\u001b" && input[end + 1] === "\\") return end + 2;
      }
      return undefined;
    }
    if (kind === "7") { this.savedRow = this.row; this.savedColumn = this.column; }
    if (kind === "8") { this.row = this.savedRow; this.column = this.savedColumn; }
    return start + 2;
  }

  private csi(raw: string, command: string): void {
    const values = raw.replace(/^[?>!]/u, "").split(";").map((part) => part === "" ? 0 : Number(part));
    const first = values[0] ?? 0;
    const amount = first === 0 ? 1 : first;
    switch (command) {
      case "A": this.row = Math.max(0, this.row - amount); break;
      case "B": this.row = Math.min(this.rows - 1, this.row + amount); break;
      case "C": this.column = Math.min(this.columns - 1, this.column + amount); break;
      case "D": this.column = Math.max(0, this.column - amount); break;
      case "E": this.row = Math.min(this.rows - 1, this.row + amount); this.column = 0; break;
      case "F": this.row = Math.max(0, this.row - amount); this.column = 0; break;
      case "G": this.column = Math.max(0, Math.min(this.columns - 1, amount - 1)); break;
      case "H":
      case "f":
        this.row = Math.max(0, Math.min(this.rows - 1, (values[0] || 1) - 1));
        this.column = Math.max(0, Math.min(this.columns - 1, (values[1] || 1) - 1));
        break;
      case "J": this.eraseDisplay(first); break;
      case "K": this.eraseLine(first); break;
      case "s": this.savedRow = this.row; this.savedColumn = this.column; break;
      case "u": this.row = this.savedRow; this.column = this.savedColumn; break;
      case "h": if (raw.includes("?1049")) this.clear(); break;
      default: break;
    }
  }

  private put(character: string): void {
    if (this.rows === 0 || this.columns === 0) return;
    if (this.wrapPending) {
      this.column = 0;
      this.lineFeed();
      this.wrapPending = false;
    }
    this.cells[this.row]![this.column] = character;
    if (this.column === this.columns - 1) this.wrapPending = true;
    else this.column += 1;
  }

  private lineFeed(): void {
    if (this.row < this.rows - 1) { this.row += 1; return; }
    this.cells.shift();
    this.cells.push(Array.from({ length: this.columns }, () => " "));
  }

  private eraseDisplay(mode: number): void {
    if (mode === 2 || mode === 3) { this.clear(); return; }
    if (mode === 0) {
      this.eraseLine(0);
      for (let row = this.row + 1; row < this.rows; row += 1) this.cells[row]!.fill(" ");
      return;
    }
    if (mode === 1) {
      this.eraseLine(1);
      for (let row = 0; row < this.row; row += 1) this.cells[row]!.fill(" ");
    }
  }

  private eraseLine(mode: number): void {
    const line = this.cells[this.row]!;
    if (mode === 2) { line.fill(" "); return; }
    if (mode === 1) { for (let column = 0; column <= this.column; column += 1) line[column] = " "; return; }
    for (let column = this.column; column < this.columns; column += 1) line[column] = " ";
  }

  private clear(): void {
    for (const line of this.cells) line.fill(" ");
    this.row = 0;
    this.column = 0;
    this.wrapPending = false;
  }
}

export function hasFullscreenConversationFrame(lines: readonly string[]): boolean {
  return lines.length === ROWS
    && (lines[0]?.includes("A1.2") ?? false)
    && (lines[ROWS - 1]?.includes("following") ?? false);
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

function readTrace(path: string): string[] {
  try { return readFileSync(path, "utf8").split("\n").filter(Boolean); }
  catch { return []; }
}

async function waitFor(predicate: () => boolean, detail: () => string): Promise<void> {
  const deadline = Date.now() + EVENT_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await Bun.sleep(25);
  }
  throw new Error(`timeout: ${detail()}`);
}

function writeInput(child: ChildProcess, data: string): void {
  if (child.stdin === null) throw new Error("PTY stdin is unavailable");
  child.stdin.write(data);
}

export async function awaitTerminalClose(child: {
  once(event: "close", listener: () => void): unknown;
  readonly stdout: Readable | null;
  readonly stderr: Readable | null;
}): Promise<void> {
  const processClose = new Promise<void>((resolve) => { child.once("close", resolve); });
  const streams = [child.stdout, child.stderr].filter((stream): stream is Readable => stream !== null);
  await Promise.all([processClose, ...streams.map((stream) => stream.closed ? Promise.resolve() : finished(stream))]);
}

async function stop(child: ChildProcess, terminalClose: Promise<void>): Promise<void> {
  if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
  await terminalClose;
}

function requireScript(): void {
  const result = spawnSync("script", ["--version"], { encoding: "utf8", timeout: 5_000 });
  if (result.error !== undefined || result.status !== 0) {
    throw new Error("system script(1) PTY prerequisite is unavailable");
  }
}

export function createChildConversationGateEnvironment(
  workDir: string,
  eventFile: string,
  inherited: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = {
    ...inherited,
    HOME: join(workDir, "home"),
    PI_CODING_AGENT_DIR: join(workDir, "agent"),
    PI_CHILD_CONVERSATION_GATE_EVENT_FILE: eventFile,
    PI_OFFLINE: "1",
  };
  for (const name of [
    "PI_CODING_AGENT_SESSION_DIR",
    "PI_PACKAGE_DIR",
    "XDG_CONFIG_HOME",
    "XDG_DATA_HOME",
    "XDG_CACHE_HOME",
    CHILD_MARKER_ENV,
    CHILD_DEPTH_ENV,
    CHILD_MAX_DEPTH_ENV,
    CHILD_CAPACITY_ENV,
  ]) delete environment[name];
  return environment;
}

async function drive(command: readonly string[], workDir: string, eventFile: string, proofFile: string, logFile: string): Promise<string[]> {
  const shellCommand = `stty rows ${ROWS} cols ${COLUMNS}; exec ${command.map(shellQuote).join(" ")}`;
  mkdirSync(join(workDir, "home"), { recursive: true });
  mkdirSync(join(workDir, "agent"), { recursive: true });
  const environment = createChildConversationGateEnvironment(workDir, eventFile);
  environment.PI_CHILD_CONVERSATION_GATE_PROOF_FILE = proofFile;
  const child = spawn("script", ["-q", "-f", "-c", shellCommand, logFile], {
    cwd: workDir,
    env: environment,
    stdio: ["pipe", "pipe", "pipe"],
  });
  const terminalClose = awaitTerminalClose(child);
  const terminal = new FixedTerminalScreen(ROWS, COLUMNS);
  let cumulativeRawOutput = "";
  let conversationOpen = false;
  let rawOsc133Observed = false;
  const accept = (chunk: Buffer): void => {
    const text = chunk.toString("utf8");
    cumulativeRawOutput += text;
    if (conversationOpen && containsOsc133(cumulativeRawOutput)) rawOsc133Observed = true;
    terminal.feed(text);
  };
  child.stdout.on("data", accept);
  child.stderr.on("data", accept);
  const events: string[] = [];
  const detail = (phase: string): string => safeChildGateDiagnostic(phase, cumulativeRawOutput, events);
  const assertNoRawOsc133 = (): void => {
    if (rawOsc133Observed || (conversationOpen && containsOsc133(cumulativeRawOutput))) {
      throw new Error("raw output contains OSC 133 shell integration");
    }
  };
  const observe = async (predicate: () => boolean, phase: string): Promise<void> => {
    await waitFor(predicate, () => detail(phase));
    assertNoRawOsc133();
  };

  try {
    await waitFor(
      () => terminal.text().includes(CHILD_GATE_EDITOR_TEXT) && terminal.text().includes("Nested gate child"),
      () => detail("initial parent frame"),
    );
    events.push("editor-prefilled");

    const beforeClear = cumulativeRawOutput.length;
    writeInput(child, "\u0003");
    await waitFor(() => cumulativeRawOutput.length > beforeClear, () => detail("clear draft"));
    writeInput(child, encodeKey("down"));
    await waitFor(() => readTrace(eventFile).includes("widget-focused"), () => detail("widget focus"));
    events.push("widget-focused");

    writeInput(child, encodeKey("down"));
    await waitFor(() => /›[^\n]*A1\.2/u.test(terminal.text()), () => detail("nested selection"));
    events.push("nested-row-selected");

    writeInput(child, encodeKey("enter"));
    await waitFor(() => terminal.lines()[0]?.includes("A1.2") === true, () => detail("conversation open"));
    conversationOpen = true;
    assertNoRawOsc133();
    events.push("conversation-opened");
    await observe(() => hasFullscreenConversationFrame(terminal.lines()), "fullscreen frame");
    events.push("fullscreen-covered");

    writeInput(child, "g");
    await observe(() => terminal.text().includes(CHILD_GATE_NATIVE_USER_TEXT), "native user");
    events.push("native-user-rendered");
    await observe(() => terminal.text().includes(CHILD_GATE_NATIVE_ASSISTANT_TEXT), "native assistant");
    events.push("native-assistant-rendered");
    writeInput(child, "\u000f");
    await observe(() => terminal.text().includes(CHILD_GATE_BUILTIN_SUMMARY)
      && terminal.text().includes(CHILD_GATE_TOOL_PREVIEW) && terminal.text().includes("read"), "native built-in tool");
    events.push("native-builtin-tool-rendered");
    await observe(() => terminal.text().includes("subagent_probe")
      && terminal.text().includes("fixture"), "native generic tool");
    events.push("native-generic-tool-rendered");
    writeInput(child, "\u000f");
    await observe(() => !terminal.text().includes(CHILD_GATE_TOOL_PREVIEW), "tools collapse before renderer override proof");
    for (let index = 0; index < 24 && !(terminal.text().includes("Result shown in bounded form")
      && !terminal.text().includes(CHILD_GATE_BUILTIN_SUMMARY)
      && !terminal.text().includes("subagent_probe")); index += 1) {
      const beforeMove = cumulativeRawOutput.length;
      writeInput(child, encodeKey("down"));
      await waitFor(() => cumulativeRawOutput.length > beforeMove, () => detail("renderer override scroll"));
      assertNoRawOsc133();
    }
    await observe(() => terminal.text().includes("read")
      && terminal.text().includes("Result shown in bounded form")
      && !terminal.text().includes(CHILD_GATE_BUILTIN_SUMMARY)
      && !terminal.text().includes("subagent_probe")
      && !terminal.text().includes(CHILD_GATE_SENSITIVE_VALUE), "renderer override tool");
    events.push("native-override-tool-rendered");
    writeFileSync(proofFile, "native-built-in-rendered\n", { flag: "wx", mode: 0o600 });
    await observe(() => readTrace(eventFile).includes("native-builtin-names-asserted"), "runtime built-in names");
    events.push("native-builtin-names-asserted");

    writeInput(child, "G");
    await observe(() => terminal.lines()[ROWS - 1]?.includes("following") === true, "conversation tail");
    writeInput(child, "\u001b[5~");
    await observe(() => terminal.lines()[ROWS - 1]?.includes("paused") === true, "page up");
    events.push("scrolled-up");

    writeInput(child, "g");
    await observe(() => terminal.text().includes("CHILD_GATE_THINKING"), "thinking before toggle");
    writeInput(child, "\u0014");
    await observe(() => !terminal.text().includes("CHILD_GATE_THINKING"), "thinking toggle");
    events.push("thinking-toggled");

    writeInput(child, "\u000f");
    await observe(() => terminal.text().includes("CHILD_GATE_TOOL_PREVIEW"), "tools toggle");
    events.push("tools-toggled");

    writeInput(child, encodeKey("escape"));
    await observe(() => !terminal.lines()[0]?.includes("A1.2"), "conversation close");
    events.push("conversation-closed");
    await observe(() => terminal.text().includes(CHILD_GATE_EDITOR_TEXT), "editor restore");
    events.push("editor-restored");

    writeInput(child, encodeKey("enter"));
    await observe(() => terminal.lines()[0]?.includes("A1.2") === true, "selection restore");
    events.push("selection-restored");
    writeInput(child, encodeKey("escape"));
    await observe(() => !terminal.lines()[0]?.includes("A1.2"), "second close");
    writeInput(child, encodeKey("up"));
    await observe(() => /›[^\n]*A1(?!\.)/u.test(terminal.text()), "widget navigation");
    writeInput(child, encodeKey("up"));
    await observe(() => readTrace(eventFile).includes("editor-refocused"), "widget navigation restore");
    events.push("widget-navigation-restored");
    return events;
  } finally {
    await stop(child, terminalClose);
    assertNoRawOsc133();
  }
}

async function main(): Promise<void> {
  const workDir = mkdtempSync(join(tmpdir(), "pi-child-conversation-gate-"));
  const eventFile = join(workDir, "events.txt");
  const proofFile = join(workDir, "built-in-proof.txt");
  const logFile = join(workDir, "script.log");
  let outcome: ChildConversationGateOutcome = "not-run";
  let reason = "gate did not run";
  try {
    requireScript();
    const target = detectPiRuntime(piExecutable("pi"));
    const events = await drive([
      target.executable,
      "-e", FIXTURE,
      "--no-extensions",
      "--no-session",
      "--offline",
      "--model", "child-conversation-gate/fixture",
      "--no-context-files",
      "--no-skills",
      "--no-prompt-templates",
      "--no-themes",
      "--approve",
    ], workDir, eventFile, proofFile, logFile);
    process.stderr.write(`child conversation gate events: ${JSON.stringify(events)}\n`);
    outcome = classifyChildConversationGate(events);
    if (outcome !== "supported") reason = "required event ordering was not observed";
  } catch (error) {
    outcome = "unsupported";
    const errorType = error instanceof Error ? error.name : typeof error;
    const rawOsc133 = error instanceof Error && error.message === "raw output contains OSC 133 shell integration";
    const failedPhase = error instanceof Error ? /^timeout: ([^;]+)/u.exec(error.message)?.[1] : undefined;
    const phase = failedPhase === undefined ? "runtime failure" : failedPhase;
    reason = `${safeChildGateDiagnostic(phase, "", readTrace(eventFile))}; errorType=${errorType}; rawOsc133=${rawOsc133}`;
  } finally {
    rmSync(workDir, { recursive: true, force: true });
  }
  const label = outcome === "supported"
    ? "CHILD_CONVERSATION_GATE_SUPPORTED"
    : "CHILD_CONVERSATION_GATE_UNSUPPORTED";
  console.log(outcome === "supported" ? label : `${label}: ${reason}`);
  if (outcome !== "supported") process.exitCode = 1;
}

if (process.argv[1] !== undefined && fileURLToPath(import.meta.url) === process.argv[1]) await main();
