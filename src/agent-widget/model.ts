import type { AgentRow, AgentWidgetSnapshot } from "../agent-observation.ts";
import { MAX_WIDGET_ROWS } from "../constants.ts";
import {
  agentCount,
  agentDepth,
  type AgentCount,
  type AgentOrdinal,
  type ContextLabel,
  type ModelLabel,
  type TaskLabel,
} from "../domain.ts";

export const MAX_ORDINAL_CHARS = 128;
const MAX_CONTEXT_CHARS = 24;
const MAX_MODEL_CHARS = 32;
const MAX_TASK_LABEL_CHARS = 200;
const MAX_DEPTH = 8;

export interface AgentWidgetModel {
  readonly rows: readonly AgentRow[];
  readonly total: AgentCount;
  readonly sourceOmitted: AgentCount;
  readonly displayOmitted: AgentCount;
  readonly degraded: boolean;
  readonly selected: AgentOrdinal | undefined;
  readonly offset: number;
}

export function emptyModel(): AgentWidgetModel {
  return { rows: [], total: agentCount(0), sourceOmitted: agentCount(0), displayOmitted: agentCount(0), degraded: false, selected: undefined, offset: 0 };
}

export function replaceRows(model: AgentWidgetModel, snapshot: AgentWidgetSnapshot): AgentWidgetModel {
  const rows: AgentRow[] = [];
  const ordinals = new Set<AgentOrdinal>();
  let dropped = 0;
  for (const row of snapshot.rows) {
    if (rows.length >= Number(MAX_WIDGET_ROWS) || row.ordinal.length > MAX_ORDINAL_CHARS || ordinals.has(row.ordinal)) {
      dropped += 1;
      continue;
    }
    ordinals.add(row.ordinal);
    rows.push(bound(row));
  }
  const previousIndex = model.selected === undefined ? -1 : model.rows.findIndex((row) => row.ordinal === model.selected);
  return {
    rows,
    total: snapshot.total,
    sourceOmitted: snapshot.omitted,
    displayOmitted: agentCount(dropped),
    degraded: snapshot.degraded,
    selected: reselect(rows, model.selected, previousIndex),
    offset: clampOffset(model.offset, rows.length),
  };
}

export function selectFirst(model: AgentWidgetModel): AgentWidgetModel {
  const first = model.rows[0];
  return first === undefined ? model : { ...model, selected: first.ordinal, offset: 0 };
}

export function clearSelection(model: AgentWidgetModel): AgentWidgetModel { return { ...model, selected: undefined }; }

export function moveSelection(model: AgentWidgetModel, direction: "up" | "down", budget: number): { readonly model: AgentWidgetModel; readonly exit: boolean } {
  const index = model.rows.findIndex((row) => row.ordinal === model.selected);
  if (index === -1) return direction === "down" ? { model: selectFirst(model), exit: false } : { model: clearSelection(model), exit: true };
  if (direction === "up" && index === 0) return { model: clearSelection(model), exit: true };
  const next = direction === "up" ? index - 1 : Math.min(index + 1, model.rows.length - 1);
  const selected = model.rows[next]!.ordinal;
  return { model: { ...model, selected, offset: scrollTo(model.offset, next, budget, model.rows.length) }, exit: false };
}

export function visibleRows(model: AgentWidgetModel, budget: number): readonly AgentRow[] {
  const index = model.rows.findIndex((row) => row.ordinal === model.selected);
  const offset = index === -1 ? clampOffset(model.offset, model.rows.length, budget) : scrollTo(model.offset, index, budget, model.rows.length);
  return model.rows.slice(offset, offset + Math.max(0, budget));
}

export function rowBudget(terminalRows: number): number { return Math.min(10, Math.max(3, Math.floor(terminalRows / 4))); }

function scrollTo(offset: number, index: number, budget: number, length: number): number {
  const size = Math.max(1, budget);
  const lower = Math.max(0, index - size + 1);
  return clampOffset(Math.min(Math.max(offset, lower), index), length, size);
}
function clampOffset(offset: number, length: number, budget = length): number { return Math.max(0, Math.min(offset, Math.max(0, length - Math.max(0, budget)))); }
function reselect(rows: readonly AgentRow[], selected: AgentOrdinal | undefined, previousIndex: number): AgentOrdinal | undefined {
  if (selected === undefined || rows.length === 0) return undefined;
  if (rows.some((row) => row.ordinal === selected)) return selected;
  if (previousIndex < 0) return undefined;
  return rows[Math.min(previousIndex, rows.length - 1)]!.ordinal;
}

function bound(row: AgentRow): AgentRow {
  return {
    ...row,
    // The source brands these labels; slicing preserves their display-label meaning while enforcing this model's tighter retention bounds.
    context: row.context.slice(0, MAX_CONTEXT_CHARS) as ContextLabel,
    model: row.model.slice(0, MAX_MODEL_CHARS) as ModelLabel,
    taskLabel: row.taskLabel.slice(0, MAX_TASK_LABEL_CHARS) as TaskLabel,
    // The source brand has no runtime guarantees; NaN becomes zero, infinities clamp at an endpoint,
    // and truncation makes the finite result an integer before agentDepth re-brands it.
    depth: agentDepth(Math.min(MAX_DEPTH, Math.max(0, Math.trunc(Number.isNaN(Number(row.depth)) ? 0 : Number(row.depth))))),
  };
}
