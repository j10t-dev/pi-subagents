import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

import {
  cgroupScopeName,
  createContainmentProvider,
  resolveCgroupV2Backend,
  type CgroupFileSystem,
  type CgroupV2Options,
  type ProbeProcess,
} from "../src/cgroup-v2.ts";
import {
  agentId,
  observedCgroupScopePath,
  processId,
  PublicPreflightError,
  runAttemptId,
  verifiedContainmentReceiptPath,
} from "../src/domain.ts";
import type { AbsolutePath, CgroupScopePath } from "../src/domain.ts";
import type { ContainmentDescriptor, RestorationContainmentDescriptor } from "../src/containment.ts";
import { absolutePath, containmentReceiptPath } from "../src/paths.ts";
import { temporaryStateRoot } from "./support/temp-state.ts";

const MOUNT = "/sys/fs/cgroup";
const CURRENT = `${MOUNT}/user.slice/pi.scope`;
const ROOT = `${CURRENT}/pi-subagents`;
const PARENT_ID = agentId("parent-session");
const PARENT = `${ROOT}/${cgroupScopeName(PARENT_ID)}`;
const ATTEMPT_ID = runAttemptId("attempt-1");
const ATTEMPT = `${PARENT}/${cgroupScopeName(ATTEMPT_ID)}`;
const PREFLIGHT = `${PARENT}/preflight-00112233445566778899aabbccddeeff`;

function runtimeDescriptor(path = ATTEMPT): RestorationContainmentDescriptor {
  return { backend: "cgroup-v2", scopePath: observedCgroupScopePath(absolutePath(path)) };
}
const RAW_PARENT_ID: string = PARENT_ID;
// @ts-expect-error raw strings must be validated before cgroup parent identity construction.
const _scopeFromRawParent = cgroupScopeName(RAW_PARENT_ID);
const _optionsWithRawParent: CgroupV2Options = {
  // @ts-expect-error cgroup options retain the validated parent identity internally.
  parentSessionId: RAW_PARENT_ID,
  receiptPathFor: () => containmentReceiptPath("/state", "type-flow.json"),
};
void _scopeFromRawParent;
void _optionsWithRawParent;

describe("cgroup-v2", () => {
  test("uses complete SHA-256 scope names", () => {
    expect(cgroupScopeName(PARENT_ID)).toBe(
      "a1bdc27ac7582a7459555e91884123666722003a729ba3fbfc29676fc4f724c7",
    );
    expect(cgroupScopeName(ATTEMPT_ID)).toBe(
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

  test.each([
    ["pre-existing", true, undefined],
    ["newly created", false, undefined],
    ["concurrently adopted", false, "EEXIST"],
  ] as const)("requires a private canonical directory for a %s default root", (_name, exists, mkdirFailure) => {
    const fs = baseFs(...(exists ? [ROOT] : []));
    if (mkdirFailure !== undefined) {
      fs.beforeMkdirFailure(ROOT, mkdirFailure, () => fs.addDirectory(ROOT, 0o700));
    }

    const resolved = backend(fs);

    expect(String(resolved.root)).toBe(ROOT);
    expect(fs.stat(ROOT).mode & 0o777).toBe(0o700);
  });

  test.each([
    ["mode 0755", (fs: MemoryCgroupFileSystem) => fs.addDirectory(ROOT, 0o755)],
    ["non-directory", (fs: MemoryCgroupFileSystem) => fs.nonDirectories.add(ROOT)],
    ["escaped realpath", (fs: MemoryCgroupFileSystem) => fs.reals.set(ROOT, "/outside/root")],
  ])("rejects a %s default root without creating its parent", (_name, arrange) => {
    const fs = baseFs(ROOT);
    arrange(fs);

    expect(() => backend(fs)).toThrow(/^containment_unavailable:root/);
    expect(fs.trace).not.toContain(`mkdir:${PARENT}:700`);
  });

  test.each([
    ["root", ROOT, "EACCES"],
    ["parent scope", PARENT, "EACCES"],
    ["root", ROOT, "EIO"],
  ] as const)("does not mkdir after a non-ENOENT %s stat failure", (category, path, code) => {
    const fs = baseFs(ROOT);
    fs.statFailures.set(path, code);

    expect(() => backend(fs)).toThrow(`containment_unavailable:${category}`);
    expect(fs.trace).not.toContain(`mkdir:${path}:700`);
  });

  test("preserves a TypeError from a strict root stat probe", () => {
    const fs = baseFs(ROOT);
    fs.stat = (path: string) => {
      if (path === ROOT) throw new TypeError("programming failure");
      return { isDirectory: () => fs.directories.has(path), mode: 0o700 };
    };

    expect(() => backend(fs)).toThrow(new TypeError("programming failure"));
  });

  test.each([
    ["non-directory", (fs: MemoryCgroupFileSystem) => fs.nonDirectories.add(ROOT)],
    ["mode 0755", (fs: MemoryCgroupFileSystem) => fs.modes.set(ROOT, 0o755)],
    ["missing", (fs: MemoryCgroupFileSystem) => fs.directories.delete(ROOT)],
    ["escaped realpath", (fs: MemoryCgroupFileSystem) => fs.reals.set(ROOT, "/outside/root")],
  ])("rejects root creation EEXIST followed by %s", (_name, arrange) => {
    const fs = baseFs();
    fs.beforeMkdirFailure(ROOT, "EEXIST", () => {
      fs.addDirectory(ROOT, 0o700);
      arrange(fs);
    });

    expect(() => backend(fs)).toThrow(/^containment_unavailable:root/);
    expect(fs.trace).not.toContain(`mkdir:${PARENT}:700`);
  });

  test.each(["EACCES", "EIO"] as const)("rejects root creation %s without creating its parent", (code) => {
    const fs = baseFs();
    fs.mkdirFailures.set(ROOT, code);

    expect(() => backend(fs)).toThrow(/^containment_unavailable:root/);
    expect(fs.trace).not.toContain(`mkdir:${PARENT}:700`);
  });

  test("does not adopt a bare-message root creation EEXIST failure", () => {
    const fs = baseFs();
    fs.mkdir = () => {
      fs.addDirectory(ROOT, 0o700);
      throw new Error("EEXIST");
    };

    expect(() => backend(fs)).toThrow(/^containment_unavailable:root/);
    expect(fs.trace).not.toContain(`mkdir:${PARENT}:700`);
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

  test("prepare retains only a candidate until the created scope receives canonical proof", () => {
    const fs = baseFs();
    const resolved = backend(fs);
    fs.trace.length = 0;
    const first = resolved.prepareAttempt(ATTEMPT_ID);
    const second = resolved.prepareAttempt(ATTEMPT_ID);
    const candidateScope: AbsolutePath = first.candidate.scopePath;
    // @ts-expect-error lexical preparation is not observed runtime evidence.
    const _candidateAsObserved: RestorationContainmentDescriptor = first.candidate;
    // @ts-expect-error lexical preparation cannot produce a live canonical cgroup proof.
    const _candidateAsProven: CgroupScopePath = first.candidate.scopePath;
    void _candidateAsObserved;
    void _candidateAsProven;
    expect(first).toBe(second);
    expect(JSON.parse(JSON.stringify(first.candidate))).toEqual({ backend: "cgroup-v2", scopePath: ATTEMPT });
    expect(fs.trace).toEqual([]);
    expect(fs.directories.has(ATTEMPT)).toBeFalse();
    expect(() => first.proveRuntimeDescriptor(runtimeDescriptor())).toThrow(/^containment_unavailable:attempt scope/);

    fs.addDirectory(candidateScope);
    const proven: ContainmentDescriptor = first.proveRuntimeDescriptor(runtimeDescriptor());
    expect(proven.backend).toBe("cgroup-v2");
    expect(String(proven.scopePath)).toBe(candidateScope);
  });

  test.each([
    ["changed identity", `${PARENT}/different-attempt`],
    ["root escape", "/outside/attempt"],
  ])("runtime proof rejects a %s realpath", (_name, canonicalScope) => {
    const fs = baseFs();
    const resolved = backend(fs);
    const attempt = resolved.prepareAttempt(ATTEMPT_ID);
    fs.addDirectory(ATTEMPT);
    fs.reals.set(ATTEMPT, canonicalScope);

    expect(() => attempt.proveRuntimeDescriptor(runtimeDescriptor()))
      .toThrow(/^containment_unavailable:attempt scope/);
  });

  test("restore validates backend, exact identity and extant canonical containment without minting live proof", () => {
    const fs = baseFs();
    const resolved = backend(fs);
    const stored = runtimeDescriptor();
    const restored = resolved.restoreAttempt(ATTEMPT_ID, stored);
    const candidateScope: AbsolutePath = restored.candidate.scopePath;
    // @ts-expect-error restoration validation alone does not prove a live cgroup scope.
    const _restoredAsLive: CgroupScopePath = restored.candidate.scopePath;
    void _restoredAsLive;
    expect(candidateScope).toBe(stored.scopePath);
    expect(restored.candidate).toEqual(stored);
    expect(() => resolved.restoreAttempt(ATTEMPT_ID, runtimeDescriptor(`${ATTEMPT}-wrong`)))
      .toThrow(/^containment_unavailable:attempt descriptor/);
    const malformedDescriptor: RestorationContainmentDescriptor = { ...stored };
    Reflect.set(malformedDescriptor, "backend", "other");
    expect(() => resolved.restoreAttempt(ATTEMPT_ID, malformedDescriptor))
      .toThrow(/^containment_unavailable:attempt descriptor/);
    fs.addDirectory(ATTEMPT);
    fs.reals.set(ATTEMPT, `${PARENT}/different-attempt`);
    expect(() => resolved.restoreAttempt(ATTEMPT_ID, stored)).toThrow(/^containment_unavailable:attempt scope/);
    fs.reals.set(ATTEMPT, "/outside/attempt");
    expect(() => resolved.restoreAttempt(ATTEMPT_ID, stored)).toThrow(/^containment_unavailable:attempt scope/);
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
    const attempt = resolved.restoreAttempt(ATTEMPT_ID, runtimeDescriptor());
    await expect(attempt.cleanup()).rejects.toThrow(/^containment_unavailable:missing attempt scope/);
    await expect(attempt.cleanup(verifiedContainmentReceiptPath(containmentReceiptPath("/wrong", "receipt.json"))))
      .rejects.toThrow(/^containment_unavailable:missing attempt scope/);
  });

  test("terminate creates a no-process scope, proves empty, durably publishes v2 receipt, then removes", async () => {
    const root = temporaryStateRoot("pi-cgroup-receipt-");
    const state: string = root.path;
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
    } finally { root.cleanup(); }
  });

  test("termination kills before polling an initially empty scope", async () => {
    const root = temporaryStateRoot("pi-cgroup-termination-");
    const state: string = root.path;
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
    } finally { root.cleanup(); }
  });

  test("cleanup removes a proven-empty nested cgroup subtree leaf-first", async () => {
    const fs = baseFs();
    const receipt = containmentReceiptPath("/state", "receipt.json");
    const resolved = backend(fs, { receiptPathFor: () => receipt, diagnostic: (message) => fs.diagnostics.push(message) });
    const attempt = resolved.restoreAttempt(ATTEMPT_ID, runtimeDescriptor());
    const childRoot = `${ATTEMPT}/pi-subagents`;
    const childParent = `${childRoot}/${cgroupScopeName(agentId("child-session"))}`;
    const childAttempt = `${childParent}/${cgroupScopeName(runAttemptId("child-attempt"))}`;
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
    const attempt = resolved.restoreAttempt(ATTEMPT_ID, runtimeDescriptor());
    fs.addDirectory(ATTEMPT);
    fs.failure = "attempt-remove-once";
    const proof = verifiedContainmentReceiptPath(receipt);
    await expect(attempt.cleanup(proof)).resolves.toBeUndefined();
    expect(fs.diagnostics).toContain("containment_unavailable:attempt cleanup failed");
    fs.directories.delete(ATTEMPT);
    await expect(resolved.shutdown()).resolves.toBeUndefined();
  });

  test("receipt publication gates cleanup and failed first cleanup is retried by shutdown", async () => {
    const root = temporaryStateRoot("pi-cgroup-retry-");
    const state: string = root.path;
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
    } finally { root.cleanup(); }
  });

  test("shutdown rejects a genuine attempt-removal retry error and remains retryable without re-containing", async () => {
    const root = temporaryStateRoot("pi-cgroup-retry-error-");
    const state: string = root.path;
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
    } finally { root.cleanup(); }
  });

  test("reuses a parent scope found by the strict probe", () => {
    const fs = baseFs(ROOT, PARENT);
    const resolved = backend(fs);
    expect(String(resolved.parentScope)).toBe(PARENT);
    expect(fs.trace).not.toContain(`mkdir:${PARENT}:700`);
  });

  test("fails closed when parent mkdir loses an absent-check fast-restart race", () => {
    const fs = baseFs(ROOT);
    fs.beforeMkdirFailure(PARENT, "EEXIST", () => fs.addDirectory(PARENT));
    expect(() => backend(fs)).toThrow("containment_unavailable:parent scope");
  });

  test("shutdown removes the parent but retains a newly created default root", async () => {
    const fs = baseFs();
    const resolved = backend(fs);
    fs.trace.length = 0;

    await resolved.shutdown();

    expect(fs.trace).toEqual([`rmdir:${PARENT}`]);
    expect(fs.directories.has(ROOT)).toBeTrue();
  });

  test("shutdown leaves a configured root and removes only its parent", async () => {
    const configuredRoot = `${MOUNT}/delegated`;
    const fs = baseFs(configuredRoot);
    const resolved = backend(fs, { configuredRoot });
    fs.trace.length = 0;

    await resolved.shutdown();

    expect(fs.trace).toEqual([`rmdir:${resolved.parentScope}`]);
    expect(fs.directories.has(configuredRoot)).toBeTrue();
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
    parentSessionId: PARENT_ID,
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
  readonly modes = new Map<string, number>();
  readonly statFailures = new Map<string, string>();
  readonly mkdirFailures = new Map<string, string>();
  readonly trace: string[] = [];
  readonly diagnostics: string[] = [];
  failure?: string;
  private readonly beforeMkdirFailures = new Map<string, { code: string; action: () => void }>();
  private attemptRemovalFailed = false;

  constructor(paths: readonly string[]) { for (const path of paths) this.addDirectory(path); }
  addDirectory(path: string, mode = 0o700): void {
    this.directories.add(path);
    this.modes.set(path, mode);
    this.files.set(`${path}/cgroup.events`, ["populated 0\n"]);
    this.files.set(`${path}/cgroup.procs`, []);
  }
  beforeMkdirFailure(path: string, code: string, action: () => void): void {
    this.beforeMkdirFailures.set(path, { code, action });
  }
  readFile(path: string): string {
    const name = path.slice(path.lastIndexOf("/") + 1);
    if (name === "cgroup.events") {
      if (this.failure === "events") { this.failure = "events-recovery"; throw errno("EIO"); }
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
    throw errno("ENOENT");
  }
  writeFile(path: string, value: string): void {
    const name = path.slice(path.lastIndexOf("/") + 1);
    this.trace.push(`write:${name}:${value.trim()}`);
    if (name === "cgroup.procs" && this.failure === "move") throw errno("EACCES");
    if (name === "cgroup.kill" && this.failure === "kill") { this.failure = "kill-recovery"; throw errno("EACCES"); }
    this.files.set(path, [value]);
    if (name === "cgroup.kill" && this.failure !== "empty") {
      this.files.set(path.replace("cgroup.kill", "cgroup.events"), ["populated 1\n", "populated 0\n"]);
    }
  }
  mkdir(path: string, mode: number): void {
    const short = path.startsWith(PARENT + "/preflight-") ? path.slice(PARENT.length + 1) : path;
    this.trace.push(path.startsWith(PARENT + "/preflight-") ? `mkdir:${short}` : `mkdir:${short}:${mode.toString(8)}`);
    if (this.failure === "create" && path === PREFLIGHT) throw errno("EACCES");
    const beforeFailure = this.beforeMkdirFailures.get(path);
    if (beforeFailure !== undefined) {
      this.beforeMkdirFailures.delete(path);
      beforeFailure.action();
      throw errno(beforeFailure.code);
    }
    const failure = this.mkdirFailures.get(path);
    if (failure !== undefined) throw errno(failure);
    if (this.directories.has(path)) throw errno("EEXIST");
    this.addDirectory(path, mode);
  }
  realpath(path: string): string {
    if (!this.directories.has(path) && !this.nonDirectories.has(path)) throw errno("ENOENT");
    return this.reals.get(path) ?? path;
  }
  stat(path: string): { isDirectory(): boolean; mode: number } {
    const failure = this.statFailures.get(path);
    if (failure !== undefined) throw errno(failure);
    if (!this.directories.has(path) && !this.nonDirectories.has(path)) throw errno("ENOENT");
    return {
      isDirectory: () => !this.nonDirectories.has(path),
      mode: this.modes.get(path) ?? 0o100600,
    };
  }
  removeDirectory(path: string): void {
    const short = path.startsWith(PARENT + "/preflight-") ? path.slice(PARENT.length + 1) : path;
    this.trace.push(`rmdir:${short}`);
    if (this.failure === "remove" && path === PREFLIGHT) { this.failure = "remove-recovery"; throw errno("EIO"); }
    if (this.failure === "attempt-remove-once" && path === ATTEMPT && !this.attemptRemovalFailed) { this.attemptRemovalFailed = true; throw errno("EIO"); }
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
    pid: processId(4242),
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
