import { describe, expect, test } from "bun:test";
import { Value } from "typebox/value";

import {
  AgentErrorCode,
  AgentEventType,
  AgentState,
  CancellationReason,
  CompletionState,
  agentId,
  assertTransition,
  createRunAttemptId,
  isLegalTransition,
  milliseconds,
  modelSpec,
  runAttemptId,
  runId,
  runIdFromEntry,
  sessionEntryId,
  toAgentError,
  truncateUtf8,
  retainUtf8Tail,
  utf8Bytes,
} from "../src/domain.ts";
import { diagnosticsPath } from "../src/paths.ts";
import {
  AgentCompletionSchema,
  AgentErrorSchema,
  AgentUsageSchema,
  CompletionOutputSchema,
  PersistedAgentEventSchema,
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

describe("modelSpec", () => {
  test("accepts a non-empty spec", () => {
    expect(modelSpec("anthropic/claude:high") as string).toBe("anthropic/claude:high");
  });

  test("rejects an empty or blank spec", () => {
    expect(() => modelSpec("")).toThrow(/invalid_input/);
    expect(() => modelSpec("   ")).toThrow(/invalid_input/);
  });
});

describe("milliseconds / utf8Bytes", () => {
  test("accepts non-negative integers", () => {
    expect(milliseconds(0) as number).toBe(0);
    expect(milliseconds(1000) as number).toBe(1000);
    expect(utf8Bytes(0) as number).toBe(0);
  });

  test("rejects negative or fractional values", () => {
    expect(() => milliseconds(-1)).toThrow(/invalid_input/);
    expect(() => milliseconds(1.5)).toThrow(/invalid_input/);
    expect(() => utf8Bytes(-1)).toThrow(/invalid_input/);
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
    const tail = retainUtf8Tail(`old${"£".repeat(30_000)}END`, 50_000);
    expect(Buffer.byteLength(tail)).toBeLessThanOrEqual(50_000);
    expect(tail.endsWith("END")).toBeTrue();
    expect(tail).not.toContain("�");
  });
  test("returns the original text untruncated when within budget", () => {
    expect(truncateUtf8("hello", 10) as unknown).toEqual({
      text: "hello",
      originalBytes: 5,
      retainedBytes: 5,
      truncated: false,
    });
  });

  test("truncates to a valid UTF-8 prefix, never splitting a multi-byte character", () => {
    expect(truncateUtf8("£££", 5) as unknown).toEqual({
      text: "££",
      originalBytes: 6,
      retainedBytes: 4,
      truncated: true,
    });
  });

  test("handles a zero byte budget", () => {
    expect(truncateUtf8("abc", 0) as unknown).toEqual({
      text: "",
      originalBytes: 3,
      retainedBytes: 0,
      truncated: true,
    });
  });

  test("handles ASCII truncation at an exact boundary", () => {
    expect(truncateUtf8("abcdef", 3) as unknown).toEqual({
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
      const err = toAgentError(new Error("secret transport dump"), code);
      expect(err.code).toBe(code);
      expect(err.message.length).toBeLessThanOrEqual(10_000);
      expect(err.message).not.toContain("secret transport dump");
    }
  });

  test("never leaks raw exception content regardless of error shape", () => {
    expect(
      toAgentError(new Error("secret transport dump"), AgentErrorCode.ProtocolError).message,
    ).not.toContain("secret transport dump");
    expect(toAgentError("raw string throw", AgentErrorCode.SpawnFailed).message).not.toContain(
      "raw string throw",
    );
    expect(toAgentError(undefined, AgentErrorCode.InvalidState).message).toBeTruthy();
  });

  test("attaches an optional diagnostics path without altering the message", () => {
    const withPath = toAgentError(
      new Error("x"),
      AgentErrorCode.ProtocolError,
      diagnosticsPath("/tmp", "diag.log"),
    );
    expect(String(withPath.diagnosticsPath)).toBe("/tmp/diag.log");
    const withoutPath = toAgentError(new Error("x"), AgentErrorCode.ProtocolError);
    expect(withoutPath.diagnosticsPath).toBeUndefined();
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

  test("SubagentSettingsSchema and SettingsDocumentSchema reject non-positive limits", () => {
    expect(Value.Check(SubagentSettingsSchema, { maxConcurrentRuns: 4 })).toBe(true);
    expect(Value.Check(SubagentSettingsSchema, { maxConcurrentRuns: 0 })).toBe(false);
    expect(Value.Check(SubagentSettingsSchema, { maxConcurrentRuns: 1.5 })).toBe(false);
    expect(Value.Check(SettingsDocumentSchema, {})).toBe(true);
    expect(Value.Check(SettingsDocumentSchema, { subagents: { maxConcurrentRuns: 4 } })).toBe(
      true,
    );
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
