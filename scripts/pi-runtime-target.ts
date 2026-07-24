import { spawnSync } from "node:child_process";

import type { Brand } from "../src/domain.ts";

export type PiExecutable = Brand<string, "PiExecutable">;
export type DetectedPiVersion = Brand<string, "DetectedPiVersion">;

export interface PiRuntimeTarget {
  readonly executable: PiExecutable;
  readonly detectedVersion: DetectedPiVersion;
}

export interface PiVersionProbeResult {
  readonly status: number | null;
  readonly stdout: string;
  readonly stderr: string;
  readonly signal?: NodeJS.Signals | undefined;
  readonly error?: Error | undefined;
}

export interface PiVersionProbe {
  run(): PiVersionProbeResult;
}

const GLOBAL_PI = piExecutable("pi");

export function piExecutable(value: string): PiExecutable {
  if (value.length === 0 || value.includes("\0")) {
    throw new Error("invalid_input: Pi executable must be non-empty and contain no NUL");
  }
  return value as PiExecutable;
}

export function detectedPiVersion(value: string): DetectedPiVersion {
  if (value.length === 0 || value.includes("\0")) {
    throw new Error("invalid_input: detected Pi version must be non-empty and contain no NUL");
  }
  return value as DetectedPiVersion;
}

function executableProbe(executable: PiExecutable): PiVersionProbe {
  return {
    run() {
      const result = spawnSync(executable, ["--version"], {
        encoding: "utf-8",
        timeout: 15_000,
      });
      return {
        status: result.status,
        stdout: result.stdout ?? "",
        stderr: result.stderr ?? "",
        signal: result.signal ?? undefined,
        error: result.error,
      };
    },
  };
}

export function detectGlobalPi(probe: PiVersionProbe = executableProbe(GLOBAL_PI)): PiRuntimeTarget {
  return detectPiRuntime(GLOBAL_PI, probe, "global Pi");
}

export function detectPiRuntime(
  executable: PiExecutable,
  probe: PiVersionProbe = executableProbe(executable),
  label = "Pi runtime",
): PiRuntimeTarget {
  const result = probe.run();
  if (result.error !== undefined) {
    throw new Error(`cannot detect ${label}: ${result.error.message}`, { cause: result.error });
  }
  if (result.status === null) {
    throw new Error(`cannot detect ${label}: timed out or was terminated by ${result.signal ?? "an unknown signal"}`);
  }
  if (result.status !== 0) {
    const detail = result.stderr.trim();
    throw new Error(`cannot detect ${label}: exited with status ${result.status}${detail === "" ? "" : `: ${detail}`}`);
  }
  const reported = result.stdout.trim();
  if (reported === "") throw new Error(`cannot detect ${label}: returned an empty version`);
  return Object.freeze({ executable, detectedVersion: detectedPiVersion(reported) });
}
