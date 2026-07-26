import { getMarkdownTheme, type Theme } from "@earendil-works/pi-coding-agent";
import { Markdown, truncateToWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";

import type { ConversationItem } from "../agent-observation.ts";
import {
  viewportLineCount,
  visualLineCount,
  type RenderWidth,
  type TerminalRows,
} from "../domain.ts";
import type { ChildConversationModel, ConversationLayout } from "./conversation-model.ts";

export const MAX_VISUAL_TRANSCRIPT_LINES = 4_096;

export interface ChildConversationRender {
  readonly lines: readonly string[];
  readonly transcriptLines: readonly string[];
  readonly layout: ConversationLayout;
}

/** Pure text-cell rendering over correlation-free conversation state. */
export function renderChildConversation(
  model: ChildConversationModel,
  theme: Theme,
  width: RenderWidth,
  terminalRowCount: TerminalRows,
): ChildConversationRender {
  const columns = Number(width);
  const header = [
    theme.fg("accent", `${model.conversation.row.ordinal} · ${model.conversation.row.model} · ${model.conversation.row.context} · ${model.conversation.row.state}`),
    theme.fg("muted", String(model.conversation.row.taskLabel)),
  ].map((line) => bounded(line, columns));
  const status = [bounded(theme.fg(statusColour(model), statusText(model)), columns)];
  const footer = [bounded(theme.fg("dim", footerText(model)), columns)];
  const viewport = Math.max(0, Number(terminalRowCount) - header.length - status.length - footer.length);
  const transcriptLines = layoutTranscript(model, theme, columns);
  const layout: ConversationLayout = Object.freeze({
    contentLines: visualLineCount(transcriptLines.length),
    viewportLines: viewportLineCount(viewport),
  });
  const maximumOffset = Math.max(0, transcriptLines.length - viewport);
  const offset = Math.min(maximumOffset, Number(model.lineOffset));
  const end = transcriptLines.length - offset;
  const start = Math.max(0, end - viewport);
  const visibleTranscript = transcriptLines.slice(start, end);
  const lines = [...header, ...status, ...visibleTranscript, ...footer]
    .slice(0, Number(terminalRowCount))
    .map((line) => bounded(line, columns));
  return Object.freeze({ lines: Object.freeze(lines), transcriptLines, layout });
}

function layoutTranscript(model: ChildConversationModel, theme: Theme, width: number): readonly string[] {
  const lines: string[] = [];
  if (model.conversation.truncatedBefore) {
    lines.push(...wrapped(theme.fg("warning", "Earlier source history omitted"), width));
  }
  for (const item of model.conversation.items) {
    lines.push(...renderItem(item, model, theme, width));
  }
  if (lines.length <= MAX_VISUAL_TRANSCRIPT_LINES) return Object.freeze(lines.map((line) => bounded(line, width)));
  const marker = bounded(theme.fg("warning", "Visual beginning omitted"), width);
  return Object.freeze([marker, ...lines.slice(-(MAX_VISUAL_TRANSCRIPT_LINES - 1)).map((line) => bounded(line, width))]);
}

function renderItem(
  item: ConversationItem,
  model: ChildConversationModel,
  theme: Theme,
  width: number,
): readonly string[] {
  switch (item.kind) {
    case "user":
      return wrapped(theme.fg("userMessageText", `You · ${item.text}`), width);
    case "assistant": {
      const label = bounded(theme.fg("accent", `Assistant · ${item.phase}`), width);
      const markdown = new Markdown(item.text, 0, 0, getMarkdownTheme());
      return [label, ...markdown.render(Math.max(1, width)).map((line) => bounded(line, width))];
    }
    case "thinking":
      return model.thinkingVisible
        ? wrapped(theme.fg("thinkingText", `Thinking · ${item.phase} · ${item.text}`), width)
        : [];
    case "tool": {
      const colour = item.phase === "failed" ? "error" : item.phase === "completed" ? "success" : "warning";
      const lines = wrapped(theme.fg(colour, `Tool · ${item.tool} · ${item.phase}`), width);
      if (!model.toolsExpanded || item.preview === undefined) return lines;
      return [...lines, ...wrapped(theme.fg("toolOutput", item.preview), width)];
    }
    case "notice":
      return wrapped(theme.fg("warning", noticeText(item.code)), width);
  }
}

function statusText(model: ChildConversationModel): string {
  if (Number(model.conversation.revision) === 0) return "Loading conversation";
  if (!model.conversation.routeAvailable) return "Route unavailable · retained content";
  switch (model.conversation.availability) {
    case "live": return "Live conversation";
    case "stopped": return "Stopped conversation";
    case "unavailable": return "Conversation unavailable";
  }
}

function statusColour(model: ChildConversationModel): "success" | "warning" | "muted" {
  if (Number(model.conversation.revision) === 0) return "muted";
  return model.conversation.routeAvailable && model.conversation.availability !== "unavailable" ? "success" : "warning";
}

function noticeText(code: Extract<ConversationItem, { kind: "notice" }>["code"]): string {
  switch (code) {
    case "context-compacted": return "Context compacted";
    case "transport-unavailable": return "Transport unavailable";
    case "projection-unavailable": return "Projection unavailable";
  }
}

function footerText(model: ChildConversationModel): string {
  const follow = model.following ? "following" : `paused · ${model.lineOffset} lines from tail`;
  return `${follow} · ↑/↓ line · PgUp/PgDn page · g/G top/tail · Ctrl+T thinking · Ctrl+O tools · Esc close`;
}

function wrapped(text: string, width: number): string[] {
  if (width === 0) return [];
  const lines = wrapTextWithAnsi(text, width);
  return (lines.length === 0 ? [""] : lines).map((line) => bounded(line, width));
}

function bounded(line: string, width: number): string {
  return truncateToWidth(line, width, "");
}
