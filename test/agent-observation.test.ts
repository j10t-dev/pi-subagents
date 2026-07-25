import { describe, expect, test } from "bun:test";
import {
  AgentState,
  CompletionState,
  agentId,
  agentOrdinal,
  contextPercent,
  directAgentOrdinal,
  modelSpec,
} from "../src/domain.ts";
import {
  contextLabel,
  deriveDisplayState,
  deriveModelLabel,
  deriveTaskLabel,
} from "../src/agent-observation.ts";

describe("agent observation projection", () => {
  test("constructs branch-local direct and hierarchical ordinals", () => {
    expect(String(directAgentOrdinal(1))).toBe("A1");
    expect(String(agentOrdinal("A12.3"))).toBe("A12.3");
    expect(() => agentOrdinal("A0")).toThrow(/ordinal/);
  });

  test("derives model, context, and terminal display labels", () => {
    expect(String(deriveModelLabel(modelSpec("openai-codex/gpt-5.6-luna"), "high"))).toBe("gpt-5.6-luna:h");
    expect(String(contextLabel({ kind: "known", percent: contextPercent(42.4) }))).toBe("42%");
    expect(String(contextLabel({ kind: "known", percent: contextPercent(1_200) }))).toBe("999+%");
    expect(String(contextLabel({ kind: "unavailable" }))).toBe("?%");
    expect(deriveDisplayState(AgentState.Stopped, CompletionState.Failed)).toBe("failed");
  });

  test("rejects an unsafe model identity rather than presenting it as unknown", () => {
    expect(() => deriveModelLabel(modelSpec("provider/model\u202Eidentity"), "high"))
      .toThrow("invalid_input: invalid model label");
  });

  test.each([
    ["opening backtick fence with arbitrary info", "```ts title=\"review\"\nReview the adapter\n```"],
    ["opening tilde fence with arbitrary info", "  ~~~ typescript title='review'  \n\n  Review the adapter  \n~~~~"],
    ["bare closing fences", "~~~\n```\nReview the adapter\n~~~~"],
  ] as const)("skips standalone Markdown fence lines for %s", (_name, assignment) => {
    expect(String(deriveTaskLabel(assignment, { knownAgentIds: new Set(), knownRunIds: new Set(), knownInternalPaths: new Set() })))
      .toBe("Review the adapter");
  });

  test("does not classify ordinary prose containing backticks as a fence", () => {
    expect(String(deriveTaskLabel("Review `inline` code and the ``` token", {
      knownAgentIds: new Set(), knownRunIds: new Set(), knownInternalPaths: new Set(),
    }))).toBe("Review inline code and the token");
  });

  test("bounds the first descriptive line after standalone fences", () => {
    const label = deriveTaskLabel(`\n\`\`\`\n${"界".repeat(1_000)}\n\`\`\``, {
      knownAgentIds: new Set(), knownRunIds: new Set(), knownInternalPaths: new Set(),
    });
    expect([...label]).toHaveLength(80);
    expect(Buffer.byteLength(label, "utf8")).toBeLessThanOrEqual(512);
  });

  test("redacts sensitive identities and path-like tokens from task labels", () => {
    const label = deriveTaskLabel("## Review /tmp/a.ts for agent-a. More detail", {
      knownAgentIds: new Set([agentId("agent-a")]),
      knownRunIds: new Set(),
      knownInternalPaths: new Set(),
    });
    expect(String(label)).toBe("Review path for path");
    expect(label).not.toContain("agent-a");
  });
});
