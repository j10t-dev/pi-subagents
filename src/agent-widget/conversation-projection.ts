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
    selected.transcript.items.map((item, index) => projectTurn(
      item, revision, index, sensitive, selected.transcript.sensitiveValues.overflowed, renderingCwd,
    )),
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
  sensitiveOverflowed: boolean,
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
          presentation: projectTool(
            block.presentation, conversationCallKey(revision, index, blockIndex), sensitive, sensitiveOverflowed, renderingCwd,
          ),
        });
      })),
    });
  }
}

function projectTool(
  presentation: TranscriptToolPresentation,
  callKey: ReturnType<typeof conversationCallKey>,
  sensitive: ReadonlySet<string>,
  sensitiveOverflowed: boolean,
  renderingCwd: PresentationCwd | undefined,
): ConversationToolPresentation {
  const argumentsValue = sensitiveOverflowed || presentation.arguments === undefined
    ? undefined
    : admitSafePresentationJson(presentation.arguments, sensitive);
  const details = sensitiveOverflowed || presentation.result?.details === undefined
    ? undefined
    : admitSafePresentationJson(presentation.result.details, sensitive);
  const content = sensitiveOverflowed
    ? undefined
    : presentation.result?.content.filter((text) => !containsSensitiveText(text, sensitive));
  const result = sensitiveOverflowed || presentation.result === undefined ? undefined : Object.freeze({
    content: Object.freeze(content ?? []),
    ...(details === undefined ? {} : { details }),
    isError: presentation.result.isError,
  });
  const preview = sensitiveOverflowed || presentation.preview === undefined || containsSensitiveText(presentation.preview, sensitive)
    ? undefined
    : presentation.preview;
  return Object.freeze({
    callKey, tool: presentation.tool, phase: presentation.phase,
    ...(argumentsValue === undefined ? {} : { arguments: argumentsValue }),
    ...(result === undefined ? {} : { result }),
    ...(preview === undefined ? {} : { preview }),
    rendering: sensitiveOverflowed
      ? "renderer-override"
      : decideRendering(presentation, argumentsValue, details, content, renderingCwd),
  });
}

/**
 * Built-in name resolution inside `ToolExecutionComponent` cannot be suppressed, so an ineligible
 * built-in keeps the native shell and replaces both renderers instead of degrading to generic.
 */
function decideRendering(
  presentation: TranscriptToolPresentation,
  admittedArguments: SafePresentationJson | undefined,
  admittedDetails: SafePresentationJson | undefined,
  admittedContent: readonly string[] | undefined,
  renderingCwd: PresentationCwd | undefined,
): ConversationToolRendering {
  const name = String(presentation.tool);
  if (!NATIVE_BUILT_IN_TOOL_NAMES.has(name)) return "native-generic";
  if (renderingCwd === undefined || admittedArguments === undefined) return "renderer-override";
  if (!compatibleBuiltInArguments(name, admittedArguments)) return "renderer-override";
  if (presentation.result?.details !== undefined && admittedDetails === undefined) return "renderer-override";
  if (presentation.phase !== "running"
    && (presentation.result === undefined || admittedContent === undefined || admittedContent.length === 0)) {
    return "renderer-override";
  }
  if (!compatibleBuiltInDetails(name, admittedDetails)) return "renderer-override";
  return "native-built-in";
}

function compatibleBuiltInArguments(name: string, value: SafePresentationJson): boolean {
  const record = jsonRecord(value);
  if (record === undefined) return false;
  switch (name) {
    case "read": return stringField(record, "path") && optionalNumber(record, "offset") && optionalNumber(record, "limit");
    case "bash": return stringField(record, "command") && optionalNumber(record, "timeout");
    case "edit": return stringField(record, "path") && Array.isArray(record.edits)
      && record.edits.every((edit) => {
        const item = jsonRecord(edit);
        return item !== undefined && stringField(item, "oldText") && stringField(item, "newText");
      });
    case "write": return stringField(record, "path") && stringField(record, "content");
    case "grep": return stringField(record, "pattern") && optionalString(record, "path")
      && optionalString(record, "glob") && optionalBoolean(record, "ignoreCase")
      && optionalBoolean(record, "literal") && optionalNumber(record, "context") && optionalNumber(record, "limit");
    case "find": return stringField(record, "pattern") && optionalString(record, "path") && optionalNumber(record, "limit");
    case "ls": return optionalString(record, "path") && optionalNumber(record, "limit");
    default: return false;
  }
}

function compatibleBuiltInDetails(name: string, value: SafePresentationJson | undefined): boolean {
  if (value === undefined) return true;
  const record = jsonRecord(value);
  if (record === undefined) return false;
  switch (name) {
    case "read": return onlyFields(record, ["truncation"]) && optionalTruncation(record, "truncation");
    case "bash": return onlyFields(record, ["truncation", "fullOutputPath"])
      && optionalTruncation(record, "truncation") && optionalString(record, "fullOutputPath");
    case "edit": return onlyFields(record, ["diff", "patch", "firstChangedLine"])
      && stringField(record, "diff") && stringField(record, "patch") && optionalNumber(record, "firstChangedLine");
    case "write": return false;
    case "grep": return onlyFields(record, ["truncation", "matchLimitReached", "linesTruncated"])
      && optionalTruncation(record, "truncation") && optionalNumber(record, "matchLimitReached")
      && optionalBoolean(record, "linesTruncated");
    case "find": return onlyFields(record, ["truncation", "resultLimitReached"])
      && optionalTruncation(record, "truncation") && optionalNumber(record, "resultLimitReached");
    case "ls": return onlyFields(record, ["truncation", "entryLimitReached"])
      && optionalTruncation(record, "truncation") && optionalNumber(record, "entryLimitReached");
    default: return false;
  }
}

function optionalTruncation(record: Readonly<Record<string, unknown>>, key: string): boolean {
  if (!(key in record)) return true;
  const value = jsonRecord(record[key]);
  return value !== undefined
    && onlyFields(value, [
      "content", "truncated", "truncatedBy", "totalLines", "totalBytes", "outputLines", "outputBytes",
      "lastLinePartial", "firstLineExceedsLimit", "maxLines", "maxBytes",
    ])
    && stringField(value, "content")
    && typeof value.truncated === "boolean"
    && (value.truncatedBy === "lines" || value.truncatedBy === "bytes" || value.truncatedBy === null)
    && ["totalLines", "totalBytes", "outputLines", "outputBytes", "maxLines", "maxBytes"].every((field) => numberField(value, field))
    && typeof value.lastLinePartial === "boolean"
    && typeof value.firstLineExceedsLimit === "boolean";
}

function jsonRecord(value: unknown): Readonly<Record<string, unknown>> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Readonly<Record<string, unknown>>
    : undefined;
}
function stringField(record: Readonly<Record<string, unknown>>, key: string): boolean { return typeof record[key] === "string"; }
function numberField(record: Readonly<Record<string, unknown>>, key: string): boolean { return typeof record[key] === "number" && Number.isFinite(record[key]); }
function optionalString(record: Readonly<Record<string, unknown>>, key: string): boolean { return !(key in record) || stringField(record, key); }
function optionalNumber(record: Readonly<Record<string, unknown>>, key: string): boolean { return !(key in record) || numberField(record, key); }
function optionalBoolean(record: Readonly<Record<string, unknown>>, key: string): boolean { return !(key in record) || typeof record[key] === "boolean"; }
function onlyFields(record: Readonly<Record<string, unknown>>, fields: readonly string[]): boolean {
  const admitted = new Set(fields);
  return Object.keys(record).every((key) => admitted.has(key));
}
function containsSensitiveText(text: string, sensitive: ReadonlySet<string>): boolean {
  return [...sensitive].some((value) => value.length > 0 && text.includes(value));
}

function projectHeader(row: AgentRow): ConversationHeader {
  return Object.freeze({ ordinal: row.ordinal, model: row.model, context: row.context, taskLabel: row.taskLabel, state: row.state });
}
