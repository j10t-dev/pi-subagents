import { getMarkdownTheme, type Theme } from "@earendil-works/pi-coding-agent";
import { Markdown, truncateToWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";

import type { ConversationAssistantBlock, ConversationTurn } from "../agent-observation.ts";
import { MAX_CONVERSATION_LAYOUT_LINES } from "../constants.ts";
import {
  viewportLineCount,
  visualLineCount,
  type RenderWidth,
  type TerminalRows,
} from "../domain.ts";
import type { ChildConversationModel, ConversationLayout } from "./conversation-model.ts";

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
    theme.fg("accent", `${model.conversation.header.ordinal} · ${model.conversation.header.model} · ${model.conversation.header.context} · ${model.conversation.header.state}`),
    theme.fg("muted", String(model.conversation.header.taskLabel)),
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
  for (const turn of model.conversation.turns) append(renderTurn(turn, model, theme, width));

  const ordered: string[] = [];
  const firstLine = retainedLines === MAX_CONVERSATION_LAYOUT_LINES ? nextLine : 0;
  for (let index = 0; index < retainedLines; index += 1) {
    ordered.push(lines[(firstLine + index) % MAX_CONVERSATION_LAYOUT_LINES]!);
  }
  if (totalLines <= MAX_CONVERSATION_LAYOUT_LINES) return Object.freeze(ordered);
  const marker = bounded(theme.fg("warning", "Visual beginning omitted"), width);
  return Object.freeze([marker, ...ordered.slice(1)]);
}

function renderTurn(
  turn: ConversationTurn,
  model: ChildConversationModel,
  theme: Theme,
  width: number,
): readonly string[] {
  switch (turn.kind) {
    case "user": return wrapped(theme.fg("userMessageText", `You · ${stripOsc133(turn.text)}`), width);
    case "notice": return wrapped(theme.fg("warning", noticeText(turn.code)), width);
    case "assistant": return turn.blocks.flatMap((block) => renderAssistantBlock(block, turn.phase, model, theme, width));
  }
}

function renderAssistantBlock(
  block: ConversationAssistantBlock,
  phase: "partial" | "final",
  model: ChildConversationModel,
  theme: Theme,
  width: number,
): readonly string[] {
  switch (block.kind) {
    case "text": {
      const label = bounded(theme.fg("accent", `Assistant · ${phase}`), width);
      const markdown = new Markdown(stripOsc133(block.text), 0, 0, getMarkdownTheme());
      return [label, ...markdown.render(Math.max(1, width)).map((line) => bounded(line, width))];
    }
    case "thinking":
      return model.thinkingVisible
        ? wrapped(theme.fg("thinkingText", `Thinking · ${stripOsc133(block.text)}`), width)
        : [];
    case "tool": {
      const presentation = block.presentation;
      const colour = presentation.phase === "failed" ? "error" : presentation.phase === "completed" ? "success" : "warning";
      const lines = wrapped(theme.fg(colour, `Tool · ${presentation.tool} · ${presentation.phase}`), width);
      if (!model.toolsExpanded || presentation.preview === undefined) return lines;
      return [...lines, ...wrapped(theme.fg("toolOutput", stripOsc133(presentation.preview)), width)];
    }
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

function noticeText(code: Extract<ConversationTurn, { kind: "notice" }>["code"]): string {
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
  const lines = wrapTextWithAnsi(stripOsc133(text), width);
  return (lines.length === 0 ? [""] : lines).map((line) => bounded(line, width));
}

function bounded(line: string, width: number): string {
  return truncateToWidth(stripOsc133(line), width, "");
}

/** Removes OSC 133 shell-integration sequences without disturbing unrelated terminal styling. */
function stripOsc133(value: string): string {
  let output = "";
  let index = 0;
  while (index < value.length) {
    if (value[index] !== "\u001b" || value[index + 1] !== "]" || !value.startsWith("133;", index + 2)) {
      output += value[index]!;
      index += 1;
      continue;
    }
    let cursor = index + 6;
    let terminated = false;
    while (cursor < value.length) {
      if (value[cursor] === "\u0007") {
        cursor += 1;
        terminated = true;
        break;
      }
      if (value[cursor] === "\u001b" && value[cursor + 1] === "\\") {
        cursor += 2;
        terminated = true;
        break;
      }
      cursor += 1;
    }
    if (!terminated) break;
    index = cursor;
  }
  return output;
}
