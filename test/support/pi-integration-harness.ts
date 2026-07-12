import { execFileSync } from "node:child_process";
import { realpathSync } from "node:fs";
import { isAbsolute } from "node:path";

export interface ParentPiEnvironmentInput {
  readonly agentDir: string;
  readonly home: string;
  readonly childLaunchDir?: string;
  readonly base?: NodeJS.ProcessEnv;
  readonly extra?: Readonly<NodeJS.ProcessEnv>;
}

export interface IntegrationCliRuntime {
  resolveOnPath(): string;
  canonicalise(path: string): string;
  version(path: string): string;
  write(message: string): void;
}

const SYSTEM_RUNTIME: IntegrationCliRuntime = {
  resolveOnPath: () => execFileSync("sh", ["-c", "command -v pi"], { encoding: "utf8" }),
  canonicalise: (path) => realpathSync(path),
  version: (path) => execFileSync(path, ["--version"], { encoding: "utf8" }),
  write: (message) => { process.stdout.write(message); },
};

export function createParentPiEnvironment(input: ParentPiEnvironmentInput): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = {
    ...(input.base ?? process.env),
    ...input.extra,
    PI_CODING_AGENT_DIR: input.agentDir,
    HOME: input.home,
    MOCK_PROVIDER_NO_NETWORK: "1",
  };
  delete environment.PI_SUBAGENT_CHILD;
  if (input.childLaunchDir === undefined) delete environment.MOCK_PROVIDER_CHILD_LAUNCH_DIR;
  else environment.MOCK_PROVIDER_CHILD_LAUNCH_DIR = input.childLaunchDir;
  return environment;
}

/**
 * Adapts a parent environment for Pi's public RpcClient. Its `Record<string, string>`
 * type cannot express Node's supported undefined tombstone for removing an inherited
 * variable, so this test-only assertion is deliberately confined to this boundary.
 */
export function adaptParentPiEnvironmentForRpcClient(environment: NodeJS.ProcessEnv): Record<string, string> {
  return { ...environment, PI_SUBAGENT_CHILD: undefined } as unknown as Record<string, string>;
}

export function resolveIntegrationCli(
  environment: NodeJS.ProcessEnv = process.env,
  runtime: IntegrationCliRuntime = SYSTEM_RUNTIME,
): string {
  const explicit = environment.PI_INTEGRATION_CLI;
  if (explicit !== undefined) {
    if (!isAbsolute(explicit)) throw new Error("PI_INTEGRATION_CLI must be an absolute path");
    return runtime.canonicalise(explicit);
  }
  if (environment.CI !== undefined) throw new Error("CI requires PI_INTEGRATION_CLI");

  const located = runtime.resolveOnPath().trim();
  if (!isAbsolute(located)) throw new Error("local integration requires an absolute pi executable on PATH");
  return runtime.canonicalise(located);
}

export function reportIntegrationCli(
  executable: string,
  runtime: IntegrationCliRuntime = SYSTEM_RUNTIME,
): void {
  const version = runtime.version(executable).trim();
  if (version.length === 0) throw new Error("selected integration Pi returned an empty --version");
  runtime.write(`pi integration executable: ${executable}\npi integration version: ${version}\n`);
}
