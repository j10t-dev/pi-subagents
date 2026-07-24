import { isAbsolute, join } from "node:path";

import { DEFAULT_MAX_CONCURRENT_RUNS, DEFAULT_MAX_DEPTH, MAX_MAX_DEPTH, MAX_TREE_CHILD_PROCESSES } from "./constants.ts";
import { boundedTreeChildCount, type DelegationLimits } from "./delegation-policy.ts";
import {
  delegationDepth,
  runCapacity,
  type AbsolutePath,
  type DelegationDepth,
  type RunCapacity,
} from "./domain.ts";
import { absolutePath } from "./paths.ts";

export interface SubagentSettingsResolved {
  maxConcurrentRuns: RunCapacity;
  maxDepth: DelegationDepth;
  cgroupRoot?: AbsolutePath;
}

export interface SubagentSettingsFileInput {
  agentDir: AbsolutePath;
  cwd: AbsolutePath;
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
  /** Managed descendants inherit limits and may not override them locally. */
  readonly inheritedLimits?: DelegationLimits;
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

  const inherited = options.inheritedLimits;
  let maxConcurrentRuns = inherited?.maxConcurrentRuns ??
    extractMaxConcurrentRuns(global, "global", diagnostics) ?? DEFAULT_MAX_CONCURRENT_RUNS;
  let maxDepth = inherited?.maxDepth ?? extractMaxDepth(global, "global", diagnostics) ?? DEFAULT_MAX_DEPTH;

  if (inherited === undefined) {
    const projectValue = extractMaxConcurrentRuns(project, "project", diagnostics);
    if (projectValue !== undefined) maxConcurrentRuns = projectValue;
    if (maxDepth > 1 && boundedTreeChildCount(maxConcurrentRuns, maxDepth) > MAX_TREE_CHILD_PROCESSES) {
      diagnostics.push(
        `subagents maxDepth ${maxDepth} with maxConcurrentRuns ${maxConcurrentRuns} allows more than 100 concurrent child processes; using maxDepth 1`,
      );
      maxDepth = delegationDepth(1);
    }
  }
  diagnoseProjectMaxDepth(project, diagnostics);

  const cgroupRoot = extractCgroupRoot(global, diagnostics);
  diagnoseProjectCgroupRoot(project, diagnostics);

  return {
    value: {
      maxConcurrentRuns,
      maxDepth,
      ...(cgroupRoot === undefined ? {} : { cgroupRoot }),
    },
    diagnostics,
  };
}

function extractCgroupRoot(
  subagents: Record<string, unknown> | undefined,
  diagnostics: string[],
): AbsolutePath | undefined {
  if (subagents === undefined || subagents.cgroupRoot === undefined) return undefined;
  const value = subagents.cgroupRoot;
  if (typeof value !== "string" || !isAbsolute(value) || value.includes("\0")) {
    diagnostics.push("global subagents.cgroupRoot must be an absolute path; ignoring");
    return undefined;
  }
  return absolutePath(value);
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

export function readGlobalMaxDepth(globalText: string | undefined): DelegationDepth {
  const diagnostics: string[] = [];
  const maxDepth = extractMaxDepth(readSubagents(globalText, "global", diagnostics), "global", diagnostics);
  return maxDepth ?? DEFAULT_MAX_DEPTH;
}

function extractMaxDepth(
  subagents: Record<string, unknown> | undefined,
  source: string,
  diagnostics: string[],
): DelegationDepth | undefined {
  if (subagents === undefined || subagents.maxDepth === undefined) return undefined;
  const maxDepth = subagents.maxDepth;
  if (
    typeof maxDepth !== "number" || !Number.isInteger(maxDepth) ||
    maxDepth < 0 || maxDepth > MAX_MAX_DEPTH
  ) {
    diagnostics.push(`${source} subagents.maxDepth must be an integer from 0 through 8; ignoring`);
    return undefined;
  }
  return delegationDepth(maxDepth);
}

function diagnoseProjectMaxDepth(
  subagents: Record<string, unknown> | undefined,
  diagnostics: string[],
): void {
  if (subagents?.maxDepth !== undefined) {
    diagnostics.push("project subagents.maxDepth is global-only; ignoring");
  }
}

function extractMaxConcurrentRuns(
  subagents: Record<string, unknown> | undefined,
  source: string,
  diagnostics: string[],
): RunCapacity | undefined {
  if (subagents === undefined) return undefined;

  const maxConcurrentRuns = subagents.maxConcurrentRuns;
  if (maxConcurrentRuns === undefined) {
    return undefined;
  }
  if (
    typeof maxConcurrentRuns !== "number" ||
    !Number.isSafeInteger(maxConcurrentRuns) ||
    maxConcurrentRuns < 1
  ) {
    diagnostics.push(
      `${source} subagents.maxConcurrentRuns must be a positive safe integer; ignoring`,
    );
    return undefined;
  }

  return runCapacity(maxConcurrentRuns);
}
