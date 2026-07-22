import { readFileSync, symlinkSync } from "node:fs";
import { EventEmitter } from "node:events";
import { basename, join } from "node:path";
import { PassThrough } from "node:stream";
import type { SpawnOptions } from "node:child_process";

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
import {
  BoundedTestOutput,
  formatTestGroupOutput,
} from "../scripts/bounded-test-output.ts";
import {
  integrationConcurrency,
  runSelectedTestGroups,
  runTestGroups,
  testCommandArguments,
  type RunnerDependencies,
  type TestGroupProcess,
} from "../scripts/run-tests.ts";
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

class FakeTestGroupProcess extends EventEmitter implements TestGroupProcess {
  readonly stdout: PassThrough | null;
  readonly stderr: PassThrough | null;
  readonly killSignals: NodeJS.Signals[] = [];
  killResult = true;

  constructor(captured = true) {
    super();
    this.stdout = captured ? new PassThrough() : null;
    this.stderr = captured ? new PassThrough() : null;
  }

  kill(signal: NodeJS.Signals = "SIGTERM"): boolean {
    this.killSignals.push(signal);
    return this.killResult;
  }

  spawned(): void {
    this.emit("spawn");
  }

  exit(code: number | null, signal: NodeJS.Signals | null = null): void {
    this.emit("exit", code, signal);
  }

  spawnError(error: Error): void {
    this.emit("error", error);
  }
}

interface SpawnRecord {
  readonly command: string;
  readonly args: readonly string[];
  readonly options: SpawnOptions;
  readonly child: FakeTestGroupProcess;
}

function runnerHarness(children: readonly FakeTestGroupProcess[], parallelism = 6): {
  readonly dependencies: RunnerDependencies;
  readonly records: SpawnRecord[];
  readonly writes: string[];
} {
  const records: SpawnRecord[] = [];
  const writes: string[] = [];
  let nextChild = 0;
  return {
    records,
    writes,
    dependencies: {
      parallelism,
      spawn(command, args, options) {
        const child = children[nextChild];
        if (child === undefined) throw new Error("missing fake child");
        nextChild += 1;
        records.push({ command, args, options, child });
        return child;
      },
      stdout: {
        write(chunk: Uint8Array | string): boolean {
          writes.push(Buffer.from(chunk).toString("utf8"));
          return true;
        },
      },
    },
  };
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
  test.each([1, 16] as const)("all-host overlap at capacity %d", async (parallelism) => {
    const attempted: string[] = [];
    const release = Promise.withResolvers<void>();
    const groups: TestGroup[] = TEST_GROUP_NAMES.map((name) => ({
      name,
      files: [`test/${name}.test.ts`],
    }));

    const running = runTestGroups(groups, async (group) => {
      testCommandArguments(group, parallelism);
      attempted.push(group.name);
      await release.promise;
      return 0;
    });

    try {
      expect(attempted).toEqual([...TEST_GROUP_NAMES]);
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

  test("a later-settling earlier canonical rejection wins over a faster later rejection", async () => {
    const release = Promise.withResolvers<void>();
    const firstError = new Error("canonical failure");
    const laterError = new Error("fast later failure");
    const running = runTestGroups([
      { name: "unit", files: ["test/domain.test.ts"] },
      { name: "transport", files: ["test/rpc-client.test.ts"] },
    ], async (group) => {
      if (group.name === "unit") {
        await release.promise;
        throw firstError;
      }
      throw laterError;
    });
    release.resolve();
    await expect(running).rejects.toBe(firstError);
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

  test("a later-settling earlier canonical non-zero exit wins over a faster later exit", async () => {
    const release = Promise.withResolvers<void>();
    const running = runTestGroups([
      { name: "unit", files: ["test/domain.test.ts"] },
      { name: "transport", files: ["test/rpc-client.test.ts"] },
    ], async (group) => {
      if (group.name === "unit") {
        await release.promise;
        return 17;
      }
      return 23;
    });
    release.resolve();
    expect(await running).toBe(17);
  });
});

describe("runSelectedTestGroups", () => {
  const unitGroup: TestGroup = { name: "unit", files: ["test/domain.test.ts"] };
  const transportGroup: TestGroup = { name: "transport", files: ["test/rpc-client.test.ts"] };

  test("single runnable group inherits stdio and the original environment without publication", async () => {
    const child = new FakeTestGroupProcess(false);
    const harness = runnerHarness([child]);
    const running = runSelectedTestGroups(REPOSITORY_ROOT, [unitGroup], harness.dependencies);

    expect(harness.records).toHaveLength(1);
    expect(harness.records[0]?.options.stdio).toBe("inherit");
    expect(harness.records[0]?.options.env).toBe(process.env);
    expect(child.stdout).toBeNull();
    expect(child.stderr).toBeNull();
    expect(harness.writes).toEqual([]);
    child.exit(7);

    expect(await running).toBe(7);
    expect(harness.writes).toEqual([]);
  });

  test("single runnable group maps a signal exit to one without a start line", async () => {
    const child = new FakeTestGroupProcess(false);
    const harness = runnerHarness([child]);
    const running = runSelectedTestGroups(REPOSITORY_ROOT, [unitGroup], harness.dependencies);
    child.exit(null, "SIGKILL");

    expect(await running).toBe(1);
    expect(harness.writes).toEqual([]);
  });

  test("multi-group children start synchronously with piped colour-disabled streams", async () => {
    const first = new FakeTestGroupProcess();
    const second = new FakeTestGroupProcess();
    const harness = runnerHarness([first, second]);
    const running = runSelectedTestGroups(
      REPOSITORY_ROOT,
      [unitGroup, transportGroup],
      harness.dependencies,
    );

    expect(harness.records).toHaveLength(2);
    expect(harness.records.map((record) => record.options.stdio)).toEqual([
      ["inherit", "pipe", "pipe"],
      ["inherit", "pipe", "pipe"],
    ]);
    for (const record of harness.records) {
      expect(record.options.env).not.toBe(process.env);
      expect(record.options.env?.FORCE_COLOR).toBe("0");
      expect(record.child.stdout?.listenerCount("data")).toBeGreaterThan(0);
      expect(record.child.stderr?.listenerCount("data")).toBeGreaterThan(0);
    }
    expect(harness.writes).toEqual([
      "starting test group unit\n",
      "starting test group transport\n",
    ]);

    second.stdout?.end("transport-out");
    second.stderr?.end("transport-err");
    second.exit(0);
    first.stdout?.end("unit-out");
    first.stderr?.end("unit-err");
    first.exit(0);
    expect(await running).toBe(0);

    const blocks = harness.writes.slice(2);
    expect(blocks).toHaveLength(2);
    expect(blocks[0]).toContain("===== test group: transport =====");
    expect(blocks[0]).toContain("transport-out");
    expect(blocks[0]).toContain("transport-err");
    expect(blocks[0]).toEndWith("===== end test group: transport =====\n");
    expect(blocks[1]).toContain("===== test group: unit =====");
    expect(blocks[1]).toContain("unit-out");
    expect(blocks[1]).toContain("unit-err");
    expect(blocks[1]).toEndWith("===== end test group: unit =====\n");
    expect(blocks.every((block) => (block.match(/===== test group:/g) ?? []).length === 1)).toBeTrue();
  });
});

describe("captured group settlement", () => {
  const groups: readonly TestGroup[] = [
    { name: "unit", files: ["test/domain.test.ts"] },
    { name: "transport", files: ["test/rpc-client.test.ts"] },
  ];

  test("stream failure kills once, drains the sibling stream, and rejects after one publication", async () => {
    const first = new FakeTestGroupProcess();
    const second = new FakeTestGroupProcess();
    const harness = runnerHarness([first, second]);
    const captureError = new Error("stdout broke");
    let settled = false;
    const running = runSelectedTestGroups(REPOSITORY_ROOT, groups, harness.dependencies);
    running.then(
      () => { settled = true; },
      () => { settled = true; },
    );

    first.stdout?.write("retained-out");
    first.stdout?.emit("error", captureError);
    expect(first.killSignals).toEqual(["SIGTERM"]);
    first.stderr?.write("retained-err");
    first.stdout?.emit("end");
    first.stdout?.emit("close");
    first.stderr?.emit("end");
    await Promise.resolve();
    expect(settled).toBeFalse();

    first.exit(null, "SIGTERM");
    first.stdout?.emit("close");
    second.stdout?.emit("end");
    second.stderr?.emit("end");
    second.exit(0);
    await expect(running).rejects.toBe(captureError);

    const firstBlocks = harness.writes.filter((write) => write.includes("===== test group: unit ====="));
    expect(firstBlocks).toHaveLength(1);
    expect(firstBlocks[0]).toContain("retained-out");
    expect(firstBlocks[0]).toContain("retained-err");
    expect(firstBlocks[0]).toContain("test group capture failed: stdout broke\n");
    expect(firstBlocks[0]).toContain("test group terminated by SIGTERM");
    first.exit(0);
    first.stderr?.emit("close");
    expect(harness.writes.filter((write) => write.includes("===== test group: unit ====="))).toHaveLength(1);
  });

  test("a post-spawn child error after failed capture kill waits for exit and preserves the capture error", async () => {
    const first = new FakeTestGroupProcess();
    const second = new FakeTestGroupProcess();
    first.killResult = false;
    const harness = runnerHarness([first, second]);
    const captureError = new Error("stdout capture failed");
    const killError = Object.assign(new Error("kill denied"), { code: "EPERM" });
    let settled = false;
    const running = runSelectedTestGroups(REPOSITORY_ROOT, groups, harness.dependencies);
    running.then(
      () => { settled = true; },
      () => { settled = true; },
    );

    first.spawned();
    second.stdout?.end();
    second.stderr?.end();
    second.exit(0);
    first.stdout?.emit("error", captureError);
    expect(first.killSignals).toEqual(["SIGTERM"]);
    first.spawnError(killError);
    first.stderr?.end();
    for (let turn = 0; turn < 10; turn += 1) await Promise.resolve();
    expect(settled).toBeFalse();
    expect(harness.writes.some((write) => write.includes("===== test group: unit ====="))).toBeFalse();

    first.exit(0);
    await expect(running).rejects.toBe(captureError);
  });

  test("publishes the first capture diagnostic once after stderr evicts both bounded regions", async () => {
    const first = new FakeTestGroupProcess();
    const second = new FakeTestGroupProcess();
    const harness = runnerHarness([first, second]);
    const dependencies: RunnerDependencies = {
      ...harness.dependencies,
      captureLimits: { headBytes: 8, tailBytes: 12 },
    };
    const captureError = new Error("stdout broke");
    const running = runSelectedTestGroups(REPOSITORY_ROOT, groups, dependencies);

    first.stderr?.write("HEADHEAD");
    first.stdout?.emit("error", captureError);
    first.stderr?.end(`${"x".repeat(64)}TAILTAILTAIL`);
    first.stdout?.emit("end");
    first.exit(null, "SIGTERM");
    second.stdout?.end();
    second.stderr?.end();
    second.exit(0);

    await expect(running).rejects.toBe(captureError);
    const block = harness.writes.find((write) => write.includes("===== test group: unit ====="));
    const diagnostic = "test group capture failed: stdout broke\n";
    expect(block?.split(diagnostic)).toHaveLength(2);
    expect(block).toContain("HEADHEAD\n... [truncated");
    expect(block).toContain("TAILTAILTAIL");
  });

  test("asynchronous spawn rejection waits for every sibling", async () => {
    const first = new FakeTestGroupProcess();
    const second = new FakeTestGroupProcess();
    const harness = runnerHarness([first, second]);
    const spawnError = new Error("async spawn failed");
    let settled = false;
    const running = runSelectedTestGroups(REPOSITORY_ROOT, groups, harness.dependencies);
    running.catch(() => { settled = true; });

    first.spawnError(spawnError);
    await Promise.resolve();
    expect(settled).toBeFalse();
    second.stdout?.emit("end");
    second.stderr?.emit("end");
    second.exit(0);

    await expect(running).rejects.toBe(spawnError);
  });

  test("synchronous spawn throw still launches later canonical groups and waits for them", async () => {
    const sibling = new FakeTestGroupProcess();
    const writes: string[] = [];
    const attempted: string[] = [];
    const spawnError = new Error("sync spawn failed");
    let settled = false;
    const dependencies: RunnerDependencies = {
      parallelism: 6,
      spawn(_command, args) {
        const file = args[1];
        if (file === undefined) throw new Error("missing test file argument");
        attempted.push(file);
        if (attempted.length === 1) throw spawnError;
        return sibling;
      },
      stdout: {
        write(chunk: Uint8Array | string): boolean {
          writes.push(Buffer.from(chunk).toString("utf8"));
          return true;
        },
      },
    };
    const running = runSelectedTestGroups(REPOSITORY_ROOT, groups, dependencies);
    running.catch(() => { settled = true; });

    expect(attempted).toEqual(["test/domain.test.ts", "test/rpc-client.test.ts"]);
    await Promise.resolve();
    expect(settled).toBeFalse();
    sibling.stdout?.emit("end");
    sibling.stderr?.emit("end");
    sibling.exit(0);
    await expect(running).rejects.toBe(spawnError);
    expect(writes.filter((write) => write.startsWith("starting test group"))).toHaveLength(2);
  });

  test("captured SIGKILL publishes a labelled signal block and returns one", async () => {
    const first = new FakeTestGroupProcess();
    const second = new FakeTestGroupProcess();
    const harness = runnerHarness([first, second]);
    const running = runSelectedTestGroups(REPOSITORY_ROOT, groups, harness.dependencies);
    first.stdout?.emit("end");
    first.stderr?.emit("end");
    first.exit(null, "SIGKILL");
    second.stdout?.emit("end");
    second.stderr?.emit("end");
    second.exit(0);

    expect(await running).toBe(1);
    expect(harness.writes.join("")).toContain(
      "--- signal ---\ntest group terminated by SIGKILL\n",
    );
  });

  test("same-turn completions use two non-overlapping block writes", async () => {
    const first = new FakeTestGroupProcess();
    const second = new FakeTestGroupProcess();
    const harness = runnerHarness([first, second]);
    const running = runSelectedTestGroups(REPOSITORY_ROOT, groups, harness.dependencies);
    first.stdout?.end("first");
    first.stderr?.end();
    second.stdout?.end("second");
    second.stderr?.end();
    first.exit(0);
    second.exit(0);

    expect(await running).toBe(0);
    const blocks = harness.writes.filter((write) => write.startsWith("===== test group:"));
    expect(blocks).toHaveLength(2);
    expect(blocks.every((block) => (block.match(/===== test group:/g) ?? []).length === 1)).toBeTrue();
    expect(blocks.every((block) => (block.match(/===== end test group:/g) ?? []).length === 1)).toBeTrue();
  });

  test("continuously drains at least four MiB per stream with bounded retained publication", async () => {
    const first = new FakeTestGroupProcess();
    const second = new FakeTestGroupProcess();
    const harness = runnerHarness([first, second]);
    const dependencies: RunnerDependencies = {
      ...harness.dependencies,
      captureLimits: { headBytes: 8, tailBytes: 12 },
    };
    const running = runSelectedTestGroups(REPOSITORY_ROOT, groups, dependencies);
    const totalBytes = 4 * 1024 * 1024 + 31;
    const chunk = Buffer.alloc(65_537, 0x78);
    for (const stream of [first.stdout, first.stderr]) {
      if (stream === null) throw new Error("expected captured stream");
      let written = 0;
      while (written < totalBytes) {
        const length = Math.min(chunk.byteLength, totalBytes - written);
        stream.write(chunk.subarray(0, length));
        written += length;
      }
      stream.end();
    }
    first.exit(0);
    second.stdout?.end();
    second.stderr?.end();
    second.exit(0);

    expect(await running).toBe(0);
    const block = harness.writes.find((write) => write.includes("===== test group: unit ====="));
    expect(block).toBeDefined();
    const notice = `... [truncated ${totalBytes - 20} bytes] ...`;
    expect(block?.split(notice)).toHaveLength(3);
    expect(Buffer.byteLength(block ?? "")).toBeLessThan(1024);
  });
});

describe("integrationConcurrency", () => {
  test.each([
    [1, 1],
    [4, 1],
    [5, 1],
    [6, 2],
    [16, 12],
    [64, 12],
  ] as const)("maps %d available CPUs to %d integration workers", (available, expected) => {
    expect(integrationConcurrency(available)).toBe(expected);
  });

  test.each([Number.NaN, Number.POSITIVE_INFINITY, 1.5, 0, -1])(
    "rejects invalid available CPUs %p",
    (available) => {
      expect(() => integrationConcurrency(available)).toThrow(TypeError);
    },
  );
});

describe("testCommandArguments", () => {
  test("uses 30000 and capacity-aware concurrency only for the integration group", () => {
    expect(testCommandArguments({
      name: "integration",
      files: ["test/pi-integration.test.ts"],
    }, 6)).toEqual([
      "test", "test/pi-integration.test.ts", "--timeout", "30000",
      "--concurrent", "--max-concurrency", "2",
    ]);
    expect(testCommandArguments({
      name: "unit",
      files: ["test/domain.test.ts"],
    }, 1)).toEqual([
      "test", "test/domain.test.ts", "--timeout", "30000",
    ]);
  });

  test("preserves explicit 30000 and 40000 integration test declarations", () => {
    const source = readFileSync(join(REPOSITORY_ROOT, "test/pi-integration.test.ts"), "utf8");
    expect(source).toContain("}, 30_000);");
    expect(source).toContain("}, 40_000);");
  });
});

describe("BoundedTestOutput", () => {
  const limits = { headBytes: 8, tailBytes: 12 } as const;

  test("bounded output retains exact head and tail with an exact truncated byte count", () => {
    const output = new BoundedTestOutput(limits);
    output.append(Buffer.from("HEADHEAD" + "x".repeat(30) + "TAILTAILTAIL"));

    expect(output.discardedBytes).toBe(30);
    expect(output.render()).toBe("HEADHEAD\n... [truncated 30 bytes] ...\nTAILTAILTAIL");
  });

  test("repeated large chunks keep only bounded retained output", () => {
    const output = new BoundedTestOutput(limits);
    for (let index = 0; index < 32; index += 1) output.append(Buffer.alloc(64 * 1024, 0x61));

    expect(output.discardedBytes).toBe(32 * 64 * 1024 - 20);
    expect(Buffer.byteLength(output.render())).toBeLessThan(100);
  });

  test("stdout and stderr retain independent bounded counts", () => {
    const stdout = new BoundedTestOutput(limits);
    const stderr = new BoundedTestOutput(limits);
    stdout.append(Buffer.alloc(25, 0x6f));
    stderr.append(Buffer.alloc(40, 0x65));

    expect(stdout.discardedBytes).toBe(5);
    expect(stderr.discardedBytes).toBe(20);
  });

  test("removes a valid four-byte UTF-8 scalar split at the truncated head boundary", () => {
    const output = new BoundedTestOutput(limits);
    output.append(Buffer.from(`aaaaaaa😀${"m".repeat(30)}`));

    expect(output.render()).toBe(`aaaaaaa\n... [truncated 22 bytes] ...\n${"m".repeat(12)}`);
  });

  test("removes a valid four-byte UTF-8 scalar split at the truncated tail boundary", () => {
    const output = new BoundedTestOutput(limits);
    output.append(Buffer.from(`hhhhhhhhmmmmm😀${"p".repeat(10)}`));

    expect(output.render()).toBe(`hhhhhhhh\n... [truncated 9 bytes] ...\n${"p".repeat(10)}`);
  });

  test("keeps malformed retained UTF-8 bytes for replacement decoding", () => {
    const output = new BoundedTestOutput(limits);
    output.append(Buffer.concat([Buffer.from("aaaaaaa"), Buffer.from([0x80]), Buffer.alloc(20, 0x6d)]));

    expect(output.render()).toStartWith("aaaaaaa�\n... [truncated");
  });

  test("untruncated multi-byte UTF-8 text round-trips across internal storage", () => {
    const output = new BoundedTestOutput(limits);
    const text = "1234567😀é";
    expect(Buffer.byteLength(text)).toBeLessThanOrEqual(20);
    output.append(Buffer.from(text));

    expect(output.render()).toBe(text);
    expect(output.discardedBytes).toBe(0);
  });

  test.each([
    [{ headBytes: -1, tailBytes: 1 }, "negative"],
    [{ headBytes: 1.5, tailBytes: 1 }, "fractional"],
    [{ headBytes: 0, tailBytes: 0 }, "empty"],
  ] as const)("rejects %s capture limits", (invalid) => {
    expect(() => new BoundedTestOutput(invalid)).toThrow(TypeError);
  });
});

describe("formatTestGroupOutput", () => {
  test("formats test group output with exact attributed framing", () => {
    const stdout = new BoundedTestOutput({ headBytes: 8, tailBytes: 12 });
    const stderr = new BoundedTestOutput({ headBytes: 8, tailBytes: 12 });
    stdout.append(Buffer.from("out"));
    stderr.append(Buffer.from("err\n"));

    expect(formatTestGroupOutput("unit", stdout, stderr)).toBe(
      "===== test group: unit =====\n" +
      "--- stdout ---\nout\n" +
      "--- stderr ---\nerr\n" +
      "===== end test group: unit =====\n",
    );
  });

  test("formats test group signal diagnostics and omits empty sections", () => {
    const stdout = new BoundedTestOutput({ headBytes: 8, tailBytes: 12 });
    const stderr = new BoundedTestOutput({ headBytes: 8, tailBytes: 12 });

    expect(formatTestGroupOutput("process", stdout, stderr, "SIGKILL")).toBe(
      "===== test group: process =====\n" +
      "--- signal ---\ntest group terminated by SIGKILL\n" +
      "===== end test group: process =====\n",
    );
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
