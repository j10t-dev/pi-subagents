import { spawn, type SpawnOptions } from "node:child_process";
import { createReadStream, type Stats } from "node:fs";
import { chmod, mkdtemp, open, rm, type FileHandle } from "node:fs/promises";
import { availableParallelism, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pipeline as nodePipeline } from "node:stream/promises";
import { fileURLToPath } from "node:url";

import {
  discoverTestFiles,
  groupTestFiles,
  parseRequestedGroups,
  selectTestGroups,
  TEST_GROUP_NAMES,
  type TestGroup,
} from "./test-groups.ts";

export interface TestGroupProcess {
  once(event: "spawn", listener: () => void): this;
  once(event: "error", listener: (error: Error) => void): this;
  once(
    event: "exit",
    listener: (
      code: number | null,
      signal: NodeJS.Signals | null,
    ) => void,
  ): this;
}

export interface RunnerOutput extends NodeJS.WritableStream {
  readonly isTTY?: boolean;
}

export interface RunnerFileSystem {
  mkdtemp(prefix: string): Promise<string>;
  open(path: string, flags: string, mode: number): Promise<FileHandle>;
  createReadStream(path: string): NodeJS.ReadableStream;
  stat(handle: FileHandle): Promise<Stats>;
  readLastByte(handle: FileHandle, position: number): Promise<number>;
  rm(path: string): Promise<void>;
}

export interface RunnerDependencies {
  readonly spawn: (
    command: string,
    args: readonly string[],
    options: SpawnOptions,
  ) => TestGroupProcess;
  readonly stdout: RunnerOutput;
  readonly stderr: Pick<NodeJS.WritableStream, "write">;
  readonly parallelism: number;
  readonly fileSystem?: RunnerFileSystem;
  readonly pipeline?: typeof nodePipeline;
}

interface AllocatedTranscript {
  readonly group: TestGroup;
  readonly path: string;
  readonly handle: FileHandle;
}

type SettledResult =
  | { readonly kind: "status"; readonly status: number }
  | { readonly kind: "spawn-error"; readonly error: unknown };

interface SettledGroup {
  readonly group: TestGroup;
  readonly transcriptPath: string;
  readonly result: SettledResult;
}

type Outcome =
  | { readonly kind: "status"; readonly status: number }
  | { readonly kind: "error"; readonly error: unknown };

interface LaunchResult {
  readonly settled: SettledGroup[];
  readonly closeError: unknown;
}

const fileSystem: RunnerFileSystem = {
  mkdtemp,
  open,
  createReadStream,
  async stat(handle) {
    return handle.stat();
  },
  async readLastByte(handle, position) {
    const buffer = Buffer.alloc(1);
    await handle.read(buffer, 0, 1, position);
    return buffer[0] ?? -1;
  },
  async rm(path) {
    await rm(path, { recursive: true, force: true });
  },
};

export async function runSelectedTestGroups(
  root: string,
  groups: readonly TestGroup[],
  dependencies: RunnerDependencies,
): Promise<number> {
  const runnable = canonicalRunnableGroups(groups);
  if (runnable.length === 0) {
    return 0;
  }
  if (runnable.length === 1) {
    return spawnInheritedGroup(
      root,
      runnable[0]!,
      runnable.length,
      dependencies,
    );
  }
  return runConcurrentGroups(root, runnable, dependencies);
}

export function integrationConcurrency(
  parallelism: number,
  runnableGroupCount: number,
): number {
  if (!Number.isInteger(parallelism) || parallelism < 1) {
    throw new TypeError("available parallelism must be a positive integer");
  }
  if (!Number.isInteger(runnableGroupCount) || runnableGroupCount < 1) {
    throw new TypeError("runnable group count must be a positive integer");
  }
  return Math.min(
    12,
    Math.max(1, parallelism - Math.max(0, runnableGroupCount - 1)),
  );
}

export function testCommandArguments(
  group: TestGroup,
  parallelism: number,
  runnableGroupCount: number,
): string[] {
  return [
    "test",
    ...group.files,
    "--timeout",
    "30000",
    ...(group.name === "integration"
      ? [
          "--concurrent",
          "--max-concurrency",
          String(integrationConcurrency(parallelism, runnableGroupCount)),
        ]
      : []),
  ];
}

function spawnInheritedGroup(
  root: string,
  group: TestGroup,
  runnableGroupCount: number,
  dependencies: RunnerDependencies,
): Promise<number> {
  return new Promise((resolveExit, reject) => {
    let child: TestGroupProcess;
    try {
      child = dependencies.spawn(
        process.execPath,
        testCommandArguments(
          group,
          dependencies.parallelism,
          runnableGroupCount,
        ),
        {
          cwd: root,
          stdio: "inherit",
          env: process.env,
        },
      );
    } catch (error) {
      reject(error);
      return;
    }
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      resolveExit(signal === null ? code ?? 1 : 1);
    });
  });
}

async function runConcurrentGroups(
  root: string,
  runnable: readonly TestGroup[],
  dependencies: RunnerDependencies,
): Promise<number> {
  const fs = dependencies.fileSystem ?? fileSystem;
  const pipeline = dependencies.pipeline ?? nodePipeline;
  let directory: string | undefined;
  let outcome: Outcome = { kind: "status", status: 0 };
  let cleanupError: Error | undefined;
  const transcripts: AllocatedTranscript[] = [];

  try {
    directory = await fs.mkdtemp(join(tmpdir(), "pi-subagents-tests-"));
    await chmod(directory, 0o700);
    for (const group of runnable) {
      const path = join(directory, `${group.name}.log`);
      transcripts.push({
        group,
        path,
        handle: await fs.open(path, "wx", 0o600),
      });
    }
    const launched = await launchAndSettle(
      root,
      transcripts,
      runnable.length,
      dependencies,
    );
    cleanupError = asError(launched.closeError);
    const originalMaxListeners = dependencies.stdout.getMaxListeners();
    if (originalMaxListeners !== 0) {
      dependencies.stdout.setMaxListeners(
        originalMaxListeners + launched.settled.length * 4,
      );
    }
    try {
      await replayGroups(launched.settled, fs, pipeline, dependencies);
    } finally {
      dependencies.stdout.setMaxListeners(originalMaxListeners);
    }
    outcome = selectCanonicalResult(launched.settled);
  } catch (error) {
    outcome = { kind: "error", error };
  }

  cleanupError ??= asError(await firstCloseError(transcripts));
  try {
    if (directory !== undefined) {
      await fs.rm(directory);
    }
  } catch (error) {
    cleanupError ??= asError(error);
  }

  if (cleanupError !== undefined) {
    const hasPrimary = outcome.kind === "error" || outcome.status !== 0;
    if (!hasPrimary) {
      throw cleanupError;
    }
    writeDiagnostic(
      dependencies.stderr,
      "test runner cleanup failed: ",
      cleanupError,
    );
  }
  if (outcome.kind === "error") {
    throw outcome.error;
  }
  return outcome.status;
}

async function launchAndSettle(
  root: string,
  transcripts: readonly AllocatedTranscript[],
  runnableGroupCount: number,
  dependencies: RunnerDependencies,
): Promise<LaunchResult> {
  const settlements: Array<Promise<SettledGroup>> = [];
  const closes: Array<Promise<unknown>> = [];

  for (const transcript of transcripts) {
    let child: TestGroupProcess;
    try {
      child = dependencies.spawn(
        process.execPath,
        testCommandArguments(
          transcript.group,
          dependencies.parallelism,
          runnableGroupCount,
        ),
        {
          cwd: root,
          stdio: ["inherit", transcript.handle.fd, transcript.handle.fd],
          env: {
            ...process.env,
            FORCE_COLOR: dependencies.stdout.isTTY === true ? "1" : "0",
          },
        },
      );
    } catch (error) {
      settlements.push(Promise.resolve({
        group: transcript.group,
        transcriptPath: transcript.path,
        result: { kind: "spawn-error", error },
      }));
      closes.push(
        closeHandle(transcript.handle).then(
          () => undefined,
          (closeError: unknown) => closeError,
        ),
      );
      continue;
    }

    settlements.push(
      settleChild(child).then((result) => ({
        group: transcript.group,
        transcriptPath: transcript.path,
        result,
      })),
    );
    closes.push(
      closeHandle(transcript.handle).then(
        () => undefined,
        (closeError: unknown) => closeError,
      ),
    );
  }

  const settled = await Promise.all(settlements);
  const closeResults = await Promise.all(closes);
  return {
    settled,
    closeError: closeResults.find((error) => error !== undefined),
  };
}

async function firstCloseError(
  transcripts: readonly AllocatedTranscript[],
): Promise<unknown> {
  const results = await Promise.all(
    transcripts.map((transcript) =>
      closeHandle(transcript.handle).then(
        () => undefined,
        (error: unknown) => error,
      )),
  );
  return results.find((error) => error !== undefined);
}

function settleChild(child: TestGroupProcess): Promise<SettledResult> {
  return new Promise((resolve) => {
    let spawned = false;
    let settled = false;

    const settle = (result: SettledResult): void => {
      if (!settled) {
        settled = true;
        resolve(result);
      }
    };

    child.once("spawn", () => {
      spawned = true;
    });
    child.once("error", (error) => {
      if (!spawned) {
        settle({ kind: "spawn-error", error });
      }
    });
    child.once("exit", (code, signal) => {
      settle({
        kind: "status",
        status: signal === null ? code ?? 1 : 1,
      });
    });
  });
}

async function replayGroups(
  records: readonly SettledGroup[],
  fs: RunnerFileSystem,
  pipeline: typeof nodePipeline,
  dependencies: RunnerDependencies,
): Promise<void> {
  for (const record of records) {
    try {
      await writeOutput(
        dependencies.stdout,
        `===== ${record.group.name} =====\n`,
      );
      const source = fs.createReadStream(record.transcriptPath);
      let destinationError: Error | undefined;
      const onDestinationError = (error: Error): void => {
        destinationError ??= error;
      };
      dependencies.stdout.once("error", onDestinationError);
      try {
        await pipeline(source, dependencies.stdout, { end: false });
      } catch (error) {
        dependencies.stdout.removeListener("error", onDestinationError);
        throw destinationError ?? error;
      }
      dependencies.stdout.removeListener("error", onDestinationError);
      if (destinationError !== undefined) {
        throw destinationError;
      }
      if (await transcriptNeedsNewline(record.transcriptPath, fs)) {
        await writeOutput(dependencies.stdout, "\n");
      }
      if (record.result.kind === "spawn-error") {
        await writeOutput(
          dependencies.stdout,
          boundedDiagnostic(
            "test group failed to start: ",
            record.result.error,
          ),
        );
      }
    } catch (error) {
      if (isEpipe(error)) {
        return;
      }
      const canonical = selectCanonicalResult(records);
      if (
        canonical.kind === "error"
        && error instanceof Error
        && !("cause" in error)
      ) {
        try {
          Object.assign(error, { cause: canonical.error });
        } catch {
          // Immutable errors retain identity without a cause.
        }
      }
      throw error;
    }
  }
}

async function transcriptNeedsNewline(
  path: string,
  fs: RunnerFileSystem,
): Promise<boolean> {
  const handle = await fs.open(path, "r", 0o600);
  try {
    const metadata = await fs.stat(handle);
    return metadata.size > 0
      && await fs.readLastByte(handle, metadata.size - 1) !== 0x0a;
  } finally {
    await closeHandle(handle);
  }
}

function selectCanonicalResult(records: readonly SettledGroup[]): Outcome {
  const rejected = records.find(
    (record) => record.result.kind === "spawn-error",
  );
  if (rejected?.result.kind === "spawn-error") {
    return { kind: "error", error: rejected.result.error };
  }
  const failed = records.find(
    (record) =>
      record.result.kind === "status" && record.result.status !== 0,
  );
  return {
    kind: "status",
    status: failed?.result.kind === "status" ? failed.result.status : 0,
  };
}

async function closeHandle(handle: FileHandle): Promise<void> {
  try {
    await handle.close();
  } catch (error) {
    if (!isClosedHandle(error)) {
      throw error;
    }
  }
}

function isClosedHandle(error: unknown): boolean {
  return error instanceof Error
    && "code" in error
    && error.code === "EBADF";
}

function isEpipe(error: unknown): boolean {
  return error instanceof Error
    && "code" in error
    && error.code === "EPIPE";
}

function writeOutput(
  output: NodeJS.WritableStream,
  text: string,
): Promise<void> {
  return new Promise((resolve, reject) => {
    let settled = false;

    const settle = (error?: Error | null): void => {
      if (settled) {
        return;
      }
      settled = true;
      if (error == null) {
        resolve();
      } else {
        reject(error);
      }
    };
    const onError = (error: Error): void => {
      output.removeListener("error", onError);
      settle(error);
    };

    output.once("error", onError);
    output.write(text, (error?: Error | null) => {
      if (error == null) {
        output.removeListener("error", onError);
        settle();
      } else {
        settle(error);
        setImmediate(() => output.removeListener("error", onError));
      }
    });
  });
}

function writeDiagnostic(
  output: Pick<NodeJS.WritableStream, "write">,
  prefix: string,
  error: unknown,
): void {
  const writable = output as NodeJS.WritableStream;
  const onError = (): void => {
    writable.removeListener?.("error", onError);
  };

  writable.once?.("error", onError);
  try {
    writable.write(boundedDiagnostic(prefix, error), () => {
      // Retain the listener through Node's callback-then-error turn.
      setImmediate(() => writable.removeListener?.("error", onError));
    });
  } catch {
    writable.removeListener?.("error", onError);
  }
}

function canonicalRunnableGroups(groups: readonly TestGroup[]): TestGroup[] {
  const order = new Map(
    TEST_GROUP_NAMES.map((name, index) => [name, index]),
  );
  return groups
    .filter((group) => group.files.length > 0)
    .sort(
      (left, right) => order.get(left.name)! - order.get(right.name)!,
    );
}

function asError(value: unknown): Error | undefined {
  if (value === undefined) return undefined;
  return value instanceof Error
    ? value
    : new Error(String(value), { cause: value });
}

function boundedDiagnostic(prefix: string, error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error);
  const message = raw.replace(/[\r\n]+/g, " ");
  const budget = 1_024 - Buffer.byteLength(prefix) - 1;
  let bytes = Buffer.from(message).subarray(0, Math.max(0, budget));

  while (bytes.length > 0) {
    try {
      new TextDecoder("utf-8", { fatal: true }).decode(bytes);
      break;
    } catch {
      bytes = bytes.subarray(0, -1);
    }
  }
  return `${prefix}${bytes.toString("utf8")}\n`;
}

async function main(): Promise<void> {
  const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
  const selected = selectTestGroups(
    groupTestFiles(discoverTestFiles(root)),
    parseRequestedGroups(process.argv.slice(2)),
  );
  process.exitCode = await runSelectedTestGroups(root, selected, {
    spawn,
    stdout: process.stdout,
    stderr: process.stderr,
    parallelism: availableParallelism(),
  });
}

if (
  process.argv[1] !== undefined
  && resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  await main();
}
