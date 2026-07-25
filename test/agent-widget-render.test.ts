import { describe, expect, test } from "bun:test";
import { visibleWidth } from "@earendil-works/pi-tui";

import type { AgentDisplayState, AgentRow, AgentWidgetSnapshot } from "../src/agent-observation.ts";
import { emptyModel, replaceRows, selectFirst } from "../src/agent-widget/model.ts";
import { renderRows, type AgentWidgetView } from "../src/agent-widget/render.ts";
import {
  AgentState,
  agentCount,
  agentDepth,
  agentOrdinal,
  agentWidgetRevision,
  type ContextLabel,
  type ModelLabel,
  type TaskLabel,
} from "../src/domain.ts";

function row(ordinal: string, depth = 0, taskLabel = "Research terminal UX"): AgentRow {
  return {
    ordinal: agentOrdinal(ordinal),
    depth: agentDepth(depth),
    model: "luna:h" as ModelLabel,
    context: "42%" as ContextLabel,
    taskLabel: taskLabel as TaskLabel,
    state: AgentState.Running as AgentDisplayState,
  };
}

function view(rows: readonly AgentRow[], options: Partial<AgentWidgetView> & {
  total?: number; omitted?: number; degraded?: boolean; select?: boolean;
} = {}): AgentWidgetView {
  const snapshot: AgentWidgetSnapshot = {
    revision: agentWidgetRevision(1),
    rows,
    total: agentCount(options.total ?? rows.length),
    omitted: agentCount(options.omitted ?? 0),
    degraded: options.degraded ?? false,
  };
  const base = replaceRows(emptyModel(), snapshot);
  return {
    model: options.select === false ? base : selectFirst(base),
    sourceError: options.sourceError ?? false,
    navigationLost: options.navigationLost ?? false,
  };
}

describe("header grammar", () => {
  test("renders rendered/total with no suffixes when nothing applies", () => {
    const lines = renderRows(view([row("A1"), row("A2")]), 120, 10);
    expect(lines[0]).toBe("Subagents 2/2");
  });

  test("assembles every part in the fixed order", () => {
    const lines = renderRows(view([row("A1")], { total: 252, omitted: 51, degraded: true, sourceError: true, navigationLost: true }), 200, 10);
    expect(lines[0]).toBe("Subagents 1/252 · 51 omitted · incomplete · stale — source error · arrow navigation unavailable");
  });

  test("renders a source error with no rows beneath it", () => {
    const lines = renderRows(view([], { total: 0, sourceError: true }), 120, 10);
    expect(lines).toEqual(["Subagents 0/0 · stale — source error"]);
  });

  test("counts only the rows in the window", () => {
    const rows = Array.from({ length: 8 }, (_, index) => row(`A${index + 1}`));
    expect(renderRows(view(rows), 120, 3)[0]).toBe("Subagents 3/8");
  });
});

describe("rows", () => {
  test("draws marker, tree prefix, ordinal, model, context, label and state", () => {
    const lines = renderRows(view([row("A1"), row("A1.1", 1), row("A1.2", 1)]), 120, 10);
    expect(lines[1]!.startsWith("› ")).toBe(true);
    expect(lines[2]!.startsWith("  ")).toBe(true);
    expect(lines[2]).toContain("├─ A1.1");
    expect(lines[3]).toContain("└─ A1.2");
    expect(lines[1]).toContain("luna:h");
    expect(lines[1]).toContain("(42%)");
    expect(lines[1]!.trimEnd().endsWith("running")).toBe(true);
  });

  test("sanitises control characters and ANSI sequences out of every field", () => {
    const lines = renderRows(view([row("A1", 0, "a\u001b[31mb\u0009c\u000Ad\u0007e")]), 120, 10);
    expect(lines[1]).not.toMatch(/[\u0000-\u001f\u007f-\u009f]/u);
    expect(lines[1]).toContain("ab c d e");
  });
});

describe("concession ladder", () => {
  const rows = [row("A1"), row("A1.10", 1, "Review the findings carefully"), row("A1.10.3", 2)];

  test("never exceeds the supplied width at any width", () => {
    for (let width = 200; width >= 1; width -= 1) {
      for (const line of renderRows(view(rows), width, 10)) expect(visibleWidth(line)).toBeLessThanOrEqual(width);
    }
  });

  test("walks the steps in order as the terminal narrows", () => {
    const at = (width: number) => renderRows(view(rows), width, 10).slice(1).join("\u000A");
    expect(at(120)).toContain("Research terminal UX");
    const widest = (absent: (rendered: string) => boolean): number =>
      [...Array(200).keys()].map((index) => 200 - index).find((w) => absent(at(w)))!;
    const dropContext = widest((r) => !r.includes("(42%)"));
    const dropModel = widest((r) => !r.includes("luna:h"));
    const dropState = widest((r) => !r.includes("running"));
    const dropPrefix = widest((r) => !r.includes("─"));
    expect(dropContext).toBeGreaterThan(dropModel);
    expect(dropModel).toBeGreaterThan(dropState);
    expect(dropState).toBeGreaterThan(dropPrefix);
  });

  test("applies the same step to every row in the window", () => {
    for (let width = 60; width >= 20; width -= 1) {
      const lines = renderRows(view(rows), width, 10).slice(1);
      const withContext = lines.filter((line) => line.includes("%)")).length;
      expect(withContext === 0 || withContext === lines.length).toBe(true);
    }
  });

  test("renders the header alone once marker and ordinal cannot fit", () => {
    const lines = renderRows(view(rows), 2, 10);
    expect(lines).toHaveLength(1);
    expect(visibleWidth(lines[0]!)).toBeLessThanOrEqual(2);
  });
});
