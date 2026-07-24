import { expect, test } from "bun:test";
import {
  AgentErrorCode,
  agentDepth,
  agentId,
  agentOrdinal,
  type AgentErrorCode as AgentErrorCodeType,
  type DiagnosticsPath,
  type OutputPath,
  type RunId,
  type SessionPath,
} from "../src/domain.ts";
import { contextLabel, deriveTaskLabel, type AgentRow } from "../src/agent-observation.ts";
import { diagnosticsPath, outputPath, sessionPath } from "../src/paths.ts";
import {
  renderLifecycleToolResult,
  validatedErrorCode,
  validatedPath,
  validatedRunId,
  type AgentDisplayResolver,
} from "../src/tool-presentation.ts";

type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends
  (<T>() => T extends B ? 1 : 2) ? true : false;
type Assert<T extends true> = T;
type _RunId = Assert<Equal<NonNullable<ReturnType<typeof validatedRunId>>, RunId>>;
type _ErrorCode = Assert<Equal<NonNullable<ReturnType<typeof validatedErrorCode>>, AgentErrorCodeType>>;
type _OutputPath = Assert<Equal<NonNullable<ReturnType<typeof validatedPath<OutputPath>>>, OutputPath>>;
type _SessionPath = Assert<Equal<NonNullable<ReturnType<typeof validatedPath<SessionPath>>>, SessionPath>>;
type _DiagnosticsPath = Assert<Equal<NonNullable<ReturnType<typeof validatedPath<DiagnosticsPath>>>, DiagnosticsPath>>;


function row(id: string, ordinal: string, state: AgentRow["state"], task = "task"): [ReturnType<typeof agentId>, AgentRow] {
  return [agentId(id), Object.freeze({ ordinal: agentOrdinal(ordinal), depth: agentDepth(0), model: "luna:h" as AgentRow["model"], context: contextLabel({ kind: "unavailable" }), taskLabel: deriveTaskLabel(task, { knownAgentIds: new Set(), knownRunIds: new Set(), knownInternalPaths: new Set() }), state })];
}
function resolver(entries: Array<[ReturnType<typeof agentId>, AgentRow]>): AgentDisplayResolver {
  const rows = new Map(entries);
  return { resolve: (id) => rows.get(id) };
}

test("preserves validated diagnostic brands while rendering safe diagnostics", () => {
  expect(String(validatedRunId("deadbeef"))).toBe("deadbeef");
  expect(String(validatedErrorCode(AgentErrorCode.ProtocolError))).toBe(AgentErrorCode.ProtocolError);
  expect(String(validatedPath<OutputPath>("/tmp/out", (parent, child) => outputPath(parent, child)))).toBe("/tmp/out");
  expect(String(validatedPath<SessionPath>("/tmp/transcript", (parent, child) => sessionPath(parent, child)))).toBe("/tmp/transcript");
  expect(String(validatedPath<DiagnosticsPath>("/tmp/diagnostic", (parent, child) => diagnosticsPath(parent, child)))).toBe("/tmp/diagnostic");
});

test("renders one shared safe row without native identity", () => {
  const text = renderLifecycleToolResult("spawn_agent", { agentId: "agent-a", state: "running" }, resolver([row("agent-a", "A1", "running", "Research terminal UX")]), { expanded: false });
  expect(text).toBe("A1 · luna:h · Research terminal UX · running");
  expect(text).not.toContain("agent-a");
});

test("uses a safe fallback when lookup is unavailable", () => {
  expect(renderLifecycleToolResult("send_input", { agentId: "agent-a" }, { resolve: () => undefined }, { expanded: false })).toBe("Agent · unavailable");
});

test("collapsed await merges completion, hides stopped history, and counts later pages", () => {
  const rows = resolver([row("agent-a", "A1", "completed"), row("agent-b", "A2", "running"), row("agent-c", "A3", "stopped")]);
  const text = renderLifecycleToolResult("await_agent", {
    completions: [{ agentId: "agent-a", runId: "deadbeef", state: "completed", output: { text: "secret" } }],
    remainingCompletions: 0,
    inventory: { total: 23, omitted: 20, remaining: 20, nextAfterAgentId: "agent-c", agents: [
      { agentId: "agent-a", state: "stopped" }, { agentId: "agent-b", state: "running" }, { agentId: "agent-c", state: "stopped" },
    ] }, timedOut: false,
  }, rows, { expanded: false });
  expect(text.split("\n")).toEqual([
    "A1 · luna:h · task · completed",
    "A2 · luna:h · task · running",
    "1 stopped agent not shown · 20 inventory agents on later pages",
  ]);
  expect(text).not.toContain("secret");
  expect(text).not.toContain("deadbeef");
});

test("expanded await includes bounded diagnostics but never child output", () => {
  const entries = Array.from({ length: 120 }, (_, index) => row(`agent-${index}`, `A${index + 1}`, "running"));
  const text = renderLifecycleToolResult("await_agent", {
    completions: [{ agentId: "agent-0", runId: "deadbeef", state: "completed", output: { text: "MODEL_SECRET" } }],
    inventory: { total: 120, omitted: 0, remaining: 20, nextAfterAgentId: "agent-99", agents: entries.map(([id]) => ({ agentId: id, state: "running" })) },
    remainingCompletions: 0, timedOut: false,
  }, resolver(entries), { expanded: true });
  expect(text).toContain("nextAfterAgentId=");
  expect(text).toContain("agentId=");
  expect(text).toContain("23 additional rows omitted");
  expect(text.split("\n")).toHaveLength(100);
  expect(text).not.toContain("MODEL_SECRET");
  expect(Buffer.byteLength(text, "utf8")).toBeLessThanOrEqual(8_192);
});

test("collapsed rendering reserves a row and reports the exact cap omission count", () => {
  const entries = Array.from({ length: 30 }, (_, index) => row(`agent-${index}`, `A${index + 1}`, "running"));
  const text = renderLifecycleToolResult("stop_agent", { outcomes: entries.map(([id]) => ({ agentId: id, state: "cancelled" })) }, resolver(entries), { expanded: false });
  expect(text.split("\n")).toHaveLength(20);
  expect(text.split("\n").at(-1)).toBe("11 additional rows omitted");
});

test("byte-pressure admission keeps whole multibyte rows and exact omissions deterministically", () => {
  const entries = Array.from({ length: 30 }, (_, index) => row(`agent-${index}`, `A${index + 1}`, "running", `row-${index}-${"£😀".repeat(600)}`));
  const details = { outcomes: entries.map(([id]) => ({ agentId: id, state: "cancelled" })) };
  const first = renderLifecycleToolResult("stop_agent", details, resolver(entries), { expanded: false });
  const second = renderLifecycleToolResult("stop_agent", details, resolver(entries), { expanded: false });
  const lines = first.split("\n");
  const shown = lines.length - 1;
  expect(second).toBe(first);
  expect(lines.at(-1)).toBe(`${30 - shown} additional rows omitted`);
  expect(Buffer.byteLength(first, "utf8")).toBeLessThanOrEqual(8_192);
  expect(first).not.toContain("\uFFFD");
  for (let index = 0; index < shown; index++) expect(lines[index]).toContain(`row-${index}-`);
});

test("expanded diagnostics admit only validated identities, paths, cursors, and error codes", () => {
  const rows = resolver([row("agent-a", "A1", "failed")]);
  const valid = renderLifecycleToolResult("await_agent", {
    completions: [{ agentId: "agent-a", runId: "deadbeef", outputPath: "/tmp/out", transcriptPath: "/tmp/transcript", error: { code: AgentErrorCode.ProtocolError, diagnosticsPath: "/tmp/diagnostic" } }],
    inventory: { total: 1, omitted: 0, remaining: 1, nextAfterAgentId: "agent-a", agents: [] },
  }, rows, { expanded: true });
  expect(valid).toContain("nextAfterAgentId=agent-a");
  expect(valid).toContain("runId=deadbeef");
  expect(valid).toContain("outputPath=/tmp/out");
  expect(valid).toContain("transcriptPath=/tmp/transcript");
  expect(valid).toContain("diagnosticsPath=/tmp/diagnostic");
  expect(valid).toContain(`· ${AgentErrorCode.ProtocolError}`);

  const invalid = renderLifecycleToolResult("await_agent", {
    completions: [{ agentId: "agent-a", runId: "not-a-run", outputPath: "relative/out", transcriptPath: "/tmp/\u202Etranscript", error: { code: "invented_error", diagnosticsPath: "relative/diagnostic" } }],
    inventory: { total: 1, omitted: 0, remaining: 1, nextAfterAgentId: "not a valid agent", agents: [] },
  }, rows, { expanded: true });
  for (const unsafe of ["not-a-run", "relative/out", "transcript", "invented_error", "relative/diagnostic", "not a valid agent"]) {
    expect(invalid).not.toContain(unsafe);
  }
});
