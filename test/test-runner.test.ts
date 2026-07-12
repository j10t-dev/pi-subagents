import { describe, expect, test } from "bun:test";

import { groupTestFiles, isDefaultTestFile, runTestGroups, type TestGroup } from "../scripts/run-tests.ts";

describe("isDefaultTestFile", () => {
  test("includes ordinary tests and excludes the opt-in live smoke and non-tests", () => {
    expect(isDefaultTestFile("controller.test.ts")).toBeTrue();
    expect(isDefaultTestFile("live-model-smoke.test.ts")).toBeFalse();
    expect(isDefaultTestFile("fixture.ts")).toBeFalse();
  });
});

describe("groupTestFiles", () => {
  test("assigns every discovered test file to exactly one isolated group", () => {
    const files = [
      "test/watchdog.test.ts",
      "test/pi-launcher.test.ts",
      "test/cgroup-process.test.ts",
      "test/rpc-client.test.ts",
      "test/rpc-wire.test.ts",
      "test/jsonl.test.ts",
      "test/output-store.test.ts",
      "test/ui-spike.test.ts",
      "test/domain.test.ts",
      "test/run-controller.test.ts",
      "test/pi-integration.test.ts",
    ];

    const groups = groupTestFiles(files);

    expect(groups).toEqual([
      { name: "process", files: ["test/pi-launcher.test.ts", "test/watchdog.test.ts"] },
      {
        name: "transport",
        files: [
          "test/jsonl.test.ts",
          "test/output-store.test.ts",
          "test/rpc-client.test.ts",
          "test/rpc-wire.test.ts",
          "test/ui-spike.test.ts",
        ],
      },
      {
        name: "remaining",
        files: ["test/cgroup-process.test.ts", "test/domain.test.ts", "test/pi-integration.test.ts", "test/run-controller.test.ts"],
      },
    ] satisfies TestGroup[]);
    expect(groups.flatMap((group) => group.files).sort()).toEqual([...files].sort());
  });

  test("rejects duplicate discovery input", () => {
    expect(() => groupTestFiles(["test/domain.test.ts", "test/domain.test.ts"])).toThrow(/duplicate/);
  });
});

describe("runTestGroups", () => {
  test("fails fast and returns the first non-zero exit code", async () => {
    const attempted: string[] = [];
    const groups: TestGroup[] = [
      { name: "process", files: ["test/watchdog.test.ts"] },
      { name: "transport", files: ["test/rpc-client.test.ts"] },
      { name: "remaining", files: ["test/domain.test.ts"] },
    ];

    const exitCode = await runTestGroups(groups, async (group) => {
      attempted.push(group.name);
      return group.name === "transport" ? 17 : 0;
    });

    expect(exitCode).toBe(17);
    expect(attempted).toEqual(["process", "transport"]);
  });
});
