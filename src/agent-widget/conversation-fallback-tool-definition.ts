import type { Theme, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";

import type { ToolDisplayName } from "../domain.ts";

/**
 * Replaces both native built-in renderers for a tool record whose data cannot drive them.
 *
 * `ToolExecutionComponent` resolves a built-in definition from the tool name unconditionally, and a
 * supplied definition takes precedence over it, so this keeps Pi's native shell while guaranteeing
 * that the built-in renderers are never reached. Rendering never calls `execute`.
 */
export function createPresentationToolDefinition(tool: ToolDisplayName, theme: Theme): ToolDefinition {
  return {
    name: String(tool),
    label: String(tool),
    description: "Read-only child tool presentation",
    parameters: Type.Object({}, { additionalProperties: true }),
    execute: () => Promise.reject(new Error("invalid_state: presentation tool definitions never execute")),
    renderCall: () => new Text(theme.fg("toolTitle", String(tool)), 1, 0),
    renderResult: (_result, _options, _renderTheme, context) => new Text(
      theme.fg(context.isError ? "error" : "toolOutput", presentationSummary(context.isError)),
      1,
      0,
    ),
  };
}

function presentationSummary(isError: boolean): string {
  return isError ? "Result unavailable for native rendering" : "Result shown in bounded form";
}
