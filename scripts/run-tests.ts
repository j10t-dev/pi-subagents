import { spawn } from "node:child_process";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  discoverTestFiles,
  groupTestFiles,
  parseRequestedGroups,
  selectTestGroups,
  type TestGroup,
} from "./test-groups.ts";

export async function runTestGroups(
  groups: readonly TestGroup[],
  run: (group: TestGroup) => Promise<number>,
): Promise<number> {
  const runnable = groups.filter((group) => group.files.length > 0);
  const results = await Promise.allSettled(runnable.map((group) => run(group)));
  const rejected = results.find((result) => result.status === "rejected");
  if (rejected !== undefined) throw rejected.reason;
  const failed = results
    .flatMap((result) => result.status === "fulfilled" ? [result.value] : [])
    .find((exitCode) => exitCode !== 0);
  return failed ?? 0;
}

export function testCommandArguments(group: TestGroup): string[] {
  return [
    "test",
    ...group.files,
    "--timeout",
    "20000",
    ...(group.name === "integration" ? ["--concurrent", "--max-concurrency", "12"] : []),
  ];
}

function spawnGroup(root: string, group: TestGroup): Promise<number> {
  return new Promise((resolveExit, reject) => {
    const child = spawn(process.execPath, testCommandArguments(group), {
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
  const groups = groupTestFiles(discoverTestFiles(root));
  const requested = parseRequestedGroups(process.argv.slice(2));
  const selected = selectTestGroups(groups, requested);
  process.exitCode = await runTestGroups(selected, (group) => spawnGroup(root, group));
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main();
}
