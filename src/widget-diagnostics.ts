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
};

/** Returns only bounded, static user-facing text. Exception details never enter this module. */
export function widgetDiagnostic(code: WidgetDiagnosticCode): string {
  return MESSAGES[code];
}
