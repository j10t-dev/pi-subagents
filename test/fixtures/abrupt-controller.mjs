import { spawn } from "node:child_process";
import { closeSync, existsSync, fsyncSync, openSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

const [watchdogPath, launcherPath, attemptId, receiptPath, scopePath, treePath, pidFile, phase] = process.argv.slice(2);
const pauses = {
  "after-launcher-membership-before-pi-spawn": "after-membership",
  "after-pi-spawn-with-descendants": "after-pi-spawn",
};
writeFileSync(`${receiptPath}.fake-config.json`, JSON.stringify(
  pauses[phase] === undefined ? {} : { pauseAt: pauses[phase] },
));
const watchdog = spawn(process.execPath, [watchdogPath, attemptId, receiptPath, scopePath, dirname(scopePath), launcherPath], {
  detached: true,
  env: process.env,
  stdio: ["pipe", "pipe", "pipe", "pipe", "pipe", "pipe"],
});

let buffer = "";
let descriptor;
if (phase === "before-watchdog-ready") report();
watchdog.stdout.on("data", (chunk) => {
  buffer += chunk.toString("utf8");
  for (;;) {
    const newline = buffer.indexOf("\n");
    if (newline < 0) return;
    const record = JSON.parse(buffer.slice(0, newline));
    buffer = buffer.slice(newline + 1);
    if (record.type === "ready") {
      descriptor = record.descriptor;
      if (phase !== "after-ready-before-launch-persistence") persistDescriptor(descriptor);
      if (phase === "after-ready-before-launch-persistence" || phase === "after-descriptor-before-authorisation") report();
      else watchdog.stdin.write(`${JSON.stringify({ command: process.execPath, args: [treePath, pidFile], cwd: process.cwd(), env: process.env, shell: false })}\n`);
    }
    if (record.type === "launched" && phase === "after-pi-spawn-with-descendants") {
      waitForProcessTree().then(() => report(undefined, record.pid));
    }
  }
});

if (phase === "after-launcher-membership-before-pi-spawn") {
  waitForLauncher().then((launcherPid) => report(launcherPid));
}

function waitForLauncher() {
  return new Promise((resolve) => {
    const poll = () => {
      if (existsSync(`${scopePath}/cgroup.procs`)) {
        const pid = Number(readFileSync(`${scopePath}/cgroup.procs`, "utf8").trim());
        if (Number.isInteger(pid) && pid > 0) return resolve(pid);
      }
      setTimeout(poll, 5);
    };
    poll();
  });
}

function report(launcherPid = launcherPidInScope(), piPid = null) {
  process.stdout.write(`${JSON.stringify({ phase, controllerPid: process.pid, watchdogPid: watchdog.pid, launcherPid, piPid, ...(descriptor === undefined ? {} : { descriptor }) })}\n`);
}
function launcherPidInScope() {
  try {
    const child = readFileSync(`/proc/${watchdog.pid}/task/${watchdog.pid}/children`, "utf8")
      .trim().split(/\s+/).map(Number).find((pid) => Number.isInteger(pid) && pid > 0);
    if (child !== undefined) return child;
  } catch { /* fall back to fake cgroup membership */ }
  if (!existsSync(`${scopePath}/cgroup.procs`)) return null;
  const pid = Number(readFileSync(`${scopePath}/cgroup.procs`, "utf8").trim());
  return Number.isInteger(pid) && pid > 0 ? pid : null;
}

function persistDescriptor(value) {
  const destination = `${receiptPath}.descriptor.json`;
  const temporary = `${destination}.${process.pid}.tmp`;
  const file = openSync(temporary, "wx", 0o600);
  try { writeFileSync(file, `${JSON.stringify(value)}\n`); fsyncSync(file); } finally { closeSync(file); }
  renameSync(temporary, destination);
  const directory = openSync(dirname(destination), "r");
  try { fsyncSync(directory); } finally { closeSync(directory); }
}

function waitForProcessTree() {
  return new Promise((resolve, reject) => {
    const deadline = Date.now() + 10_000;
    const poll = () => {
      if (existsSync(pidFile) && readFileSync(pidFile, "utf8").trim().split("\n").filter(Boolean).length >= 3) return resolve();
      if (Date.now() >= deadline) return reject(new Error("process tree did not become ready"));
      setTimeout(poll, 5);
    };
    poll();
  });
}

setInterval(() => {}, 1_000);
