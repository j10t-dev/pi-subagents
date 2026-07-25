#!/usr/bin/env bun
/** Real-Pi widget composition and focus-transfer gate under the system script(1) PTY. */
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { assertOrdered, encodeKey } from "./focus-spike-protocol.ts";
import { detectPiRuntime, piExecutable } from "./pi-runtime-target.ts";

export const REQUIRED_EVENTS = [
  "submitted",
  "autocomplete",
  "cleared",
  "widget-focused",
  "editor-refocused",
  "native-arrow",
  "selector-consumed",
] as const;

export type WidgetFocusGateOutcome = "supported" | "unsupported" | "not-run";

export function classifyGate(events: readonly string[]): WidgetFocusGateOutcome {
  if (events.length === 0) return "not-run";
  try {
    assertOrdered(events, REQUIRED_EVENTS);
    return "supported";
  } catch {
    return "unsupported";
  }
}

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURE = join(HERE, "widget-gate-fixture.ts");
const EVENT_TIMEOUT_MS = 8_000;
const START_TIMEOUT_MS = 12_000;
const TURN_TIMEOUT_MS = 60_000;
const QUIET_MS = 750;
const RESPONSE_TOKEN = "widgetgateproof";
const RESPONSE_MARKER = RESPONSE_TOKEN.toUpperCase();
const SUBMISSION_PROMPT = `Reply with only the uppercase form of ${RESPONSE_TOKEN}.`;

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

function readTrace(path: string): string[] {
  try {
    return readFileSync(path, "utf-8").split("\u000A").filter(Boolean);
  } catch {
    return [];
  }
}

const ANSI_ESCAPE = /\u001b(?:\[[0-?]*[ -/]*[@-~]|\][^\u0007]*(?:\u0007|\u001b\\))/gu;
const DIAGNOSTIC_EVENTS: ReadonlySet<string> = new Set(REQUIRED_EVENTS.filter((event) => event !== "submitted"));

/**
 * Formats bounded structural state for failures without reproducing terminal or model content.
 * `screen` is inspected only for lengths and control-sequence counts; trace output is allow-listed.
 */
export function safeGateDiagnostic(
  phase: string,
  screen: string,
  events: readonly string[] = [],
): string {
  const safePhase = phase.replace(/[^a-z0-9_.-]/giu, "_").slice(0, 48);
  const controlCount = [...screen].filter((character) => {
    const code = character.codePointAt(0) ?? 0;
    return code < 32 || code === 127;
  }).length;
  const escapeCount = screen.match(ANSI_ESCAPE)?.length ?? 0;
  const knownEvents = new Set<string>();
  for (const event of events) {
    if (DIAGNOSTIC_EVENTS.has(event)) knownEvents.add(event);
    if (knownEvents.size === DIAGNOSTIC_EVENTS.size) break;
  }
  return `phase=${safePhase}; outputLength=${screen.length}; controls=${controlCount}; escapes=${escapeCount}; trace=${[...knownEvents].join(",") || "none"}`;
}

async function waitFor(predicate: () => boolean, timeoutMs: number, detail: () => string): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await Bun.sleep(50);
  }
  throw new Error(`timeout: ${detail()}`);
}

function writeInput(child: ChildProcess, data: string): void {
  if (child.stdin === null) throw new Error("PTY stdin is unavailable");
  child.stdin.write(data);
}

async function stop(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  child.kill("SIGTERM");
  await new Promise<void>((resolve) => {
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      resolve();
    }, 2_000);
    child.once("exit", () => {
      clearTimeout(timer);
      resolve();
    });
  });
}

/**
 * A response marker is evidence of a completed submission only when it was absent before Enter and
 * appears afterwards. The gate deliberately requests an uppercase marker from a lowercase token, so
 * editor echo cannot satisfy this predicate.
 */
export function responseMarkerAppeared(screen: string, marker: string, after: number): boolean {
  return marker.length > 0 && !screen.slice(0, after).includes(marker) && screen.slice(after).includes(marker);
}

/** A selector belongs to this slash only when its frame was emitted after that slash was typed. */
export function screenHasAutocompleteSince(screen: string, after: number): boolean {
  const added = screen.slice(after);
  // Generic command text can be historical repaint or help output. Every accepted branch needs
  // the selector's fresh position/total indicator from the post-slash frame.
  return /\(\d+\/\d+\)/u.test(added)
    && /(?:Commands|command|autocomplete|\/help|\bsettings\b)/iu.test(added);
}

/** Returns the selector-row marker that moves when Down changes the selected command. */
export function selectorSelectionIndicator(frame: string): string | undefined {
  const visible = frame.replace(ANSI_ESCAPE, "");
  if (!/\(\d+\/\d+\)/u.test(visible)) return undefined;
  const match = /(?:^|[\r\n])([→❯›> ])\s*settings\b/u.exec(visible);
  return match?.[1];
}

export function selectorIndicatorChanged(before: string | undefined, after: string | undefined): boolean {
  return before !== undefined && after !== undefined && before !== after;
}

/** Pi handles autocomplete within its editor, so native-arrow instrumentation may fire while the
 * selector consumes Down. Selector ownership is disproved only by a new widget focus transfer. */
export function selectorDownWasConsumed(
  before: string | undefined,
  after: string | undefined,
  eventsAfterDown: readonly string[],
): boolean {
  return selectorIndicatorChanged(before, after) && !eventsAfterDown.includes("widget-focused");
}

/**
 * Resolves once the pty has produced no new output for `quietMs`. Pi redraws in place and streams a
 * model response token by token, so "the frame stopped changing" is the only reliable signal that a
 * turn has finished; there is no terminal string to wait for, and no string to wait to disappear.
 */
async function waitForQuiet(readScreen: () => string, quietMs: number, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let length = readScreen().length;
  let since = Date.now();
  while (Date.now() < deadline) {
    await Bun.sleep(50);
    const current = readScreen().length;
    if (current !== length) {
      length = current;
      since = Date.now();
      continue;
    }
    if (Date.now() - since >= quietMs) return;
  }
  throw new Error(`output did not settle within ${timeoutMs}ms; ${safeGateDiagnostic("turn settle", readScreen())}`);
}

async function drive(piCommand: readonly string[], workDir: string, eventFile: string, logFile: string): Promise<string[]> {
  const child = spawn("script", ["-q", "-f", "-c", piCommand.map(shellQuote).join(" "), logFile], {
    cwd: workDir,
    env: { ...process.env, PI_WIDGET_GATE_EVENT_FILE: eventFile },
    stdio: ["pipe", "pipe", "pipe"],
  });
  let screen = "";
  child.stdout.on("data", (chunk: Buffer) => { screen += chunk.toString("utf-8"); });
  child.stderr.on("data", (chunk: Buffer) => { screen += chunk.toString("utf-8"); });

  try {
    await waitFor(() => screen.includes("Observe first fixture agent"), START_TIMEOUT_MS, () => safeGateDiagnostic("widget render", screen));

    const events: string[] = [];
    const beforePrompt = screen.length;
    writeInput(child, SUBMISSION_PROMPT);
    await waitFor(() => screen.length > beforePrompt, EVENT_TIMEOUT_MS, () => safeGateDiagnostic("prompt render", screen));
    const beforeEnter = screen.length;
    writeInput(child, encodeKey("enter"));
    await waitFor(
      () => responseMarkerAppeared(screen, RESPONSE_MARKER, beforeEnter),
      TURN_TIMEOUT_MS,
      () => safeGateDiagnostic("response after Enter", screen),
    );
    // Waits out the whole model turn, not just the response-marker frame. Every growth-based
    // assertion after this point would otherwise be satisfied by response streaming alone.
    await waitForQuiet(() => screen, QUIET_MS, TURN_TIMEOUT_MS);
    events.push("submitted");

    // A fresh command autocomplete immediately after the settled turn independently proves that
    // submission emptied the editor and returned it to command-ready state.
    const firstSlash = screen.length;
    writeInput(child, "/");
    await waitFor(() => screenHasAutocompleteSince(screen, firstSlash), EVENT_TIMEOUT_MS, () => safeGateDiagnostic("autocomplete", screen));
    events.push("autocomplete");
    writeInput(child, encodeKey("escape"));
    await waitForQuiet(() => screen, QUIET_MS, EVENT_TIMEOUT_MS);

    const beforeTextForClear = screen.length;
    writeInput(child, "abc");
    await waitFor(() => screen.length > beforeTextForClear, EVENT_TIMEOUT_MS, () => safeGateDiagnostic("clear input", screen));
    const beforeClear = screen.length;
    writeInput(child, "\u0003");
    await waitFor(() => screen.length > beforeClear, EVENT_TIMEOUT_MS, () => safeGateDiagnostic("clear action", screen));
    await waitForQuiet(() => screen, QUIET_MS, EVENT_TIMEOUT_MS);
    events.push("cleared");

    writeInput(child, encodeKey("down"));
    await waitFor(() => readTrace(eventFile).includes("widget-focused"), EVENT_TIMEOUT_MS, () => safeGateDiagnostic("empty editor Down", screen, readTrace(eventFile)));
    events.push("widget-focused");

    writeInput(child, encodeKey("up"));
    await waitFor(() => readTrace(eventFile).includes("editor-refocused"), EVENT_TIMEOUT_MS, () => safeGateDiagnostic("widget Up", screen, readTrace(eventFile)));
    events.push("editor-refocused");

    const beforeNativeText = screen.length;
    writeInput(child, "x");
    await waitFor(() => screen.length > beforeNativeText, EVENT_TIMEOUT_MS, () => safeGateDiagnostic("native arrow input", screen));
    writeInput(child, encodeKey("down"));
    await waitFor(() => readTrace(eventFile).includes("native-arrow"), EVENT_TIMEOUT_MS, () => safeGateDiagnostic("native editor Down", screen, readTrace(eventFile)));
    events.push("native-arrow");
    const beforeNativeClear = screen.length;
    writeInput(child, "\u0003");
    await waitFor(() => screen.length > beforeNativeClear, EVENT_TIMEOUT_MS, () => safeGateDiagnostic("native clear", screen));
    await waitForQuiet(() => screen, QUIET_MS, EVENT_TIMEOUT_MS);

    const secondSlash = screen.length;
    writeInput(child, "/");
    await waitFor(() => screenHasAutocompleteSince(screen, secondSlash), EVENT_TIMEOUT_MS, () => safeGateDiagnostic("second selector", screen));
    await waitForQuiet(() => screen, QUIET_MS, EVENT_TIMEOUT_MS);
    const initialIndicator = selectorSelectionIndicator(screen.slice(secondSlash));
    if (initialIndicator === undefined) {
      throw new Error(safeGateDiagnostic("second selector indicator", screen));
    }
    const traceCount = readTrace(eventFile).length;
    const beforeSelectorDown = screen.length;
    writeInput(child, encodeKey("down"));
    await waitFor(
      () => selectorIndicatorChanged(initialIndicator, selectorSelectionIndicator(screen.slice(beforeSelectorDown))),
      EVENT_TIMEOUT_MS,
      () => safeGateDiagnostic("selector Down", screen, readTrace(eventFile)),
    );
    const eventsAfterSelectorDown = readTrace(eventFile).slice(traceCount);
    if (!selectorDownWasConsumed(
      initialIndicator,
      selectorSelectionIndicator(screen.slice(beforeSelectorDown)),
      eventsAfterSelectorDown,
    )) {
      throw new Error(safeGateDiagnostic("selector ownership", screen, readTrace(eventFile)));
    }
    events.push("selector-consumed");
    writeInput(child, encodeKey("escape"));
    return events;
  } finally {
    await stop(child);
  }
}

async function main(): Promise<void> {
  const target = detectPiRuntime(piExecutable("pi"));
  const workDir = mkdtempSync(join(tmpdir(), "pi-widget-focus-gate-"));
  const eventFile = join(workDir, "events.txt");
  const logFile = join(workDir, "script.log");
  let outcome: WidgetFocusGateOutcome = "not-run";
  let reason = "gate did not run";
  try {
    const events = await drive([
      target.executable,
      "-e", FIXTURE,
      "--no-extensions",
      "--no-session",
      "--offline",
      "--no-context-files",
      "--no-skills",
      "--no-prompt-templates",
      "--no-themes",
      "--approve",
    ], workDir, eventFile, logFile);
    process.stderr.write(`widget focus gate events: ${JSON.stringify(events)}\u000A`);
    outcome = classifyGate(events);
    reason = outcome === "unsupported" ? `ordering mismatch: ${JSON.stringify(events)}` : reason;
  } catch (error) {
    outcome = "unsupported";
    const errorType = error instanceof Error ? error.name : typeof error;
    reason = `${safeGateDiagnostic("runtime failure", "", readTrace(eventFile))}; errorType=${errorType}`;
  } finally {
    rmSync(workDir, { recursive: true, force: true });
  }
  const label = outcome === "supported" ? "WIDGET_FOCUS_GATE_SUPPORTED" : "WIDGET_FOCUS_GATE_UNSUPPORTED";
  console.log(outcome === "supported" ? label : `${label}: ${reason}`);
  if (outcome !== "supported") process.exitCode = 1;
}

if (process.argv[1] !== undefined && fileURLToPath(import.meta.url) === process.argv[1]) {
  await main();
}
