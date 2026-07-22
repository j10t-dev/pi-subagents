import { spawn, type SpawnOptions } from "node:child_process";
import { availableParallelism } from "node:os";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  BoundedTestOutput,
  formatTestGroupOutput,
  type CaptureLimits,
} from "./bounded-test-output.ts";
import {
  discoverTestFiles,
  groupTestFiles,
  parseRequestedGroups,
  selectTestGroups,
  type TestGroup,
} from "./test-groups.ts";

export interface TestGroupProcess {
  readonly stdout: NodeJS.ReadableStream | null;
  readonly stderr: NodeJS.ReadableStream | null;
  once(event: "spawn", listener: () => void): this;
  once(event: "error", listener: (error: Error) => void): this;
  once(
    event: "exit",
    listener: (code: number | null, signal: NodeJS.Signals | null) => void,
  ): this;
  kill(signal?: NodeJS.Signals): boolean;
}

export interface RunnerDependencies {
  readonly spawn: (
    command: string,
    args: readonly string[],
    options: SpawnOptions,
  ) => TestGroupProcess;
  readonly stdout: Pick<NodeJS.WriteStream, "write">;
  readonly parallelism: number;
  readonly captureLimits?: CaptureLimits;
}

export async function runTestGroups(
  groups: readonly TestGroup[],
  run: (group: TestGroup) => Promise<number>,
): Promise<number> {
  const runnable = groups.filter((group) => group.files.length > 0);
  const executions = runnable.map((group) => {
    try {
      return Promise.resolve(run(group));
    } catch (error) {
      return Promise.reject(error);
    }
  });
  const results = await Promise.allSettled(executions);
  const rejected = results.find((result) => result.status === "rejected");
  if (rejected !== undefined) throw rejected.reason;
  const failed = results
    .flatMap((result) => result.status === "fulfilled" ? [result.value] : [])
    .find((exitCode) => exitCode !== 0);
  return failed ?? 0;
}

export async function runSelectedTestGroups(
  root: string,
  groups: readonly TestGroup[],
  dependencies: RunnerDependencies,
): Promise<number> {
  const runnable = groups.filter((group) => group.files.length > 0);
  const concurrent = runnable.length >= 2;
  return runTestGroups(
    runnable,
    (group) => spawnGroup(root, group, concurrent, dependencies),
  );
}

export function integrationConcurrency(parallelism: number): number {
  if (!Number.isInteger(parallelism) || parallelism < 1) {
    throw new TypeError("available parallelism must be a positive integer");
  }
  return Math.min(12, Math.max(1, parallelism - 4));
}

export function testCommandArguments(group: TestGroup, parallelism: number): string[] {
  return [
    "test",
    ...group.files,
    "--timeout",
    "30000",
    ...(group.name === "integration"
      ? ["--concurrent", "--max-concurrency", String(integrationConcurrency(parallelism))]
      : []),
  ];
}

export function spawnGroup(
  root: string,
  group: TestGroup,
  concurrent: boolean,
  dependencies: RunnerDependencies,
): Promise<number> {
  if (!concurrent) return spawnInheritedGroup(root, group, dependencies);
  return spawnCapturedGroup(root, group, dependencies);
}

function spawnInheritedGroup(
  root: string,
  group: TestGroup,
  dependencies: RunnerDependencies,
): Promise<number> {
  return new Promise((resolveExit, reject) => {
    const child = dependencies.spawn(
      process.execPath,
      testCommandArguments(group, dependencies.parallelism),
      { cwd: root, stdio: "inherit", env: process.env },
    );
    child.once("error", reject);
    child.once("exit", (code, signal) => resolveExit(signal === null ? code ?? 1 : 1));
  });
}

function spawnCapturedGroup(
  root: string,
  group: TestGroup,
  dependencies: RunnerDependencies,
): Promise<number> {
  return new Promise((resolveExit, reject) => {
    const stdout = new BoundedTestOutput(dependencies.captureLimits);
    const stderr = new BoundedTestOutput(dependencies.captureLimits);
    dependencies.stdout.write(`starting test group ${group.name}\n`);
    const child = dependencies.spawn(
      process.execPath,
      testCommandArguments(group, dependencies.parallelism),
      {
        cwd: root,
        stdio: ["inherit", "pipe", "pipe"],
        env: { ...process.env, FORCE_COLOR: "0" },
      },
    );

    let spawned = false;
    let exitOccurred = false;
    let exitCode: number | null = null;
    let exitSignal: NodeJS.Signals | null = null;
    let stdoutSettled = child.stdout === null;
    let stderrSettled = child.stderr === null;
    let failure: Error | undefined;
    let captureDiagnostic: string | undefined;
    let killRequested = false;
    let finalised = false;

    const finalise = (): void => {
      if (finalised || !exitOccurred || !stdoutSettled || !stderrSettled) return;
      finalised = true;
      const block = formatTestGroupOutput(
        group.name,
        stdout,
        stderr,
        exitSignal === null ? undefined : exitSignal,
        captureDiagnostic,
      );
      dependencies.stdout.write(block);
      if (failure !== undefined) {
        reject(failure);
        return;
      }
      resolveExit(exitSignal === null ? exitCode ?? 1 : 1);
    };

    const captureFailed = (error: Error): void => {
      if (failure === undefined) {
        failure = error;
        captureDiagnostic = `test group capture failed: ${error.message}\n`;
      }
      if (!exitOccurred && !killRequested) {
        killRequested = true;
        child.kill("SIGTERM");
      }
    };

    const observeStream = (
      stream: NodeJS.ReadableStream | null,
      output: BoundedTestOutput,
      settle: () => void,
    ): void => {
      if (stream === null) return;
      let streamSettled = false;
      const settleOnce = (): void => {
        if (streamSettled) return;
        streamSettled = true;
        settle();
        finalise();
      };
      stream.on("data", (chunk: string | Uint8Array) => {
        output.append(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      });
      stream.once("error", (error: Error) => {
        captureFailed(error);
        settleOnce();
      });
      stream.once("end", settleOnce);
      stream.once("close", settleOnce);
    };

    observeStream(child.stdout, stdout, () => { stdoutSettled = true; });
    observeStream(child.stderr, stderr, () => { stderrSettled = true; });

    child.once("spawn", () => {
      spawned = true;
    });
    child.once("error", (error) => {
      if (failure === undefined) failure = error;
      if (spawned) return;
      exitOccurred = true;
      stdoutSettled = true;
      stderrSettled = true;
      finalise();
    });
    child.once("exit", (code, signal) => {
      exitOccurred = true;
      exitCode = code;
      exitSignal = signal;
      finalise();
    });
  });
}

async function main(): Promise<void> {
  const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
  const groups = groupTestFiles(discoverTestFiles(root));
  const requested = parseRequestedGroups(process.argv.slice(2));
  const selected = selectTestGroups(groups, requested);
  const parallelism = availableParallelism();
  process.exitCode = await runSelectedTestGroups(root, selected, {
    spawn: (command, args, options) => spawn(command, args, options),
    stdout: process.stdout,
    parallelism,
  });
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main();
}
