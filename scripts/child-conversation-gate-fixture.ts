import { appendFileSync } from "node:fs";

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
} from "../src/domain.ts";
import { publishObservationPort } from "../src/observation-registry.ts";
import { widgetGateTracePath } from "../src/paths.ts";

export const CHILD_GATE_EDITOR_TEXT = "child-gate-draft";

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
  const items: TranscriptItem[] = [
    { sequence: transcriptSequence(0), runId: nativeRun, kind: "user", text: transcriptText("Gate question") },
  ];
  for (let index = 0; index < 35; index += 1) {
    items.push({
      sequence: transcriptSequence(items.length),
      runId: nativeRun,
      kind: "assistant",
      group: transcriptAssistantGroup(index),
      phase: "final",
      blocks: index === 20 ? [
        { kind: "thinking", phase: "final", text: transcriptText("CHILD_GATE_THINKING") },
        { kind: "tool", presentation: { tool: toolDisplayName("read"), phase: "completed", preview: transcriptText("CHILD_GATE_TOOL_PREVIEW") } },
        { kind: "text", phase: "final", text: transcriptText(`Gate transcript line ${String(index).padStart(2, "0")}`) },
      ] : [
        { kind: "text", phase: "final", text: transcriptText(`Gate transcript line ${String(index).padStart(2, "0")}`) },
      ],
    });
  }
  return Object.freeze({
    revision: selectedTranscriptRevision(1),
    transcript: Object.freeze({
      revision: transcriptRevision(1),
      items: Object.freeze(items),
      truncatedBefore: false,
      availability: "live",
      sensitiveValues: { nativeIds: new Set<string>(), managedPathsAndNames: new Set<string>() },
    }),
    row,
    routeAvailable: true,
  });
}

function selectedSource(row: AgentRow): SelectedTranscriptSource {
  const snapshot = selected(row);
  return { snapshot: () => snapshot, subscribe: () => () => {} };
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
  let activeContext: ExtensionContext | undefined;
  createAgentWidgetExtension(pi, {
    createSource: () => source,
    trace: (event) => {
      if (tracePath !== undefined) appendFileSync(tracePath, `${event}\n`);
      if (event === "widget-focused") activeContext?.ui.setEditorText(CHILD_GATE_EDITOR_TEXT);
    },
  });
  let publication: ReturnType<typeof publishObservationPort> | undefined;
  pi.on("session_start", (_event, ctx) => {
    activeContext = ctx;
    ctx.ui.setEditorText(CHILD_GATE_EDITOR_TEXT);
    publication?.clear();
    publication = publishObservationPort(triggerPort);
  });
  pi.on("session_shutdown", () => {
    publication?.clear();
    publication = undefined;
    activeContext = undefined;
  });
}
