import type {
  AgentRow,
  ConversationItem,
  ConversationSnapshot,
  SelectedTranscriptSnapshot,
  TranscriptItem,
} from "../agent-observation.ts";
import {
  conversationItemKey,
  conversationRevision,
  type ConversationRevision,
} from "../domain.ts";

/** Removes transcript correlation before any state can reach presentation code. */
export function projectConversationSnapshot(selected: SelectedTranscriptSnapshot): ConversationSnapshot {
  const revision = conversationRevision(
    Number(selected.transcript.revision) === 0 ? 0 : Number(selected.revision),
  );
  const items = Object.freeze(selected.transcript.items.map((item, index) => projectItem(item, revision, index)));
  return Object.freeze({
    revision,
    items,
    truncatedBefore: selected.transcript.truncatedBefore,
    availability: selected.transcript.availability,
    row: projectRow(selected.row),
    routeAvailable: selected.routeAvailable,
  });
}

function projectItem(item: TranscriptItem, revision: ConversationRevision, index: number): ConversationItem {
  const key = conversationItemKey(revision, index);
  switch (item.kind) {
    case "user":
      return Object.freeze({ key, kind: "user", text: item.text });
    case "assistant":
      return Object.freeze({ key, kind: "assistant", phase: item.phase, text: item.text });
    case "thinking":
      return Object.freeze({ key, kind: "thinking", phase: item.phase, text: item.text });
    case "tool":
      return Object.freeze({
        key,
        kind: "tool",
        tool: item.tool,
        phase: item.phase,
        ...(item.preview === undefined ? {} : { preview: item.preview }),
      });
    case "notice":
      return Object.freeze({ key, kind: "notice", code: item.code });
  }
}

function projectRow(row: AgentRow): AgentRow {
  return Object.freeze({
    ordinal: row.ordinal,
    depth: row.depth,
    model: row.model,
    context: row.context,
    taskLabel: row.taskLabel,
    state: row.state,
  });
}
