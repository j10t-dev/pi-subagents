import { execSync } from "node:child_process";
import { lstatSync, mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import {
  agentId,
  observationRevision,
  type AbsolutePath,
  type AgentId,
  type ObservationRevision,
  type ObservationSnapshotPath,
} from "../src/domain.ts";
import { absolutePath } from "../src/paths.ts";
import {
  MAX_SNAPSHOT_BYTES,
  observationSnapshotPath,
  readKnownChildSnapshots,
  type ObservationSnapshotV1,
} from "../src/observation-snapshot-path.ts";

/**
 * Simulates a caller that bypassed `agentId()` and cast a raw string. Brands are erased at
 * runtime, so the module must still defend its path construction against these values.
 */
function smuggled(value: string): AgentId {
  return value as AgentId;
}

const CHILD_1 = agentId("child-1");

let agentDir: AbsolutePath;
beforeEach(() => { agentDir = absolutePath(mkdtempSync(join(tmpdir(), "obs-path-"))); });
afterEach(() => { rmSync(agentDir, { recursive: true, force: true }); });

function writeSnapshot(sessionId: AgentId, snapshot: unknown): void {
  const path = observationSnapshotPath(agentDir, sessionId);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(snapshot));
}

const valid: ObservationSnapshotV1 = {
  version: 1,
  sessionId: CHILD_1,
  revision: observationRevision(3),
  agents: [{ ordinal: "A1", state: "running", taskLabel: "Research terminal UX" }],
};

describe("observationSnapshotPath", () => {
  test("builds a proven path beneath the managed pi-subagents root", () => {
    const path: ObservationSnapshotPath = observationSnapshotPath(
      absolutePath("/agent"),
      agentId("abc123"),
    );
    const absolute: AbsolutePath = path;
    expect(String(absolute)).toBe("/agent/pi-subagents/abc123/ui/observation-v1.json");
  });

  test("rejects a smuggled session id containing a path separator", () => {
    expect(() => observationSnapshotPath(absolutePath("/agent"), smuggled("../escape"))).toThrow(/session id/i);
    expect(() => observationSnapshotPath(absolutePath("/agent"), smuggled("a/b"))).toThrow(/session id/i);
  });

  test("rejects a smuggled empty or relative session id", () => {
    expect(() => observationSnapshotPath(absolutePath("/agent"), smuggled(""))).toThrow(/session id/i);
    expect(() => observationSnapshotPath(absolutePath("/agent"), smuggled("."))).toThrow(/session id/i);
    expect(() => observationSnapshotPath(absolutePath("/agent"), smuggled(".."))).toThrow(/session id/i);
  });
});

describe("readKnownChildSnapshots", () => {
  test("reads only snapshots for known child session ids", () => {
    writeSnapshot(CHILD_1, valid);
    writeSnapshot(agentId("intruder"), { ...valid, sessionId: "intruder" });
    const result = readKnownChildSnapshots(agentDir, [CHILD_1]);
    expect([...result.snapshots.keys()]).toEqual([CHILD_1]);
    const snapshot = result.snapshots.get(CHILD_1);
    const session: AgentId | undefined = snapshot?.sessionId;
    const revision: ObservationRevision | undefined = snapshot?.revision;
    expect(session).toBe(CHILD_1);
    expect(revision).toBe(observationRevision(3));
    expect(result.skipped.size).toBe(0);
  });

  test("reports a missing snapshot as skipped rather than throwing", () => {
    const result = readKnownChildSnapshots(agentDir, [agentId("never-written")]);
    expect(result.snapshots.size).toBe(0);
    expect(result.skipped.get(agentId("never-written"))).toBe("missing");
  });

  test("reports a malformed snapshot", () => {
    const path = observationSnapshotPath(agentDir, CHILD_1);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, "{ not json");
    const result = readKnownChildSnapshots(agentDir, [CHILD_1]);
    expect(result.snapshots.size).toBe(0);
    expect(result.skipped.get(CHILD_1)).toBe("malformed");
  });

  test("reports an oversized snapshot", () => {
    writeSnapshot(CHILD_1, { ...valid, agents: [{ ordinal: "A1", state: "running", taskLabel: "x".repeat(MAX_SNAPSHOT_BYTES) }] });
    const result = readKnownChildSnapshots(agentDir, [CHILD_1]);
    expect(result.snapshots.size).toBe(0);
    expect(result.skipped.get(CHILD_1)).toBe("oversized");
  });

  test.each([-1, 1.5, Number.MAX_SAFE_INTEGER + 1])(
    "reports malformed observation revision %p",
    (revision) => {
      writeSnapshot(CHILD_1, { ...valid, revision });
      const result = readKnownChildSnapshots(agentDir, [CHILD_1]);
      expect(result.snapshots.size).toBe(0);
      expect(result.skipped.get(CHILD_1)).toBe("malformed");
    },
  );

  test("reports a snapshot whose declared sessionId does not match its slot", () => {
    writeSnapshot(CHILD_1, { ...valid, sessionId: "someone-else" });
    const result = readKnownChildSnapshots(agentDir, [CHILD_1]);
    expect(result.snapshots.size).toBe(0);
    expect(result.skipped.get(CHILD_1)).toBe("session-id-mismatch");
  });

  test("reports a smuggled session id as invalid instead of building a path from it", () => {
    const result = readKnownChildSnapshots(agentDir, [smuggled("../escape")]);
    expect(result.snapshots.size).toBe(0);
    expect(result.skipped.get(smuggled("../escape"))).toBe("invalid-session-id");
  });

  test("reports a slot whose directory symlinks outside the managed root", () => {
    // Plant a valid snapshot outside the managed root, then point the child's slot dir at it via a
    // symlink. The reader must refuse to follow the escape, and must say why.
    const outside = mkdtempSync(join(tmpdir(), "pi-snap-escape-"));
    const outsideUi = join(outside, "ui");
    mkdirSync(outsideUi, { recursive: true });
    writeFileSync(join(outsideUi, "observation-v1.json"), JSON.stringify({ ...valid, sessionId: "child-1" }));
    const slotDir = join(agentDir, "pi-subagents", "child-1");
    mkdirSync(dirname(slotDir), { recursive: true });
    try {
      symlinkSync(outside, slotDir);
    } catch {
      return; // platform without symlink support: nothing to prove
    }
    const result = readKnownChildSnapshots(agentDir, [CHILD_1]);
    expect(result.snapshots.size).toBe(0);
    expect(result.skipped.get(CHILD_1)).toBe("escapes-managed-root");
    rmSync(outside, { recursive: true, force: true });
  });

  test.skipIf(process.platform === "win32")(
    "skips a FIFO planted at the snapshot path instead of blocking forever",
    () => {
      // The slot directory is created by a same-user child process, so a hostile or buggy child can
      // plant a FIFO where the snapshot file belongs. A blocking open(2) would wedge the reader
      // permanently; the documented contract is that a non-regular file is skipped.
      // The read runs in a subprocess under a hard timeout because a synchronous open(2) block
      // cannot be interrupted by any in-process timer: were the guard removed, an in-process read
      // would hang the whole suite instead of failing, and a hang is a far worse signal than a
      // red test.
      const path = observationSnapshotPath(agentDir, CHILD_1);
      mkdirSync(dirname(path), { recursive: true });
      execSync(`mkfifo '${path.replace(/'/g, "'\\''")}'`);
      try {
        expect(lstatSync(path).isFIFO()).toBe(true); // the hazard really is in place
        const module = join(import.meta.dir, "..", "src", "observation-snapshot-path.ts");
        const domain = join(import.meta.dir, "..", "src", "domain.ts");
        const probe = Bun.spawnSync({
          cmd: [
            process.execPath,
            "-e",
            `import { readKnownChildSnapshots } from ${JSON.stringify(module)};` +
              `import { agentId } from ${JSON.stringify(domain)};` +
              `const r = readKnownChildSnapshots(${JSON.stringify(agentDir)}, [agentId("child-1")]);` +
              `process.stdout.write(\`\${r.snapshots.size}:\${r.skipped.get(agentId("child-1"))}\`);`,
          ],
          timeout: 5000,
        });
        // A blocked open(2) would be killed by the timeout, surfacing as SIGTERM and a null exit.
        expect(probe.signalCode ?? null).toBeNull();
        expect(probe.exitCode).toBe(0);
        expect(probe.stdout.toString()).toBe("0:not-a-regular-file");
      } finally {
        rmSync(path, { force: true });
      }
    },
  );
});
