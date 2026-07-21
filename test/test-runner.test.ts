import { symlinkSync } from "node:fs";
import { basename, join } from "node:path";

import { afterAll, describe, expect, test } from "bun:test";

import {
  TEST_GROUP_NAMES,
  TEST_GROUP_RULES,
  discoverTestFiles,
  groupTestFiles,
  parseRequestedGroups,
  resolveTestGroupOwner,
  selectTestGroups,
  type TestGroup,
  type TestGroupName,
} from "../scripts/test-groups.ts";
import { runTestGroups, testCommandArguments } from "../scripts/run-tests.ts";
import { temporaryTree as createTemporaryTree } from "./support/temp-state.ts";

const REPOSITORY_ROOT = join(import.meta.dir, "..");
const DISCOVERED = discoverTestFiles(REPOSITORY_ROOT);

const temporaryRoots: Array<{ cleanup(): void }> = [];

afterAll(() => {
  for (const root of temporaryRoots) root.cleanup();
});

function temporaryTree(relativePaths: readonly string[]): string {
  const tree = createTemporaryTree(relativePaths, "pi-test-groups-");
  temporaryRoots.push(tree);
  return tree.path;
}

function groupOf(groups: readonly TestGroup[], file: string): TestGroupName | undefined {
  return groups.find((group) => group.files.includes(file))?.name;
}

describe("discoverTestFiles", () => {
  test("walks nested directories and excludes support modules and the live smoke", () => {
    const root = temporaryTree([
      "test/domain.test.ts",
      "test/nested/rpc-wire.test.ts",
      "test/nested/controller.test.ts",
      "test/support/helper.ts",
      "test/live-model-smoke.test.ts",
    ]);

    expect(discoverTestFiles(root)).toEqual([
      "test/domain.test.ts",
      "test/nested/controller.test.ts",
      "test/nested/rpc-wire.test.ts",
    ]);
  });

  test("names the expected path when the test directory is missing", () => {
    const root = temporaryTree(["package.json"]);

    expect(() => discoverTestFiles(root)).toThrow(
      `test directory not found: ${join(root, "test")}`,
    );
  });

  test("rejects a symlinked test root", () => {
    const root = temporaryTree(["outside/domain.test.ts"]);
    const link = join(root, "test");
    symlinkSync(join(root, "outside"), link);

    expect(() => discoverTestFiles(root)).toThrow(`symlinked test path: ${link}`);
  });

  test("rejects a symlinked test file", () => {
    const root = temporaryTree(["test/target.test.ts"]);
    const link = join(root, "test", "linked.test.ts");
    symlinkSync(join(root, "test", "target.test.ts"), link);

    expect(() => discoverTestFiles(root)).toThrow(`symlinked test path: ${link}`);
  });

  test("rejects a symlinked test directory", () => {
    const root = temporaryTree(["outside/nested.test.ts", "test/domain.test.ts"]);
    const link = join(root, "test", "linked");
    symlinkSync(join(root, "outside"), link);

    expect(() => discoverTestFiles(root)).toThrow(`symlinked test path: ${link}`);
  });
});

describe("groupTestFiles", () => {
  const groups = groupTestFiles(DISCOVERED);

  test("assigns every current repository default test to exactly one group", () => {
    const assigned = groups.flatMap((group) => group.files);

    expect(new Set(assigned).size).toBe(assigned.length);
    expect([...assigned].sort()).toEqual([...DISCOVERED].sort());
  });

  test("returns all five groups in canonical order", () => {
    expect(groups.map((group) => group.name)).toEqual([...TEST_GROUP_NAMES]);
  });

  test.each([
    ["test/controller-scenarios.test.ts", "controller"],
    ["test/pi-integration.test.ts", "integration"],
    ["test/context-safety.test.ts", "controller"],
  ] as const)("places %s in the %s group", (file, expected) => {
    expect(groupOf(groups, file)).toBe(expected);
  });

  test("rejects a file no rule owns", () => {
    expect(() => groupTestFiles(["test/mystery.test.ts"])).toThrow(
      "unassigned test file: test/mystery.test.ts",
    );
  });

  test("assigns split settings suites to unit exactly once", () => {
    const unit = groupTestFiles([
      "test/async-primitives.test.ts",
      "test/paths.test.ts",
      "test/settings.test.ts",
    ]).find((group) => group.name === "unit");
    expect(unit?.files).toEqual([
      "test/async-primitives.test.ts",
      "test/paths.test.ts",
      "test/settings.test.ts",
    ]);
  });
});

describe("resolveTestGroupOwner", () => {
  test("resolves against the production rules by default", () => {
    expect(resolveTestGroupOwner("test/controller-scenarios.test.ts")).toBe("controller");
  });

  test("rejects a file no rule owns", () => {
    expect(() => resolveTestGroupOwner("test/mystery.test.ts")).toThrow(
      "unassigned test file: test/mystery.test.ts",
    );
  });

  test("rejects a basename claimed by two rule sets", () => {
    const conflicting: Record<TestGroupName, ReadonlySet<string>> = {
      unit: new Set(["contested.test.ts"]),
      transport: new Set(["contested.test.ts"]),
      process: new Set(),
      controller: new Set(),
      integration: new Set(),
    };

    expect(() => resolveTestGroupOwner("test/contested.test.ts", conflicting)).toThrow(
      "multiply assigned test file: test/contested.test.ts",
    );
  });
});

describe("selectTestGroups", () => {
  const groups = groupTestFiles(DISCOVERED);

  test("returns every group when nothing is requested", () => {
    expect(selectTestGroups(groups, []).map((group) => group.name)).toEqual([...TEST_GROUP_NAMES]);
  });

  test("returns only the requested groups in canonical order", () => {
    expect(selectTestGroups(groups, ["transport", "unit"]).map((group) => group.name)).toEqual([
      "unit",
      "transport",
    ]);
  });
});

describe("parseRequestedGroups", () => {
  test("accepts repeated --group arguments once each", () => {
    expect(parseRequestedGroups(["--group", "unit", "--group", "transport", "--group", "unit"])).toEqual([
      "unit",
      "transport",
    ]);
  });

  test("rejects an unknown group", () => {
    expect(() => parseRequestedGroups(["--group", "nonsense"])).toThrow("unknown test group: nonsense");
  });

  test("rejects a malformed argument list", () => {
    expect(() => parseRequestedGroups(["--group"])).toThrow(/--group/);
    expect(() => parseRequestedGroups(["unit"])).toThrow(/unit/);
  });
});

describe("runTestGroups", () => {
  test("runs every non-empty group concurrently", async () => {
    const attempted: string[] = [];
    const release = Promise.withResolvers<void>();
    const groups: TestGroup[] = [
      { name: "unit", files: ["test/domain.test.ts"] },
      { name: "transport", files: ["test/rpc-client.test.ts"] },
      { name: "integration", files: ["test/pi-integration.test.ts"] },
    ];

    const running = runTestGroups(groups, async (group) => {
      attempted.push(group.name);
      await release.promise;
      return 0;
    });

    try {
      expect(attempted).toEqual(["unit", "transport", "integration"]);
      release.resolve();
      expect(await running).toBe(0);
    } finally {
      release.resolve();
      await running;
    }
  });

  test("waits for every group before propagating a rejection", async () => {
    const release = Promise.withResolvers<void>();
    let siblingSettled = false;
    const groups: TestGroup[] = [
      { name: "transport", files: ["test/rpc-client.test.ts"] },
      { name: "integration", files: ["test/pi-integration.test.ts"] },
    ];

    let settlement: { error: Error | undefined; siblingSettled: boolean } | undefined;
    const observed = runTestGroups(groups, async (group) => {
      if (group.name === "transport") throw new Error("spawn failed");
      await release.promise;
      siblingSettled = true;
      return 0;
    }).then(
      () => ({ error: undefined, siblingSettled }),
      (error: Error) => ({ error, siblingSettled }),
    ).then((result) => {
      settlement = result;
      return result;
    });

    for (let turn = 0; turn < 10; turn += 1) await Promise.resolve();
    const settlementBeforeSibling = settlement;
    release.resolve();
    const result = await observed;
    expect(settlementBeforeSibling).toBeUndefined();
    expect(result.error?.message).toBe("spawn failed");
    expect(result.siblingSettled).toBeTrue();
  });

  test("waits for every started group and returns the first non-zero exit", async () => {
    const attempted: string[] = [];
    const groups: TestGroup[] = [
      { name: "unit", files: [] },
      { name: "transport", files: ["test/rpc-client.test.ts"] },
      { name: "process", files: ["test/watchdog.test.ts"] },
      { name: "integration", files: ["test/pi-integration.test.ts"] },
    ];

    const exitCode = await runTestGroups(groups, async (group) => {
      attempted.push(group.name);
      if (group.name === "transport") return 17;
      if (group.name === "process") return 23;
      return 0;
    });

    expect(exitCode).toBe(17);
    expect(attempted).toEqual(["transport", "process", "integration"]);
  });
});

describe("testCommandArguments", () => {
  test("enables bounded concurrency only for the integration group", () => {
    expect(testCommandArguments({
      name: "integration",
      files: ["test/pi-integration.test.ts"],
    })).toEqual([
      "test",
      "test/pi-integration.test.ts",
      "--timeout",
      "20000",
      "--concurrent",
      "--max-concurrency",
      "12",
    ]);
    expect(testCommandArguments({
      name: "unit",
      files: ["test/domain.test.ts"],
    })).toEqual(["test", "test/domain.test.ts", "--timeout", "20000"]);
  });
});

describe("repository inventory", () => {
  test("every discovered basename is owned by exactly one rule", () => {
    const groups = groupTestFiles(DISCOVERED);
    const basenames = groups.flatMap((group) => group.files.map((file) => basename(file)));

    expect(new Set(basenames).size).toBe(basenames.length);
  });

  test("every rule basename names a test file that still exists", () => {
    const discovered = new Set(DISCOVERED.map((file) => basename(file)));
    const named = TEST_GROUP_NAMES.flatMap((group) => [...TEST_GROUP_RULES[group]]);

    expect(named.filter((name) => !discovered.has(name))).toEqual([]);
  });
});
