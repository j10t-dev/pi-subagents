import { describe, expect, test } from "bun:test";
import { accessSync, existsSync, mkdirSync, readFileSync, realpathSync } from "node:fs";
import { constants } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { resolveCgroupV2Backend } from "../src/cgroup-v2.ts";
import { createRunAttemptId } from "../src/domain.ts";
import { testAbsolutePath } from "./support/brands.ts";
import { isContainedPath } from "../src/paths.ts";
import { containmentReceiptPath } from "../src/paths.ts";
import { WatchdogClient, verifyContainmentReceipt } from "../src/watchdog-client.ts";
import { temporaryStateRoot } from "./support/temp-state.ts";

const SETSID = resolveSetsid();

describe("production cgroup-v2 process containment", () => {
  test("kills a setsid descendant outside the launcher process group", async () => {
    const stateRoot = temporaryStateRoot("pi-cgroup-process-");
    const state: string = stateRoot.path;
    const pidPath = join(state, "pids.json");
    const backend = resolveCgroupV2Backend({
      parentSessionId: `setsid-process-${process.pid}-${Date.now()}`,
      ...(process.env.PI_SUBAGENTS_CGROUP_ROOT === undefined ? {} : { configuredRoot: process.env.PI_SUBAGENTS_CGROUP_ROOT }),
      receiptPathFor: (attemptId) => containmentReceiptPath(state, `${attemptId}.json`),
    });
    const attemptId = createRunAttemptId();
    let client: WatchdogClient | undefined;
    try {
      await backend.preflight();
      const attempt = backend.prepareAttempt(attemptId);
      client = new WatchdogClient({ attemptId, receiptPath: containmentReceiptPath(state, `${attemptId}.json`), attempt });
      await client.ready();
      const nestedRoot = join(attempt.descriptor.scopePath, "pi-subagents");
      const nestedParent = join(nestedRoot, "nested-parent");
      mkdirSync(nestedRoot, { mode: 0o700 });
      mkdirSync(nestedParent, { mode: 0o700 });
      await client.launch({
        command: testAbsolutePath(process.execPath),
        args: [join(import.meta.dir, "fixtures/setsid-descendant.mjs"), pidPath, SETSID],
        cwd: testAbsolutePath(state),
        env: process.env,
        shell: false,
      });
      const pids = await waitForPids(pidPath);
      expect(processGroup(pids.detached)).not.toBe(processGroup(pids.launcher));
      expect(pids.cgroups.detached).toContain(cgroupMembershipPath(attempt.descriptor.scopePath));

      await client.close();
      const receiptPath = containmentReceiptPath(state, `${attemptId}.json`);
      verifyContainmentReceipt(receiptPath, attemptId, undefined, attempt.descriptor);
      const receipt = JSON.parse(readFileSync(receiptPath, "utf8"));
      expect(processAbsent(pids.detached)).toBeTrue();
      expect(Object.keys(receipt).sort()).toEqual([
        "attemptId", "backend", "outcome", "populated", "scopePath", "timestamp", "version",
      ]);
      expect(receipt).toMatchObject({
        version: 2,
        backend: "cgroup-v2",
        scopePath: attempt.descriptor.scopePath,
        populated: false,
      });
      expect(existsSync(nestedParent)).toBeFalse();
      expect(existsSync(nestedRoot)).toBeFalse();
      expect(existsSync(attempt.descriptor.scopePath)).toBeFalse();
    } finally {
      await client?.close().catch(() => undefined);
      await backend.shutdown().catch(() => undefined);
      stateRoot.cleanup();
    }
  }, 30_000);

  test("configured-root descendants remain nested beneath the ancestor attempt", async () => {
    const stateRoot = temporaryStateRoot("pi-cgroup-nested-");
    const state: string = stateRoot.path;
    const readyPath = join(state, "nested-ready.json");
    const bootstrap = resolveCgroupV2Backend({
      parentSessionId: `nested-bootstrap-${process.pid}-${Date.now()}`,
      receiptPathFor: (attemptId) => containmentReceiptPath(state, `bootstrap-${attemptId}.json`),
    });
    let ancestor: ReturnType<typeof resolveCgroupV2Backend> | undefined;
    let ancestorClient: WatchdogClient | undefined;
    try {
      await bootstrap.preflight();
      ancestor = resolveCgroupV2Backend({
        parentSessionId: `nested-ancestor-${process.pid}-${Date.now()}`,
        configuredRoot: bootstrap.root,
        receiptPathFor: (attemptId) => containmentReceiptPath(state, `ancestor-${attemptId}.json`),
      });
      await ancestor.preflight();
      const attemptId = createRunAttemptId();
      const ancestorAttempt = ancestor.prepareAttempt(attemptId);
      ancestorClient = new WatchdogClient({
        attemptId,
        receiptPath: containmentReceiptPath(state, `ancestor-${attemptId}.json`),
        attempt: ancestorAttempt,
      });
      await ancestorClient.ready();
      await ancestorClient.launch({
        command: testAbsolutePath(process.execPath),
        args: [fileURLToPath(new URL("fixtures/nested-cgroup-controller.ts", import.meta.url)), state, readyPath],
        cwd: testAbsolutePath(state),
        env: process.env,
        shell: false,
      });
      const ready = await waitForNestedReady(readyPath);
      expect(isContainedPath(ancestorAttempt.descriptor.scopePath, ready.nestedRoot)).toBeTrue();
      expect(isContainedPath(ancestorAttempt.descriptor.scopePath, ready.nestedScope)).toBeTrue();
      expect(ready.grandchildPids).not.toHaveLength(0);

      await ancestorClient.close();
      await waitForProcessesAbsent([ready.controllerPid, ...ready.grandchildPids]);
      expect(cgroupReportsRunning(ancestorAttempt.descriptor.scopePath)).toBeFalse();
      expect(cgroupReportsRunning(ready.nestedScope)).toBeFalse();
      expect(cgroupReportsRunning(ready.nestedRoot)).toBeFalse();
    } finally {
      await ancestorClient?.close().catch(() => undefined);
      await ancestor?.shutdown().catch(() => undefined);
      await bootstrap.shutdown().catch(() => undefined);
      stateRoot.cleanup();
    }
  }, 30_000);
});

function resolveSetsid(): string {
  for (const directory of (process.env.PATH ?? "").split(":")) {
    const candidate = join(directory || ".", "setsid");
    try {
      accessSync(candidate, constants.X_OK);
      const resolved = realpathSync(candidate);
      if (resolved.startsWith("/")) return resolved;
    } catch { /* continue searching PATH */ }
  }
  throw new Error("cgroup process prerequisite missing: system setsid executable was not found on PATH");
}

async function waitForPids(path: string): Promise<{ launcher: number; child: number; detached: number; cgroups: { launcher: string; child: string; detached: string } }> {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    if (existsSync(path)) return JSON.parse(readFileSync(path, "utf8")) as Awaited<ReturnType<typeof waitForPids>>;
    await Bun.sleep(20);
  }
  throw new Error("setsid descendant fixture did not record PIDs");
}

function cgroupMembershipPath(scope: string): string {
  return scope.startsWith("/sys/fs/cgroup/") ? scope.slice("/sys/fs/cgroup".length) : scope;
}

function processGroup(pid: number): number {
  const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
  const tail = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
  return Number(tail[2]);
}

interface NestedCgroupReady {
  readonly controllerPid: number;
  readonly nestedRoot: string;
  readonly nestedScope: string;
  readonly grandchildPids: readonly number[];
}

async function waitForNestedReady(path: string): Promise<NestedCgroupReady> {
  const errorPath = `${path}.error`;
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    if (existsSync(errorPath)) throw new Error(readFileSync(errorPath, "utf8"));
    if (existsSync(path)) return JSON.parse(readFileSync(path, "utf8")) as NestedCgroupReady;
    await Bun.sleep(20);
  }
  throw new Error("nested cgroup fixture did not publish readiness");
}

async function waitForProcessesAbsent(pids: readonly number[]): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    if (pids.every(processAbsent)) return;
    await Bun.sleep(20);
  }
  throw new Error(`nested cgroup fixture processes remain: ${pids.filter((pid) => !processAbsent(pid)).join(",")}`);
}

function cgroupReportsRunning(path: string): boolean {
  try { return /(?:^|\n)populated 1(?:\n|$)/u.test(readFileSync(join(path, "cgroup.events"), "utf8")); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

function processAbsent(pid: number): boolean {
  try { process.kill(pid, 0); return false; }
  catch (error) { return (error as NodeJS.ErrnoException).code === "ESRCH"; }
}
