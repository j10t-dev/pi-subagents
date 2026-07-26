import type { Theme } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";

import { MAX_CONVERSATION_LAYOUT_LINES } from "../constants.ts";
import {
  renderWidth,
  viewportLineCount,
  visualLineCount,
  type RenderWidth,
  type TerminalRows,
} from "../domain.ts";
import type { ChildConversationModel, ConversationLayout } from "./conversation-model.ts";
import { stripShellIntegration, type PiConversationAdapter } from "./conversation-native-adapter.ts";

export interface ChildConversationRender {
  readonly lines: readonly string[];
  readonly transcriptLines: readonly string[];
  readonly layout: ConversationLayout;
}


/** Bounded viewport rendering over correlation-free conversation state. */
export function renderChildConversation(
  model: ChildConversationModel,
  theme: Theme,
  width: RenderWidth,
  terminalRowCount: TerminalRows,
  adapter: PiConversationAdapter,
): ChildConversationRender {
  const columns = Number(width);
  const header = [
    theme.fg("accent", `${model.conversation.header.ordinal} · ${model.conversation.header.model} · ${model.conversation.header.context} · ${model.conversation.header.state}`),
    theme.fg("muted", String(model.conversation.header.taskLabel)),
  ].map((line) => bounded(line, columns));
  const status = [bounded(theme.fg(statusColour(model), statusText(model)), columns)];
  const footer = [bounded(theme.fg("dim", footerText(model)), columns)];
  const viewport = Math.max(0, Number(terminalRowCount) - header.length - status.length - footer.length);
  const transcriptLines = layoutTranscript(model, theme, columns, adapter);
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

function layoutTranscript(
  model: ChildConversationModel,
  theme: Theme,
  width: number,
  adapter: PiConversationAdapter,
): readonly string[] {
  const lines = new Array<string>(MAX_CONVERSATION_LAYOUT_LINES);
  let retainedLines = 0;
  let totalLines = 0;
  let nextLine = 0;
  const append = (next: readonly string[]): void => {
    for (const line of next) {
      lines[nextLine] = bounded(line, width);
      nextLine = (nextLine + 1) % MAX_CONVERSATION_LAYOUT_LINES;
      retainedLines = Math.min(retainedLines + 1, MAX_CONVERSATION_LAYOUT_LINES);
      totalLines += 1;
    }
  };
  if (model.conversation.truncatedBefore) {
    append(wrapped(theme.fg("warning", "Earlier source history omitted"), width));
  }
  append(adapter.render(model.conversation, {
    thinkingVisible: model.thinkingVisible,
    toolsExpanded: model.toolsExpanded,
    width: renderWidth(width),
  }));

  const ordered: string[] = [];
  const firstLine = retainedLines === MAX_CONVERSATION_LAYOUT_LINES ? nextLine : 0;
  for (let index = 0; index < retainedLines; index += 1) {
    ordered.push(lines[(firstLine + index) % MAX_CONVERSATION_LAYOUT_LINES]!);
  }
  if (totalLines <= MAX_CONVERSATION_LAYOUT_LINES) return Object.freeze(ordered);
  const marker = bounded(theme.fg("warning", "Visual beginning omitted"), width);
  return Object.freeze([marker, ...ordered.slice(1)]);
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

function footerText(model: ChildConversationModel): string {
  const follow = model.following ? "following" : `paused · ${model.lineOffset} lines from tail`;
  return `${follow} · ↑/↓ line · PgUp/PgDn page · g/G top/tail · Ctrl+T thinking · Ctrl+O tools · Esc close`;
}

function wrapped(text: string, width: number): string[] {
  if (width === 0) return [];
  const lines = wrapTextWithAnsi(stripShellIntegration(text), width);
  return (lines.length === 0 ? [""] : lines).map((line) => bounded(line, width));
}

function bounded(line: string, width: number): string {
  return truncateToWidth(stripShellIntegration(line), width, "");
}
