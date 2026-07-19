import { createHash } from "node:crypto";
import { isAbsolute } from "node:path";
import { Type, type Static } from "typebox";
import {
  AgentErrorCode,
  AgentState,
  CancellationReason,
  CompletionState,
  THINKING_LEVELS,
  agentId,
  milliseconds,
  runId,
  toAgentError,
  truncateUtf8,
  isPublicPreflightError,
  type AgentError,
  type AgentId,
  type DiagnosticsPath,
} from "./domain.ts";
import { AbortError } from "./async-primitives.ts";
import { MAX_AGGREGATE_RECEIVE_BYTES, MAX_ERROR_MESSAGE_BYTES } from "./constants.ts";
import type { SpawnStartResult, StartResult, SubagentController } from "./controller.ts";

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
  description: "Start a fresh persistent child session asynchronously; collect completion with receive_agent.",
});
export type SpawnAgentInput = Static<typeof spawnAgentSchema>;

export const sendInputSchema = Type.Object({
  agentId: Type.String(),
  message: Type.String(),
}, { additionalProperties: false });
export type SendInputInput = Static<typeof sendInputSchema>;

export const receiveAgentSchema = Type.Object({
  timeoutMs: Type.Optional(Type.Integer({ minimum: 0 })),
}, { additionalProperties: false });
export type ReceiveAgentInput = Static<typeof receiveAgentSchema>;

export const stopAgentSchema = Type.Object({
  agentIds: Type.Array(Type.String(), { minItems: 1 }),
}, { additionalProperties: false });
export type StopAgentInput = Static<typeof stopAgentSchema>;

export const subagentToolSchemas = {
  spawn_agent: spawnAgentSchema,
  send_input: sendInputSchema,
  receive_agent: receiveAgentSchema,
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
  renderResult?(result: object): string;
}

export type SubagentToolRegistry = {
  readonly [K in SubagentToolName]: SubagentTool<K>;
};

/** The controller surface required by public subagent tools. */
export type SubagentToolController = Pick<SubagentController, "spawn" | "sendInput" | "receive" | "stop">;

export function createSubagentTools(controller: SubagentToolController): SubagentToolRegistry {
  return {
    spawn_agent: tool("spawn_agent", "Start an isolated child agent assignment.", spawnAgentSchema,
      async (input) => executeSpawn(() => controller.spawn(input)), projectSpawnStart, renderStart,
      undefined, { preservePublicPreflight: true }),
    send_input: tool("send_input", "Start a literal assignment on a stopped child agent.", sendInputSchema,
      async (input) => executeStart(() => controller.sendInput(agentId(input.agentId), input.message),
        AgentErrorCode.SessionUnavailable), projectStart, renderStart),
    receive_agent: tool("receive_agent", "Receive ready completions and the complete owned-agent inventory.", receiveAgentSchema,
      async (input, signal) => controller.receive({
        ...(input.timeoutMs === undefined ? {} : { timeoutMs: milliseconds(input.timeoutMs) }),
        ...(signal === undefined ? {} : { signal }),
      }), projectReceive, renderReceive, boundReceiveContent),
    stop_agent: tool("stop_agent", "Stop one or more owned child agents.", stopAgentSchema,
      async (input) => {
        const outcomes = await Promise.all(input.agentIds.map(async (raw) => {
          let id: AgentId;
          try { id = agentId(raw); }
          catch { return failed(displayAgentId(raw), toAgentError(undefined, AgentErrorCode.InvalidAgent)); }
          try { return await controller.stop(id); }
          catch (error) { return failed(raw, stableError(error)); }
        }));
        return { outcomes };
      }, projectStop, renderStop),
  };
}

function tool<K extends SubagentToolName, TResult extends object>(
  name: K,
  description: string,
  parameters: (typeof subagentToolSchemas)[K],
  execute: (input: SubagentToolInput<K>, signal?: AbortSignal) => Promise<TResult>,
  project: (result: TResult) => object,
  renderResult: (result: object) => string,
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
        let code: AgentErrorCode | undefined;
        try { code = stableErrorCode(error); }
        catch { throw invalidPublicResult(); }
        if (code !== undefined) {
          const stable = toAgentError(undefined, code);
          throw new Error(`${stable.code}: ${stable.message}`);
        }
        throw invalidPublicResult();
      }
      try {
        const details = project(result);
        return bounded(details, projectContent?.(details));
      }
      catch { throw invalidPublicResult(); }
    },
    renderResult: (result) => {
      try { return renderResult(result); }
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
  const source = requiredRecord(value);
  const state = requiredLiteral(source, "state", Object.values(AgentState));
  if (state === AgentState.Running) {
    return { agentId: requiredAgentId(source, "agentId"), runId: requiredRunId(source, "runId"), state };
  }
  if (state === AgentState.Settling) {
    return { agentId: requiredAgentId(source, "agentId"), runId: requiredRunId(source, "runId"), state, error: projectError(source.error) };
  }
  if (state !== AgentState.Stopped && state !== AgentState.Stopping) throw invalidPublicResult();
  return { agentId: requiredAgentId(source, "agentId"), state, error: projectError(source.error) };
}

function projectSpawnStart(value: SpawnStartResult): object {
  const source = requiredRecord(value);
  const state = requiredLiteral(source, "state", Object.values(AgentState));
  if (state !== AgentState.Running) return projectStart(value);
  return {
    agentId: requiredAgentId(source, "agentId"),
    runId: requiredRunId(source, "runId"),
    state,
    model: requiredCanonicalModelReference(source, "model"),
    thinkingLevel: requiredLiteral(source, "thinkingLevel", THINKING_LEVELS),
    tools: requiredToolArray(source, "tools"),
    ...(source.warning === undefined ? {} : { warning: requiredBoundedString(source, "warning", MAX_ERROR_MESSAGE_BYTES) }),
  };
}

function projectReceive(value: object): object {
  const source = requiredRecord(value);
  return {
    completions: requiredArray(source, "completions").map(projectCompletion),
    agents: requiredArray(source, "agents").map(projectAgentSummary),
    timedOut: requiredBoolean(source, "timedOut"),
  };
}

/** Keeps the complete inventory while re-budgeting inline output so provider-visible JSON stays bounded. */
function boundReceiveContent(value: object): object {
  if (jsonBytes(value) <= MAX_AGGREGATE_RECEIVE_BYTES) return value;
  const source = requiredRecord(value);
  const completions = requiredArray(source, "completions");
  const retained = completions.reduce<number>((total, completion) => {
    const output = requiredRecord(requiredRecord(completion).output);
    return total + requiredNonnegativeInteger(output, "retainedBytes");
  }, 0);
  let low = 0;
  let high = retained;
  let best = rebudgetReceive(source, completions, 0);
  if (jsonBytes(best) > MAX_AGGREGATE_RECEIVE_BYTES) {
    const agents = requiredArray(source, "agents").map((value) => {
      const agent = requiredRecord(value);
      return {
        agentId: requiredString(agent, "agentId"),
        state: requiredString(agent, "state"),
        ...optionalStringContentField(agent, "currentRunId"),
        ...optionalStringContentField(agent, "latestCompletionState"),
      };
    });
    const compactSource = { ...source, agents };
    if (jsonBytes(rebudgetReceive(compactSource, completions, 0)) > MAX_AGGREGATE_RECEIVE_BYTES) throw invalidPublicResult();
    return boundReceiveContent(compactSource);
  }
  while (low <= high) {
    const middle = Math.floor((low + high) / 2);
    const candidate = rebudgetReceive(source, completions, middle);
    if (jsonBytes(candidate) <= MAX_AGGREGATE_RECEIVE_BYTES) {
      best = candidate;
      low = middle + 1;
    } else high = middle - 1;
  }
  if (jsonBytes(best) > MAX_AGGREGATE_RECEIVE_BYTES) throw invalidPublicResult();
  return best;
}

function optionalStringContentField(value: Record<string, unknown>, key: string): Record<string, string> {
  return value[key] === undefined ? {} : { [key]: requiredString(value, key) };
}

function rebudgetReceive(
  source: Record<string, unknown>,
  completions: unknown[],
  outputBudget: number,
): object {
  let remaining = outputBudget;
  const boundedCompletions = completions.map((value) => {
    const completion = requiredRecord(value);
    const output = requiredRecord(completion.output);
    const text = requiredString(output, "text");
    const originalBytes = requiredNonnegativeInteger(output, "originalBytes");
    const boundedOutput = truncateUtf8(text, remaining);
    remaining -= boundedOutput.retainedBytes;
    return {
      ...completion,
      output: {
        text: boundedOutput.text,
        originalBytes,
        retainedBytes: boundedOutput.retainedBytes,
        truncated: boundedOutput.retainedBytes < originalBytes,
      },
    };
  });
  return { ...source, completions: boundedCompletions };
}

function jsonBytes(value: object): number {
  return new TextEncoder().encode(JSON.stringify(value)).byteLength;
}

function projectStop(value: object): object {
  const source = requiredRecord(value);
  return { outcomes: requiredArray(source, "outcomes").map((item) => {
    const outcome = requiredRecord(item);
    const state = requiredLiteral(outcome, "state", ["cancelled", "already_stopped", "failed"] as const);
    if (state === "cancelled") {
      return { agentId: requiredAgentId(outcome, "agentId"), runId: requiredRunId(outcome, "runId"), state };
    }
    if (state === "already_stopped") return { agentId: requiredAgentId(outcome, "agentId"), state };
    if (state !== "failed") throw invalidPublicResult();
    return {
      agentId: requiredBoundedString(outcome, "agentId", 256),
      ...optionalRunIdField(outcome, "runId"),
      state,
      ...optionalLiteralField(outcome, "agentState", [AgentState.Settling, AgentState.Stopping] as const),
      error: projectError(outcome.error),
    };
  }) };
}

function projectCompletion(value: unknown): object {
  const completion = requiredRecord(value);
  const state = requiredLiteral(completion, "state", Object.values(CompletionState));
  const base = {
    agentId: requiredAgentId(completion, "agentId"),
    runId: requiredRunId(completion, "runId"),
    state,
    output: projectOutput(completion.output),
    outputPath: requiredPath(completion, "outputPath"),
    transcriptPath: requiredPath(completion, "transcriptPath"),
    ...optionalProjectedField(completion, "usage", projectAgentUsage),
  };
  if (state === CompletionState.Failed) return { ...base, error: projectError(completion.error) };
  if (state === CompletionState.Cancelled) return { ...base, reason: requiredLiteral(completion, "reason", Object.values(CancellationReason)) };
  if (state !== CompletionState.Completed) throw invalidPublicResult();
  return base;
}

function projectAgentSummary(value: unknown): object {
  const summary = requiredRecord(value);
  return {
    agentId: requiredAgentId(summary, "agentId"),
    state: requiredLiteral(summary, "state", Object.values(AgentState)),
    transcriptPath: requiredPath(summary, "transcriptPath"),
    ...optionalRunIdField(summary, "currentRunId"),
    ...optionalLiteralField(summary, "latestCompletionState", Object.values(CompletionState)),
    ...optionalPathField(summary, "latestOutputPath"),
  };
}

function projectOutput(value: unknown): object {
  const output = requiredRecord(value);
  const text = requiredString(output, "text");
  const originalBytes = requiredNonnegativeInteger(output, "originalBytes");
  const retainedBytes = requiredNonnegativeInteger(output, "retainedBytes");
  const truncated = requiredBoolean(output, "truncated");
  const actualBytes = new TextEncoder().encode(text).byteLength;
  if (retainedBytes !== actualBytes || originalBytes < retainedBytes || truncated !== (retainedBytes < originalBytes)) throw invalidPublicResult();
  return { text, originalBytes, retainedBytes, truncated };
}

function projectAgentUsage(value: unknown): object {
  const agentUsage = requiredRecord(value);
  const usage = requiredRecord(agentUsage.usage);
  const cost = requiredRecord(usage.cost);
  return {
    turns: requiredNonnegativeInteger(agentUsage, "turns"),
    usage: {
      input: requiredNonnegativeNumber(usage, "input"), output: requiredNonnegativeNumber(usage, "output"),
      cacheRead: requiredNonnegativeNumber(usage, "cacheRead"), cacheWrite: requiredNonnegativeNumber(usage, "cacheWrite"),
      ...optionalNumberField(usage, "cacheWrite1h"), ...optionalNumberField(usage, "reasoning"),
      totalTokens: requiredNonnegativeNumber(usage, "totalTokens"),
      cost: {
        input: requiredNonnegativeNumber(cost, "input"), output: requiredNonnegativeNumber(cost, "output"),
        cacheRead: requiredNonnegativeNumber(cost, "cacheRead"), cacheWrite: requiredNonnegativeNumber(cost, "cacheWrite"),
        total: requiredNonnegativeNumber(cost, "total"),
      },
    },
  };
}

function projectError(value: unknown): object {
  const error = requiredRecord(value);
  const code = requiredLiteral(error, "code", Object.values(AgentErrorCode));
  const diagnostics = optionalPathField(error, "diagnosticsPath").diagnosticsPath;
  return toAgentError(undefined, code, diagnostics as DiagnosticsPath | undefined);
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
  const item = requiredBoundedString(value, key, 1_024);
  const separator = item.indexOf("/");
  if (separator <= 0 || separator === item.length - 1 || item !== item.trim() || /[\u0000-\u001f\u007f]/u.test(item)) throw invalidPublicResult();
  return item;
}

function requiredToolArray(value: Record<string, unknown>, key: string): string[] {
  const items = requiredArray(value, key);
  if (items.length > 1_024) throw invalidPublicResult();
  return items.map((item) => {
    if (typeof item !== "string" || item.length === 0 || new TextEncoder().encode(item).byteLength > 256 || /[\u0000-\u001f\u007f]/u.test(item)) {
      throw invalidPublicResult();
    }
    return item;
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

function requiredBoolean(value: Record<string, unknown>, key: string): boolean {
  const item = value[key];
  if (typeof item !== "boolean") throw invalidPublicResult();
  return item;
}

function requiredLiteral<const T extends readonly string[]>(value: Record<string, unknown>, key: string, allowed: T): T[number] {
  const item = requiredString(value, key);
  if (!allowed.includes(item)) throw invalidPublicResult();
  return item;
}

function requiredAgentId(value: Record<string, unknown>, key: string): string {
  const item = requiredString(value, key);
  try { agentId(item); } catch { throw invalidPublicResult(); }
  return item;
}

function requiredBoundedString(value: Record<string, unknown>, key: string, maxBytes: number): string {
  const item = requiredString(value, key);
  if (item.length === 0 || new TextEncoder().encode(item).byteLength > maxBytes) throw invalidPublicResult();
  return item;
}

function requiredRunId(value: Record<string, unknown>, key: string): string {
  const item = requiredString(value, key);
  try { runId(item); } catch { throw invalidPublicResult(); }
  return item;
}

const MAX_PUBLIC_PATH_BYTES = 4_096;

function requiredPath(value: Record<string, unknown>, key: string): string {
  const item = requiredString(value, key);
  if (!isAbsolute(item) || item.includes("\0") || new TextEncoder().encode(item).byteLength > MAX_PUBLIC_PATH_BYTES) throw invalidPublicResult();
  return item;
}

function optionalRunIdField(value: Record<string, unknown>, key: string): Record<string, string> {
  if (value[key] === undefined) return {};
  return { [key]: requiredRunId(value, key) };
}

function optionalPathField(value: Record<string, unknown>, key: string): Record<string, string> {
  if (value[key] === undefined) return {};
  return { [key]: requiredPath(value, key) };
}

function optionalLiteralField<const T extends readonly string[]>(value: Record<string, unknown>, key: string, allowed: T): Record<string, T[number]> {
  if (value[key] === undefined) return {};
  return { [key]: requiredLiteral(value, key, allowed) };
}

function optionalNumberField(value: Record<string, unknown>, key: string): Record<string, number> {
  if (value[key] === undefined) return {};
  return { [key]: requiredNonnegativeNumber(value, key) };
}

function optionalProjectedField(value: Record<string, unknown>, key: string, project: (item: unknown) => object): object {
  return value[key] === undefined ? {} : { [key]: project(value[key]) };
}

function invalidPublicResult(): Error {
  const error = toAgentError(undefined, AgentErrorCode.InternalError);
  return new Error(`${error.code}: ${error.message}`);
}

function bounded<TResult extends object>(details: TResult, contentDetails: object = details): { content: string; details: TResult } {
  return { content: JSON.stringify(contentDetails), details };
}

function failed(agentId: string, error: AgentError) {
  return { agentId, state: "failed" as const, error };
}

/** Stable, schema-valid display identity for an invalid untrusted input without echoing it. */
function displayAgentId(raw: string): string {
  return `invalid-${createHash("sha256").update(raw).digest("hex").slice(0, 24)}`;
}

function stableError(error: unknown): AgentError {
  const code = stableErrorCode(error);
  return toAgentError(error, Object.values(AgentErrorCode).includes(code as AgentErrorCode) ? code! : AgentErrorCode.InvalidState);
}

async function executeStart<TResult extends object>(operation: () => Promise<TResult>, fallbackCode: AgentErrorCode): Promise<TResult> {
  try { return await operation(); }
  catch (error) {
    const stable = stableError(error);
    const fallback = stable.code === AgentErrorCode.InvalidState && !hasStableCode(error)
      ? toAgentError(undefined, fallbackCode)
      : stable;
    throw new Error(`${fallback.code}: ${fallback.message}`);
  }
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
    ? toAgentError(undefined, fallbackCode)
    : stable;
  return new Error(`${projected.code}: ${projected.message}`);
}

function hasStableCode(error: unknown): boolean {
  return stableErrorCode(error) !== undefined;
}

function stableErrorCode(error: unknown): AgentErrorCode | undefined {
  try {
    if (error instanceof Error) {
      const code = /^([a-z_]+):/.exec(error.message)?.[1] as AgentErrorCode | undefined;
      return Object.values(AgentErrorCode).includes(code as AgentErrorCode) ? code : undefined;
    }
    if (typeof error !== "object" || error === null) return undefined;
    const code = (error as { code?: unknown }).code;
    return Object.values(AgentErrorCode).includes(code as AgentErrorCode) ? code as AgentErrorCode : undefined;
  } catch { return undefined; }
}

const MAX_RENDER_BYTES = 8_192;

function modelIdForDisplay(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const separator = value.indexOf("/");
  return separator < 0 ? undefined : value.slice(separator + 1);
}

function renderStart(result: object): string {
  const details = resultDetails(result);
  const model = modelIdForDisplay(details.model);
  const selection = `${model === undefined ? "" : field({ model }, "model")}${field(details, "thinkingLevel", "reasoning")}`;
  return compact([`${fields(details, ["agentId", "runId", "state"])}${selection}`]);
}

function renderReceive(result: object): string {
  const details = resultDetails(result);
  const completions = objectArray(details.completions);
  const agents = objectArray(details.agents);
  const lines = [
    `completions=${completions.length} agents=${agents.length}${field(details, "timedOut")}`,
    ...completions.map((completion) => `completion ${fields(completion, ["agentId", "runId", "state", "outputPath"])}`),
    ...agents.map((agent) => `agent ${fields(agent, ["agentId", "state", "currentRunId", "latestCompletionState", "latestOutputPath"])}`),
  ];
  return compact(lines);
}

function renderStop(result: object): string {
  const outcomes = objectArray(resultDetails(result).outcomes);
  return compact([
    `outcomes=${outcomes.length}`,
    ...outcomes.map((outcome) => {
      const error = record(outcome.error);
      return fields(outcome, ["agentId", "runId", "state", "agentState"])
        + (error === undefined ? "" : field(error, "code", "errorCode"));
    }),
  ]);
}

function resultDetails(result: object): Record<string, unknown> {
  const outer = result as Record<string, unknown>;
  return record(outer.details) ?? outer;
}

function objectArray(value: unknown): Record<string, unknown>[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    const valueRecord = record(item);
    return valueRecord === undefined ? [] : [valueRecord];
  });
}

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null ? value as Record<string, unknown> : undefined;
}

function fields(value: Record<string, unknown>, names: readonly string[]): string {
  return names.map((name) => field(value, name).trimStart()).filter((value) => value.length > 0).join(" ");
}

function field(value: Record<string, unknown>, name: string, label = name): string {
  const raw = value[name];
  if (typeof raw !== "string" && typeof raw !== "number" && typeof raw !== "boolean") return "";
  return ` ${label}=${String(raw).replaceAll(/[\r\n]/g, " ")}`;
}

function compact(lines: readonly string[]): string {
  return truncateUtf8(lines.filter((line) => line.length > 0).join("\n"), MAX_RENDER_BYTES).text;
}
