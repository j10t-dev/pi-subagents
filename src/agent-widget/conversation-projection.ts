import type {
  AgentRow,
  ConversationItem,
  ConversationSnapshot,
  SelectedTranscriptSnapshot,
  TranscriptAssistantBlock,
  TranscriptItem,
} from "../agent-observation.ts";
import { conversationItemKey, conversationRevision, type ConversationRevision } from "../domain.ts";

/** Removes transcript correlation before any state can reach presentation code. */
export function projectConversationSnapshot(selected: SelectedTranscriptSnapshot): ConversationSnapshot {
  const revision = conversationRevision(Number(selected.transcript.revision) === 0 ? 0 : Number(selected.revision));
  const flattened = selected.transcript.items.flatMap(flattenItem);
  const items = Object.freeze(flattened.map((item, index) => projectItem(item, revision, index)));
  return Object.freeze({ revision, items, truncatedBefore: selected.transcript.truncatedBefore,
    availability: selected.transcript.availability, row: projectRow(selected.row), routeAvailable: selected.routeAvailable });
}

type FlatItem = Exclude<TranscriptItem, { kind: "assistant" }> | TranscriptAssistantBlock;
function flattenItem(item: TranscriptItem): readonly FlatItem[] {
  return item.kind === "assistant" ? item.blocks : [item];
}
function projectItem(item: FlatItem, revision: ConversationRevision, index: number): ConversationItem {
  const key = conversationItemKey(revision, index);
  switch (item.kind) {
    case "user": return Object.freeze({ key, kind: "user", text: item.text });
    case "text": return Object.freeze({ key, kind: "assistant", phase: item.phase, text: item.text });
    case "thinking": return Object.freeze({ key, kind: "thinking", phase: item.phase, text: item.text });
    case "tool": return Object.freeze({ key, kind: "tool", tool: item.presentation.tool, phase: item.presentation.phase,
      ...(item.presentation.preview === undefined ? {} : { preview: item.presentation.preview }) });
    case "notice": return Object.freeze({ key, kind: "notice", code: item.code });
  }
}
function projectRow(row: AgentRow): AgentRow {
  return Object.freeze({ ordinal: row.ordinal, depth: row.depth, model: row.model, context: row.context, taskLabel: row.taskLabel, state: row.state });
}
