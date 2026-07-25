import { execSync } from "node:child_process";
import { lstatSync, mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import {
  AgentState,
  agentCount,
  agentId,
  agentOrdinal,
  incarnationId,
  observationRevision,
  type AbsolutePath,
  type AgentId,
  type ContextLabel,
  type ModelLabel,
  type ObservationSnapshotPath,
  type TaskLabel,
} from "../src/domain.ts";
import { absolutePath } from "../src/paths.ts";
import {
  MAX_SNAPSHOT_BYTES,
  encodeObservationSnapshot,
  observationSlotDirectory,
  observationSnapshotPath,
  readKnownChildSnapshots,
  type ObservationSnapshot,
} from "../src/observation-snapshot-path.ts";

function smuggled(value: string): AgentId {
  return value as AgentId;
}

const CHILD_1 = agentId("child-1");
const ROW = {
  ordinal: agentOrdinal("A1"), sessionId: agentId("grandchild-1"), model: "model:high" as ModelLabel,
  context: "42%" as ContextLabel, taskLabel: "Research terminal UX" as TaskLabel, state: AgentState.Running,
};

let agentDir: AbsolutePath;
beforeEach(() => { agentDir = absolutePath(mkdtempSync(join(tmpdir(), "obs-path-"))); });
afterEach(() => { rmSync(agentDir, { recursive: true, force: true }); });

function snapshot(overrides: Partial<ObservationSnapshot> = {}): ObservationSnapshot {
  return {
    sessionId: CHILD_1, incarnation: incarnationId("relay_1"), revision: observationRevision(3),
    total: agentCount(1), omitted: agentCount(0), degraded: false, agents: [ROW], ...overrides,
  };
}

function writeSnapshot(sessionId: AgentId, value: unknown): void {
  const path = observationSnapshotPath(agentDir, sessionId);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(value));
}

function raw(value: ObservationSnapshot): Record<string, unknown> {
  return JSON.parse(JSON.stringify(value)) as Record<string, unknown>;
}

describe("managed observation slot paths", () => {
  test("builds a shared slot directory and observation.json path beneath the managed root", () => {
    expect(String(observationSlotDirectory(absolutePath("/agent"), agentId("abc123")))).toBe(
      "/agent/pi-subagents/abc123/ui",
    );
    const path: ObservationSnapshotPath = observationSnapshotPath(absolutePath("/agent"), agentId("abc123"));
    expect(String(path)).toBe("/agent/pi-subagents/abc123/ui/observation.json");
  });

  test("rejects smuggled session IDs before path construction", () => {
    for (const value of ["", ".", "..", "../escape", "a/b"]) {
      expect(() => observationSlotDirectory(absolutePath("/agent"), smuggled(value))).toThrow(/session id/i);
    }
  });
});

describe("current observation snapshot codec", () => {
  test("round-trips the current wire through the known-child reader", () => {
    const value = snapshot();
    expect(encodeObservationSnapshot(value)).toEqual({ ok: true, text: expect.any(String) });
    writeSnapshot(CHILD_1, value);
    expect(readKnownChildSnapshots(agentDir, [value.sessionId]).snapshots.get(value.sessionId)).toEqual(value);
  });

  test("accepts a composed local ordinal", () => {
    const value = snapshot({ agents: [{ ...ROW, ordinal: agentOrdinal("A1.2") }] });
    writeSnapshot(CHILD_1, value);
    expect(readKnownChildSnapshots(agentDir, [CHILD_1]).snapshots.get(CHILD_1)).toEqual(value);
  });

  test.each([
    ["missing sessionId", (value: Record<string, unknown>) => { delete value.sessionId; }],
    ["invalid incarnation alphabet", (value: Record<string, unknown>) => { value.incarnation = "bad/incarnation"; }],
    ["invalid incarnation length", (value: Record<string, unknown>) => { value.incarnation = "x".repeat(65); }],
    ["negative count", (value: Record<string, unknown>) => { value.total = -1; }],
    ["inconsistent omitted", (value: Record<string, unknown>) => { value.omitted = 1; }],
    ["duplicate ordinal", (value: Record<string, unknown>) => { value.agents = [ROW, { ...ROW, sessionId: agentId("grandchild-2") }]; value.total = 2; }],
    ["duplicate session ID", (value: Record<string, unknown>) => { value.agents = [ROW, { ...ROW, ordinal: agentOrdinal("A2") }]; value.total = 2; }],
    ["invalid state", (value: Record<string, unknown>) => { (value.agents as Array<Record<string, unknown>>)[0]!.state = "unknown"; }],
    ["task-label control", (value: Record<string, unknown>) => { (value.agents as Array<Record<string, unknown>>)[0]!.taskLabel = "bad\nlabel"; }],
    ["model control", (value: Record<string, unknown>) => { (value.agents as Array<Record<string, unknown>>)[0]!.model = "bad\u0000model"; }],
    ["context control", (value: Record<string, unknown>) => { (value.agents as Array<Record<string, unknown>>)[0]!.context = "bad\u007f"; }],
    ["task-label byte limit", (value: Record<string, unknown>) => { (value.agents as Array<Record<string, unknown>>)[0]!.taskLabel = "£".repeat(257); }],
    ["model byte limit", (value: Record<string, unknown>) => { (value.agents as Array<Record<string, unknown>>)[0]!.model = "£".repeat(513); }],
    ["context character limit", (value: Record<string, unknown>) => { (value.agents as Array<Record<string, unknown>>)[0]!.context = "123456789"; }],
  ] as const)("rejects malformed %s", (_name, mutate) => {
    const value = raw(snapshot());
    mutate(value);
    writeSnapshot(CHILD_1, value);
    expect(readKnownChildSnapshots(agentDir, [CHILD_1]).skipped.get(CHILD_1)).toBe("malformed");
  });

  test("reports a snapshot whose declared session ID does not match its slot", () => {
    writeSnapshot(CHILD_1, { ...snapshot(), sessionId: "someone-else" });
    expect(readKnownChildSnapshots(agentDir, [CHILD_1]).skipped.get(CHILD_1)).toBe("session-id-mismatch");
  });

  test("rejects a snapshot with more than the widget row bound", () => {
    const agents = Array.from({ length: 201 }, (_, index) => ({ ...ROW, ordinal: agentOrdinal(`A${index + 1}`), sessionId: agentId(`descendant-${index + 1}`) }));
    writeSnapshot(CHILD_1, { ...snapshot(), total: agentCount(201), agents });
    expect(readKnownChildSnapshots(agentDir, [CHILD_1]).skipped.get(CHILD_1)).toBe("malformed");
  });
});

describe("readKnownChildSnapshots hardening", () => {
  test("reads only requested known slots", () => {
    writeSnapshot(CHILD_1, snapshot());
    writeSnapshot(agentId("intruder"), { ...snapshot(), sessionId: "intruder" });
    expect([...readKnownChildSnapshots(agentDir, [CHILD_1]).snapshots.keys()]).toEqual([CHILD_1]);
  });

  test("reports missing, oversized and smuggled slots without throwing", () => {
    expect(readKnownChildSnapshots(agentDir, [agentId("never-written")]).skipped.get(agentId("never-written"))).toBe("missing");
    writeSnapshot(CHILD_1, { ...raw(snapshot()), ignored: "x".repeat(Number(MAX_SNAPSHOT_BYTES)) });
    expect(readKnownChildSnapshots(agentDir, [CHILD_1]).skipped.get(CHILD_1)).toBe("oversized");
    expect(readKnownChildSnapshots(agentDir, [smuggled("../escape")]).skipped.get(smuggled("../escape"))).toBe("invalid-session-id");
  });

  test("refuses a child slot symlinked outside the managed root", () => {
    const outside = mkdtempSync(join(tmpdir(), "pi-snap-escape-"));
    mkdirSync(join(outside, "ui"), { recursive: true });
    writeFileSync(join(outside, "ui", "observation.json"), JSON.stringify(snapshot()));
    const slot = join(agentDir, "pi-subagents", "child-1");
    mkdirSync(dirname(slot), { recursive: true });
    try {
      symlinkSync(outside, slot);
    } catch {
      rmSync(outside, { recursive: true, force: true });
      return;
    }
    expect(readKnownChildSnapshots(agentDir, [CHILD_1]).skipped.get(CHILD_1)).toBe("escapes-managed-root");
    rmSync(outside, { recursive: true, force: true });
  });

  test.skipIf(process.platform === "win32")("refuses a FIFO slot without blocking", () => {
    const path = observationSnapshotPath(agentDir, CHILD_1);
    mkdirSync(dirname(path), { recursive: true });
    execSync(`mkfifo '${path.replace(/'/g, "'\\''")}'`);
    try {
      expect(lstatSync(path).isFIFO()).toBe(true);
      const module = join(import.meta.dir, "..", "src", "observation-snapshot-path.ts");
      const domain = join(import.meta.dir, "..", "src", "domain.ts");
      const probe = Bun.spawnSync({
        cmd: [process.execPath, "-e", `import { readKnownChildSnapshots } from ${JSON.stringify(module)};` +
          `import { agentId } from ${JSON.stringify(domain)};` +
          `const r = readKnownChildSnapshots(${JSON.stringify(agentDir)}, [agentId("child-1")]);` +
          `process.stdout.write(\`\${r.snapshots.size}:\${r.skipped.get(agentId("child-1"))}\`);`],
        timeout: 5000,
      });
      expect(probe.signalCode ?? null).toBeNull();
      expect(probe.exitCode).toBe(0);
      expect(probe.stdout.toString()).toBe("0:not-a-regular-file");
    } finally {
      rmSync(path, { force: true });
    }
  });
});
