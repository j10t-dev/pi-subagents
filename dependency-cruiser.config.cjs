const FOUNDATION = "^src/(?:domain|constants|paths|schemas|containment|async-primitives|durable-fs|jsonl|assignment-identity|delegation-policy)\\.ts$";
const ORCHESTRATION_PI_HOST = "^(?:index\\.ts|src/(?:controller|run-controller|completion-service|tools|pi-composition)\\.ts)$";
const PRESENTATION_PROJECTION = "^src/(?:agent-observation|agent-observation-store|context-observation|observation-registry|observation-relay|observation-snapshot-path|snapshot-watcher|recursive-agent-index|tool-presentation|ui-forwarder|widget-diagnostics|ambient-status-lease|coalescer)\\.ts$|^src/agent-widget/";
const PERSISTENCE_LAUNCH_AUTHORITY = "^src/(?:persistence|restoration|output-store|pi-composition|pi-launcher|rpc-client|cgroup-v2|watchdog-client)\\.ts$";

module.exports = {
  forbidden: [
    {
      name: "no-runtime-production-cycles",
      severity: "error",
      from: { path: "^(?:index\\.ts|src/)" },
      to: {
        circular: true,
        viaOnly: { dependencyTypesNot: ["type-only"] },
      },
    },
    {
      name: "foundation-does-not-depend-upward",
      severity: "error",
      from: { path: FOUNDATION },
      to: { path: `${ORCHESTRATION_PI_HOST}|${PRESENTATION_PROJECTION}` },
    },
    {
      name: "projection-has-no-authority",
      severity: "error",
      from: { path: PRESENTATION_PROJECTION },
      to: { path: PERSISTENCE_LAUNCH_AUTHORITY },
    },
  ],
  options: {
    tsPreCompilationDeps: "specify",
    tsConfig: { fileName: "./tsconfig.json" },
  },
};
