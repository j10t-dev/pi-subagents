import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import type {
  ContainmentAttempt,
  ContainmentDescriptor,
  ContainmentOutcome,
  RestorationContainmentDescriptor,
} from "../src/containment.ts";
import { createRunAttemptId, milliseconds, verifiedContainmentReceiptPath } from "../src/domain.ts";
import type {
  AbsolutePath,
  CgroupScopePath,
  ContainmentReceiptPath,
  ProcessGroupId,
  RunAttemptId,
  VerifiedContainmentReceiptPath,
} from "../src/domain.ts";
import { WatchdogClient, verifyContainmentReceipt } from "../src/watchdog-client.ts";
import { testContainmentAttempt } from "./support/brands.ts";
import { temporaryStateRoot } from "./support/temp-state.ts";

const clients: WatchdogClient[] = [];
const directories: ReturnType<typeof temporaryStateRoot>[] = [];
afterEach(async () => {
  await Promise.allSettled(clients.splice(0).map((client) => client.close()));
  Bun.gc(true);
  for (const directory of directories.splice(0)) directory.cleanup();
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
      timeoutMs: milliseconds(1_000),
    }, { testEnvironment: { PI_WATCHDOG_FAKE_CGROUP: "1" } }));
    clients.push(client);

    await expect(client.ready()).rejects.toThrow();
    expect(existsSync(join(fixture.scope, "cgroup.procs"))).toBeFalse();
  });

  test("rejects an attempt scope whose parent differs from the backend canonical parent", async () => {
    const fixture = watchdogFixture({ expectedParent: "other-parent" });

    await expect(fixture.client.ready()).rejects.toThrow();
  });

  test("rejects a canonical parent wire value whose basename is not a lowercase SHA-256 digest", async () => {
    const fixture = watchdogFixture({ parentWireBasename: "not-a-sha-256-digest" });

    await expect(fixture.client.ready()).rejects.toThrow();
  });

  test("creates the attempt scope and reports the exact descriptor before launch", async () => {
    const fixture = watchdogFixture();

    const descriptor: ContainmentDescriptor = await fixture.client.ready();
    const scope: CgroupScopePath = descriptor.scopePath;
    expect(scope).toBe(fixture.attempt.descriptor.scopePath);
    expect(descriptor).toEqual(fixture.attempt.descriptor);
    expect(fixture.attempt.proofCalls).toBe(1);

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

  test("returns restoration-only v2 evidence unless an expected live descriptor is supplied", () => {
    const fixture = watchdogFixture();
    writeFileSync(fixture.receipt, JSON.stringify({
      version: 2,
      attemptId: fixture.attemptId,
      backend: "cgroup-v2",
      scopePath: fixture.scope,
      outcome: "no_process",
      populated: false,
      timestamp: new Date().toISOString(),
    }));

    const restoration = verifyContainmentReceipt(fixture.receipt, fixture.attemptId);
    if (restoration.version !== 2) throw new Error("expected v2 receipt");
    const stored: RestorationContainmentDescriptor = restoration.descriptor;
    // @ts-expect-error receipt JSON alone cannot prove a live canonical cgroup scope.
    const _liveWithoutExpected: ContainmentDescriptor = restoration.descriptor;
    void _liveWithoutExpected;

    const live = verifyContainmentReceipt(
      fixture.receipt,
      fixture.attemptId,
      undefined,
      fixture.attempt.descriptor,
    );
    if (live.version !== 2) throw new Error("expected v2 receipt");
    const proven: ContainmentDescriptor = live.descriptor;
    expect(proven).toBe(fixture.attempt.descriptor);
    expect(stored).toEqual(proven);
  });

  test("brands a validated historical process group and rejects invalid numeric identities", () => {
    const directory = temporaryDirectory("receipt-v1-pgid-");
    const receipt = join(directory, "receipt.json") as ContainmentReceiptPath;
    const attemptId = createRunAttemptId();
    writeFileSync(receipt, JSON.stringify({ version: 1, attemptId, outcome: "terminated", pgid: 99_999_999,
      timestamp: new Date().toISOString() }));
    const verified = verifyContainmentReceipt(receipt, attemptId);
    if (verified.version !== 1 || verified.pgid === null) throw new Error("expected v1 process group");
    const group: ProcessGroupId = verified.pgid;
    expect(Number(group)).toBe(99_999_999);

    for (const pgid of [0, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
      writeFileSync(receipt, JSON.stringify({ version: 1, attemptId, outcome: "terminated", pgid,
        timestamp: new Date().toISOString() }));
      expect(() => verifyContainmentReceipt(receipt, attemptId)).toThrow("invalid containment receipt schema");
    }
  });

  test.each([0, 1.5, Number.MAX_SAFE_INTEGER + 1])(
    "rejects malformed launched process id %p with the existing protocol error",
    async (pid) => {
      const previous = process.env.MALFORMED_WATCHDOG_CASE;
      process.env.MALFORMED_WATCHDOG_CASE = `invalid-launched:${pid}`;
      const fixture = watchdogFixture({
        watchdogPath: join(import.meta.dir, "fixtures/malformed-watchdog.mjs") as AbsolutePath,
      });
      try {
        await fixture.client.ready();
        await expect(fixture.client.launch({
          command: process.execPath as AbsolutePath,
          args: ["-e", "process.exit(0)"],
          cwd: fixture.directory as AbsolutePath,
          env: process.env,
          shell: false,
        })).rejects.toThrow("protocol_error: malformed launched control message");
      } finally {
        if (previous === undefined) delete process.env.MALFORMED_WATCHDOG_CASE;
        else process.env.MALFORMED_WATCHDOG_CASE = previous;
      }
    },
  );

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
  proofCalls = 0;
  readonly candidate;
  readonly descriptor;

  constructor(
    private readonly proofAttempt: ContainmentAttempt & { readonly descriptor: ContainmentDescriptor },
    readonly receipt: ContainmentReceiptPath,
    readonly parentScope: AbsolutePath,
    private readonly terminateFailure = false,
  ) {
    this.candidate = proofAttempt.candidate;
    this.descriptor = proofAttempt.descriptor;
  }

  get attemptId(): RunAttemptId { return this.proofAttempt.attemptId; }

  proveRuntimeDescriptor(evidence: RestorationContainmentDescriptor): ContainmentDescriptor {
    this.proofCalls++;
    return this.proofAttempt.proveRuntimeDescriptor(evidence);
  }

  async terminate(outcome: ContainmentOutcome): Promise<VerifiedContainmentReceiptPath> {
    this.terminateCalls++;
    if (this.terminateFailure) throw new Error("parent cgroup kill failed");
    const primitiveScopePath: string = this.descriptor.scopePath;
    const primitiveReceiptPath: string = this.receipt;
    const primitiveAttemptId: string = this.attemptId;
    if (existsSync(primitiveScopePath)) writeFileSync(join(primitiveScopePath, "cgroup.events"), "populated 0\n");
    writeFileSync(primitiveReceiptPath, `${JSON.stringify({ version: 2, attemptId: primitiveAttemptId, backend: "cgroup-v2",
      scopePath: primitiveScopePath, outcome, populated: false, timestamp: new Date().toISOString() })}\n`, { mode: 0o600 });
    return verifiedContainmentReceiptPath(this.receipt);
  }

  async verifyEmpty(): Promise<void> {}
  async cleanup(): Promise<void> { this.cleanupCalls++; }
}

function watchdogFixture(options: { blockEmpty?: boolean; killFailure?: boolean; watchdogPath?: AbsolutePath; failure?: string; fake?: boolean; expectedParent?: string; parentWireBasename?: string; createClient?: boolean } = {}) {
  const directory = temporaryDirectory("cgroup-watchdog-");
  const attemptId = createRunAttemptId();
  const proven = testContainmentAttempt(attemptId, directory as AbsolutePath);
  const parent: string = proven.parentScope;
  const descriptor = proven.descriptor;
  const parentScopeWire: string | undefined = options.parentWireBasename === undefined
    ? undefined
    : join(directory, options.parentWireBasename);
  mkdirSync(parent, { recursive: true, mode: 0o700 });
  if (parentScopeWire !== undefined) mkdirSync(parentScopeWire, { recursive: true, mode: 0o700 });
  const expectedParent = options.expectedParent === undefined
    ? proven.parentScope
    : testContainmentAttempt(attemptId, directory as AbsolutePath, options.expectedParent).parentScope;
  if (expectedParent !== parent) mkdirSync(expectedParent, { recursive: true, mode: 0o700 });
  const scope = descriptor.scopePath;
  const receipt = join(directory, "receipt.json") as ContainmentReceiptPath;
  const trace = join(directory, "trace");
  const attempt = new FakeAttempt(proven, receipt, expectedParent, options.killFailure);
  const useFakeHarness = options.fake !== false && options.watchdogPath === undefined;
  if (useFakeHarness) writeFileSync(`${receipt}.fake-config.json`, JSON.stringify({
    trace,
    blockEmpty: options.blockEmpty === true,
    killFailure: options.killFailure === true,
    ...(options.failure === undefined ? {} : { failure: options.failure }),
    ...(parentScopeWire === undefined ? {} : { parentScopeWire }),
  }));
  const client = options.createClient === false ? undefined : new WatchdogClient({
    attemptId,
    receiptPath: receipt,
    attempt,
    watchdogPath: options.watchdogPath ?? (useFakeHarness
      ? join(import.meta.dir, "fixtures/fake-watchdog.mjs") as AbsolutePath
      : join(import.meta.dir, "../watchdog.mjs") as AbsolutePath),
    launcherPath: join(import.meta.dir, "../launcher.mjs") as AbsolutePath,
    timeoutMs: milliseconds(1_000),
  });
  if (client !== undefined) clients.push(client);
  return { client: client as WatchdogClient, attempt, attemptId, directory, scope, receipt, trace };
}

function temporaryDirectory(prefix: string): string {
  const state = temporaryStateRoot(prefix);
  directories.push(state);
  return state.path;
}
