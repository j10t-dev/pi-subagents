import {
  agentId, delegationDepth, milliseconds, modelId, modelSpec, observationRevision, processCount,
  processGroupId, processId, providerId, rpcRequestId, runAttemptId, runCapacity, runId,
  observedCgroupScopePath, sessionEntryId, toolName, uiRequestId,
  utf16CodeUnitOffset, utf8Bytes, verifiedContainmentReceiptPath,
  type AbsolutePath, type AgentId, type CommittedOutputPath,
  type ContainmentReceiptPath, type ModelId, type ModelSpec, type Milliseconds,
  type DelegationDepth, type ObservationRevision, type OutputPath, type ProcessCount,
  type ProcessGroupId, type ProcessId, type ProviderId, type RpcRequestId, type RunAttemptId,
  type RunCapacity, type RunId, type SessionEntryId,
  type ObservedCgroupScopePath, type SessionPath, type ToolName, type UIRequestId,
  type Utf16CodeUnitOffset, type Utf8Bytes,
  type VerifiedContainmentReceiptPath,
} from "../../src/domain.ts";
import {
  resolveCgroupV2Backend,
  type CgroupFileSystem,
} from "../../src/cgroup-v2.ts";
import type { ContainmentAttempt, ContainmentDescriptor } from "../../src/containment.ts";
import { OutputStore } from "../../src/output-store.ts";
import {
  absolutePath, containmentReceiptPath, outputPath, sessionPath,
} from "../../src/paths.ts";

/** Fixed root every test path brand is validated against; escaping it throws `invalid_input`. */
const TEST_ROOT = "/tmp/pi-subagents-test";

export const testAgentId = (value = "agent-a"): AgentId => agentId(value);
export const testEntryId = (value = "aaaaaaaa"): SessionEntryId => sessionEntryId(value);
export const testRpcRequestId = (value = "rpc-1"): RpcRequestId => rpcRequestId(value);
export const testUIRequestId = (value = "ui-1"): UIRequestId => uiRequestId(value);
export const testRunId = (value = "deadbeef"): RunId => runId(value);
export const testAttemptId = (value = "attempt-1"): RunAttemptId => runAttemptId(value);
export const testProviderId = (value = "mock-provider"): ProviderId => providerId(value);
export const testModelId = (value = "mock-model"): ModelId => modelId(value);
export const testToolName = (value = "read"): ToolName => toolName(value);
export const testModelSpec = (value = "mock-provider/mock-model"): ModelSpec => modelSpec(value);
export const testMilliseconds = (value: number): Milliseconds => milliseconds(value);
export const testUtf8Bytes = (value: number): Utf8Bytes => utf8Bytes(value);
export const testUtf16Offset = (value: number): Utf16CodeUnitOffset => utf16CodeUnitOffset(value);
export const testDelegationDepth = (value: number): DelegationDepth => delegationDepth(value);
export const testRunCapacity = (value: number): RunCapacity => runCapacity(value);
export const testProcessCount = (value: number): ProcessCount => processCount(value);
export const testProcessId = (value: number): ProcessId => processId(value);
export const testProcessGroupId = (value: number): ProcessGroupId => processGroupId(value);
export const testObservationRevision = (value: number): ObservationRevision => observationRevision(value);
export const testAbsolutePath = (value: string): AbsolutePath => absolutePath(value);
export const testObservedCgroupScopePath = (value: string): ObservedCgroupScopePath =>
  observedCgroupScopePath(absolutePath(value));

/**
 * Runs the production cgroup proof operation against a deterministic canonical filesystem.
 * This does not cast or construct the proof brand in test code.
 */
export function testContainmentAttempt(
  attemptId = testAttemptId(),
  root = testAbsolutePath(`${TEST_ROOT}/cgroup`),
  parentSessionId = "test-parent",
): ContainmentAttempt & { readonly descriptor: ContainmentDescriptor } {
  const directories = new Set<string>([root]);
  const fs: CgroupFileSystem = {
    readFile: () => "",
    writeFile: () => {},
    mkdir: (path) => { directories.add(path); },
    realpath: (path) => {
      if (!directories.has(path)) throw missingPath();
      return path;
    },
    stat: (path) => {
      if (!directories.has(path)) throw missingPath();
      return { isDirectory: () => true, mode: 0o700 };
    },
    removeDirectory: (path) => { directories.delete(path); },
    list: () => [],
  };
  const attempt = resolveCgroupV2Backend({
    parentSessionId: agentId(parentSessionId),
    mountPath: root,
    configuredRoot: root,
    fs,
    receiptPathFor: (id) => testReceiptPath(`${TEST_ROOT}/receipts/${id}.json`),
  }).prepareAttempt(attemptId);
  directories.add(attempt.candidate.scopePath);
  const descriptor = attempt.proveRuntimeDescriptor({
    ...attempt.candidate,
    scopePath: observedCgroupScopePath(attempt.candidate.scopePath),
  });
  return Object.assign(attempt, { descriptor });
}

/** Each supplied path is validated against {@link TEST_ROOT}; paths outside it are rejected. */
export const testSessionPath = (value = `${TEST_ROOT}/sessions/agent-a.jsonl`): SessionPath => sessionPath(TEST_ROOT, value);
export const testOutputPath = (value = `${TEST_ROOT}/output/deadbeef.committed`): OutputPath => outputPath(TEST_ROOT, value);
export function testCommittedOutputPath(options: {
  readonly runId?: RunId;
  readonly workDir?: AbsolutePath;
} = {}): CommittedOutputPath {
  const run = options.runId ?? testRunId();
  const workDir = options.workDir ?? testAbsolutePath(`${TEST_ROOT}/output/agent-a`);
  const attempt = testAttemptId(`fixture-${run}`);
  const store = new OutputStore({ workDir });
  store.beginAttempt(attempt);
  return store.bindRun(attempt, run);
}
export const testReceiptPath = (value = `${TEST_ROOT}/receipts/attempt-1.json`): ContainmentReceiptPath =>
  containmentReceiptPath(TEST_ROOT, value);
export const testVerifiedReceiptPath = (value = `${TEST_ROOT}/receipts/attempt-1.json`): VerifiedContainmentReceiptPath =>
  verifiedContainmentReceiptPath(testReceiptPath(value));

function missingPath(): Error & { readonly code: "ENOENT" } {
  return Object.assign(new Error("ENOENT"), { code: "ENOENT" as const });
}
