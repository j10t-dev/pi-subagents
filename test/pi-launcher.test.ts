import { describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { buildRpcLaunchSpec, resolvePiInvocation } from "../src/pi-launcher.ts";
import { testAbsolutePath, testModelSpec } from "./support/brands.ts";

describe("resolvePiInvocation", () => {
  test("uses Node with the exact parent script", () => {
    expect(resolvePiInvocation({ execPath: "/usr/bin/node", argv: ["node", "/opt/pi/cli.js"] }) as unknown).toEqual({
      command: "/usr/bin/node", argsPrefix: ["/opt/pi/cli.js"],
    });
  });
  test("uses Bun with the exact parent script", () => {
    expect(resolvePiInvocation({ execPath: "/usr/bin/bun", argv: ["bun", "/opt/pi/cli.ts"] }) as unknown).toEqual({
      command: "/usr/bin/bun", argsPrefix: ["/opt/pi/cli.ts"],
    });
  });
  test("uses a compiled Pi executable directly", () => {
    expect(resolvePiInvocation({ execPath: "/opt/pi/pi", argv: ["/opt/pi/pi"] }) as unknown).toEqual({ command: "/opt/pi/pi", argsPrefix: [] });
  });
  test("fails closed for an absolute unrecognised runtime without a script", () => {
    expect(() => resolvePiInvocation({ execPath: "/usr/bin/custom-runtime", argv: ["/usr/bin/custom-runtime"] })).toThrow(/same Pi entry point/);
  });
  test("fails closed for Bun without a resolvable Pi script", () => {
    expect(() => resolvePiInvocation({ execPath: "/usr/bin/bun", argv: ["/usr/bin/bun"] })).toThrow(/same Pi entry point/);
  });
  test("fails closed for Node without a resolvable Pi script", () => {
    expect(() => resolvePiInvocation({ execPath: "/usr/bin/node", argv: ["/usr/bin/node"] })).toThrow(/same Pi entry point/);
  });
});

describe("buildRpcLaunchSpec", () => {
  test("uses an exact allowlist or explicit no-tools argument", () => {
    const base = (override: { effectiveTools: readonly string[] }) => ({
      invocation: { command: testAbsolutePath("/pi"), argsPrefix: [] },
      cwd: testAbsolutePath("/work"),
      childSessionDir: testAbsolutePath("/sessions"),
      effectiveModel: testModelSpec("mock-provider/luna"),
      effectiveThinking: "high" as const,
      childDepth: 1,
      maxDepth: 1,
      maxConcurrentRuns: 4,
      ...override,
    });

    const allowlistArgs = buildRpcLaunchSpec(base({ effectiveTools: ["read", "web_fetch"] })).args;
    expect(allowlistArgs.slice(allowlistArgs.indexOf("--tools"), allowlistArgs.indexOf("--tools") + 2))
      .toContainAllValues(["--tools", "read,web_fetch"]);
    expect(buildRpcLaunchSpec(base({ effectiveTools: [] })).args).toContain("--no-tools");
    expect(buildRpcLaunchSpec(base({ effectiveTools: [] })).args).not.toContain("--tools");
  });

  test("builds the exact RPC prefix and rewrites managed environment without mutating its caller", () => {
    const env = {
      HOME: "/home/me",
      PI_SUBAGENT_CHILD: "stale",
      PI_SUBAGENT_DEPTH: "99",
      PI_SUBAGENT_MAX_DEPTH: "99",
      PI_SUBAGENT_MAX_CONCURRENT_RUNS: "99",
    };
    const before = JSON.stringify(env);
    const spec = buildRpcLaunchSpec({ invocation: { command: testAbsolutePath("/usr/bin/node"), argsPrefix: ["/pi.js"] }, cwd: testAbsolutePath("/work"),
      childSessionDir: testAbsolutePath("/state/child"), effectiveTools: ["read", "bash"], effectiveModel: testModelSpec("openai/gpt"),
      effectiveThinking: "high", env, childDepth: 1, maxDepth: 2, maxConcurrentRuns: 4 });
    expect(spec.args).toEqual([
      "/pi.js",
      "--mode", "rpc",
      "--session-dir", "/state/child",
      "--model", "openai/gpt",
      "--thinking", "high",
      "--tools", "read,bash",
    ]);
    expect(spec).toMatchObject({ command: "/usr/bin/node", cwd: "/work", shell: false });
    expect(spec.env).toMatchObject({
      PI_SUBAGENT_CHILD: "1",
      PI_SUBAGENT_DEPTH: "1",
      PI_SUBAGENT_MAX_DEPTH: "2",
      PI_SUBAGENT_MAX_CONCURRENT_RUNS: "4",
    });
    expect(JSON.stringify(env)).toBe(before);
    expect(Object.isFrozen(spec)).toBe(true);
  });
  test("adds trust only for realpath-contained cwd", () => {
    const root = mkdtempSync(join(tmpdir(), "launcher-")); mkdirSync(join(root, "project", "child"), { recursive: true }); mkdirSync(join(root, "outside"));
    symlinkSync(join(root, "outside"), join(root, "project", "escape"));
    const base = { invocation: { command: testAbsolutePath("/pi"), argsPrefix: [] }, childSessionDir: testAbsolutePath("/sessions"), effectiveTools: [], effectiveModel: testModelSpec("x"), effectiveThinking: "low" as const, trustedRoot: testAbsolutePath(join(root, "project")), childDepth: 1, maxDepth: 1, maxConcurrentRuns: 4 };
    expect(buildRpcLaunchSpec({ ...base, cwd: testAbsolutePath(join(root, "project", "child")) }).args).toContain("--approve");
    expect(buildRpcLaunchSpec({ ...base, cwd: testAbsolutePath(join(root, "project2")) }).args).not.toContain("--approve");
    expect(buildRpcLaunchSpec({ ...base, cwd: testAbsolutePath(join(root, "project", "escape")) }).args).not.toContain("--approve");
  });
});
