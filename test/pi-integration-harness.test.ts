import { describe, expect, test } from "bun:test";

import {
  adaptParentPiEnvironmentForRpcClient,
  createParentPiEnvironment,
  reportIntegrationCli,
  resolveIntegrationCli,
  type IntegrationCliRuntime,
} from "./support/pi-integration-harness.ts";

describe("createParentPiEnvironment", () => {
  test("returns isolated parent environments and removes inherited child-only state last", () => {
    const base = {
      BASE_MARKER: "base",
      PI_SUBAGENT_CHILD: "1",
      MOCK_PROVIDER_CHILD_LAUNCH_DIR: "/stale-launches",
    } satisfies NodeJS.ProcessEnv;
    const extra = {
      EXTRA_MARKER: "extra",
      PI_SUBAGENT_CHILD: "1",
    } satisfies NodeJS.ProcessEnv;

    const first = createParentPiEnvironment({
      base,
      extra,
      agentDir: "/tmp/agent-a",
      home: "/tmp/home-a",
      childLaunchDir: "/tmp/launch-a",
    });
    const second = createParentPiEnvironment({
      base,
      agentDir: "/tmp/agent-b",
      home: "/tmp/home-b",
    });

    expect(first).toMatchObject({
      BASE_MARKER: "base",
      EXTRA_MARKER: "extra",
      PI_CODING_AGENT_DIR: "/tmp/agent-a",
      HOME: "/tmp/home-a",
      MOCK_PROVIDER_NO_NETWORK: "1",
      MOCK_PROVIDER_CHILD_LAUNCH_DIR: "/tmp/launch-a",
    });
    expect(first.PI_SUBAGENT_CHILD).toBeUndefined();
    expect(second).toMatchObject({
      BASE_MARKER: "base",
      PI_CODING_AGENT_DIR: "/tmp/agent-b",
      HOME: "/tmp/home-b",
      MOCK_PROVIDER_NO_NETWORK: "1",
    });
    expect(second.PI_SUBAGENT_CHILD).toBeUndefined();
    expect(second.MOCK_PROVIDER_CHILD_LAUNCH_DIR).toBeUndefined();

    first.HOME = "/mutated";
    expect(second.HOME).toBe("/tmp/home-b");
    expect(base).toEqual({
      BASE_MARKER: "base",
      PI_SUBAGENT_CHILD: "1",
      MOCK_PROVIDER_CHILD_LAUNCH_DIR: "/stale-launches",
    });
  });
});

describe("adaptParentPiEnvironmentForRpcClient", () => {
  test("uses an enumerable undefined child-marker tombstone without mutating the parent environment", () => {
    const parent = createParentPiEnvironment({
      base: { PI_SUBAGENT_CHILD: "1" },
      agentDir: "/tmp/agent",
      home: "/tmp/home",
    });

    const adapted = adaptParentPiEnvironmentForRpcClient(parent);
    const merged = { PI_SUBAGENT_CHILD: "1", ...adapted };

    expect(Object.hasOwn(parent, "PI_SUBAGENT_CHILD")).toBeFalse();
    expect(Object.hasOwn(adapted, "PI_SUBAGENT_CHILD")).toBeTrue();
    expect(Object.keys(adapted)).toContain("PI_SUBAGENT_CHILD");
    expect(adapted.PI_SUBAGENT_CHILD).toBeUndefined();
    expect(merged.PI_SUBAGENT_CHILD).toBeUndefined();
  });
});

describe("resolveIntegrationCli", () => {
  test("prefers and canonicalises an explicit absolute executable without consulting PATH", () => {
    const calls: string[] = [];
    const selected = resolveIntegrationCli(
      { PI_INTEGRATION_CLI: "/opt/pi/bin/pi", CI: "1" },
      runtime({
        resolveOnPath: () => { calls.push("path"); return "/usr/bin/pi"; },
        canonicalise: (path) => { calls.push(`realpath:${path}`); return "/real/pi"; },
      }),
    );

    expect(selected).toBe("/real/pi");
    expect(calls).toEqual(["realpath:/opt/pi/bin/pi"]);
  });

  test("rejects relative explicit paths and CI PATH fallback", () => {
    expect(() => resolveIntegrationCli(
      { PI_INTEGRATION_CLI: "bin/pi" },
      runtime(),
    )).toThrow("PI_INTEGRATION_CLI must be an absolute path");
    expect(() => resolveIntegrationCli(
      { CI: "1" },
      runtime(),
    )).toThrow("CI requires PI_INTEGRATION_CLI");
  });

  test("allows one canonical local PATH fallback when CI is absent", () => {
    const calls: string[] = [];
    const selected = resolveIntegrationCli({}, runtime({
      resolveOnPath: () => { calls.push("path"); return "/usr/local/bin/pi\n"; },
      canonicalise: (path) => { calls.push(`realpath:${path}`); return "/canonical/pi"; },
    }));

    expect(selected).toBe("/canonical/pi");
    expect(calls).toEqual(["path", "realpath:/usr/local/bin/pi"]);
  });

  test("prints the selected path and version in one report", () => {
    const output: string[] = [];
    const integrationRuntime = runtime({
      version: (path) => {
        expect(path).toBe("/canonical/pi");
        return "pi 0.test\n";
      },
      write: (message) => { output.push(message); },
    });

    reportIntegrationCli("/canonical/pi", integrationRuntime);

    expect(output).toEqual([
      "pi integration executable: /canonical/pi\npi integration version: pi 0.test\n",
    ]);
  });
});

function runtime(overrides: Partial<IntegrationCliRuntime> = {}): IntegrationCliRuntime {
  return {
    resolveOnPath: () => "/usr/bin/pi",
    canonicalise: (path) => path,
    version: () => "pi test",
    write: () => {},
    ...overrides,
  };
}
