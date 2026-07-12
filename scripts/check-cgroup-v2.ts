import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { resolveCgroupV2Backend } from "../src/cgroup-v2.ts";
import { containmentReceiptPath } from "../src/paths.ts";

const state = mkdtempSync(join(tmpdir(), "pi-subagents-cgroup-check-"));
let root: string | undefined;

try {
  const backend = resolveCgroupV2Backend({
    parentSessionId: `cgroup-check-${process.pid}-${Date.now()}`,
    ...(process.env.PI_SUBAGENTS_CGROUP_ROOT === undefined
      ? {}
      : { configuredRoot: process.env.PI_SUBAGENTS_CGROUP_ROOT }),
    receiptPathFor: (attemptId) => containmentReceiptPath(state, `${attemptId}.json`),
  });
  root = backend.root;
  try {
    await backend.preflight();
  } finally {
    await backend.shutdown();
  }
  process.stdout.write(`cgroup-v2 containment available: ${root}\n`);
} catch {
  process.stderr.write("cgroup-v2 containment unavailable: cgroup-v2\n");
  process.exitCode = 1;
} finally {
  rmSync(state, { recursive: true, force: true });
}
