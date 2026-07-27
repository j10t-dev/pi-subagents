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

export interface PiConversationAdapterFactories {
  readonly getMarkdownTheme: typeof getMarkdownTheme;
  readonly parseSkillBlock: typeof parseSkillBlock;
  readonly createUserMessage: (...args: ConstructorParameters<typeof UserMessageComponent>) => UserMessageComponent;
  readonly createSkillInvocation: (...args: ConstructorParameters<typeof SkillInvocationMessageComponent>) => SkillInvocationMessageComponent;
  readonly createAssistantMessage: (...args: ConstructorParameters<typeof AssistantMessageComponent>) => AssistantMessageComponent;
  readonly createPresentationToolDefinition: typeof createPresentationToolDefinition;
  readonly createToolExecution: (...args: ConstructorParameters<typeof ToolExecutionComponent>) => ToolExecutionComponent;
}

export interface PiConversationAdapterOptions {
  readonly tui: TUI;
  /** Governs local fallback presentation; native components use Pi's process-global theme. */
  readonly theme: Theme;
  /** Constructor boundary used by host compatibility tests and item-level containment. */
  readonly factories?: Partial<PiConversationAdapterFactories>;
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

interface ComponentUpdater<T> {
  readonly component: T;
  readonly childIndex: number;
}

interface BuiltComponents {
  readonly revision: number;
  readonly renderingCwd: string | undefined;
  readonly children: Component[];
  readonly assistants: readonly ComponentUpdater<AssistantMessageComponent>[];
  readonly expandable: readonly ComponentUpdater<ExpandableComponent>[];
  readonly failedChildren: Set<number>;
}

export function createPiConversationAdapter(options: PiConversationAdapterOptions): PiConversationAdapter {
  const factories: PiConversationAdapterFactories = {
    getMarkdownTheme,
    parseSkillBlock,
    createUserMessage: (...args) => new UserMessageComponent(...args),
    createSkillInvocation: (...args) => new SkillInvocationMessageComponent(...args),
    createAssistantMessage: (...args) => new AssistantMessageComponent(...args),
    createPresentationToolDefinition,
    createToolExecution: (...args) => new ToolExecutionComponent(...args),
    ...options.factories,
  };
  let built: BuiltComponents | undefined;
  let constructions = 0;
  let disposed = false;

  function build(conversation: ConversationSnapshot): BuiltComponents {
    const children: Component[] = [];
    const assistants: ComponentUpdater<AssistantMessageComponent>[] = [];
    const expandable: ComponentUpdater<ExpandableComponent>[] = [];
    for (const turn of conversation.turns) {
      appendTurn(turn, conversation, children, assistants, expandable, options, factories);
    }
    constructions += 1;
    return Object.freeze({
      revision: Number(conversation.revision),
      renderingCwd: conversation.renderingCwd === undefined ? undefined : String(conversation.renderingCwd),
      children,
      assistants: Object.freeze(assistants),
      expandable: Object.freeze(expandable),
      failedChildren: new Set<number>(),
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
      for (const assistant of built.assistants) {
        if (built.failedChildren.has(assistant.childIndex)) continue;
        try { assistant.component.setHideThinkingBlock(!renderOptions.thinkingVisible); }
        catch { degradeBuiltItem(built, assistant.childIndex, options); }
      }
      for (const item of built.expandable) {
        if (built.failedChildren.has(item.childIndex)) continue;
        try { item.component.setExpanded(renderOptions.toolsExpanded); }
        catch { degradeBuiltItem(built, item.childIndex, options); }
      }
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
  assistants: ComponentUpdater<AssistantMessageComponent>[],
  expandable: ComponentUpdater<ExpandableComponent>[],
  options: PiConversationAdapterOptions,
  factories: PiConversationAdapterFactories,
): void {
  if (turn.kind === "notice") {
    appendTransaction(children, assistants, expandable, options, (pending) => {
      if (children.length > 0) pending.children.push(new Spacer(1));
      pending.children.push(new Text(options.theme.fg("warning", noticeText(turn.code)), NATIVE_OUTPUT_PAD, 0));
    });
    return;
  }
  if (turn.kind === "user") {
    appendTransaction(children, assistants, expandable, options, (pending) => {
      const markdown = factories.getMarkdownTheme();
      if (children.length > 0) pending.children.push(new Spacer(1));
      const text = String(turn.text);
      const skill = factories.parseSkillBlock(text);
      if (skill === null) {
        pending.children.push(factories.createUserMessage(text, markdown, NATIVE_OUTPUT_PAD));
        return;
      }
      const skillComponent = factories.createSkillInvocation(skill, markdown);
      pending.children.push(skillComponent);
      pending.expandable.push({ component: skillComponent, childIndex: pending.children.length - 1 });
      if (skill.userMessage) {
        pending.children.push(new Spacer(1));
        pending.children.push(factories.createUserMessage(skill.userMessage, markdown, NATIVE_OUTPUT_PAD));
      }
    });
    return;
  }

  appendTransaction(children, assistants, expandable, options, (pending) => {
    const assistant = factories.createAssistantMessage(
      presentationMessage(turn),
      false,
      factories.getMarkdownTheme(),
      HIDDEN_THINKING_LABEL,
      NATIVE_OUTPUT_PAD,
    );
    pending.children.push(assistant);
    pending.assistants.push({ component: assistant, childIndex: pending.children.length - 1 });
  });
  for (const block of turn.blocks) {
    if (block.kind !== "tool") continue;
    appendTransaction(children, assistants, expandable, options, (pending) => {
      const component = createToolComponent(block.presentation, conversation, options, factories);
      applyToolState(component, block.presentation, turn.stopReason);
      pending.children.push(component);
      pending.expandable.push({ component, childIndex: pending.children.length - 1 });
    });
  }
}

interface PendingComponents {
  readonly children: Component[];
  readonly assistants: ComponentUpdater<AssistantMessageComponent>[];
  readonly expandable: ComponentUpdater<ExpandableComponent>[];
}

function appendTransaction(
  children: Component[],
  assistants: ComponentUpdater<AssistantMessageComponent>[],
  expandable: ComponentUpdater<ExpandableComponent>[],
  options: PiConversationAdapterOptions,
  construct: (pending: PendingComponents) => void,
): void {
  const pending: PendingComponents = { children: [], assistants: [], expandable: [] };
  try {
    construct(pending);
    const firstChild = children.length;
    children.push(...pending.children);
    assistants.push(...pending.assistants.map((item) => ({ ...item, childIndex: firstChild + item.childIndex })));
    expandable.push(...pending.expandable.map((item) => ({ ...item, childIndex: firstChild + item.childIndex })));
  } catch {
    if (children.length > 0) children.push(new Spacer(1));
    children.push(new Text(options.theme.fg("warning", "Item unavailable"), NATIVE_OUTPUT_PAD, 0));
  }
}

function degradeBuiltItem(built: BuiltComponents, childIndex: number, options: PiConversationAdapterOptions): void {
  built.failedChildren.add(childIndex);
  built.children[childIndex] = new Text(options.theme.fg("warning", "Item unavailable"), NATIVE_OUTPUT_PAD, 0);
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
  factories: PiConversationAdapterFactories,
): ToolExecutionComponent {
  const definition = presentation.rendering === "renderer-override"
    ? factories.createPresentationToolDefinition(presentation.tool, options.theme)
    : undefined;
  return factories.createToolExecution(
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
