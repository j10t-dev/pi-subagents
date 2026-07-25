import { spawn } from "node:child_process";

const MAX_CONTROL_LINE_BYTES = 256 * 1024;
const GRACEFUL_SHUTDOWN_MS = 1_000;
let state = "await_prepare";
let buffer = Buffer.alloc(0);
let spec;
let child;
let finalising = false;

process.stdin.on("data", consume);
process.stdin.once("end", () => void shutdown(state === "running" ? 0 : 1));
process.stdin.once("error", fail);
process.stdout.once("error", fail);
process.stderr.once("error", fail);
process.on("SIGTERM", () => void shutdown(state === "running" ? 0 : 1));

function consume(chunk) {
  if (finalising) return;
  buffer = Buffer.concat([buffer, chunk]);
  if (buffer.length > MAX_CONTROL_LINE_BYTES && !buffer.includes(0x0a)) return fail(new Error("oversized control record"));
  for (;;) {
    const newline = buffer.indexOf(0x0a);
    if (newline < 0) return;
    const line = buffer.subarray(0, newline);
    buffer = buffer.subarray(newline + 1);
    if (line.length > MAX_CONTROL_LINE_BYTES) return fail(new Error("oversized control record"));
    let value;
    try { value = JSON.parse(line.toString("utf8")); }
    catch { return fail(new Error("malformed control record")); }
    accept(value);
    if (finalising) return;
  }
}

function accept(value) {
  if (state === "await_prepare" && validPrepare(value)) {
    spec = value.spec;
    state = "await_authorize";
    write({ type: "prepared", pid: process.pid });
    return;
  }
  if (state === "await_authorize" && exactKeys(value, ["type"]) && value.type === "authorize") {
    authorise();
    return;
  }
  fail(new Error("invalid control state"));
}

function authorise() {
  state = "running";
  try {
    child = spawn(spec.command, spec.args, {
      cwd: spec.cwd,
      env: spec.env,
      shell: false,
      detached: false,
      stdio: [3, 4, 5],
    });
  } catch (error) { fail(error); return; }
  child.once("spawn", () => write({ type: "spawned", pid: child.pid }));
  child.once("error", fail);
  child.once("exit", (code, signal) => {
    write({ type: "exit", code, signal });
    state = "done";
    void shutdown(0);
  });
}

function validPrepare(value) {
  if (!exactKeys(value, ["spec", "type"]) || value.type !== "prepare") return false;
  const launch = value.spec;
  return exactKeys(launch, ["args", "command", "cwd", "env", "shell"]) &&
    typeof launch.command === "string" && launch.command.startsWith("/") &&
    Array.isArray(launch.args) && launch.args.every((entry) => typeof entry === "string") &&
    typeof launch.cwd === "string" && launch.cwd.startsWith("/") &&
    launch.shell === false && launch.env !== null && typeof launch.env === "object" && !Array.isArray(launch.env) &&
    Object.values(launch.env).every((entry) => entry === undefined || typeof entry === "string");
}

function exactKeys(value, keys) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const actual = Object.keys(value).sort();
  return actual.length === keys.length && actual.every((key, index) => key === keys[index]);
}

function write(value) {
  if (!process.stdout.destroyed) process.stdout.write(`${JSON.stringify(value)}\n`);
}

function fail(error) {
  if (!finalising) process.stderr.write(`launcher_error: ${error instanceof Error ? error.message : String(error)}\n`);
  void shutdown(1);
}

async function shutdown(code) {
  if (finalising) return;
  finalising = true;
  process.stdin.pause();
  if (child !== undefined && child.exitCode === null && child.signalCode === null) {
    child.kill("SIGTERM");
    await Promise.race([
      new Promise((resolve) => child.once("exit", resolve)),
      new Promise((resolve) => setTimeout(resolve, GRACEFUL_SHUTDOWN_MS)),
    ]);
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
  }
  process.exit(code);
}
