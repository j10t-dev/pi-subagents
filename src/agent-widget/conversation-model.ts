import type { ConversationSnapshot } from "../agent-observation.ts";
import {
  visualLineOffset,
  type ViewportLineCount,
  type VisualLineCount,
  type VisualLineOffset,
} from "../domain.ts";

export interface ConversationLayout {
  readonly contentLines: VisualLineCount;
  readonly viewportLines: ViewportLineCount;
}

export interface ChildConversationModel {
  readonly conversation: ConversationSnapshot;
  readonly following: boolean;
  readonly lineOffset: VisualLineOffset;
  readonly thinkingVisible: boolean;
  readonly toolsExpanded: boolean;
}

export type ConversationMovement = "up" | "down" | "page-up" | "page-down" | "top" | "tail";

export function createChildConversationModel(conversation: ConversationSnapshot): ChildConversationModel {
  return Object.freeze({
    conversation,
    following: true,
    lineOffset: visualLineOffset(0),
    thinkingVisible: true,
    toolsExpanded: false,
  });
}

export function replaceConversation(
  model: ChildConversationModel,
  conversation: ConversationSnapshot,
  layout: ConversationLayout,
): ChildConversationModel {
  return clampConversationLayout(Object.freeze({ ...model, conversation }), layout);
}

export function moveConversation(
  model: ChildConversationModel,
  movement: ConversationMovement,
  layout: ConversationLayout,
  amount = 1,
): ChildConversationModel {
  const maximum = maximumOffset(layout);
  const safeAmount = Number.isFinite(amount) && amount > 0 ? Math.floor(amount) : 0;
  const page = Number(layout.viewportLines);
  const current = Number(model.lineOffset);
  let next: number;
  switch (movement) {
    case "up": next = saturatedAdd(current, safeAmount, maximum); break;
    case "down": next = Math.max(0, current - safeAmount); break;
    case "page-up": next = saturatedAdd(current, page, maximum); break;
    case "page-down": next = Math.max(0, current - page); break;
    case "top": next = maximum; break;
    case "tail": next = 0; break;
  }
  return withOffset(model, Math.min(maximum, next));
}

export function clampConversationLayout(
  model: ChildConversationModel,
  layout: ConversationLayout,
): ChildConversationModel {
  return withOffset(model, Math.min(Number(model.lineOffset), maximumOffset(layout)));
}

export function toggleConversationThinking(model: ChildConversationModel): ChildConversationModel {
  return Object.freeze({ ...model, thinkingVisible: !model.thinkingVisible });
}

export function toggleConversationTools(model: ChildConversationModel): ChildConversationModel {
  return Object.freeze({ ...model, toolsExpanded: !model.toolsExpanded });
}

function maximumOffset(layout: ConversationLayout): number {
  return Math.max(0, Number(layout.contentLines) - Number(layout.viewportLines));
}

function saturatedAdd(left: number, right: number, maximum: number): number {
  if (right >= maximum - left) return maximum;
  return left + right;
}

function withOffset(model: ChildConversationModel, offset: number): ChildConversationModel {
  const lineOffset = visualLineOffset(offset);
  return Object.freeze({ ...model, lineOffset, following: Number(lineOffset) === 0 });
}
