import { describe, expect, test } from "bun:test";

import extension, { buildProductionControllerOptions, createPiSubagentsExtension, registrationForLaunchContext, type ExtensionController } from "../index.ts";
import { parseExtensionLaunchContext } from "../src/delegation-policy.ts";
import { acquireStatusLease } from "../src/ambient-status-lease.ts";
import { withProductionContainmentPreflight } from "../src/pi-composition.ts";
import type { ContainmentBackend } from "../src/containment.ts";
import { AgentState, agentId, agentObservationRevision, delegationDepth, directAgentOrdinal, modelSpec, runId, runCapacity, type AbsolutePath } from "../src/domain.ts";
import type { SubagentObservationPort } from "../src/agent-observation.ts";
import { AgentObservationStore } from "../src/agent-observation-store.ts";
import { SubagentController } from "../src/controller.ts";
import { onObservationPort } from "../src/observation-registry.ts";
import { absolutePath } from "../src/paths.ts";
import { createObservationDisplayResolver } from "../src/tool-presentation.ts";
import { awaitAgentSchema, createSubagentTools, sendInputSchema, spawnAgentSchema, stopAgentSchema } from "../src/tools.ts";
import { deferred } from "./support/async.ts";
import { extensionApiForTest, lifecycleOn, type ExtensionApiPort, type LifecycleHandler } from "./support/extension-api.ts";
import { testAbsolutePath, testSessionPath } from "./support/brands.ts";

interface HarnessContext {
  statuses: Array<string | undefined>;
  ui: {
    setStatus(key: string, value: string | undefined): void;
    notify(message: string, type: "warning"): void;
  };
}
type Handler = LifecycleHandler<HarnessContext>;

function registerTestTool(tools: Array<Record<string, unknown>>): ExtensionApiPort["registerTool"] {
  return ((tool: object) => tools.push(tool as Record<string, unknown>)) as ExtensionApiPort["registerTool"];
}

function harness() {
  const tools: Array<Record<string, unknown>> = [];
  const handlers = new Map<string, Handler[]>();
  return {
    api: {
      registerTool: registerTestTool(tools),
      on: lifecycleOn(handlers),
      appendEntry: () => {},
      sendMessage: () => {},
      getThinkingLevel: () => "high",
      getActiveTools: () => [],
    } satisfies ExtensionApiPort,
    tools,
    handlers,
    emit: async (name: string, event: object, ctx = context()) => {
      for (const handler of handlers.get(name) ?? []) await handler(event, ctx);
      return ctx;
    },
  };
}

function context(): HarnessContext {
  const statuses: Array<string | undefined> = [];
  return {
    statuses,
    ui: {
      setStatus: (_key: string, value: string | undefined) => statuses.push(value),
      notify: () => {},
    },
  };
}

function controller(log: string[], observation?: SubagentObservationPort): ExtensionController {
  return {
    restore: async () => { log.push("restore"); },
    shutdown: async () => { log.push("shutdown"); },
    status: () => "0 running · 0 ready",
    ...(observation === undefined ? {} : { observationPort: () => observation }),
    tools: () => ({
      spawn_agent: { name: "spawn_agent", description: "spawn_agent", parameters: spawnAgentSchema, execute: async () => ({ content: "spawn_agent", details: { name: "spawn_agent" } }), renderResult: () => "spawn_agent" },
      send_input: { name: "send_input", description: "send_input", parameters: sendInputSchema, execute: async () => ({ content: "send_input", details: { name: "send_input" } }), renderResult: () => "send_input" },
      await_agent: { name: "await_agent", description: "await_agent", parameters: awaitAgentSchema, execute: async () => ({ content: "await_agent", details: { name: "await_agent" } }), renderResult: () => "await_agent" },
      stop_agent: { name: "stop_agent", description: "stop_agent", parameters: stopAgentSchema, execute: async () => ({ content: "stop_agent", details: { name: "stop_agent" } }), renderResult: () => "stop_agent" },
    }),
  };
}

// The extension factory returns its detached widget startup. These tests supply no widget seam, and
// `installWidget` already contains and reports startup failure, so every call site marks it `void`.
describe("Pi subagents extension", () => {
  test("publishes only the restored controller port and clears it before shutdown", async () => {
    const h = harness();
    const log: string[] = [];
    const port: SubagentObservationPort = {
      observation: () => undefined,
      directSnapshot: () => ({ kind: "unavailable", finalRevision: agentObservationRevision(0) }),
      transcriptSource: () => undefined,
      subscribe: () => () => {},
    };
    const seen: Array<SubagentObservationPort | undefined> = [];
    const unsubscribe = onObservationPort((value) => seen.push(value));
    void createPiSubagentsExtension({ platform: "linux", registration: { enabled: true },
      createController: () => controller(log, port), diagnostic: () => {} })(extensionApiForTest(h.api));
    await h.emit("session_start", { type: "session_start", reason: "startup" });
    expect(seen.at(-1)).toBe(port);
    await h.emit("session_shutdown", { type: "session_shutdown", reason: "quit" });
    expect(seen.at(-1)).toBeUndefined();
    expect(log).toEqual(["restore", "shutdown"]);
    unsubscribe();
  });

  test("supported parent registers four rendered tools and the lifecycle handlers without starting resources", () => {
    const h = harness();
    const log: string[] = [];
    void createPiSubagentsExtension({
      platform: "linux",
      nodeVersion: "22.19.0",
      registration: { enabled: true },
      createController: () => controller(log),
      diagnostic: (message) => log.push(message),
    })(extensionApiForTest(h.api));

    expect(log).toEqual([]);
    expect(h.tools.map((tool) => tool.name)).toEqual(["spawn_agent", "send_input", "await_agent", "stop_agent"]);
    expect(h.tools.every((tool) => typeof tool.renderCall === "function" && typeof tool.renderResult === "function")).toBe(true);
    expect(h.tools[0]?.parameters).toBe(spawnAgentSchema);
    expect(h.tools[1]?.parameters).toBe(sendInputSchema);
    expect(h.tools[2]?.parameters).toBe(awaitAgentSchema);
    expect(h.tools[3]?.parameters).toBe(stopAgentSchema);
    expect([...h.handlers.keys()]).toEqual([
      "session_start", "session_before_tree", "session_tree", "session_before_switch", "session_before_fork", "session_shutdown",
    ]);
  });

  test("renders historical tool results without exposing raw details", async () => {
    const h = harness();
    const log: string[] = [];
    void createPiSubagentsExtension({
      platform: "linux", registration: { enabled: true },
      createController: () => controller(log), diagnostic: () => {},
    })(extensionApiForTest(h.api));
    const tool = h.tools[0] as { renderResult(result: { details?: object }): { text: string } };
    const result = { details: { agentId: "agent-secret", outputPath: "/tmp/secret" } };

    expect(tool.renderResult(result).text).toBe("Agent · unavailable");
    await h.emit("session_start", { type: "session_start", reason: "startup" });
    await h.emit("session_shutdown", { type: "session_shutdown", reason: "quit" });
    expect(tool.renderResult(result).text).toBe("Agent · unavailable");
  });

  test.each([
    ["spawn_agent", { agentId: agentId("agent-a"), runId: runId("deadbeef"), state: "running" }],
    ["send_input", { agentId: agentId("agent-a"), runId: runId("deadbeef"), state: "running" }],
    ["await_agent", {
      completions: [], remainingCompletions: 0,
      inventory: { total: 1, omitted: 0, remaining: 0, agents: [{ agentId: agentId("agent-a"), runId: runId("deadbeef"), state: "running" }] },
      timedOut: false,
    }],
    ["stop_agent", { outcomes: [{ agentId: agentId("agent-a"), runId: runId("deadbeef"), state: "cancelled" }] }],
  ] as const)("registered %s uses the observation-backed lifecycle renderer", async (name, details) => {
    const h = harness();
    const store = observedRunningStore();
    void createPiSubagentsExtension({ platform: "linux", registration: { enabled: true },
      createController: () => ({ ...controller([], store), tools: () => createSubagentTools(
        new SubagentController(), createObservationDisplayResolver(store),
      ) }), diagnostic: () => {} })(extensionApiForTest(h.api));
    await h.emit("session_start", { type: "session_start", reason: "startup" });
    const definition = h.tools.find((entry) => entry.name === name) as {
      renderResult(result: { details: object }, options: { expanded: boolean }): { text: string };
    };

    const rendered = definition.renderResult({ details }, { expanded: false }).text;

    expect(rendered).toContain("A1 · luna:h · task · running");
    expect(rendered).not.toContain("agent-a");
  });

  test("registered await_agent forwards expanded to diagnostic rendering", async () => {
    const h = harness();
    const log: string[] = [];
    const store = new AgentObservationStore();
    const id = agentId("agent-a");
    const nativeRunId = runId("deadbeef");
    store.registerSpawned({ agentId: id, ordinal: directAgentOrdinal(1), assignment: "task",
      sessionPath: testSessionPath("/tmp/pi-subagents-test/agent-a.jsonl"), cwd: testAbsolutePath("/tmp/pi-subagents-test"),
      model: modelSpec("mock-provider/luna"), thinkingLevel: "high" });
    store.updateLifecycle({ agentId: id, runId: nativeRunId, state: AgentState.Running,
      transcriptPath: testSessionPath("/tmp/pi-subagents-test/agent-a.jsonl") });
    void createPiSubagentsExtension({ platform: "linux", registration: { enabled: true },
      createController: () => ({ ...controller(log, store), tools: () => createSubagentTools(
        new SubagentController(), createObservationDisplayResolver(store),
      ) }), diagnostic: () => {} })(extensionApiForTest(h.api));
    await h.emit("session_start", { type: "session_start", reason: "startup" });
    const details = {
      completions: [], remainingCompletions: 0,
      inventory: { total: 1, omitted: 0, remaining: 0,
        agents: [{ agentId: id, runId: nativeRunId, state: "running", transcriptPath: "/tmp/pi-subagents-test/agent-a.jsonl" }] },
      timedOut: false,
    };
    const definition = h.tools.find((entry) => entry.name === "await_agent") as {
      renderResult(result: { details: object }, options: { expanded: boolean }): { text: string };
    };

    const collapsed = definition.renderResult({ details }, { expanded: false }).text;
    const expanded = definition.renderResult({ details }, { expanded: true }).text;

    expect(collapsed).toContain("A1 · luna:h · task · running");
    expect(collapsed).not.toContain(String(id));
    expect(collapsed).not.toContain("/tmp/pi-subagents-test/agent-a.jsonl");
    expect(expanded).toContain(`agentId=${id}`);
    expect(expanded).toContain("/tmp/pi-subagents-test/agent-a.jsonl");
  });

  test("a tool execution outliving its session returns its result instead of throwing session_unavailable", async () => {
    const h = harness();
    const log: string[] = [];
    const gate = deferred<void>();
    const base = controller(log);
    const slow: ExtensionController = {
      ...base,
      tools: () => {
        const registry = base.tools();
        return {
          ...registry,
          await_agent: {
            ...registry.await_agent,
            execute: async () => {
              await gate.promise;
              return { content: "await_agent", details: { name: "await_agent" } };
            },
          },
        };
      },
    };
    void createPiSubagentsExtension({
      platform: "linux", nodeVersion: "22.19.0", registration: { enabled: true },
      createController: () => slow, diagnostic: () => {},
    })(extensionApiForTest(h.api));
    await h.emit("session_start", { type: "session_start", reason: "startup" });
    const tool = h.tools.find((entry) => entry.name === "await_agent") as {
      execute(id: string, input: object, signal?: AbortSignal): Promise<{ details: object }>;
    };

    // The execution spans the shutdown that clears the active controller.
    const pending = tool.execute("call-1", {}, undefined);
    await h.emit("session_shutdown", { type: "session_shutdown", reason: "quit" });
    gate.resolve();

    expect(await pending).toMatchObject({ details: { name: "await_agent" } });
  });

  test("spawn registration gives one non-duplicated asynchronous delegation guideline", () => {
    const h = harness();
    void createPiSubagentsExtension({
      platform: "linux",
      registration: { enabled: true },
      createController: () => controller([]),
      diagnostic: () => {},
    })(extensionApiForTest(h.api));
    const spawn = h.tools.find((tool) => tool.name === "spawn_agent");

    expect(spawn?.description).toBe(
      "Start a persistent child assignment asynchronously; collect completion with await_agent.",
    );
    expect(spawn?.promptSnippet).toBe("Delegate a fresh persistent assignment with spawn_agent");
    expect(spawn?.promptGuidelines).toEqual([
      "When delegation is requested, call spawn_agent directly, then use await_agent to collect completion.",
    ]);
    for (const tool of h.tools.filter((candidate) => candidate.name !== "spawn_agent")) {
      expect(tool.promptGuidelines).toBeUndefined();
    }
  });

  const invalidContexts = [
    ["invalid marker", { PI_SUBAGENT_CHILD: "2" }],
    ["stray numeric values", { PI_SUBAGENT_DEPTH: "1" }],
    ["partial values", { PI_SUBAGENT_CHILD: "1", PI_SUBAGENT_DEPTH: "1" }],
    ["marked depth zero", { PI_SUBAGENT_CHILD: "1", PI_SUBAGENT_DEPTH: "0", PI_SUBAGENT_MAX_DEPTH: "2", PI_SUBAGENT_MAX_CONCURRENT_RUNS: "1" }],
    ["depth above maximum", { PI_SUBAGENT_CHILD: "1", PI_SUBAGENT_DEPTH: "3", PI_SUBAGENT_MAX_DEPTH: "2", PI_SUBAGENT_MAX_CONCURRENT_RUNS: "1" }],
    ["leading zero", { PI_SUBAGENT_CHILD: "1", PI_SUBAGENT_DEPTH: "01", PI_SUBAGENT_MAX_DEPTH: "2", PI_SUBAGENT_MAX_CONCURRENT_RUNS: "1" }],
    ["negative text", { PI_SUBAGENT_CHILD: "1", PI_SUBAGENT_DEPTH: "-1", PI_SUBAGENT_MAX_DEPTH: "2", PI_SUBAGENT_MAX_CONCURRENT_RUNS: "1" }],
    ["exponent text", { PI_SUBAGENT_CHILD: "1", PI_SUBAGENT_DEPTH: "1e0", PI_SUBAGENT_MAX_DEPTH: "2", PI_SUBAGENT_MAX_CONCURRENT_RUNS: "1" }],
    ["unsafe integer", { PI_SUBAGENT_CHILD: "1", PI_SUBAGENT_DEPTH: "1", PI_SUBAGENT_MAX_DEPTH: "2", PI_SUBAGENT_MAX_CONCURRENT_RUNS: "9007199254740992" }],
    ["zero capacity", { PI_SUBAGENT_CHILD: "1", PI_SUBAGENT_DEPTH: "1", PI_SUBAGENT_MAX_DEPTH: "2", PI_SUBAGENT_MAX_CONCURRENT_RUNS: "0" }],
  ] as const;

  test.each(invalidContexts)("parses %s metadata as invalid", (_label, env) => {
    expect(parseExtensionLaunchContext(env)).toMatchObject({ kind: "invalid" });
  });

  test.each(invalidContexts)("routes %s invalid metadata through registration wiring", async (_label, env) => {
    const parsed = parseExtensionLaunchContext(env);
    expect(parsed.kind).toBe("invalid");
    const registration = registrationForLaunchContext(parsed, delegationDepth(1));
    expect(registration.enabled).toBe(false);
    if (registration.enabled) throw new Error("invalid metadata must disable registration");
    expect(typeof registration.diagnostic).toBe("string");
    const h = harness();
    const diagnostics: string[] = [];
    void createPiSubagentsExtension({
      platform: "linux", registration,
      createController: () => { throw new Error("must not construct"); },
      diagnostic: (message) => diagnostics.push(message),
    })(extensionApiForTest(h.api));
    expect(h.tools).toEqual([]);
    expect([...h.handlers.keys()]).toEqual(["session_start"]);
    const notifications: Array<[string, string]> = [];
    await h.emit("session_start", {}, {
      statuses: [], ui: { setStatus: () => {}, notify: (message, type) => notifications.push([message, type]) },
    });
    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0]).toBe(registration.diagnostic);
    expect(notifications).toEqual([[registration.diagnostic!, "warning"]]);
  });

  test("zero-depth roots, maximum-depth descendants, and legacy children register nothing", () => {
    const registrations = [
      registrationForLaunchContext(parseExtensionLaunchContext({}), delegationDepth(0)),
      registrationForLaunchContext(parseExtensionLaunchContext({
        PI_SUBAGENT_CHILD: "1", PI_SUBAGENT_DEPTH: "2", PI_SUBAGENT_MAX_DEPTH: "2", PI_SUBAGENT_MAX_CONCURRENT_RUNS: "1",
      }), delegationDepth(1)),
      registrationForLaunchContext(parseExtensionLaunchContext({ PI_SUBAGENT_CHILD: "1" }), delegationDepth(1)),
    ];
    for (const registration of registrations) {
      const h = harness();
      void createPiSubagentsExtension({ platform: "linux", registration,
        createController: () => { throw new Error("must not construct"); }, diagnostic: () => {} })(extensionApiForTest(h.api));
      expect(h.tools).toEqual([]);
      expect([...h.handlers.keys()]).toEqual(["session_start"]);
    }
  });

  test("a root at the explicit default and a descendant below its maximum register tools", () => {
    const registrations = [
      registrationForLaunchContext(parseExtensionLaunchContext({}), delegationDepth(1)),
      registrationForLaunchContext(parseExtensionLaunchContext({
        PI_SUBAGENT_CHILD: "1", PI_SUBAGENT_DEPTH: "1", PI_SUBAGENT_MAX_DEPTH: "2", PI_SUBAGENT_MAX_CONCURRENT_RUNS: "1",
      }), delegationDepth(1)),
    ];
    for (const registration of registrations) {
      const h = harness();
      void createPiSubagentsExtension({ platform: "linux", registration,
        createController: () => controller([]), diagnostic: () => {} })(extensionApiForTest(h.api));
      expect(h.tools).toHaveLength(4);
    }
  });

  test("invalid registration warns once at session start without registering tools", async () => {
    const h = harness();
    const diagnostics: string[] = [];
    void createPiSubagentsExtension({
      platform: "linux", registration: { enabled: false, diagnostic: "pi-subagents disabled: malformed managed delegation environment" },
      createController: () => { throw new Error("must not construct"); }, diagnostic: (message) => diagnostics.push(message),
    })(extensionApiForTest(h.api));
    expect(h.tools).toEqual([]);
    expect(diagnostics).toEqual(["pi-subagents disabled: malformed managed delegation environment"]);
    expect([...h.handlers.keys()]).toEqual(["session_start"]);
    const notifications: Array<[string, string]> = [];
    await h.emit("session_start", {}, {
      statuses: [], ui: { setStatus: () => {}, notify: (message, type) => notifications.push([message, type]) },
    });
    expect(notifications).toEqual([["pi-subagents disabled: malformed managed delegation environment", "warning"]]);
  });

  test("child suppression registers nothing and cannot disable other extensions", () => {
    const h = harness();
    h.tools.push({ name: "other_extension" });
    void createPiSubagentsExtension({
      platform: "linux", registration: { enabled: false },
      createController: () => { throw new Error("must not construct"); }, diagnostic: () => {},
    })(extensionApiForTest(h.api));
    expect(h.tools.map((tool) => tool.name)).toEqual(["other_extension"]);
    expect([...h.handlers.keys()]).toEqual(["session_start"]);
  });

  test("unsupported platform emits one bounded diagnostic and starts no resources", () => {
    const h = harness();
    const diagnostics: string[] = [];
    void createPiSubagentsExtension({
      platform: "darwin", nodeVersion: "22.19.0", registration: { enabled: true },
      createController: () => { throw new Error("must not construct"); },
      diagnostic: (message) => diagnostics.push(message),
    })(extensionApiForTest(h.api));
    expect(h.tools).toEqual([]);
    expect(h.handlers.size).toBe(0);
    expect(diagnostics).toEqual([
      "pi-subagents disabled: requires Linux and Node 22.19 or newer; found darwin and Node 22.19.0",
    ]);
    expect(Buffer.byteLength(diagnostics[0]!)).toBeLessThanOrEqual(500);
  });

  test("marked children still report an unsupported platform before suppressing lifecycle tools", () => {
    const h = harness();
    const diagnostics: string[] = [];
    void createPiSubagentsExtension({
      platform: "darwin", nodeVersion: "22.19.0", registration: { enabled: false },
      createController: () => { throw new Error("must not construct"); },
      diagnostic: (message) => diagnostics.push(message),
    })(extensionApiForTest(h.api));
    expect(h.tools).toEqual([]);
    expect(h.handlers.size).toBe(0);
    expect(diagnostics).toEqual([
      "pi-subagents disabled: requires Linux and Node 22.19 or newer; found darwin and Node 22.19.0",
    ]);
    expect(Buffer.byteLength(diagnostics[0]!)).toBeLessThanOrEqual(500);
  });

  test("start restores one controller, navigation and every shutdown reason clean up idempotently", async () => {
    for (const reason of ["quit", "reload", "new", "resume", "fork"]) {
      const h = harness();
      const log: string[] = [];
      void createPiSubagentsExtension({ platform: "linux", registration: { enabled: true },
        createController: () => controller(log), diagnostic: () => {} })(extensionApiForTest(h.api));
      const ctx = await h.emit("session_start", { type: "session_start", reason: "startup" });
      expect(log).toEqual(["restore"]);
      expect(ctx.statuses.at(-1)).toBe("0 running · 0 ready");
      await h.emit("session_shutdown", { type: "session_shutdown", reason });
      await h.emit("session_shutdown", { type: "session_shutdown", reason });
      expect(log).toEqual(["restore", "shutdown"]);
    }
  });

  test("stopped-only tree navigation clears, disposes, restores, and republishes serially", async () => {
    const h = harness();
    const log: string[] = [];
    const ports: SubagentObservationPort[] = [new AgentObservationStore(), new AgentObservationStore()];
    let created = 0;
    const seen: Array<SubagentObservationPort | undefined> = [];
    const unsubscribe = onObservationPort((port) => seen.push(port));
    void createPiSubagentsExtension({ platform: "linux", registration: { enabled: true },
      createController: () => {
        const index = created++;
        return {
          ...controller([], ports[index]),
          beforeTree: () => true,
          restore: async () => { log.push(`restore:${index}`); },
          shutdown: async () => { log.push(`shutdown:${index}`); },
        };
      }, diagnostic: () => {} })(extensionApiForTest(h.api));

    await h.emit("session_start", { type: "session_start", reason: "startup" });
    await h.emit("session_tree", { type: "session_tree", newLeafId: "second", oldLeafId: "first" });

    expect(log).toEqual(["restore:0", "shutdown:0", "restore:1"]);
    expect(seen.slice(-3)).toEqual([ports[0], undefined, ports[1]]);
    await h.emit("session_shutdown", { type: "session_shutdown", reason: "quit" });
    unsubscribe();
  });

  test("reload shuts down the old instance before the next instance restores", async () => {
    const h = harness();
    const log: string[] = [];
    void createPiSubagentsExtension({ platform: "linux", registration: { enabled: true },
      createController: () => controller(log), diagnostic: () => {} })(extensionApiForTest(h.api));
    await h.emit("session_start", { type: "session_start", reason: "startup" });
    await h.emit("session_shutdown", { type: "session_shutdown", reason: "reload" });
    await h.emit("session_start", { type: "session_start", reason: "reload" });
    expect(log).toEqual(["restore", "shutdown", "restore"]);
  });

  test("failed shutdown retains ownership, blocks replacement restoration, and can be retried", async () => {
    const h = harness();
    const entered = deferred<void>();
    const release = deferred<void>();
    const log: string[] = [];
    let shutdownAttempts = 0;
    void createPiSubagentsExtension({ platform: "linux", registration: { enabled: true },
      createController: () => ({ ...controller(log), shutdown: async () => {
        shutdownAttempts++;
        log.push(`shutdown-${shutdownAttempts}`);
        if (shutdownAttempts === 1) { entered.resolve(); await release.promise; throw new Error("containment failed"); }
      } }), diagnostic: () => {} })(extensionApiForTest(h.api));
    const firstContext = await h.emit("session_start", { type: "session_start", reason: "startup" });
    const replacementContext = context();
    const replacing = h.emit("session_start", { type: "session_start", reason: "reload" }, replacementContext);
    await entered.promise;
    expect(log).toEqual(["restore", "shutdown-1"]);
    const tool = h.tools[0] as { execute(id: string, input: object, signal: AbortSignal): Promise<unknown> };
    expect(await tool.execute("call", {}, new AbortController().signal)).toBeDefined();
    release.resolve();
    await expect(replacing).rejects.toThrow("containment failed");
    expect(replacementContext.statuses).toEqual([]);
    expect(firstContext.statuses.at(-1)).toBe("0 running · 0 ready");

    await h.emit("session_start", { type: "session_start", reason: "reload" }, replacementContext);
    expect(log).toEqual(["restore", "shutdown-1", "shutdown-2", "restore"]);
  });

  test("Node versions before 22.19 are rejected before registration", () => {
    const h = harness(); const diagnostics: string[] = [];
    void createPiSubagentsExtension({ platform: "linux", nodeVersion: "22.18.0", registration: { enabled: true },
      createController: () => { throw new Error("must not construct"); }, diagnostic: (message) => diagnostics.push(message) })(extensionApiForTest(h.api));
    expect(h.tools).toEqual([]);
    expect(diagnostics).toEqual([
      "pi-subagents disabled: requires Linux and Node 22.19 or newer; found linux and Node 22.18.0",
    ]);
  });

  test("natural child completion refreshes status without another lifecycle tool call", async () => {
    const h = harness();
    const log: string[] = [];
    let refreshStatus = (): void => { throw new Error("status refresh was not wired"); };
    let value = "agents: 1 running, 0 results ready";
    void createPiSubagentsExtension({ platform: "linux", registration: { enabled: true },
      createController: (_context, _api, refresh) => {
        refreshStatus = refresh;
        return { ...controller(log), status: () => value };
      }, diagnostic: () => {} })(extensionApiForTest(h.api));
    const ctx = await h.emit("session_start", { type: "session_start", reason: "startup" });
    value = "agents: 0 running, 1 result ready";

    refreshStatus();

    expect(ctx.statuses.at(-1)).toBe("agents: 0 running, 1 result ready");
  });

  test("a held lease suppresses the status key and release restores the controller's latest text", async () => {
    const h = harness();
    const log: string[] = [];
    let refreshStatus = (): void => { throw new Error("status refresh was not wired"); };
    let value = "agents: 1 running, 0 results ready";
    void createPiSubagentsExtension({ platform: "linux", registration: { enabled: true },
      createController: (_context, _api, refresh) => {
        refreshStatus = refresh;
        return { ...controller(log), status: () => value };
      }, diagnostic: () => {} })(extensionApiForTest(h.api));
    const ctx = await h.emit("session_start", { type: "session_start", reason: "startup" });
    expect(ctx.statuses.at(-1)).toBe("agents: 1 running, 0 results ready");

    const lease = acquireStatusLease();
    expect(ctx.statuses.at(-1)).toBe(undefined);
    value = "agents: 0 running, 1 result ready";
    refreshStatus();
    expect(ctx.statuses.at(-1)).toBe(undefined);   // core kept publishing; the presenter suppressed it

    lease.release();
    expect(ctx.statuses.at(-1)).toBe("agents: 0 running, 1 result ready");

    await h.emit("session_shutdown", { type: "session_shutdown", reason: "quit" });
    expect(ctx.statuses.at(-1)).toBe(undefined);
  });

  test("passes configured absolute roots only to root production controllers", () => {
    const rootOptions = buildProductionControllerOptions(
      testAbsolutePath("/agent"),
      {
        maxConcurrentRuns: runCapacity(4),
        maxDepth: delegationDepth(2),
        cgroupRoot: testAbsolutePath("/sys/fs/cgroup/delegated"),
      },
      delegationDepth(0),
      () => {},
    );
    const stateRoot: AbsolutePath = rootOptions.stateRoot;
    const cgroupRoot: AbsolutePath | undefined = rootOptions.cgroupRoot;
    expect(String(stateRoot)).toBe("/agent/pi-subagents");
    expect(String(cgroupRoot)).toBe("/sys/fs/cgroup/delegated");
    expect(rootOptions).toMatchObject({ cgroupRoot: "/sys/fs/cgroup/delegated", currentDepth: 0 });
    expect(buildProductionControllerOptions(
      testAbsolutePath("/agent"),
      {
        maxConcurrentRuns: runCapacity(4),
        maxDepth: delegationDepth(2),
        cgroupRoot: testAbsolutePath("/sys/fs/cgroup/delegated"),
      },
      delegationDepth(1),
      () => {},
    )).not.toHaveProperty("cgroupRoot");
  });

  for (const preparation of ["prepareSpawn", "prepareSend"] as const) {
    for (const failure of ["unavailable", "probe"] as const) {
      test(`production ${preparation} ${failure} containment preflight is stable and precedes every launch side effect`, async () => {
        const sideEffects = {
          session: 0,
          persistence: 0,
          attempt: 0,
          watchdog: 0,
          launcher: 0,
          pi: 0,
        };
        const backend = containmentBackend(async () => {
          if (failure === "probe") throw new Error("host path and raw probe failure");
        });
        const provider = failure === "unavailable"
          ? { kind: "unavailable" as const, requireAvailable(): never { throw new Error("raw resolver path"); } }
          : { kind: "available" as const, backend };

        await expect(withProductionContainmentPreflight(provider, () => {
          sideEffects.session++;
          sideEffects.persistence++;
          sideEffects.attempt++;
          sideEffects.watchdog++;
          sideEffects.launcher++;
          sideEffects.pi++;
        })).rejects.toMatchObject({ code: "containment_failed", message: "containment_failed: cgroup-v2 containment is unavailable" });
        expect(sideEffects).toEqual({ session: 0, persistence: 0, attempt: 0, watchdog: 0, launcher: 0, pi: 0 });
      });
    }

    test(`production ${preparation} preserves an unrelated continuation failure`, async () => {
      const failure = new Error(`${preparation} original classification`);
      const backend = containmentBackend(async () => {});

      await expect(withProductionContainmentPreflight(
        { kind: "available", backend },
        () => { throw failure; },
      )).rejects.toBe(failure);
    });
  }

  test("default export is an extension factory", () => expect(typeof extension).toBe("function"));
});

function observedRunningStore(): AgentObservationStore {
  const store = new AgentObservationStore();
  const id = agentId("agent-a");
  store.registerSpawned({ agentId: id, ordinal: directAgentOrdinal(1), assignment: "task",
    sessionPath: testSessionPath("/tmp/pi-subagents-test/agent-a.jsonl"), cwd: testAbsolutePath("/tmp/pi-subagents-test"),
    model: modelSpec("mock-provider/luna"), thinkingLevel: "high" });
  store.updateLifecycle({ agentId: id, runId: runId("deadbeef"), state: AgentState.Running,
    transcriptPath: testSessionPath("/tmp/pi-subagents-test/agent-a.jsonl") });
  return store;
}

function containmentBackend(preflight: () => Promise<void>): ContainmentBackend {
  return {
    root: absolutePath("/cgroup/root"),
    parentScope: absolutePath("/cgroup/root/parent"),
    preflight,
    prepareAttempt: () => { throw new Error("attempt side effect"); },
    restoreAttempt: () => { throw new Error("restoration side effect"); },
    shutdown: async () => {},
  };
}

