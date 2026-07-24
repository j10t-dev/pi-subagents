import { realpathSync } from "node:fs";
import { basename, resolve } from "node:path";

import type {
  AbsolutePath,
  DelegationDepth,
  ModelSpec,
  RunCapacity,
  ThinkingLevel,
  ToolName,
} from "./domain.ts";
import {
  CHILD_CAPACITY_ENV,
  CHILD_DEPTH_ENV,
  CHILD_MARKER_ENV,
  CHILD_MAX_DEPTH_ENV,
} from "./constants.ts";
import { absolutePath, isContainedPath } from "./paths.ts";

export interface PiInvocation { readonly command: AbsolutePath; readonly argsPrefix: readonly string[] }
export interface InvocationProcess { readonly execPath: string; readonly argv: readonly string[] }

export function resolvePiInvocation(source: InvocationProcess = process): PiInvocation {
  const command = absolutePath(source.execPath);
  const executable = basename(command).toLowerCase();
  if (executable === "node" || executable === "node.exe" || executable === "bun" || executable === "bun.exe") {
    const script = source.argv[1];
    if (script === undefined || script.length === 0 || !script.startsWith("/")) {
      throw new Error("launch_error: cannot resolve the same Pi entry point from the Node process");
    }
    return Object.freeze({ command, argsPrefix: Object.freeze([absolutePath(script)]) });
  }
  if ((executable === "pi" || executable === "pi.exe") && source.argv[0] !== undefined && resolve(source.argv[0]) === command) {
    return Object.freeze({ command, argsPrefix: Object.freeze([]) });
  }
  throw new Error("launch_error: cannot resolve the same Pi entry point; PATH fallback is forbidden");
}

export interface RpcLaunchSpec {
  readonly command: AbsolutePath;
  readonly args: readonly string[];
  readonly cwd: AbsolutePath;
  readonly env: Readonly<NodeJS.ProcessEnv>;
  readonly shell: false;
}

export interface BuildRpcLaunchOptions {
  readonly invocation?: PiInvocation;
  readonly cwd: AbsolutePath;
  readonly childSessionDir: AbsolutePath;
  readonly existingSession?: AbsolutePath;
  readonly effectiveTools: readonly ToolName[];
  readonly effectiveModel: ModelSpec;
  readonly effectiveThinking: ThinkingLevel;
  readonly childDepth: DelegationDepth;
  readonly maxDepth: DelegationDepth;
  readonly maxConcurrentRuns: RunCapacity;
  readonly trustedRoot?: AbsolutePath;
  readonly env?: NodeJS.ProcessEnv;
}

export function buildRpcLaunchSpec(options: BuildRpcLaunchOptions): RpcLaunchSpec {
  const invocation = options.invocation ?? resolvePiInvocation();
  const args = [
    ...invocation.argsPrefix,
    "--mode", "rpc",
    "--session-dir", options.childSessionDir,
    "--model", options.effectiveModel,
    "--thinking", options.effectiveThinking,
  ];
  if (options.effectiveTools.length === 0) args.push("--no-tools");
  else args.push("--tools", options.effectiveTools.join(","));
  if (options.existingSession !== undefined) args.push("--session", options.existingSession);
  if (isRealContained(options.trustedRoot, options.cwd)) args.push("--approve");
  const env = Object.freeze({
    ...(options.env ?? process.env),
    [CHILD_MARKER_ENV]: "1",
    [CHILD_DEPTH_ENV]: String(options.childDepth),
    [CHILD_MAX_DEPTH_ENV]: String(options.maxDepth),
    [CHILD_CAPACITY_ENV]: String(options.maxConcurrentRuns),
  });
  return Object.freeze({ command: invocation.command, args: Object.freeze(args), cwd: options.cwd, env, shell: false });
}

function isRealContained(parent: AbsolutePath | undefined, child: AbsolutePath): boolean {
  if (parent === undefined) return false;
  try { return isContainedPath(realpathSync(parent), realpathSync(child)); } catch { return false; }
}
