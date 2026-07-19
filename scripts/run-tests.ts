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
  for (const group of groups) {
    if (group.files.length === 0) continue;
    const exitCode = await run(group);
    if (exitCode !== 0) return exitCode;
  }
  return 0;
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
  const groups = groupTestFiles(discoverTestFiles(root));
  const requested = parseRequestedGroups(process.argv.slice(2));
  const selected = selectTestGroups(groups, requested);
  process.exitCode = await runTestGroups(selected, (group) => spawnGroup(root, group));
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main();
}
