/** Schema version stamped on newly persisted lifecycle event envelopes. */
export const CURRENT_EVENT_SCHEMA_VERSION = 2;

/** Historical lifecycle schema retained verbatim for restoration. */
export const HISTORICAL_EVENT_SCHEMA_VERSION = 1;

/** Custom entry `customType` used for all persisted lifecycle events. */
export const AGENT_EVENT_CUSTOM_TYPE = "pi-subagents:event";

/** Environment variable set on child processes so this extension self-suppresses lifecycle tools. */
export const CHILD_MARKER_ENV = "PI_SUBAGENT_CHILD";

/** Default maximum number of concurrently running agents. */
export const DEFAULT_MAX_CONCURRENT_RUNS = 4;

/** Maximum time for strict live assignment identity resolution. */
export const ASSIGNMENT_IDENTITY_TIMEOUT_MS = 5_000;

/** Interval between post-barrier assignment identity snapshots. */
export const ASSIGNMENT_IDENTITY_POLL_MS = 25;

/** Maximum UTF-8 bytes retained in a single persisted completion output. */
export const MAX_COMPLETION_OUTPUT_BYTES = 50_000;

/** Maximum UTF-8 bytes retained per persisted or model-visible error message. */
export const MAX_ERROR_MESSAGE_BYTES = 10_000;

/** Maximum time to prove a cgroup has become empty. */
export const CONTAINMENT_TIMEOUT_MS = 10_000;

/** Maximum UTF-8 bytes retained in a stderr tail. */
export const MAX_STDERR_TAIL_BYTES = 50_000;

/** Maximum aggregate UTF-8 bytes of completion output returned from one `receive_agent` call. */
export const MAX_AGGREGATE_RECEIVE_BYTES = 50_000;

/** Maximum size of one ordinary RPC record before it is discarded through the next LF. */
export const MAX_RPC_RECORD_BYTES = 16 * 1024 * 1024;

/** Maximum span of the authoritative child session JSONL inspected during bounded recovery. */
export const MAX_SESSION_RECOVERY_BYTES = 32 * 1024 * 1024;

/** Directory name (beneath the extension's state directory) holding per-parent child sessions. */
export const STATE_DIR_NAME = "pi-subagents";
