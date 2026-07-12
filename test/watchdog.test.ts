import { afterEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { ContainmentAttempt, ContainmentOutcome } from "../src/containment.ts";
import { createRunAttemptId, verifiedContainmentReceiptPath } from "../src/domain.ts";
import type { AbsolutePath, ContainmentReceiptPath, RunAttemptId, VerifiedContainmentReceiptPath } from "../src/domain.ts";
import { WatchdogClient, verifyContainmentReceipt } from "../src/watchdog-client.ts";

const clients: WatchdogClient[] = [];
const directories: string[] = [];
afterEach(async () => {
  await Promise.allSettled(clients.splice(0).map((client) => client.close()));
  Bun.gc(true);
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe("cgroup-v2 watchdog", () => {
  test("does not activate fake containment from ambient environment in default construction", async () => {
    const previous = process.env.PI_WATCHDOG_FAKE_CGROUP;
    process.env.PI_WATCHDOG_FAKE_CGROUP = "1";
    const fixture = watchdogFixture({ fake: false });
    try {
      await expect(fixture.client.ready()).rejects.toThrow();
      expect(existsSync(join(fixture.scope, "cgroup.procs"))).toBeFalse();
    } finally {
      if (previous === undefined) delete process.env.PI_WATCHDOG_FAKE_CGROUP;
      else process.env.PI_WATCHDOG_FAKE_CGROUP = previous;
    }
  });

  test("cannot enable fake containment through the public client options", async () => {
    const fixture = watchdogFixture({ fake: false, createClient: false });
    const client = new WatchdogClient(Object.assign({
      attemptId: fixture.attemptId,
      receiptPath: fixture.receipt,
      attempt: fixture.attempt,
      launcherPath: join(import.meta.dir, "../launcher.mjs") as AbsolutePath,
      timeoutMs: 1_000,
    }, { testEnvironment: { PI_WATCHDOG_FAKE_CGROUP: "1" } }));
    clients.push(client);

    await expect(client.ready()).rejects.toThrow();
    expect(existsSync(join(fixture.scope, "cgroup.procs"))).toBeFalse();
  });

  test("rejects an attempt scope whose parent differs from the backend canonical parent", async () => {
    const fixture = watchdogFixture({ expectedParent: "other-parent" });

    await expect(fixture.client.ready()).rejects.toThrow();
  });

  test("rejects a canonical parent whose basename is not a lowercase SHA-256 digest", async () => {
    const fixture = watchdogFixture({ parentBasename: "not-a-sha-256-digest" });

    await expect(fixture.client.ready()).rejects.toThrow();
  });

  test("creates the attempt scope and reports the exact descriptor before launch", async () => {
    const fixture = watchdogFixture();

    await expect(fixture.client.ready()).resolves.toEqual(fixture.attempt.descriptor);

    expect(existsSync(fixture.scope)).toBeTrue();
    expect(readFileSync(fixture.trace, "utf8").trim().split("\n")).toEqual(["watchdog:attempt-create"]);
  });

  test("moves the prepared launcher, verifies membership, then authorises Pi", async () => {
    const fixture = watchdogFixture();
    await fixture.client.ready();
    const marker = join(fixture.directory, "pi-marker");

    const launch = await fixture.client.launch({
      command: process.execPath as AbsolutePath,
      args: ["-e", `require('node:fs').writeFileSync(${JSON.stringify(marker)}, String(process.pid))`],
      cwd: fixture.directory as AbsolutePath,
      env: process.env,
      shell: false,
    });
    await launch.exited;

    expect(existsSync(marker)).toBeTrue();
    expect(readFileSync(fixture.trace, "utf8").trim().split("\n")).toEqual([
      "watchdog:attempt-create",
      "launcher:spawn",
      "launcher:prepared",
      "cgroup.procs:write-launcher-pid",
      "cgroup.procs:read-membership",
      "launcher:authorize",
      "launcher:spawned-pi",
    ]);
    expect("pgid" in launch).toBeFalse();
  });

  test.each(["after-launcher-spawn", "after-membership"])(
    "failure %s before authorisation never creates Pi and publishes no_process proof",
    async (failure) => {
      const fixture = watchdogFixture({ failure });
      await fixture.client.ready();
      const marker = join(fixture.directory, "forbidden-pi-marker");

      await expect(fixture.client.launch({
        command: process.execPath as AbsolutePath,
        args: ["-e", `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'spawned')`],
        cwd: fixture.directory as AbsolutePath,
        env: process.env,
        shell: false,
      })).rejects.toThrow();

      expect(existsSync(marker)).toBeFalse();
      expect(JSON.parse(readFileSync(fixture.receipt, "utf8"))).toMatchObject({ version: 2, outcome: "no_process" });
    },
  );

  test("failure after authorisation retains containment through empty spawn_failed proof", async () => {
    const fixture = watchdogFixture({ failure: "after-authorisation" });
    await fixture.client.ready();

    await expect(fixture.client.launch({
      command: process.execPath as AbsolutePath,
      args: ["-e", "setInterval(() => {}, 1000)"],
      cwd: fixture.directory as AbsolutePath,
      env: process.env,
      shell: false,
    })).rejects.toThrow();

    expect(JSON.parse(readFileSync(fixture.receipt, "utf8"))).toMatchObject({
      version: 2,
      outcome: "spawn_failed",
      populated: false,
    });
  });

  test("publishes no receipt while populated and removes the scope only after durable proof", async () => {
    const fixture = watchdogFixture({ blockEmpty: true });
    await fixture.client.ready();
    await fixture.client.launch({ command: process.execPath as AbsolutePath, args: ["-e", "setInterval(() => {}, 1000)"],
      cwd: fixture.directory as AbsolutePath, env: process.env, shell: false });

    const closing = fixture.client.close();
    await Bun.sleep(100);
    expect(existsSync(fixture.receipt)).toBeFalse();
    expect(existsSync(fixture.scope)).toBeTrue();

    writeFileSync(join(fixture.scope, "cgroup.events"), "populated 0\n");
    await closing;

    expect(verifyContainmentReceipt(fixture.receipt, fixture.attemptId, undefined, fixture.attempt.descriptor)).toMatchObject({ version: 2, populated: false });
    expect(existsSync(fixture.scope)).toBeFalse();
  }, 15_000);

  test("kill failure leaves the scope, publishes no receipt, and rejects containment", async () => {
    const fixture = watchdogFixture({ killFailure: true });
    await fixture.client.ready();
    await fixture.client.launch({ command: process.execPath as AbsolutePath, args: ["-e", "setInterval(() => {}, 1000)"],
      cwd: fixture.directory as AbsolutePath, env: process.env, shell: false });

    await expect(fixture.client.close()).rejects.toThrow(/containment|kill|watchdog/);

    expect(existsSync(fixture.receipt)).toBeFalse();
    expect(existsSync(fixture.scope)).toBeTrue();
    expect(fixture.attempt.terminateCalls).toBe(1);
  }, 15_000);

  test("watchdog control failure waits for watchdog exit then uses the parent attempt exactly once", async () => {
    const fixture = watchdogFixture({ watchdogPath: join(import.meta.dir, "fixtures/malformed-watchdog.mjs") as AbsolutePath });

    await expect(fixture.client.ready()).rejects.toThrow(/protocol_error/);
    await Promise.allSettled([fixture.client.close(), fixture.client.close()]);

    expect(fixture.attempt.terminateCalls).toBe(1);
    expect(verifyContainmentReceipt(fixture.receipt, fixture.attemptId, undefined, fixture.attempt.descriptor).version).toBe(2);
  }, 15_000);

  test("valid receipt cleanup discharges backend attempt tracking", async () => {
    const fixture = watchdogFixture();
    await fixture.client.ready();

    await fixture.client.close();
    await fixture.client.waitForReceipt();

    expect(fixture.attempt.cleanupCalls).toBeGreaterThanOrEqual(1);
  });
});

describe("verifyContainmentReceipt", () => {
  test("retains exact historical v1 semantics", () => {
    const directory = temporaryDirectory("receipt-v1-");
    const receipt = join(directory, "receipt.json") as ContainmentReceiptPath;
    const attemptId = createRunAttemptId();
    writeFileSync(receipt, JSON.stringify({ version: 1, attemptId, outcome: "no_process", pgid: null,
      timestamp: new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString() }));
    expect(verifyContainmentReceipt(receipt, attemptId)).toMatchObject({ version: 1, pgid: null });
  });

  test.each([
    { extra: true },
    { populated: true },
    { backend: "process-group" },
    { scopePath: "/wrong/scope" },
    { outcome: "containment_failed" },
  ])("rejects malformed or mismatched v2 receipt %#", (override) => {
    const fixture = watchdogFixture();
    writeFileSync(fixture.receipt, JSON.stringify({
      version: 2, attemptId: fixture.attemptId, backend: "cgroup-v2", scopePath: fixture.scope,
      outcome: "no_process", populated: false, timestamp: new Date().toISOString(), ...override,
    }));
    expect(() => verifyContainmentReceipt(fixture.receipt, fixture.attemptId, undefined, fixture.attempt.descriptor)).toThrow();
  });
});

class FakeAttempt implements ContainmentAttempt {
  terminateCalls = 0;
  cleanupCalls = 0;
  readonly descriptor;

  constructor(
    readonly attemptId: RunAttemptId,
    readonly receipt: ContainmentReceiptPath,
    scope: AbsolutePath,
    readonly parentScope: AbsolutePath,
    private readonly terminateFailure = false,
  ) {
    this.descriptor = { backend: "cgroup-v2" as const, scopePath: scope };
  }

  async terminate(outcome: ContainmentOutcome): Promise<VerifiedContainmentReceiptPath> {
    this.terminateCalls++;
    if (this.terminateFailure) throw new Error("parent cgroup kill failed");
    if (existsSync(this.descriptor.scopePath)) writeFileSync(join(this.descriptor.scopePath, "cgroup.events"), "populated 0\n");
    writeFileSync(this.receipt, `${JSON.stringify({ version: 2, attemptId: this.attemptId, backend: "cgroup-v2",
      scopePath: this.descriptor.scopePath, outcome, populated: false, timestamp: new Date().toISOString() })}\n`, { mode: 0o600 });
    return verifiedContainmentReceiptPath(this.receipt);
  }

  async verifyEmpty(): Promise<void> {}
  async cleanup(): Promise<void> { this.cleanupCalls++; }
}

function watchdogFixture(options: { blockEmpty?: boolean; killFailure?: boolean; watchdogPath?: AbsolutePath; failure?: string; fake?: boolean; expectedParent?: string; parentBasename?: string; createClient?: boolean } = {}) {
  const directory = temporaryDirectory("cgroup-watchdog-");
  const attemptId = createRunAttemptId();
  const parent = join(directory, options.parentBasename ?? createHash("sha256").update("parent").digest("hex"));
  mkdirSync(parent, { mode: 0o700 });
  const expectedParent = options.expectedParent === undefined
    ? parent as AbsolutePath
    : join(directory, createHash("sha256").update(options.expectedParent).digest("hex")) as AbsolutePath;
  if (expectedParent !== parent) mkdirSync(expectedParent, { mode: 0o700 });
  const scope = join(parent, createHash("sha256").update(attemptId).digest("hex")) as AbsolutePath;
  const receipt = join(directory, "receipt.json") as ContainmentReceiptPath;
  const trace = join(directory, "trace");
  const attempt = new FakeAttempt(attemptId, receipt, scope, expectedParent, options.killFailure);
  const useFakeHarness = options.fake !== false && options.watchdogPath === undefined;
  if (useFakeHarness) writeFileSync(`${receipt}.fake-config.json`, JSON.stringify({
    trace,
    blockEmpty: options.blockEmpty === true,
    killFailure: options.killFailure === true,
    ...(options.failure === undefined ? {} : { failure: options.failure }),
  }));
  const client = options.createClient === false ? undefined : new WatchdogClient({
    attemptId,
    receiptPath: receipt,
    attempt,
    watchdogPath: options.watchdogPath ?? (useFakeHarness
      ? join(import.meta.dir, "fixtures/fake-watchdog.mjs") as AbsolutePath
      : join(import.meta.dir, "../watchdog.mjs") as AbsolutePath),
    launcherPath: join(import.meta.dir, "../launcher.mjs") as AbsolutePath,
    timeoutMs: 1_000,
  });
  if (client !== undefined) clients.push(client);
  return { client: client as WatchdogClient, attempt, attemptId, directory, scope, receipt, trace };
}

function temporaryDirectory(prefix: string): string {
  const directory = mkdtempSync(join(tmpdir(), prefix));
  directories.push(directory);
  return directory;
}
