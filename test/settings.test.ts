import { describe, expect, test } from "bun:test";
import { getEventListeners } from "node:events";
import { mkdirSync, mkdtempSync, realpathSync, statSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  AbortError,
  Mutex,
  PersistenceSequencer,
  RunSemaphore,
  delayWithAbort,
  waitWithAbort,
} from "../src/async-primitives.ts";
import {
  containedPath,
  isContainedPath,
  realContainedPath,
  restoredStatePath,
  writeOwnerOnlyFile,
} from "../src/paths.ts";
import type { AbsolutePath } from "../src/domain.ts";
import { loadSubagentSettings, readGlobalMaxDepth, readSubagentSettingsFiles } from "../src/settings.ts";
import { boundedTreeChildCount } from "../src/delegation-policy.ts";

describe("Mutex", () => {
  test("grants the lock in FIFO order", async () => {
    const mutex = new Mutex();
    const order: number[] = [];

    const release0 = await mutex.acquire();
    const p1 = mutex.acquire().then((release) => {
      order.push(1);
      release();
    });
    const p2 = mutex.acquire().then((release) => {
      order.push(2);
      release();
    });
    const p3 = mutex.acquire().then((release) => {
      order.push(3);
      release();
    });

    order.push(0);
    release0();
    await Promise.all([p1, p2, p3]);

    expect(order).toEqual([0, 1, 2, 3]);
  });

  test("runExclusive serializes concurrent callers", async () => {
    const mutex = new Mutex();
    let active = 0;
    let maxActive = 0;

    const task = async () => {
      await mutex.runExclusive(async () => {
        active += 1;
        maxActive = Math.max(maxActive, active);
        await new Promise((resolve) => setTimeout(resolve, 1));
        active -= 1;
      });
    };

    await Promise.all([task(), task(), task(), task()]);
    expect(maxActive).toBe(1);
  });
});

describe("RunSemaphore", () => {
  test("caps concurrent tryAcquire() at capacity", () => {
    const semaphore = new RunSemaphore(4);
    const reservations = [
      semaphore.tryAcquire(),
      semaphore.tryAcquire(),
      semaphore.tryAcquire(),
      semaphore.tryAcquire(),
    ];
    expect(reservations.every((r) => r !== undefined)).toBe(true);
    expect(semaphore.tryAcquire()).toBeUndefined();
  });

  test("release is one-time; a second release does not free an extra slot", () => {
    const semaphore = new RunSemaphore(1);
    const reservation = semaphore.tryAcquire();
    expect(reservation).toBeDefined();
    reservation?.release();
    reservation?.release();
    expect(semaphore.activeCount).toBe(0);

    const second = semaphore.tryAcquire();
    expect(second).toBeDefined();
    expect(semaphore.tryAcquire()).toBeUndefined();
  });

  test("releasing frees a slot for a subsequent tryAcquire()", () => {
    const semaphore = new RunSemaphore(1);
    const first = semaphore.tryAcquire();
    expect(semaphore.tryAcquire()).toBeUndefined();
    first?.release();
    expect(semaphore.tryAcquire()).toBeDefined();
  });

  test("rejects a non-positive-integer capacity", () => {
    expect(() => new RunSemaphore(0)).toThrow(/invalid_input/);
    expect(() => new RunSemaphore(-1)).toThrow(/invalid_input/);
    expect(() => new RunSemaphore(1.5)).toThrow(/invalid_input/);
  });
});

describe("PersistenceSequencer", () => {
  test("append groups remain contiguous under concurrent callers", async () => {
    const written: string[] = [];
    const sequencer = new PersistenceSequencer<string>((event) => {
      written.push(event);
    });

    const groupA = sequencer.withGroup(async (append) => {
      await append("a1");
      await new Promise((resolve) => setTimeout(resolve, 1));
      await append("a2");
    });
    const groupB = sequencer.withGroup(async (append) => {
      await append("b1");
      await append("b2");
    });

    await Promise.all([groupA, groupB]);

    const isContiguous =
      (written[0] === "a1" && written[1] === "a2" && written[2] === "b1" && written[3] === "b2") ||
      (written[0] === "b1" && written[1] === "b2" && written[2] === "a1" && written[3] === "a2");
    expect(isContiguous).toBe(true);
  });
});

describe("waitWithAbort", () => {
  test("rejects with AbortError and removes its listener when the signal aborts first", async () => {
    const controller = new AbortController();
    const never = new Promise<void>(() => {});

    const waiting = waitWithAbort(never, controller.signal);
    expect(getEventListeners(controller.signal, "abort").length).toBe(1);

    controller.abort();
    await expect(waiting).rejects.toBeInstanceOf(AbortError);
    expect(getEventListeners(controller.signal, "abort").length).toBe(0);
  });

  test("removes its listener when the promise settles first", async () => {
    const controller = new AbortController();
    const resolved = Promise.resolve(42);

    const result = await waitWithAbort(resolved, controller.signal);
    expect(result).toBe(42);
    expect(getEventListeners(controller.signal, "abort").length).toBe(0);
  });

  test("delayWithAbort rejects immediately when the launch deadline aborts", async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(delayWithAbort(25, controller.signal)).rejects.toBeInstanceOf(AbortError);
  });
});

describe("paths", () => {
  test("a sibling directory with a shared prefix is never contained", () => {
    expect(isContainedPath("/trusted/project", "/trusted/project2")).toBe(false);
    expect(isContainedPath("/trusted/project", "/trusted/project2/file.txt")).toBe(false);
  });

  test("a nested path is contained", () => {
    expect(isContainedPath("/trusted/project", "/trusted/project/sub/file.txt")).toBe(true);
    expect(isContainedPath("/trusted/project", "/trusted/project")).toBe(true);
  });

  test("containedPath throws on escape via ..", () => {
    expect(() => containedPath("/trusted/project", "../escape")).toThrow(/invalid_input/);
  });

  test("containedPath accepts a nested relative child", () => {
    const result = containedPath("/trusted/project", "sub/file.txt");
    expect(result as string).toBe("/trusted/project/sub/file.txt");
  });

  test("realContainedPath rejects a symlink that escapes the parent", () => {
    const root = mkdtempSync(join(tmpdir(), "pi-subagents-paths-"));
    const parent = join(root, "parent");
    const outside = join(root, "outside");
    const escapeLink = join(parent, "escape");

    mkdirSync(parent, { recursive: true });
    mkdirSync(outside, { recursive: true });
    symlinkSync(outside, escapeLink);

    expect(() => realContainedPath(parent, "escape")).toThrow(/invalid_input/);
  });

  test("realContainedPath accepts a symlink that stays within the parent", () => {
    const root = mkdtempSync(join(tmpdir(), "pi-subagents-paths-"));
    const parent = join(root, "parent");
    const target = join(parent, "real-target");
    const insideLink = join(parent, "inside-link");

    mkdirSync(target, { recursive: true });
    symlinkSync(target, insideLink);

    const result = realContainedPath(parent, "inside-link");
    expect(result as string).toBe(realpathSync(target));
  });

  test("restoredStatePath rejects an existing symlink escape after lexical containment", () => {
    const root = mkdtempSync(join(tmpdir(), "pi-subagents-restored-paths-"));
    const state = join(root, "state"); const outside = join(root, "outside");
    mkdirSync(state); mkdirSync(outside);
    const escape = join(state, "escape"); symlinkSync(outside, escape);
    expect(() => restoredStatePath(state, escape)).toThrow(/invalid_input/);
  });

  test("writeOwnerOnlyFile creates owner-only files and directories", () => {
    const root = mkdtempSync(join(tmpdir(), "pi-subagents-paths-"));
    const nested = join(root, "state", "child", "file.json") as AbsolutePath;

    writeOwnerOnlyFile(nested, '{"ok":true}');

    const fileMode = statSync(nested).mode & 0o777;
    const dirMode = statSync(join(root, "state", "child")).mode & 0o777;
    expect(fileMode).toBe(0o600);
    expect(dirMode).toBe(0o700);
  });
});

describe("readSubagentSettingsFiles", () => {
  test("reads the global and trusted custom project settings paths exactly", () => {
    const reads: string[] = [];
    const files = new Map([
      ["/agent/settings.json", '{"subagents":{"maxConcurrentRuns":2}}'],
      ["/project/.brand/settings.json", '{"subagents":{"maxConcurrentRuns":7}}'],
      ["/project/.pi/settings.json", '{"subagents":{"maxConcurrentRuns":9}}'],
    ]);
    const readOptional = (path: string): string | undefined => {
      reads.push(path);
      return files.get(path);
    };

    expect(readSubagentSettingsFiles({
      agentDir: "/agent",
      cwd: "/project",
      projectTrusted: true,
      configDirName: ".brand",
      readOptional,
    })).toEqual({
      globalText: '{"subagents":{"maxConcurrentRuns":2}}',
      projectText: '{"subagents":{"maxConcurrentRuns":7}}',
    });
    expect(reads).toEqual(["/agent/settings.json", "/project/.brand/settings.json"]);

    reads.length = 0;
    expect(readSubagentSettingsFiles({
      agentDir: "/agent",
      cwd: "/project",
      projectTrusted: false,
      configDirName: ".brand",
      readOptional,
    })).toEqual({ globalText: '{"subagents":{"maxConcurrentRuns":2}}' });
    expect(reads).toEqual(["/agent/settings.json"]);

    const loaded = loadSubagentSettings({
      ...readSubagentSettingsFiles({
        agentDir: "/agent",
        cwd: "/project",
        projectTrusted: true,
        configDirName: ".brand",
        readOptional,
      }),
      projectTrusted: true,
    });
    expect(loaded.value.maxConcurrentRuns).toBe(7);
  });
});

describe("loadSubagentSettings", () => {
  test("a trusted project value overrides the global value", () => {
    const result = loadSubagentSettings({
      globalText: '{"subagents":{"maxConcurrentRuns":3}}',
      projectText: '{"subagents":{"maxConcurrentRuns":6}}',
      projectTrusted: true,
    });
    expect(result.value.maxConcurrentRuns).toBe(6);
    expect(result.diagnostics).toEqual([]);
  });

  test("an untrusted project value never overrides the global value", () => {
    const result = loadSubagentSettings({
      globalText: '{"subagents":{"maxConcurrentRuns":3}}',
      projectText: '{"subagents":{"maxConcurrentRuns":6}}',
      projectTrusted: false,
    });
    expect(result.value.maxConcurrentRuns).toBe(3);
  });

  test("an untrusted project's settings text is never read", () => {
    let accessed = false;
    const options = {
      globalText: '{"subagents":{"maxConcurrentRuns":3}}',
      projectTrusted: false,
      get projectText(): string {
        accessed = true;
        return '{"subagents":{"maxConcurrentRuns":6}}';
      },
    };

    const result = loadSubagentSettings(options);

    expect(accessed).toBe(false);
    expect(result.value.maxConcurrentRuns).toBe(3);
  });

  test("falls back to the default when no settings files exist", () => {
    const result = loadSubagentSettings({ projectTrusted: false });
    expect(result.value.maxConcurrentRuns).toBe(4);
  });

  test("malformed global JSON falls back to the default and emits a diagnostic", () => {
    const result = loadSubagentSettings({
      globalText: "{not valid json",
      projectTrusted: false,
    });
    expect(result.value.maxConcurrentRuns).toBe(4);
    expect(result.diagnostics.length).toBe(1);
  });

  test("an out-of-range maxConcurrentRuns falls back and emits a diagnostic", () => {
    const result = loadSubagentSettings({
      globalText: '{"subagents":{"maxConcurrentRuns":0}}',
      projectTrusted: false,
    });
    expect(result.value.maxConcurrentRuns).toBe(4);
    expect(result.diagnostics.length).toBe(1);
  });

  test("a fractional maxConcurrentRuns falls back and emits a diagnostic", () => {
    const result = loadSubagentSettings({
      globalText: '{"subagents":{"maxConcurrentRuns":2.5}}',
      projectTrusted: false,
    });
    expect(result.value.maxConcurrentRuns).toBe(4);
    expect(result.diagnostics.length).toBe(1);
  });

  test("an invalid trusted project value falls back to the global value", () => {
    const result = loadSubagentSettings({
      globalText: '{"subagents":{"maxConcurrentRuns":3}}',
      projectText: '{"subagents":{"maxConcurrentRuns":-1}}',
      projectTrusted: true,
    });
    expect(result.value.maxConcurrentRuns).toBe(3);
    expect(result.diagnostics.length).toBe(1);
  });

  test("uses only the global cgroup root while allowing project concurrency", () => {
    const configured = loadSubagentSettings({
      globalText: JSON.stringify({ subagents: { maxConcurrentRuns: 2, cgroupRoot: "/sys/fs/cgroup/delegated" } }),
      projectText: JSON.stringify({ subagents: { maxConcurrentRuns: 1, cgroupRoot: "/sys/fs/cgroup/project" } }),
      projectTrusted: true,
    });
    expect(configured.value).toEqual({
      maxConcurrentRuns: 1,
      maxDepth: 1,
      cgroupRoot: "/sys/fs/cgroup/delegated",
    });
    expect(configured.diagnostics).toContain(
      "project subagents.cgroupRoot is global-only; ignoring",
    );
  });

  test("resolves the default and global-only depth", () => {
    expect(loadSubagentSettings({ projectTrusted: false }).value).toMatchObject({
      maxConcurrentRuns: 4,
      maxDepth: 1,
    });
    expect(loadSubagentSettings({
      globalText: '{"subagents":{"maxDepth":0}}', projectTrusted: false,
    }).value.maxDepth).toBe(0);
    expect(loadSubagentSettings({
      globalText: '{"subagents":{"maxConcurrentRuns":1,"maxDepth":8}}', projectTrusted: false,
    }).value.maxDepth).toBe(8);
  });

  test.each([-1, 9, 20, 1.5, "2"])("rejects invalid depth %p", (maxDepth) => {
    const result = loadSubagentSettings({
      globalText: JSON.stringify({ subagents: { maxDepth } }), projectTrusted: false,
    });
    expect(result.value.maxDepth).toBe(1);
    expect(result.diagnostics).toContain(
      "global subagents.maxDepth must be an integer from 0 through 8; ignoring",
    );
  });

  test("rejects an unsafe concurrency capacity", () => {
    const result = loadSubagentSettings({
      globalText: JSON.stringify({ subagents: { maxConcurrentRuns: Number.MAX_SAFE_INTEGER + 1 } }),
      projectTrusted: false,
    });
    expect(result.value.maxConcurrentRuns).toBe(4);
    expect(result.diagnostics).toContain(
      "global subagents.maxConcurrentRuns must be a positive safe integer; ignoring",
    );
  });

  test("ignores project depth while retaining trusted project concurrency", () => {
    const result = loadSubagentSettings({
      globalText: '{"subagents":{"maxConcurrentRuns":4,"maxDepth":2}}',
      projectText: '{"subagents":{"maxConcurrentRuns":5,"maxDepth":3}}', projectTrusted: true,
    });
    expect(result.value).toMatchObject({ maxConcurrentRuns: 5, maxDepth: 2 });
    expect(result.diagnostics).toContain("project subagents.maxDepth is global-only; ignoring");
  });

  test("bounds a trusted project concurrency override with global depth", () => {
    const result = loadSubagentSettings({
      globalText: '{"subagents":{"maxConcurrentRuns":4,"maxDepth":3}}',
      projectText: '{"subagents":{"maxConcurrentRuns":5}}',
      projectTrusted: true,
    });
    expect(result.value).toMatchObject({ maxConcurrentRuns: 5, maxDepth: 1 });
    expect(result.diagnostics).toContain(
      "subagents maxDepth 3 with maxConcurrentRuns 5 allows more than 100 concurrent child processes; using maxDepth 1",
    );
  });

  test("bounds the joint recursive budget", () => {
    expect(loadSubagentSettings({
      globalText: '{"subagents":{"maxConcurrentRuns":4,"maxDepth":2}}', projectTrusted: false,
    }).value).toMatchObject({ maxConcurrentRuns: 4, maxDepth: 2 });
    const excessive = loadSubagentSettings({
      globalText: '{"subagents":{"maxConcurrentRuns":5,"maxDepth":3}}', projectTrusted: false,
    });
    expect(excessive.value).toMatchObject({ maxConcurrentRuns: 5, maxDepth: 1 });
    expect(excessive.diagnostics).toContain(
      "subagents maxDepth 3 with maxConcurrentRuns 5 allows more than 100 concurrent child processes; using maxDepth 1",
    );
  });

  test("inherits descendant limits without local concurrency or depth overrides", () => {
    const result = loadSubagentSettings({
      globalText: '{"subagents":{"maxConcurrentRuns":9,"maxDepth":3}}',
      projectText: '{"subagents":{"maxConcurrentRuns":8,"maxDepth":4}}',
      projectTrusted: true,
      inheritedLimits: { maxConcurrentRuns: 2, maxDepth: 2 },
    });
    expect(result.value).toMatchObject({ maxConcurrentRuns: 2, maxDepth: 2 });
    expect(result.diagnostics).toContain("project subagents.maxDepth is global-only; ignoring");
  });

  test("counts bounded recursive capacity without overflow and preserves depth-one capacity", () => {
    expect(boundedTreeChildCount(100, 1)).toBe(100);
    expect(boundedTreeChildCount(101, 1)).toBe(101);
    expect(boundedTreeChildCount(Number.MAX_SAFE_INTEGER, 2)).toBe(101);
    expect(boundedTreeChildCount(Number.MAX_SAFE_INTEGER, 1)).toBe(101);
    expect(loadSubagentSettings({
      globalText: JSON.stringify({ subagents: { maxConcurrentRuns: Number.MAX_SAFE_INTEGER, maxDepth: 1 } }),
      projectTrusted: false,
    }).value).toMatchObject({ maxConcurrentRuns: Number.MAX_SAFE_INTEGER, maxDepth: 1 });
    expect(readGlobalMaxDepth('{"subagents":{"maxDepth":2}}')).toBe(2);
    expect(readGlobalMaxDepth("not JSON")).toBe(1);
  });

  test("rejects invalid global cgroup roots and never supplies a project root", () => {
    for (const cgroupRoot of ["relative", "", "bad\u0000path", 1]) {
      const result = loadSubagentSettings({
        globalText: JSON.stringify({ subagents: { cgroupRoot } }),
        projectText: JSON.stringify({ subagents: { cgroupRoot: "/sys/fs/cgroup/project" } }),
        projectTrusted: true,
      });
      expect(result.value).toEqual({ maxConcurrentRuns: 4, maxDepth: 1 });
      expect(result.diagnostics).toContain(
        "global subagents.cgroupRoot must be an absolute path; ignoring",
      );
      expect(result.diagnostics).toContain(
        "project subagents.cgroupRoot is global-only; ignoring",
      );
    }
  });
});
