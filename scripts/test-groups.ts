import { lstatSync, readdirSync, type Dirent } from "node:fs";
import { basename, join, relative, sep } from "node:path";

export const TEST_GROUP_NAMES = ["unit", "transport", "process", "controller", "integration"] as const;
export type TestGroupName = (typeof TEST_GROUP_NAMES)[number];

export interface TestGroup {
  readonly name: TestGroupName;
  readonly files: readonly string[];
}

export const TEST_GROUP_RULES: Readonly<Record<TestGroupName, ReadonlySet<string>>> = {
  unit: new Set([
    "assignment-identity.test.ts",
    "async-primitives.test.ts",
    "child-selection.test.ts",
    "completion-service.test.ts",
    "domain.test.ts",
    "durable-fs.test.ts",
    "observation-snapshot-path.test.ts",
    "persistence.test.ts",
    "pi-integration-harness.test.ts",
    "paths.test.ts",
    "settings.test.ts",
    "support-barriers.test.ts",
    "test-runner.test.ts",
  ]),
  transport: new Set([
    "focus-spike.test.ts",
    "jsonl.test.ts",
    "output-store.test.ts",
    "rpc-client.test.ts",
    "rpc-wire.test.ts",
    "ui-forwarder.test.ts",
    "ui-spike.test.ts",
  ]),
  process: new Set([
    "abrupt-controller.test.ts",
    "cgroup-process.test.ts",
    "cgroup-v2.test.ts",
    "launcher.test.ts",
    "pi-launcher.test.ts",
    "watchdog.test.ts",
  ]),
  controller: new Set([
    "context-safety.test.ts",
    "controller-scenarios.test.ts",
    "controller.test.ts",
    "extension.test.ts",
    "restoration-planner.test.ts",
    "restoration.test.ts",
    "run-controller.test.ts",
    "tools.test.ts",
  ]),
  integration: new Set(["pi-integration.test.ts"]),
};

const LIVE_SMOKE = "live-model-smoke.test.ts";

export function discoverTestFiles(root: string): string[] {
  const testRoot = join(root, "test");
  const found: string[] = [];
  const read = (directory: string): Dirent[] => {
    try {
      return readdirSync(directory, { withFileTypes: true });
    } catch (cause) {
      // Only the root read can legitimately be absent; a nested ENOENT means the tree
      // changed mid-walk, so report the directory that actually failed.
      if (!(cause instanceof Error) || !("code" in cause) || cause.code !== "ENOENT") throw cause;
      throw new Error(`test directory not found: ${directory}`, { cause });
    }
  };
  const visit = (directory: string): void => {
    for (const entry of read(directory)) {
      const path = join(directory, entry.name);
      if (entry.isSymbolicLink()) throw new Error(`symlinked test path: ${path}`);
      if (entry.isDirectory()) visit(path);
      else if (entry.isFile() && entry.name.endsWith(".test.ts") && entry.name !== LIVE_SMOKE) {
        found.push(relative(root, path).split(sep).join("/"));
      }
    }
  };
  try {
    if (lstatSync(testRoot).isSymbolicLink()) throw new Error(`symlinked test path: ${testRoot}`);
  } catch (cause) {
    if (!(cause instanceof Error) || !("code" in cause) || cause.code !== "ENOENT") throw cause;
  }
  visit(testRoot);
  return found.sort();
}

export function groupTestFiles(files: readonly string[]): TestGroup[] {
  const sorted = [...files].sort();
  if (new Set(sorted).size !== sorted.length) throw new Error("duplicate test file discovered");

  const members: Record<TestGroupName, string[]> = {
    unit: [],
    transport: [],
    process: [],
    controller: [],
    integration: [],
  };

  for (const file of sorted) members[resolveTestGroupOwner(file)].push(file);

  return TEST_GROUP_NAMES.map((name) => ({ name, files: members[name] }));
}

export function resolveTestGroupOwner(
  file: string,
  rules: Readonly<Record<TestGroupName, ReadonlySet<string>>> = TEST_GROUP_RULES,
): TestGroupName {
  const name = basename(file);
  const owners = TEST_GROUP_NAMES.filter((group) => rules[group].has(name));
  if (owners.length === 0) throw new Error(`unassigned test file: ${file}`);
  if (owners.length > 1) throw new Error(`multiply assigned test file: ${file}`);
  return owners[0]!;
}

export function selectTestGroups(
  groups: readonly TestGroup[],
  requested: readonly TestGroupName[],
): TestGroup[] {
  if (requested.length === 0) return [...groups];
  const wanted = new Set(requested);
  return groups.filter((group) => wanted.has(group.name));
}

export function parseRequestedGroups(argv: readonly string[]): TestGroupName[] {
  const requested: TestGroupName[] = [];
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument !== "--group") throw new Error(`unexpected argument: ${argument}`);
    const value = argv[index + 1];
    if (value === undefined) throw new Error("--group requires a group name");
    if (!isTestGroupName(value)) throw new Error(`unknown test group: ${value}`);
    if (!requested.includes(value)) requested.push(value);
    index += 1;
  }
  return requested;
}

function isTestGroupName(value: string): value is TestGroupName {
  return (TEST_GROUP_NAMES as readonly string[]).includes(value);
}
