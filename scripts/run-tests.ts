import { spawn } from "node:child_process";
import { readdirSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export type TestGroup = Readonly<{
  name: "process" | "transport" | "remaining";
  files: readonly string[];
}>;

const PROCESS_TESTS = /^(?:watchdog|pi-launcher)\.test\.ts$/;
const TRANSPORT_TESTS = /^(?:jsonl|output-store|rpc-client|rpc-wire|ui-spike)\.test\.ts$/;

export function isDefaultTestFile(name: string): boolean {
  return name.endsWith(".test.ts") && name !== "live-model-smoke.test.ts";
}

export function groupTestFiles(files: readonly string[]): TestGroup[] {
  const sorted = [...files].sort();
  if (new Set(sorted).size !== sorted.length) throw new Error("duplicate test file discovered");

  const groups: TestGroup[] = [
    { name: "process", files: sorted.filter((file) => PROCESS_TESTS.test(basename(file))) },
    { name: "transport", files: sorted.filter((file) => TRANSPORT_TESTS.test(basename(file))) },
    {
      name: "remaining",
      files: sorted.filter((file) => !PROCESS_TESTS.test(basename(file)) && !TRANSPORT_TESTS.test(basename(file))),
    },
  ];
  const assigned = groups.flatMap((group) => group.files);
  if (assigned.length !== sorted.length || new Set(assigned).size !== sorted.length) {
    throw new Error("test grouping omitted or duplicated a test file");
  }
  return groups;
}

export async function runTestGroups(
  groups: readonly TestGroup[],
  run: (group: TestGroup) => Promise<number>,
): Promise<number> {
  for (const group of groups) {
    if (group.files.length === 0) continue;
    const exitCode = await run(group);
    if (exitCode !== 0) return exitCode;
  }
  return 0;
}

function discoverTests(root: string): string[] {
  return readdirSync(join(root, "test"), { withFileTypes: true })
    .filter((entry) => entry.isFile() && isDefaultTestFile(entry.name))
    .map((entry) => join("test", entry.name));
}

function spawnGroup(root: string, group: TestGroup): Promise<number> {
  return new Promise((resolveExit, reject) => {
    const child = spawn(process.execPath, ["test", ...group.files, "--timeout", "20000"], {
      cwd: root,
      stdio: "inherit",
    });
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (signal !== null) {
        process.stderr.write(`test group ${group.name} terminated by ${signal}\n`);
        resolveExit(1);
        return;
      }
      resolveExit(code ?? 1);
    });
  });
}

async function main(): Promise<void> {
  const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
  const groups = groupTestFiles(discoverTests(root));
  process.exitCode = await runTestGroups(groups, (group) => spawnGroup(root, group));
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main();
}
