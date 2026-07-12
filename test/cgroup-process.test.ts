import { describe, expect, test } from "bun:test";
import { accessSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { constants } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { resolveCgroupV2Backend } from "../src/cgroup-v2.ts";
import { createRunAttemptId } from "../src/domain.ts";
import { containmentReceiptPath } from "../src/paths.ts";
import { WatchdogClient, verifyContainmentReceipt } from "../src/watchdog-client.ts";

const SETSID = resolveSetsid();

describe("production cgroup-v2 process containment", () => {
  test("kills a setsid descendant outside the launcher process group", async () => {
    const state = mkdtempSync(join(tmpdir(), "pi-cgroup-process-"));
    const pidPath = join(state, "pids.json");
    const backend = resolveCgroupV2Backend({
      parentSessionId: `setsid-process-${process.pid}-${Date.now()}`,
      ...(process.env.PI_SUBAGENTS_CGROUP_ROOT === undefined ? {} : { configuredRoot: process.env.PI_SUBAGENTS_CGROUP_ROOT }),
      receiptPathFor: (attemptId) => containmentReceiptPath(state, `${attemptId}.json`),
    });
    const attemptId = createRunAttemptId();
    let client: WatchdogClient | undefined;
    try {
      await backend.preflight();
      const attempt = backend.prepareAttempt(attemptId);
      client = new WatchdogClient({ attemptId, receiptPath: containmentReceiptPath(state, `${attemptId}.json`), attempt });
      await client.ready();
      const nestedRoot = join(attempt.descriptor.scopePath, "pi-subagents");
      const nestedParent = join(nestedRoot, "nested-parent");
      mkdirSync(nestedRoot, { mode: 0o700 });
      mkdirSync(nestedParent, { mode: 0o700 });
      await client.launch({
        command: process.execPath as never,
        args: [join(import.meta.dir, "fixtures/setsid-descendant.mjs"), pidPath, SETSID],
        cwd: state as never,
        env: process.env,
        shell: false,
      });
      const pids = await waitForPids(pidPath);
      expect(processGroup(pids.detached)).not.toBe(processGroup(pids.launcher));
      expect(pids.cgroups.detached).toContain(cgroupMembershipPath(attempt.descriptor.scopePath));

      await client.close();
      const receiptPath = containmentReceiptPath(state, `${attemptId}.json`);
      verifyContainmentReceipt(receiptPath, attemptId, undefined, attempt.descriptor);
      const receipt = JSON.parse(readFileSync(receiptPath, "utf8"));
      expect(processAbsent(pids.detached)).toBeTrue();
      expect(Object.keys(receipt).sort()).toEqual([
        "attemptId", "backend", "outcome", "populated", "scopePath", "timestamp", "version",
      ]);
      expect(receipt).toMatchObject({
        version: 2,
        backend: "cgroup-v2",
        scopePath: attempt.descriptor.scopePath,
        populated: false,
      });
      expect(existsSync(nestedParent)).toBeFalse();
      expect(existsSync(nestedRoot)).toBeFalse();
      expect(existsSync(attempt.descriptor.scopePath)).toBeFalse();
    } finally {
      await client?.close().catch(() => undefined);
      await backend.shutdown().catch(() => undefined);
      rmSync(state, { recursive: true, force: true });
    }
  }, 30_000);
});

function resolveSetsid(): string {
  for (const directory of (process.env.PATH ?? "").split(":")) {
    const candidate = join(directory || ".", "setsid");
    try {
      accessSync(candidate, constants.X_OK);
      const resolved = realpathSync(candidate);
      if (resolved.startsWith("/")) return resolved;
    } catch { /* continue searching PATH */ }
  }
  throw new Error("cgroup process prerequisite missing: system setsid executable was not found on PATH");
}

async function waitForPids(path: string): Promise<{ launcher: number; child: number; detached: number; cgroups: { launcher: string; child: string; detached: string } }> {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    if (existsSync(path)) return JSON.parse(readFileSync(path, "utf8")) as Awaited<ReturnType<typeof waitForPids>>;
    await Bun.sleep(20);
  }
  throw new Error("setsid descendant fixture did not record PIDs");
}

function cgroupMembershipPath(scope: string): string {
  return scope.startsWith("/sys/fs/cgroup/") ? scope.slice("/sys/fs/cgroup".length) : scope;
}

function processGroup(pid: number): number {
  const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
  const tail = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
  return Number(tail[2]);
}

function processAbsent(pid: number): boolean {
  try { process.kill(pid, 0); return false; }
  catch (error) { return (error as NodeJS.ErrnoException).code === "ESRCH"; }
}
