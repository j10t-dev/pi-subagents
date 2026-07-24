import {
  agentErrorCode,
  agentId,
  runId,
  type AbsolutePath,
  type AgentErrorCode,
  type AgentId,
  type RunId,
} from "./domain.ts";
import { directAgentRow, type AgentRow, type SubagentObservationPort } from "./agent-observation.ts";
import { diagnosticsPath, outputPath, sessionPath } from "./paths.ts";
import type { DiagnosticsPath, OutputPath, SessionPath } from "./domain.ts";

export interface AgentDisplayResolver {
  resolve(agentId: AgentId): AgentRow | undefined;
}

export function createObservationDisplayResolver(
  port: Pick<SubagentObservationPort, "observation">,
): AgentDisplayResolver {
  return { resolve: (id) => {
    const observation = port.observation(id);
    return observation === undefined ? undefined : directAgentRow(observation);
  } };
}

export function renderLifecycleToolResult(
  tool: "spawn_agent" | "send_input" | "await_agent" | "stop_agent",
  details: object,
  resolver: AgentDisplayResolver,
  options: { readonly expanded: boolean },
): string {
  const source = record(details) ?? {};
  const selected = tool === "await_agent"
    ? awaitLines(source, resolver, options.expanded)
    : ordinaryLines(tool, source, resolver, options.expanded);
  return admitLines(selected.lines, options.expanded ? 100 : 20, selected.omitted, title(tool));
}

interface SelectedLines { readonly lines: readonly string[]; readonly omitted: readonly string[] }
interface ResolvedLine { readonly id: AgentId; readonly row: AgentRow; readonly source: Record<string, unknown> }

function ordinaryLines(tool: string, source: Record<string, unknown>, resolver: AgentDisplayResolver, expanded: boolean): SelectedLines {
  const records = tool === "stop_agent" ? recordsFrom(source.outcomes) : [source];
  const resolved = records.flatMap((item) => resolveLine(item, resolver));
  const unavailable = resolved.length === 0 && records.length > 0 ? ["Agent · unavailable"] : [];
  const lines = [...resolved.sort(compareRows).map((item) => renderRow(item, expanded)), ...unavailable];
  return { lines, omitted: [] };
}

function awaitLines(source: Record<string, unknown>, resolver: AgentDisplayResolver, expanded: boolean): SelectedLines {
  const completions = recordsFrom(source.completions);
  const inventory = record(source.inventory) ?? {};
  const page = recordsFrom(inventory.agents);
  const completionIds = new Set(completions.flatMap((item) => nativeId(item) ?? []));
  const selected = new Map<AgentId, Record<string, unknown>>();
  for (const item of completions) { const id = nativeId(item); if (id !== undefined) selected.set(id, item); }
  let stopped = 0;
  for (const item of page) {
    const id = nativeId(item);
    if (id === undefined) continue;
    if (completionIds.has(id)) continue;
    if (!expanded && item.state === "stopped") { stopped++; continue; }
    selected.set(id, item);
  }
  const resolved: ResolvedLine[] = [];
  let unavailable = 0;
  for (const [id, item] of selected) {
    const row = resolver.resolve(id);
    if (row === undefined) unavailable++;
    else resolved.push({ id, row, source: item });
  }
  resolved.sort(compareRows);
  const lines = resolved.map((item) => renderRow(item, expanded));
  if (unavailable > 0) lines.push(...Array(unavailable).fill("Agent · unavailable"));
  const omitted: string[] = [];
  if (!expanded && stopped > 0) omitted.push(`${stopped} stopped agent${stopped === 1 ? "" : "s"} not shown`);
  const later = nonnegativeInteger(inventory.remaining);
  if (later > 0) omitted.push(`${later} inventory agent${later === 1 ? "" : "s"} on later pages`);
  if (expanded) {
    const cursor = validatedAgentId(inventory.nextAfterAgentId);
    const total = nonnegativeInteger(inventory.total);
    const omittedCount = nonnegativeInteger(inventory.omitted);
    const remaining = nonnegativeInteger(inventory.remaining);
    lines.unshift(`inventory total=${total} omitted=${omittedCount} remaining=${remaining}`);
    if (cursor !== undefined) lines.unshift(`nextAfterAgentId=${cursor}`);
  }
  return { lines, omitted };
}

function resolveLine(source: Record<string, unknown>, resolver: AgentDisplayResolver): ResolvedLine[] {
  const id = nativeId(source);
  if (id === undefined) return [];
  const row = resolver.resolve(id);
  return row === undefined ? [] : [{ id, row, source }];
}

function renderRow(item: ResolvedLine, expanded: boolean): string {
  const errorCode = validatedErrorCode(record(item.source.error)?.code);
  const base = `${item.row.ordinal} · ${item.row.model} · ${item.row.taskLabel} · ${item.row.state}${errorCode === undefined ? "" : ` · ${errorCode}`}`;
  if (!expanded) return safeLine(base);
  const diagnostics = [`agentId=${item.id}`];
  const nativeRunId = validatedRunId(item.source.runId);
  if (nativeRunId !== undefined) diagnostics.push(`runId=${nativeRunId}`);
  const nativeOutputPath = validatedPath(item.source.outputPath, outputPath);
  if (nativeOutputPath !== undefined) diagnostics.push(`outputPath=${nativeOutputPath}`);
  const nativeTranscriptPath = validatedPath(item.source.transcriptPath, sessionPath);
  if (nativeTranscriptPath !== undefined) diagnostics.push(`transcriptPath=${nativeTranscriptPath}`);
  const sourceDiagnosticsPath = validatedPath(item.source.diagnosticsPath, diagnosticsPath);
  if (sourceDiagnosticsPath !== undefined) diagnostics.push(`diagnosticsPath=${sourceDiagnosticsPath}`);
  const errorDiagnosticsPath = validatedPath(record(item.source.error)?.diagnosticsPath, diagnosticsPath);
  if (errorDiagnosticsPath !== undefined) diagnostics.push(`diagnosticsPath=${errorDiagnosticsPath}`);
  return safeLine(`${base} · ${diagnostics.join(" ")}`);
}

function admitLines(lines: readonly string[], cap: number, omissions: readonly string[], fallbackTitle: string): string {
  const safe = lines.map(safeLine).filter((line) => line.length > 0);
  const semanticOmissions = [...omissions];
  const needsOmissionRow = semanticOmissions.length > 0 || safe.length > cap;
  let admitted = safe.slice(0, Math.max(0, cap - (needsOmissionRow ? 1 : 0)));
  let omissionLine = exactOmissionLine(semanticOmissions, safe.length - admitted.length);
  while (byteLength([...admitted, ...(omissionLine ? [omissionLine] : [])]) > 8_192 && admitted.length > 0) {
    admitted = admitted.slice(0, -1);
    omissionLine = exactOmissionLine(semanticOmissions, safe.length - admitted.length);
  }
  const output = [...admitted, ...(omissionLine ? [safeLine(omissionLine)] : [])].join("\n");
  if (new TextEncoder().encode(output).byteLength <= 8_192) return output || "Agent · unavailable";
  return `${fallbackTitle}\n${safe.length} additional rows omitted`;
}

function exactOmissionLine(semantic: readonly string[], additional: number): string {
  return [...semantic, ...(additional > 0 ? [`${additional} additional rows omitted`] : [])].join(" · ");
}

function nativeId(value: Record<string, unknown>): AgentId | undefined {
  if (typeof value.agentId !== "string") return undefined;
  try { return agentId(value.agentId); } catch { return undefined; }
}
function recordsFrom(value: unknown): Record<string, unknown>[] {
  if (!Array.isArray(value) || value.length > 10_000) return [];
  const records: Record<string, unknown>[] = [];
  for (const item of value) {
    const candidate = record(item);
    if (candidate !== undefined) records.push(candidate);
  }
  return records;
}
function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}
function compareRows(left: ResolvedLine, right: ResolvedLine): number {
  const a = String(left.row.ordinal).slice(1).split(".").map(Number);
  const b = String(right.row.ordinal).slice(1).split(".").map(Number);
  for (let index = 0; index < Math.max(a.length, b.length); index++) {
    const difference = (a[index] ?? -1) - (b[index] ?? -1);
    if (difference !== 0) return difference;
  }
  return 0;
}
function safeLine(value: string): string {
  return value.replace(/[\u0000-\u001f\u007f-\u009f\u061c\u200e-\u200f\u202a-\u202e\u2066-\u2069]/gu, " ").replace(/\s+/gu, " ").trim();
}
function validatedAgentId(value: unknown): AgentId | undefined {
  if (typeof value !== "string") return undefined;
  try { return agentId(value); } catch { return undefined; }
}
export function validatedRunId(value: unknown): RunId | undefined {
  if (typeof value !== "string") return undefined;
  try { return runId(value); } catch { return undefined; }
}
export function validatedErrorCode(value: unknown): AgentErrorCode | undefined {
  if (typeof value !== "string") return undefined;
  try { return agentErrorCode(value); } catch { return undefined; }
}
export function validatedPath<T extends AbsolutePath>(
  value: unknown,
  constructor: (parent: string, child: string) => T,
): T | undefined {
  if (typeof value !== "string" || !value.startsWith("/") || new TextEncoder().encode(value).byteLength > 4_096 || safeLine(value) !== value) return undefined;
  try { return constructor("/", value); } catch { return undefined; }
}
function nonnegativeInteger(value: unknown): number { return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : 0 }
function byteLength(lines: readonly string[]): number { return new TextEncoder().encode(lines.join("\n")).byteLength }
function title(tool: string): string { return ({ spawn_agent: "Spawn agent", send_input: "Send input", await_agent: "Await agent", stop_agent: "Stop agent" } as Record<string, string>)[tool] ?? "Agent" }
