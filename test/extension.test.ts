import { describe, expect, test } from "bun:test";

import extension, { buildProductionControllerOptions, createPiSubagentsExtension, type ExtensionController } from "../index.ts";
import { withProductionContainmentPreflight } from "../src/pi-composition.ts";
import type { ContainmentBackend } from "../src/containment.ts";
import { absolutePath } from "../src/paths.ts";
import { receiveAgentSchema, sendInputSchema, spawnAgentSchema, stopAgentSchema } from "../src/tools.ts";
import { deferred } from "./support/async.ts";
import { extensionApiForTest, lifecycleOn, type ExtensionApiPort, type LifecycleHandler } from "./support/extension-api.ts";

interface HarnessContext {
  statuses: Array<string | undefined>;
  ui: { setStatus(key: string, value: string | undefined): void };
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
    ui: { setStatus: (_key: string, value: string | undefined) => statuses.push(value) },
  };
}

function controller(log: string[]): ExtensionController {
  return {
    restore: async () => { log.push("restore"); },
    shutdown: async () => { log.push("shutdown"); },
    status: () => "0 running · 0 ready",
    tools: () => ({
      spawn_agent: { name: "spawn_agent", description: "spawn_agent", parameters: spawnAgentSchema, execute: async () => ({ content: "spawn_agent", details: { name: "spawn_agent" } }), renderResult: () => "spawn_agent" },
      send_input: { name: "send_input", description: "send_input", parameters: sendInputSchema, execute: async () => ({ content: "send_input", details: { name: "send_input" } }), renderResult: () => "send_input" },
      receive_agent: { name: "receive_agent", description: "receive_agent", parameters: receiveAgentSchema, execute: async () => ({ content: "receive_agent", details: { name: "receive_agent" } }), renderResult: () => "receive_agent" },
      stop_agent: { name: "stop_agent", description: "stop_agent", parameters: stopAgentSchema, execute: async () => ({ content: "stop_agent", details: { name: "stop_agent" } }), renderResult: () => "stop_agent" },
    }),
  };
}

describe("Pi subagents extension", () => {
  test("supported parent registers four rendered tools and the lifecycle handlers without starting resources", () => {
    const h = harness();
    const log: string[] = [];
    createPiSubagentsExtension({
      platform: "linux",
      nodeVersion: "22.19.0",
      child: false,
      createController: () => controller(log),
      diagnostic: (message) => log.push(message),
    })(extensionApiForTest(h.api));

    expect(log).toEqual([]);
    expect(h.tools.map((tool) => tool.name)).toEqual(["spawn_agent", "send_input", "receive_agent", "stop_agent"]);
    expect(h.tools.every((tool) => typeof tool.renderCall === "function" && typeof tool.renderResult === "function")).toBe(true);
    expect(h.tools[0]?.parameters).toBe(spawnAgentSchema);
    expect(h.tools[1]?.parameters).toBe(sendInputSchema);
    expect(h.tools[2]?.parameters).toBe(receiveAgentSchema);
    expect(h.tools[3]?.parameters).toBe(stopAgentSchema);
    expect([...h.handlers.keys()]).toEqual([
      "session_start", "session_before_tree", "session_before_switch", "session_before_fork", "session_shutdown",
    ]);
  });

  test("renders historical tool results without an active session", async () => {
    const h = harness();
    const log: string[] = [];
    createPiSubagentsExtension({
      platform: "linux", child: false,
      createController: () => controller(log), diagnostic: () => {},
    })(extensionApiForTest(h.api));
    const tool = h.tools[0] as { renderResult(result: { details?: object }): { text: string } };

    expect(tool.renderResult({ details: { name: "historical" } }).text).toBe('{"name":"historical"}');
    await h.emit("session_start", { type: "session_start", reason: "startup" });
    await h.emit("session_shutdown", { type: "session_shutdown", reason: "quit" });
    expect(tool.renderResult({ details: { name: "historical" } }).text).toBe('{"name":"historical"}');
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
          receive_agent: {
            ...registry.receive_agent,
            execute: async () => {
              await gate.promise;
              return { content: "receive_agent", details: { name: "receive_agent" } };
            },
          },
        };
      },
    };
    createPiSubagentsExtension({
      platform: "linux", nodeVersion: "22.19.0", child: false,
      createController: () => slow, diagnostic: () => {},
    })(extensionApiForTest(h.api));
    await h.emit("session_start", { type: "session_start", reason: "startup" });
    const tool = h.tools.find((entry) => entry.name === "receive_agent") as {
      execute(id: string, input: object, signal?: AbortSignal): Promise<{ details: object }>;
    };

    // The execution spans the shutdown that clears the active controller.
    const pending = tool.execute("call-1", {}, undefined);
    await h.emit("session_shutdown", { type: "session_shutdown", reason: "quit" });
    gate.resolve();

    expect(await pending).toMatchObject({ details: { name: "receive_agent" } });
  });

  test("spawn registration gives one non-duplicated asynchronous delegation guideline", () => {
    const h = harness();
    createPiSubagentsExtension({
      platform: "linux",
      child: false,
      createController: () => controller([]),
      diagnostic: () => {},
    })(extensionApiForTest(h.api));
    const spawn = h.tools.find((tool) => tool.name === "spawn_agent");

    expect(spawn?.description).toBe(
      "Start a persistent child assignment asynchronously; collect completion with receive_agent.",
    );
    expect(spawn?.promptSnippet).toBe("Delegate a fresh persistent assignment with spawn_agent");
    expect(spawn?.promptGuidelines).toEqual([
      "When delegation is requested, call spawn_agent directly, then use receive_agent to collect completion.",
    ]);
    for (const tool of h.tools.filter((candidate) => candidate.name !== "spawn_agent")) {
      expect(tool.promptGuidelines).toBeUndefined();
    }
  });

  test("child suppression registers nothing and cannot disable other extensions", () => {
    const h = harness();
    h.tools.push({ name: "other_extension" });
    createPiSubagentsExtension({
      platform: "linux", child: true,
      createController: () => { throw new Error("must not construct"); }, diagnostic: () => {},
    })(extensionApiForTest(h.api));
    expect(h.tools.map((tool) => tool.name)).toEqual(["other_extension"]);
    expect(h.handlers.size).toBe(0);
  });

  test("unsupported platform emits one bounded diagnostic and starts no resources", () => {
    const h = harness();
    const diagnostics: string[] = [];
    createPiSubagentsExtension({
      platform: "darwin", nodeVersion: "22.19.0", child: false,
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
    createPiSubagentsExtension({
      platform: "darwin", nodeVersion: "22.19.0", child: true,
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
      createPiSubagentsExtension({ platform: "linux", child: false,
        createController: () => controller(log), diagnostic: () => {} })(extensionApiForTest(h.api));
      const ctx = await h.emit("session_start", { type: "session_start", reason: "startup" });
      expect(log).toEqual(["restore"]);
      expect(ctx.statuses.at(-1)).toBe("0 running · 0 ready");
      await h.emit("session_shutdown", { type: "session_shutdown", reason });
      await h.emit("session_shutdown", { type: "session_shutdown", reason });
      expect(log).toEqual(["restore", "shutdown"]);
    }
  });

  test("reload shuts down the old instance before the next instance restores", async () => {
    const h = harness();
    const log: string[] = [];
    createPiSubagentsExtension({ platform: "linux", child: false,
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
    createPiSubagentsExtension({ platform: "linux", child: false,
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
    createPiSubagentsExtension({ platform: "linux", nodeVersion: "22.18.0", child: false,
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
    let value = "agents: 1 running, 0 result ready";
    createPiSubagentsExtension({ platform: "linux", child: false,
      createController: (_context, _api, refresh) => {
        refreshStatus = refresh;
        return { ...controller(log), status: () => value };
      }, diagnostic: () => {} })(extensionApiForTest(h.api));
    const ctx = await h.emit("session_start", { type: "session_start", reason: "startup" });
    value = "agents: 0 running, 1 result ready";

    refreshStatus();

    expect(ctx.statuses.at(-1)).toBe("agents: 0 running, 1 result ready");
  });

  test("passes the global cgroup root through factored production controller options", () => {
    expect(buildProductionControllerOptions("/agent", { maxConcurrentRuns: 2, cgroupRoot: "/sys/fs/cgroup/delegated" }, () => {})).toMatchObject({
      capacity: 2,
      stateRoot: "/agent/pi-subagents",
      cgroupRoot: "/sys/fs/cgroup/delegated",
    });
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

