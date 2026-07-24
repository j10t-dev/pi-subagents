import { spawn } from "node:child_process";
import { createHash, randomBytes as nodeRandomBytes } from "node:crypto";
import {
  mkdirSync,
  readFileSync,
  realpathSync,
  readdirSync,
  rmdirSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { isAbsolute, join, resolve } from "node:path";

import { CONTAINMENT_TIMEOUT_MS } from "./constants.ts";
import type {
  ContainmentAttempt,
  ContainmentBackend,
  ContainmentCandidateDescriptor,
  ContainmentDescriptor,
  ContainmentOutcome,
  RestorationContainmentDescriptor,
} from "./containment.ts";
import { publishCommittedSync } from "./durable-fs.ts";
import {
  AgentErrorCode,
  PublicPreflightError,
  milliseconds,
  processId,
  verifiedContainmentReceiptPath,
  type AbsolutePath,
  type AgentId,
  type CgroupScopePath,
  type ContainmentReceiptPath,
  type Milliseconds,
  type ProcessId,
  type RunAttemptId,
  type VerifiedContainmentReceiptPath,
} from "./domain.ts";
import { absolutePath, isContainedPath } from "./paths.ts";

const UNAVAILABLE_PREFIX = "containment_unavailable:";

export interface CgroupStat {
  isDirectory(): boolean;
  readonly mode: number;
}

export interface CgroupFileSystem {
  readFile(path: string): string;
  writeFile(path: string, value: string): void;
  mkdir(path: string, mode: number): void;
  realpath(path: string): string;
  stat(path: string): CgroupStat;
  removeDirectory(path: string): void;
  /** Returns direct directory-entry names, matching `readdirSync(path)`. */
  list(path: string): readonly string[];
}

export interface ProbeProcess {
  readonly pid: ProcessId;
  release(): void;
  readonly exited: Promise<void>;
  kill(): void;
}

export interface CgroupV2Options {
  readonly parentSessionId: AgentId;
  readonly configuredRoot?: string;
  readonly mountPath?: string;
  readonly selfCgroupText?: string;
  readonly fs?: CgroupFileSystem;
  readonly spawnProbe?: () => ProbeProcess;
  readonly receiptPathFor: (attemptId: RunAttemptId) => ContainmentReceiptPath;
  readonly pollDelay?: (milliseconds: Milliseconds) => Promise<void>;
  readonly now?: () => number;
  readonly randomBytes?: (bytes: number) => Buffer;
  readonly diagnostic?: (message: string) => void;
}

export function cgroupScopeName(value: AgentId | RunAttemptId): string {
  const primitiveIdentity: string = value;
  return createHash("sha256").update(primitiveIdentity).digest("hex");
}

export function resolveCgroupV2Backend(options: CgroupV2Options): ContainmentBackend {
  const fs = options.fs ?? nodeCgroupFileSystem;
  const mountReal = canonicalDirectory(fs, options.mountPath ?? "/sys/fs/cgroup", "mount");
  if (options.configuredRoot !== undefined &&
      (!isAbsolute(options.configuredRoot) || options.configuredRoot.includes("\0"))) {
    unavailable("configured root");
  }
  const root = options.configuredRoot === undefined
    ? resolveDefaultRoot(
      fs,
      mountReal,
      options.selfCgroupText ?? readFileSync("/proc/self/cgroup", "utf8"),
    )
    : canonicalContainedDirectory(fs, mountReal, options.configuredRoot, "configured root");
  const parentCandidate = join(root, cgroupScopeName(options.parentSessionId));
  const parentStat = probeDirectoryStrict(fs, parentCandidate, "parent scope");
  if (parentStat === undefined) {
    filesystemOperation("parent scope", () => fs.mkdir(parentCandidate, 0o700));
  } else if (!parentStat.isDirectory()) {
    unavailable("parent scope");
  }
  const parentReal = canonicalContainedDirectory(fs, root, parentCandidate, "parent scope");
  return new CgroupV2Backend(fs, root, parentReal, options);
}

export type ContainmentProvider =
  | { kind: "available"; backend: ContainmentBackend }
  | { kind: "unavailable"; requireAvailable(): never };

export function createContainmentProvider(options: CgroupV2Options): ContainmentProvider {
  try {
    return { kind: "available", backend: resolveCgroupV2Backend(options) };
  } catch (error) {
    if (!(error instanceof CgroupUnavailableError)) throw error;
    return {
      kind: "unavailable",
      requireAvailable(): never {
        throw new PublicPreflightError(
          AgentErrorCode.ContainmentFailed,
          "cgroup-v2 containment is unavailable",
        );
      },
    };
  }
}

class CgroupV2Backend implements ContainmentBackend {
  private readonly attempts = new Map<RunAttemptId, CgroupAttempt>();
  readonly root: AbsolutePath;
  readonly parentScope: AbsolutePath;

  constructor(
    private readonly fs: CgroupFileSystem,
    root: string,
    parentScope: string,
    private readonly options: CgroupV2Options,
  ) {
    this.root = absolutePath(root);
    this.parentScope = absolutePath(parentScope);
  }

  async preflight(): Promise<void> {
    const name = `preflight-${(this.options.randomBytes ?? nodeRandomBytes)(16).toString("hex")}`;
    const primitiveParentScope: string = this.parentScope;
    const scope = join(primitiveParentScope, name);
    let scopeCreated = false;
    let probe: ProbeProcess | undefined;
    try {
      filesystemOperation("capability probe create", () => this.fs.mkdir(scope, 0o700));
      scopeCreated = true;
      probe = (this.options.spawnProbe ?? defaultProbe)();
      filesystemOperation("probe process move", () => {
        const primitivePid: number = probe!.pid;
        this.fs.writeFile(join(scope, "cgroup.procs"), `${primitivePid}\n`);
      });
      const members = filesystemOperation(
        "probe membership",
        () => parsePids(this.fs.readFile(join(scope, "cgroup.procs"))),
      );
      if (!members.includes(probe.pid)) unavailable("probe membership");
      filesystemOperation("probe kill", () => this.fs.writeFile(join(scope, "cgroup.kill"), "1\n"));
      await this.waitEmpty(scope);
      probe.release();
      await filesystemPromise("probe exit", probe.exited);
      filesystemOperation("probe remove", () => this.fs.removeDirectory(scope));
      scopeCreated = false;
    } catch (error) {
      if (probe !== undefined) {
        bestEffort(() => probe!.kill());
        bestEffort(() => probe!.release());
      }
      if (scopeCreated) await this.recoverProbeScope(scope);
      if (error instanceof CgroupUnavailableError) throw error;
      if (error instanceof TypeError) throw error;
      unavailable("capability probe");
    }
  }

  prepareAttempt(attemptId: RunAttemptId): ContainmentAttempt {
    // Resolution and preflight establish canonical containment; preparation remains synchronous
    // and non-I/O. Same-user replacement after preflight is outside this backend's threat model.
    assertContained(this.root, this.parentScope, "parent scope");
    const existing = this.attempts.get(attemptId);
    if (existing !== undefined) return existing;
    const primitiveParentScope: string = this.parentScope;
    const scope = absolutePath(join(primitiveParentScope, cgroupScopeName(attemptId)));
    assertContained(this.parentScope, scope, "attempt path");
    const attempt = new CgroupAttempt(this, attemptId, scope);
    this.attempts.set(attemptId, attempt);
    return attempt;
  }

  restoreAttempt(
    attemptId: RunAttemptId,
    descriptor: RestorationContainmentDescriptor,
  ): ContainmentAttempt {
    const primitiveParentScope: string = this.parentScope;
    const expected = absolutePath(join(primitiveParentScope, cgroupScopeName(attemptId)));
    if (descriptor.backend !== "cgroup-v2" || descriptor.scopePath !== expected) {
      unavailable("attempt descriptor");
    }
    const operationScope = directoryExists(this.fs, expected)
      ? canonicalContainedDirectory(this.fs, this.root, expected, "attempt scope")
      : expected;
    if (operationScope !== expected) unavailable("attempt scope");
    const existing = this.attempts.get(attemptId);
    if (existing !== undefined) return existing;
    const attempt = new CgroupAttempt(this, attemptId, absolutePath(operationScope));
    this.attempts.set(attemptId, attempt);
    return attempt;
  }

  async shutdown(): Promise<void> {
    for (const attempt of [...this.attempts.values()]) {
      await attempt.retryCleanup();
    }
    this.removeIntermediate(this.parentScope, "parent scope");
  }

  proveRuntimeDescriptor(
    attempt: CgroupAttempt,
    evidence: RestorationContainmentDescriptor,
  ): ContainmentDescriptor {
    if (evidence.backend !== attempt.candidate.backend ||
        evidence.scopePath !== attempt.candidate.scopePath) {
      unavailable("attempt descriptor");
    }
    const canonicalScope = canonicalContainedDirectory(
      this.fs,
      this.parentScope,
      attempt.operationScope,
      "attempt scope",
    );
    if (canonicalScope !== attempt.operationScope) unavailable("attempt scope");
    return {
      backend: "cgroup-v2",
      scopePath: provenCgroupScopePath(attempt.candidate.scopePath),
    };
  }

  ensureNoProcessScope(scope: string): void {
    if (directoryExists(this.fs, scope)) {
      requireDirectory(this.fs, scope, "attempt scope");
      return;
    }
    filesystemOperation("attempt scope create", () => this.fs.mkdir(scope, 0o700));
  }

  scopeExists(scope: string): boolean {
    return directoryExists(this.fs, scope);
  }

  async terminateScope(scope: string): Promise<void> {
    if (!directoryExists(this.fs, scope)) unavailable("missing attempt scope");
    filesystemOperation("attempt kill", () => this.fs.writeFile(join(scope, "cgroup.kill"), "1\n"));
    await this.waitEmpty(scope);
  }

  async verifyEmpty(scope: string): Promise<void> {
    if (!directoryExists(this.fs, scope)) unavailable("missing attempt scope");
    await this.waitEmpty(scope);
  }

  publishReceipt(attempt: CgroupAttempt, outcome: ContainmentOutcome): VerifiedContainmentReceiptPath {
    const receiptPath = this.options.receiptPathFor(attempt.attemptId);
    const primitiveAttemptId: string = attempt.attemptId;
    const primitiveScopePath: string = attempt.candidate.scopePath;
    publishCommittedSync({
      destination: receiptPath,
      data: JSON.stringify({
        version: 2,
        attemptId: primitiveAttemptId,
        backend: "cgroup-v2",
        scopePath: primitiveScopePath,
        outcome,
        timestamp: new Date((this.options.now ?? Date.now)()).toISOString(),
        populated: false,
      }),
    });
    return verifiedContainmentReceiptPath(receiptPath);
  }

  receiptPathFor(attemptId: RunAttemptId): ContainmentReceiptPath {
    return this.options.receiptPathFor(attemptId);
  }

  proofMatches(attemptId: RunAttemptId, proof: VerifiedContainmentReceiptPath): boolean {
    return proof === this.receiptPathFor(attemptId);
  }

  removeAttempt(attempt: CgroupAttempt, proof?: VerifiedContainmentReceiptPath): void {
    const scope = attempt.operationScope;
    if (!directoryExists(this.fs, scope)) {
      if (proof === undefined || proof !== this.receiptPathFor(attempt.attemptId)) {
        unavailable("missing attempt scope");
      }
      this.attempts.delete(attempt.attemptId);
      return;
    }
    this.removeEmptyDescendants(scope);
    filesystemOperation("attempt remove", () => this.fs.removeDirectory(scope));
    this.attempts.delete(attempt.attemptId);
  }

  private removeEmptyDescendants(scope: string): void {
    const pending: Array<{ path: string; remove: boolean }> = [{ path: scope, remove: false }];
    while (pending.length > 0) {
      const current = pending.pop()!;
      if (current.remove) {
        if (this.readPopulated(current.path) !== 0) unavailable("attempt descendant populated");
        filesystemOperation("attempt descendant remove", () => this.fs.removeDirectory(current.path));
        continue;
      }
      if (current.path !== scope) pending.push({ path: current.path, remove: true });
      const entries = filesystemOperation("attempt list", () => this.fs.list(current.path));
      for (const entry of entries) {
        if (entry.length === 0 || entry === "." || entry === ".." || entry.includes("/") || entry.includes("\0")) {
          unavailable("attempt descendant");
        }
        const candidate = join(current.path, entry);
        const stat = filesystemOperation("attempt descendant", () => this.fs.stat(candidate));
        if (!stat.isDirectory()) continue;
        const child = canonicalContainedDirectory(this.fs, current.path, candidate, "attempt descendant");
        pending.push({ path: child, remove: false });
      }
    }
  }

  recordAttemptCleanupFailure(): void {
    this.options.diagnostic?.(`${UNAVAILABLE_PREFIX}attempt cleanup failed`);
  }

  private readPopulated(scope: string): 0 | 1 {
    return filesystemOperation(
      "cgroup events",
      () => parsePopulated(this.fs.readFile(join(scope, "cgroup.events"))),
    );
  }

  private async waitEmpty(scope: string): Promise<void> {
    const now = this.options.now ?? Date.now;
    const deadline = now() + CONTAINMENT_TIMEOUT_MS;
    while (true) {
      if (this.readPopulated(scope) === 0) return;
      if (now() >= deadline) unavailable("empty timeout");
      await (this.options.pollDelay ?? delay)(milliseconds(20));
    }
  }

  private async recoverProbeScope(scope: string): Promise<void> {
    try {
      this.fs.writeFile(join(scope, "cgroup.kill"), "1\n");
    } catch { /* a failed kill is still followed by the strongest available emptiness check */ }
    try {
      await this.waitEmpty(scope);
    } catch { return; }
    try {
      this.fs.removeDirectory(scope);
    } catch { /* preflight retains the original bounded capability failure */ }
  }

  private removeIntermediate(path: string, label: string): boolean {
    try {
      this.fs.removeDirectory(path);
      return true;
    } catch (error) {
      const code = errorCode(error);
      if (code === "ENOTEMPTY" || code === "ENOENT") {
        this.options.diagnostic?.(`${UNAVAILABLE_PREFIX}${label} cleanup ${code.toLowerCase()}`);
        return code === "ENOENT";
      }
      throw error;
    }
  }
}

class CgroupAttempt implements ContainmentAttempt {
  readonly candidate: ContainmentCandidateDescriptor;
  readonly parentScope: AbsolutePath;
  acceptedReceipt: VerifiedContainmentReceiptPath | undefined;

  constructor(
    private readonly backend: CgroupV2Backend,
    readonly attemptId: RunAttemptId,
    readonly operationScope: AbsolutePath,
  ) {
    this.parentScope = backend.parentScope;
    this.candidate = { backend: "cgroup-v2", scopePath: operationScope };
  }

  proveRuntimeDescriptor(evidence: RestorationContainmentDescriptor): ContainmentDescriptor {
    return this.backend.proveRuntimeDescriptor(this, evidence);
  }

  async terminate(outcome: ContainmentOutcome): Promise<VerifiedContainmentReceiptPath> {
    if (outcome === "no_process") this.backend.ensureNoProcessScope(this.operationScope);
    await this.backend.terminateScope(this.operationScope);
    const proof = this.backend.publishReceipt(this, outcome);
    this.acceptedReceipt = proof;
    try {
      this.backend.removeAttempt(this, proof);
    } catch {
      this.backend.recordAttemptCleanupFailure();
    }
    return proof;
  }

  async verifyEmpty(): Promise<void> {
    await this.backend.verifyEmpty(this.operationScope);
  }

  async cleanup(proof?: VerifiedContainmentReceiptPath): Promise<void> {
    if (proof !== undefined && this.backend.proofMatches(this.attemptId, proof)) {
      this.acceptedReceipt = proof;
    }
    if (!this.backend.scopeExists(this.operationScope)) {
      this.backend.removeAttempt(this, proof);
      return;
    }
    await this.verifyEmpty();
    try {
      this.backend.removeAttempt(this, proof);
    } catch {
      this.backend.recordAttemptCleanupFailure();
    }
  }

  async retryCleanup(): Promise<void> {
    if (!this.backend.scopeExists(this.operationScope)) {
      this.backend.removeAttempt(this, this.acceptedReceipt);
      return;
    }
    await this.verifyEmpty();
    this.backend.removeAttempt(this, this.acceptedReceipt);
  }
}

function resolveDefaultRoot(
  fs: CgroupFileSystem,
  mountReal: string,
  selfCgroupText: string,
): string {
  const unified = parseUnifiedPath(selfCgroupText);
  const current = resolve(mountReal, `.${unified}`);
  assertContained(mountReal, current, "parent cgroup");
  const currentReal = canonicalContainedDirectory(fs, mountReal, current, "parent cgroup");
  const rootCandidate = join(currentReal, "pi-subagents");

  const existing = probeDirectoryStrict(fs, rootCandidate, "root");
  if (existing === undefined) {
    try {
      fs.mkdir(rootCandidate, 0o700);
    } catch (error) {
      if (error instanceof TypeError) throw error;
      if (errorCode(error) !== "EEXIST") unavailable("root");
    }
  }

  const resolved = probeDirectoryStrict(fs, rootCandidate, "root");
  if (resolved === undefined) unavailable("root");
  requirePrivateDirectory(resolved, "root");
  return canonicalContainedDirectory(fs, mountReal, rootCandidate, "root");
}

function parseUnifiedPath(text: string): string {
  const lines = text.split("\n").filter((line) => line.length > 0);
  if (lines.length !== 1 || !/^0::\/(?:[^/\n]+(?:\/[^/\n]+)*)?$/.test(lines[0]!)) {
    unavailable("unified cgroup");
  }
  const path = lines[0]!.slice(3);
  if (path.split("/").includes("..")) unavailable("unified cgroup");
  return path;
}

function parsePopulated(text: string): 0 | 1 {
  const lines = text.split("\n").filter((line) => line.length > 0);
  const records = lines.map((line) => /^([^\s]+) ([0-9]+)$/.exec(line));
  if (records.some((record) => record === null)) unavailable("cgroup events");
  const populated = records.filter((record) => record![1] === "populated");
  if (populated.length !== 1 || (populated[0]![2] !== "0" && populated[0]![2] !== "1")) {
    unavailable("cgroup events");
  }
  return populated[0]![2] === "0" ? 0 : 1;
}

function parsePids(text: string): ProcessId[] {
  const lines = text.split("\n").filter((line) => line.length > 0);
  if (lines.some((line) => !/^[1-9]\d*$/.test(line))) unavailable("cgroup membership");
  const primitivePids = lines.map(Number);
  if (primitivePids.some((pid) => !Number.isSafeInteger(pid))) unavailable("cgroup membership");
  return primitivePids.map(processId);
}

function canonicalDirectory(fs: CgroupFileSystem, path: string, label: string): string {
  requireDirectory(fs, path, label);
  return filesystemOperation(label, () => fs.realpath(path));
}

function canonicalContainedDirectory(
  fs: CgroupFileSystem,
  parent: string,
  path: string,
  label: string,
): string {
  const real = canonicalDirectory(fs, path, label);
  assertContained(parent, real, label);
  return real;
}

function requireDirectory(fs: CgroupFileSystem, path: string, label: string): void {
  const stat = filesystemOperation(label, () => fs.stat(path));
  if (!stat.isDirectory()) unavailable(label);
}

function probeDirectoryStrict(
  fs: CgroupFileSystem,
  path: string,
  label: string,
): CgroupStat | undefined {
  try {
    return fs.stat(path);
  } catch (error) {
    if (error instanceof TypeError) throw error;
    if (errorCode(error) === "ENOENT") return undefined;
    unavailable(label);
  }
}

function requirePrivateDirectory(stat: CgroupStat, label: string): void {
  if (!stat.isDirectory() || (stat.mode & 0o777) !== 0o700) unavailable(label);
}

function directoryExists(fs: CgroupFileSystem, path: string): boolean {
  try {
    fs.stat(path);
    return true;
  } catch (error) {
    if (error instanceof TypeError) throw error;
    return false;
  }
}

function assertContained(parent: string, child: string, label: string): void {
  if (!isContainedPath(parent, child)) unavailable(label);
}

/**
 * Promotes an absolute path only after this module has proved the exact attempt identity and
 * containment beneath the backend's canonical parent scope.
 */
function provenCgroupScopePath(path: AbsolutePath): CgroupScopePath {
  return path as CgroupScopePath;
}

function filesystemOperation<T>(category: string, operation: () => T): T {
  try {
    return operation();
  } catch (error) {
    if (error instanceof CgroupUnavailableError) throw error;
    if (error instanceof TypeError) throw error;
    unavailable(category);
  }
}

async function filesystemPromise<T>(category: string, promise: Promise<T>): Promise<T> {
  try {
    return await promise;
  } catch (error) {
    if (error instanceof CgroupUnavailableError) throw error;
    if (error instanceof TypeError) throw error;
    unavailable(category);
  }
}

function unavailable(category: string): never {
  throw new CgroupUnavailableError(category);
}

class CgroupUnavailableError extends Error {
  constructor(category: string) {
    super(`${UNAVAILABLE_PREFIX}${category}`);
  }
}

function errorCode(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null || !("code" in error)) return undefined;
  const code = Reflect.get(error, "code");
  return typeof code === "string" ? code : undefined;
}

function bestEffort(operation: () => void): void {
  try { operation(); } catch { /* retain the primary capability failure */ }
}

function delay(milliseconds: Milliseconds): Promise<void> {
  const primitiveMilliseconds: number = milliseconds;
  return new Promise((done) => setTimeout(done, primitiveMilliseconds));
}

function defaultProbe(): ProbeProcess {
  const child = spawn(process.execPath, ["-e", "process.stdin.resume()"], {
    stdio: ["pipe", "ignore", "ignore"],
    shell: false,
    detached: false,
  });
  if (child.pid === undefined) throw new Error("probe pid unavailable");
  return {
    pid: processId(child.pid),
    release: () => child.stdin.end(),
    exited: new Promise((done, reject) => {
      child.once("exit", () => done());
      child.once("error", reject);
    }),
    kill: () => { child.kill(); },
  };
}

export const nodeCgroupFileSystem: CgroupFileSystem = {
  readFile: (path) => readFileSync(path, "utf8"),
  writeFile: (path, value) => writeFileSync(path, value),
  mkdir: (path, mode) => mkdirSync(path, { mode }),
  realpath: realpathSync,
  stat: statSync,
  removeDirectory: rmdirSync,
  list: readdirSync,
};
