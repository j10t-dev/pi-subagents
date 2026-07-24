import { describe, expect, test } from "bun:test";
import { spawn, type ChildProcess } from "node:child_process";
import {
  accessSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmdirSync,
  writeFileSync,
} from "node:fs";
import { constants } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { resolveCgroupV2Backend } from "../src/cgroup-v2.ts";
import { agentId, createRunAttemptId, type AgentId } from "../src/domain.ts";
import { testAbsolutePath } from "./support/brands.ts";
import { isContainedPath } from "../src/paths.ts";
import { containmentReceiptPath } from "../src/paths.ts";
import { WatchdogClient, verifyContainmentReceipt } from "../src/watchdog-client.ts";
import { temporaryStateRoot } from "./support/temp-state.ts";

const SETSID = resolveSetsid();

describe("race fixture failure cleanup", () => {
  test("preserves a rejected fixture reason when diagnostics are empty", () => {
    const spawnError = new Error("fixture spawn failed");

    const error = raceFixtureCleanupError([
      { status: "rejected", reason: spawnError },
    ], "");

    expect(error).toBeInstanceOf(AggregateError);
    expect(error?.errors).toEqual([spawnError]);
  });

  test("includes bounded fixture diagnostics without replacing rejection reasons", () => {
    const lifecycleError = new Error("fixture closed without exit");

    const error = raceFixtureCleanupError([
      { status: "rejected", reason: lifecycleError },
    ], `prefix-${"x".repeat(5_000)}`);

    expect(error?.errors[0]).toBe(lifecycleError);
    expect(error?.errors[1]).toBeInstanceOf(Error);
    expect((error?.errors[1] as Error).message).toStartWith("race fixture diagnostics:\n");
    expect((error?.errors[1] as Error).message).not.toContain("prefix-");
    expect((error?.errors[1] as Error).message.length).toBeLessThan(4_200);
  });
});

describe("production cgroup-v2 process containment", () => {
  test("kills a setsid descendant outside the launcher process group", async () => {
    const stateRoot = temporaryStateRoot("pi-cgroup-process-");
    const state: string = stateRoot.path;
    const pidPath = join(state, "pids.json");
    const backend = resolveCgroupV2Backend({
      parentSessionId: agentId(`setsid-process-${process.pid}-${Date.now()}`),
      ...(process.env.PI_SUBAGENTS_CGROUP_ROOT === undefined ? {} : { configuredRoot: process.env.PI_SUBAGENTS_CGROUP_ROOT }),
      receiptPathFor: (attemptId) => containmentReceiptPath(state, `${attemptId}.json`),
    });
    const attemptId = createRunAttemptId();
    let client: WatchdogClient | undefined;
    try {
      await backend.preflight();
      const attempt = backend.prepareAttempt(attemptId);
      client = new WatchdogClient({ attemptId, receiptPath: containmentReceiptPath(state, `${attemptId}.json`), attempt });
      const descriptor = await client.ready();
      const nestedRoot = join(descriptor.scopePath, "pi-subagents");
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
      expect(pids.cgroups.detached).toContain(cgroupMembershipPath(descriptor.scopePath));

      await client.close();
      const receiptPath = containmentReceiptPath(state, `${attemptId}.json`);
      verifyContainmentReceipt(receiptPath, attemptId, undefined, descriptor);
      const receipt = JSON.parse(readFileSync(receiptPath, "utf8"));
      expect(processAbsent(pids.detached)).toBeTrue();
      expect(Object.keys(receipt).sort()).toEqual([
        "attemptId", "backend", "outcome", "populated", "scopePath", "timestamp", "version",
      ]);
      expect(receipt).toMatchObject({
        version: 2,
        backend: "cgroup-v2",
        scopePath: descriptor.scopePath,
        populated: false,
      });
      expect(existsSync(nestedParent)).toBeFalse();
      expect(existsSync(nestedRoot)).toBeFalse();
      expect(existsSync(descriptor.scopePath)).toBeFalse();
    } finally {
      await client?.close().catch(() => undefined);
      await backend.shutdown().catch(() => undefined);
      stateRoot.cleanup();
    }
  }, 30_000);

  test("adopts exactly one concurrent production default-root creation", async () => {
    const membership = `${currentUnifiedPath().replace(/\/$/, "")}/${raceScratchName()}`;
    if (membership.split("/").includes("..")) throw new Error(`unsafe cgroup membership: ${membership}`);
    const scratch = join("/sys/fs/cgroup", membership);
    const barrierRoot = temporaryStateRoot("pi-cgroup-root-race-");
    const barrier = barrierRoot.path;
    const arrivalA = join(barrier, "a.arrived");
    const arrivalB = join(barrier, "b.arrived");
    const releasePath = join(barrier, "release");
    let first: RaceFixture | undefined;
    let second: RaceFixture | undefined;
    try {
      mkdirSync(scratch, { mode: 0o700 });
      first = spawnRaceFixture(membership, scratch, "a", barrier, agentId(`race-parent-a-${process.pid}-${Date.now()}`));
      second = spawnRaceFixture(membership, scratch, "b", barrier, agentId(`race-parent-b-${process.pid}-${Date.now()}`));
      await waitForFiles([arrivalA, arrivalB], 10_000);
      writeFileSync(releasePath, "release", { flag: "wx" });

      const results = await Promise.all([first.result, second.result]);
      expect(results.map((result) => result.mkdirOutcome).sort()).toEqual(["EEXIST", "created"]);
      expect(new Set(results.map((result) => result.parentScope)).size).toBe(2);
      expect(results.every((result) => result.root === join(scratch, "pi-subagents"))).toBeTrue();
      expect(existsSync(join(scratch, "pi-subagents"))).toBeTrue();
      trimEmptyCgroupTree(scratch);
      expect(existsSync(scratch)).toBeFalse();
    } finally {
      if (!existsSync(releasePath)) {
        try { writeFileSync(releasePath, "release", { flag: "wx" }); } catch { /* another cleaner released it */ }
      }
      for (const fixture of [first, second]) fixture?.child.kill();
      const settlements = await Promise.allSettled([first?.result, second?.result].filter(isDefined));
      const diagnostics = [first, second].filter(isDefined).map((fixture) => fixture.diagnostic()).join("\n");
      const fixtureError = raceFixtureCleanupError(settlements, diagnostics);
      trimEmptyCgroupTreeBestEffort(scratch);
      barrierRoot.cleanup();
      if (fixtureError !== undefined) throw fixtureError;
    }
  }, 30_000);

  test("waits for a successful fixture stdout pipe to close before parsing", async () => {
    const stateRoot = temporaryStateRoot("pi-cgroup-delayed-stdout-");
    const fixture = join(stateRoot.path, "delayed-stdout.cjs");
    writeFileSync(fixture, [
      'const { spawn } = require("node:child_process");',
      'spawn(process.execPath, ["-e", `setTimeout(() => process.stdout.write(JSON.stringify({ id: "a", root: "/root", parentScope: "/scope", mkdirOutcome: "created" }) + "\\\\n"), 50)`], { stdio: ["ignore", "inherit", "inherit"] }).unref();',
    ].join("\n"));
    try {
      const race = spawnRaceFixture("/", "/unused", "a", stateRoot.path, agentId("delayed-stdout"), fixture);
      const result = await race.result.catch((error: unknown) => {
        throw new Error(`delayed stdout fixture failed: ${error instanceof Error ? error.message : String(error)}; ${race.diagnostic()}`);
      });
      expect(result).toEqual({
        id: "a", root: "/root", parentScope: "/scope", mkdirOutcome: "created",
      });
    } finally {
      stateRoot.cleanup();
    }
  });

  test("configured-root descendants remain nested beneath the ancestor attempt", async () => {
    const stateRoot = temporaryStateRoot("pi-cgroup-nested-");
    const state: string = stateRoot.path;
    const readyPath = join(state, "nested-ready.json");
    const bootstrap = resolveCgroupV2Backend({
      parentSessionId: agentId(`nested-bootstrap-${process.pid}-${Date.now()}`),
      receiptPathFor: (attemptId) => containmentReceiptPath(state, `bootstrap-${attemptId}.json`),
    });
    let ancestor: ReturnType<typeof resolveCgroupV2Backend> | undefined;
    let ancestorClient: WatchdogClient | undefined;
    try {
      await bootstrap.preflight();
      ancestor = resolveCgroupV2Backend({
        parentSessionId: agentId(`nested-ancestor-${process.pid}-${Date.now()}`),
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
      const ancestorDescriptor = await ancestorClient.ready();
      await ancestorClient.launch({
        command: testAbsolutePath(process.execPath),
        args: [fileURLToPath(new URL("fixtures/nested-cgroup-controller.ts", import.meta.url)), state, readyPath],
        cwd: testAbsolutePath(state),
        env: process.env,
        shell: false,
      });
      const ready = await waitForNestedReady(readyPath);
      expect(isContainedPath(ancestorDescriptor.scopePath, ready.nestedRoot)).toBeTrue();
      expect(isContainedPath(ancestorDescriptor.scopePath, ready.nestedScope)).toBeTrue();
      expect(ready.grandchildPids).not.toHaveLength(0);

      await ancestorClient.close();
      await waitForProcessesAbsent([ready.controllerPid, ...ready.grandchildPids]);
      expect(cgroupReportsRunning(ancestorDescriptor.scopePath)).toBeFalse();
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

interface RaceFixtureResult {
  readonly id: "a" | "b";
  readonly root: string;
  readonly parentScope: string;
  readonly mkdirOutcome: "created" | "EEXIST";
}

interface RaceFixture {
  readonly child: ChildProcess;
  readonly result: Promise<RaceFixtureResult>;
  diagnostic(): string;
}

function currentUnifiedPath(): string {
  const text = readFileSync("/proc/self/cgroup", "utf8").trim();
  const match = /^0::(\/(?:[^/\n]+(?:\/[^/\n]+)*)?)$/.exec(text);
  if (match?.[1] === undefined) throw new Error(`unexpected unified cgroup: ${text}`);
  if (match[1].split("/").includes("..")) throw new Error(`unsafe unified cgroup: ${match[1]}`);
  return match[1];
}

function raceScratchName(): string {
  return `pi-subagents-race-${process.pid}-${Date.now()}`;
}

function spawnRaceFixture(
  membership: string,
  scratch: string,
  id: "a" | "b",
  barrier: string,
  parentSessionId: AgentId,
  fixture = fileURLToPath(new URL("fixtures/cgroup-root-race.ts", import.meta.url)),
): RaceFixture {
  const primitiveParentSessionId: string = parentSessionId;
  const child = spawn(process.execPath, [fixture, membership, scratch, id, barrier, primitiveParentSessionId], {
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk: Buffer) => { stdout = boundedDiagnostic(stdout + chunk.toString()); });
  child.stderr.on("data", (chunk: Buffer) => { stderr = boundedDiagnostic(stderr + chunk.toString()); });
  const result = new Promise<RaceFixtureResult>((resolve, reject) => {
    let exitOutcome: { code: number | null; signal: NodeJS.Signals | null } | undefined;
    child.once("error", reject);
    child.once("exit", (code, signal) => { exitOutcome = { code, signal }; });
    child.once("close", () => {
      if (exitOutcome === undefined) {
        reject(new Error(`race fixture ${id} closed without an exit outcome; stdout=${stdout}; stderr=${stderr}`));
        return;
      }
      if (exitOutcome.code !== 0 || exitOutcome.signal !== null) {
        reject(new Error(`race fixture ${id} exited code=${exitOutcome.code} signal=${exitOutcome.signal}; stdout=${stdout}; stderr=${stderr}`));
        return;
      }
      try {
        const lines = stdout.trim().split("\n");
        const line = lines[0];
        if (lines.length !== 1 || line === undefined || line === "") throw new Error("expected exactly one JSON record");
        resolve(JSON.parse(line) as RaceFixtureResult);
      } catch (error) {
        reject(new Error(`race fixture ${id} invalid output: ${error instanceof Error ? error.message : String(error)}; stderr=${stderr}`));
      }
    });
  });
  void result.catch(() => undefined);
  return { child, result, diagnostic: () => `fixture ${id}: stdout=${stdout}; stderr=${stderr}` };
}

async function waitForFiles(paths: readonly string[], timeout: number): Promise<void> {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (paths.every(existsSync)) return;
    await Bun.sleep(10);
  }
  throw new Error(`race fixture arrivals timed out: ${paths.filter((path) => !existsSync(path)).join(", ")}`);
}

function trimEmptyCgroupTree(root: string): void {
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if (entry.isDirectory()) trimEmptyCgroupTree(join(root, entry.name));
  }
  rmdirSync(root);
}

function trimEmptyCgroupTreeBestEffort(root: string): void {
  try { trimEmptyCgroupTree(root); } catch { /* failure cleanup must not mask the primary error */ }
}

function boundedDiagnostic(value: string): string {
  return value.length <= 4_096 ? value : value.slice(-4_096);
}

function raceFixtureCleanupError(
  settlements: readonly PromiseSettledResult<unknown>[],
  diagnostics: string,
): AggregateError | undefined {
  const reasons = settlements.flatMap((result) => result.status === "rejected" ? [result.reason] : []);
  if (reasons.length === 0) return undefined;
  const errors = diagnostics.length === 0
    ? reasons
    : [...reasons, new Error(`race fixture diagnostics:\n${boundedDiagnostic(diagnostics)}`)];
  return new AggregateError(errors, "race fixture failure");
}

function isDefined<T>(value: T | undefined): value is T {
  return value !== undefined;
}

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
