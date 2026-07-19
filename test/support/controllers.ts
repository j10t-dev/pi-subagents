import { AgentState, type AgentId } from "../../src/domain.ts";
import { RunController, type RunControllerOptions } from "../../src/run-controller.ts";
import { testAgentId, testSessionPath } from "./brands.ts";

export function testRunController(options: Partial<RunControllerOptions> = {}): RunController {
  return new RunController({ capacity: 2, ...options });
}

export function registerStopped(controller: RunController, suffix: string | number = "a"): AgentId {
  const id = testAgentId(`agent-${suffix}`);
  controller.register({ agentId: id, state: AgentState.Stopped, transcriptPath: testSessionPath() });
  return id;
}
