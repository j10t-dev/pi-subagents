import { readFileSync } from "node:fs";
import { join } from "node:path";

import { resolveCgroupV2Backend } from "../../src/cgroup-v2.ts";
import { agentId, createRunAttemptId, retainUtf8Tail, utf8Bytes } from "../../src/domain.ts";
import { publishCommittedSync } from "../../src/durable-fs.ts";
import { containmentReceiptPath } from "../../src/paths.ts";
import { WatchdogClient } from "../../src/watchdog-client.ts";
import { testAbsolutePath } from "../support/brands.ts";

interface NestedCgroupReady {
  readonly controllerPid: number;
  readonly nestedRoot: string;
  readonly nestedScope: string;
  readonly grandchildPids: readonly number[];
}

const [stateDir, readyPath] = process.argv.slice(2);
if (stateDir === undefined || readyPath === undefined) {
  throw new Error("usage: nested-cgroup-controller <state-dir> <ready-json-path>");
}

try {
  const backend = resolveCgroupV2Backend({
    parentSessionId: agentId(`nested-controller-${process.pid}`),
    receiptPathFor: (attemptId) => containmentReceiptPath(stateDir, `nested-${attemptId}.json`),
  });
  await backend.preflight();
  const attemptId = createRunAttemptId();
  const attempt = backend.prepareAttempt(attemptId);
  const client = new WatchdogClient({
    attemptId,
    receiptPath: containmentReceiptPath(stateDir, `nested-${attemptId}.json`),
    attempt,
  });
  const descriptor = await client.ready();
  await client.launch({
    command: testAbsolutePath(process.execPath),
    args: ["-e", "setInterval(() => {}, 1000)"],
    cwd: testAbsolutePath(stateDir),
    env: process.env,
    shell: false,
  });
  const grandchildPids = readFileSync(join(descriptor.scopePath, "cgroup.procs"), "utf8")
    .split("\n")
    .filter((line) => line.length > 0)
    .map(Number);
  if (grandchildPids.length === 0) throw new Error("nested cgroup fixture launched no grandchild process");
  const record: NestedCgroupReady = {
    controllerPid: process.pid,
    nestedRoot: backend.root,
    nestedScope: descriptor.scopePath,
    grandchildPids,
  };
  publishCommittedSync({ destination: readyPath, data: JSON.stringify(record) });
  await new Promise<never>(() => {});
} catch (error) {
  const message = retainUtf8Tail(error instanceof Error ? error.message : String(error), utf8Bytes(500));
  publishCommittedSync({ destination: `${readyPath}.error`, data: message });
  process.exitCode = 1;
}
