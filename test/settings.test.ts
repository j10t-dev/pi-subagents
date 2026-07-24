import { describe, expect, test } from "bun:test";

import { loadSubagentSettings, readGlobalMaxDepth, readSubagentSettingsFiles } from "../src/settings.ts";
import { boundedTreeChildCount, canDelegateFrom } from "../src/delegation-policy.ts";
import { delegationDepth, processCount, runCapacity, type AbsolutePath } from "../src/domain.ts";

const DEPTH = delegationDepth(1);
const CAPACITY = runCapacity(4);
// @ts-expect-error delegation APIs reject run capacities where a depth is required.
const _delegateWithCapacity = () => canDelegateFrom(CAPACITY, DEPTH);
// @ts-expect-error bounded tree capacity rejects delegation depth.
const _treeWithDepthCapacity = () => boundedTreeChildCount(DEPTH, DEPTH);
void _delegateWithCapacity;
void _treeWithDepthCapacity;
import { testAbsolutePath } from "./support/brands.ts";

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
      agentDir: testAbsolutePath("/agent"),
      cwd: testAbsolutePath("/project"),
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
      agentDir: testAbsolutePath("/agent"),
      cwd: testAbsolutePath("/project"),
      projectTrusted: false,
      configDirName: ".brand",
      readOptional,
    })).toEqual({ globalText: '{"subagents":{"maxConcurrentRuns":2}}' });
    expect(reads).toEqual(["/agent/settings.json"]);

    const loaded = loadSubagentSettings({
      ...readSubagentSettingsFiles({
        agentDir: testAbsolutePath("/agent"),
        cwd: testAbsolutePath("/project"),
        projectTrusted: true,
        configDirName: ".brand",
        readOptional,
      }),
      projectTrusted: true,
    });
    expect(loaded.value.maxConcurrentRuns).toBe(runCapacity(7));
  });
});

describe("loadSubagentSettings", () => {
  test("a trusted project value overrides the global value", () => {
    const result = loadSubagentSettings({
      globalText: '{"subagents":{"maxConcurrentRuns":3}}',
      projectText: '{"subagents":{"maxConcurrentRuns":6}}',
      projectTrusted: true,
    });
    expect(result.value.maxConcurrentRuns).toBe(runCapacity(6));
    expect(result.diagnostics).toEqual([]);
  });

  test("an untrusted project value never overrides the global value", () => {
    const result = loadSubagentSettings({
      globalText: '{"subagents":{"maxConcurrentRuns":3}}',
      projectText: '{"subagents":{"maxConcurrentRuns":6}}',
      projectTrusted: false,
    });
    expect(result.value.maxConcurrentRuns).toBe(runCapacity(3));
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
    expect(result.value.maxConcurrentRuns).toBe(runCapacity(3));
  });

  test("falls back to the default when no settings files exist", () => {
    const result = loadSubagentSettings({ projectTrusted: false });
    expect(result.value.maxConcurrentRuns).toBe(runCapacity(4));
  });

  test("malformed global JSON falls back to the default and emits a diagnostic", () => {
    const result = loadSubagentSettings({
      globalText: "{not valid json",
      projectTrusted: false,
    });
    expect(result.value.maxConcurrentRuns).toBe(runCapacity(4));
    expect(result.diagnostics.length).toBe(1);
  });

  test("an out-of-range maxConcurrentRuns falls back and emits a diagnostic", () => {
    const result = loadSubagentSettings({
      globalText: '{"subagents":{"maxConcurrentRuns":0}}',
      projectTrusted: false,
    });
    expect(result.value.maxConcurrentRuns).toBe(runCapacity(4));
    expect(result.diagnostics.length).toBe(1);
  });

  test("a fractional maxConcurrentRuns falls back and emits a diagnostic", () => {
    const result = loadSubagentSettings({
      globalText: '{"subagents":{"maxConcurrentRuns":2.5}}',
      projectTrusted: false,
    });
    expect(result.value.maxConcurrentRuns).toBe(runCapacity(4));
    expect(result.diagnostics.length).toBe(1);
  });

  test("an invalid trusted project value falls back to the global value", () => {
    const result = loadSubagentSettings({
      globalText: '{"subagents":{"maxConcurrentRuns":3}}',
      projectText: '{"subagents":{"maxConcurrentRuns":-1}}',
      projectTrusted: true,
    });
    expect(result.value.maxConcurrentRuns).toBe(runCapacity(3));
    expect(result.diagnostics.length).toBe(1);
  });

  test("uses only the global cgroup root while allowing project concurrency", () => {
    const configured = loadSubagentSettings({
      globalText: JSON.stringify({ subagents: { maxConcurrentRuns: 2, cgroupRoot: "/sys/fs/cgroup/delegated" } }),
      projectText: JSON.stringify({ subagents: { maxConcurrentRuns: 1, cgroupRoot: "/sys/fs/cgroup/project" } }),
      projectTrusted: true,
    });
    const cgroupRoot: AbsolutePath | undefined = configured.value.cgroupRoot;
    expect(String(cgroupRoot)).toBe("/sys/fs/cgroup/delegated");
    expect(configured.value).toEqual({
      maxConcurrentRuns: runCapacity(1),
      maxDepth: delegationDepth(1),
      cgroupRoot: testAbsolutePath("/sys/fs/cgroup/delegated"),
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
    }).value.maxDepth).toBe(delegationDepth(0));
    expect(loadSubagentSettings({
      globalText: '{"subagents":{"maxConcurrentRuns":1,"maxDepth":8}}', projectTrusted: false,
    }).value.maxDepth).toBe(delegationDepth(8));
  });

  test.each([-1, 9, 20, 1.5, "2"])("rejects invalid depth %p", (maxDepth) => {
    const result = loadSubagentSettings({
      globalText: JSON.stringify({ subagents: { maxDepth } }), projectTrusted: false,
    });
    expect(result.value.maxDepth).toBe(delegationDepth(1));
    expect(result.diagnostics).toContain(
      "global subagents.maxDepth must be an integer from 0 through 8; ignoring",
    );
  });

  test("rejects an unsafe concurrency capacity", () => {
    const result = loadSubagentSettings({
      globalText: JSON.stringify({ subagents: { maxConcurrentRuns: Number.MAX_SAFE_INTEGER + 1 } }),
      projectTrusted: false,
    });
    expect(result.value.maxConcurrentRuns).toBe(runCapacity(4));
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
      inheritedLimits: { maxConcurrentRuns: runCapacity(2), maxDepth: delegationDepth(2) },
    });
    expect(result.value).toMatchObject({ maxConcurrentRuns: 2, maxDepth: 2 });
    expect(result.diagnostics).toContain("project subagents.maxDepth is global-only; ignoring");
  });

  test("counts bounded recursive capacity without overflow and preserves depth-one capacity", () => {
    expect(boundedTreeChildCount(runCapacity(100), delegationDepth(1))).toBe(processCount(100));
    expect(boundedTreeChildCount(runCapacity(101), delegationDepth(1))).toBe(processCount(101));
    expect(boundedTreeChildCount(runCapacity(Number.MAX_SAFE_INTEGER), delegationDepth(2))).toBe(processCount(101));
    expect(boundedTreeChildCount(runCapacity(Number.MAX_SAFE_INTEGER), delegationDepth(1))).toBe(processCount(101));
    expect(loadSubagentSettings({
      globalText: JSON.stringify({ subagents: { maxConcurrentRuns: Number.MAX_SAFE_INTEGER, maxDepth: 1 } }),
      projectTrusted: false,
    }).value).toMatchObject({ maxConcurrentRuns: Number.MAX_SAFE_INTEGER, maxDepth: 1 });
    expect(readGlobalMaxDepth('{"subagents":{"maxDepth":2}}')).toBe(delegationDepth(2));
    expect(readGlobalMaxDepth("not JSON")).toBe(delegationDepth(1));
  });

  test("rejects invalid global cgroup roots and never supplies a project root", () => {
    for (const cgroupRoot of ["relative", "", "bad\u0000path", 1]) {
      const result = loadSubagentSettings({
        globalText: JSON.stringify({ subagents: { cgroupRoot } }),
        projectText: JSON.stringify({ subagents: { cgroupRoot: "/sys/fs/cgroup/project" } }),
        projectTrusted: true,
      });
      expect(result.value).toEqual({ maxConcurrentRuns: runCapacity(4), maxDepth: delegationDepth(1) });
      expect(result.diagnostics).toContain(
        "global subagents.cgroupRoot must be an absolute path; ignoring",
      );
      expect(result.diagnostics).toContain(
        "project subagents.cgroupRoot is global-only; ignoring",
      );
    }
  });
});
