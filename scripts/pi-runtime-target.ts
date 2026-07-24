import { spawnSync } from "node:child_process";

import type { Brand } from "../src/domain.ts";

export type PiExecutable = Brand<"pi", "GlobalPiExecutable">;
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

const GLOBAL_PI = "pi" as PiExecutable;

const defaultProbe: PiVersionProbe = {
  run() {
    const result = spawnSync(GLOBAL_PI, ["--version"], {
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

export function detectGlobalPi(probe: PiVersionProbe = defaultProbe): PiRuntimeTarget {
  const result = probe.run();
  if (result.error !== undefined) {
    throw new Error(`cannot detect global Pi: ${result.error.message}`, { cause: result.error });
  }
  if (result.status === null) {
    throw new Error(`cannot detect global Pi: timed out or was terminated by ${result.signal ?? "an unknown signal"}`);
  }
  if (result.status !== 0) {
    const detail = result.stderr.trim();
    throw new Error(`cannot detect global Pi: exited with status ${result.status}${detail === "" ? "" : `: ${detail}`}`);
  }
  const reported = result.stdout.trim();
  if (reported === "") throw new Error("cannot detect global Pi: returned an empty version");
  return Object.freeze({ executable: GLOBAL_PI, detectedVersion: reported as DetectedPiVersion });
}
