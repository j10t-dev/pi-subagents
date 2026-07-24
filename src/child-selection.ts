import type { Api, Model } from "@earendil-works/pi-ai";

import {
  AgentErrorCode,
  PublicPreflightError,
  modelId,
  modelSpecFrom,
  providerId,
  toolName,
  truncateUtf8,
  utf8Bytes,
  type ModelId,
  type ModelSpec,
  type ProviderId,
  type ThinkingLevel,
  type ToolName,
} from "./domain.ts";
import { MAX_ERROR_MESSAGE_BYTES } from "./constants.ts";

export const LIFECYCLE_TOOL_NAMES: readonly ToolName[] = Object.freeze([
  toolName("spawn_agent"),
  toolName("send_input"),
  toolName("receive_agent"),
  toolName("stop_agent"),
]);

type NativeModel = Model<Api>;
type BrandedNativeModel = Omit<NativeModel, "provider" | "id"> & {
  readonly provider: ProviderId;
  readonly id: ModelId;
};
type NativeThinkingLevel = ThinkingLevel;

export interface ModelCatalogue {
  getAll(): readonly NativeModel[];
}

export interface ChildSelectionInput {
  readonly requestedModel?: string;
  readonly requestedTools?: readonly string[];
  readonly parentModel: NativeModel;
  readonly parentThinking: NativeThinkingLevel;
  readonly parentActiveTools: readonly string[];
  readonly allowLifecycleTools: boolean;
  readonly modelRegistry: ModelCatalogue;
}

export interface EffectiveChildSelection {
  readonly model: ModelSpec;
  readonly thinkingLevel: NativeThinkingLevel;
  readonly tools: readonly ToolName[];
  readonly warning?: string;
}

export function resolveChildSelection(input: ChildSelectionInput): EffectiveChildSelection {
  const parentModel = projectNativeModel(input.parentModel);
  const models = input.modelRegistry.getAll().map(projectNativeModel);
  const selection = selectModel(input, parentModel, models);
  const activeTools = input.parentActiveTools.map(toolName);
  const tools = selectTools(input.requestedTools, activeTools, input.allowLifecycleTools);
  return Object.freeze({ ...selection, tools });
}

export function projectCustomModelWarning(pattern: string): string {
  const projectedPattern = diagnosticText(pattern, "model");
  const result = projectedPattern === undefined
    ? "The supplied child model pattern uses the custom model-id fallback."
    : `Model pattern "${projectedPattern}" uses the custom model-id fallback.`;
  return truncateUtf8(result, MAX_ERROR_MESSAGE_BYTES).text;
}

const THINKING_LEVELS: ReadonlySet<string> = new Set([
  "off", "minimal", "low", "medium", "high", "xhigh", "max",
]);
const SAFE_MODEL_DIAGNOSTIC = /^[A-Za-z0-9@._+:/?*\[\]-]{1,512}$/u;
const SAFE_TOOL_DIAGNOSTIC = /^[A-Za-z0-9_.:-]{1,128}$/u;
const LIFECYCLE_TOOLS: ReadonlySet<ToolName> = new Set(LIFECYCLE_TOOL_NAMES);

interface RequestedModelSelection {
  readonly model: ModelSpec;
  readonly thinkingLevel?: ThinkingLevel;
  readonly warning?: string;
}

type ModelMatch =
  | { readonly status: "found"; readonly model: BrandedNativeModel }
  | { readonly status: "ambiguous" | "none" };

function selectModel(
  input: ChildSelectionInput,
  parentModel: BrandedNativeModel,
  models: readonly BrandedNativeModel[],
): Pick<EffectiveChildSelection, "model" | "thinkingLevel" | "warning"> {
  if (input.requestedModel === undefined) {
    return {
      model: modelSpecFrom(parentModel.provider, parentModel.id),
      thinkingLevel: input.parentThinking,
    };
  }

  const resolved = resolveRequestedModel(
    input.requestedModel,
    models,
    parentModel.provider,
  );
  if (resolved === undefined) throw unavailableModel(input.requestedModel);
  return {
    model: resolved.model,
    thinkingLevel: resolved.thinkingLevel ?? input.parentThinking,
    ...(resolved.warning === undefined ? {} : { warning: resolved.warning }),
  };
}

function resolveRequestedModel(
  pattern: string,
  models: readonly BrandedNativeModel[],
  preferredProvider: ProviderId,
): RequestedModelSelection | undefined {
  if (diagnosticText(pattern, "model") === undefined) return undefined;

  const complete = findModel(pattern, models, preferredProvider);
  if (complete.status === "found") return { model: modelReference(complete.model) };
  if (complete.status === "ambiguous") return undefined;

  const suffix = splitThinkingSuffix(pattern);
  if (suffix !== undefined) {
    const base = findModel(suffix.pattern, models, preferredProvider);
    if (base.status === "found") {
      return { model: modelReference(base.model), thinkingLevel: suffix.thinkingLevel };
    }
    if (base.status === "ambiguous") return undefined;
    const fallback = customModelFallback(suffix.pattern, models);
    return fallback === undefined ? undefined : { ...fallback, thinkingLevel: suffix.thinkingLevel };
  }

  return customModelFallback(pattern, models);
}

function findModel(
  pattern: string,
  models: readonly BrandedNativeModel[],
  preferredProvider: ProviderId,
): ModelMatch {
  const normalized = pattern.toLowerCase();
  const qualified = models.filter((model) => canonicalModel(model).toLowerCase() === normalized);
  if (qualified.length === 1) return { status: "found", model: qualified[0]! };
  if (qualified.length > 1) return { status: "ambiguous" };

  const bare = models.filter((model) => model.id.toLowerCase() === normalized);
  if (bare.length === 1) return { status: "found", model: bare[0]! };
  const preferredBare = bare.filter((model) =>
    model.provider.toLowerCase() === preferredProvider.toLowerCase());
  if (preferredBare.length === 1) return { status: "found", model: preferredBare[0]! };
  if (bare.length > 1) return { status: "ambiguous" };

  const slash = pattern.indexOf("/");
  const requestedProvider = slash === -1 ? undefined : models.find((model) =>
    model.provider.toLowerCase() === pattern.slice(0, slash).toLowerCase())?.provider;
  const needle = (requestedProvider === undefined ? pattern : pattern.slice(slash + 1)).toLowerCase();
  if (needle.length === 0) return { status: "none" };
  const candidates = models.filter((model) =>
    (requestedProvider === undefined || model.provider === requestedProvider) &&
    (model.id.toLowerCase().includes(needle) || model.name?.toLowerCase().includes(needle)));
  if (candidates.length === 0) return { status: "none" };

  const aliases = candidates.filter((model) => !/-\d{8}$/u.test(model.id));
  const preferred = aliases.length === 0 ? candidates : aliases;
  const selected = [...preferred].sort(compareCanonicalDescending)[0]!;
  return { status: "found", model: selected };
}

function compareCanonicalDescending(left: BrandedNativeModel, right: BrandedNativeModel): number {
  const leftReference = canonicalModel(left);
  const rightReference = canonicalModel(right);
  return leftReference < rightReference ? 1 : leftReference > rightReference ? -1 : 0;
}

function splitThinkingSuffix(
  pattern: string,
): { readonly pattern: string; readonly thinkingLevel: ThinkingLevel } | undefined {
  const colon = pattern.lastIndexOf(":");
  if (colon === -1) return undefined;
  const suffix = pattern.slice(colon + 1);
  return THINKING_LEVELS.has(suffix)
    ? { pattern: pattern.slice(0, colon), thinkingLevel: suffix as ThinkingLevel }
    : undefined;
}

function customModelFallback(
  pattern: string,
  models: readonly BrandedNativeModel[],
): RequestedModelSelection | undefined {
  const slash = pattern.indexOf("/");
  if (slash <= 0 || slash === pattern.length - 1) return undefined;
  const requestedProvider = pattern.slice(0, slash);
  const provider = models.find((model) =>
    model.provider.toLowerCase() === requestedProvider.toLowerCase())?.provider;
  if (provider === undefined) return undefined;
  const requestedModelId = modelId(pattern.slice(slash + 1));
  return {
    model: modelSpecFrom(provider, requestedModelId),
    warning: projectCustomModelWarning(`${provider}/${requestedModelId}`),
  };
}

function projectNativeModel(model: NativeModel): BrandedNativeModel {
  return { ...model, provider: providerId(model.provider), id: modelId(model.id) };
}

function modelReference(model: BrandedNativeModel): ModelSpec {
  return modelSpecFrom(model.provider, model.id);
}

function canonicalModel(model: BrandedNativeModel): ModelSpec {
  return modelSpecFrom(model.provider, model.id);
}

export function filterLifecycleTools(
  tools: readonly ToolName[],
  allowLifecycleTools: boolean,
): readonly ToolName[] {
  return Object.freeze(
    allowLifecycleTools
      ? [...tools]
      : tools.filter((tool) => !LIFECYCLE_TOOLS.has(tool)),
  );
}

function selectTools(
  requestedTools: readonly string[] | undefined,
  parentActiveTools: readonly ToolName[],
  allowLifecycleTools: boolean,
): readonly ToolName[] {
  const eligible = filterLifecycleTools(parentActiveTools, allowLifecycleTools);
  if (requestedTools === undefined) return Object.freeze([...eligible]);

  const selected: ToolName[] = [];
  const unavailable: string[] = [];
  for (const requested of new Set(requestedTools)) {
    const activeMember = eligible.find((tool) => tool === requested);
    if (activeMember === undefined) unavailable.push(requested);
    else selected.push(activeMember);
  }
  if (unavailable.length > 0) throw unavailableTools(unavailable);
  return Object.freeze(selected);
}

function unavailableModel(pattern: string): PublicPreflightError {
  const projected = diagnosticText(pattern, "model");
  const message = projected === undefined
    ? "supplied model pattern is unavailable; use a printable Pi model identifier"
    : `model pattern "${projected}" is unavailable; use a configured Pi model identifier`;
  return new PublicPreflightError(AgentErrorCode.ModelUnavailable, message);
}

function unavailableTools(tools: readonly string[]): PublicPreflightError {
  const projected = tools.map((tool) => diagnosticText(tool, "tool"));
  const message = projected.some((tool) => tool === undefined)
    ? "one or more requested child tools are not active in the parent"
    : `requested child tools are not active in the parent: ${projected.map((tool) => `"${tool}"`).join(", ")}`;
  return new PublicPreflightError(AgentErrorCode.InvalidInput, message);
}

function diagnosticText(value: string, kind: "model" | "tool"): string | undefined {
  const pattern = kind === "model" ? SAFE_MODEL_DIAGNOSTIC : SAFE_TOOL_DIAGNOSTIC;
  if (value.startsWith("/") || value.startsWith("./") || value.startsWith("../") || value.includes("\\")) return undefined;
  if (kind === "model" && value.split("/").some((segment) => segment === "." || segment === "..")) return undefined;
  if (!pattern.test(value)) return undefined;
  return truncateUtf8(value, utf8Bytes(kind === "model" ? 512 : 128)).truncated ? undefined : value;
}
