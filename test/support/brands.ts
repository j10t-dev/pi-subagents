import {
  agentId, milliseconds, modelSpec, runAttemptId, runId, sessionEntryId,
  verifiedContainmentReceiptPath,
  type AbsolutePath, type AgentId, type CommittedOutputPath,
  type ContainmentReceiptPath, type ModelSpec, type Milliseconds,
  type OutputPath, type RunAttemptId, type RunId, type SessionEntryId,
  type SessionPath, type VerifiedContainmentReceiptPath,
} from "../../src/domain.ts";
import {
  absolutePath, containmentReceiptPath, outputPath, sessionPath,
} from "../../src/paths.ts";

/** Fixed root every test path brand is validated against; escaping it throws `invalid_input`. */
const TEST_ROOT = "/tmp/pi-subagents-test";

export const testAgentId = (value = "agent-a"): AgentId => agentId(value);
export const testEntryId = (value = "aaaaaaaa"): SessionEntryId => sessionEntryId(value);
export const testRunId = (value = "deadbeef"): RunId => runId(value);
export const testAttemptId = (value = "attempt-1"): RunAttemptId => runAttemptId(value);
export const testModelSpec = (value = "mock-provider/mock-model"): ModelSpec => modelSpec(value);
export const testMilliseconds = (value: number): Milliseconds => milliseconds(value);
export const testAbsolutePath = (value: string): AbsolutePath => absolutePath(value);
/** Each supplied path is validated against {@link TEST_ROOT}; paths outside it are rejected. */
export const testSessionPath = (value = `${TEST_ROOT}/sessions/agent-a.jsonl`): SessionPath => sessionPath(TEST_ROOT, value);
export const testOutputPath = (value = `${TEST_ROOT}/output/deadbeef.committed`): OutputPath => outputPath(TEST_ROOT, value);
/** `root` accepts a dynamically created temp root; it defaults to {@link TEST_ROOT}. */
export const testCommittedOutputPath = (value = `${TEST_ROOT}/output/deadbeef.committed`, root = TEST_ROOT): CommittedOutputPath =>
  // `outputPath()` proves lexical containment; production intentionally exposes no committed-path constructor.
  outputPath(root, value) as CommittedOutputPath;
export const testReceiptPath = (value = `${TEST_ROOT}/receipts/attempt-1.json`): ContainmentReceiptPath =>
  containmentReceiptPath(TEST_ROOT, value);
export const testVerifiedReceiptPath = (value = `${TEST_ROOT}/receipts/attempt-1.json`): VerifiedContainmentReceiptPath =>
  verifiedContainmentReceiptPath(testReceiptPath(value));
