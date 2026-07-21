import { AgentState, type AgentId } from "../../src/domain.ts";
import { RunController, type RunControllerOptions, type RunRecord } from "../../src/run-controller.ts";
import { testAgentId, testSessionPath } from "./brands.ts";

export function testRunController(options: Partial<RunControllerOptions> = {}): RunController {
  return new RunController({ capacity: 2, ...options });
}

export async function restoreRuns(controller: RunController, records: Iterable<RunRecord>): Promise<void> {
  const admission = await controller.beginRestore();
  try {
    admission.reserve(records);
    admission.commit();
  } finally {
    admission.release();
  }
}

export function registerStopped(controller: RunController, suffix: string | number = "a"): AgentId {
  const id = testAgentId(`agent-${suffix}`);
  controller.register({ agentId: id, state: AgentState.Stopped, transcriptPath: testSessionPath() });
  return id;
}
