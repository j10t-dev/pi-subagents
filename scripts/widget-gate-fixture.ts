import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import createAgentWidgetExtension from "../agent-widget.ts";
import {
  contextLabel,
  deriveModelLabel,
  type SubagentObservationPort,
} from "../src/agent-observation.ts";
import {
  AgentState,
  agentCount,
  agentDepth,
  agentId,
  agentObservationRevision,
  agentOrdinal,
  directAgentOrdinal,
  modelSpec,
  type AgentRow,
} from "../src/domain.ts";
import { publishObservationPort } from "../src/observation-registry.ts";

const fixtureModel = deriveModelLabel(modelSpec("fixture/fixture"), "off");
const unavailableContext = contextLabel({ kind: "unavailable" });

const rows: readonly AgentRow[] = [
  {
    ordinal: agentOrdinal("A1"),
    depth: agentDepth(0),
    model: fixtureModel,
    context: unavailableContext,
    taskLabel: "Observe first fixture agent",
    state: AgentState.Running,
  },
  {
    ordinal: agentOrdinal("A2"),
    depth: agentDepth(0),
    model: fixtureModel,
    context: unavailableContext,
    taskLabel: "Observe second fixture agent",
    state: AgentState.Running,
  },
];

const port: SubagentObservationPort = {
  observation: () => undefined,
  directSnapshot: () => ({
    kind: "snapshot",
    revision: agentObservationRevision(1),
    health: { kind: "healthy" },
    total: agentCount(rows.length),
    omitted: agentCount(0),
    omittedActive: agentCount(0),
    entries: rows.map((row, index) => ({
      agentId: agentId(`fixture-agent-${index + 1}`),
      observation: {
        agentId: agentId(`fixture-agent-${index + 1}`),
        ordinal: directAgentOrdinal(index + 1),
        taskLabel: row.taskLabel,
        modelLabel: row.model,
        context: { kind: "unavailable" },
        lifecycleState: AgentState.Running,
        displayState: AgentState.Running,
        activity: { kind: "idle" },
        completionPendingDelivery: false,
        revision: agentObservationRevision(1),
      },
      row,
    })),
  }),
  transcriptSource: () => undefined,
  subscribe: () => () => {},
};

export default function installFixture(pi: ExtensionAPI): void {
  // --no-extensions means this fixture is the only extension loaded, so it owns
  // `pi-subagents-agents` alone and no controller exists to publish a competing port.
  createAgentWidgetExtension(pi);
  let publication: ReturnType<typeof publishObservationPort> | undefined;
  pi.on("session_start", () => {
    publication?.clear();
    publication = publishObservationPort(port);
  });
  pi.on("session_shutdown", () => {
    publication?.clear();
    publication = undefined;
  });
}
