import { EventEmitter } from "node:events";
import { closeSync, existsSync, openSync, readFileSync, statSync, writeSync } from "node:fs";
import { mkdir, mkdtemp, open, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { PassThrough, Writable } from "node:stream";
import { pipeline as streamPipeline } from "node:stream/promises";
import type { SpawnOptions } from "node:child_process";

import { describe, expect, test } from "bun:test";

import {
  TEST_GROUP_NAMES,
  TEST_GROUP_RULES,
  discoverTestFiles,
  groupTestFiles,
  parseRequestedGroups,
  selectTestGroups,
  resolveTestGroupOwner,
  type TestGroup,
} from "../scripts/test-groups.ts";
import {
  integrationConcurrency,
  runSelectedTestGroups,
  testCommandArguments,
  type RunnerDependencies,
  type RunnerFileSystem,
  type TestGroupProcess,
} from "../scripts/run-tests.ts";
const REPOSITORY_ROOT = join(import.meta.dir, "..");

class FakeTestGroupProcess extends EventEmitter implements TestGroupProcess {
  private descriptor: number | undefined;
  ownDescriptor(descriptor: number): void { this.descriptor = descriptor; }
  spawned(): void { this.emit("spawn"); }
  exit(code: number | null, signal: NodeJS.Signals | null = null): void {
    this.emit("exit", code, signal);
    this.closeDescriptor();
  }
  spawnError(error: Error): void {
    this.emit("error", error);
    this.closeDescriptor();
  }
  private closeDescriptor(): void {
    if (this.descriptor !== undefined) {
      closeSync(this.descriptor);
      this.descriptor = undefined;
    }
  }
}

interface SpawnRecord {
  readonly command: string;
  readonly args: readonly string[];
  readonly options: SpawnOptions;
  readonly child: FakeTestGroupProcess;
  readonly childDescriptor?: number;
}

function parentTranscriptDescriptor(options: SpawnOptions): number {
  const stdio = options.stdio;
  if (!Array.isArray(stdio) || typeof stdio[1] !== "number" || stdio[1] !== stdio[2]) {
    throw new Error("expected one shared transcript descriptor");
  }
  return stdio[1];
}

async function launched(records: readonly SpawnRecord[], count: number): Promise<void> {
  for (let turn = 0; turn < 100 && records.length < count; turn += 1) await Bun.sleep(1);
  if (records.length !== count) throw new Error(`expected ${count} launched children, got ${records.length}`);
}

function writeChildOutput(record: SpawnRecord, text: string): void {
  if (record.childDescriptor === undefined) throw new Error("missing child descriptor");
  writeSync(record.childDescriptor, text);
}

function runnerHarness(children: readonly FakeTestGroupProcess[], parallelism = 6, isTTY?: boolean): {
  readonly dependencies: RunnerDependencies;
  readonly records: SpawnRecord[];
  readonly fileSystem: RunnerFileSystem;
  readonly transcriptPaths: () => string[];
  readonly stdoutText: () => string;
  readonly stderrText: () => string;
  readonly parentCloseCalls: () => number;
  readonly temporaryDirectory: () => string | undefined;
} {
  const records: SpawnRecord[] = [];
  const transcriptPathByParentDescriptor = new Map<number, string>();
  const paths: string[] = [];
  let directory: string | undefined;
  let closeCalls = 0;
  let nextChild = 0;
  let output = "";
  let diagnostics = "";
  const stdout = new PassThrough();
  stdout.on("data", (chunk: Buffer) => { output += chunk.toString("utf8"); });
  if (isTTY !== undefined) Object.defineProperty(stdout, "isTTY", { value: isTTY });
  const fileSystem: RunnerFileSystem = {
    async mkdtemp(prefix) { directory = await mkdtemp(prefix); return directory; },
    async open(path, flags, mode) {
      const handle = await open(path, flags, mode);
      const isTranscript = flags === "wx";
      if (isTranscript) {
        paths.push(path);
        transcriptPathByParentDescriptor.set(handle.fd, path);
      }
      const close = handle.close.bind(handle);
      handle.close = async () => { if (isTranscript) closeCalls += 1; await close(); };
      return handle;
    },
    createReadStream(path) {
      const stream = new PassThrough();
      stream.end(readFileSync(path));
      return stream;
    },
    async stat(handle) { return handle.stat(); },
    async readLastByte(handle, position) {
      const buffer = Buffer.alloc(1);
      await handle.read(buffer, 0, 1, position);
      return buffer[0] ?? -1;
    },
    rm: async (path) => { await rm(path, { recursive: true, force: true }); },
  };
  return {
    records, fileSystem,
    transcriptPaths: () => [...paths],
    stdoutText: () => output,
    stderrText: () => diagnostics,
    parentCloseCalls: () => closeCalls,
    temporaryDirectory: () => directory,
    dependencies: {
      parallelism,
      stdout,
      stderr: { write(chunk) { diagnostics += Buffer.from(chunk).toString("utf8"); return true; } },
      fileSystem,
      spawn(command, args, options) {
        const child = children[nextChild++];
        if (child === undefined) throw new Error("missing fake child");
        if (options.stdio === "inherit") {
          records.push({ command, args, options, child });
          return child;
        }
        const parentDescriptor = parentTranscriptDescriptor(options);
        const path = transcriptPathByParentDescriptor.get(parentDescriptor);
        if (path === undefined) throw new Error("unknown transcript descriptor");
        const childDescriptor = openSync(path, "a", 0o600);
        child.ownDescriptor(childDescriptor);
        records.push({ command, args, options, child, childDescriptor });
        return child;
      },
    },
  };
}

const unit: TestGroup = { name: "unit", files: ["test/domain.test.ts"] };
const transport: TestGroup = { name: "transport", files: ["test/rpc-client.test.ts"] };
const processGroup: TestGroup = { name: "process", files: ["test/watchdog.test.ts"] };

// TDD contract for private allocation, descriptor replay, and canonical outcomes.
describe("runSelectedTestGroups", () => {
  test("an empty runnable selection does no work", async () => {
    const harness = runnerHarness([]);
    let temporaryDirectoryCalls = 0;
    let spawnCalls = 0;
    const dependencies: RunnerDependencies = {
      ...harness.dependencies,
      get parallelism(): number { throw new Error("capacity must not be evaluated"); },
      spawn() { spawnCalls += 1; throw new Error("must not spawn"); },
      fileSystem: { ...harness.fileSystem, async mkdtemp(prefix) { temporaryDirectoryCalls += 1; return harness.fileSystem.mkdtemp(prefix); } },
    };
    expect(await runSelectedTestGroups(REPOSITORY_ROOT, [{ name: "unit", files: [] }], dependencies)).toBe(0);
    expect(spawnCalls).toBe(0); expect(temporaryDirectoryCalls).toBe(0); expect(harness.stdoutText()).toBe("");
  });

  test.each([[0, null, 0], [7, null, 7], [null, "SIGKILL", 1], [null, null, 1]] as const)(
    "single inherited exit %p/%p maps to %d", async (code, signal, expected) => {
      const child = new FakeTestGroupProcess(); const harness = runnerHarness([child]);
      const running = runSelectedTestGroups(REPOSITORY_ROOT, [unit], harness.dependencies);
      await launched(harness.records, 1);
      expect(harness.records[0]?.options).toEqual({ cwd: REPOSITORY_ROOT, stdio: "inherit", env: process.env });
      expect(harness.stdoutText()).toBe(""); child.exit(code, signal); expect(await running).toBe(expected);
    },
  );

  test("allocates private canonical transcripts, closes parents, then replays raw output canonically", async () => {
    const first = new FakeTestGroupProcess(); const second = new FakeTestGroupProcess();
    const harness = runnerHarness([first, second]);
    const running = runSelectedTestGroups(REPOSITORY_ROOT, [unit, transport], harness.dependencies);
    await launched(harness.records, 2);
    expect(harness.records).toHaveLength(2);
    const directory = harness.temporaryDirectory(); expect(directory).toBeDefined();
    expect(basename(directory!)).toStartWith("pi-subagents-tests-");
    expect(statSync(directory!).mode & 0o777).toBe(0o700);
    expect(harness.transcriptPaths().map((path) => basename(path))).toEqual(["unit.log", "transport.log"]);
    for (const path of harness.transcriptPaths()) expect(statSync(path).mode & 0o777).toBe(0o600);
    for (const record of harness.records) {
      expect(record.options.stdio).toEqual(["inherit", expect.any(Number), expect.any(Number)]);
      expect(parentTranscriptDescriptor(record.options)).toBe((record.options.stdio as [unknown, unknown, number])[2]);
    }
    expect(harness.parentCloseCalls()).toBe(2);
    writeChildOutput(harness.records[1]!, "transport-out\ntransport-err");
    writeChildOutput(harness.records[0]!, "unit-out");
    second.exit(0); first.exit(0);
    expect(await running).toBe(0);
    expect(harness.stdoutText()).toBe("===== unit =====\nunit-out\n===== transport =====\ntransport-out\ntransport-err\n");
    expect(existsSync(directory!)).toBeFalse();
  });

  test("replays empty, newline-terminated, and alternating shared-descriptor transcripts exactly", async () => {
    const a = new FakeTestGroupProcess(); const b = new FakeTestGroupProcess(); const h = runnerHarness([a, b]);
    const running = runSelectedTestGroups(REPOSITORY_ROOT, [unit, transport], h.dependencies);
    await launched(h.records, 2);
    writeChildOutput(h.records[0]!, "one"); writeChildOutput(h.records[0]!, "-two\n");
    b.exit(0); a.exit(0); expect(await running).toBe(0);
    expect(h.stdoutText()).toBe("===== unit =====\none-two\n===== transport =====\n");
  });

  test("inspects transcript metadata and final byte through one FileHandle", async () => {
    const a = new FakeTestGroupProcess(); const b = new FakeTestGroupProcess(); const h = runnerHarness([a, b]);
    const statArguments: unknown[] = []; const readArguments: unknown[] = [];
    const running = runSelectedTestGroups(REPOSITORY_ROOT, [unit, transport], {
      ...h.dependencies,
      fileSystem: {
        ...h.fileSystem,
        async stat(argument) { statArguments.push(argument); return argument.stat(); },
        async readLastByte(argument, position) {
          readArguments.push(argument);
          const buffer = Buffer.alloc(1);
          await argument.read(buffer, 0, 1, position);
          return buffer[0] ?? -1;
        },
      },
    });
    await launched(h.records, 2);
    writeChildOutput(h.records[0]!, "no final newline");
    a.exit(0); b.exit(0);
    expect(await running).toBe(0);
    expect(statArguments).toHaveLength(2);
    expect(readArguments).toHaveLength(1);
    expect(readArguments[0]).toBe(statArguments[0]);
    expect(statArguments[0]).toHaveProperty("fd");
  });

  test.each([[true, "1"], [false, "0"], [undefined, "0"]] as const)("sets FORCE_COLOR for replay destination %p", async (isTTY, expected) => {
    const a = new FakeTestGroupProcess(); const b = new FakeTestGroupProcess(); const h = runnerHarness([a, b], 6, isTTY);
    const running = runSelectedTestGroups(REPOSITORY_ROOT, [unit, transport], h.dependencies);
    await launched(h.records, 2);
    for (const record of h.records) { expect(record.options.env).not.toBe(process.env); expect(record.options.env?.FORCE_COLOR).toBe(expected); }
    a.exit(0); b.exit(0); await running;
  });

  test("synchronous and pre-spawn failures retain canonical error after siblings settle and replay", async () => {
    const sibling = new FakeTestGroupProcess(); const h = runnerHarness([sibling]); const error = new Error("sync failure");
    let calls = 0;
    const running = runSelectedTestGroups(REPOSITORY_ROOT, [unit, transport], { ...h.dependencies, spawn(command, args, options) {
      calls += 1; if (calls === 1) throw error; return h.dependencies.spawn(command, args, options);
    } });
    for (let turn = 0; turn < 100 && calls < 2; turn += 1) await Bun.sleep(1);
    expect(calls).toBe(2); sibling.exit(0); await expect(running).rejects.toBe(error);
    expect(h.stdoutText()).toContain("test group failed to start: sync failure\n");
  });

  test("normalises direct callers into canonical launch, replay, and result order", async () => {
    const a = new FakeTestGroupProcess(); const b = new FakeTestGroupProcess(); const c = new FakeTestGroupProcess();
    const h = runnerHarness([a, b, c]); const canonicalError = new Error("canonical unit");
    const running = runSelectedTestGroups(REPOSITORY_ROOT, [{ name: "integration", files: ["test/pi-integration.test.ts"] }, transport, unit], h.dependencies);
    await launched(h.records, 3);
    expect(h.records.map((record) => record.args[1])).toEqual([unit.files[0], transport.files[0], "test/pi-integration.test.ts"]);
    expect(h.records[2]?.args.at(-1)).toBe("4");
    c.exit(17); b.exit(23); a.spawnError(canonicalError);
    await expect(running).rejects.toBe(canonicalError);
  });

  test("descriptor close failure after spawn waits for every child and remains a setup failure", async () => {
    const a = new FakeTestGroupProcess(); const b = new FakeTestGroupProcess(); const h = runnerHarness([a, b]);
    const closeFailure = new Error("parent close failed"); let removals = 0;
    const originalOpen = h.fileSystem.open;
    const running = runSelectedTestGroups(REPOSITORY_ROOT, [unit, transport], {
      ...h.dependencies,
      fileSystem: {
        ...h.fileSystem,
        async open(path, flags, mode) {
          const handle = await originalOpen(path, flags, mode);
          const close = handle.close.bind(handle); let failed = false;
          handle.close = async () => { await close(); if (!failed) { failed = true; throw closeFailure; } };
          return handle;
        },
        async rm(path) { removals += 1; await h.fileSystem.rm(path); },
      },
    });
    await launched(h.records, 2);
    expect(h.stdoutText()).toBe("");
    a.exit(0); b.exit(0);
    await expect(running).rejects.toBe(closeFailure);
    expect(removals).toBe(1);
    expect(h.stdoutText()).not.toContain("failed to start");
  });

  test("post-spawn error waits for exit while pre-spawn error is canonical", async () => {
    const a = new FakeTestGroupProcess(); const b = new FakeTestGroupProcess(); const h = runnerHarness([a, b]); const error = new Error("failed start");
    const running = runSelectedTestGroups(REPOSITORY_ROOT, [unit, transport], h.dependencies);
    await launched(h.records, 2);
    a.spawned(); a.spawnError(new Error("ignored after spawn")); b.spawnError(error);
    a.exit(17); await expect(running).rejects.toBe(error);
  });

  test("canonical spawn error and numeric failure selection ignore reverse settlement", async () => {
    const a = new FakeTestGroupProcess(); const b = new FakeTestGroupProcess(); const c = new FakeTestGroupProcess(); const h = runnerHarness([a, b, c]); const error = new Error("first");
    const running = runSelectedTestGroups(REPOSITORY_ROOT, [unit, transport, processGroup], h.dependencies);
    await launched(h.records, 3);
    c.exit(23); b.exit(17); a.spawnError(error); await expect(running).rejects.toBe(error);
  });

  test("replays every available transcript once, sequentially, with end false", async () => {
    const a = new FakeTestGroupProcess(); const b = new FakeTestGroupProcess(); const h = runnerHarness([a, b]);
    const calls: Array<{ readonly name: string; readonly options: unknown }> = [];
    const lifecycle: string[] = [];
    const pipeline = (async (source: NodeJS.ReadableStream, destination: NodeJS.WritableStream, options: unknown) => {
      const name = calls.length === 0 ? "unit" : "transport";
      calls.push({ name, options }); lifecycle.push(`start ${name}`);
      await streamPipeline(source, destination as NodeJS.WritableStream & { end(): void }, options as { end: false });
      lifecycle.push(`end ${name}`);
    }) as unknown as typeof import("node:stream/promises").pipeline;
    const running = runSelectedTestGroups(REPOSITORY_ROOT, [unit, transport], { ...h.dependencies, pipeline });
    await launched(h.records, 2);
    writeChildOutput(h.records[0]!, "unit\n"); writeChildOutput(h.records[1]!, "transport\n");
    b.exit(0); a.exit(0);
    expect(await running).toBe(0);
    expect(calls).toEqual([
      { name: "unit", options: { end: false } },
      { name: "transport", options: { end: false } },
    ]);
    expect(lifecycle).toEqual(["start unit", "end unit", "start transport", "end transport"]);
  });

  test("passes the replay destination directly to the injected pipeline", async () => {
    const first = new FakeTestGroupProcess();
    const second = new FakeTestGroupProcess();
    const harness = runnerHarness([first, second]);
    const destinations: NodeJS.WritableStream[] = [];
    const pipeline = (async (
      source: NodeJS.ReadableStream,
      destination: NodeJS.WritableStream,
    ) => {
      destinations.push(destination);
      source.resume();
    }) as typeof streamPipeline;

    const running = runSelectedTestGroups(REPOSITORY_ROOT, [unit, transport], {
      ...harness.dependencies,
      pipeline,
    });
    await launched(harness.records, 2);
    first.exit(0);
    second.exit(0);

    expect(await running).toBe(0);
    expect(destinations).toEqual([
      harness.dependencies.stdout,
      harness.dependencies.stdout,
    ]);
  });

  test("preserves a transcript callback error when the paired error event follows", async () => {
    const first = new FakeTestGroupProcess();
    const second = new FakeTestGroupProcess();
    const harness = runnerHarness([first, second]);
    const failure = new Error("transcript output failed");
    const output = new Writable({
      write(chunk, _encoding, callback) {
        callback(chunk.toString("utf8") === "transcript" ? failure : undefined);
      },
    });

    const running = runSelectedTestGroups(REPOSITORY_ROOT, [unit, transport], {
      ...harness.dependencies,
      stdout: output,
      fileSystem: {
        ...harness.fileSystem,
        createReadStream(path) {
          const source = new PassThrough();
          source.write(readFileSync(path));
          setImmediate(() => source.end());
          return source;
        },
      },
    });
    await launched(harness.records, 2);
    writeChildOutput(harness.records[0]!, "transcript");
    first.exit(0);
    second.exit(0);

    await expect(running).rejects.toBe(failure);
    await Bun.sleep(1);
  });

  test("preserves the exact callback-only non-EPIPE heading write error", async () => {
    const first = new FakeTestGroupProcess();
    const second = new FakeTestGroupProcess();
    const harness = runnerHarness([first, second]);
    const failure = new Error("heading output failed");
    const output = new EventEmitter() as EventEmitter & RunnerDependencies["stdout"];
    output.write = ((_chunk: string | Uint8Array, callback?: (error?: Error | null) => void) => {
      callback?.(failure);
      return false;
    }) as typeof output.write;

    const running = runSelectedTestGroups(REPOSITORY_ROOT, [unit, transport], {
      ...harness.dependencies,
      stdout: output,
    });
    await launched(harness.records, 2);
    first.exit(0);
    second.exit(0);

    await expect(running).rejects.toBe(failure);
  });

  test("preserves the exact callback-only non-EPIPE final-newline write error", async () => {
    const first = new FakeTestGroupProcess();
    const second = new FakeTestGroupProcess();
    const harness = runnerHarness([first, second]);
    const failure = new Error("newline output failed");
    const output = new EventEmitter() as EventEmitter & RunnerDependencies["stdout"];
    let writes = 0;
    output.write = ((_chunk: string | Uint8Array, callback?: (error?: Error | null) => void) => {
      writes += 1;
      if (writes === 3) {
        callback?.(failure);
      } else {
        callback?.();
      }
      return true;
    }) as typeof output.write;

    const running = runSelectedTestGroups(REPOSITORY_ROOT, [unit, transport], {
      ...harness.dependencies,
      stdout: output,
    });
    await launched(harness.records, 2);
    writeChildOutput(harness.records[0]!, "without newline");
    first.exit(0);
    second.exit(0);

    await expect(running).rejects.toBe(failure);
  });

  test("heading EPIPE stops publication and preserves the canonical numeric status", async () => {
    const a = new FakeTestGroupProcess(); const b = new FakeTestGroupProcess(); const h = runnerHarness([a, b]);
    const output = new EventEmitter() as EventEmitter & RunnerDependencies["stdout"];
    let writes = 0;
    output.write = ((_chunk: string | Uint8Array, callback?: (error?: Error | null) => void) => {
      writes += 1;
      const error = Object.assign(new Error("heading closed"), { code: "EPIPE" });
      if (writes === 1) {
        callback?.(error);
        process.nextTick(() => output.emit("error", error));
      } else callback?.();
      return false;
    }) as typeof output.write;
    const running = runSelectedTestGroups(REPOSITORY_ROOT, [unit, transport], { ...h.dependencies, stdout: output });
    await launched(h.records, 2); a.exit(17); b.exit(0);
    expect(await running).toBe(17);
    await Bun.sleep(1);
    expect(writes).toBe(1);
  });

  test("final-newline EPIPE stops publication and preserves the canonical numeric status", async () => {
    const a = new FakeTestGroupProcess(); const b = new FakeTestGroupProcess(); const h = runnerHarness([a, b]);
    const output = new EventEmitter() as EventEmitter & RunnerDependencies["stdout"];
    let writes = 0;
    output.write = ((_chunk: string | Uint8Array, callback?: (error?: Error | null) => void) => {
      writes += 1;
      const error = Object.assign(new Error("newline closed"), { code: "EPIPE" });
      if (writes === 3) {
        callback?.(error);
        process.nextTick(() => output.emit("error", error));
      } else callback?.();
      return true;
    }) as typeof output.write;
    const running = runSelectedTestGroups(REPOSITORY_ROOT, [unit, transport], { ...h.dependencies, stdout: output });
    await launched(h.records, 2); writeChildOutput(h.records[0]!, "without newline"); a.exit(17); b.exit(0);
    expect(await running).toBe(17);
    await Bun.sleep(1);
    expect(writes).toBe(3);
  });

  test("pipeline is sequential with end false and its non-EPIPE failure wins", async () => {
    const a = new FakeTestGroupProcess(); const b = new FakeTestGroupProcess(); const h = runnerHarness([a, b]); const failure = new Error("replay failed"); let calls = 0;
    const pipeline = (async (source: NodeJS.ReadableStream) => { (source as NodeJS.ReadableStream & { destroy(): void }).destroy(); calls += 1; throw failure; }) as unknown as typeof import("node:stream/promises").pipeline;
    const running = runSelectedTestGroups(REPOSITORY_ROOT, [unit, transport], { ...h.dependencies, pipeline });
    await launched(h.records, 2);
    a.exit(0); b.exit(17); await expect(running).rejects.toBe(failure); expect(calls).toBe(1);
  });

  test("replay failure retains exact identity and attaches the canonical spawn rejection as cause", async () => {
    const sibling = new FakeTestGroupProcess();
    const harness = runnerHarness([sibling]);
    const spawnFailure = new Error("canonical spawn failure");
    const replayFailure = new Error("replay failure");
    const pipeline = (async () => { throw replayFailure; }) as typeof streamPipeline;
    const running = runSelectedTestGroups(REPOSITORY_ROOT, [unit, transport], {
      ...harness.dependencies,
      pipeline,
      spawn(command, args, options) {
        if (args[1] === unit.files[0]) throw spawnFailure;
        return harness.dependencies.spawn(command, args, options);
      },
    });
    await launched(harness.records, 1);
    sibling.exit(0);

    await expect(running).rejects.toBe(replayFailure);
    expect(replayFailure.cause).toBe(spawnFailure);
  });

  test("transcript EPIPE through the writable callback and paired error event stops publication", async () => {
    const first = new FakeTestGroupProcess();
    const second = new FakeTestGroupProcess();
    const harness = runnerHarness([first, second]);
    const epipe = Object.assign(new Error("transcript closed"), { code: "EPIPE" });
    let writes = 0;
    const output = new Writable({
      write(chunk, _encoding, callback) {
        writes += 1;
        callback(chunk.toString("utf8") === "transcript" ? epipe : undefined);
      },
    });
    const running = runSelectedTestGroups(REPOSITORY_ROOT, [unit, transport], {
      ...harness.dependencies,
      stdout: output,
    });
    await launched(harness.records, 2);
    writeChildOutput(harness.records[0]!, "transcript");
    first.exit(17);
    second.exit(0);

    expect(await running).toBe(17);
    await Bun.sleep(1);
    expect(writes).toBe(2);
  });

  test("EPIPE stops publication but preserves canonical numeric result", async () => {
    const a = new FakeTestGroupProcess(); const b = new FakeTestGroupProcess(); const h = runnerHarness([a, b]);
    const epipe = Object.assign(new Error("closed"), { code: "EPIPE" });
    const pipeline = (async (source: NodeJS.ReadableStream) => { (source as NodeJS.ReadableStream & { destroy(): void }).destroy(); throw epipe; }) as unknown as typeof import("node:stream/promises").pipeline;
    const running = runSelectedTestGroups(REPOSITORY_ROOT, [unit, transport], { ...h.dependencies, pipeline });
    await launched(h.records, 2);
    a.exit(17); b.exit(0); expect(await running).toBe(17);
  });

  test("direct Node pipeline preserves caller listeners installed synchronously by pipe handlers", async () => {
    const first = new FakeTestGroupProcess();
    const second = new FakeTestGroupProcess();
    const harness = runnerHarness([first, second]);
    const output = new Writable({
      write(_chunk, _encoding, callback) {
        callback();
      },
    });
    output.setMaxListeners(100);
    const callerListeners: Array<() => void> = [];
    output.on("pipe", () => {
      const listener = () => undefined;
      callerListeners.push(listener);
      output.on("error", listener);
    });

    const running = runSelectedTestGroups(REPOSITORY_ROOT, [unit, transport], {
      ...harness.dependencies,
      stdout: output,
    });
    await launched(harness.records, 2);
    first.exit(0);
    second.exit(0);

    expect(await running).toBe(0);
    expect(output.getMaxListeners()).toBe(100);
    expect(callerListeners).toHaveLength(2);
    for (const listener of callerListeners) {
      expect(output.listeners("error")).toContain(listener);
      output.removeListener("error", listener);
    }
  });

  test("selects the first canonical numeric failure across multiple groups", async () => {
    const first = new FakeTestGroupProcess();
    const second = new FakeTestGroupProcess();
    const third = new FakeTestGroupProcess();
    const harness = runnerHarness([first, second, third]);
    const running = runSelectedTestGroups(
      REPOSITORY_ROOT,
      [unit, transport, processGroup],
      harness.dependencies,
    );
    await launched(harness.records, 3);

    third.exit(29);
    second.exit(23);
    first.exit(17);

    expect(await running).toBe(17);
  });

  test.each([
    [null, "SIGTERM", 1],
    [null, null, 1],
  ] as const)(
    "maps multi-group exit %p/%p to status %d",
    async (code, signal, expected) => {
      const first = new FakeTestGroupProcess();
      const second = new FakeTestGroupProcess();
      const harness = runnerHarness([first, second]);
      const running = runSelectedTestGroups(
        REPOSITORY_ROOT,
        [unit, transport],
        harness.dependencies,
      );
      await launched(harness.records, 2);

      second.exit(23);
      first.exit(code, signal);

      expect(await running).toBe(expected);
    },
  );

  test.each([
    "numeric",
    "spawn",
    "replay",
    "epipe-success",
    "epipe-numeric",
  ] as const)("removes the directory after a %s outcome", async (outcome) => {
    const first = new FakeTestGroupProcess();
    const second = new FakeTestGroupProcess();
    const harness = runnerHarness(outcome === "spawn" ? [second] : [first, second]);
    const primary = new Error(`${outcome} failure`);
    const epipe = Object.assign(new Error("closed"), { code: "EPIPE" });
    let removals = 0;
    const pipeline = outcome === "replay"
      ? (async () => { throw primary; }) as typeof streamPipeline
      : outcome.startsWith("epipe")
        ? (async () => { throw epipe; }) as typeof streamPipeline
        : undefined;
    const running = runSelectedTestGroups(REPOSITORY_ROOT, [unit, transport], {
      ...harness.dependencies,
      ...(pipeline === undefined ? {} : { pipeline }),
      spawn(command, args, options) {
        if (outcome === "spawn" && args[1] === unit.files[0]) {
          throw primary;
        }
        return harness.dependencies.spawn(command, args, options);
      },
      fileSystem: {
        ...harness.fileSystem,
        async rm(path) {
          removals += 1;
          await harness.fileSystem.rm(path);
        },
      },
    });
    await launched(harness.records, outcome === "spawn" ? 1 : 2);

    if (outcome === "spawn") {
      second.exit(0);
      await expect(running).rejects.toBe(primary);
    } else {
      first.exit(outcome === "numeric" || outcome === "epipe-numeric" ? 17 : 0);
      second.exit(0);
      if (outcome === "replay") {
        await expect(running).rejects.toBe(primary);
      } else {
        expect(await running).toBe(
          outcome === "numeric" || outcome === "epipe-numeric" ? 17 : 0,
        );
      }
    }

    expect(removals).toBe(1);
    expect(existsSync(harness.temporaryDirectory()!)).toBeFalse();
  });

  test("bounds and sanitises spawn and cleanup diagnostics as complete UTF-8 lines", async () => {
    const child = new FakeTestGroupProcess();
    const harness = runnerHarness([child]);
    const message = `forged\r\n\ud800${"£".repeat(2_000)}`;
    const spawnFailure = new Error(message);
    const cleanupFailure = new Error(message);
    const running = runSelectedTestGroups(REPOSITORY_ROOT, [unit, transport], {
      ...harness.dependencies,
      spawn(command, args, options) {
        if (args[1] === unit.files[0]) {
          throw spawnFailure;
        }
        return harness.dependencies.spawn(command, args, options);
      },
      fileSystem: {
        ...harness.fileSystem,
        async rm() {
          throw cleanupFailure;
        },
      },
    });
    await launched(harness.records, 1);
    child.exit(0);
    await expect(running).rejects.toBe(spawnFailure);

    const spawnLine = harness.stdoutText().split("\n").find((line) =>
      line.startsWith("test group failed to start: "));
    expect(spawnLine).toBeDefined();
    assertBoundedDiagnostic(`${spawnLine}\n`);
    assertBoundedDiagnostic(harness.stderrText());
  });

  test("allocation failure removes opened files and launches no child", async () => {
    const h = runnerHarness([]); const failure = new Error("allocation failed"); let opens = 0; let spawns = 0;
    const running = runSelectedTestGroups(REPOSITORY_ROOT, [unit, transport], { ...h.dependencies, spawn() { spawns += 1; throw new Error("no"); }, fileSystem: {
      ...h.fileSystem, async open(path, flags, mode) { opens += 1; if (opens === 2) throw failure; return h.fileSystem.open(path, flags, mode); },
    } });
    await expect(running).rejects.toBe(failure); expect(spawns).toBe(0); const directory = h.temporaryDirectory(); expect(directory === undefined || !existsSync(directory)).toBeTrue();
  });

  test("replay cleanup preserves caller error listeners added during the pipeline", async () => {
    const a = new FakeTestGroupProcess(); const b = new FakeTestGroupProcess(); const h = runnerHarness([a, b]);
    const callerListener = () => undefined;
    const pipeline = (async (source: NodeJS.ReadableStream) => {
      h.dependencies.stdout.once("error", callerListener);
      source.resume();
    }) as unknown as typeof import("node:stream/promises").pipeline;
    const running = runSelectedTestGroups(REPOSITORY_ROOT, [unit, transport], { ...h.dependencies, pipeline });
    await launched(h.records, 2);
    a.exit(0); b.exit(0);
    await running;
    expect(h.dependencies.stdout.listeners("error")).toContain(callerListener);
    h.dependencies.stdout.removeListener("error", callerListener);
  });

  test("asynchronous cleanup diagnostic errors preserve the primary status", async () => {
    const a = new FakeTestGroupProcess(); const b = new FakeTestGroupProcess(); const h = runnerHarness([a, b]);
    const cleanupFailure = new Error("cleanup failed"); const diagnosticFailure = new Error("closed stderr");
    const stderr = new EventEmitter() as EventEmitter & Pick<NodeJS.WritableStream, "write">;
    stderr.write = ((...args: unknown[]) => {
      const done = args.find((argument): argument is () => void => typeof argument === "function");
      process.nextTick(() => { done?.(); stderr.emit("error", diagnosticFailure); });
      return true;
    }) as typeof stderr.write;
    const running = runSelectedTestGroups(REPOSITORY_ROOT, [unit, transport], {
      ...h.dependencies,
      stderr,
      fileSystem: { ...h.fileSystem, async rm() { throw cleanupFailure; } },
    });
    await launched(h.records, 2);
    a.exit(17); b.exit(0);
    expect(await running).toBe(17);
    await Bun.sleep(1);
  });

  test("cleanup failure preserves a canonical spawn rejection and writes one diagnostic", async () => {
    const child = new FakeTestGroupProcess(); const h = runnerHarness([child]); const primary = new Error("spawn failed"); const cleanup = new Error("cleanup failed");
    const running = runSelectedTestGroups(REPOSITORY_ROOT, [unit, transport], {
      ...h.dependencies,
      spawn(command, args, options) { if (args[1] === unit.files[0]) throw primary; return h.dependencies.spawn(command, args, options); },
      fileSystem: { ...h.fileSystem, async rm() { throw cleanup; } },
    });
    await launched(h.records, 1); child.exit(0);
    await expect(running).rejects.toBe(primary);
    expect(h.stderrText()).toBe("test runner cleanup failed: cleanup failed\n");
  });

  test("cleanup failure preserves a replay rejection and writes one diagnostic", async () => {
    const a = new FakeTestGroupProcess(); const b = new FakeTestGroupProcess(); const h = runnerHarness([a, b]); const primary = new Error("replay failed"); const cleanup = new Error("cleanup failed");
    const pipeline = (async () => { throw primary; }) as unknown as typeof import("node:stream/promises").pipeline;
    const running = runSelectedTestGroups(REPOSITORY_ROOT, [unit, transport], { ...h.dependencies, pipeline, fileSystem: { ...h.fileSystem, async rm() { throw cleanup; } } });
    await launched(h.records, 2); a.exit(0); b.exit(0);
    await expect(running).rejects.toBe(primary);
    expect(h.stderrText()).toBe("test runner cleanup failed: cleanup failed\n");
  });

  test("EPIPE plus success makes cleanup failure primary", async () => {
    const a = new FakeTestGroupProcess(); const b = new FakeTestGroupProcess(); const h = runnerHarness([a, b]); const cleanup = new Error("cleanup failed");
    const epipe = Object.assign(new Error("closed"), { code: "EPIPE" });
    const pipeline = (async () => { throw epipe; }) as unknown as typeof import("node:stream/promises").pipeline;
    const running = runSelectedTestGroups(REPOSITORY_ROOT, [unit, transport], { ...h.dependencies, pipeline, fileSystem: { ...h.fileSystem, async rm() { throw cleanup; } } });
    await launched(h.records, 2); a.exit(0); b.exit(0);
    await expect(running).rejects.toBe(cleanup);
    expect(h.stderrText()).toBe("");
  });

  test("EPIPE plus numeric failure preserves status and writes one diagnostic", async () => {
    const a = new FakeTestGroupProcess(); const b = new FakeTestGroupProcess(); const h = runnerHarness([a, b]); const cleanup = new Error("cleanup failed");
    const epipe = Object.assign(new Error("closed"), { code: "EPIPE" });
    const pipeline = (async () => { throw epipe; }) as unknown as typeof import("node:stream/promises").pipeline;
    const running = runSelectedTestGroups(REPOSITORY_ROOT, [unit, transport], { ...h.dependencies, pipeline, fileSystem: { ...h.fileSystem, async rm() { throw cleanup; } } });
    await launched(h.records, 2); a.exit(17); b.exit(0);
    expect(await running).toBe(17);
    expect(h.stderrText()).toBe("test runner cleanup failed: cleanup failed\n");
  });

  test("cleanup failure is primary only after success and otherwise writes bounded diagnostic", async () => {
    const a = new FakeTestGroupProcess(); const b = new FakeTestGroupProcess(); const h = runnerHarness([a, b]); const failure = new Error("cleanup\nforged");
    const running = runSelectedTestGroups(REPOSITORY_ROOT, [unit, transport], { ...h.dependencies, fileSystem: { ...h.fileSystem, async rm() { throw failure; } } });
    await launched(h.records, 2);
    a.exit(17); b.exit(0); expect(await running).toBe(17); expect(h.stderrText()).toBe("test runner cleanup failed: cleanup forged\n");
  });

  test("a cleanup-only failure rejects with its exact error without a diagnostic", async () => {
    const a = new FakeTestGroupProcess(); const b = new FakeTestGroupProcess(); const h = runnerHarness([a, b]);
    const cleanupFailure = new Error("cleanup only");
    const running = runSelectedTestGroups(REPOSITORY_ROOT, [unit, transport], {
      ...h.dependencies,
      fileSystem: { ...h.fileSystem, async rm() { throw cleanupFailure; } },
    });
    await launched(h.records, 2);
    a.exit(0); b.exit(0);
    await expect(running).rejects.toBe(cleanupFailure);
    expect(h.stderrText()).toBe("");
  });
});

function assertBoundedDiagnostic(line: string): void {
  const bytes = Buffer.from(line);
  expect(bytes.byteLength).toBeLessThanOrEqual(1_024);
  expect(line.endsWith("\n")).toBeTrue();
  expect(line.match(/\n/g)).toHaveLength(1);
  expect(line).not.toContain("\r");
  expect(() => new TextDecoder("utf-8", { fatal: true }).decode(bytes)).not.toThrow();
}

describe("test group registry and commands", () => {
  test("rejects a missing test directory", async () => {
    const root = await mkdtemp(join(tmpdir(), "pi-subagents-missing-tests-"));
    try { expect(() => discoverTestFiles(root)).toThrow(`test directory not found: ${join(root, "test")}`); }
    finally { await rm(root, { recursive: true, force: true }); }
  });

  test.each(["root", "file", "directory"] as const)("rejects a symlinked test %s", async (kind) => {
    const root = await mkdtemp(join(tmpdir(), "pi-subagents-symlink-tests-"));
    const target = join(root, "target"); const testRoot = join(root, "test");
    try {
      await mkdir(target);
      if (kind === "root") await symlink(target, testRoot);
      else {
        await mkdir(testRoot);
        if (kind === "file") { await writeFile(join(target, "case.test.ts"), ""); await symlink(join(target, "case.test.ts"), join(testRoot, "case.test.ts")); }
        else { await mkdir(join(target, "nested")); await symlink(join(target, "nested"), join(testRoot, "nested")); }
      }
      expect(() => discoverTestFiles(root)).toThrow("symlinked test path:");
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  test("rejects unassigned and multiply-owned test files", () => {
    expect(() => resolveTestGroupOwner("test/unassigned.test.ts")).toThrow("unassigned test file: test/unassigned.test.ts");
    const rules = { ...TEST_GROUP_RULES, unit: new Set(["shared.test.ts"]), transport: new Set(["shared.test.ts"]) };
    expect(() => resolveTestGroupOwner("test/shared.test.ts", rules)).toThrow("multiply assigned test file: test/shared.test.ts");
  });

  test("rejects malformed and unknown group arguments", () => {
    expect(() => parseRequestedGroups(["unit"])).toThrow("unexpected argument: unit");
    expect(() => parseRequestedGroups(["--group"])).toThrow("--group requires a group name");
    expect(() => parseRequestedGroups(["--group", "unknown"])).toThrow("unknown test group: unknown");
  });

  test("discovers canonical groups, selects in registry order, and inventories every test", () => {
    const files = discoverTestFiles(REPOSITORY_ROOT);
    const groups = groupTestFiles(files);
    expect(groups.map((group) => group.name)).toEqual([...TEST_GROUP_NAMES]);
    expect(selectTestGroups(groups, ["transport", "unit"]).map((group) => group.name)).toEqual(["unit", "transport"]);
    expect(parseRequestedGroups(["--group", "unit", "--group", "unit"])).toEqual(["unit"]);
    expect(new Set(TEST_GROUP_NAMES.flatMap((name) => [...TEST_GROUP_RULES[name]])).size).toBe(files.length);
    expect([...TEST_GROUP_NAMES.flatMap((name) => [...TEST_GROUP_RULES[name]])].sort()).toEqual(files.map((file) => basename(file)).sort());
  });
  test.each([[1, 1, 1], [6, 1, 6], [6, 2, 5], [6, 5, 2], [6, 6, 1], [64, 6, 12]] as const)(
    "maps capacity %d with %d runnable groups to %d", (available, groups, expected) => {
      expect(integrationConcurrency(available, groups)).toBe(expected);
    },
  );
  test.each([[0, 1], [1.5, 1], [1, 0], [1, 1.5]] as const)("rejects invalid capacity inputs %p/%p", (available, groups) => {
    expect(() => integrationConcurrency(available, groups)).toThrow(TypeError);
  });
  test("uses the established timeout and integration capacity", () => {
    expect(testCommandArguments({ name: "integration", files: ["test/pi-integration.test.ts"] }, 6, 5)).toEqual(["test", "test/pi-integration.test.ts", "--timeout", "30000", "--concurrent", "--max-concurrency", "2"]);
    const integrationTests = readFileSync(
      join(REPOSITORY_ROOT, "test/pi-integration.test.ts"),
      "utf8",
    );
    expect(integrationTests).toContain("}, 30_000);");
    expect(integrationTests).toContain("}, 40_000);");
  });
});
