import { appendFileSync, existsSync, readFileSync } from "node:fs";

import * as PiRuntime from "@earendil-works/pi-coding-agent";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

import type {
  AgentRow,
  AgentWidgetSnapshot,
  AgentWidgetSource,
  SelectedTranscriptSnapshot,
  SelectedTranscriptSource,
  SubagentObservationPort,
  TranscriptItem,
} from "../src/agent-observation.ts";
import {
  contextLabel,
  deriveModelLabel,
  deriveTaskLabel,
  toolDisplayName,
  transcriptText,
  type TaskLabelContext,
} from "../src/agent-observation.ts";
import createAgentWidgetExtension from "../src/agent-widget/extension.ts";
import {
  AgentState,
  agentCount,
  agentDepth,
  agentObservationRevision,
  agentOrdinal,
  agentWidgetRevision,
  modelSpec,
  runId,
  selectedTranscriptRevision,
  transcriptAssistantGroup,
  transcriptRevision,
  transcriptSequence,
  type BoundedTranscriptJson,
} from "../src/domain.ts";
import { NATIVE_BUILT_IN_TOOL_NAMES } from "../src/agent-widget/conversation-projection.ts";
import { absolutePath, widgetGateTracePath } from "../src/paths.ts";
import { admitBoundedTranscriptJson } from "../src/schemas.ts";
import { publishObservationPort } from "../src/observation-registry.ts";

export const CHILD_GATE_EDITOR_TEXT = "child-gate-draft";
export const CHILD_GATE_NATIVE_USER_TEXT = "CHILD_GATE_NATIVE_USER";
export const CHILD_GATE_NATIVE_ASSISTANT_TEXT = "CHILD_GATE_NATIVE_ASSISTANT";
export const CHILD_GATE_BUILTIN_SUMMARY = "CHILD_GATE_BUILTIN_RESULT";
export const CHILD_GATE_TOOL_PREVIEW = "CHILD_GATE_TOOL_PREVIEW";
export const CHILD_GATE_OVERRIDE_SECRET = "CHILD_GATE_OVERSIZED_ARGUMENT_MUST_NOT_RENDER";

const taskContext: TaskLabelContext = {
  knownAgentIds: new Set(),
  knownRunIds: new Set(),
  knownInternalPaths: new Set(),
};
const model = deriveModelLabel(modelSpec("fixture/fixture"), "high");
const context = contextLabel({ kind: "unavailable" });
const rows: readonly AgentRow[] = Object.freeze([
  Object.freeze({
    ordinal: agentOrdinal("A1"),
    depth: agentDepth(0),
    model,
    context,
    taskLabel: deriveTaskLabel("Direct gate child", taskContext),
    state: AgentState.Running,
  }),
  Object.freeze({
    ordinal: agentOrdinal("A1.2"),
    depth: agentDepth(1),
    model,
    context,
    taskLabel: deriveTaskLabel("Nested gate child", taskContext),
    state: AgentState.Running,
  }),
]);

const widgetSnapshot: AgentWidgetSnapshot = Object.freeze({
  revision: agentWidgetRevision(1),
  rows,
  total: agentCount(rows.length),
  omitted: agentCount(0),
  degraded: false,
});

function selected(row: AgentRow): SelectedTranscriptSnapshot {
  const nativeRun = runId("11111111");
  const fixtureCwd = process.cwd();
  const items: TranscriptItem[] = [
    { sequence: transcriptSequence(0), runId: nativeRun, kind: "user", text: transcriptText(`${CHILD_GATE_NATIVE_USER_TEXT} **Markdown**`) },
    {
      sequence: transcriptSequence(1), runId: nativeRun, kind: "assistant", group: transcriptAssistantGroup(0), phase: "final", stopReason: "toolUse",
      blocks: [
        { kind: "thinking", phase: "final", text: transcriptText("CHILD_GATE_THINKING") },
        { kind: "text", phase: "final", text: transcriptText(CHILD_GATE_NATIVE_ASSISTANT_TEXT) },
        {
          kind: "tool",
          presentation: {
            tool: toolDisplayName("read"), phase: "completed",
            arguments: boundedFixtureJson({ path: CHILD_GATE_BUILTIN_SUMMARY }),
            result: { content: [transcriptText(CHILD_GATE_TOOL_PREVIEW)], isError: false },
          },
        },
        {
          kind: "tool",
          presentation: {
            tool: toolDisplayName("subagent_probe"), phase: "completed",
            arguments: boundedFixtureJson({ probe: "fixture" }),
            result: { content: [], isError: false },
          },
        },
        {
          kind: "tool",
          presentation: {
            tool: toolDisplayName("read"), phase: "completed",
            arguments: oversizedFixtureJson({ path: CHILD_GATE_OVERRIDE_SECRET.repeat(300) }),
            result: { content: [transcriptText(CHILD_GATE_TOOL_PREVIEW)], isError: false },
          },
        },
      ],
    },
  ];
  for (let index = 0; index < 35; index += 1) {
    items.push({
      sequence: transcriptSequence(items.length), runId: nativeRun, kind: "assistant",
      group: transcriptAssistantGroup(index + 3), phase: "final",
      blocks: [{ kind: "text", phase: "final", text: transcriptText(`Gate transcript line ${String(index).padStart(2, "0")}`) }],
    });
  }
  return Object.freeze({
    revision: selectedTranscriptRevision(1),
    transcript: Object.freeze({
      revision: transcriptRevision(1), items: Object.freeze(items), truncatedBefore: false, availability: "live",
      sensitiveValues: { nativeIds: new Set<string>(), managedPathsAndNames: new Set([CHILD_GATE_OVERRIDE_SECRET]) },
      renderingCwd: absolutePath(fixtureCwd),
    }),
    row, routeAvailable: true,
  });
}

function selectedSource(row: AgentRow): SelectedTranscriptSource {
  const snapshot = selected(row);
  return { snapshot: () => snapshot, subscribe: () => () => {} };
}

function boundedFixtureJson(value: unknown): BoundedTranscriptJson {
  const admitted = admitBoundedTranscriptJson(value);
  if (admitted === undefined) throw new Error("fixture tool JSON was unexpectedly rejected");
  return admitted;
}

/** Deliberately violates the source boundary to prove the presentation projector fails closed. */
function oversizedFixtureJson(value: unknown): BoundedTranscriptJson {
  return value as unknown as BoundedTranscriptJson;
}

const source: AgentWidgetSource & { dispose(): void } = {
  snapshot: () => widgetSnapshot,
  transcriptSource: (ordinal) => {
    const row = rows.find((candidate) => candidate.ordinal === ordinal);
    return row === undefined ? undefined : selectedSource(row);
  },
  subscribe: () => () => {},
  dispose: () => {},
};

const triggerPort: SubagentObservationPort = {
  observation: () => undefined,
  directSnapshot: () => ({ kind: "unavailable", finalRevision: agentObservationRevision(0) }),
  transcriptSource: () => undefined,
  subscribe: () => () => {},
};

function hasRuntimeBuiltInNames(fixtureCwd: string): boolean {
  const expected = new Set(NATIVE_BUILT_IN_TOOL_NAMES);
  const createAll = (PiRuntime as Record<string, unknown>).createAllToolDefinitions;
  const definitions = typeof createAll === "function"
    ? (createAll as (cwd: string) => Record<string, unknown>)(fixtureCwd)
    : Object.fromEntries(Object.entries(PiRuntime).flatMap(([exportName, factory]) => {
      if (!/^create.+ToolDefinition$/u.test(exportName) || typeof factory !== "function") return [];
      return [[exportName, (factory as (cwd: string) => { readonly name: string })(fixtureCwd)]];
    }));
  const names = new Set(Object.values(definitions).map((definition) =>
    typeof definition === "object" && definition !== null && "name" in definition ? String(definition.name) : "",
 ));
  return names.size === expected.size && [...expected].every((name) => names.has(name));
}

export default function installChildConversationGate(pi: ExtensionAPI): void {
  pi.registerProvider("child-conversation-gate", {
    name: "Child conversation gate",
    baseUrl: "http://127.0.0.1.invalid/v1",
    apiKey: "unused-offline-gate-key",
    api: "openai-completions",
    models: [{
      id: "fixture",
      name: "Child conversation fixture",
      reasoning: false,
      input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 16_384,
      maxTokens: 1_024,
    }],
  });
  const rawTracePath = process.env.PI_CHILD_CONVERSATION_GATE_EVENT_FILE;
  const tracePath = rawTracePath === undefined ? undefined : widgetGateTracePath(rawTracePath);
  const proofPath = process.env.PI_CHILD_CONVERSATION_GATE_PROOF_FILE;
  const emit = (event: string): void => { if (tracePath !== undefined) appendFileSync(tracePath, `${event}\n`); };
  let activeContext: ExtensionContext | undefined;
  let runtimeProofTimer: ReturnType<typeof setInterval> | undefined;
  let runtimeProofEmitted = false;
  createAgentWidgetExtension(pi, {
    createSource: () => source,
    trace: (event) => {
      emit(event);
      if (event === "widget-focused") activeContext?.ui.setEditorText(CHILD_GATE_EDITOR_TEXT);
    },
  });
  let publication: ReturnType<typeof publishObservationPort> | undefined;
  pi.on("session_start", (_event, ctx) => {
    activeContext = ctx;
    ctx.ui.setEditorText(CHILD_GATE_EDITOR_TEXT);
    publication?.clear();
    publication = publishObservationPort(triggerPort);
    if (proofPath !== undefined) runtimeProofTimer = setInterval(() => {
      if (runtimeProofEmitted || !existsSync(proofPath)) return;
      if (readFileSync(proofPath, "utf8") !== "native-built-in-rendered\n") return;
      runtimeProofEmitted = hasRuntimeBuiltInNames(process.cwd());
      if (runtimeProofEmitted) emit("native-builtin-names-asserted");
    }, 10);
  });
  pi.on("session_shutdown", () => {
    if (runtimeProofTimer !== undefined) clearInterval(runtimeProofTimer);
    runtimeProofTimer = undefined;
    publication?.clear();
    publication = undefined;
    activeContext = undefined;
  });
}
