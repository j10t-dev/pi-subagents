import {
  MAX_WIDGET_ROW_COUNT,
  agentCount,
  delegationDepth,
  milliseconds,
  processCount,
  runCapacity,
  utf8Bytes,
} from "./domain.ts";

export { MAX_ERROR_MESSAGE_BYTES, MAX_TRANSCRIPT_FILE_NAME_BYTES } from "./domain.ts";

/** Schema version stamped on newly persisted lifecycle event envelopes. */
export const CURRENT_EVENT_SCHEMA_VERSION = 2;

/** Historical lifecycle schema retained verbatim for restoration. */
export const HISTORICAL_EVENT_SCHEMA_VERSION = 1;

/** Custom entry `customType` used for all persisted lifecycle events. */
export const AGENT_EVENT_CUSTOM_TYPE = "pi-subagents:event";

/** Environment variable set on child processes so this extension self-suppresses lifecycle tools. */
export const CHILD_MARKER_ENV = "PI_SUBAGENT_CHILD";
export const CHILD_DEPTH_ENV = "PI_SUBAGENT_DEPTH";
export const CHILD_MAX_DEPTH_ENV = "PI_SUBAGENT_MAX_DEPTH";
export const CHILD_CAPACITY_ENV = "PI_SUBAGENT_MAX_CONCURRENT_RUNS";

/** Default maximum number of concurrently running agents. */
export const DEFAULT_MAX_CONCURRENT_RUNS = runCapacity(4);
export const DEFAULT_MAX_DEPTH = delegationDepth(1);
export const MAX_MAX_DEPTH = delegationDepth(8);
export const MAX_TREE_CHILD_PROCESSES = processCount(100);

/** Maximum time for strict live assignment identity resolution. */
export const ASSIGNMENT_IDENTITY_TIMEOUT_MS = milliseconds(5_000);

/** Interval between post-barrier assignment identity snapshots. */
export const ASSIGNMENT_IDENTITY_POLL_MS = milliseconds(25);

export const RELAY_FLUSH_WINDOW_MS = milliseconds(120);
export const INDEX_REFRESH_WINDOW_MS = milliseconds(120);
export const WATCH_FALLBACK_INTERVAL_MS = milliseconds(2_000);
export const MAX_WATCH_RETRY_INTERVAL_MS = milliseconds(30_000);

/** Maximum UTF-8 bytes retained in a single persisted completion output. */
export const MAX_COMPLETION_OUTPUT_BYTES = utf8Bytes(50_000);

/** Maximum time to prove a cgroup has become empty. */
export const CONTAINMENT_TIMEOUT_MS = milliseconds(10_000);

/** Maximum UTF-8 bytes retained in a stderr tail. */
export const MAX_STDERR_TAIL_BYTES = utf8Bytes(50_000);

/** Maximum final provider-visible serialised JSON bytes from one `await_agent` call. */
export const MAX_AGGREGATE_AWAIT_BYTES = utf8Bytes(50_000);

/** Maximum direct-child observations enumerated in one atomic snapshot/change set. */
export const MAX_DIRECT_AGENT_OBSERVATIONS = MAX_WIDGET_ROW_COUNT;

/** Maximum rows the widget retains and the direct source emits. Matches B1's direct bound. */
export const MAX_WIDGET_ROWS = agentCount(MAX_DIRECT_AGENT_OBSERVATIONS);

export const MAX_PENDING_ATTEMPT_EVENTS = 64;
export const MAX_PENDING_ATTEMPT_BYTES = utf8Bytes(64 * 1024);
export const MAX_PENDING_OBSERVATION_EVENTS = 256;
export const MAX_PENDING_OBSERVATION_BYTES = utf8Bytes(256 * 1024);

export const MAX_TRANSCRIPT_FIELD_BYTES = 8 * 1024;
export const MAX_TRANSCRIPT_SOURCE_ITEMS = 256;
export const MAX_TRANSCRIPT_SOURCE_BYTES = 256 * 1024;
export const MAX_TRANSCRIPT_STORE_ITEMS = 1_024;
export const MAX_TRANSCRIPT_STORE_BYTES = 1_024 * 1024;

/** Maximum size of one ordinary RPC record before it is discarded through the next LF. */
export const MAX_RPC_RECORD_BYTES = utf8Bytes(16 * 1024 * 1024);

/** Maximum span of the authoritative child session JSONL inspected during bounded recovery. */
export const MAX_SESSION_RECOVERY_BYTES = utf8Bytes(32 * 1024 * 1024);

/** Directory name (beneath the extension's state directory) holding per-parent child sessions. */
export const STATE_DIR_NAME = "pi-subagents";
