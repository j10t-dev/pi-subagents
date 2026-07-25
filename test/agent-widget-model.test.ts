import { describe, expect, test } from "bun:test";

import type { AgentDisplayState, AgentRow, AgentWidgetSnapshot } from "../src/agent-observation.ts";
import {
  MAX_ORDINAL_CHARS,
  clearSelection,
  emptyModel,
  moveSelection,
  replaceRows,
  rowBudget,
  selectFirst,
  visibleRows,
} from "../src/agent-widget/model.ts";
import { MAX_WIDGET_ROWS } from "../src/constants.ts";
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

function row(ordinal: string, overrides: Partial<AgentRow> = {}): AgentRow {
  return {
    ordinal: agentOrdinal(ordinal),
    depth: agentDepth(0),
    model: "luna:h" as ModelLabel,
    context: "42%" as ContextLabel,
    taskLabel: "Research terminal UX" as TaskLabel,
    state: AgentState.Running as AgentDisplayState,
    ...overrides,
  };
}

function snapshot(rows: readonly AgentRow[], total = rows.length, omitted = 0): AgentWidgetSnapshot {
  return {
    revision: agentWidgetRevision(1),
    rows,
    total: agentCount(total),
    omitted: agentCount(omitted),
    degraded: true,
  };
}

describe("replaceRows", () => {
  test("ingests an atomic snapshot and keeps the source counts", () => {
    const model = replaceRows(emptyModel(), snapshot([row("A1"), row("A2")], 12, 10));
    expect(model.rows).toHaveLength(2);
    expect(Number(model.total)).toBe(12);
    expect(Number(model.sourceOmitted)).toBe(10);
    expect(Number(model.displayOmitted)).toBe(0);
  });

  test("retains at most MAX_WIDGET_ROWS in supplied order and counts the remainder locally", () => {
    const limit = Number(MAX_WIDGET_ROWS);
    const rows = Array.from({ length: limit + 5 }, (_, index) => row(`A${index + 1}`));
    const model = replaceRows(emptyModel(), snapshot(rows, limit + 5, 0));
    expect(model.rows).toHaveLength(limit);
    expect(model.rows[0]!.ordinal).toBe(agentOrdinal("A1"));
    expect(Number(model.displayOmitted)).toBe(5);
  });

  test("bounds each field at ingestion rather than at render time", () => {
    const model = replaceRows(emptyModel(), snapshot([row("A1", {
      context: "c".repeat(100) as ContextLabel,
      model: "m".repeat(100) as ModelLabel,
      taskLabel: "t".repeat(4_000) as TaskLabel,
      depth: agentDepth(8),
    })]));
    const stored = model.rows[0]!;
    expect(stored.context).toHaveLength(24);
    expect(stored.model).toHaveLength(32);
    expect(stored.taskLabel).toHaveLength(200);
    expect(Number(stored.depth)).toBe(8);
  });

  test("drops an over-length ordinal rather than truncating it, so no two agents can collide", () => {
    const prefix = `A1${".1".repeat(MAX_ORDINAL_CHARS)}`;
    const model = replaceRows(emptyModel(), snapshot([
      row("A1"),
      { ...row("A1"), ordinal: `${prefix}.1` as AgentRow["ordinal"] },
      { ...row("A1"), ordinal: `${prefix}.2` as AgentRow["ordinal"] },
    ], 3, 0));
    expect(model.rows.map((entry) => entry.ordinal)).toEqual([agentOrdinal("A1")]);
    expect(Number(model.displayOmitted)).toBe(2);
  });

  test("normalises malformed branded depths before domain validation", () => {
    const malformed = [
      -2 as AgentRow["depth"],
      Number.NaN as AgentRow["depth"],
      3.7 as AgentRow["depth"],
      Number.POSITIVE_INFINITY as AgentRow["depth"],
    ];
    const model = replaceRows(emptyModel(), snapshot(
      malformed.map((depth, index) => row(`A${index + 1}`, { depth })),
    ));
    expect(model.rows.map((entry) => Number(entry.depth))).toEqual([0, 0, 3, 8]);
  });

  test("rejects duplicate ordinals and counts each rejected occurrence", () => {
    const model = replaceRows(emptyModel(), snapshot([
      row("A1"),
      row("A2"),
      row("A1"),
      row("A2"),
      row("A3"),
    ]));
    expect(model.rows.map((entry) => entry.ordinal)).toEqual([
      agentOrdinal("A1"), agentOrdinal("A2"), agentOrdinal("A3"),
    ]);
    expect(Number(model.displayOmitted)).toBe(2);
  });
});

describe("selection", () => {
  test("keeps the selected ordinal across reorder and completion", () => {
    let model = selectFirst(replaceRows(emptyModel(), snapshot([row("A1"), row("A2")] )));
    model = moveSelection(model, "down", 10).model;
    expect(model.selected).toBe(agentOrdinal("A2"));
    model = replaceRows(model, snapshot([row("A2", { state: "completed" as AgentDisplayState }), row("A1")]));
    expect(model.selected).toBe(agentOrdinal("A2"));
  });

  test("clamps the previous index when the selected ordinal disappears", () => {
    let model = selectFirst(replaceRows(emptyModel(), snapshot([row("A1"), row("A2"), row("A3")] )));
    model = moveSelection(model, "down", 10).model;
    model = moveSelection(model, "down", 10).model;
    expect(model.selected).toBe(agentOrdinal("A3"));
    model = replaceRows(model, snapshot([row("A1"), row("A2")]));
    expect(model.selected).toBe(agentOrdinal("A2"));
  });

  test("does not wrap, and signals exit above the first row", () => {
    const model = selectFirst(replaceRows(emptyModel(), snapshot([row("A1"), row("A2")] )));
    const down = moveSelection(moveSelection(model, "down", 10).model, "down", 10);
    expect(down.model.selected).toBe(agentOrdinal("A2"));
    expect(down.exit).toBe(false);
    const up = moveSelection(model, "up", 10);
    expect(up.exit).toBe(true);
    expect(up.model.selected).toBe(undefined);
  });

  test("clearSelection releases the marker without dropping rows", () => {
    const model = clearSelection(selectFirst(replaceRows(emptyModel(), snapshot([row("A1")] ))));
    expect(model.selected).toBe(undefined);
    expect(model.rows).toHaveLength(1);
  });
});

describe("viewport", () => {
  test("rowBudget clamps terminal quarters into [3, 10]", () => {
    expect(rowBudget(4)).toBe(3);
    expect(rowBudget(24)).toBe(6);
    expect(rowBudget(200)).toBe(10);
  });

  test("the window follows the selection and scrolls only when it would leave", () => {
    const rows = Array.from({ length: 8 }, (_, index) => row(`A${index + 1}`));
    let model = selectFirst(replaceRows(emptyModel(), snapshot(rows)));
    expect(visibleRows(model, 3).map((entry) => entry.ordinal)).toEqual([agentOrdinal("A1"), agentOrdinal("A2"), agentOrdinal("A3")]);
    for (let step = 0; step < 3; step += 1) model = moveSelection(model, "down", 3).model;
    expect(model.selected).toBe(agentOrdinal("A4"));
    expect(visibleRows(model, 3).map((entry) => entry.ordinal)).toEqual([agentOrdinal("A2"), agentOrdinal("A3"), agentOrdinal("A4")]);
  });

  test("a shrinking budget pulls the window back onto the selection", () => {
    const rows = Array.from({ length: 8 }, (_, index) => row(`A${index + 1}`));
    let model = selectFirst(replaceRows(emptyModel(), snapshot(rows)));
    for (let step = 0; step < 7; step += 1) model = moveSelection(model, "down", 8).model;
    expect(visibleRows(model, 2).map((entry) => entry.ordinal)).toEqual([agentOrdinal("A7"), agentOrdinal("A8")]);
  });
});
