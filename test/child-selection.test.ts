import { describe, expect, test } from "bun:test";

import type { Api, Model } from "@earendil-works/pi-ai";

import {
  LIFECYCLE_TOOL_NAMES,
  projectCustomModelWarning,
  resolveChildSelection,
  type ChildSelectionInput,
  type EffectiveChildSelection,
  type ModelCatalogue,
} from "../src/child-selection.ts";
import {
  AgentErrorCode,
  PublicPreflightError,
  isPublicPreflightError,
  modelSpecParts,
  type ModelId,
  type ModelSpec,
  type ProviderId,
  type ToolName,
} from "../src/domain.ts";

function assertBrandedSelection(selection: EffectiveChildSelection): void {
  const model: ModelSpec = selection.model;
  const tools: readonly ToolName[] = selection.tools;
  const parts = modelSpecParts(model);
  const provider: ProviderId = parts.provider;
  const modelId: ModelId = parts.modelId;
  void tools;
  void provider;
  void modelId;
}

const _lifecycleToolNames: readonly ToolName[] = LIFECYCLE_TOOL_NAMES;
void _lifecycleToolNames;

function primitiveTools(tools: readonly ToolName[]): readonly string[] {
  return tools;
}

const MODELS: readonly Model<Api>[] = [
  fixtureModel("mock-provider", "luna", "Luna"),
  fixtureModel("mock-provider", "luna-pro", "Luna Pro"),
  fixtureModel("mock-provider", "luna-20260101", "Luna dated"),
  fixtureModel("mock-provider", "model", "Colon base"),
  fixtureModel("mock-provider", "model:high", "Colon identifier"),
  fixtureModel("mock-provider", "shared-parent-model", "Shared parent model"),
  fixtureModel("second-provider", "solar", "BrightStar"),
  fixtureModel("second-provider", "shared-parent-model", "Shared parent model decoy"),
  fixtureModel("shared-one", "shared-model", "Shared One"),
  fixtureModel("shared-two", "shared-model", "Shared Two"),
  fixtureModel("qualified-other", "pro-other", "Provider-restricted decoy"),
  fixtureModel("gateway", "vendor/special", "Slash identifier"),
  fixtureModel("tie-a", "alpha-one", "Alpha One"),
  fixtureModel("tie-b", "alpha-two", "Alpha Two"),
  fixtureModel("qualified-provider", "target", "Qualified target"),
  fixtureModel("bare-collision", "qualified-provider/target", "Bare collision"),
];

function catalogue(): ModelCatalogue {
  return { getAll: () => [...MODELS] };
}

function fixtureModel(provider: string, id: string, name: string): Model<Api> {
  return {
    provider,
    id,
    name,
    api: "anthropic-messages",
    baseUrl: "http://127.0.0.1:0",
    reasoning: true,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 100_000,
    maxTokens: 4_096,
  };
}

function selectionInput(
  overrides: Partial<Omit<ChildSelectionInput, "parentModel" | "modelRegistry">> & {
    parentRef?: string;
    modelRegistry?: ModelCatalogue;
  } = {},
): ChildSelectionInput {
  const modelRegistry = overrides.modelRegistry ?? catalogue();
  const parentRef = overrides.parentRef ?? "mock-provider/luna";
  const parentModel = modelRegistry.getAll().find((model) => `${model.provider}/${model.id}` === parentRef);
  if (parentModel === undefined) throw new Error(`missing fixture parent ${parentRef}`);
  return {
    parentModel,
    parentThinking: overrides.parentThinking ?? "high",
    parentActiveTools: overrides.parentActiveTools ?? ["read", "web_fetch", "spawn_agent"],
    allowLifecycleTools: overrides.allowLifecycleTools ?? false,
    modelRegistry,
    ...(overrides.requestedModel === undefined ? {} : { requestedModel: overrides.requestedModel }),
    ...(overrides.requestedTools === undefined ? {} : { requestedTools: overrides.requestedTools }),
  };
}

describe("resolveChildSelection", () => {
  test.each([
    [undefined, "mock-provider/luna", "high", "mock-provider/luna", "high"],
    ["luna", "mock-provider/luna", "high", "mock-provider/luna", "high"],
    ["MOCK-PROVIDER/LUNA", "mock-provider/luna", "high", "mock-provider/luna", "high"],
    ["luna-pro:minimal", "mock-provider/luna", "high", "mock-provider/luna-pro", "minimal"],
    ["bright", "mock-provider/luna", "high", "second-provider/solar", "high"],
    ["mock-provider/lun", "mock-provider/luna", "high", "mock-provider/luna-pro", "high"],
    ["mock-provider/pro", "mock-provider/luna", "high", "mock-provider/luna-pro", "high"],
    ["vendor/special", "mock-provider/luna", "high", "gateway/vendor/special", "high"],
    ["model:high", "mock-provider/luna", "medium", "mock-provider/model:high", "medium"],
    ["alp", "mock-provider/luna", "high", "tie-b/alpha-two", "high"],
    ["shared-parent-model", "mock-provider/luna", "high", "mock-provider/shared-parent-model", "high"],
    ["shared-parent-model:low", "mock-provider/luna", "high", "mock-provider/shared-parent-model", "low"],
    ["qualified-provider/target", "mock-provider/luna", "high", "qualified-provider/target", "high"],
  ] as const)(
    "resolves %p with extension-owned semantics",
    (requestedModel, parentRef, parentThinking, model, thinkingLevel) => {
      expect(resolveChildSelection(selectionInput({
        ...(requestedModel === undefined ? {} : { requestedModel }),
        parentRef,
        parentThinking,
      })))
        .toMatchObject({ model, thinkingLevel });
    },
  );

  test("matches the parent provider case-insensitively when disambiguating a bare ID", () => {
    const input = selectionInput({ requestedModel: "shared-parent-model" });
    expect(resolveChildSelection({
      ...input,
      parentModel: { ...input.parentModel, provider: "MOCK-PROVIDER" },
    }).model as string).toBe("mock-provider/shared-parent-model");
  });

  test("retains inherited off thinking", () => {
    expect(resolveChildSelection(selectionInput({ parentThinking: "off" })).thinkingLevel).toBe("off");
  });

  test("does not read the model catalogue when inheriting the parent model", () => {
    const input = selectionInput();
    expect(resolveChildSelection({
      ...input,
      modelRegistry: { getAll: () => { throw new Error("catalogue must not be read"); } },
    }).model as string).toBe("mock-provider/luna");
  });

  test("ignores unusable catalogue entries when resolving an explicit model", () => {
    const input = selectionInput({ requestedModel: "solar" });
    expect(resolveChildSelection({
      ...input,
      modelRegistry: {
        getAll: () => [
          fixtureModel("invalid/provider", "broken", "Invalid"),
          fixtureModel("second-provider", "solar", "BrightStar"),
        ],
      },
    }).model as string).toBe("second-provider/solar");
  });

  test("reports the number of unusable catalogue entries when no model resolves", () => {
    const input = selectionInput({ requestedModel: "broken" });
    const error = capturePublicError(() => resolveChildSelection({
      ...input,
      modelRegistry: {
        getAll: () => [fixtureModel("invalid/provider", "broken", "Invalid")],
      },
    }));
    expect(error.message).toContain("ignored 1 invalid configured model entry");
  });

  test.each([
    [undefined, ["read", "web_fetch", "spawn_agent"], ["read", "web_fetch"]],
    [["web_fetch", "read", "web_fetch"], ["read", "web_fetch"], ["web_fetch", "read"]],
    [[], ["read", "web_fetch"], []],
  ] as const)("selects tools %#", (requestedTools, parentActiveTools, expected) => {
    expect(primitiveTools(resolveChildSelection(selectionInput({
      ...(requestedTools === undefined ? {} : { requestedTools }),
      parentActiveTools,
    })).tools))
      .toEqual(expected);
  });

  test("returns branded selected model and tool identities", () => {
    assertBrandedSelection(resolveChildSelection(selectionInput({ requestedTools: ["read"] })));
  });

  test("validates active parent tools before selection", () => {
    expect(() => resolveChildSelection(selectionInput({ parentActiveTools: ["read", "bad\ntool"] })))
      .toThrow(/invalid_input/);
  });

  test("retains inherited and explicitly requested lifecycle tools below the boundary", () => {
    expect(primitiveTools(resolveChildSelection(selectionInput({
      allowLifecycleTools: true,
      parentActiveTools: ["read", "spawn_agent", "receive_agent"],
    })).tools)).toEqual(["read", "spawn_agent", "receive_agent"]);

    expect(primitiveTools(resolveChildSelection(selectionInput({
      allowLifecycleTools: true,
      requestedTools: ["spawn_agent"],
      parentActiveTools: ["read", "spawn_agent"],
    })).tools)).toEqual(["spawn_agent"]);
  });

  test("rejects inactive lifecycle tools below the boundary", () => {
    expect(() => resolveChildSelection(selectionInput({
      allowLifecycleTools: true,
      requestedTools: ["receive_agent"],
      parentActiveTools: ["read", "spawn_agent"],
    }))).toThrow(expect.objectContaining({ code: AgentErrorCode.InvalidInput }));
  });

  test("strips inherited lifecycle tools and rejects each explicit lifecycle tool at the boundary", () => {
    expect(primitiveTools(resolveChildSelection(selectionInput({
      parentActiveTools: ["read", ...LIFECYCLE_TOOL_NAMES],
    })).tools)).toEqual(["read"]);
    for (const tool of LIFECYCLE_TOOL_NAMES) {
      expect(() => resolveChildSelection(selectionInput({
        requestedTools: [tool],
        parentActiveTools: ["read", ...LIFECYCLE_TOOL_NAMES],
      }))).toThrow(expect.objectContaining({ code: AgentErrorCode.InvalidInput }));
    }
  });

  test.each(["spawn_agent", "send_input", "receive_agent", "stop_agent", "inactive", "unknown"])(
    "rejects unavailable tool %s with a typed public error",
    (tool) => {
      expect(() => resolveChildSelection(selectionInput({ requestedTools: [tool] })))
        .toThrow(expect.objectContaining({
          name: "PublicPreflightError",
          code: AgentErrorCode.InvalidInput,
        }));
    },
  );

  test("deduplicates unavailable tool diagnostics", () => {
    let caught: unknown;
    try {
      resolveChildSelection(selectionInput({ requestedTools: ["inactive", "inactive", "unknown"] }));
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(PublicPreflightError);
    expect((caught as Error).message.match(/inactive/g)).toHaveLength(1);
    expect((caught as Error).message.match(/unknown/g)).toHaveLength(1);
  });

  test("rejects unmatched model text with model_unavailable", () => {
    const error = capturePublicError(() =>
      resolveChildSelection(selectionInput({ requestedModel: "definitely-no-such-model" })),
    );
    expect(error.code).toBe(AgentErrorCode.ModelUnavailable);
    expect(error.message).toContain('"definitely-no-such-model"');
  });

  test("projects custom model warnings on the immutable selection", () => {
    const result = resolveChildSelection(selectionInput({ requestedModel: "mock-provider/new-model" }));
    expect(result).toMatchObject({
      model: "mock-provider/new-model",
      warning: 'Model pattern "mock-provider/new-model" uses the custom model-id fallback.',
    });
    expect(Object.isFrozen(result)).toBe(true);
  });

  test("separates a custom model fallback from its thinking suffix", () => {
    expect(resolveChildSelection(selectionInput({ requestedModel: "mock-provider/new-model:minimal" })))
      .toMatchObject({
        model: "mock-provider/new-model",
        thinkingLevel: "minimal",
        warning: 'Model pattern "mock-provider/new-model" uses the custom model-id fallback.',
      });
  });

  test.each([
    "bad\u0000model",
    "bad\nmodel",
    "Authorization: Bearer secret",
    "token=secret",
    "/tmp/private",
    "../tmp/private",
    "mock-provider/../../private",
    "x".repeat(513),
  ])("does not project hostile model input %#", (requestedModel) => {
    const error = capturePublicError(() => resolveChildSelection(selectionInput({ requestedModel })));
    expect(error.code).toBe(AgentErrorCode.ModelUnavailable);
    expectNoHostileFragments(error.message, requestedModel);
  });

  test.each([
    "bad\u0000tool",
    "bad\ntool",
    "Authorization: Bearer secret",
    "token=secret",
    "/tmp/private",
    "../tmp/private",
    "x".repeat(129),
  ])("does not project hostile tool input %#", (requestedTool) => {
    const error = capturePublicError(() =>
      resolveChildSelection(selectionInput({ requestedTools: [requestedTool] })),
    );
    expect(error.code).toBe(AgentErrorCode.InvalidInput);
    expectNoHostileFragments(error.message, requestedTool);
  });

  test.each(["shared-model", "shared-model:low"])(
    "rejects an exact bare model ID shared by multiple providers: %s",
    (requestedModel) => {
      expect(() => resolveChildSelection(selectionInput({ requestedModel })))
        .toThrow(expect.objectContaining({
          name: "PublicPreflightError",
          code: AgentErrorCode.ModelUnavailable,
        }));
    },
  );

  test("returns deeply immutable selection data without mutating caller arrays", () => {
    const requestedTools = ["web_fetch", "read", "web_fetch"];
    const parentActiveTools = ["read", "web_fetch", "spawn_agent"];
    const beforeRequested = [...requestedTools];
    const beforeActive = [...parentActiveTools];
    const result = resolveChildSelection(selectionInput({ requestedTools, parentActiveTools }));

    expect(requestedTools).toEqual(beforeRequested);
    expect(parentActiveTools).toEqual(beforeActive);
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result.tools)).toBe(true);
    expect(Object.isFrozen(LIFECYCLE_TOOL_NAMES)).toBe(true);
  });
});

describe("custom model diagnostic projection", () => {
  test("projects a validated custom model-id fallback", () => {
    const result = projectCustomModelWarning("mock-provider/new-model");
    expect(result).toBe('Model pattern "mock-provider/new-model" uses the custom model-id fallback.');
    expect(Buffer.byteLength(result)).toBeLessThanOrEqual(10_000);
  });

  test.each([
    "bad\u0000model",
    "bad\nmodel",
    "Authorization: Bearer secret",
    "token=secret",
    "/tmp/private",
    "../tmp/private",
    "mock-provider/../../private",
    "x".repeat(513),
  ])("does not project hostile custom model patterns %#", (pattern) => {
    const result = projectCustomModelWarning(pattern);
    expect(result).toBe("The supplied child model pattern uses the custom model-id fallback.");
    expect(Buffer.byteLength(result)).toBeLessThanOrEqual(10_000);
    expectNoHostileFragments(result, pattern);
  });

  test("identifies only valid PublicPreflightError instances", () => {
    const valid = new PublicPreflightError(AgentErrorCode.InvalidInput, "fixed guidance");
    expect(isPublicPreflightError(valid)).toBe(true);
    expect(isPublicPreflightError(new Error("invalid_input: fixed guidance"))).toBe(false);
    const forged = new PublicPreflightError(AgentErrorCode.InvalidInput, "fixed guidance");
    Object.defineProperty(forged, "code", { value: "not_a_code" });
    expect(isPublicPreflightError(forged)).toBe(false);
  });

  test("bounds the complete typed error to 10,000 UTF-8 bytes", () => {
    const error = new PublicPreflightError(AgentErrorCode.InvalidInput, "£".repeat(10_000));
    expect(Buffer.byteLength(error.message)).toBeLessThanOrEqual(10_000);
    expect(error.message.startsWith("invalid_input: ")).toBe(true);
  });
});

function capturePublicError(operation: () => void): PublicPreflightError {
  try {
    operation();
  } catch (error) {
    if (isPublicPreflightError(error)) return error;
    throw error;
  }
  throw new Error("expected PublicPreflightError");
}

function expectNoHostileFragments(message: string, raw: string): void {
  expect(Buffer.byteLength(message)).toBeLessThanOrEqual(10_000);
  expect(message).not.toContain(raw);
  for (const fragment of [
    "bad",
    "Authorization",
    "Bearer",
    "token=",
    "/tmp/private",
    "private",
    "secret",
    "x".repeat(32),
  ]) {
    if (raw.includes(fragment)) expect(message).not.toContain(fragment);
  }
}
