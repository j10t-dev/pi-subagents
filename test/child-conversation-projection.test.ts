import { describe, expect, test } from "bun:test";

import type {
  AgentDisplayState,
  AgentRow,
  ConversationItem,
  SelectedTranscriptSnapshot,
  TranscriptItem,
} from "../src/agent-observation.ts";
import { projectConversationSnapshot } from "../src/agent-widget/conversation-projection.ts";
import {
  AgentState,
  agentDepth,
  agentOrdinal,
  conversationItemKey,
  conversationRevision,
  runId,
  selectedTranscriptRevision,
  transcriptAssistantGroup,
  transcriptRevision,
  transcriptSequence,
  type ContextLabel,
  type ModelLabel,
  type TaskLabel,
  type ToolDisplayName,
  type TranscriptText,
} from "../src/domain.ts";

function selectedSnapshot(): SelectedTranscriptSnapshot {
  const nativeRun = runId("deadbeef");
  const items: readonly TranscriptItem[] = [
    { sequence: transcriptSequence(901), kind: "assistant", group: transcriptAssistantGroup(0), phase: "final", blocks: [
      { kind: "text", phase: "final", text: "authoritative answer" as TranscriptText },
      { kind: "thinking", phase: "partial", text: "authoritative thought" as TranscriptText },
      { kind: "tool", presentation: { tool: "read" as ToolDisplayName, phase: "completed", preview: "safe preview" as TranscriptText } },
    ] },
    { sequence: transcriptSequence(904), runId: nativeRun, kind: "user", text: "question" as TranscriptText },
    { sequence: transcriptSequence(905), runId: nativeRun, kind: "assistant", group: transcriptAssistantGroup(1), phase: "partial", blocks: [
      { kind: "text", phase: "partial", text: "streaming answer" as TranscriptText },
      { kind: "thinking", phase: "final", text: "finished thought" as TranscriptText },
      { kind: "tool", presentation: { tool: "bash" as ToolDisplayName, phase: "running" } },
    ] },
    { sequence: transcriptSequence(908), kind: "notice", code: "context-compacted" },
    { sequence: transcriptSequence(909), kind: "notice", code: "transport-unavailable" },
    { sequence: transcriptSequence(910), kind: "notice", code: "projection-unavailable" },
  ];
  const row: AgentRow = Object.assign({
    ordinal: agentOrdinal("A1.2"),
    depth: agentDepth(1),
    model: "luna:h" as ModelLabel,
    context: "42%" as ContextLabel,
    taskLabel: "Research terminal UX" as TaskLabel,
    state: AgentState.Running as AgentDisplayState,
  }, { entryId: "entry-id", managedPath: "/managed/path" });
  return Object.assign({
    revision: selectedTranscriptRevision(73),
    transcript: Object.assign({
      revision: transcriptRevision(61),
      items,
      truncatedBefore: true,
      availability: "unavailable" as const,
      sensitiveValues: { nativeIds: new Set<string>(), managedPathsAndNames: new Set<string>() },
    }, { fileName: "child.jsonl", toolCallId: "tool-call-id" }),
    row,
    routeAvailable: false,
  }, { managedPath: "/managed/path" });
}

type AssistantConversationItem = Extract<ConversationItem, { readonly kind: "assistant" }>;
type ThinkingConversationItem = Extract<ConversationItem, { readonly kind: "thinking" }>;

describe("projectConversationSnapshot", () => {
  test("exposes assistant and thinking as distinct discriminated members", () => {
    const revision = conversationRevision(1);
    const assistant: AssistantConversationItem = {
      key: conversationItemKey(revision, 0), kind: "assistant", phase: "final",
      text: "answer" as TranscriptText,
    };
    const thinking: ThinkingConversationItem = {
      key: conversationItemKey(revision, 1), kind: "thinking", phase: "partial",
      text: "thought" as TranscriptText,
    };

    expect([assistant.kind, thinking.kind]).toEqual(["assistant", "thinking"]);
  });

  test("exhaustively copies display state while removing every correlation field", () => {
    const selected = selectedSnapshot();

    const conversation = projectConversationSnapshot(selected);

    const revision = conversationRevision(73);
    expect(conversation).toEqual({
      revision,
      items: [
        { key: conversationItemKey(revision, 0), kind: "assistant", phase: "final", text: "authoritative answer" as TranscriptText },
        { key: conversationItemKey(revision, 1), kind: "thinking", phase: "partial", text: "authoritative thought" as TranscriptText },
        { key: conversationItemKey(revision, 2), kind: "tool", tool: "read" as ToolDisplayName, phase: "completed", preview: "safe preview" as TranscriptText },
        { key: conversationItemKey(revision, 3), kind: "user", text: "question" as TranscriptText },
        { key: conversationItemKey(revision, 4), kind: "assistant", phase: "partial", text: "streaming answer" as TranscriptText },
        { key: conversationItemKey(revision, 5), kind: "thinking", phase: "final", text: "finished thought" as TranscriptText },
        { key: conversationItemKey(revision, 6), kind: "tool", tool: "bash" as ToolDisplayName, phase: "running" },
        { key: conversationItemKey(revision, 7), kind: "notice", code: "context-compacted" },
        { key: conversationItemKey(revision, 8), kind: "notice", code: "transport-unavailable" },
        { key: conversationItemKey(revision, 9), kind: "notice", code: "projection-unavailable" },
      ],
      truncatedBefore: true,
      availability: "unavailable",
      row: {
        ordinal: agentOrdinal("A1.2"), depth: agentDepth(1), model: "luna:h" as ModelLabel,
        context: "42%" as ContextLabel, taskLabel: "Research terminal UX" as TaskLabel,
        state: AgentState.Running as AgentDisplayState,
      },
      routeAvailable: false,
    });
    expect(Object.isFrozen(conversation)).toBe(true);
    expect(conversation.items.every(Object.isFrozen)).toBe(true);
    const json = JSON.stringify(conversation);
    for (const secret of ["deadbeef", "901", "entry-id", "tool-call-id", "child.jsonl", "/managed/path"]) {
      expect(json).not.toContain(secret);
    }
  });

  test("uses only local revision and source order for stable opaque item keys", () => {
    const first = projectConversationSnapshot(selectedSnapshot());
    const second = projectConversationSnapshot(selectedSnapshot());

    expect(first.items.map((item) => item.key)).toEqual(second.items.map((item) => item.key));
    expect(new Set(first.items.map((item) => item.key)).size).toBe(first.items.length);
  });
});
