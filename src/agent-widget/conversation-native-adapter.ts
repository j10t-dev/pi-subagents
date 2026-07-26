import type { AssistantMessage } from "@earendil-works/pi-ai";
import {
  AssistantMessageComponent,
  getMarkdownTheme,
  parseSkillBlock,
  SkillInvocationMessageComponent,
  ToolExecutionComponent,
  UserMessageComponent,
  type Theme,
} from "@earendil-works/pi-coding-agent";
import { Spacer, Text, type Component, type TUI } from "@earendil-works/pi-tui";

import type {
  ConversationSnapshot,
  ConversationToolPresentation,
  ConversationTurn,
} from "../agent-observation.ts";
import type { ConversationStopReason, RenderWidth } from "../domain.ts";
import { createPresentationToolDefinition } from "./conversation-fallback-tool-definition.ts";

const OSC133_7_BIT_PREFIX = "\u001b]133;";
const OSC133_C1_PREFIX = "\u009d133;";
const NATIVE_OUTPUT_PAD = 1;
const HIDDEN_THINKING_LABEL = "Thinking...";

/** Removes every OSC 133 shell-integration mark without disturbing unrelated terminal styling. */
export function stripShellIntegration(line: string): string {
  let output = "";
  let index = 0;
  while (index < line.length) {
    const prefixLength = line.startsWith(OSC133_7_BIT_PREFIX, index)
      ? OSC133_7_BIT_PREFIX.length
      : line.startsWith(OSC133_C1_PREFIX, index)
        ? OSC133_C1_PREFIX.length
        : 0;
    if (prefixLength === 0) {
      output += line[index]!;
      index += 1;
      continue;
    }

    let cursor = index + prefixLength;
    let terminated = false;
    while (cursor < line.length) {
      if (line[cursor] === "\u0007" || line[cursor] === "\u009c") {
        cursor += 1;
        terminated = true;
        break;
      }
      if (line[cursor] === "\u001b" && line[cursor + 1] === "\\") {
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

export interface PiConversationAdapterOptions {
  readonly tui: TUI;
  /** Governs local fallback presentation; native components use Pi's process-global theme. */
  readonly theme: Theme;
}

export interface PiConversationRenderOptions {
  readonly thinkingVisible: boolean;
  readonly toolsExpanded: boolean;
  readonly width: RenderWidth;
}

export interface PiConversationAdapter {
  render(conversation: ConversationSnapshot, options: PiConversationRenderOptions): readonly string[];
  invalidate(): void;
  dispose(): void;
  readonly constructionCount: number;
}

interface ExpandableComponent {
  setExpanded(expanded: boolean): void;
}

interface BuiltComponents {
  readonly revision: number;
  readonly renderingCwd: string | undefined;
  readonly children: readonly Component[];
  readonly assistants: readonly AssistantMessageComponent[];
  readonly expandable: readonly ExpandableComponent[];
}

export function createPiConversationAdapter(options: PiConversationAdapterOptions): PiConversationAdapter {
  let built: BuiltComponents | undefined;
  let constructions = 0;
  let disposed = false;

  function build(conversation: ConversationSnapshot): BuiltComponents {
    const children: Component[] = [];
    const assistants: AssistantMessageComponent[] = [];
    const expandable: ExpandableComponent[] = [];
    for (const turn of conversation.turns) {
      appendTurn(turn, conversation, children, assistants, expandable, options);
    }
    constructions += 1;
    return Object.freeze({
      revision: Number(conversation.revision),
      renderingCwd: conversation.renderingCwd === undefined ? undefined : String(conversation.renderingCwd),
      children: Object.freeze(children),
      assistants: Object.freeze(assistants),
      expandable: Object.freeze(expandable),
    });
  }

  return {
    get constructionCount(): number { return constructions },

    render(conversation, renderOptions): readonly string[] {
      if (disposed) return Object.freeze([]);
      const cwd = conversation.renderingCwd === undefined ? undefined : String(conversation.renderingCwd);
      if (built === undefined || built.revision !== Number(conversation.revision) || built.renderingCwd !== cwd) {
        built = build(conversation);
      }
      for (const assistant of built.assistants) assistant.setHideThinkingBlock(!renderOptions.thinkingVisible);
      for (const item of built.expandable) item.setExpanded(renderOptions.toolsExpanded);
      const width = Math.max(1, Number(renderOptions.width));
      const lines: string[] = [];
      for (const child of built.children) {
        try {
          for (const line of child.render(width)) lines.push(stripShellIntegration(line));
        } catch {
          lines.push(options.theme.fg("warning", "Item unavailable"));
        }
      }
      return Object.freeze(lines);
    },

    invalidate(): void { built = undefined },

    dispose(): void {
      disposed = true;
      built = undefined;
    },
  };
}

function appendTurn(
  turn: ConversationTurn,
  conversation: ConversationSnapshot,
  children: Component[],
  assistants: AssistantMessageComponent[],
  expandable: ExpandableComponent[],
  options: PiConversationAdapterOptions,
): void {
  const markdown = getMarkdownTheme();
  if (turn.kind === "notice") {
    if (children.length > 0) children.push(new Spacer(1));
    children.push(new Text(options.theme.fg("warning", noticeText(turn.code)), NATIVE_OUTPUT_PAD, 0));
    return;
  }
  if (turn.kind === "user") {
    if (children.length > 0) children.push(new Spacer(1));
    const text = String(turn.text);
    const skill = parseSkillBlock(text);
    if (skill === null) {
      children.push(new UserMessageComponent(text, markdown, NATIVE_OUTPUT_PAD));
      return;
    }
    const skillComponent = new SkillInvocationMessageComponent(skill, markdown);
    children.push(skillComponent);
    expandable.push(skillComponent);
    if (skill.userMessage) {
      children.push(new Spacer(1));
      children.push(new UserMessageComponent(skill.userMessage, markdown, NATIVE_OUTPUT_PAD));
    }
    return;
  }

  const assistant = new AssistantMessageComponent(
    presentationMessage(turn),
    false,
    markdown,
    HIDDEN_THINKING_LABEL,
    NATIVE_OUTPUT_PAD,
  );
  children.push(assistant);
  assistants.push(assistant);
  for (const block of turn.blocks) {
    if (block.kind !== "tool") continue;
    const component = createToolComponent(block.presentation, conversation, options);
    children.push(component);
    expandable.push(component);
    applyToolState(component, block.presentation, turn.stopReason);
  }
}

/** Presentation-only metadata required by Pi's public assistant message type; never persisted. */
function presentationMessage(turn: Extract<ConversationTurn, { kind: "assistant" }>): AssistantMessage {
  const content: AssistantMessage["content"] = [];
  for (const block of turn.blocks) {
    if (block.kind === "text") content.push({ type: "text", text: String(block.text) });
    else if (block.kind === "thinking") content.push({ type: "thinking", thinking: String(block.text) });
    else content.push({
      type: "toolCall",
      id: String(block.presentation.callKey),
      name: String(block.presentation.tool),
      arguments: toolArguments(block.presentation),
    });
  }
  return {
    role: "assistant",
    content,
    api: "presentation",
    provider: "presentation",
    model: "presentation",
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: turn.stopReason ?? "stop",
    timestamp: 0,
  };
}

function noticeText(code: Extract<ConversationTurn, { kind: "notice" }>["code"]): string {
  switch (code) {
    case "context-compacted": return "Context compacted";
    case "transport-unavailable": return "Transport unavailable";
    case "projection-unavailable": return "Projection unavailable";
  }
}

function toolArguments(presentation: ConversationToolPresentation): Record<string, unknown> {
  const value = presentation.arguments;
  if (value === undefined || typeof value !== "object" || value === null || Array.isArray(value)) return {};
  return { ...value };
}

function createToolComponent(
  presentation: ConversationToolPresentation,
  conversation: ConversationSnapshot,
  options: PiConversationAdapterOptions,
): ToolExecutionComponent {
  const definition = presentation.rendering === "renderer-override"
    ? createPresentationToolDefinition(presentation.tool, options.theme)
    : undefined;
  return new ToolExecutionComponent(
    String(presentation.tool),
    String(presentation.callKey),
    toolArguments(presentation),
    { showImages: false },
    definition,
    options.tui,
    conversation.renderingCwd === undefined ? "" : String(conversation.renderingCwd),
  );
}

function applyToolState(
  component: ToolExecutionComponent,
  presentation: ConversationToolPresentation,
  stopReason: ConversationStopReason | undefined,
): void {
  if (presentation.phase === "running") {
    component.markExecutionStarted();
    return;
  }
  component.setArgsComplete();
  if (stopReason === "aborted" || stopReason === "error") {
    component.updateResult({
      content: [{ type: "text", text: stopReason === "aborted" ? "Operation aborted" : "Error" }],
      isError: true,
    });
    return;
  }
  const content = presentation.result?.content ?? (presentation.preview === undefined ? [] : [presentation.preview]);
  if (content.length === 0 && presentation.result === undefined) return;
  component.updateResult({
    content: content.map((text) => ({ type: "text", text: String(text) })),
    ...(presentation.result?.details === undefined ? {} : { details: presentation.result.details }),
    isError: presentation.result?.isError ?? presentation.phase === "failed",
  });
}
