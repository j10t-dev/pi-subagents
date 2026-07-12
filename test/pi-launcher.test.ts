import { describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { buildRpcLaunchSpec, resolvePiInvocation } from "../src/pi-launcher.ts";

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
      invocation: { command: "/pi" as never, argsPrefix: [] },
      cwd: "/work" as never,
      childSessionDir: "/sessions" as never,
      effectiveModel: "mock-provider/luna" as never,
      effectiveThinking: "high" as const,
      ...override,
    });

    const allowlistArgs = buildRpcLaunchSpec(base({ effectiveTools: ["read", "web_fetch"] })).args;
    expect(allowlistArgs.slice(allowlistArgs.indexOf("--tools"), allowlistArgs.indexOf("--tools") + 2))
      .toContainAllValues(["--tools", "read,web_fetch"]);
    expect(buildRpcLaunchSpec(base({ effectiveTools: [] })).args).toContain("--no-tools");
    expect(buildRpcLaunchSpec(base({ effectiveTools: [] })).args).not.toContain("--tools");
  });

  test("builds the exact RPC prefix and isolated environment", () => {
    const spec = buildRpcLaunchSpec({ invocation: { command: "/usr/bin/node" as never, argsPrefix: ["/pi.js"] }, cwd: "/work" as never,
      childSessionDir: "/state/child" as never, effectiveTools: ["read", "bash"], effectiveModel: "openai/gpt" as never,
      effectiveThinking: "high", env: { HOME: "/home/me" } });
    expect(spec.args).toEqual([
      "/pi.js",
      "--mode", "rpc",
      "--session-dir", "/state/child",
      "--model", "openai/gpt",
      "--thinking", "high",
      "--tools", "read,bash",
    ]);
    expect(spec).toMatchObject({ command: "/usr/bin/node", cwd: "/work", shell: false });
    expect(spec.env.PI_SUBAGENT_CHILD).toBe("1");
    expect(Object.isFrozen(spec)).toBe(true);
  });
  test("adds trust only for realpath-contained cwd", () => {
    const root = mkdtempSync(join(tmpdir(), "launcher-")); mkdirSync(join(root, "project", "child"), { recursive: true }); mkdirSync(join(root, "outside"));
    symlinkSync(join(root, "outside"), join(root, "project", "escape"));
    const base = { invocation: { command: "/pi" as never, argsPrefix: [] }, childSessionDir: "/sessions" as never, effectiveTools: [], effectiveModel: "x" as never, effectiveThinking: "low" as const, trustedRoot: join(root, "project") as never };
    expect(buildRpcLaunchSpec({ ...base, cwd: join(root, "project", "child") as never }).args).toContain("--approve");
    expect(buildRpcLaunchSpec({ ...base, cwd: join(root, "project2") as never }).args).not.toContain("--approve");
    expect(buildRpcLaunchSpec({ ...base, cwd: join(root, "project", "escape") as never }).args).not.toContain("--approve");
  });
});
