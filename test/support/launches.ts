import type { LaunchSession, LaunchTransport } from "../../src/controller.ts";
import type { RunRuntime } from "../../src/run-controller.ts";
import type { VerifiedContainmentReceiptPath } from "../../src/domain.ts";
import { testAbsolutePath, testAgentId, testAttemptId, testReceiptPath, testRunId, testSessionPath, testVerifiedReceiptPath } from "./brands.ts";

export function launchSession(suffix = "a", overrides: Partial<LaunchSession> = {}): LaunchSession {
  return {
    agentId: testAgentId(`agent-${suffix}`),
    transcriptPath: testSessionPath(`/tmp/pi-subagents-test/sessions/agent-${suffix}.jsonl`),
    previousLeafId: null,
    attemptId: testAttemptId(`attempt-${suffix}`),
    containmentReceiptPath: testReceiptPath(`/tmp/pi-subagents-test/receipts/attempt-${suffix}.json`),
    ...overrides,
  };
}

export function testRuntime(options: {
  trace?: string[];
  abort?: () => Promise<void>;
  contain?: () => Promise<VerifiedContainmentReceiptPath>;
} = {}): RunRuntime {
  const trace = options.trace;
  return {
    abort: options.abort ?? (async () => { trace?.push("abort"); }),
    contain: options.contain ?? (async () => {
      trace?.push("contain");
      return testVerifiedReceiptPath();
    }),
  };
}

export function runningTransport(session: LaunchSession, overrides: Partial<LaunchTransport> = {}): LaunchTransport {
  const nativeRunId = testRunId();
  let assignment: string | undefined;
  return {
    containment: { backend: "cgroup-v2", scopePath: testAbsolutePath(`/tmp/cgroup/${session.attemptId}`) },
    runtime: testRuntime(),
    ready: async () => {}, persistLaunchRequested: async () => {},
    persistRunStarted: async () => {}, start: async () => {},
    getEntries: async () => assignment === undefined
      ? { entries: [], leafId: session.previousLeafId }
      : {
          entries: [{
            type: "message", id: nativeRunId, parentId: session.previousLeafId,
            timestamp: "2026-01-01T00:00:00.000Z",
            message: { role: "user", content: assignment, timestamp: 1 },
          }],
          leafId: nativeRunId,
        },
    prompt: async (message) => { assignment = message; },
    waitForAgentStart: async () => {}, bindRun: () => {},
    waitSettled: async () => ({ reason: "agent_settled", stopReason: "stop" }),
    recordFailure: () => {},
    ...overrides,
  };
}
