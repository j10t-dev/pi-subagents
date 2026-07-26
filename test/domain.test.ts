import { describe, expect, test } from "bun:test";
import { Value } from "typebox/value";

import {
  AgentErrorCode,
  CodedError,
  MAX_WIDGET_ROW_COUNT,
  MAX_AGENT_ORDINAL_BYTES,
  agentOrdinal,
  codedErrorToAgentError,
  AgentEventType,
  AgentState,
  CancellationReason,
  CompletionState,
  agentCount,
  agentDepth,
  agentObservationRevision,
  agentWidgetRevision,
  assistantGeneration,
  contextPercent,
  directAgentOrdinal,
  rpcContentIndex,
  rpcStopReason,
  rpcToolCallId,
  transcriptRevision,
  transcriptSequence,
  agentId,
  assertTransition,
  createRpcRequestId,
  createRunAttemptId,
  delegationDepth,
  incarnationId,
  isLegalTransition,
  milliseconds,
  newIncarnationId,
  nextDelegationDepth,
  observationRevision,
  processCount,
  processGroupId,
  processId,
  runCapacity,
  utf16CodeUnitOffset,
  modelId,
  modelSpec,
  modelSpecFrom,
  modelSpecParts,
  providerId,
  PublicPreflightError,
  rpcRequestId,
  runAttemptId,
  runId,
  runIdFromEntry,
  sessionEntryId,
  toAgentError,
  truncateUtf8,
  retainUtf8Tail,
  toolName,
  transcriptFileName,
  tryAgentOrdinal,
  tryTranscriptFileName,
  uiRequestId,
  utf8Bytes,
  MAX_TRANSCRIPT_FILE_NAME_BYTES,
  type AgentCompletion,
  type CgroupScopePath,
  type CommittedOutputPath,
  type DelegationDepth,
  type Milliseconds,
  type ModelId,
  type ModelSpec,
  type ObservationRevision,
  type ObservationSnapshotPath,
  type OutputPath,
  type ProcessCount,
  type ProcessGroupId,
  type ProcessId,
  type RunCapacity,
  type Utf16CodeUnitOffset,
  type Utf8Bytes,
  type ProviderId,
  type RpcRequestId,
  type ToolName,
  type UIRequestId,
  type WidgetRowCount,
  type AgentCount,
  type IncarnationId,
  type TranscriptFileName,
} from "../src/domain.ts";
import { absolutePath, diagnosticsPath, outputPath, sessionPath } from "../src/paths.ts";
import {
  AgentCompletionSchema,
  AgentErrorSchema,
  AgentUsageSchema,
  CompletionOutputSchema,
  RunLaunchRequestedPayloadSchema,
  RunStartedPayloadSchema,
  RunStoppingPayloadSchema,
  SettingsDocumentSchema,
  SpawnedPayloadSchema,
  SubagentSettingsSchema,
  UsageSchema,
  decodePersistedAgentEvent,
} from "../src/schemas.ts";
import type { Usage } from "../src/domain.ts";

/** Widens a branded `as const` object's values back to plain strings for assertions. */
function stringValues(obj: object): string[] {
  return Object.values(obj) as string[];
}

const RPC_ID: RpcRequestId = rpcRequestId("rpc-1");
const UI_ID: UIRequestId = uiRequestId("ui-1");
// @ts-expect-error RPC and child-originated UI correlation namespaces are distinct.
const _uiAsRpc: RpcRequestId = UI_ID;
// @ts-expect-error UI and RPC correlation namespaces are distinct.
const _rpcAsUi: UIRequestId = RPC_ID;
void _uiAsRpc;
void _rpcAsUi;

const CANDIDATE_OUTPUT: OutputPath = outputPath("/tmp", "candidate");
// @ts-expect-error a contained destination is not yet a durable committed file.
const _candidateAsCommitted: CommittedOutputPath = CANDIDATE_OUTPUT;
const _completionWithCandidate: AgentCompletion = {
  state: "completed",
  agentId: agentId("agent-a"),
  runId: runId("deadbeef"),
  output: truncateUtf8("", utf8Bytes(0)),
  // @ts-expect-error AgentCompletion cannot expose a merely intended output destination.
  outputPath: CANDIDATE_OUTPUT,
  transcriptPath: sessionPath("/tmp", "session.jsonl"),
};
void _candidateAsCommitted;
void _completionWithCandidate;

const PROVIDER_ID: ProviderId = providerId("anthropic");
const MODEL_ID: ModelId = modelId("claude/sonnet:latest");
const TOOL_NAME: ToolName = toolName("read");
const MODEL_SPEC: ModelSpec = modelSpecFrom(PROVIDER_ID, MODEL_ID);
// @ts-expect-error provider IDs and model IDs are distinct identities.
const _modelAsProvider: ProviderId = MODEL_ID;
// @ts-expect-error model IDs and tool names are distinct identities.
const _toolAsModel: ModelId = TOOL_NAME;
// @ts-expect-error complete model specs are not provider IDs.
const _specAsProvider: ProviderId = MODEL_SPEC;
void _modelAsProvider;
void _toolAsModel;
void _specAsProvider;

const DURATION: Milliseconds = milliseconds(10);
const BYTE_COUNT: Utf8Bytes = utf8Bytes(10);
const DEPTH: DelegationDepth = delegationDepth(1);
void BYTE_COUNT;
void DEPTH;
const CAPACITY: RunCapacity = runCapacity(4);
const PROCESS_COUNT: ProcessCount = processCount(4);
const OFFSET: Utf16CodeUnitOffset = utf16CodeUnitOffset(4);
const PROCESS_ID: ProcessId = processId(42);
const PROCESS_GROUP_ID: ProcessGroupId = processGroupId(42);
const OBSERVATION_REVISION: ObservationRevision = observationRevision(0);
const MAXIMUM_WIDGET_ROWS: WidgetRowCount = MAX_WIDGET_ROW_COUNT;
// @ts-expect-error widget row counts and observed agent counts are distinct numeric domains.
const _widgetRowsAsAgents: AgentCount = MAX_WIDGET_ROW_COUNT;
const ABSOLUTE_PATH = absolutePath("/tmp/proof-boundary");
// @ts-expect-error an arbitrary absolute path has no canonical cgroup-scope proof.
const _absoluteAsCgroupScope: CgroupScopePath = ABSOLUTE_PATH;
// @ts-expect-error an arbitrary absolute path has no managed snapshot-path proof.
const _absoluteAsObservationSnapshot: ObservationSnapshotPath = ABSOLUTE_PATH;
// @ts-expect-error process IDs and process-group IDs are distinct identities.
const _processAsGroup: ProcessGroupId = PROCESS_ID;
// @ts-expect-error process IDs and process counts are distinct numeric domains.
const _processAsCount: ProcessCount = PROCESS_ID;
// @ts-expect-error observation revisions are not process IDs.
const _revisionAsProcess: ProcessId = OBSERVATION_REVISION;
// @ts-expect-error process-group IDs are not observation revisions.
const _groupAsRevision: ObservationRevision = PROCESS_GROUP_ID;
// @ts-expect-error durations and byte counts are distinct units.
const _durationAsBytes: Utf8Bytes = DURATION;
// @ts-expect-error capacity and delegation depth are distinct units.
const _capacityAsDepth: DelegationDepth = CAPACITY;
// @ts-expect-error process counts and capacities are distinct units.
const _processCountAsCapacity: RunCapacity = PROCESS_COUNT;
// @ts-expect-error UTF-16 offsets and UTF-8 byte counts are distinct units.
const _offsetAsBytes: Utf8Bytes = OFFSET;
void _absoluteAsCgroupScope;
void _absoluteAsObservationSnapshot;
void _processAsGroup;
void _processAsCount;
void _revisionAsProcess;
void _groupAsRevision;
void _durationAsBytes;
void _capacityAsDepth;
void _processCountAsCapacity;
void _offsetAsBytes;
void MAXIMUM_WIDGET_ROWS;
void _widgetRowsAsAgents;

describe("correlation identities", () => {
  test("constructs non-empty RPC and UI identities", () => {
    expect(rpcRequestId("rpc-1") as string).toBe("rpc-1");
    expect(uiRequestId("ui-1") as string).toBe("ui-1");
    expect(createRpcRequestId().length).toBeGreaterThan(0);
  });

  test("rejects empty correlation identities", () => {
    expect(() => rpcRequestId("")).toThrow("protocol_error:");
    expect(() => uiRequestId("")).toThrow("protocol_error:");
  });
});

describe("agentId", () => {
  test("accepts a valid native session id", () => {
    expect(agentId("a1b2c3d4") as string).toBe("a1b2c3d4");
    expect(agentId("my-session_id.1") as string).toBe("my-session_id.1");
  });

  test("rejects an invalid native session id", () => {
    expect(() => agentId("not a session id")).toThrow(/invalid_agent/);
    expect(() => agentId("")).toThrow();
    expect(() => agentId("-leading-dash")).toThrow();
    expect(() => agentId("trailing-dash-")).toThrow();
  });

  test("rejects an unbounded native session id", () => {
    expect(() => agentId("a".repeat(257))).toThrow("invalid_agent:");
  });
});

describe("incarnationId", () => {
  test("accepts the relay incarnation alphabet and round-trips generated values", () => {
    expect(incarnationId("Ab_c-9") as string).toBe("Ab_c-9");
    const generated: IncarnationId = newIncarnationId();
    expect(incarnationId(generated) as string).toBe(generated as string);
  });

  test.each(["", "a".repeat(65), "has space", "has/slash", "has\u0000control"])(
    "rejects invalid incarnation ID %#",
    (value) => expect(() => incarnationId(value)).toThrow(`invalid incarnation id: ${JSON.stringify(value)}`),
  );
});

describe("agentOrdinal", () => {
  test("tryAgentOrdinal and agentOrdinal share the complete bounded grammar", () => {
    const valid = "A1.2.3";
    expect(tryAgentOrdinal(valid) as string).toBe(valid);
    expect(agentOrdinal(valid) as string).toBe(valid);

    for (const invalid of ["A1.0", `A${"1".repeat(Number(MAX_AGENT_ORDINAL_BYTES))}`]) {
      expect(tryAgentOrdinal(invalid)).toBeUndefined();
      expect(() => agentOrdinal(invalid)).toThrow(/invalid agent ordinal/);
    }
  });
});

describe("transcriptFileName", () => {
  test.each([
    "child.jsonl",
    "2026-07-26T03-06-36-283Z_019f9c63-877b-72df-9192-75506e278a7a.jsonl",
  ])("brands a safe transcript basename: %s", (value) => {
    expect(transcriptFileName(value)).toBe(value as TranscriptFileName);
    expect(tryTranscriptFileName(value)).toBe(value as TranscriptFileName);
  });

  test.each(["", ".", "..", "child", "child.txt", "../child.jsonl", "dir/child.jsonl", "dir\\child.jsonl", "bad\u0000.jsonl", `${"x".repeat(251)}.jsonl`])(
    "rejects an unsafe transcript basename: %s",
    (value) => expect(tryTranscriptFileName(value)).toBeUndefined(),
  );

  test("admits the exact byte bound and throws on every rejected basename", () => {
    const longest = `${"x".repeat(Number(MAX_TRANSCRIPT_FILE_NAME_BYTES) - 6)}.jsonl`;
    const longestMultibyte = `${"界".repeat(83)}.jsonl`;
    expect(transcriptFileName(longest)).toBe(longest as TranscriptFileName);
    expect(transcriptFileName(longestMultibyte)).toBe(longestMultibyte as TranscriptFileName);
    expect(tryTranscriptFileName(`${"界".repeat(84)}.jsonl`)).toBeUndefined();
    expect(() => transcriptFileName("dir/child.jsonl")).toThrow(/transcript file name/);
  });
});

describe("sessionEntryId / runId", () => {
  test("accepts 8-char lowercase hex ids", () => {
    expect(sessionEntryId("a1b2c3d4") as string).toBe("a1b2c3d4");
    expect(runId("deadbeef") as string).toBe("deadbeef");
  });

  test("rejects malformed entry ids", () => {
    expect(() => sessionEntryId("A1B2C3D4")).toThrow();
    expect(() => sessionEntryId("short")).toThrow();
    expect(() => sessionEntryId("toolongid")).toThrow();
    expect(() => runId("not-hex!!")).toThrow();
  });
});

describe("runIdFromEntry", () => {
  test("returns the entry id for a user message entry", () => {
    expect(
      runIdFromEntry({ id: "a1b2c3d4", type: "message", message: { role: "user" } }) as
        | string
        | undefined,
    ).toBe("a1b2c3d4");
  });

  test("returns undefined for an assistant message entry", () => {
    expect(
      runIdFromEntry({ id: "a1b2c3d4", type: "message", message: { role: "assistant" } }),
    ).toBeUndefined();
  });

  test("returns undefined for non-message entry types", () => {
    expect(runIdFromEntry({ id: "a1b2c3d4", type: "custom" })).toBeUndefined();
  });

  test("returns undefined for a malformed entry id", () => {
    expect(
      runIdFromEntry({ id: "not-an-id", type: "message", message: { role: "user" } }),
    ).toBeUndefined();
  });
});

describe("runAttemptId / createRunAttemptId", () => {
  test("creates unique non-empty attempt ids", () => {
    const a = createRunAttemptId();
    const b = createRunAttemptId();
    expect(a).not.toBe(b);
    expect(a.length).toBeGreaterThan(0);
  });

  test("rejects an empty attempt id", () => {
    expect(() => runAttemptId("")).toThrow(/invalid_input/);
  });
});

describe("provider/model/tool identities", () => {
  test("constructs canonical model specs and splits only the first slash", () => {
    const provider = providerId("gateway");
    const model = modelId("vendor/special:latest");
    const spec = modelSpecFrom(provider, model);
    expect(spec as string).toBe("gateway/vendor/special:latest");
    expect(modelSpecParts(spec)).toEqual({ provider, modelId: model });
    expect(modelSpec("gateway/vendor/special:latest") as string).toBe(spec as string);
  });

  test.each(["", " ", " anthropic", "anthropic ", "anthropic/api", "bad\0provider", "bad\nprovider", "bad\u007fprovider"])(
    "rejects invalid provider ID %#",
    (value) => expect(() => providerId(value)).toThrow(/invalid_input/),
  );

  test.each(["", " ", " model", "model ", "bad\0model", "bad\nmodel", "bad\u007fmodel"])(
    "rejects invalid model ID %#",
    (value) => expect(() => modelId(value)).toThrow(/invalid_input/),
  );

  test("allows slash and colon inside a model ID", () => {
    expect(modelId("vendor/model:latest") as string).toBe("vendor/model:latest");
  });

  test.each(["", "bad\0tool", "bad\ntool", "bad\u007ftool", "£".repeat(129)])(
    "rejects invalid tool name %#",
    (value) => expect(() => toolName(value)).toThrow(/invalid_input/),
  );

  test("accepts a tool name at the 256-byte boundary", () => {
    expect(toolName("£".repeat(128)) as string).toBe("£".repeat(128));
  });

  test.each(["", "bare-id", "/model", "provider/", " provider/model", "provider/model "])(
    "rejects invalid model spec %#",
    (value) => expect(() => modelSpec(value)).toThrow(/invalid_input/),
  );
});

describe("absolutePath", () => {
  test("rejects NUL before resolving a path", () => {
    expect(() => absolutePath("safe\0escape")).toThrow(/invalid_input/);
  });
});

describe("semantic numeric constructors", () => {
  test("constructs units, depths and counts", () => {
    expect(milliseconds(0) as number).toBe(0);
    expect(utf8Bytes(0) as number).toBe(0);
    expect(utf16CodeUnitOffset(4) as number).toBe(4);
    expect(delegationDepth(1) as number).toBe(1);
    expect(nextDelegationDepth(delegationDepth(1)) as number).toBe(2);
    expect(runCapacity(4) as number).toBe(4);
    expect(processCount(4) as number).toBe(4);
    expect(processId(42) as number).toBe(42);
    expect(processGroupId(43) as number).toBe(43);
    expect(observationRevision(0) as number).toBe(0);
    expect(String(directAgentOrdinal(1))).toBe("A1");
    expect(Number(agentObservationRevision(0))).toBe(0);
    expect(Number(agentWidgetRevision(0))).toBe(0);
    expect(Number(transcriptSequence(0))).toBe(0);
    expect(Number(transcriptRevision(0))).toBe(0);
    expect(Number(contextPercent(42.5))).toBe(42.5);
    expect(Number(agentDepth(8))).toBe(8);
    expect(Number(agentCount(0))).toBe(0);
    expect(Number(assistantGeneration(1))).toBe(1);
    expect(Number(rpcContentIndex(0))).toBe(0);
    expect(String(rpcToolCallId("call-1"))).toBe("call-1");
    expect(String(rpcStopReason("future-reason"))).toBe("future-reason");
  });

  test.each([
    milliseconds,
    utf8Bytes,
    utf16CodeUnitOffset,
    delegationDepth,
    processCount,
  ])("rejects negative, fractional, non-finite and unsafe values", (construct) => {
    for (const value of [-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER + 1]) {
      expect(() => construct(value)).toThrow(/invalid_input/);
    }
  });

  test.each([processId, processGroupId])(
    "process identity rejects zero, negative, fractional, non-finite and unsafe values",
    (construct) => {
      for (const value of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER + 1]) {
        expect(() => construct(value)).toThrow(/invalid_input/);
      }
    },
  );

  test("observation revision rejects negative, fractional, non-finite and unsafe values", () => {
    for (const value of [-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER + 1]) {
      expect(() => observationRevision(value)).toThrow(/invalid_input/);
    }
  });

  test("capacity rejects zero and every invalid safe-integer boundary", () => {
    for (const value of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER + 1]) {
      expect(() => runCapacity(value)).toThrow(/invalid_input/);
    }
  });

  test("next depth rejects overflow", () => {
    expect(() => nextDelegationDepth(delegationDepth(Number.MAX_SAFE_INTEGER))).toThrow(/invalid_input/);
  });
});

describe("state/completion/error/cancellation literals", () => {
  test("AgentState covers the full lifecycle", () => {
    expect(stringValues(AgentState).sort()).toEqual(
      ["running", "settling", "stopped", "stopping"].sort(),
    );
  });

  test("CompletionState covers all terminal outcomes", () => {
    expect(stringValues(CompletionState).sort()).toEqual(
      ["cancelled", "completed", "failed"].sort(),
    );
  });

  test("CancellationReason covers both reasons", () => {
    expect(stringValues(CancellationReason).sort()).toEqual(
      ["parent_shutdown", "stop_requested"].sort(),
    );
  });

  test("AgentErrorCode covers every documented code", () => {
    expect(stringValues(AgentErrorCode).sort()).toEqual(
      [
        "invalid_input",
        "invalid_agent",
        "invalid_state",
        "capacity_exceeded",
        "spawn_failed",
        "protocol_error",
        "model_unavailable",
        "run_interrupted",
        "process_exited",
        "abort_failed",
        "containment_failed",
        "terminal_persistence_failed",
        "session_unavailable",
        "internal_error",
      ].sort(),
    );
  });

  test("AgentEventType covers every persisted lifecycle event", () => {
    expect(stringValues(AgentEventType).sort()).toEqual(
      [
        "spawned",
        "run_launch_requested",
        "run_started",
        "run_stopping",
        "run_completed",
      ].sort(),
    );
  });
});

describe("assertTransition / isLegalTransition", () => {
  test("allows every legal transition", () => {
    expect(() => assertTransition(AgentState.Stopped, AgentState.Running)).not.toThrow();
    expect(() => assertTransition(AgentState.Running, AgentState.Settling)).not.toThrow();
    expect(() => assertTransition(AgentState.Running, AgentState.Stopping)).not.toThrow();
    expect(() => assertTransition(AgentState.Settling, AgentState.Stopped)).not.toThrow();
    expect(() => assertTransition(AgentState.Stopping, AgentState.Stopped)).not.toThrow();
  });

  test("rejects every illegal transition", () => {
    expect(() => assertTransition(AgentState.Stopped, AgentState.Settling)).toThrow(
      "invalid_state",
    );
    expect(() => assertTransition(AgentState.Stopped, AgentState.Stopping)).toThrow();
    expect(() => assertTransition(AgentState.Running, AgentState.Stopped)).toThrow();
    expect(() => assertTransition(AgentState.Running, AgentState.Running)).toThrow();
    expect(() => assertTransition(AgentState.Settling, AgentState.Running)).toThrow();
    expect(() => assertTransition(AgentState.Settling, AgentState.Stopping)).toThrow();
    expect(() => assertTransition(AgentState.Stopping, AgentState.Settling)).toThrow();
    expect(() => assertTransition(AgentState.Stopping, AgentState.Running)).toThrow();
  });

  test("isLegalTransition mirrors assertTransition without throwing", () => {
    expect(isLegalTransition(AgentState.Stopped, AgentState.Running)).toBe(true);
    expect(isLegalTransition(AgentState.Stopped, AgentState.Settling)).toBe(false);
  });
});

describe("truncateUtf8", () => {
  test("retains a UTF-8-safe diagnostic tail at the 50 KB boundary", () => {
    const tail = retainUtf8Tail(`old${"£".repeat(30_000)}END`, utf8Bytes(50_000));
    expect(Buffer.byteLength(tail)).toBeLessThanOrEqual(50_000);
    expect(tail.endsWith("END")).toBeTrue();
    expect(tail).not.toContain("�");
  });
  test("returns the original text untruncated when within budget", () => {
    expect(truncateUtf8("hello", utf8Bytes(10)) as unknown).toEqual({
      text: "hello",
      originalBytes: 5,
      retainedBytes: 5,
      truncated: false,
    });
  });

  test("truncates to a valid UTF-8 prefix, never splitting a multi-byte character", () => {
    expect(truncateUtf8("£££", utf8Bytes(5)) as unknown).toEqual({
      text: "££",
      originalBytes: 6,
      retainedBytes: 4,
      truncated: true,
    });
  });

  test("handles a zero byte budget", () => {
    expect(truncateUtf8("abc", utf8Bytes(0)) as unknown).toEqual({
      text: "",
      originalBytes: 3,
      retainedBytes: 0,
      truncated: true,
    });
  });

  test("handles ASCII truncation at an exact boundary", () => {
    expect(truncateUtf8("abcdef", utf8Bytes(3)) as unknown).toEqual({
      text: "abc",
      originalBytes: 6,
      retainedBytes: 3,
      truncated: true,
    });
  });
});

describe("toAgentError", () => {
  test("produces a stable bounded message for each error code", () => {
    for (const code of Object.values(AgentErrorCode)) {
      const err = toAgentError(code);
      expect(err.code).toBe(code);
      expect(err.message.length).toBeLessThanOrEqual(10_000);
      expect(err.message).not.toContain("secret transport dump");
    }
  });

  test("attaches an optional diagnostics path without altering the message", () => {
    const withPath = toAgentError(AgentErrorCode.ProtocolError, diagnosticsPath("/tmp", "diag.log"));
    expect(String(withPath.diagnosticsPath)).toBe("/tmp/diag.log");
    expect(withPath.message).toBe(toAgentError(AgentErrorCode.ProtocolError).message);
    const withoutPath = toAgentError(AgentErrorCode.ProtocolError);
    expect(withoutPath.diagnosticsPath).toBeUndefined();
  });
});

describe("CodedError", () => {
  test("carries a stable code-prefixed message and its code for every error code", () => {
    for (const code of Object.values(AgentErrorCode)) {
      const error = new CodedError(code);
      expect(error).toBeInstanceOf(Error);
      expect(error.name).toBe("CodedError");
      expect(error.code).toBe(code);
      expect(error.message).toBe(`${code}: ${toAgentError(code).message}`);
      expect(error.diagnosticsPath).toBeUndefined();
    }
  });

  test("retains a diagnostics path through codedErrorToAgentError", () => {
    const path = diagnosticsPath("/tmp", "coded.log");
    const withPath = codedErrorToAgentError(new CodedError(AgentErrorCode.ProtocolError, path));
    expect(withPath).toEqual({
      code: AgentErrorCode.ProtocolError,
      message: toAgentError(AgentErrorCode.ProtocolError).message,
      diagnosticsPath: path,
    });
    const withoutPath = codedErrorToAgentError(new CodedError(AgentErrorCode.ProtocolError));
    expect(withoutPath.diagnosticsPath).toBeUndefined();
  });

  test("exposes no own enumerable state at the tool boundary", () => {
    const path = diagnosticsPath("/tmp", "coded.log");
    const withPath = new CodedError(AgentErrorCode.SpawnFailed, path);
    const withoutPath = new CodedError(AgentErrorCode.SpawnFailed);
    expect(Object.keys(withPath)).toEqual([]);
    expect(JSON.stringify(withoutPath)).toBe("{}");
    expect("diagnosticsPath" in withoutPath).toBe(false);
  });

  test("PublicPreflightError keeps its caller-supplied public message", () => {
    const error = new PublicPreflightError(AgentErrorCode.InvalidInput, "custom guidance text");
    expect(error.message).toBe("invalid_input: custom guidance text");
    expect(error.code).toBe(AgentErrorCode.InvalidInput);
  });
});

describe("public TypeBox schemas", () => {
  test("CompletionOutputSchema accepts a well-formed output and rejects malformed shapes", () => {
    expect(
      Value.Check(CompletionOutputSchema, {
        text: "hi",
        originalBytes: 2,
        retainedBytes: 2,
        truncated: false,
      }),
    ).toBe(true);
    expect(Value.Check(CompletionOutputSchema, { text: "hi" })).toBe(false);
  });

  test("AgentErrorSchema accepts valid codes and rejects unknown codes", () => {
    expect(Value.Check(AgentErrorSchema, { code: "invalid_input", message: "x" })).toBe(true);
    expect(Value.Check(AgentErrorSchema, { code: "not_a_code", message: "x" })).toBe(false);
  });

  test("SpawnedPayloadSchema validates spawn configuration", () => {
    const valid = {
      agentId: "a1b2c3d4",
      sessionPath: "/tmp/a1b2c3d4.jsonl",
      cwd: "/tmp",
      provider: "anthropic",
      modelId: "claude",
      thinkingLevel: "high",
      tools: ["read", "bash"],
    };
    expect(Value.Check(SpawnedPayloadSchema, valid)).toBe(true);
    expect(Value.Check(SpawnedPayloadSchema, { ...valid, thinkingLevel: "extreme" })).toBe(false);
  });

  test("RunLaunchRequestedPayloadSchema accepts a null previousLeafId", () => {
    const valid = {
      agentId: "a1b2c3d4",
      previousLeafId: null,
      attemptId: "attempt-1",
      containmentReceiptPath: "/tmp/receipt.json",
      containment: { backend: "cgroup-v2", scopePath: "/sys/fs/cgroup/pi-subagents/parent/attempt" },
    };
    expect(Value.Check(RunLaunchRequestedPayloadSchema, valid)).toBe(true);
    expect(
      Value.Check(RunLaunchRequestedPayloadSchema, { ...valid, previousLeafId: 5 }),
    ).toBe(false);
  });

  test("RunStartedPayloadSchema and RunStoppingPayloadSchema validate their shapes", () => {
    expect(
      Value.Check(RunStartedPayloadSchema, {
        agentId: "a1b2c3d4",
        runId: "deadbeef",
        attemptId: "attempt-1",
      }),
    ).toBe(true);
    expect(
      Value.Check(RunStoppingPayloadSchema, {
        agentId: "a1b2c3d4",
        runId: "deadbeef",
        reason: "stop_requested",
        containmentReceiptPath: "/tmp/receipt.json",
      }),
    ).toBe(true);
    expect(
      Value.Check(RunStoppingPayloadSchema, {
        agentId: "a1b2c3d4",
        runId: "deadbeef",
        reason: "not_a_reason",
        containmentReceiptPath: "/tmp/receipt.json",
      }),
    ).toBe(false);
  });

  test("AgentCompletionSchema discriminates completed/failed/cancelled variants", () => {
    const base = {
      agentId: "a1b2c3d4",
      runId: "deadbeef",
      output: { text: "", originalBytes: 0, retainedBytes: 0, truncated: false },
      outputPath: "/tmp/out.md",
      transcriptPath: "/tmp/session.jsonl",
    };
    expect(Value.Check(AgentCompletionSchema, { ...base, state: "completed" })).toBe(true);
    expect(
      Value.Check(AgentCompletionSchema, {
        ...base,
        state: "failed",
        error: { code: "process_exited", message: "x" },
      }),
    ).toBe(true);
    expect(
      Value.Check(AgentCompletionSchema, {
        ...base,
        state: "cancelled",
        reason: "stop_requested",
      }),
    ).toBe(true);
    expect(Value.Check(AgentCompletionSchema, { ...base, state: "unknown" })).toBe(false);
  });

  test("UsageSchema accepts a realistic Pi Usage value with cacheWrite1h/reasoning omitted", () => {
    const usage: Usage = {
      input: 1200,
      output: 340,
      cacheRead: 800,
      cacheWrite: 0,
      totalTokens: 2340,
      cost: { input: 0.003, output: 0.005, cacheRead: 0.0002, cacheWrite: 0, total: 0.0082 },
    };
    expect(Value.Check(UsageSchema, usage)).toBe(true);
    expect(Value.Check(AgentUsageSchema, { turns: 2, usage })).toBe(true);
  });

  test("UsageSchema accepts a realistic Pi Usage value with cacheWrite1h/reasoning present", () => {
    const usage: Usage = {
      input: 1200,
      output: 340,
      cacheRead: 800,
      cacheWrite: 500,
      cacheWrite1h: 120,
      reasoning: 96,
      totalTokens: 2340,
      cost: { input: 0.003, output: 0.005, cacheRead: 0.0002, cacheWrite: 0.001, total: 0.0092 },
    };
    expect(Value.Check(UsageSchema, usage)).toBe(true);
  });

  test.each([
    ["negative token", (usage: Usage) => ({ ...usage, input: -1 })],
    ["NaN token", (usage: Usage) => ({ ...usage, output: Number.NaN })],
    ["infinite token", (usage: Usage) => ({ ...usage, cacheRead: Number.POSITIVE_INFINITY })],
    ["negative optional", (usage: Usage) => ({ ...usage, reasoning: -1 })],
    ["NaN optional", (usage: Usage) => ({ ...usage, cacheWrite1h: Number.NaN })],
    ["negative cost", (usage: Usage) => ({ ...usage, cost: { ...usage.cost, total: -1 } })],
    ["infinite cost", (usage: Usage) => ({ ...usage, cost: { ...usage.cost, input: Number.POSITIVE_INFINITY } })],
  ] as const)("usage schema rejects %s", (_label, mutate) => {
    const validUsage: Usage = {
      input: 1200,
      output: 340,
      cacheRead: 800,
      cacheWrite: 500,
      cacheWrite1h: 120,
      reasoning: 96,
      totalTokens: 2340,
      cost: { input: 0.003, output: 0.005, cacheRead: 0.0002, cacheWrite: 0.001, total: 0.0092 },
    };
    expect(Value.Check(UsageSchema, mutate(validUsage))).toBe(false);
  });

  test("UsageSchema rejects a value missing a required cost field", () => {
    expect(
      Value.Check(UsageSchema, {
        input: 1,
        output: 1,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 2,
        cost: { input: 0, output: 0, cacheRead: 0, total: 0 },
      }),
    ).toBe(false);
  });

  test("UsageSchema rejects a value missing totalTokens", () => {
    expect(
      Value.Check(UsageSchema, {
        input: 1,
        output: 1,
        cacheRead: 0,
        cacheWrite: 0,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      }),
    ).toBe(false);
  });

  test("public schemas reject negative, non-finite and malformed branded DTO fields", () => {
    const usage = { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
    const valid = { agentId: "agent-a", runId: "deadbeef", state: "completed",
      output: { text: "", originalBytes: 0, retainedBytes: 0, truncated: false },
      outputPath: "/tmp/out", transcriptPath: "/tmp/session", usage: { turns: 1, usage } };
    expect(Value.Check(AgentCompletionSchema, { ...valid, agentId: "!" })).toBeFalse();
    expect(Value.Check(AgentCompletionSchema, { ...valid, runId: "not-a-run" })).toBeFalse();
    expect(Value.Check(AgentCompletionSchema, { ...valid, outputPath: "relative/path" })).toBeFalse();
    expect(Value.Check(UsageSchema, { ...valid.usage!.usage, input: -1 })).toBeFalse();
    expect(Value.Check(UsageSchema, { ...valid.usage!.usage, totalTokens: Number.NaN })).toBeFalse();
  });

  test("SubagentSettingsSchema and SettingsDocumentSchema validate safe limits and depth", () => {
    expect(Value.Check(SubagentSettingsSchema, { maxConcurrentRuns: 4, maxDepth: 0 })).toBe(true);
    expect(Value.Check(SubagentSettingsSchema, { maxConcurrentRuns: 4, maxDepth: 8 })).toBe(true);
    expect(Value.Check(SubagentSettingsSchema, { maxConcurrentRuns: 0 })).toBe(false);
    expect(Value.Check(SubagentSettingsSchema, { maxConcurrentRuns: 1.5 })).toBe(false);
    expect(Value.Check(SubagentSettingsSchema, { maxConcurrentRuns: Number.MAX_SAFE_INTEGER + 1 })).toBe(false);
    for (const maxDepth of [-1, 9, 1.5]) {
      expect(Value.Check(SubagentSettingsSchema, { maxDepth })).toBe(false);
      expect(Value.Check(SettingsDocumentSchema, { subagents: { maxDepth } })).toBe(false);
    }
    expect(Value.Check(SettingsDocumentSchema, {})).toBe(true);
    expect(Value.Check(SettingsDocumentSchema, { subagents: { maxConcurrentRuns: 4, maxDepth: 8 } })).toBe(true);
    expect(Value.Check(SettingsDocumentSchema, {
      subagents: { maxConcurrentRuns: Number.MAX_SAFE_INTEGER + 1 },
    })).toBe(false);
  });

  test("decoded DTOs remain plain strings/numbers until constructors brand them", () => {
    const decoded = decodePersistedAgentEvent({
      schemaVersion: 1,
      eventType: "run_started",
      payload: { agentId: "a1b2c3d4", runId: "deadbeef", attemptId: "attempt-1" },
    });
    expect(typeof decoded.payload).toBe("object");
    if (decoded.eventType === "run_started") {
      expect(typeof decoded.payload.agentId).toBe("string");
      expect(typeof decoded.payload.runId).toBe("string");
      const branded = agentId(decoded.payload.agentId);
      expect(branded as string).toBe("a1b2c3d4");
    }
  });
});

describe("decodePersistedAgentEvent", () => {
  test("accepts every event/payload pairing", () => {
    expect(() =>
      decodePersistedAgentEvent({
        schemaVersion: 1,
        eventType: "spawned",
        payload: {
          agentId: "a1b2c3d4",
          sessionPath: "/tmp/a.jsonl",
          cwd: "/tmp",
          provider: "anthropic",
          modelId: "claude",
          thinkingLevel: "medium",
          tools: [],
        },
      }),
    ).not.toThrow();
  });

  test("rejects an unknown schema version", () => {
    expect(() =>
      decodePersistedAgentEvent({
        schemaVersion: 2,
        eventType: "spawned",
        payload: {},
      }),
    ).toThrow(/invalid_input/);
  });

  test("rejects mismatched event/payload pairs", () => {
    expect(() =>
      decodePersistedAgentEvent({
        schemaVersion: 1,
        eventType: "spawned",
        payload: { agentId: "a1b2c3d4", runId: "deadbeef", attemptId: "attempt-1" },
      }),
    ).toThrow(/invalid_input/);
  });

  test("rejects non-object values", () => {
    expect(() => decodePersistedAgentEvent("not an object")).toThrow();
    expect(() => decodePersistedAgentEvent(null)).toThrow();
    expect(() => decodePersistedAgentEvent(undefined)).toThrow();
  });
});
