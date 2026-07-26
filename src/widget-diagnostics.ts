export const WidgetDiagnosticCode = {
  StartupFailed: "startup_failed",
  LifecycleFailed: "lifecycle_failed",
  MountFailed: "mount_failed",
  UnmountFailed: "unmount_failed",
  SourceFailed: "source_failed",
  RegistryFailed: "registry_failed",
  EditorFailed: "editor_failed",
  EditorReplaced: "editor_replaced",
  ComponentFailed: "component_failed",
  StatusFailed: "status_failed",
  TraceFailed: "trace_failed",
  RelayEncodeOversized: "relay_encode_oversized",
  RelayWriteFailed: "relay_write_failed",
  RelayRenameFailed: "relay_rename_failed",
  WatchUnavailable: "watch_unavailable",
  ConversationUnavailable: "conversation_unavailable",
  TranscriptRouteUnavailable: "transcript_route_unavailable",
  TranscriptReadRefused: "transcript_read_refused",
  TranscriptMalformed: "transcript_malformed",
  TranscriptOversized: "transcript_oversized",
  TranscriptWatchFallback: "transcript_watch_fallback",
} as const;

export type WidgetDiagnosticCode = (typeof WidgetDiagnosticCode)[keyof typeof WidgetDiagnosticCode];

const MESSAGES: Readonly<Record<WidgetDiagnosticCode, string>> = {
  [WidgetDiagnosticCode.StartupFailed]: "Subagent widget unavailable (startup_failed).",
  [WidgetDiagnosticCode.LifecycleFailed]: "Subagent widget unavailable (lifecycle_failed).",
  [WidgetDiagnosticCode.MountFailed]: "Subagent widget unavailable (mount_failed).",
  [WidgetDiagnosticCode.UnmountFailed]: "Subagent widget cleanup incomplete (unmount_failed).",
  [WidgetDiagnosticCode.SourceFailed]: "Subagent widget data unavailable (source_failed).",
  [WidgetDiagnosticCode.RegistryFailed]: "Subagent widget data unavailable (registry_failed).",
  [WidgetDiagnosticCode.EditorFailed]: "Subagent widget navigation unavailable (editor_failed).",
  [WidgetDiagnosticCode.EditorReplaced]: "Subagent widget arrow navigation unavailable (editor_replaced).",
  [WidgetDiagnosticCode.ComponentFailed]: "Subagent widget unavailable (component_failed).",
  [WidgetDiagnosticCode.StatusFailed]: "Subagent widget status unavailable (status_failed).",
  [WidgetDiagnosticCode.TraceFailed]: "Subagent widget gate trace unavailable (trace_failed).",
  [WidgetDiagnosticCode.RelayEncodeOversized]: "Agent observation snapshot exceeds the wire limit.",
  [WidgetDiagnosticCode.RelayWriteFailed]: "Agent observation snapshot could not be written.",
  [WidgetDiagnosticCode.RelayRenameFailed]: "Agent observation snapshot could not be published.",
  [WidgetDiagnosticCode.WatchUnavailable]: "Agent observation file watching is unavailable.",
  [WidgetDiagnosticCode.ConversationUnavailable]: "This agent's conversation is unavailable.",
  [WidgetDiagnosticCode.TranscriptRouteUnavailable]: "This agent's conversation is no longer available.",
  [WidgetDiagnosticCode.TranscriptReadRefused]: "This agent's conversation could not be opened safely.",
  [WidgetDiagnosticCode.TranscriptMalformed]: "This agent's conversation could not be read.",
  [WidgetDiagnosticCode.TranscriptOversized]: "This agent's conversation exceeds the readable limit.",
  [WidgetDiagnosticCode.TranscriptWatchFallback]: "This agent's conversation is refreshing periodically.",
};

/**
 * The bounded subset a transcript source may report. Narrowing the port to these codes keeps
 * transcript acquisition from reaching any diagnostic that could carry unrelated detail.
 */
export const TranscriptDiagnosticCode = {
  RouteUnavailable: WidgetDiagnosticCode.TranscriptRouteUnavailable,
  ReadRefused: WidgetDiagnosticCode.TranscriptReadRefused,
  Malformed: WidgetDiagnosticCode.TranscriptMalformed,
  Oversized: WidgetDiagnosticCode.TranscriptOversized,
  WatchFallback: WidgetDiagnosticCode.TranscriptWatchFallback,
} as const;

export type TranscriptDiagnosticCode = (typeof TranscriptDiagnosticCode)[keyof typeof TranscriptDiagnosticCode];

/** Returns only bounded, static user-facing text. Exception details never enter this module. */
export function widgetDiagnostic(code: WidgetDiagnosticCode): string {
  return MESSAGES[code];
}
