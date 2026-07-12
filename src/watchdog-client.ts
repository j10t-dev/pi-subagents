import { spawn, type ChildProcess } from "node:child_process";
import { readFileSync, realpathSync, readdirSync, rmSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { StringDecoder } from "node:string_decoder";
import type { Writable, Readable } from "node:stream";

import type { ContainmentAttempt, ContainmentDescriptor, ContainmentOutcome } from "./containment.ts";
import { retainUtf8Tail, verifiedContainmentReceiptPath } from "./domain.ts";
import type { AbsolutePath, ContainmentReceiptPath, RunAttemptId, VerifiedContainmentReceiptPath } from "./domain.ts";
import type { RpcLaunchSpec } from "./pi-launcher.ts";
import type { RpcLaunchTransport } from "./rpc-client.ts";

export interface WatchdogClientOptions {
  attemptId: RunAttemptId;
  receiptPath: ContainmentReceiptPath;
  attempt: ContainmentAttempt;
  watchdogPath?: AbsolutePath;
  launcherPath?: AbsolutePath;
  timeoutMs?: number;
  maxControlLineBytes?: number;
}
export interface WatchdogLaunch {
  stdin: Writable;
  stdout: Readable;
  stderr: Readable;
  exited: Promise<{ code: number | null; signal: NodeJS.Signals | null }>;
}
type WatchdogProcess = ChildProcess & { stdin: Writable; stdout: Readable; stderr: Readable };
type ControlMessage =
  | { type: "ready"; descriptor: ContainmentDescriptor }
  | { type: "authorised" }
  | { type: "launched"; pid: number }
  | { type: "exit"; code: number | null; signal: NodeJS.Signals | null };
export type WatchdogLaunchPhase = "attempt_prepared" | "launcher_authorised" | "pi_spawned";

export class WatchdogContainmentUnresolvedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WatchdogContainmentUnresolvedError";
  }
}

export class WatchdogClient {
  private child: WatchdogProcess | undefined;
  private readonly childClosed: Promise<void>;
  private rpcStreams: readonly [Writable, Readable, Readable] | undefined;
  private readonly messages: ControlMessage[] = [];
  private readonly waiters: Array<{ resolve: (message: ControlMessage) => void; reject: (error: Error) => void }> = [];
  private controlBuffer: Buffer<ArrayBufferLike> = Buffer.alloc(0);
  private diagnostics = "";
  private readonly diagnosticsDecoder = new StringDecoder("utf8");
  private protocolError: Error | undefined;
  private containment: Promise<VerifiedContainmentReceiptPath> | undefined;
  private readonly attemptEpoch = Date.now();
  private controlState: ControlMessage["type"] | "done" = "ready";
  private receiptCleanup: Promise<void> | undefined;
  launchPhase: WatchdogLaunchPhase = "attempt_prepared";

  constructor(private readonly options: WatchdogClientOptions) {
    if (options.attempt.attemptId !== options.attemptId) throw new Error("watchdog attempt mismatch");
    const script = options.watchdogPath ?? join(dirname(fileURLToPath(import.meta.url)), "../watchdog.mjs") as AbsolutePath;
    const launcher = options.launcherPath ?? join(dirname(fileURLToPath(import.meta.url)), "../launcher.mjs") as AbsolutePath;
    rmSync(options.receiptPath as string, { force: true });
    const child = spawn(process.execPath, [script, options.attemptId, options.receiptPath, options.attempt.descriptor.scopePath, options.attempt.parentScope, launcher], {
      detached: true,
      shell: false,
      env: sanitiseWatchdogEnvironment(process.env),
      stdio: ["pipe", "pipe", "pipe", "pipe", "pipe", "pipe"],
    });
    this.child = child;
    this.childClosed = new Promise<void>((resolve, reject) => {
      child.once("exit", () => resolve());
      child.once("error", reject);
    });
    void this.childClosed.catch(() => undefined);
    const rpcStdin = child.stdio.at(3);
    const rpcStdout = child.stdio.at(4);
    const rpcStderr = child.stdio.at(5);
    if (!isWritable(rpcStdin) || !isReadable(rpcStdout) || !isReadable(rpcStderr)) throw new Error("watchdog RPC streams unavailable");
    const rpcStreams = [rpcStdin, rpcStdout, rpcStderr] as const;
    this.rpcStreams = rpcStreams;
    child.stdout.on("data", (chunk: Buffer) => this.consumeControl(chunk));
    child.stdout.once("end", () => {
      if (this.controlState !== "done" && this.protocolError === undefined && this.containment === undefined) this.failProtocol("watchdog control EOF");
    });
    child.stderr.on("data", (chunk: Buffer) => {
      this.diagnostics = retainUtf8Tail(this.diagnostics + this.diagnosticsDecoder.write(chunk), 50_000);
    });
    child.stderr.once("end", () => {
      this.diagnostics = retainUtf8Tail(this.diagnostics + this.diagnosticsDecoder.end(), 50_000);
    });
    const fail = (label: string) => (error: Error) => this.failProtocol(`${label}: ${errorText(error)}`);
    child.once("error", fail("watchdog process error"));
    child.stdin.on("error", fail("watchdog control stdin error"));
    child.stdout.on("error", fail("watchdog control stdout error"));
    child.stderr.on("error", fail("watchdog control stderr error"));
    rpcStreams[0].on("error", fail("watchdog rpc stream 3 error"));
    rpcStreams[1].on("error", fail("watchdog rpc stream 4 error"));
    rpcStreams[2].on("error", fail("watchdog rpc stream 5 error"));
  }

  async ready(): Promise<ContainmentDescriptor> {
    try {
      const message = await this.next("ready");
      if (message.type !== "ready") throw new Error("protocol_error: expected ready");
      if (!sameDescriptor(message.descriptor, this.options.attempt.descriptor)) throw new Error("protocol_error: descriptor mismatch");
      return message.descriptor;
    } catch (error) { throw await this.containAndDescribe("readiness", error); }
  }

  async launch(spec: RpcLaunchSpec): Promise<WatchdogLaunch> {
    try {
      const child = this.requireChild();
      await writeControl(child.stdin, `${JSON.stringify(spec)}\n`, this.timeout, "watchdog launch write timeout");
      const authorised = await this.next("authorised");
      if (authorised.type !== "authorised") throw new Error("protocol_error: expected authorised");
      this.launchPhase = "launcher_authorised";
      const message = await this.next("launched");
      if (message.type !== "launched") throw new Error("protocol_error: expected launched");
      this.launchPhase = "pi_spawned";
      const exited = this.next("exit", false).then(async (value) => {
        if (value.type !== "exit") throw new Error("protocol_error: expected exit");
        await this.waitForReceipt();
        return { code: value.code, signal: value.signal };
      }).catch(async (error) => { throw await this.containAndDescribe("exit", error); });
      void exited.catch(() => undefined);
      const rpcStreams = this.requireRpcStreams();
      return { stdin: rpcStreams[0], stdout: rpcStreams[1], stderr: rpcStreams[2], exited };
    } catch (error) { throw await this.containAndDescribe("launch", error); }
  }

  async waitForReceipt(): Promise<VerifiedContainmentReceiptPath> {
    const end = Date.now() + this.timeout;
    let error: unknown;
    while (Date.now() < end) {
      try {
        const receipt = verifyContainmentReceipt(
          this.options.receiptPath,
          this.options.attemptId,
          this.attemptEpoch,
          this.options.attempt.descriptor,
        );
        if (receipt.version !== 2) throw new Error("invalid live containment receipt version");
        this.receiptCleanup ??= this.options.attempt.cleanup(receipt.path);
        await this.receiptCleanup;
        return receipt.path;
      } catch (caught) {
        error = caught;
        await delay(20);
      }
    }
    throw error instanceof Error ? error : new Error("containment receipt timeout");
  }

  escalate(): void { void this.beginContainment().catch(() => undefined); }
  async close(): Promise<void> { await this.beginContainment(); }
  getDiagnostics(): string { return this.diagnostics; }

  private get timeout(): number { return Math.min(this.options.timeoutMs ?? 5_000, 20_000); }

  private beginContainment(): Promise<VerifiedContainmentReceiptPath> {
    if (this.containment !== undefined) return this.containment;
    this.containment = (async () => {
      const child = this.requireChild();
      if (!child.stdin.destroyed) child.stdin.end();
      try {
        await this.stopWatchdog(child);
        await this.closePipes(child);
      } catch (error) {
        throw new WatchdogContainmentUnresolvedError(errorText(error));
      }
      this.releaseProcessReferences(child);
      try { return await this.waitForReceipt(); }
      catch {
        return await this.options.attempt.terminate(this.fallbackOutcome());
      }
    })();
    return this.containment;
  }

  private fallbackOutcome(): ContainmentOutcome {
    return this.launchPhase === "pi_spawned" ? "terminated"
      : this.launchPhase === "launcher_authorised" ? "spawn_failed"
      : "no_process";
  }

  private async stopWatchdog(child: WatchdogProcess): Promise<void> {
    if (await settlesWithin(this.childClosed, 1_000)) return;
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
    if (await settlesWithin(this.childClosed, 1_000)) return;
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    await withTimeout(this.childClosed, this.timeout, `watchdog forced exit timeout; stderr=${this.getDiagnostics()}`);
  }

  private async closePipes(child: WatchdogProcess): Promise<void> {
    for (const endpoint of child.stdio) {
      if (endpoint !== null && endpoint !== undefined && !endpoint.destroyed) endpoint.destroy();
    }
    try {
      await withTimeout(Promise.all([this.childClosed, waitForPipeClosure(child.stdio)]), this.timeout, `watchdog pipe close timeout; stderr=${this.getDiagnostics()}`);
    } catch (error) {
      const states = child.stdio.map((endpoint, index) => `${index}:${endpoint === null || endpoint === undefined ? "absent" : endpoint.closed ? "closed" : endpoint.destroyed ? "destroyed" : "open"}`).join(",");
      throw new Error(`${errorText(error)}; pipes=${states}`);
    }
  }

  private releaseProcessReferences(child: WatchdogProcess): void {
    child.removeAllListeners();
    for (const endpoint of child.stdio) endpoint?.removeAllListeners();
    this.rpcStreams = undefined;
    this.child = undefined;
  }

  private requireChild(): WatchdogProcess {
    if (this.child === undefined) throw new Error("invalid_state: watchdog process has been released");
    return this.child;
  }

  private requireRpcStreams(): readonly [Writable, Readable, Readable] {
    if (this.rpcStreams === undefined) throw new Error("invalid_state: watchdog RPC streams have been released");
    return this.rpcStreams;
  }

  private async containAndDescribe(stage: string, error: unknown): Promise<Error> {
    let containmentError: unknown;
    try { await this.beginContainment(); } catch (caught) { containmentError = caught; }
    return new Error(`watchdog ${stage} failed: ${errorText(error)}; stderr=${this.getDiagnostics()}${containmentError === undefined ? "" : `; ${errorText(containmentError)}`}`);
  }

  private next(type: ControlMessage["type"], bounded = true): Promise<ControlMessage> {
    if (this.protocolError !== undefined) return Promise.reject(this.protocolError);
    const found = this.messages.shift();
    if (found !== undefined) return found.type === type ? Promise.resolve(found) : Promise.reject(new Error(`protocol_error: expected ${type}, received ${found.type}`));
    const pending = new Promise<ControlMessage>((resolve, reject) => {
      this.waiters.push({ resolve, reject });
      if (this.protocolError !== undefined) reject(this.protocolError);
    });
    return bounded ? withTimeout(pending, this.timeout, `watchdog ${type} timeout; stderr=${this.getDiagnostics()}`) : pending;
  }

  private deliver(value: unknown): void {
    const message = decodeControlMessage(value);
    if (message.type !== this.controlState) throw new Error(`protocol_error: expected ${this.controlState}, received ${message.type}`);
    this.controlState = message.type === "ready" ? "authorised"
      : message.type === "authorised" ? "launched"
      : message.type === "launched" ? "exit"
      : "done";
    const waiter = this.waiters.shift();
    if (waiter === undefined) this.messages.push(message); else waiter.resolve(message);
  }

  private failProtocol(reason: string): void {
    if (this.protocolError !== undefined) return;
    this.protocolError = new Error(`protocol_error: ${reason}; stderr=${this.getDiagnostics()}`);
    for (const waiter of this.waiters) waiter.reject(this.protocolError);
    this.waiters.length = 0;
    void this.beginContainment().catch(() => undefined);
  }

  private consumeControl(chunk: Buffer): void {
    if (this.protocolError !== undefined) return;
    this.controlBuffer = Buffer.concat([this.controlBuffer, chunk]);
    const maximum = this.options.maxControlLineBytes ?? 64 * 1024;
    if (this.controlBuffer.length > maximum && !this.controlBuffer.includes(0x0a)) { this.failProtocol("oversized control record"); return; }
    for (;;) {
      const newline = this.controlBuffer.indexOf(0x0a);
      if (newline < 0) return;
      const line = this.controlBuffer.subarray(0, newline);
      this.controlBuffer = this.controlBuffer.subarray(newline + 1);
      if (line.length > maximum) { this.failProtocol("oversized control record"); return; }
      try { this.deliver(JSON.parse(line.toString("utf8"))); }
      catch (error) { this.failProtocol(errorText(error)); return; }
    }
  }
}

export async function launchWatchdogRpcTransport(client: WatchdogClient, spec: RpcLaunchSpec): Promise<RpcLaunchTransport> {
  await client.ready();
  const launch = await client.launch(spec);
  return { stdin: launch.stdin, stdout: launch.stdout, stderr: launch.stderr, exited: launch.exited, terminate: () => client.close() };
}

export type VerifiedContainmentReceipt =
  | { version: 1; path: VerifiedContainmentReceiptPath; pgid: number | null }
  | { version: 2; path: VerifiedContainmentReceiptPath; descriptor: ContainmentDescriptor; populated: false };

export function verifyContainmentReceipt(
  path: ContainmentReceiptPath,
  attemptId: RunAttemptId,
  attemptEpoch?: number,
  expectedDescriptor?: ContainmentDescriptor,
): VerifiedContainmentReceipt {
  const receiptPath: string = path;
  let value: unknown;
  try { value = JSON.parse(readFileSync(receiptPath, "utf8")); }
  catch { throw new Error("invalid containment receipt"); }
  if (!isRecord(value)) throw new Error("invalid containment receipt schema");
  const timestamp = typeof value.timestamp === "string" ? Date.parse(value.timestamp) : Number.NaN;
  if (value.attemptId !== attemptId) throw new Error("containment receipt attempt mismatch");
  if (Number.isNaN(timestamp) || (attemptEpoch !== undefined && timestamp < attemptEpoch) || timestamp > Date.now() + 60_000) throw new Error("stale containment receipt");
  if (realpathSync(receiptPath) !== join(realpathSync(dirname(receiptPath)), basename(receiptPath))) throw new Error("invalid containment receipt location");
  const pathProof = verifiedContainmentReceiptPath(path);
  if (value.version === 1) {
    if (!hasExactKeys(value, ["attemptId", "outcome", "pgid", "timestamp", "version"])) throw new Error("invalid containment receipt schema");
    const coherent = value.outcome === "terminated" ? Number.isInteger(value.pgid) && Number(value.pgid) > 0 : value.pgid === null;
    if (!coherent || !OUTCOMES.has(String(value.outcome))) throw new Error("invalid containment receipt schema");
    const pgid = value.pgid === null ? null : Number(value.pgid);
    if (pgid !== null && groupHasLiveMembers(pgid)) throw new Error("containment process group remains alive");
    return { version: 1, path: pathProof, pgid };
  }
  if (value.version === 2) {
    if (!hasExactKeys(value, ["attemptId", "backend", "outcome", "populated", "scopePath", "timestamp", "version"]) ||
        value.backend !== "cgroup-v2" || typeof value.scopePath !== "string" || !value.scopePath.startsWith("/") || value.scopePath.includes("\0") ||
        value.populated !== false || !OUTCOMES.has(String(value.outcome))) throw new Error("invalid containment receipt schema");
    const descriptor: ContainmentDescriptor = { backend: "cgroup-v2", scopePath: value.scopePath as AbsolutePath };
    if (expectedDescriptor !== undefined && !sameDescriptor(descriptor, expectedDescriptor)) throw new Error("containment receipt descriptor mismatch");
    return { version: 2, path: pathProof, descriptor, populated: false };
  }
  throw new Error("invalid containment receipt schema");
}

const OUTCOMES = new Set(["no_process", "terminated", "spawn_failed", "invalid_launch"]);
function decodeControlMessage(value: unknown): ControlMessage {
  if (!isRecord(value) || typeof value.type !== "string") throw new Error("protocol_error: malformed control message");
  if (value.type === "ready" && hasExactKeys(value, ["descriptor", "type"]) && isDescriptor(value.descriptor)) return { type: "ready", descriptor: value.descriptor };
  if (value.type === "authorised" && hasExactKeys(value, ["type"])) return { type: "authorised" };
  if (value.type === "launched" && hasExactKeys(value, ["pid", "type"]) && Number.isInteger(value.pid) && Number(value.pid) > 0) return { type: "launched", pid: Number(value.pid) };
  if (value.type === "exit" && hasExactKeys(value, ["code", "signal", "type"]) && (value.code === null || Number.isInteger(value.code) && Number(value.code) >= 0 && Number(value.code) <= 255) && (value.signal === null || isSignal(value.signal))) return { type: "exit", code: value.code as number | null, signal: value.signal as NodeJS.Signals | null };
  throw new Error(`protocol_error: malformed ${value.type} control message`);
}
function isDescriptor(value: unknown): value is ContainmentDescriptor { return isRecord(value) && hasExactKeys(value, ["backend", "scopePath"]) && value.backend === "cgroup-v2" && typeof value.scopePath === "string" && value.scopePath.startsWith("/") && !value.scopePath.includes("\0"); }
function sameDescriptor(left: ContainmentDescriptor, right: ContainmentDescriptor): boolean { return left.backend === right.backend && left.scopePath === right.scopePath; }
function isSignal(value: unknown): value is NodeJS.Signals { return typeof value === "string" && SIGNALS.has(value as NodeJS.Signals); }
const SIGNALS = new Set<NodeJS.Signals>(["SIGABRT","SIGALRM","SIGBUS","SIGCHLD","SIGCONT","SIGFPE","SIGHUP","SIGILL","SIGINT","SIGIO","SIGIOT","SIGKILL","SIGPIPE","SIGPOLL","SIGPROF","SIGPWR","SIGQUIT","SIGSEGV","SIGSTKFLT","SIGSTOP","SIGSYS","SIGTERM","SIGTRAP","SIGTSTP","SIGTTIN","SIGTTOU","SIGURG","SIGUSR1","SIGUSR2","SIGVTALRM","SIGWINCH","SIGXCPU","SIGXFSZ"]);
function isRecord(value: unknown): value is Record<string, unknown> { return typeof value === "object" && value !== null && !Array.isArray(value); }
function isWritable(value: Writable | Readable | null | undefined): value is Writable { return value !== null && value !== undefined && typeof (value as Writable).write === "function"; }
function isReadable(value: Writable | Readable | null | undefined): value is Readable { return value !== null && value !== undefined && typeof (value as Readable).read === "function"; }
function hasExactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean { const keys = Object.keys(value).sort(); return keys.length === expected.length && keys.every((key, index) => key === expected[index]); }
function errorText(error: unknown): string { return error instanceof Error ? error.message : String(error); }
function sanitiseWatchdogEnvironment(environment: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return Object.fromEntries(Object.entries(environment).filter(([key]) => !key.startsWith("PI_WATCHDOG_FAKE_")));
}
function delay(ms: number): Promise<void> { return new Promise((resolve) => setTimeout(resolve, ms)); }
function writeControl(stream: Writable, value: string, ms: number, message: string): Promise<void> { return withTimeout(new Promise((resolve, reject) => stream.write(value, (error) => error ? reject(error) : resolve())), ms, message); }
function groupHasLiveMembers(pgid: number): boolean {
  try { for (const name of readdirSync("/proc")) { if (!/^\d+$/.test(name)) continue; try { const fields = procStatFields(readFileSync(`/proc/${name}/stat`, "utf8")); if (Number(fields[2]) === pgid && fields[0] !== "Z") return true; } catch {} } return false; }
  catch { try { process.kill(-pgid, 0); return true; } catch (error) { return errorCode(error) !== "ESRCH"; } }
}
function errorCode(error: unknown): string | undefined { if (typeof error !== "object" || error === null || !("code" in error)) return undefined; const value = Reflect.get(error, "code"); return typeof value === "string" ? value : undefined; }
function procStatFields(stat: string): string[] { const end = stat.lastIndexOf(")"); if (end < 0) throw new Error("malformed proc stat"); return stat.slice(end + 2).split(" "); }
function withTimeout<T>(promise: Promise<T>, ms: number, message: string): Promise<T> { return new Promise((resolve, reject) => { const timer = setTimeout(() => reject(new Error(message)), ms); promise.then((value) => { clearTimeout(timer); resolve(value); }, (error) => { clearTimeout(timer); reject(error); }); }); }
async function settlesWithin(promise: Promise<void>, ms: number): Promise<boolean> { try { await withTimeout(promise, ms, "timeout"); return true; } catch (error) { if (error instanceof Error && error.message === "timeout") return false; throw error; } }
async function waitForPipeClosure(endpoints: ChildProcess["stdio"]): Promise<void> {
  while (!endpoints.every((endpoint) => endpoint === null || endpoint === undefined || endpoint.closed)) await delay(10);
}
