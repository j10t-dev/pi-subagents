import { randomUUID } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import { join } from "node:path";

import type { DirectAgentSnapshotResult, SubagentObservationPort } from "./agent-observation.ts";
import { agentCount, newIncarnationId, observationRevision, type AbsolutePath, type AgentCount, type AgentId, type IncarnationId, type ObservationRevision } from "./domain.ts";
import { systemDurableFileSystem, type DurableFileSystem } from "./durable-fs.ts";
import { STATE_DIR_NAME } from "./constants.ts";
import { isContainedPath } from "./paths.ts";
import { encodeObservationSnapshot, observationSlotDirectory, observationSnapshotPath, type ObservationSnapshot } from "./observation-snapshot-path.ts";
import { WidgetDiagnosticCode, type WidgetDiagnosticCode as WidgetDiagnosticCodeValue } from "./widget-diagnostics.ts";

export interface ObservationRelay {
  setPort(port: SubagentObservationPort | undefined): void;
  markDirty(): void;
  flush(): void;
  dispose(): void;
}

/** Narrow construction boundary for the owner-only current observation publisher. */
export interface ObservationRelayDependencies {
  readonly agentDir: AbsolutePath;
  readonly sessionId: AgentId;
  readonly diagnostic: (code: WidgetDiagnosticCodeValue) => void;
  readonly filesystem?: DurableFileSystem;
  readonly incarnation?: IncarnationId;
  /** Test seam for the otherwise impossible zero-row oversize condition. */
  readonly encodeObservationSnapshot?: typeof encodeObservationSnapshot;
}

export function createObservationRelay(dependencies: ObservationRelayDependencies): ObservationRelay {
  return new ManagedObservationRelay(dependencies);
}

type AvailableDirectSnapshot = Extract<DirectAgentSnapshotResult, { readonly kind: "snapshot" }>;

class ManagedObservationRelay implements ObservationRelay {
  private readonly filesystem: DurableFileSystem;
  private readonly incarnation: IncarnationId;
  private readonly encode: typeof encodeObservationSnapshot;
  private port: SubagentObservationPort | undefined;
  private dirty = false;
  private hasReceivedPort = false;
  private disposed = false;
  private lastSuccessfulRevision: ObservationRevision = observationRevision(0);

  constructor(private readonly dependencies: ObservationRelayDependencies) {
    this.filesystem = dependencies.filesystem ?? systemDurableFileSystem;
    this.incarnation = dependencies.incarnation ?? newIncarnationId();
    this.encode = dependencies.encodeObservationSnapshot ?? encodeObservationSnapshot;
  }

  setPort(port: SubagentObservationPort | undefined): void {
    if (this.disposed) return;
    this.port = port;
    if (port !== undefined) {
      this.hasReceivedPort = true;
      this.dirty = true;
    }
  }

  markDirty(): void {
    if (!this.disposed) this.dirty = true;
  }

  flush(): void {
    if (this.disposed || !this.dirty) return;
    const direct = this.currentDirectSnapshot();
    if (direct === undefined) return;
    const revision = observationRevision(Number(this.lastSuccessfulRevision) + 1);
    const fitted = this.fit(direct, revision);
    if (fitted === undefined) return;
    if (!this.publish(fitted)) return;
    this.lastSuccessfulRevision = revision;
    this.dirty = false;
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.port = undefined;
    this.dirty = false;
  }

  private currentDirectSnapshot(): AvailableDirectSnapshot | "empty" | undefined {
    if (this.port === undefined) return this.hasReceivedPort ? undefined : "empty";
    try {
      const snapshot = this.port.directSnapshot();
      return snapshot.kind === "snapshot" ? snapshot : undefined;
    } catch {
      return undefined;
    }
  }

  private fit(direct: AvailableDirectSnapshot | "empty", revision: ObservationRevision): ObservationSnapshot | undefined {
    const total = direct === "empty" ? agentCount(0) : direct.total;
    const all = direct === "empty" ? [] : direct.entries.map(({ agentId, row }) => ({
      ordinal: row.ordinal, sessionId: agentId, model: row.model, context: row.context, taskLabel: row.taskLabel, state: row.state,
    }));
    let retained = all;
    let degraded = direct !== "empty" && (direct.health.kind === "degraded" || Number(direct.omittedActive) > 0);
    while (true) {
      let omitted: AgentCount;
      try {
        omitted = agentCount(Number(total) - retained.length);
      } catch {
        return undefined;
      }
      const snapshot: ObservationSnapshot = {
        sessionId: this.dependencies.sessionId, incarnation: this.incarnation, revision, total, omitted, degraded, agents: retained,
      };
      const encoded = this.encode(snapshot);
      if (encoded.ok) return snapshot;
      if (retained.length === 0) {
        this.report(WidgetDiagnosticCode.RelayEncodeOversized);
        return undefined;
      }
      retained = retained.slice(0, -1);
      degraded = true;
    }
  }

  private publish(snapshot: ObservationSnapshot): boolean {
    const directory = observationSlotDirectory(this.dependencies.agentDir, this.dependencies.sessionId);
    const destination = observationSnapshotPath(this.dependencies.agentDir, this.dependencies.sessionId);
    const encoded = this.encode(snapshot);
    if (!encoded.ok) {
      this.report(WidgetDiagnosticCode.RelayEncodeOversized);
      return false;
    }
    let temporary: string | undefined;
    try {
      this.prepareManagedDirectory(directory);
      temporary = join(directory, `.observation-${randomUUID()}.tmp`);
      writeSyncedFile(temporary, encoded.text, this.filesystem);
    } catch {
      this.cleanup(temporary);
      this.report(WidgetDiagnosticCode.RelayWriteFailed);
      return false;
    }
    try {
      this.filesystem.rename(temporary, destination);
      temporary = undefined;
      syncDirectory(directory, this.filesystem);
      return true;
    } catch {
      this.cleanup(temporary);
      this.report(WidgetDiagnosticCode.RelayRenameFailed);
      return false;
    }
  }

  private prepareManagedDirectory(directory: string): void {
    const agentRoot = this.requireDirectory(this.dependencies.agentDir);
    const managedRoot = join(this.dependencies.agentDir, STATE_DIR_NAME);
    const ownerDirectory = join(managedRoot, this.dependencies.sessionId);
    let parent: string = this.dependencies.agentDir;
    for (const component of [managedRoot, ownerDirectory, directory]) {
      this.ensureManagedDirectoryComponent(component, parent, agentRoot);
      parent = component;
    }
  }

  /** Creates one component only after proving its parent and re-proves the new component. */
  private ensureManagedDirectoryComponent(path: string, parent: string, agentRoot: string): void {
    try {
      this.requireDirectory(path, agentRoot);
      return;
    } catch (error) {
      if (!isMissing(error)) throw error;
    }
    this.requireDirectory(parent, agentRoot);
    try {
      this.filesystem.mkdir(path, 0o700);
    } catch (error) {
      if (!isAlreadyExists(error)) throw error;
    }
    syncDirectory(parent, this.filesystem);
    this.requireDirectory(path, agentRoot);
  }

  /** Refuses links and non-directories before every descent, then proves real containment. */
  private requireDirectory(path: string, agentRoot?: string): string {
    const entry = this.filesystem.lstat(path);
    if (!entry.isDirectory() || entry.isSymbolicLink()) {
      throw new Error("observation relay directory component is unsafe");
    }
    const resolved = this.filesystem.realpath(path);
    if (agentRoot !== undefined && !isContainedPath(agentRoot, resolved)) {
      throw new Error("observation relay path escapes managed root");
    }
    return resolved;
  }

  private cleanup(path: string | undefined): void {
    if (path === undefined) return;
    try {
      if (this.filesystem.exists(path)) this.filesystem.unlink(path);
    } catch { /* retain the publication failure */ }
  }

  private report(code: WidgetDiagnosticCodeValue): void {
    try { this.dependencies.diagnostic(code); } catch { /* diagnostics cannot block projection */ }
  }
}

function writeSyncedFile(path: string, text: string, filesystem: DurableFileSystem): void {
  let fd: number | undefined;
  let failure: Error | undefined;
  try {
    fd = filesystem.open(path, fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_NOFOLLOW, 0o600);
    filesystem.write(fd, text);
    filesystem.sync(fd);
  } catch (error) {
    failure = asError(error);
  } finally {
    if (fd !== undefined) {
      try { filesystem.close(fd); } catch (error) { failure ??= asError(error); }
    }
  }
  if (failure !== undefined) throw failure;
}

function isMissing(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}

function isAlreadyExists(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "EEXIST";
}

function syncDirectory(path: string, filesystem: DurableFileSystem): void {
  let fd: number | undefined;
  let failure: Error | undefined;
  try {
    fd = filesystem.open(path, "r");
    filesystem.sync(fd);
  } catch (error) {
    failure = asError(error);
  } finally {
    if (fd !== undefined) {
      try { filesystem.close(fd); } catch (error) { failure ??= asError(error); }
    }
  }
  if (failure !== undefined) throw failure;
}

function asError(value: unknown): Error {
  return value instanceof Error ? value : new Error(String(value), { cause: value });
}
