import { describe, expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { resolveCgroupV2Backend, type CgroupFileSystem } from "../src/cgroup-v2.ts";
import type { AbsolutePath, ContainmentReceiptPath, RunAttemptId } from "../src/domain.ts";
import { createRunAttemptId } from "../src/domain.ts";
import { verifyContainmentReceipt } from "../src/watchdog-client.ts";
import { temporaryStateRoot } from "./support/temp-state.ts";

const NODE = Bun.which("node") ?? (() => { throw new Error("production abrupt-controller test requires Node on PATH"); })();

const phases: string[] = [
  "before-watchdog-ready",
  "after-ready-before-launch-persistence",
  "after-descriptor-before-authorisation",
  "after-launcher-membership-before-pi-spawn",
  "after-pi-spawn-with-descendants",
];

describe("abrupt controller restoration matrix", () => {
  test("production backend contains every survivor after only the watchdog is killed", async () => {
    const state = temporaryStateRoot("abrupt-controller-production-");
    const directory: string = state.path;
    const attemptId = createRunAttemptId();
    const parentSessionId = `abrupt-production-${process.pid}-${Date.now()}`;
    const receipt = join(directory, "receipt.json") as ContainmentReceiptPath;
    const treePath = join(directory, "tree.jsonl");
    const persistedDescriptorPath = `${receipt}.descriptor.json`;
    const backend = resolveCgroupV2Backend({
      parentSessionId,
      ...(process.env.PI_SUBAGENTS_CGROUP_ROOT === undefined ? {} : { configuredRoot: process.env.PI_SUBAGENTS_CGROUP_ROOT }),
      receiptPathFor: () => receipt,
    });
    const scope = join(backend.parentScope, createHash("sha256").update(attemptId).digest("hex")) as AbsolutePath;
    let child: ReturnType<typeof spawn> | undefined;
    let report: AbruptReport | undefined;
    let survivorPids: number[] = [];
    let survivorsStopped = false;
    try {
      await backend.preflight();
      child = spawn(NODE, [
        join(import.meta.dir, "fixtures/abrupt-controller.mjs"),
        join(import.meta.dir, "../watchdog.mjs"),
        join(import.meta.dir, "../launcher.mjs"),
        attemptId,
        receipt,
        scope,
        join(import.meta.dir, "fixtures/process-tree.mjs"),
        treePath,
        "after-pi-spawn-with-descendants",
      ], { stdio: "pipe" });
      if (child.stdout === null) throw new Error("production abrupt-controller fixture stdout unavailable");
      report = await nextJson(child.stdout);
      expect(existsSync(persistedDescriptorPath)).toBeTrue();
      expect(report.descriptor).toEqual({ backend: "cgroup-v2", scopePath: scope });
      expect(typeof report.launcherPid).toBe("number");
      expect(typeof report.piPid).toBe("number");
      const treePids = await waitForTreePids(treePath);
      survivorPids = [report.launcherPid!, report.piPid!, ...treePids];
      expect(survivorPids.filter(processAbsent)).toEqual([]);
      stopProcesses(survivorPids);
      survivorsStopped = true;
      await waitForProcessesStopped(survivorPids);

      process.kill(report.watchdogPid, "SIGKILL");
      await waitForProcessAbsent(report.watchdogPid);

      expect(strictPopulated(scope)).toBe(1);
      expect(survivorPids.filter(processAbsent)).toEqual([]);

      const descriptor = report.descriptor!;
      const restored = backend.restoreAttempt(attemptId, descriptor);
      const proof = await restored.terminate("terminated");
      const verified = verifyContainmentReceipt(receipt, attemptId, undefined, descriptor);
      expect(verified).toEqual({ version: 2, path: proof, descriptor, populated: false });
      const receiptValue = JSON.parse(readFileSync(receipt, "utf8")) as Record<string, unknown>;
      expect(receiptValue).toEqual({
        version: 2,
        attemptId,
        backend: "cgroup-v2",
        scopePath: descriptor.scopePath,
        outcome: "terminated",
        populated: false,
        timestamp: expect.any(String),
      });
      expect(existsSync(scope)).toBeFalse();
      expect(survivorPids.every(processAbsent)).toBeTrue();
      await restored.cleanup(proof);
      await backend.shutdown();
    } finally {
      if (survivorsStopped) continueProcesses(survivorPids);
      if (report?.descriptor !== undefined && existsSync(report.descriptor.scopePath)) {
        await backend.restoreAttempt(attemptId, report.descriptor).terminate("terminated").catch(() => undefined);
      }
      killProcesses(survivorPids);
      child?.kill("SIGKILL");
      if (report !== undefined) {
        try { process.kill(report.watchdogPid, "SIGKILL"); } catch { /* process already exited */ }
      }
      await backend.shutdown().catch(() => undefined);
      state.cleanup();
    }
  }, 30_000);

  test.each(phases)("reports watchdog, launcher, and Pi identity for %s", async (phase) => {
    const state = temporaryStateRoot("abrupt-controller-");
    const directory: string = state.path;
    const attemptId = createRunAttemptId();
    const parentSessionId = "abrupt-parent";
    const root = join(directory, "root");
    const parent = join(root, createHash("sha256").update(parentSessionId).digest("hex"));
    const scope = join(parent, createHash("sha256").update(attemptId).digest("hex")) as AbsolutePath;
    const receipt = join(directory, "receipt.json") as ContainmentReceiptPath;
    mkdirSync(parent, { recursive: true, mode: 0o700 });
    let watchdogPid: number | undefined;
    const child = spawn(process.execPath, [
      join(import.meta.dir, "fixtures/abrupt-controller.mjs"),
      join(import.meta.dir, "fixtures/fake-watchdog.mjs"),
      join(import.meta.dir, "../launcher.mjs"),
      attemptId,
      receipt,
      scope,
      join(import.meta.dir, "fixtures/process-tree.mjs"),
      join(directory, "tree.jsonl"),
      phase,
    ], { stdio: "pipe" });
    try {
      const report = await nextJson(child.stdout);
      watchdogPid = report.watchdogPid;
      expect(report).toMatchObject({ phase, watchdogPid: expect.any(Number) });
      child.kill("SIGKILL");
      if (phase === "after-descriptor-before-authorisation" || phase === "after-launcher-membership-before-pi-spawn" ||
          phase === "after-pi-spawn-with-descendants") {
        process.kill(-watchdogPid, "SIGKILL");
      }
      await Bun.sleep(20);
      if (phase === "before-watchdog-ready") expect(report.descriptor).toBeUndefined();
      else {
        const descriptor = report.descriptor;
        if (descriptor === undefined) throw new Error("post-descriptor phase omitted descriptor");
        expect(descriptor).toEqual({ backend: "cgroup-v2", scopePath: scope });
        if (phase === "after-launcher-membership-before-pi-spawn" || phase === "after-pi-spawn-with-descendants") {
          expect(report.launcherPid).toEqual(expect.any(Number));
        }
        if (phase === "after-pi-spawn-with-descendants") expect(report.piPid).toEqual(expect.any(Number));

        const fs = new RestorationFs([dirname(root), root, parent, scope]);
        const backend = resolveCgroupV2Backend({
          parentSessionId,
          mountPath: dirname(root),
          configuredRoot: root,
          fs,
          receiptPathFor: () => receipt,
        });
        const restored = backend.restoreAttempt(attemptId, descriptor);
        const proof = await restored.terminate("terminated");
        expect(verifyContainmentReceipt(receipt, attemptId, undefined, descriptor)).toMatchObject({ version: 2, populated: false });
        await restored.cleanup(proof);
      }
    } finally {
      child.kill("SIGKILL");
      if (watchdogPid !== undefined) {
        try { process.kill(-watchdogPid, "SIGKILL"); } catch { /* process already exited */ }
      }
      state.cleanup();
    }
  }, 15_000);
});

interface AbruptReport {
  readonly phase: string;
  readonly controllerPid: number;
  readonly watchdogPid: number;
  readonly launcherPid: number | null;
  readonly piPid: number | null;
  readonly descriptor?: { readonly backend: "cgroup-v2"; readonly scopePath: AbsolutePath };
}

function nextJson(stream: NodeJS.ReadableStream): Promise<AbruptReport> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const settle = (callback: () => void) => { if (!settled) { settled = true; callback(); } };
    let text = "";
    stream.on("data", (chunk: Buffer) => {
      text += chunk.toString("utf8");
      const newline = text.indexOf("\n");
      if (newline < 0) return;
      settle(() => {
        try {
          const value: unknown = JSON.parse(text.slice(0, newline));
          if (!isAbruptReport(value)) throw new Error("invalid abrupt fixture report");
          resolve(value);
        } catch (error) { reject(error); }
      });
    });
    stream.once("error", (error) => settle(() => reject(error)));
    stream.once("end", () => settle(() => reject(new Error("abrupt fixture exited before reporting"))));
  });
}

async function waitForTreePids(path: string): Promise<number[]> {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    if (existsSync(path)) {
      const records = readFileSync(path, "utf8").trim().split("\n").filter(Boolean)
        .map((line) => JSON.parse(line) as { pid: number });
      if (records.length >= 3) return records.map(({ pid }) => pid);
    }
    await Bun.sleep(20);
  }
  throw new Error("production process tree did not report every descendant");
}

function stopProcesses(pids: readonly number[]): void {
  for (const pid of new Set(pids)) process.kill(pid, "SIGSTOP");
}

function continueProcesses(pids: readonly number[]): void {
  for (const pid of new Set(pids)) {
    try { process.kill(pid, "SIGCONT"); } catch { /* process already exited */ }
  }
}

function killProcesses(pids: readonly number[]): void {
  for (const pid of new Set(pids)) {
    try { process.kill(pid, "SIGKILL"); } catch { /* process already exited */ }
  }
}

async function waitForProcessesStopped(pids: readonly number[]): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    if (pids.every(processStopped)) return;
    await Bun.sleep(20);
  }
  throw new Error("contained survivors did not stop");
}

async function waitForProcessAbsent(pid: number): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    if (processAbsent(pid)) return;
    await Bun.sleep(20);
  }
  throw new Error(`process ${pid} remained present`);
}

function strictPopulated(scope: AbsolutePath): 0 | 1 {
  const values = readFileSync(join(scope, "cgroup.events"), "utf8").trim().split("\n")
    .map((line) => /^([^\s]+) ([01])$/.exec(line));
  const populated = values.filter((value) => value?.[1] === "populated");
  if (values.some((value) => value === null) || populated.length !== 1) {
    throw new Error("invalid cgroup.events populated state");
  }
  return populated[0]![2] === "1" ? 1 : 0;
}

function processPresent(pid: number): boolean {
  try { process.kill(pid, 0); return true; }
  catch { return false; }
}

function processAbsent(pid: number): boolean {
  return !processPresent(pid);
}

function processStopped(pid: number): boolean {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    return stat.at(stat.lastIndexOf(")") + 2) === "T";
  } catch {
    return false;
  }
}

function isAbruptReport(value: unknown): value is AbruptReport {
  if (typeof value !== "object" || value === null) return false;
  const report = value as Record<string, unknown>;
  const validPid = (pid: unknown): pid is number => Number.isInteger(pid) && (pid as number) > 0;
  if (typeof report.phase !== "string" || !validPid(report.controllerPid) || !validPid(report.watchdogPid) ||
      (report.launcherPid !== null && !validPid(report.launcherPid)) || (report.piPid !== null && !validPid(report.piPid))) return false;
  if (report.descriptor === undefined) return true;
  if (typeof report.descriptor !== "object" || report.descriptor === null) return false;
  const descriptor = report.descriptor as Record<string, unknown>;
  return descriptor.backend === "cgroup-v2" && typeof descriptor.scopePath === "string" && descriptor.scopePath.startsWith("/");
}

class RestorationFs implements CgroupFileSystem {
  readonly directories = new Set<string>();
  readonly files = new Map<string, string>();
  constructor(paths: readonly string[]) { paths.forEach((path) => this.add(path)); }
  readFile(path: string): string { return this.files.get(path) ?? ""; }
  writeFile(path: string, value: string): void {
    this.files.set(path, value);
    if (path.endsWith("/cgroup.kill")) this.files.set(path.replace("cgroup.kill", "cgroup.events"), "populated 0\n");
  }
  mkdir(path: string): void { this.add(path); }
  realpath(path: string): string {
    if (!this.directories.has(path)) throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
    return path;
  }
  stat(path: string): { isDirectory(): boolean; mode: number } {
    if (!this.directories.has(path)) throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
    return { isDirectory: () => true, mode: 0o700 };
  }
  removeDirectory(path: string): void { this.directories.delete(path); }
  list(): readonly string[] { return []; }
  private add(path: string): void {
    this.directories.add(path);
    this.files.set(`${path}/cgroup.events`, "populated 0\n");
    this.files.set(`${path}/cgroup.procs`, "");
  }
}
