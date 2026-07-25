import { constants as fsConstants, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import {
  AgentState,
  agentCount,
  agentId,
  agentObservationRevision,
  agentOrdinal,
  incarnationId,
  observationRevision,
  type AbsolutePath,
  type ContextLabel,
  type ModelLabel,
  type TaskLabel,
} from "../src/domain.ts";
import type { DirectAgentSnapshotResult, SubagentObservationPort } from "../src/agent-observation.ts";
import { systemDurableFileSystem } from "../src/durable-fs.ts";
import { absolutePath } from "../src/paths.ts";
import { observationSnapshotPath, readKnownChildSnapshots } from "../src/observation-snapshot-path.ts";
import {
  createObservationRelay,
  type ObservationRelayDependencies,
} from "../src/observation-relay.ts";

const SESSION_ID = agentId("relay-owner");
let agentDir: AbsolutePath;
let diagnostics: string[];

beforeEach(() => {
  agentDir = absolutePath(mkdtempSync(join(tmpdir(), "observation-relay-")));
  diagnostics = [];
});
afterEach(() => { rmSync(agentDir, { recursive: true, force: true }); });

function row(index: number, long = false) {
  return {
    agentId: agentId(`child-${index}`),
    row: {
      ordinal: agentOrdinal(`A${index}`), model: (long ? "m".repeat(1024) : "model:high") as ModelLabel,
      context: "42%" as ContextLabel, taskLabel: (long ? "t".repeat(512) : `Task ${index}`) as TaskLabel,
      state: AgentState.Running,
    },
  };
}

function direct(
  entries = [row(1)],
  options: { readonly total?: number; readonly omitted?: number; readonly omittedActive?: number; readonly degraded?: boolean } = {},
): DirectAgentSnapshotResult {
  return {
    kind: "snapshot", revision: agentObservationRevision(7),
    health: options.degraded ? { kind: "degraded", codes: ["projection-failed"] } : { kind: "healthy" },
    total: agentCount(options.total ?? entries.length), omitted: agentCount(options.omitted ?? 0),
    omittedActive: agentCount(options.omittedActive ?? 0), entries: entries as never,
  };
}

function port(result: DirectAgentSnapshotResult): SubagentObservationPort {
  return {
    observation: () => undefined,
    directSnapshot: () => result,
    transcriptSource: () => undefined,
    subscribe: () => () => {},
  };
}

function relay(overrides: Partial<ObservationRelayDependencies> = {}) {
  return createObservationRelay({
    agentDir, sessionId: SESSION_ID, incarnation: incarnationId("relay-test"),
    diagnostic: (code) => diagnostics.push(code), ...overrides,
  });
}

function published() {
  return readKnownChildSnapshots(agentDir, [SESSION_ID]).snapshots.get(SESSION_ID);
}

describe("ObservationRelay", () => {
  test("writes an empty snapshot from a portless initial flush", () => {
    const subject = relay();
    subject.markDirty();
    subject.flush();
    expect(published()).toMatchObject({ total: agentCount(0), omitted: agentCount(0), degraded: false, agents: [] });
  });

  test("projects a restored port and round-trips through the hardened reader", () => {
    const subject = relay();
    subject.setPort(port(direct()));
    subject.flush();
    expect(published()).toMatchObject({ sessionId: SESSION_ID, incarnation: incarnationId("relay-test"), agents: [{ sessionId: agentId("child-1"), ordinal: agentOrdinal("A1") }] });
  });

  test.each([
    ["degraded direct health", direct([row(1)], { degraded: true })],
    ["active omitted direct children", direct([row(1)], { total: 2, omitted: 1, omittedActive: 1 })],
  ] as const)("marks a snapshot degraded for %s", (_name, result) => {
    const subject = relay();
    subject.setPort(port(result));
    subject.flush();
    expect(published()?.degraded).toBe(true);
  });

  test("retains exact prior bytes when the port becomes unavailable", () => {
    const subject = relay();
    subject.setPort(port(direct()));
    subject.flush();
    const path = observationSnapshotPath(agentDir, SESSION_ID);
    const prior = readFileSync(path, "utf8");
    subject.setPort(port({ kind: "unavailable", finalRevision: agentObservationRevision(8) }));
    subject.flush();
    expect(readFileSync(path, "utf8")).toBe(prior);
  });

  test("does not write when a port is withdrawn", () => {
    const subject = relay();
    subject.setPort(port(direct()));
    subject.flush();
    const path = observationSnapshotPath(agentDir, SESSION_ID);
    const prior = readFileSync(path, "utf8");
    subject.setPort(undefined);
    subject.flush();
    expect(readFileSync(path, "utf8")).toBe(prior);
  });

  test("fits a complete 200-row snapshot by dropping only tail rows", () => {
    const entries = Array.from({ length: 200 }, (_, index) => row(index + 1, true));
    const subject = relay();
    subject.setPort(port(direct(entries)));
    subject.flush();
    const value = published();
    const expectedDropped = 200 - (value?.agents.length ?? 0);
    expect(value).toMatchObject({ total: agentCount(200), omitted: agentCount(expectedDropped), degraded: true });
    expect(value?.agents.map((entry) => entry.ordinal)).toEqual(entries.slice(0, -expectedDropped).map((entry) => entry.row.ordinal));
    expect(expectedDropped).toBeGreaterThan(0);
  });

  test("reports relay_encode_oversized only when even the zero-row snapshot cannot encode", () => {
    const subject = relay({ encodeObservationSnapshot: () => ({ ok: false, reason: "oversized" }) });
    subject.markDirty();
    subject.flush();
    expect(diagnostics).toEqual(["relay_encode_oversized"]);
    expect(published()).toBeUndefined();
  });

  test("opens temporary snapshots with explicit create-exclusive no-follow flags", () => {
    const temporaryFlags: unknown[] = [];
    const filesystem = {
      ...systemDurableFileSystem,
      open: (path: string, flags: string | number, mode?: number) => {
        if (path.includes(".observation-")) temporaryFlags.push(flags);
        return systemDurableFileSystem.open(path, flags, mode);
      },
    };
    const subject = relay({ filesystem });
    subject.setPort(port(direct()));
    subject.flush();
    expect(temporaryFlags).toEqual([fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_NOFOLLOW]);
  });

  test("refuses publication when managed component lstat validation is interrupted", () => {
    const managedRoot = join(agentDir, "pi-subagents");
    const filesystem = {
      ...systemDurableFileSystem,
      lstat: (path: string) => {
        if (path === managedRoot) throw new Error("component replaced during validation");
        return systemDurableFileSystem.lstat(path);
      },
    };
    const subject = relay({ filesystem });
    subject.setPort(port(direct()));
    subject.flush();
    expect(published()).toBeUndefined();
    expect(diagnostics).toContain("relay_write_failed");
  });

  test("atomically replaces the slot only after a complete temporary write", () => {
    const renameObservations: string[] = [];
    const filesystem = {
      ...systemDurableFileSystem,
      rename: (source: string, destination: string) => {
        renameObservations.push(`${existsSync(source)}:${existsSync(destination)}`);
        systemDurableFileSystem.rename(source, destination);
      },
    };
    const subject = relay({ filesystem });
    subject.setPort(port(direct([row(1)])));
    subject.flush();
    subject.setPort(port(direct([row(2)])));
    subject.flush();
    expect(renameObservations).toEqual(["true:false", "true:true"]);
    expect(published()?.agents[0]?.sessionId).toBe(agentId("child-2"));
  });

  test("does not advance revision after a failed write", () => {
    let failWrites = false;
    const subject = relay({
      filesystem: { ...systemDurableFileSystem, write: (fd, data) => {
        if (failWrites) throw new Error("write blocked");
        systemDurableFileSystem.write(fd, data);
      } },
    });
    subject.setPort(port(direct([row(1)])));
    subject.flush();
    expect(published()?.revision).toBe(observationRevision(1));
    failWrites = true;
    subject.setPort(port(direct([row(2)])));
    subject.flush();
    expect(published()?.revision).toBe(observationRevision(1));
    expect(diagnostics).toContain("relay_write_failed");
  });

  test("does not traverse a symlinked owner slot", () => {
    const outside = mkdtempSync(join(tmpdir(), "observation-relay-escape-"));
    const ownerDirectory = join(agentDir, "pi-subagents", String(SESSION_ID));
    mkdirSync(join(agentDir, "pi-subagents"), { recursive: true });
    try {
      symlinkSync(outside, ownerDirectory, "dir");
    } catch {
      rmSync(outside, { recursive: true, force: true });
      return;
    }
    const subject = relay();
    subject.setPort(port(direct()));
    subject.flush();
    expect(existsSync(join(outside, "observation.json"))).toBe(false);
    expect(existsSync(join(outside, "ui"))).toBe(false);
    expect(existsSync(join(outside, "ui", "observation.json"))).toBe(false);
    expect(diagnostics).toContain("relay_write_failed");
    rmSync(outside, { recursive: true, force: true });
  });

  test("dispose releases private relay state without removing the slot", () => {
    const subject = relay();
    subject.setPort(port(direct()));
    subject.flush();
    const path = observationSnapshotPath(agentDir, SESSION_ID);
    subject.dispose();
    expect(existsSync(path)).toBe(true);
  });
});
