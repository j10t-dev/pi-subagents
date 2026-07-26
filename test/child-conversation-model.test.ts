import { describe, expect, test } from "bun:test";

import type { AgentDisplayState, ConversationSnapshot } from "../src/agent-observation.ts";
import {
  clampConversationLayout,
  createChildConversationModel,
  moveConversation,
  replaceConversation,
  toggleConversationThinking,
  toggleConversationTools,
} from "../src/agent-widget/conversation-model.ts";
import {
  AgentState,
  agentOrdinal,
  conversationRevision,
  viewportLineCount,
  visualLineCount,
  type ContextLabel,
  type ModelLabel,
  type TaskLabel,
} from "../src/domain.ts";

function conversation(revision = 1, options: Partial<ConversationSnapshot> = {}): ConversationSnapshot {
  return Object.freeze({
    revision: conversationRevision(revision),
    turns: [],
    truncatedBefore: false,
    availability: "live" as const,
    header: Object.freeze({
      ordinal: agentOrdinal("A1.2"), model: "luna:h" as ModelLabel,
      context: "42%" as ContextLabel, taskLabel: "Research terminal UX" as TaskLabel,
      state: AgentState.Running as AgentDisplayState,
    }),
    routeAvailable: true,
    ...options,
  });
}

const layout = (contentLines: number, viewportLines: number) => ({
  contentLines: visualLineCount(contentLines),
  viewportLines: viewportLineCount(viewportLines),
});

describe("child conversation model", () => {
  test("defaults to loading at revision zero with tail following and local toggles", () => {
    const model = createChildConversationModel(conversation(0));

    expect(model).toMatchObject({
      following: true, lineOffset: 0, thinkingVisible: true, toolsExpanded: false,
    });
    expect(Number(model.conversation.revision)).toBe(0);
  });

  test("new revisions follow the tail while following and preserve a paused tail-relative offset", () => {
    let following = createChildConversationModel(conversation(1));
    following = replaceConversation(following, conversation(2), layout(40, 10));
    expect(following).toMatchObject({ following: true, lineOffset: 0 });

    let paused = moveConversation(following, "up", layout(40, 10));
    paused = replaceConversation(paused, conversation(3), layout(45, 10));
    expect(paused).toMatchObject({ following: false, lineOffset: 1 });
    expect(Number(paused.conversation.revision)).toBe(3);
  });

  test("supports line, page, top and tail movement with bottom resumption", () => {
    let model = createChildConversationModel(conversation());
    model = moveConversation(model, "up", layout(40, 10));
    expect(model).toMatchObject({ following: false, lineOffset: 1 });
    model = moveConversation(model, "page-up", layout(40, 10));
    expect(model).toMatchObject({ following: false, lineOffset: 11 });
    model = moveConversation(model, "top", layout(40, 10));
    expect(model).toMatchObject({ following: false, lineOffset: 30 });
    model = moveConversation(model, "page-down", layout(40, 10));
    expect(model).toMatchObject({ following: false, lineOffset: 20 });
    model = moveConversation(model, "down", layout(40, 10), 1_000);
    expect(model).toMatchObject({ following: true, lineOffset: 0 });
    model = moveConversation(model, "up", layout(40, 10), 3);
    model = moveConversation(model, "tail", layout(40, 10));
    expect(model).toMatchObject({ following: true, lineOffset: 0 });
  });

  test("saturates arithmetic and clamps the paused offset after resize", () => {
    let model = createChildConversationModel(conversation());
    model = moveConversation(model, "up", layout(4_096, 1), Number.MAX_SAFE_INTEGER);
    expect(Number(model.lineOffset)).toBe(4_095);

    model = clampConversationLayout(model, layout(8, 6));
    expect(model).toMatchObject({ following: false, lineOffset: 2 });
    model = clampConversationLayout(model, layout(3, 10));
    expect(model).toMatchObject({ following: true, lineOffset: 0 });
  });

  test("toggles thinking and tools without changing navigation or retained unavailable content", () => {
    let model = createChildConversationModel(conversation());
    model = moveConversation(model, "up", layout(20, 5), 4);
    model = toggleConversationThinking(model);
    model = toggleConversationTools(model);
    model = replaceConversation(model, conversation(2, {
      availability: "unavailable", routeAvailable: false,
    }), layout(20, 5));

    expect(model).toMatchObject({
      following: false, lineOffset: 4, thinkingVisible: false, toolsExpanded: true,
      conversation: { availability: "unavailable", routeAvailable: false, turns: [] },
    });
  });
});
