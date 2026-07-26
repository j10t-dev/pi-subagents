import { createHash } from "node:crypto";
import { isAbsolute } from "node:path";
import { Type, type Static } from "typebox";
import {
  AgentErrorCode,
  AgentState,
  CodedError,
  CompletionState,
  agentId,
  milliseconds,
  modelSpec,
  toolName,
  toAgentError,
  utf8Bytes,
  codedErrorToAgentError,
  isPublicPreflightError,
  agentCount,
  type AgentCompletion,
  type AgentCount,
  type AgentError,
  type AgentId,
  type AgentUsage,
  type RunId,
  type Utf8Bytes,
} from "./domain.ts";
import { AbortError } from "./async-primitives.ts";
import { MAX_AGGREGATE_AWAIT_BYTES, MAX_ERROR_MESSAGE_BYTES } from "./constants.ts";
import type { PublicStopOutcome, SpawnStartResult, StartResult, SubagentController } from "./controller.ts";
import type { AgentSummary, CompletionAwaitResult } from "./completion-service.ts";
import { renderLifecycleToolResult, type AgentDisplayResolver } from "./tool-presentation.ts";

export const spawnAgentSchema = Type.Object({
  task: Type.String({ description: "Literal first assignment for the fresh child session." }),
  model: Type.Optional(Type.String({
    description: "Optional child model pattern, for example gpt-5.6-luna, openai-codex/gpt-5.6-luna, or either with :high.",
  })),
  cwd: Type.Optional(Type.String({
    description: "Optional child working directory; defaults to the parent working directory.",
  })),
  tools: Type.Optional(Type.Array(Type.String(), {
    description: "Optional exact allowlist from parent-active tools; omission inherits eligible tools and [] enables none.",
  })),
}, {
  additionalProperties: false,
  description: "Start a fresh persistent child session asynchronously; collect completion with await_agent.",
});
export type SpawnAgentInput = Static<typeof spawnAgentSchema>;

export const sendInputSchema = Type.Object({
  agentId: Type.String(),
  message: Type.String(),
}, { additionalProperties: false });
export type SendInputInput = Static<typeof sendInputSchema>;

export const awaitAgentSchema = Type.Object({
  timeoutMs: Type.Optional(Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER })),
  afterAgentId: Type.Optional(Type.String({ minLength: 1, maxLength: 256 })),
}, { additionalProperties: false });
export type AwaitAgentInput = Static<typeof awaitAgentSchema>;

export interface AwaitInventoryPage {
  readonly total: AgentCount;
  readonly omitted: AgentCount;
  readonly remaining: AgentCount;
  readonly nextAfterAgentId?: AgentId;
  readonly agents: readonly AgentSummary[];
}

export interface AwaitAgentResult {
  readonly completions: readonly [] | readonly [AgentCompletion];
  readonly remainingCompletions: AgentCount;
  readonly inventory: AwaitInventoryPage;
  readonly timedOut: boolean;
}

export const stopAgentSchema = Type.Object({
  agentIds: Type.Array(Type.String(), { minItems: 1 }),
}, { additionalProperties: false });
export type StopAgentInput = Static<typeof stopAgentSchema>;

export const subagentToolSchemas = {
  spawn_agent: spawnAgentSchema,
  send_input: sendInputSchema,
  await_agent: awaitAgentSchema,
  stop_agent: stopAgentSchema,
} as const;

export type SubagentToolName = keyof typeof subagentToolSchemas;
export type SubagentToolInput<K extends SubagentToolName> =
  Static<(typeof subagentToolSchemas)[K]>;

export interface SubagentTool<K extends SubagentToolName> {
  readonly name: K;
  readonly description: string;
  readonly parameters: (typeof subagentToolSchemas)[K];
  execute(
    input: SubagentToolInput<K>,
    signal?: AbortSignal,
  ): Promise<{ content: string; details: object }>;
  renderResult?(result: object, options?: { readonly expanded: boolean }): string;
}

export type SubagentToolRegistry = {
  readonly [K in SubagentToolName]: SubagentTool<K>;
};

/** The controller surface required by public subagent tools. */
export type SubagentToolController = Pick<SubagentController, "spawn" | "sendInput" | "awaitReady" | "stop">;

type ToolStopOutcome = PublicStopOutcome | {
  agentId: string;
  runId?: RunId;
  state: "failed";
  agentState?: typeof AgentState.Settling | typeof AgentState.Stopping;
  error: AgentError;
};

export function createSubagentTools(
  controller: SubagentToolController,
  resolver: AgentDisplayResolver = { resolve: () => undefined },
): SubagentToolRegistry {
  const render = (name: SubagentToolName) => (result: object, options = { expanded: false }): string =>
    renderLifecycleToolResult(name, resultDetails(result), resolver, options);
  return {
    spawn_agent: tool("spawn_agent", "Start an isolated child agent assignment.", spawnAgentSchema,
      async (input) => executeSpawn(() => controller.spawn(input)), projectSpawnStart, render("spawn_agent"),
      undefined, { preservePublicPreflight: true }),
    send_input: tool("send_input", "Start a literal assignment on a stopped child agent.", sendInputSchema,
      async (input) => executeStart(() => controller.sendInput(agentId(input.agentId), input.message),
        AgentErrorCode.SessionUnavailable), projectStart, render("send_input")),
    await_agent: tool("await_agent", "Await one ready completion and page the owned-agent inventory.", awaitAgentSchema,
      async (input, signal) => projectAwaitResult(await controller.awaitReady({
        ...(input.timeoutMs === undefined ? {} : { timeoutMs: milliseconds(input.timeoutMs) }),
        ...(signal === undefined ? {} : { signal }),
      }), input.afterAgentId), projectAwait, render("await_agent"), boundAwaitContent),
    stop_agent: tool("stop_agent", "Stop one or more owned child agents.", stopAgentSchema,
      async (input) => {
        const outcomes: ToolStopOutcome[] = await Promise.all(input.agentIds.map(async (raw) => {
          let id: AgentId;
          try { id = agentId(raw); }
          catch { return failed(displayAgentId(raw), toAgentError(AgentErrorCode.InvalidAgent)); }
          try { return await controller.stop(id); }
          catch (error) { return failed(raw, stableError(error)); }
        }));
        return { outcomes };
      }, projectStop, render("stop_agent")),
  };
}

function tool<K extends SubagentToolName, TResult extends object>(
  name: K,
  description: string,
  parameters: (typeof subagentToolSchemas)[K],
  execute: (input: SubagentToolInput<K>, signal?: AbortSignal) => Promise<TResult>,
  project: (result: TResult) => object,
  renderResult: (result: object, options?: { readonly expanded: boolean }) => string,
  projectContent?: (details: object) => object,
  options: { preservePublicPreflight?: boolean } = {},
): SubagentTool<K> {
  return {
    name,
    description,
    parameters,
    execute: async (input, signal) => {
      let safeInput: SubagentToolInput<K>;
      try { safeInput = copyPublicInput(input) as SubagentToolInput<K>; }
      catch { throw invalidPublicResult(); }
      let result: TResult;
      try { result = await execute(safeInput, signal); }
      catch (error) {
        // A host-cancelled turn is not an extension failure: rethrow so Pi records the tool call
        // as cancelled rather than reporting a stable agent error code.
        if (isAbort(error)) throw error;
        if (options.preservePublicPreflight === true && isPublicPreflightError(error)) throw error;
        if (error instanceof CodedError) throw new CodedError(error.code, error.diagnosticsPath);
        let code: AgentErrorCode | undefined;
        try { code = stableErrorCode(error); }
        catch { throw invalidPublicResult(); }
        if (code !== undefined) throw new CodedError(code);
        throw invalidPublicResult();
      }
      try {
        const details = project(result);
        return bounded(details, projectContent?.(details));
      }
      catch { throw invalidPublicResult(); }
    },
    renderResult: (result, renderOptions) => {
      try { return renderResult(result, renderOptions); }
      catch { throw invalidPublicResult(); }
    },
  };
}

/** True for both this extension's `AbortError` and a host `DOMException` abort. */
function isAbort(error: unknown): boolean {
  return error instanceof AbortError || (error instanceof Error && error.name === "AbortError");
}

function copyPublicInput(value: unknown, seen = new WeakSet<object>()): unknown {
  if (value === null || typeof value === "string" || typeof value === "number" || typeof value === "boolean" || value === undefined) return value;
  if (typeof value !== "object" || seen.has(value)) throw invalidPublicResult();
  seen.add(value);
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null && !Array.isArray(value)) throw invalidPublicResult();
  const descriptors = Object.getOwnPropertyDescriptors(value);
  for (const descriptor of Object.values(descriptors)) {
    if (descriptor.get !== undefined || descriptor.set !== undefined) throw invalidPublicResult();
  }
  if (Array.isArray(value)) {
    const length = descriptors.length?.value;
    if (!Number.isSafeInteger(length) || length < 0) throw invalidPublicResult();
    const copy: unknown[] = [];
    for (let index = 0; index < length; index++) {
      const descriptor = descriptors[String(index)];
      if (descriptor === undefined || !("value" in descriptor)) throw invalidPublicResult();
      copy.push(copyPublicInput(descriptor.value, seen));
    }
    return copy;
  }
  const copy: Record<string, unknown> = {};
  for (const [key, descriptor] of Object.entries(descriptors)) {
    if (!descriptor.enumerable || !("value" in descriptor)) continue;
    copy[key] = copyPublicInput(descriptor.value, seen);
  }
  return copy;
}

function projectStart(value: StartResult): object {
  if (value.state === AgentState.Running) {
    return { agentId: value.agentId, runId: value.runId, state: value.state };
  }
  if (value.state === AgentState.Settling) {
    return { agentId: value.agentId, runId: value.runId, state: value.state, error: projectError(value.error) };
  }
  return { agentId: value.agentId, state: value.state, error: projectError(value.error) };
}

function projectSpawnStart(value: SpawnStartResult): object {
  if (value.state !== AgentState.Running) return projectStart(value);
  return {
    agentId: value.agentId,
    runId: value.runId,
    state: value.state,
    model: requiredCanonicalModelReference({ model: value.model }, "model"),
    thinkingLevel: value.thinkingLevel,
    tools: requiredToolArray({ tools: value.tools }, "tools"),
    ...(value.warning === undefined
      ? {}
      : { warning: requiredBoundedString({ warning: value.warning }, "warning", MAX_ERROR_MESSAGE_BYTES) }),
  };
}

function projectAwait(value: AwaitAgentResult): object {
  return {
    completions: value.completions.map(projectCompletion),
    remainingCompletions: value.remainingCompletions,
    inventory: {
      total: value.inventory.total,
      omitted: value.inventory.omitted,
      remaining: value.inventory.remaining,
      ...(value.inventory.nextAfterAgentId === undefined ? {} : { nextAfterAgentId: value.inventory.nextAfterAgentId }),
      agents: value.inventory.agents.map(projectAgentSummary),
    },
    timedOut: value.timedOut,
  };
}

function projectAwaitResult(value: CompletionAwaitResult, rawAfterAgentId?: string): AwaitAgentResult {
  const sorted = [...value.agents].sort((left, right) => left.agentId < right.agentId ? -1 : left.agentId > right.agentId ? 1 : 0);
  let after: AgentId | undefined;
  if (rawAfterAgentId !== undefined) after = agentId(rawAfterAgentId);
  const start = after === undefined ? 0 : sorted.findIndex((summary) => summary.agentId > after!);
  const offset = start < 0 ? sorted.length : start;
  const eligible = sorted.slice(offset, offset + 100);
  const total = agentCount(sorted.length);
  const candidates: AgentSummary[] = [];
  for (const candidate of eligible) {
    const tentative = [...candidates, candidate];
    const tentativeRemaining = agentCount(sorted.length - offset - tentative.length);
    const tentativeCursor = tentativeRemaining > 0 ? tentative.at(-1)?.agentId : undefined;
    const reserved: AwaitAgentResult = {
      completions: value.completion === undefined ? [] : [withoutCompletionText(value.completion)],
      remainingCompletions: value.remainingCompletions,
      inventory: { total, omitted: agentCount(sorted.length - tentative.length), remaining: tentativeRemaining, ...(tentativeCursor === undefined ? {} : { nextAfterAgentId: tentativeCursor }), agents: tentative },
      timedOut: value.timedOut,
    };
    if (jsonBytes(projectAwait(reserved)) > MAX_AGGREGATE_AWAIT_BYTES) break;
    candidates.push(candidate);
  }
  const omitted = agentCount(sorted.length - candidates.length);
  const remaining = agentCount(sorted.length - offset - candidates.length);
  const nextAfterAgentId = remaining > 0 ? candidates.at(-1)?.agentId : undefined;
  return {
    completions: value.completion === undefined ? [] : [value.completion],
    remainingCompletions: value.remainingCompletions,
    inventory: { total, omitted, remaining, ...(nextAfterAgentId === undefined ? {} : { nextAfterAgentId }), agents: candidates },
    timedOut: value.timedOut,
  };
}

function withoutCompletionText(completion: AgentCompletion): AgentCompletion {
  return {
    ...completion,
    output: {
      ...completion.output,
      text: "",
      retainedBytes: utf8Bytes(0),
      truncated: completion.output.originalBytes > 0,
    },
  };
}

/** Bounds only provider content; full projected details remain available to renderers. */
function boundAwaitContent(value: object): object {
  if (jsonBytes(value) <= MAX_AGGREGATE_AWAIT_BYTES) return value;
  const source = requiredRecord(value);
  const completions = requiredArray(source, "completions");
  if (completions.length > 1) throw invalidPublicResult();
  if (completions.length === 0) throw invalidPublicResult();
  const completion = requiredRecord(completions[0]);
  const output = requiredRecord(completion.output);
  const text = requiredString(output, "text");
  const originalRetainedBytes = requiredUtf8Bytes(output, "retainedBytes");
  const previouslyTruncated = requiredBoolean(output, "truncated");
  const materialise = (prefix: string): object => {
    const retainedBytes = utf8Bytes(new TextEncoder().encode(prefix).byteLength);
    return {
      ...source,
      completions: [{
        ...completion,
        output: {
          text: prefix,
          originalBytes: requiredUtf8Bytes(output, "originalBytes"),
          retainedBytes,
          truncated: previouslyTruncated || retainedBytes < originalRetainedBytes,
        },
      }],
    };
  };
  if (jsonBytes(materialise("")) > MAX_AGGREGATE_AWAIT_BYTES) throw invalidPublicResult();
  const points = [...text];
  let low = 0;
  let high = points.length;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (jsonBytes(materialise(points.slice(0, middle).join(""))) <= MAX_AGGREGATE_AWAIT_BYTES) low = middle;
    else high = middle - 1;
  }
  return materialise(points.slice(0, low).join(""));
}

function jsonBytes(value: object): Utf8Bytes {
  return utf8Bytes(new TextEncoder().encode(JSON.stringify(value)).byteLength);
}

function projectStop(value: { outcomes: ToolStopOutcome[] }): object {
  return { outcomes: value.outcomes.map((outcome) => {
    if (outcome.state === "cancelled") {
      return { agentId: outcome.agentId, runId: outcome.runId, state: outcome.state };
    }
    if (outcome.state === "already_stopped") return { agentId: outcome.agentId, state: outcome.state };
    return {
      agentId: outcome.agentId,
      ...(outcome.runId === undefined ? {} : { runId: outcome.runId }),
      state: outcome.state,
      ...(outcome.agentState === undefined ? {} : { agentState: outcome.agentState }),
      error: projectError(outcome.error),
    };
  }) };
}

function projectCompletion(completion: AgentCompletion): object {
  const base = {
    agentId: completion.agentId,
    runId: completion.runId,
    state: completion.state,
    output: projectOutput(completion.output),
    outputPath: requiredPath({ outputPath: completion.outputPath }, "outputPath"),
    transcriptPath: requiredPath({ transcriptPath: completion.transcriptPath }, "transcriptPath"),
    ...(completion.usage === undefined ? {} : { usage: projectAgentUsage(completion.usage) }),
  };
  if (completion.state === CompletionState.Failed) return { ...base, error: projectError(completion.error) };
  if (completion.state === CompletionState.Cancelled) return { ...base, reason: completion.reason };
  return base;
}

function projectAgentSummary(summary: AgentSummary): object {
  return {
    agentId: summary.agentId,
    state: summary.state,
    transcriptPath: requiredPath({ transcriptPath: summary.transcriptPath }, "transcriptPath"),
    ...(summary.currentRunId === undefined ? {} : { currentRunId: summary.currentRunId }),
    ...(summary.latestCompletionState === undefined ? {} : { latestCompletionState: summary.latestCompletionState }),
    ...(summary.latestOutputPath === undefined ? {} : { latestOutputPath: requiredPath({ latestOutputPath: summary.latestOutputPath }, "latestOutputPath") }),
  };
}

function projectOutput(value: unknown): object {
  const output = requiredRecord(value);
  const text = requiredString(output, "text");
  const originalBytes = requiredUtf8Bytes(output, "originalBytes");
  const retainedBytes = requiredUtf8Bytes(output, "retainedBytes");
  const truncated = requiredBoolean(output, "truncated");
  const actualBytes = utf8Bytes(new TextEncoder().encode(text).byteLength);
  if (retainedBytes !== actualBytes || originalBytes < retainedBytes || truncated !== (retainedBytes < originalBytes)) throw invalidPublicResult();
  return { text, originalBytes, retainedBytes, truncated };
}

function projectAgentUsage(agentUsage: AgentUsage): object {
  const agentUsageRecord = { turns: agentUsage.turns };
  const usage = {
    input: agentUsage.usage.input,
    output: agentUsage.usage.output,
    cacheRead: agentUsage.usage.cacheRead,
    cacheWrite: agentUsage.usage.cacheWrite,
    cacheWrite1h: agentUsage.usage.cacheWrite1h,
    reasoning: agentUsage.usage.reasoning,
    totalTokens: agentUsage.usage.totalTokens,
  };
  const cost = {
    input: agentUsage.usage.cost.input,
    output: agentUsage.usage.cost.output,
    cacheRead: agentUsage.usage.cost.cacheRead,
    cacheWrite: agentUsage.usage.cost.cacheWrite,
    total: agentUsage.usage.cost.total,
  };
  return {
    turns: requiredNonnegativeInteger(agentUsageRecord, "turns"),
    usage: {
      input: requiredNonnegativeNumber(usage, "input"), output: requiredNonnegativeNumber(usage, "output"),
      cacheRead: requiredNonnegativeNumber(usage, "cacheRead"), cacheWrite: requiredNonnegativeNumber(usage, "cacheWrite"),
      ...optionalNumberField(usage, "cacheWrite1h"),
      ...optionalNumberField(usage, "reasoning"),
      totalTokens: requiredNonnegativeNumber(usage, "totalTokens"),
      cost: {
        input: requiredNonnegativeNumber(cost, "input"), output: requiredNonnegativeNumber(cost, "output"),
        cacheRead: requiredNonnegativeNumber(cost, "cacheRead"), cacheWrite: requiredNonnegativeNumber(cost, "cacheWrite"),
        total: requiredNonnegativeNumber(cost, "total"),
      },
    },
  };
}

function projectError(error: AgentError): object {
  if (error.diagnosticsPath === undefined) return toAgentError(error.code);
  requiredPath({ diagnosticsPath: error.diagnosticsPath }, "diagnosticsPath");
  return toAgentError(error.code, error.diagnosticsPath);
}

function requiredRecord(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw invalidPublicResult();
  return value as Record<string, unknown>;
}

function requiredArray(value: Record<string, unknown>, key: string): unknown[] {
  const item = value[key];
  if (!Array.isArray(item)) throw invalidPublicResult();
  return item;
}

function requiredString(value: Record<string, unknown>, key: string): string {
  const item = value[key];
  if (typeof item !== "string") throw invalidPublicResult();
  return item;
}

function requiredCanonicalModelReference(value: Record<string, unknown>, key: string): string {
  const item = requiredBoundedString(value, key, utf8Bytes(1_024));
  try { return modelSpec(item); }
  catch { throw invalidPublicResult(); }
}

function requiredToolArray(value: Record<string, unknown>, key: string): string[] {
  const items = requiredArray(value, key);
  if (items.length > 1_024) throw invalidPublicResult();
  return items.map((item) => {
    if (typeof item !== "string") throw invalidPublicResult();
    try { return toolName(item); }
    catch { throw invalidPublicResult(); }
  });
}

function requiredNonnegativeNumber(value: Record<string, unknown>, key: string): number {
  const item = value[key];
  if (typeof item !== "number" || !Number.isFinite(item) || item < 0) throw invalidPublicResult();
  return item;
}

function requiredNonnegativeInteger(value: Record<string, unknown>, key: string): number {
  const item = requiredNonnegativeNumber(value, key);
  if (!Number.isInteger(item)) throw invalidPublicResult();
  return item;
}

function requiredUtf8Bytes(value: Record<string, unknown>, key: string): Utf8Bytes {
  return utf8Bytes(requiredNonnegativeInteger(value, key));
}

function requiredBoolean(value: Record<string, unknown>, key: string): boolean {
  const item = value[key];
  if (typeof item !== "boolean") throw invalidPublicResult();
  return item;
}

function requiredBoundedString(value: Record<string, unknown>, key: string, maxBytes: Utf8Bytes): string {
  const item = requiredString(value, key);
  if (item.length === 0 || new TextEncoder().encode(item).byteLength > maxBytes) throw invalidPublicResult();
  return item;
}

const MAX_PUBLIC_PATH_BYTES = utf8Bytes(4_096);

function requiredPath(value: Record<string, unknown>, key: string): string {
  const item = requiredString(value, key);
  if (!isAbsolute(item) || item.includes("\0") || new TextEncoder().encode(item).byteLength > MAX_PUBLIC_PATH_BYTES) throw invalidPublicResult();
  return item;
}

function optionalNumberField(value: Record<string, unknown>, key: string): Record<string, number> {
  if (value[key] === undefined) return {};
  return { [key]: requiredNonnegativeNumber(value, key) };
}

function invalidPublicResult(): Error {
  return new CodedError(AgentErrorCode.InternalError);
}

function bounded<TResult extends object>(details: TResult, contentDetails: object = details): { content: string; details: TResult } {
  return { content: JSON.stringify(contentDetails), details };
}

function failed(agentId: string, error: AgentError): ToolStopOutcome {
  return { agentId, state: "failed" as const, error };
}

/** Stable, schema-valid display identity for an invalid untrusted input without echoing it. */
function displayAgentId(raw: string): string {
  return `invalid-${createHash("sha256").update(raw).digest("hex").slice(0, 24)}`;
}

function stableError(error: unknown): AgentError {
  if (error instanceof CodedError) return codedErrorToAgentError(error);
  return toAgentError(stableErrorCode(error) ?? AgentErrorCode.InvalidState);
}

async function executeStart<TResult extends object>(operation: () => Promise<TResult>, fallbackCode: AgentErrorCode): Promise<TResult> {
  try { return await operation(); }
  catch (error) { throw stableOperationError(error, fallbackCode); }
}

async function executeSpawn(operation: () => Promise<SpawnStartResult>): Promise<SpawnStartResult> {
  try {
    return await operation();
  } catch (error) {
    if (isPublicPreflightError(error)) throw error;
    throw stableOperationError(error, AgentErrorCode.SpawnFailed);
  }
}

function stableOperationError(error: unknown, fallbackCode: AgentErrorCode): Error {
  const stable = stableError(error);
  const projected = stable.code === AgentErrorCode.InvalidState && !hasStableCode(error)
    ? toAgentError(fallbackCode)
    : stable;
  return new CodedError(projected.code, projected.diagnosticsPath);
}

function hasStableCode(error: unknown): boolean {
  return stableErrorCode(error) !== undefined;
}

function stableErrorCode(error: unknown): AgentErrorCode | undefined {
  try {
    if (error instanceof CodedError || isPublicPreflightError(error)) return error.code;
    if (error instanceof Error) {
      const code = /^([a-z_]+):/.exec(error.message)?.[1] as AgentErrorCode | undefined;
      return Object.values(AgentErrorCode).includes(code as AgentErrorCode) ? code : undefined;
    }
    if (typeof error !== "object" || error === null) return undefined;
    const code = (error as { code?: unknown }).code;
    return Object.values(AgentErrorCode).includes(code as AgentErrorCode) ? code as AgentErrorCode : undefined;
  } catch { return undefined; }
}

function resultDetails(result: object): Record<string, unknown> {
  const outer = result as Record<string, unknown>;
  const details = outer.details;
  return typeof details === "object" && details !== null ? details as Record<string, unknown> : outer;
}
