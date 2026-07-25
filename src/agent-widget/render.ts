import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";

import type { AgentRow } from "../agent-observation.ts";
import type { RenderWidth, WidgetRowBudget } from "../domain.ts";
import { visibleRows, type AgentWidgetModel } from "./model.ts";

export interface AgentWidgetView {
  readonly model: AgentWidgetModel;
  readonly sourceError: boolean;
  readonly navigationLost: boolean;
}

interface Concession { readonly label: boolean; readonly context: boolean; readonly model: boolean; readonly state: boolean; readonly prefix: boolean }
const LADDER: readonly Concession[] = [
  { label: true, context: true, model: true, state: true, prefix: true },
  { label: true, context: false, model: true, state: true, prefix: true },
  { label: true, context: false, model: false, state: true, prefix: true },
  { label: true, context: false, model: false, state: false, prefix: true },
  { label: true, context: false, model: false, state: false, prefix: false },
  { label: false, context: false, model: false, state: false, prefix: false },
];
const LABEL_FLOOR = 8;
const ANSI = /\u001b(?:\[[0-?]*[ -/]*[@-~]|\][^\u0007]*(?:\u0007|\u001b\\))/gu;
const CONTROL = /[\u0000-\u001f\u007f-\u009f]/gu;

export function renderRows(view: AgentWidgetView, width: RenderWidth, budget: WidgetRowBudget): string[] {
  const rows = visibleRows(view.model, budget);
  // Pi's public width utilities require raw numbers; `RenderWidth` has already normalised and
  // bounded the adapter value before this deliberate unbranding.
  const columns = Number(width);
  const step = chooseStep(rows, columns);
  const lines = step === undefined ? [] : rows.map((_, index) => line(rows, index, view.model, step, columns));
  return [header(view, lines.length, columns), ...lines];
}

function header(view: AgentWidgetView, rendered: number, width: number): string {
  const omitted = Number(view.model.sourceOmitted) + Number(view.model.displayOmitted);
  const parts = [`Subagents ${rendered}/${Number(view.model.total)}`];
  if (omitted > 0) parts.push(`${omitted} omitted`);
  if (view.model.degraded) parts.push("incomplete");
  if (view.sourceError) parts.push("stale — source error");
  if (view.navigationLost) parts.push("arrow navigation unavailable");
  for (let keep = parts.length; keep > 1; keep -= 1) {
    const candidate = parts.slice(0, keep).join(" · ");
    if (visibleWidth(candidate) <= width) return candidate;
  }
  const counts = parts[0]!;
  return visibleWidth(counts) <= width ? counts : truncateToWidth("Subagents", width);
}

function chooseStep(rows: readonly AgentRow[], width: number): Concession | undefined {
  if (rows.length === 0) return undefined;
  for (const step of LADDER) {
    const widest = Math.max(...rows.map((_, index) => fixedWidth(rows, index, step)));
    if (widest + (step.label ? LABEL_FLOOR : 0) <= width) return step;
  }
  return undefined;
}
function fixedWidth(rows: readonly AgentRow[], index: number, step: Concession): number { return visibleWidth(head(rows, index, step)) + visibleWidth(tail(rows[index]!, step)); }
function head(rows: readonly AgentRow[], index: number, step: Concession): string { return `  ${step.prefix ? prefix(rows, index) : ""}${sanitise(rows[index]!.ordinal)} `; }
function tail(row: AgentRow, step: Concession): string {
  const fields = [step.model ? sanitise(row.model) : "", step.context ? `(${sanitise(row.context)})` : ""].filter((field) => field.length > 0);
  const trailing = step.state ? ` ${sanitise(row.state)}` : "";
  return `${fields.join(" ")}${fields.length > 0 ? " " : ""}${trailing}`;
}
function line(rows: readonly AgentRow[], index: number, model: AgentWidgetModel, step: Concession, width: number): string {
  const row = rows[index]!;
  const marker = model.selected === row.ordinal ? "›" : " ";
  const start = `${marker}${head(rows, index, step).slice(1)}`;
  const end = tail(row, step);
  const room = Math.max(0, width - visibleWidth(start) - visibleWidth(end));
  const label = step.label ? truncateToWidth(sanitise(row.taskLabel), room) : "";
  const padding = " ".repeat(Math.max(0, room - visibleWidth(label)));
  return truncateToWidth(`${start}${label}${padding}${end}`, width);
}
function prefix(rows: readonly AgentRow[], index: number): string {
  const depth = Number(rows[index]!.depth);
  if (depth === 0) return "";
  return `${"   ".repeat(depth - 1)}${isLastAtDepth(rows, index) ? "└─ " : "├─ "}`;
}
function isLastAtDepth(rows: readonly AgentRow[], index: number): boolean {
  const depth = Number(rows[index]!.depth);
  for (let next = index + 1; next < rows.length; next += 1) {
    const other = Number(rows[next]!.depth);
    if (other < depth) return true;
    if (other === depth) return false;
  }
  return true;
}
function sanitise(value: string): string {
  return value.replace(ANSI, "").replace(/[\u0009\u000A\u000D]/gu, " ").replace(CONTROL, " ").replace(/\s+/gu, " ").trim();
}
