import { readFileSync } from "node:fs";
import { join } from "node:path";

import { CONFIG_DIR_NAME, getAgentDir, type ExtensionAPI, type ExtensionContext, type ExtensionFactory } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";

import { CHILD_MARKER_ENV } from "./src/constants.ts";
import { SubagentController } from "./src/controller.ts";
import { createProductionController } from "./src/pi-composition.ts";
import { loadSubagentSettings, readSubagentSettingsFiles, type SubagentSettingsResolved } from "./src/settings.ts";
import { receiveAgentSchema, sendInputSchema, spawnAgentSchema, stopAgentSchema, subagentToolSchemas, createSubagentTools, type SubagentToolName, type SubagentToolRegistry } from "./src/tools.ts";

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
    description: "Start a persistent child assignment asynchronously; collect completion with receive_agent.",
    parameters: spawnAgentSchema,
    promptSnippet: "Delegate a fresh persistent assignment with spawn_agent",
    promptGuidelines: [
      "When delegation is requested, call spawn_agent directly, then use receive_agent to collect completion.",
    ],
  },
  send_input: { label: "Send input", description: "Start a literal assignment on a stopped child agent.", parameters: sendInputSchema },
  receive_agent: { label: "Receive agent", description: "Receive ready completions and the complete owned-agent inventory.", parameters: receiveAgentSchema },
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

export interface PiSubagentsExtensionOptions {
  platform: string;
  nodeVersion?: string;
  child: boolean;
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
    if (options.child) return;

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
    registerSubagentTool(pi, "receive_agent", TOOL_SPECS.receive_agent, resolveCurrent, refreshAfterTool);
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

const extension = createPiSubagentsExtension({
  platform: process.platform,
  nodeVersion: process.versions.node,
  child: process.env[CHILD_MARKER_ENV] === "1",
  createController: (context, pi, refreshStatus) => {
    const agentDir = getAgentDir();
    const projectTrusted = context.isProjectTrusted();
    const texts = readSubagentSettingsFiles({
      agentDir,
      cwd: context.cwd,
      projectTrusted,
      configDirName: CONFIG_DIR_NAME,
      readOptional,
    });
    const loaded = loadSubagentSettings({
      ...texts,
      projectTrusted,
    });
    for (const message of loaded.diagnostics) context.ui.notify(message, "warning");
    const controller = createProductionController(
      context,
      pi,
      buildProductionControllerOptions(agentDir, loaded.value, refreshStatus),
    );
    // Built once per controller: `tools()` is called on every tool execution and every render.
    let registry: SubagentToolRegistry | undefined;
    return Object.assign(controller, { tools: () => (registry ??= createSubagentTools(controller)) });
  },
  diagnostic: (message) => { process.stderr.write(`${message}\n`); },
});

export default extension;

export function buildProductionControllerOptions(
  agentDir: string,
  settings: SubagentSettingsResolved,
  onStatusChange: () => void,
): Parameters<typeof createProductionController>[2] {
  return {
    capacity: settings.maxConcurrentRuns,
    stateRoot: join(agentDir, "pi-subagents"),
    ...(settings.cgroupRoot === undefined ? {} : { cgroupRoot: settings.cgroupRoot }),
    onStatusChange,
  };
}

function readOptional(path: string): string | undefined {
  try { return readFileSync(path, "utf8"); } catch { return undefined; }
}
