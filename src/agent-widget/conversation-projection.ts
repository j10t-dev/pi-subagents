import type {
  AgentRow,
  ConversationAssistantBlock,
  ConversationHeader,
  ConversationSnapshot,
  ConversationToolPresentation,
  ConversationToolRendering,
  ConversationTurn,
  SelectedTranscriptSnapshot,
  TranscriptItem,
  TranscriptSensitiveValues,
  TranscriptToolPresentation,
} from "../agent-observation.ts";
import { admitSafePresentationJson } from "../schemas.ts";
import {
  conversationCallKey,
  conversationRevision,
  conversationTurnKey,
  tryPresentationCwd,
  type ConversationRevision,
  type PresentationCwd,
  type SafePresentationJson,
} from "../domain.ts";

/** Pi's built-in tool names, whose renderers `ToolExecutionComponent` resolves unconditionally. */
export const NATIVE_BUILT_IN_TOOL_NAMES: ReadonlySet<string> = Object.freeze(
  new Set(["read", "bash", "edit", "write", "grep", "find", "ls"]),
) as ReadonlySet<string>;

/** Removes transcript correlation and native identity before any state reaches presentation code. */
export function projectConversationSnapshot(selected: SelectedTranscriptSnapshot): ConversationSnapshot {
  const revision = conversationRevision(
    Number(selected.transcript.revision) === 0 ? 0 : Number(selected.revision),
  );
  const sensitive = mergedSensitiveValues(selected.transcript.sensitiveValues);
  const renderingCwd = admitRenderingCwd(selected.transcript.renderingCwd, sensitive);
  const turns = Object.freeze(
    selected.transcript.items.map((item, index) => projectTurn(item, revision, index, sensitive, renderingCwd)),
  );
  return Object.freeze({
    revision,
    turns,
    truncatedBefore: selected.transcript.truncatedBefore,
    availability: selected.transcript.availability,
    header: projectHeader(selected.row),
    routeAvailable: selected.routeAvailable,
    ...(renderingCwd === undefined ? {} : { renderingCwd }),
  });
}

function mergedSensitiveValues(values: TranscriptSensitiveValues): ReadonlySet<string> {
  return Object.freeze(new Set<string>([...values.nativeIds, ...values.managedPathsAndNames])) as ReadonlySet<string>;
}

/** A working directory is local presentation data only; managed roots and identity are refused. */
function admitRenderingCwd(candidate: string | undefined, sensitive: ReadonlySet<string>): PresentationCwd | undefined {
  if (candidate === undefined) return undefined;
  const admitted = tryPresentationCwd(candidate);
  if (admitted === undefined) return undefined;
  for (const value of sensitive) {
    if (value.length > 0 && admitted.includes(value)) return undefined;
  }
  return admitted;
}

function projectTurn(
  item: TranscriptItem,
  revision: ConversationRevision,
  index: number,
  sensitive: ReadonlySet<string>,
  renderingCwd: PresentationCwd | undefined,
): ConversationTurn {
  const key = conversationTurnKey(revision, index);
  switch (item.kind) {
    case "user": return Object.freeze({ key, kind: "user", text: item.text });
    case "notice": return Object.freeze({ key, kind: "notice", code: item.code });
    case "assistant": return Object.freeze({
      key, kind: "assistant", phase: item.phase,
      ...(item.stopReason === undefined ? {} : { stopReason: item.stopReason }),
      blocks: Object.freeze(item.blocks.map((block, blockIndex): ConversationAssistantBlock => {
        if (block.kind !== "tool") return Object.freeze({ kind: block.kind, text: block.text });
        return Object.freeze({
          kind: "tool",
          presentation: projectTool(block.presentation, conversationCallKey(revision, index, blockIndex), sensitive, renderingCwd),
        });
      })),
    });
  }
}

function projectTool(
  presentation: TranscriptToolPresentation,
  callKey: ReturnType<typeof conversationCallKey>,
  sensitive: ReadonlySet<string>,
  renderingCwd: PresentationCwd | undefined,
): ConversationToolPresentation {
  const argumentsValue = presentation.arguments === undefined ? undefined : admitSafePresentationJson(presentation.arguments, sensitive);
  const details = presentation.result?.details === undefined ? undefined : admitSafePresentationJson(presentation.result.details, sensitive);
  const result = presentation.result === undefined ? undefined : Object.freeze({
    content: presentation.result.content,
    ...(details === undefined ? {} : { details }),
    isError: presentation.result.isError,
  });
  return Object.freeze({
    callKey, tool: presentation.tool, phase: presentation.phase,
    ...(argumentsValue === undefined ? {} : { arguments: argumentsValue }),
    ...(result === undefined ? {} : { result }),
    ...(presentation.preview === undefined ? {} : { preview: presentation.preview }),
    rendering: decideRendering(presentation, argumentsValue, renderingCwd),
  });
}

/**
 * Built-in name resolution inside `ToolExecutionComponent` cannot be suppressed, so an ineligible
 * built-in keeps the native shell and replaces both renderers instead of degrading to generic.
 */
function decideRendering(
  presentation: TranscriptToolPresentation,
  admittedArguments: SafePresentationJson | undefined,
  renderingCwd: PresentationCwd | undefined,
): ConversationToolRendering {
  if (!NATIVE_BUILT_IN_TOOL_NAMES.has(String(presentation.tool))) return "native-generic";
  if (renderingCwd === undefined || admittedArguments === undefined) return "renderer-override";
  if (typeof admittedArguments !== "object" || admittedArguments === null || Array.isArray(admittedArguments)) return "renderer-override";
  if (presentation.result !== undefined && presentation.result.details === undefined
    && presentation.arguments !== undefined && presentation.result.content.length === 0) return "renderer-override";
  return "native-built-in";
}

function projectHeader(row: AgentRow): ConversationHeader {
  return Object.freeze({ ordinal: row.ordinal, model: row.model, context: row.context, taskLabel: row.taskLabel, state: row.state });
}
