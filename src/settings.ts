import { isAbsolute, join } from "node:path";

import { DEFAULT_MAX_CONCURRENT_RUNS } from "./constants.ts";

export interface SubagentSettingsResolved {
  maxConcurrentRuns: number;
  cgroupRoot?: string;
}

export interface SubagentSettingsFileInput {
  agentDir: string;
  cwd: string;
  projectTrusted: boolean;
  configDirName: string;
  readOptional(path: string): string | undefined;
}

export function readSubagentSettingsFiles(input: SubagentSettingsFileInput): {
  globalText?: string;
  projectText?: string;
} {
  const globalText = input.readOptional(join(input.agentDir, "settings.json"));
  const projectText = input.projectTrusted
    ? input.readOptional(join(input.cwd, input.configDirName, "settings.json"))
    : undefined;
  return {
    ...(globalText === undefined ? {} : { globalText }),
    ...(projectText === undefined ? {} : { projectText }),
  };
}

export interface LoadSubagentSettingsOptions {
  /** Raw text of the global settings file, if one exists. */
  globalText?: string;
  /**
   * Raw text of the project settings file, if one exists. Never read unless `projectTrusted`
   * is `true` — an untrusted project's settings must have no effect on this process.
   */
  projectText?: string;
  projectTrusted: boolean;
}

export interface LoadSubagentSettingsResult {
  value: SubagentSettingsResolved;
  diagnostics: string[];
}

/**
 * Resolves subagent settings from optional global/project JSON documents. The project document
 * is consulted only when `projectTrusted` is `true`, and only overrides fields it validly
 * specifies; malformed or out-of-range values fall back to the next-lower-precedence source and
 * emit a bounded diagnostic rather than throwing.
 */
export function loadSubagentSettings(
  options: LoadSubagentSettingsOptions,
): LoadSubagentSettingsResult {
  const diagnostics: string[] = [];

  const global = readSubagents(options.globalText, "global", diagnostics);
  const project = options.projectTrusted
    ? readSubagents(options.projectText, "project", diagnostics)
    : undefined;

  let maxConcurrentRuns =
    extractMaxConcurrentRuns(global, "global", diagnostics) ??
    DEFAULT_MAX_CONCURRENT_RUNS;

  const projectValue = extractMaxConcurrentRuns(project, "project", diagnostics);
  if (projectValue !== undefined) {
    maxConcurrentRuns = projectValue;
  }

  const cgroupRoot = extractCgroupRoot(global, diagnostics);
  diagnoseProjectCgroupRoot(project, diagnostics);

  return {
    value: {
      maxConcurrentRuns,
      ...(cgroupRoot === undefined ? {} : { cgroupRoot }),
    },
    diagnostics,
  };
}

function extractCgroupRoot(
  subagents: Record<string, unknown> | undefined,
  diagnostics: string[],
): string | undefined {
  if (subagents === undefined || subagents.cgroupRoot === undefined) return undefined;
  const value = subagents.cgroupRoot;
  if (typeof value !== "string" || !isAbsolute(value) || value.includes("\0")) {
    diagnostics.push("global subagents.cgroupRoot must be an absolute path; ignoring");
    return undefined;
  }
  return value;
}

function diagnoseProjectCgroupRoot(
  subagents: Record<string, unknown> | undefined,
  diagnostics: string[],
): void {
  if (subagents?.cgroupRoot !== undefined) {
    diagnostics.push("project subagents.cgroupRoot is global-only; ignoring");
  }
}

function readSubagents(
  text: string | undefined,
  source: string,
  diagnostics: string[],
): Record<string, unknown> | undefined {
  if (text === undefined) return undefined;

  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    diagnostics.push(`${source} subagents settings file is not valid JSON; ignoring`);
    return undefined;
  }
  if (typeof json !== "object" || json === null) {
    diagnostics.push(`${source} subagents settings file must be a JSON object; ignoring`);
    return undefined;
  }
  const subagents = (json as Record<string, unknown>).subagents;
  if (subagents === undefined) return undefined;
  if (typeof subagents !== "object" || subagents === null) {
    diagnostics.push(`${source} "subagents" must be an object; ignoring`);
    return undefined;
  }
  return subagents as Record<string, unknown>;
}

function extractMaxConcurrentRuns(
  subagents: Record<string, unknown> | undefined,
  source: string,
  diagnostics: string[],
): number | undefined {
  if (subagents === undefined) return undefined;

  const maxConcurrentRuns = subagents.maxConcurrentRuns;
  if (maxConcurrentRuns === undefined) {
    return undefined;
  }
  if (
    typeof maxConcurrentRuns !== "number" ||
    !Number.isInteger(maxConcurrentRuns) ||
    maxConcurrentRuns < 1
  ) {
    diagnostics.push(
      `${source} subagents.maxConcurrentRuns must be a positive integer; ignoring`,
    );
    return undefined;
  }

  return maxConcurrentRuns;
}
