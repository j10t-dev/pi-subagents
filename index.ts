import { readFileSync } from "node:fs";
import { join } from "node:path";

import { CONFIG_DIR_NAME, getAgentDir, type ExtensionAPI, type ExtensionContext, type ExtensionFactory } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";

import { canDelegateFrom, parseExtensionLaunchContext, type DelegationLimits } from "./src/delegation-policy.ts";
import { SubagentController } from "./src/controller.ts";
import { delegationDepth, type AbsolutePath, type DelegationDepth } from "./src/domain.ts";
import { createProductionController } from "./src/pi-composition.ts";
import { absolutePath } from "./src/paths.ts";
import { loadSubagentSettings, readGlobalMaxDepth, readSubagentSettingsFiles, type SubagentSettingsResolved } from "./src/settings.ts";
import { awaitAgentSchema, sendInputSchema, spawnAgentSchema, stopAgentSchema, subagentToolSchemas, createSubagentTools, type SubagentToolName, type SubagentToolRegistry } from "./src/tools.ts";

const STATUS_KEY = "pi-subagents";
type ToolRegistrationSpec<K extends SubagentToolName> = {
  readonly label: string;
  readonly description: string;
  readonly parameters: (typeof subagentToolSchemas)[K];
  readonly promptSnippet?: string;
  readonly promptGuidelines?: readonly string[];
};

type ToolRegistrationSpecs = {
  readonly [K in SubagentToolName]: ToolRegistrationSpec<K>;
};

const TOOL_SPECS = {
  spawn_agent: {
    label: "Spawn agent",
    description: "Start a persistent child assignment asynchronously; collect completion with await_agent.",
    parameters: spawnAgentSchema,
    promptSnippet: "Delegate a fresh persistent assignment with spawn_agent",
    promptGuidelines: [
      "When delegation is requested, call spawn_agent directly, then use await_agent to collect completion.",
    ],
  },
  send_input: { label: "Send input", description: "Start a literal assignment on a stopped child agent.", parameters: sendInputSchema },
  await_agent: { label: "Await agent", description: "Await one ready completion and page the owned-agent inventory.", parameters: awaitAgentSchema },
  stop_agent: { label: "Stop agent", description: "Stop one or more owned child agents.", parameters: stopAgentSchema },
} satisfies ToolRegistrationSpecs;

export interface ExtensionController {
  restore(): Promise<void>;
  shutdown(): Promise<void>;
  status(): string;
  tools(): SubagentToolRegistry;
  beforeTree?(): boolean;
  beforeSwitch?(): boolean;
  beforeFork?(): boolean;
}

export type ExtensionRegistration =
  | { readonly enabled: true }
  | { readonly enabled: false; readonly diagnostic?: string };

export interface PiSubagentsExtensionOptions {
  platform: string;
  nodeVersion?: string;
  registration: ExtensionRegistration;
  createController(context: ExtensionContext, api: ExtensionAPI, refreshStatus: () => void): ExtensionController;
  diagnostic(message: string): void;
}

export function createPiSubagentsExtension(options: PiSubagentsExtensionOptions): ExtensionFactory {
  return (pi) => {
    const nodeVersion = options.nodeVersion ?? process.versions.node;
    if (options.platform !== "linux" || !supportedNode(nodeVersion)) {
      options.diagnostic(
        `pi-subagents disabled: requires Linux and Node 22.19 or newer; found ${options.platform} and Node ${nodeVersion}`.slice(0, 500),
      );
      return;
    }
    if (!options.registration.enabled) {
      const diagnostic = options.registration.diagnostic;
      if (diagnostic !== undefined) {
        options.diagnostic(diagnostic);
        pi.on("session_start", (_event, context) => { context.ui.notify(diagnostic, "warning"); });
      }
      return;
    }

    let current: ExtensionController | undefined;
    let activeContext: ExtensionContext | undefined;
    let closing: Promise<void> | undefined;
    let lifecycleTail = Promise.resolve();

    // Bound to the controller that actually executed: a tool call can outlive its session
    // (shutdown, or a replacing session_start), and neither case may destroy the result or
    // publish status from a controller that is no longer current.
    const refreshAfterTool = (owner: ExtensionController): void => {
      if (current === owner) activeContext?.ui.setStatus(STATUS_KEY, owner.status());
    };
    const resolveCurrent = (): ExtensionController | undefined => current;
    registerSubagentTool(pi, "spawn_agent", TOOL_SPECS.spawn_agent, resolveCurrent, refreshAfterTool);
    registerSubagentTool(pi, "send_input", TOOL_SPECS.send_input, resolveCurrent, refreshAfterTool);
    registerSubagentTool(pi, "await_agent", TOOL_SPECS.await_agent, resolveCurrent, refreshAfterTool);
    registerSubagentTool(pi, "stop_agent", TOOL_SPECS.stop_agent, resolveCurrent, refreshAfterTool);

    pi.on("session_start", (_event, context) => serialiseLifecycle(async () => {
      if (current !== undefined) await closeCurrent();
      let controller!: ExtensionController;
      const refreshStatus = (): void => {
        if (current === controller && activeContext === context) context.ui.setStatus(STATUS_KEY, controller.status());
      };
      controller = options.createController(context, pi, refreshStatus);
      current = controller;
      activeContext = context;
      await controller.restore();
      context.ui.setStatus(STATUS_KEY, controller.status());
    }));
    pi.on("session_before_tree", () => ({ cancel: current?.beforeTree?.() === false }));
    pi.on("session_before_switch", () => { current?.beforeSwitch?.(); });
    pi.on("session_before_fork", () => { current?.beforeFork?.(); });
    pi.on("session_shutdown", (_event, context) => serialiseLifecycle(async () => {
      await closeCurrent();
      context.ui.setStatus(STATUS_KEY, undefined);
    }));

    function serialiseLifecycle(operation: () => Promise<void>): Promise<void> {
      const result = lifecycleTail.catch(() => undefined).then(operation);
      lifecycleTail = result.catch(() => undefined);
      return result;
    }

    async function closeCurrent(): Promise<void> {
      if (closing !== undefined) return closing;
      const owned = current;
      if (owned === undefined) return;
      const ownedContext = activeContext;
      const operation = owned.shutdown().then(() => {
        if (current === owned) current = undefined;
        if (activeContext === ownedContext) activeContext = undefined;
      }).finally(() => { if (closing === operation) closing = undefined; });
      closing = operation;
      return closing;
    }
  };
}

function registerSubagentTool<K extends SubagentToolName>(
  pi: ExtensionAPI,
  name: K,
  spec: ToolRegistrationSpec<K>,
  resolveController: () => ExtensionController | undefined,
  afterExecute: (owner: ExtensionController) => void,
): void {
  pi.registerTool({
    name,
    label: spec.label,
    description: spec.description,
    parameters: spec.parameters,
    ...(spec.promptSnippet === undefined ? {} : { promptSnippet: spec.promptSnippet }),
    ...(spec.promptGuidelines === undefined ? {} : { promptGuidelines: [...spec.promptGuidelines] }),
    execute: async (_toolCallId, input, signal) => {
      const owner = requireController(resolveController());
      const result = await owner.tools()[name].execute(input, signal);
      afterExecute(owner);
      return { content: [{ type: "text", text: result.content }], details: result.details };
    },
    renderCall: () => new Text(spec.label, 0, 0),
    renderResult: (result) => {
      const text = resolveController()?.tools()[name].renderResult?.(recordDetails(result.details)) ?? compactResult(result.details);
      return new Text(text, 0, 0);
    },
  });
}

function supportedNode(value: string): boolean {
  const match = /^(\d+)\.(\d+)\.(\d+)/.exec(value);
  if (match === null) return false;
  const major = Number(match[1]); const minor = Number(match[2]);
  return major > 22 || major === 22 && minor >= 19;
}

function requireController(value: ExtensionController | undefined): ExtensionController {
  if (value === undefined) throw new Error("session_unavailable: subagent session has not started");
  return value;
}

function recordDetails(value: object | undefined): object {
  return value ?? {};
}

function compactResult(value: object | undefined): string {
  const text = JSON.stringify(value ?? {});
  return text.length <= 500 ? text : `${text.slice(0, 497)}...`;
}

const launchContext = parseExtensionLaunchContext(process.env);
const defaultAgentDir = absolutePath(getAgentDir());
const defaultRootMaxDepth = readGlobalMaxDepth(readOptional(join(defaultAgentDir, "settings.json")));
const defaultRegistration = registrationForLaunchContext(launchContext, defaultRootMaxDepth);

const extension = createPiSubagentsExtension({
  platform: process.platform,
  nodeVersion: process.versions.node,
  registration: defaultRegistration,
  createController: (context, pi, refreshStatus) => {
    const agentDir = absolutePath(getAgentDir());
    const cwd = absolutePath(context.cwd);
    const currentDepth = launchContext.kind === "descendant" ? launchContext.currentDepth : delegationDepth(0);
    const inheritedLimits: DelegationLimits | undefined =
      launchContext.kind === "descendant" ? launchContext.limits : undefined;
    const projectTrusted = context.isProjectTrusted();
    const texts = readSubagentSettingsFiles({
      agentDir,
      cwd,
      projectTrusted,
      configDirName: CONFIG_DIR_NAME,
      readOptional,
    });
    const loaded = loadSubagentSettings({
      ...texts,
      projectTrusted,
      ...(inheritedLimits === undefined ? {} : { inheritedLimits }),
    });
    for (const message of loaded.diagnostics) context.ui.notify(message, "warning");
    const controller = createProductionController(
      context,
      pi,
      buildProductionControllerOptions(agentDir, loaded.value, currentDepth, refreshStatus),
    );
    // Built once per controller: `tools()` is called on every tool execution and every render.
    let registry: SubagentToolRegistry | undefined;
    return Object.assign(controller, { tools: () => (registry ??= createSubagentTools(controller)) });
  },
  diagnostic: (message) => { process.stderr.write(`${message}\n`); },
});

export default extension;

export function buildProductionControllerOptions(
  agentDir: AbsolutePath,
  settings: SubagentSettingsResolved,
  currentDepth: DelegationDepth,
  onStatusChange: () => void,
): Parameters<typeof createProductionController>[2] {
  return {
    capacity: settings.maxConcurrentRuns,
    currentDepth,
    maxDepth: settings.maxDepth,
    stateRoot: absolutePath(join(agentDir, "pi-subagents")),
    ...(currentDepth === 0 && settings.cgroupRoot !== undefined
      ? { cgroupRoot: settings.cgroupRoot }
      : {}),
    onStatusChange,
  };
}

export function registrationForLaunchContext(
  context: ReturnType<typeof parseExtensionLaunchContext>,
  rootMaxDepth: DelegationDepth,
): ExtensionRegistration {
  if (context.kind === "invalid") return { enabled: false, diagnostic: context.diagnostic };
  if (context.kind === "legacy-child") return { enabled: false };
  if (context.kind === "descendant") {
    return canDelegateFrom(context.currentDepth, context.limits.maxDepth)
      ? { enabled: true }
      : { enabled: false };
  }
  return canDelegateFrom(context.currentDepth, rootMaxDepth) ? { enabled: true } : { enabled: false };
}

function readOptional(path: string): string | undefined {
  try { return readFileSync(path, "utf8"); } catch { return undefined; }
}
