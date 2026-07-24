import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import {
  nodeCgroupFileSystem,
  resolveCgroupV2Backend,
  type CgroupFileSystem,
} from "../../src/cgroup-v2.ts";
import { agentId } from "../../src/domain.ts";
import { containmentReceiptPath, isContainedPath } from "../../src/paths.ts";

type FixtureId = "a" | "b";
type MkdirOutcome = "created" | "EEXIST";

interface FixtureRecord {
  readonly id: FixtureId;
  readonly root: string;
  readonly parentScope: string;
  readonly mkdirOutcome: MkdirOutcome;
}

async function main(): Promise<void> {
  const [membership, scratch, idValue, barrierDirectory, parentSessionId, ...extra] = process.argv.slice(2);
  if (
    membership === undefined || scratch === undefined ||
    (idValue !== "a" && idValue !== "b") ||
    barrierDirectory === undefined || parentSessionId === undefined || extra.length !== 0
  ) {
    throw new Error("expected membership, scratch, fixture ID, barrier directory, and parent session ID");
  }
  if (membership.split("/").includes("..")) throw new Error(`unsafe cgroup membership: ${membership}`);

  const id: FixtureId = idValue;
  const rootCandidate = join(scratch, "pi-subagents");
  const arrivalPath = join(barrierDirectory, `${id}.arrived`);
  const releasePath = join(barrierDirectory, "release");
  let mkdirOutcome: MkdirOutcome | undefined;
  const fs: CgroupFileSystem = {
    readFile: (path) => nodeCgroupFileSystem.readFile(path),
    writeFile: (path, value) => nodeCgroupFileSystem.writeFile(path, value),
    realpath: (path) => nodeCgroupFileSystem.realpath(path),
    stat: (path) => nodeCgroupFileSystem.stat(path),
    removeDirectory: (path) => nodeCgroupFileSystem.removeDirectory(path),
    list: (path) => nodeCgroupFileSystem.list(path),
    mkdir(path, mode): void {
      if (path !== rootCandidate) return nodeCgroupFileSystem.mkdir(path, mode);
      writeFileSync(arrivalPath, id, { flag: "wx" });
      waitForRelease(releasePath, 10_000, id);
      try {
        nodeCgroupFileSystem.mkdir(path, mode);
        mkdirOutcome = "created";
      } catch (error) {
        if (errorCode(error) === "EEXIST") mkdirOutcome = "EEXIST";
        throw error;
      }
    },
  };

  const backend = resolveCgroupV2Backend({
    parentSessionId: agentId(parentSessionId),
    selfCgroupText: `0::${membership}\n`,
    fs,
    receiptPathFor: (attemptId) => containmentReceiptPath(barrierDirectory, `${id}-${attemptId}.json`),
  });
  if (backend.root !== rootCandidate) throw new Error(`unexpected root: ${backend.root}`);
  if (!isContainedPath(backend.root, backend.parentScope) || backend.parentScope === backend.root) {
    throw new Error(`parent scope escapes root: ${backend.parentScope}`);
  }
  if (mkdirOutcome === undefined) throw new Error("root mkdir outcome was not recorded");
  await backend.shutdown();
  if (existsSync(backend.parentScope)) throw new Error(`parent scope remains: ${backend.parentScope}`);
  if (!existsSync(rootCandidate)) throw new Error(`shared root is absent: ${rootCandidate}`);

  const record: FixtureRecord = { id, root: backend.root, parentScope: backend.parentScope, mkdirOutcome };
  process.stdout.write(`${JSON.stringify(record)}\n`);
}

function waitForRelease(releasePath: string, timeout: number, id: FixtureId): void {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (existsSync(releasePath)) return;
    Bun.sleepSync(5);
  }
  throw new Error(`race fixture ${id} timed out waiting for release`);
}

function errorCode(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null || !("code" in error)) return undefined;
  const code = Reflect.get(error, "code");
  return typeof code === "string" ? code : undefined;
}

void main().catch((error: unknown) => {
  const diagnostic = error instanceof Error ? (error.stack ?? error.message) : String(error);
  process.stderr.write(`${diagnostic.slice(-4_096)}\n`);
  process.exitCode = 1;
});
