import { readFileSync } from "node:fs";
import { join } from "node:path";

import { CONFIG_DIR_NAME, getAgentDir, type ExtensionAPI, type ExtensionContext, type ExtensionFactory } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";

import { CHILD_MARKER_ENV } from "./src/constants.ts";
import { SubagentController } from "./src/controller.ts";
import { createProductionController } from "./src/pi-composition.ts";
import { loadSubagentSettings, readSubagentSettingsFiles, type SubagentSettingsResolved } from "./src/settings.ts";
import { receiveAgentSchema, sendInputSchema, spawnAgentSchema, stopAgentSchema, createSubagentTools, type SubagentTool } from "./src/tools.ts";

const STATUS_KEY = "pi-subagents";
const TOOL_SPECS = [
  [
    "spawn_agent",
    "Spawn agent",
    "Start a persistent child assignment asynchronously; collect completion with receive_agent.",
    spawnAgentSchema,
    "Delegate a fresh persistent assignment with spawn_agent",
    ["When delegation is requested, call spawn_agent directly, then use receive_agent to collect completion."],
  ],
  ["send_input", "Send input", "Start a literal assignment on a stopped child agent.", sendInputSchema],
  ["receive_agent", "Receive agent", "Receive ready completions and the complete owned-agent inventory.", receiveAgentSchema],
  ["stop_agent", "Stop agent", "Stop one or more owned child agents.", stopAgentSchema],
] as const;

export interface ExtensionController {
  restore(): Promise<void>;
  shutdown(): Promise<void>;
  status(): string;
  tools(): readonly SubagentTool[];
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

    for (const [name, label, description, parameters, promptSnippet, promptGuidelines] of TOOL_SPECS) {
      pi.registerTool({
        name,
        label,
        description,
        parameters,
        ...(promptSnippet === undefined ? {} : { promptSnippet }),
        ...(promptGuidelines === undefined ? {} : { promptGuidelines: [...promptGuidelines] }),
        execute: async (_toolCallId, input, signal) => {
          const controller = requireController(current);
          const implementation = controller.tools().find((candidate) => candidate.name === name);
          if (implementation === undefined) throw new Error(`internal_error: missing ${name} implementation`);
          const result = await implementation.execute(input, signal);
          activeContext?.ui.setStatus(STATUS_KEY, controller.status());
          return { content: [{ type: "text", text: result.content }], details: result.details };
        },
        renderCall: () => new Text(label, 0, 0),
        renderResult: (result) => {
          const implementation = current?.tools().find((candidate) => candidate.name === name);
          const text = implementation?.renderResult?.(recordDetails(result.details)) ?? compactResult(result.details);
          return new Text(text, 0, 0);
        },
      });
    }

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
    return Object.assign(controller, { tools: () => createSubagentTools(controller) });
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
