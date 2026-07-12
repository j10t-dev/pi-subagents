import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import {
  cgroupScopeName,
  createContainmentProvider,
  resolveCgroupV2Backend,
  type CgroupFileSystem,
  type ProbeProcess,
} from "../src/cgroup-v2.ts";
import { PublicPreflightError, runAttemptId, verifiedContainmentReceiptPath } from "../src/domain.ts";
import type { ContainmentDescriptor } from "../src/containment.ts";
import { absolutePath, containmentReceiptPath } from "../src/paths.ts";

const MOUNT = "/sys/fs/cgroup";
const CURRENT = `${MOUNT}/user.slice/pi.scope`;
const ROOT = `${CURRENT}/pi-subagents`;
const PARENT = `${ROOT}/${cgroupScopeName("parent-session")}`;
const ATTEMPT = `${PARENT}/${cgroupScopeName("attempt-1")}`;
const PREFLIGHT = `${PARENT}/preflight-00112233445566778899aabbccddeeff`;
const ATTEMPT_ID = runAttemptId("attempt-1");

describe("cgroup-v2", () => {
  test("uses complete SHA-256 scope names", () => {
    expect(cgroupScopeName("parent-session")).toBe(
      "a1bdc27ac7582a7459555e91884123666722003a729ba3fbfc29676fc4f724c7",
    );
    expect(cgroupScopeName("attempt-1")).toBe(
      "3dafcfaa6218343276ff42263fe100bab5e2b0475a8d98b96abc88c57bfd9992",
    );
  });

  const invalidSelfCgroups = [
    ["malformed", "garbage\n"],
    ["duplicate", "0::/user.slice\n0::/other.slice\n"],
    ["non-unified", "0::/user.slice\n1:name=systemd:/user.slice\n"],
    ["relative", "0::user.slice\n"],
    ["traversal", "0::/user.slice/../escape\n"],
  ] as const;
  for (const [name, text] of invalidSelfCgroups) {
    test(`rejects ${name} /proc/self/cgroup input`, () => {
      const fs = baseFs();
      expect(() => backend(fs, { selfCgroupText: text })).toThrow(/^containment_unavailable:unified cgroup/);
      expect(fs.directories.has(ROOT)).toBeFalse();
    });
  }

  test("resolves the default root, creates missing root and parent with mode 0700", () => {
    const fs = baseFs();
    const resolved = backend(fs);
    expect(String(resolved.root)).toBe(ROOT);
    expect(String(resolved.parentScope)).toBe(PARENT);
    expect(fs.trace).toEqual([`mkdir:${ROOT}:700`, `mkdir:${PARENT}:700`]);
  });

  test("reuses an existing default root and does not later remove it", async () => {
    const fs = baseFs(ROOT);
    const resolved = backend(fs);
    await resolved.shutdown();
    expect(fs.trace).toEqual([`mkdir:${PARENT}:700`, `rmdir:${PARENT}`]);
    expect(fs.directories.has(ROOT)).toBeTrue();
  });

  const nonDirectories = [
    ["mount", MOUNT],
    ["root", ROOT],
    ["parent scope", PARENT],
  ] as const;
  for (const [category, path] of nonDirectories) {
    test(`rejects a non-directory ${category}`, () => {
      const fs = path === PARENT ? baseFs(ROOT, PARENT) : path === ROOT ? baseFs(ROOT) : baseFs();
      fs.nonDirectories.add(path);
      expect(() => backend(fs)).toThrow(new RegExp(`^containment_unavailable:${category}`));
    });
  }

  test("configured root must be absolute, NUL-free, existing, beneath the mount, and is never created", () => {
    for (const configuredRoot of [`${MOUNT}/missing`, "/outside", "delegated", `${MOUNT}/delegated\0escape`]) {
      const fs = configuredRoot.endsWith("/missing") ? baseFs() : baseFs(configuredRoot);
      if (configuredRoot === "delegated") fs.reals.set(configuredRoot, `${MOUNT}/delegated`);
      expect(() => backend(fs, { configuredRoot })).toThrow(/^containment_unavailable:configured root/);
      expect(fs.trace).toEqual([]);
    }
  });

  test("rejects configured-root and default-current symlink escape", () => {
    const configured = baseFs(`${MOUNT}/delegated`);
    configured.reals.set(`${MOUNT}/delegated`, "/outside/delegated");
    expect(() => backend(configured, { configuredRoot: `${MOUNT}/delegated` })).toThrow(/^containment_unavailable:configured root/);

    const current = baseFs();
    current.reals.set(CURRENT, "/outside/current");
    expect(() => backend(current)).toThrow(/^containment_unavailable:parent cgroup/);
  });

  test("prepare is non-I/O, deterministic and reuses attempt identity", () => {
    const fs = baseFs();
    const resolved = backend(fs);
    fs.trace.length = 0;
    const first = resolved.prepareAttempt(ATTEMPT_ID);
    const second = resolved.prepareAttempt(ATTEMPT_ID);
    expect(first).toBe(second);
    expect(first.descriptor).toEqual({ backend: "cgroup-v2", scopePath: absolutePath(ATTEMPT) });
    expect(fs.trace).toEqual([]);
    expect(fs.directories.has(ATTEMPT)).toBeFalse();
  });

  test("prepare performs no filesystem I/O after resolution", () => {
    const fs = baseFs();
    const resolved = backend(fs);
    fs.reals.set(PARENT, "/outside/parent");
    expect(resolved.prepareAttempt(ATTEMPT_ID).descriptor.scopePath).toBe(absolutePath(ATTEMPT));
  });

  test("restore validates backend, exact identity and extant canonical containment", () => {
    const fs = baseFs();
    const resolved = backend(fs);
    const descriptor = resolved.prepareAttempt(ATTEMPT_ID).descriptor;
    expect(resolved.restoreAttempt(ATTEMPT_ID, descriptor).descriptor).toEqual(descriptor);
    expect(() => resolved.restoreAttempt(ATTEMPT_ID, { ...descriptor, scopePath: absolutePath(`${ATTEMPT}-wrong`) }))
      .toThrow(/^containment_unavailable:attempt descriptor/);
    const malformedDescriptor: ContainmentDescriptor = { ...descriptor };
    Reflect.set(malformedDescriptor, "backend", "other");
    expect(() => resolved.restoreAttempt(ATTEMPT_ID, malformedDescriptor))
      .toThrow(/^containment_unavailable:attempt descriptor/);
    fs.addDirectory(ATTEMPT);
    fs.reals.set(ATTEMPT, `${PARENT}/different-attempt`);
    expect(() => resolved.restoreAttempt(ATTEMPT_ID, descriptor)).toThrow(/^containment_unavailable:attempt scope/);
    fs.reals.set(ATTEMPT, "/outside/attempt");
    expect(() => resolved.restoreAttempt(ATTEMPT_ID, descriptor)).toThrow(/^containment_unavailable:attempt scope/);
  });

  test("preflight proves the exact authoritative operation trace", async () => {
    const fs = baseFs();
    const probe = controlledProbe(fs);
    const resolved = backend(fs, {
      spawnProbe: () => { fs.trace.push("spawn-probe"); return probe; },
      randomBytes: () => Buffer.from("00112233445566778899aabbccddeeff", "hex"),
      pollDelay: async () => {},
    });
    fs.trace.length = 0;
    await resolved.preflight();
    expect(fs.trace).toEqual([
      "mkdir:preflight-00112233445566778899aabbccddeeff",
      "spawn-probe",
      "write:cgroup.procs:4242",
      "read:cgroup.procs",
      "write:cgroup.kill:1",
      "read:cgroup.events:populated 1",
      "read:cgroup.events:populated 0",
      "probe-exited",
      "rmdir:preflight-00112233445566778899aabbccddeeff",
    ]);
  });

  for (const stage of ["create", "move", "membership", "events", "kill", "empty", "exit", "remove"] as const) {
    test(`preflight contains and rejects a ${stage} failure without attempt creation`, async () => {
      let clock = 0;
      const fs = baseFs();
      const probe = controlledProbe(fs, stage === "exit");
      fs.failure = stage;
      const resolved = backend(fs, {
        spawnProbe: () => { fs.trace.push("spawn-probe"); return probe; },
        randomBytes: () => Buffer.from("00112233445566778899aabbccddeeff", "hex"),
        now: () => clock,
        pollDelay: async () => { clock += 10_001; },
      });
      fs.trace.length = 0;
      await expect(resolved.preflight()).rejects.toThrow(/^containment_unavailable:/);
      expect(probe.killed).toBe(stage !== "create");
      expect(probe.released).toBe(stage !== "create");
      expect(fs.directories.has(ATTEMPT)).toBeFalse();
      if (stage !== "create") {
        expect(fs.trace.some((entry) => entry === "write:cgroup.kill:1")).toBeTrue();
        expect(fs.trace.some((entry) => entry.startsWith("read:cgroup.events"))).toBeTrue();
      }
    });
  }

  test("strict events parsing polls until exactly populated 0", async () => {
    for (const malformed of ["", "populated 2\n", "populated 0\npopulated 0\n", "populated x\n", "populated 0\nbad\n"]) {
      const fs = baseFs();
      const resolved = backend(fs);
      const attempt = resolved.prepareAttempt(ATTEMPT_ID);
      fs.addDirectory(ATTEMPT);
      fs.files.set(`${ATTEMPT}/cgroup.events`, [malformed]);
      await expect(attempt.verifyEmpty()).rejects.toThrow(/^containment_unavailable:cgroup events/);
    }
  });

  test("absence without matching durable proof never proves cleanup", async () => {
    const fs = baseFs();
    const resolved = backend(fs);
    const attempt = resolved.restoreAttempt(ATTEMPT_ID, { backend: "cgroup-v2", scopePath: absolutePath(ATTEMPT) });
    await expect(attempt.cleanup()).rejects.toThrow(/^containment_unavailable:missing attempt scope/);
    await expect(attempt.cleanup(verifiedContainmentReceiptPath(containmentReceiptPath("/wrong", "receipt.json"))))
      .rejects.toThrow(/^containment_unavailable:missing attempt scope/);
  });

  test("terminate creates a no-process scope, proves empty, durably publishes v2 receipt, then removes", async () => {
    const state = mkdtempSync(join(tmpdir(), "pi-cgroup-receipt-"));
    try {
      const fs = baseFs();
      const receipt = containmentReceiptPath(state, "attempt.json");
      const resolved = backend(fs, { receiptPathFor: () => receipt, now: () => Date.parse("2026-01-02T03:04:05.000Z") });
      const proof = await resolved.prepareAttempt(ATTEMPT_ID).terminate("no_process");
      expect(String(proof)).toBe(String(receipt));
      expect(JSON.parse(readFileSync(receipt, "utf8"))).toEqual({
        version: 2,
        attemptId: "attempt-1",
        backend: "cgroup-v2",
        scopePath: ATTEMPT,
        outcome: "no_process",
        timestamp: "2026-01-02T03:04:05.000Z",
        populated: false,
      });
      expect(fs.directories.has(ATTEMPT)).toBeFalse();
      expect(fs.trace.slice(-5)).toEqual([
        `mkdir:${ATTEMPT}:700`,
        "write:cgroup.kill:1",
        "read:cgroup.events:populated 1",
        "read:cgroup.events:populated 0",
        `rmdir:${ATTEMPT}`,
      ]);
    } finally { rmSync(state, { recursive: true, force: true }); }
  });

  test("termination kills before polling an initially empty scope", async () => {
    const state = mkdtempSync(join(tmpdir(), "pi-cgroup-termination-"));
    try {
      const fs = baseFs();
      const resolved = backend(fs, { receiptPathFor: () => containmentReceiptPath(state, "attempt.json") });
      const attempt = resolved.prepareAttempt(ATTEMPT_ID);
      fs.addDirectory(ATTEMPT);
      fs.trace.length = 0;

      await attempt.terminate("terminated");

      expect(fs.trace).toEqual([
        "write:cgroup.kill:1",
        "read:cgroup.events:populated 1",
        "read:cgroup.events:populated 0",
        `rmdir:${ATTEMPT}`,
      ]);
    } finally { rmSync(state, { recursive: true, force: true }); }
  });

  test("cleanup removes a proven-empty nested cgroup subtree leaf-first", async () => {
    const fs = baseFs();
    const receipt = containmentReceiptPath("/state", "receipt.json");
    const resolved = backend(fs, { receiptPathFor: () => receipt, diagnostic: (message) => fs.diagnostics.push(message) });
    const attempt = resolved.restoreAttempt(ATTEMPT_ID, { backend: "cgroup-v2", scopePath: absolutePath(ATTEMPT) });
    const childRoot = `${ATTEMPT}/pi-subagents`;
    const childParent = `${childRoot}/${cgroupScopeName("child-session")}`;
    const childAttempt = `${childParent}/${cgroupScopeName("child-attempt")}`;
    for (const path of [ATTEMPT, childRoot, childParent, childAttempt]) fs.addDirectory(path);

    await attempt.cleanup(verifiedContainmentReceiptPath(receipt));

    expect(fs.diagnostics).toEqual([]);
    expect([ATTEMPT, childRoot, childParent, childAttempt].some((path) => fs.directories.has(path))).toBeFalse();
    expect(fs.trace.slice(-8)).toEqual([
      "read:cgroup.events:populated 0",
      "read:cgroup.events:populated 0",
      `rmdir:${childAttempt}`,
      "read:cgroup.events:populated 0",
      `rmdir:${childParent}`,
      "read:cgroup.events:populated 0",
      `rmdir:${childRoot}`,
      `rmdir:${ATTEMPT}`,
    ]);
  });

  test("an accepted external receipt proof survives failed cleanup for shutdown retry", async () => {
    const fs = baseFs();
    const receipt = containmentReceiptPath("/state", "receipt.json");
    const resolved = backend(fs, { receiptPathFor: () => receipt, diagnostic: (message) => fs.diagnostics.push(message) });
    const attempt = resolved.restoreAttempt(ATTEMPT_ID, { backend: "cgroup-v2", scopePath: absolutePath(ATTEMPT) });
    fs.addDirectory(ATTEMPT);
    fs.failure = "attempt-remove-once";
    const proof = verifiedContainmentReceiptPath(receipt);
    await expect(attempt.cleanup(proof)).resolves.toBeUndefined();
    expect(fs.diagnostics).toContain("containment_unavailable:attempt cleanup failed");
    fs.directories.delete(ATTEMPT);
    await expect(resolved.shutdown()).resolves.toBeUndefined();
  });

  test("receipt publication gates cleanup and failed first cleanup is retried by shutdown", async () => {
    const state = mkdtempSync(join(tmpdir(), "pi-cgroup-retry-"));
    try {
      const fs = baseFs();
      fs.failure = "attempt-remove-once";
      const receipt = containmentReceiptPath(state, "attempt.json");
      const resolved = backend(fs, { receiptPathFor: () => receipt, diagnostic: (message) => fs.diagnostics.push(message) });
      const proof = await resolved.prepareAttempt(ATTEMPT_ID).terminate("no_process");
      expect(String(proof)).toBe(String(receipt));
      expect(fs.directories.has(ATTEMPT)).toBeTrue();
      await resolved.shutdown();
      expect(fs.directories.has(ATTEMPT)).toBeFalse();
      expect(fs.trace.filter((entry) => entry === `rmdir:${ATTEMPT}`)).toHaveLength(2);
      expect(fs.diagnostics).toContain("containment_unavailable:attempt cleanup failed");
    } finally { rmSync(state, { recursive: true, force: true }); }
  });

  test("shutdown rejects a genuine attempt-removal retry error and remains retryable without re-containing", async () => {
    const state = mkdtempSync(join(tmpdir(), "pi-cgroup-retry-error-"));
    try {
      const fs = baseFs();
      fs.failure = "attempt-remove-twice";
      const resolved = backend(fs, {
        receiptPathFor: () => containmentReceiptPath(state, "attempt.json"),
        diagnostic: (message) => fs.diagnostics.push(message),
      });
      await resolved.prepareAttempt(ATTEMPT_ID).terminate("no_process");

      await expect(resolved.shutdown()).rejects.toThrow("containment_unavailable:attempt remove");
      expect(fs.trace.filter((entry) => entry === "write:cgroup.kill:1")).toHaveLength(1);
      expect(fs.directories.has(ATTEMPT)).toBeTrue();

      await expect(resolved.shutdown()).resolves.toBeUndefined();
      expect(fs.trace.filter((entry) => entry === "write:cgroup.kill:1")).toHaveLength(1);
      expect(fs.directories.has(ATTEMPT)).toBeFalse();
    } finally { rmSync(state, { recursive: true, force: true }); }
  });

  test("shutdown removes empty parent then only an auto-created root", async () => {
    const fs = baseFs();
    const resolved = backend(fs);
    fs.trace.length = 0;
    await resolved.shutdown();
    expect(fs.trace).toEqual([`rmdir:${PARENT}`, `rmdir:${ROOT}`]);

    const configuredFs = baseFs(`${MOUNT}/delegated`);
    const configured = backend(configuredFs, { configuredRoot: `${MOUNT}/delegated` });
    configuredFs.trace.length = 0;
    await configured.shutdown();
    expect(configuredFs.trace).toEqual([`rmdir:${configured.parentScope}`]);
    expect(configuredFs.directories.has(`${MOUNT}/delegated`)).toBeTrue();
  });

  test("shutdown diagnoses ENOTEMPTY and absent intermediates but rejects other removal errors", async () => {
    for (const failure of ["ENOTEMPTY", "ENOENT"] as const) {
      const fs = baseFs();
      const resolved = backend(fs, { diagnostic: (message) => fs.diagnostics.push(message) });
      fs.failure = failure === "ENOTEMPTY" ? "parent-not-empty" : "parent-absent";
      await resolved.shutdown();
      expect(fs.diagnostics.some((message) => message.startsWith("containment_unavailable:parent scope cleanup"))).toBeTrue();
    }
    const fs = baseFs();
    const resolved = backend(fs);
    fs.failure = "parent-remove";
    await expect(resolved.shutdown()).rejects.toThrow("EACCES");
  });

  test("provider bounds only cgroup unavailability and preserves programming errors", () => {
    const unavailable = createContainmentProvider(options(baseFs(), { configuredRoot: `${MOUNT}/missing` }));
    expect(unavailable.kind).toBe("unavailable");
    if (unavailable.kind === "unavailable") {
      expect(() => unavailable.requireAvailable()).toThrow(new PublicPreflightError("containment_failed", "cgroup-v2 containment is unavailable"));
    }
    const programmingFailure = baseFs();
    programmingFailure.reals.set(MOUNT, "PROGRAMMING_ERROR");
    const originalRealpath = programmingFailure.realpath.bind(programmingFailure);
    programmingFailure.realpath = (path: string): string => {
      if (programmingFailure.reals.get(path) === "PROGRAMMING_ERROR") throw new TypeError("programming failure");
      return originalRealpath(path);
    };
    expect(() => createContainmentProvider(options(programmingFailure))).toThrow("programming failure");
  });
});

interface BackendOverrides {
  configuredRoot?: string;
  selfCgroupText?: string;
  spawnProbe?: () => ProbeProcess;
  randomBytes?: (bytes: number) => Buffer;
  pollDelay?: (milliseconds: number) => Promise<void>;
  now?: () => number;
  receiptPathFor?: () => ReturnType<typeof containmentReceiptPath>;
  diagnostic?: (message: string) => void;
}

function options(fs: MemoryCgroupFileSystem, overrides: BackendOverrides = {}) {
  return {
    parentSessionId: "parent-session",
    mountPath: MOUNT,
    selfCgroupText: "0::/user.slice/pi.scope\n",
    fs,
    receiptPathFor: overrides.receiptPathFor ?? (() => containmentReceiptPath("/state", "receipt.json")),
    ...overrides,
  };
}
function backend(fs: MemoryCgroupFileSystem, overrides: BackendOverrides = {}) {
  return resolveCgroupV2Backend(options(fs, overrides));
}
function baseFs(...extra: string[]): MemoryCgroupFileSystem {
  return new MemoryCgroupFileSystem([MOUNT, `${MOUNT}/user.slice`, CURRENT, ...extra]);
}

class MemoryCgroupFileSystem implements CgroupFileSystem {
  readonly directories = new Set<string>();
  readonly nonDirectories = new Set<string>();
  readonly files = new Map<string, string[]>();
  readonly reals = new Map<string, string>();
  readonly trace: string[] = [];
  readonly diagnostics: string[] = [];
  failure?: string;
  private attemptRemovalFailed = false;

  constructor(paths: readonly string[]) { for (const path of paths) this.addDirectory(path); }
  addDirectory(path: string): void {
    this.directories.add(path);
    this.files.set(`${path}/cgroup.events`, ["populated 0\n"]);
    this.files.set(`${path}/cgroup.procs`, []);
  }
  readFile(path: string): string {
    const name = path.slice(path.lastIndexOf("/") + 1);
    if (name === "cgroup.events") {
      if (this.failure === "events") { this.failure = "events-recovery"; throw new Error("EIO"); }
      if (this.failure === "empty") {
        this.trace.push("read:cgroup.events:populated 1");
        return "populated 1\n";
      }
      const values = this.files.get(path) ?? ["populated 0\n"];
      const value = values.length > 1 ? values.shift()! : values[0]!;
      this.trace.push(`read:cgroup.events:${value.trim()}`);
      return value;
    }
    if (name === "cgroup.procs") {
      this.trace.push("read:cgroup.procs");
      if (this.failure === "membership") return "9999\n";
      return (this.files.get(path) ?? []).at(-1) ?? "";
    }
    throw new Error("ENOENT");
  }
  writeFile(path: string, value: string): void {
    const name = path.slice(path.lastIndexOf("/") + 1);
    this.trace.push(`write:${name}:${value.trim()}`);
    if (name === "cgroup.procs" && this.failure === "move") throw new Error("EACCES");
    if (name === "cgroup.kill" && this.failure === "kill") { this.failure = "kill-recovery"; throw new Error("EACCES"); }
    this.files.set(path, [value]);
    if (name === "cgroup.kill" && this.failure !== "empty") {
      this.files.set(path.replace("cgroup.kill", "cgroup.events"), ["populated 1\n", "populated 0\n"]);
    }
  }
  mkdir(path: string, mode: number): void {
    const short = path.startsWith(PARENT + "/preflight-") ? path.slice(PARENT.length + 1) : path;
    this.trace.push(path.startsWith(PARENT + "/preflight-") ? `mkdir:${short}` : `mkdir:${short}:${mode.toString(8)}`);
    if (this.failure === "create" && path === PREFLIGHT) throw new Error("EACCES");
    this.addDirectory(path);
  }
  realpath(path: string): string {
    if (!this.directories.has(path) && !this.nonDirectories.has(path)) throw new Error("ENOENT");
    return this.reals.get(path) ?? path;
  }
  stat(path: string): { isDirectory(): boolean } {
    if (!this.directories.has(path) && !this.nonDirectories.has(path)) throw new Error("ENOENT");
    return { isDirectory: () => !this.nonDirectories.has(path) };
  }
  removeDirectory(path: string): void {
    const short = path.startsWith(PARENT + "/preflight-") ? path.slice(PARENT.length + 1) : path;
    this.trace.push(`rmdir:${short}`);
    if (this.failure === "remove" && path === PREFLIGHT) { this.failure = "remove-recovery"; throw new Error("EIO"); }
    if (this.failure === "attempt-remove-once" && path === ATTEMPT && !this.attemptRemovalFailed) { this.attemptRemovalFailed = true; throw new Error("EIO"); }
    if (this.failure === "attempt-remove-twice" && path === ATTEMPT) {
      const removals = this.trace.filter((entry) => entry === `rmdir:${ATTEMPT}`).length;
      if (removals === 1) throw errno("EIO");
      if (removals === 2) throw errno("EACCES");
    }
    if (this.failure === "parent-not-empty" && path === PARENT) throw errno("ENOTEMPTY");
    if (this.failure === "parent-absent" && path === PARENT) { this.directories.delete(path); throw errno("ENOENT"); }
    if (this.failure === "parent-remove" && path === PARENT) throw errno("EACCES");
    if ([...this.directories].some((candidate) => candidate.startsWith(`${path}/`))) throw errno("ENOTEMPTY");
    this.directories.delete(path);
  }
  list(path: string): readonly string[] {
    return [...this.directories]
      .filter((candidate) => candidate !== path && candidate.startsWith(`${path}/`) && !candidate.slice(path.length + 1).includes("/"))
      .map((candidate) => candidate.slice(path.length + 1));
  }
}

function controlledProbe(fs: MemoryCgroupFileSystem, rejectExit = false): ProbeProcess & { killed: boolean; released: boolean } {
  let settle!: () => void;
  let fail!: (error: Error) => void;
  const exited = new Promise<void>((resolve, reject) => { settle = resolve; fail = reject; });
  const probe = {
    pid: 4242,
    killed: false,
    released: false,
    release(): void {
      if (probe.released) return;
      probe.released = true;
      fs.trace.push("probe-exited");
      if (rejectExit) fail(new Error("probe exit failed")); else settle();
    },
    kill(): void { probe.killed = true; },
    exited,
  };
  return probe;
}
function errno(code: string): Error & { code: string } {
  return Object.assign(new Error(code), { code });
}
