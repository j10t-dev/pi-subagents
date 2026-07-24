import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import {
  accessSync,
  appendFileSync,
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  rmdirSync,
  statSync,
  statfsSync,
  writeFileSync,
} from "node:fs";
import { constants } from "node:fs";
import { dirname, isAbsolute, join } from "node:path";

const [attemptId, receiptPath, scopePath, parentScopePath, launcherPath] = process.argv.slice(2);
const MAX_CONTROL_LINE_BYTES = 256 * 1024;
const CONTAINMENT_TIMEOUT_MS = 10_000;
const FAKE = true;
const testConfig = existsSync(`${receiptPath}.fake-config.json`)
  ? JSON.parse(readFileSync(`${receiptPath}.fake-config.json`, "utf8"))
  : {};
// Test configuration models an independently received primitive wire value; it never alters the
// production-proven descriptor passed by the parent process.
const parentScopeWire = Object.hasOwn(testConfig, "parentScopeWire")
  ? testConfig.parentScopeWire
  : parentScopePath;
let state = "await_launch";
let controlBuffer = Buffer.alloc(0);
let launcher;
let finalising;
let authorised = false;
let piSpawned = false;

try {
  validatePaths();
  createAttemptScope();
  writeParent({ type: "ready", descriptor: { backend: "cgroup-v2", scopePath } });
} catch (error) {
  diagnostic(error);
  process.exit(1);
}

process.stdin.on("data", consumeParent);
process.stdin.once("end", () => void finish(outcomeForPhase()));
process.stdin.once("error", () => void finish(outcomeForPhase()));
process.stdout.once("error", () => void finish(outcomeForPhase()));
process.stderr.once("error", () => void finish(outcomeForPhase()));
process.on("SIGTERM", () => void finish(outcomeForPhase()));
process.on("SIGINT", () => void finish(outcomeForPhase()));

function validatePaths() {
  for (const [label, path] of [["receipt", receiptPath], ["scope", scopePath], ["parent scope", parentScopeWire], ["launcher", launcherPath]]) {
    if (typeof path !== "string" || !isAbsolute(path) || path.includes("\0")) throw new Error(`invalid ${label} path`);
  }
  if (typeof attemptId !== "string" || attemptId.length === 0) throw new Error("invalid attempt id");
  if (realpathSync(parentScopeWire) !== parentScopeWire || !/^[0-9a-f]{64}$/.test(parentScopeWire.slice(parentScopeWire.lastIndexOf("/") + 1)) || dirname(scopePath) !== parentScopeWire) {
    throw new Error("attempt scope is not rooted in the backend canonical parent scope");
  }
  const expectedScope = createHash("sha256").update(attemptId).digest("hex");
  if (scopePath !== join(parentScopeWire, expectedScope)) throw new Error("invalid attempt scope identity");
  if (realpathSync(launcherPath) !== launcherPath || !statSync(launcherPath).isFile()) throw new Error("invalid canonical launcher path");
}

function createAttemptScope() {
  mkdirSync(scopePath, { mode: 0o700 });
  if (realpathSync(scopePath) !== scopePath) throw new Error("invalid canonical attempt scope");
  if (!FAKE && Number(statfsSync(scopePath).type) !== 0x63677270) throw new Error("attempt scope is not cgroup-v2");
  if (FAKE) {
    writeFileSync(join(scopePath, "cgroup.procs"), "");
    writeFileSync(join(scopePath, "cgroup.events"), "populated 0\n");
    writeFileSync(join(scopePath, "cgroup.kill"), "");
  }
  requireControlFiles();
  if (readMembers().length !== 0 || readPopulated() !== 0) throw new Error("attempt scope is not empty");
  trace("watchdog:attempt-create");
}

function consumeParent(chunk) {
  if (state !== "await_launch" || finalising !== undefined) return;
  controlBuffer = Buffer.concat([controlBuffer, chunk]);
  if (controlBuffer.length > MAX_CONTROL_LINE_BYTES && !controlBuffer.includes(0x0a)) return void finish("invalid_launch");
  const newline = controlBuffer.indexOf(0x0a);
  if (newline < 0) return;
  const line = controlBuffer.subarray(0, newline);
  const rest = controlBuffer.subarray(newline + 1);
  state = "launch_received";
  if (line.length > MAX_CONTROL_LINE_BYTES || rest.length !== 0) return void finish("invalid_launch");
  let spec;
  try { spec = JSON.parse(line.toString("utf8")); validateSpec(spec); }
  catch (error) { diagnostic(error); void finish("invalid_launch"); return; }
  void launch(spec);
}

async function launch(spec) {
  if (finalising !== undefined) return;
  trace("launcher:spawn");
  try {
    launcher = spawn(process.execPath, [launcherPath], {
      detached: false,
      shell: false,
      env: { ...process.env, PI_LAUNCHER_CONTROL_TARGET: "watchdog-launcher-control" },
      stdio: ["pipe", "pipe", "pipe", 3, 4, 5],
    });
    if (launcher.pid === undefined) throw new Error("launcher pid unavailable");
    launcher.stderr.on("data", (chunk) => process.stderr.write(chunk));
    launcher.once("error", (error) => { diagnostic(error); void finish(authorised ? "spawn_failed" : "no_process"); });
    injectFailure("after-launcher-spawn");
    const records = launcherRecords(launcher.stdout);
    launcher.stdin.write(`${JSON.stringify({ type: "prepare", spec })}\n`);
    const prepared = await records.next();
    if (!exactKeys(prepared, ["pid", "type"]) || prepared.type !== "prepared" || prepared.pid !== launcher.pid) throw new Error("invalid launcher prepared record");
    trace("launcher:prepared");
    writeFileSync(join(scopePath, "cgroup.procs"), `${launcher.pid}\n`);
    if (FAKE) writeFileSync(join(scopePath, "cgroup.events"), "populated 1\n");
    trace("cgroup.procs:write-launcher-pid");
    const members = readMembers();
    trace("cgroup.procs:read-membership");
    if (!members.includes(launcher.pid)) throw new Error("launcher membership verification failed");
    injectFailure("after-membership");
    await pauseAt("after-membership");
    trace("launcher:authorize");
    launcher.stdin.write(`${JSON.stringify({ type: "authorize" })}\n`);
    authorised = true;
    writeParent({ type: "authorised" });
    injectFailure("after-authorisation");
    const spawned = await records.next();
    if (!exactKeys(spawned, ["pid", "type"]) || spawned.type !== "spawned" || !positivePid(spawned.pid)) throw new Error("invalid launcher spawned record");
    piSpawned = true;
    trace("launcher:spawned-pi");
    writeParent({ type: "launched", pid: spawned.pid });
    await pauseAt("after-pi-spawn");
    const exited = await records.next();
    if (!validExit(exited)) throw new Error("invalid launcher exit record");
    writeParent(exited);
    if (!testConfig.blockEmpty) writeFileSync(join(scopePath, "cgroup.events"), "populated 0\n");
    await finish("terminated");
  } catch (error) {
    diagnostic(error);
    await finish(authorised ? "spawn_failed" : "no_process");
  }
}

async function finish(outcome) {
  if (finalising !== undefined) return finalising;
  finalising = (async () => {
    state = "done";
    process.stdin.pause();
    try {
      if (readPopulated() === 1) {
        if (testConfig.killFailure) throw new Error("cgroup kill failed");
        writeFileSync(join(scopePath, "cgroup.kill"), "1\n");
        if (launcher !== undefined && launcher.exitCode === null && launcher.signalCode === null) launcher.kill("SIGKILL");
        if (!testConfig.blockEmpty) writeFileSync(join(scopePath, "cgroup.events"), "populated 0\n");
      }
      await pollEmpty();
      writeReceipt({ version: 2, attemptId, backend: "cgroup-v2", scopePath, outcome, populated: false, timestamp: new Date().toISOString() });
      if (FAKE) {
        for (const name of ["cgroup.procs", "cgroup.events", "cgroup.kill"]) rmSync(join(scopePath, name));
      }
      try { rmdirSync(scopePath); } catch (error) { diagnostic(new Error(`attempt cleanup failed: ${errorText(error)}`)); }
      process.exitCode = 0;
    } catch (error) {
      diagnostic(error);
      process.exitCode = 1;
    }
    process.stdin.destroy();
    if (launcher !== undefined && launcher.exitCode === null && launcher.signalCode === null) launcher.kill("SIGKILL");
  })();
  return finalising;
}

function launcherRecords(stream) {
  let buffer = Buffer.alloc(0);
  const values = [];
  const waiters = [];
  let failed;
  stream.on("data", (chunk) => {
    if (failed !== undefined) return;
    buffer = Buffer.concat([buffer, chunk]);
    if (buffer.length > MAX_CONTROL_LINE_BYTES && !buffer.includes(0x0a)) return rejectAll(new Error("oversized launcher control record"));
    for (;;) {
      const newline = buffer.indexOf(0x0a);
      if (newline < 0) return;
      const line = buffer.subarray(0, newline);
      buffer = buffer.subarray(newline + 1);
      if (line.length > MAX_CONTROL_LINE_BYTES) return rejectAll(new Error("oversized launcher control record"));
      let value;
      try { value = JSON.parse(line.toString("utf8")); } catch { return rejectAll(new Error("malformed launcher control record")); }
      const waiter = waiters.shift();
      if (waiter === undefined) values.push(value); else waiter.resolve(value);
    }
  });
  stream.once("end", () => rejectAll(new Error("launcher control EOF")));
  stream.once("error", rejectAll);
  function rejectAll(error) { failed = error; for (const waiter of waiters.splice(0)) waiter.reject(error); }
  return { next: () => {
    const value = values.shift();
    if (value !== undefined) return Promise.resolve(value);
    if (failed !== undefined) return Promise.reject(failed);
    return new Promise((resolve, reject) => waiters.push({ resolve, reject }));
  } };
}

function validateSpec(value) {
  if (!exactKeys(value, ["args", "command", "cwd", "env", "shell"]) || typeof value.command !== "string" || !isAbsolute(value.command) ||
      !Array.isArray(value.args) || value.args.some((entry) => typeof entry !== "string") || typeof value.cwd !== "string" || !isAbsolute(value.cwd) ||
      value.shell !== false || value.env === null || typeof value.env !== "object" || Array.isArray(value.env) ||
      Object.values(value.env).some((entry) => entry !== undefined && typeof entry !== "string")) throw new Error("invalid launch specification");
}
function requireControlFiles() {
  readFileSync(join(scopePath, "cgroup.procs"), "utf8");
  readFileSync(join(scopePath, "cgroup.events"), "utf8");
  accessSync(join(scopePath, "cgroup.kill"), constants.W_OK);
}
function readMembers() { const text = readFileSync(join(scopePath, "cgroup.procs"), "utf8"); const lines = text.split("\n").filter(Boolean); if (lines.some((line) => !/^[1-9]\d*$/.test(line))) throw new Error("invalid cgroup membership"); return lines.map(Number); }
function readPopulated() { const matches = readFileSync(join(scopePath, "cgroup.events"), "utf8").split("\n").map((line) => /^populated ([01])$/.exec(line)).filter(Boolean); if (matches.length !== 1) throw new Error("invalid cgroup events"); return Number(matches[0][1]); }
async function pollEmpty() { const deadline = Date.now() + CONTAINMENT_TIMEOUT_MS; while (readPopulated() !== 0) { if (Date.now() >= deadline) throw new Error("cgroup empty timeout"); await new Promise((resolve) => setTimeout(resolve, 20)); } }
function validExit(value) { return exactKeys(value, ["code", "signal", "type"]) && value.type === "exit" && (value.code === null || Number.isInteger(value.code) && value.code >= 0 && value.code <= 255) && (value.signal === null || typeof value.signal === "string"); }
function exactKeys(value, keys) { if (value === null || typeof value !== "object" || Array.isArray(value)) return false; const actual = Object.keys(value).sort(); return actual.length === keys.length && actual.every((key, index) => key === keys[index]); }
function positivePid(value) { return Number.isInteger(value) && value > 0; }
function outcomeForPhase() { return piSpawned ? "terminated" : authorised ? "spawn_failed" : "no_process"; }
function writeParent(value) { if (!process.stdout.destroyed) process.stdout.write(`${JSON.stringify(value)}\n`); }
function diagnostic(error) { if (!process.stderr.destroyed) process.stderr.write(`watchdog_error: ${errorText(error)}\n`); }
function errorText(error) { return error instanceof Error ? error.message : String(error); }
function trace(event) { if (typeof testConfig.trace === "string") appendFileSync(testConfig.trace, `${event}\n`); }
function injectFailure(phase) { if (testConfig.failure === phase) throw new Error(`injected ${phase} failure`); }
async function pauseAt(phase) {
  if (testConfig.pauseAt !== phase) return;
  await new Promise(() => {});
}
function writeReceipt(receipt) {
  mkdirSync(dirname(receiptPath), { recursive: true, mode: 0o700 });
  const temporary = `${receiptPath}.${process.pid}.tmp`;
  const fd = openSync(temporary, "wx", 0o600);
  try { writeFileSync(fd, `${JSON.stringify(receipt)}\n`); fsyncSync(fd); } finally { closeSync(fd); }
  renameSync(temporary, receiptPath);
  const directory = openSync(dirname(receiptPath), "r");
  try { fsyncSync(directory); } finally { closeSync(directory); }
}
