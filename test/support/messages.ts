import { AgentState, AgentErrorCode, CancellationReason, CompletionState, truncateUtf8, type AgentCompletion, type Usage } from "../../src/domain.ts";
import type { AgentSummary } from "../../src/completion-service.ts";
import type { WireAssistantMessage } from "../../src/schemas.ts";
import { testAgentId, testCommittedOutputPath, testRunId, testSessionPath } from "./brands.ts";

export const testUsage = (overrides: Partial<Usage> = {}): Usage => ({
  input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  ...overrides,
});

export const assistantMessage = (text = "done", overrides: Partial<WireAssistantMessage> = {}): WireAssistantMessage => ({
  role: "assistant",
  content: text === "" ? [] : [{ type: "text", text }],
  usage: testUsage(),
  stopReason: "stop",
  ...overrides,
});

export const completedCompletion = (
  overrides: Partial<Extract<AgentCompletion, { state: "completed" }>> = {},
): Extract<AgentCompletion, { state: "completed" }> => ({
  agentId: testAgentId(), runId: testRunId(), state: CompletionState.Completed,
  output: truncateUtf8("done", 50_000),
  outputPath: testCommittedOutputPath(), transcriptPath: testSessionPath(),
  ...overrides,
});

export const failedCompletion = (
  overrides: Partial<Extract<AgentCompletion, { state: "failed" }>> = {},
): Extract<AgentCompletion, { state: "failed" }> => ({
  ...completedCompletion(), state: CompletionState.Failed,
  error: { code: AgentErrorCode.ProcessExited, message: "child process exited unexpectedly" },
  ...overrides,
});

export const cancelledCompletion = (
  overrides: Partial<Extract<AgentCompletion, { state: "cancelled" }>> = {},
): Extract<AgentCompletion, { state: "cancelled" }> => ({
  ...completedCompletion(), state: CompletionState.Cancelled,
  reason: CancellationReason.StopRequested,
  ...overrides,
});

export const agentSummary = (overrides: Partial<AgentSummary> = {}): AgentSummary => ({
  agentId: testAgentId(), state: AgentState.Running, transcriptPath: testSessionPath(), currentRunId: testRunId(),
  ...overrides,
});

