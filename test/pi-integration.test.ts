import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
  accessSync,
  closeSync,
  constants,
  existsSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  readSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { CONFIG_DIR_NAME, RpcClient, SessionManager, type SessionEntry } from "@earendil-works/pi-coding-agent";

import { launchAfterSurrender } from "../src/pi-composition.ts";
import { verifyContainmentReceipt } from "../src/watchdog-client.ts";
import { containmentReceiptPath } from "../src/paths.ts";
import {
  adaptParentPiEnvironmentForRpcClient,
  clearManagedChildEnvironment,
  createParentPiEnvironment,
  reportIntegrationCli,
  resolveIntegrationCli,
} from "./support/pi-integration-harness.ts";
import { testAttemptId, testVerifiedReceiptPath } from "./support/brands.ts";
import { temporaryStateRoot } from "./support/temp-state.ts";

clearManagedChildEnvironment(process.env);

const PI_EXECUTABLE = resolveIntegrationCli();
reportIntegrationCli(PI_EXECUTABLE);
const LIFECYCLE_TOOLS = ["spawn_agent", "send_input", "await_agent", "stop_agent"] as const;

describe("installed Pi integration prerequisites", () => {
  test("the literal command-v Pi launcher registers the extension in a real parent session", async () => {
    const state = temporaryStateRoot("pi-literal-launcher-");
    const root: string = state.path;
    const agentDir = join(root, "agent");
    const extensions = join(agentDir, "extensions");
    const project = join(root, "project");
    mkdirSync(extensions, { recursive: true });
    mkdirSync(project);
    symlinkSync(fileURLToPath(new URL("..", import.meta.url)), join(extensions, "pi-subagents"));
    symlinkSync(
      fileURLToPath(new URL("fixtures/mock-provider-extension.ts", import.meta.url)),
      join(extensions, "mock-provider-extension.ts"),
    );
    const client = new RpcClient({
      cliPath: PI_EXECUTABLE,
      cwd: project,
      env: adaptParentPiEnvironmentForRpcClient(
        createParentPiEnvironment({ agentDir, home: root }),
      ),
      provider: "mock-provider",
      model: "mock-model",
      args: ["--approve", "--offline"],
    });
    try {
      await client.start();
      await client.promptAndWait("REPORT_TOOLS", undefined, 20_000);
      expect(parseStringArray(await client.getLastAssistantText())).toEqual(
        expect.arrayContaining([...LIFECYCLE_TOOLS]),
      );
      expect(client.getStderr()).not.toContain("pi-subagents disabled:");
    } finally {
      await client.stop();
      state.cleanup();
    }
  }, 30_000);

  test("normal launcher registers four lifecycle tools and runs one deterministic child without network access", async () => {
    const state = temporaryStateRoot("pi-real-integration-");
    const root: string = state.path;
    const agentDir = join(root, "agent");
    const extensions = join(agentDir, "extensions");
    const project = join(root, "project");
    mkdirSync(extensions, { recursive: true });
    mkdirSync(project);
    symlinkSync(fileURLToPath(new URL("..", import.meta.url)), join(extensions, "pi-subagents"));
    const provider = fileURLToPath(new URL("fixtures/mock-provider-extension.ts", import.meta.url));
    expect(existsSync(provider)).toBeTrue();
    symlinkSync(provider, join(extensions, "mock-provider-extension.ts"));
    writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ subagents: { maxConcurrentRuns: 2 } }));
    const client = new RpcClient({
      cliPath: PI_EXECUTABLE,
      cwd: project,
      env: adaptParentPiEnvironmentForRpcClient(createParentPiEnvironment({ agentDir, home: root })),
      provider: "mock-provider",
      model: "mock-model",
      args: ["--approve", "--offline"],
    });
    try {
      await client.start();
      await client.promptAndWait("REPORT_TOOLS", undefined, 20_000);
      const tools = JSON.parse((await client.getLastAssistantText()) ?? "[]") as unknown;
      expect(tools).toEqual(expect.arrayContaining(["spawn_agent", "send_input", "await_agent", "stop_agent"]));
      expect(client.getStderr()).not.toContain("pi-subagents disabled:");
      await client.promptAndWait("CALL_SPAWN", undefined, 20_000);
      await client.promptAndWait("CALL_AWAIT", undefined, 20_000);
      const text = await client.getLastAssistantText();
      expect(text).toContain("child-complete");
      const completed = lifecycleEntries((await client.getEntries()).entries)
        .reverse().find((event) => lifecycleEventTypes([event])[0] === "run_completed");
      const completedPayload = lifecyclePayload(completed);
      const committedPath = String(completedPayload.outputPath);
      expect(lstatSync(committedPath).isFile()).toBeTrue();
      expect(lstatSync(committedPath).mode & 0o777).toBe(0o600);
      expect(readFileSync(committedPath, "utf8")).toContain("child-complete");
      expect(readdirSync(join(committedPath, "..")).filter((name) => name.startsWith(".tmp-"))).toEqual([]);
      expect(client.getStderr()).not.toContain("http");
    } finally {
      await client.stop();
      state.cleanup();
    }
  }, 30_000);

  test("a restarted parent restores and resumes a legacy unqualified persisted model", async () => {
    const state = temporaryStateRoot("pi-real-restore-");
    const root: string = state.path;
    const agentDir = join(root, "agent");
    const extensions = join(agentDir, "extensions");
    const project = join(root, "project");
    mkdirSync(extensions, { recursive: true });
    mkdirSync(project);
    symlinkSync(fileURLToPath(new URL("..", import.meta.url)), join(extensions, "pi-subagents"));
    symlinkSync(fileURLToPath(new URL("fixtures/mock-provider-extension.ts", import.meta.url)), join(extensions, "mock-provider-extension.ts"));
    const options = {
      cliPath: PI_EXECUTABLE,
      cwd: project,
      env: adaptParentPiEnvironmentForRpcClient(createParentPiEnvironment({ agentDir, home: root })),
      provider: "mock-provider",
      model: "mock-model",
      args: ["--approve", "--offline"],
    };
    const first = new RpcClient(options);
    await first.start();
    await first.promptAndWait("CALL_SPAWN_TASK|CHILD_COMPLETE|mock-provider/luna", undefined, 20_000);
    const started = decodeStartResult(await first.getLastAssistantText());
    expect(started.agentId).toBeString();
    expect(started.runId).toMatch(/^[0-9a-f]{8}$/);
    expect(started.model).toBe("mock-provider/luna");
    const spawned = lifecycleEntries((await first.getEntries()).entries)
      .find((event) => lifecycleEventTypes([event])[0] === "spawned");
    const newlyPersistedPayload = lifecyclePayload(spawned);
    await first.promptAndWait("CALL_AWAIT", undefined, 20_000);
    const parentFile = (await first.getState()).sessionFile;
    expect(parentFile).toBeString();
    await first.stop();
    publishDeferredV2Receipt(parentFile!, started.agentId);
    seedLegacySpawnedModel(parentFile!, started.agentId, "mock-provider", "luna");

    const second = new RpcClient({ ...options, args: [...options.args, "--session", parentFile!] });
    try {
      await second.start();
      await second.promptAndWait("ACK_RESTORATION_NOTIFICATION", undefined, 20_000);
      await second.promptAndWait(`CALL_SEND|${started.agentId}|CHILD_COMPLETE_AGAIN`, undefined, 20_000);
      const resumed = decodeStartResult(await second.getLastAssistantText());
      expect(resumed).toMatchObject({ agentId: started.agentId, state: "running" });
      expect(resumed.runId).not.toBe(started.runId);
      expect({ provider: newlyPersistedPayload.provider, modelId: newlyPersistedPayload.modelId })
        .toEqual({ provider: "mock-provider", modelId: "luna" });
      await second.promptAndWait("CALL_AWAIT", undefined, 20_000);
      expect(await second.getLastAssistantText()).toContain(started.runId!);
      await second.promptAndWait("CALL_AWAIT", undefined, 20_000);
      expect(await second.getLastAssistantText()).toContain("CHILD_COMPLETE>CHILD_COMPLETE_AGAIN");
      const transcript = readFileSync(findChildTranscript(agentDir, started.agentId), "utf8");
      expect(transcript).toContain('"provider":"mock-provider"');
      expect(transcript).toContain('"model":"luna"');
    } finally {
      await second.stop();
      state.cleanup();
    }
  }, 40_000);

  test("trusted discovery, child tool suppression, extension-owned model suffixes and unavailable tools", async () => {
    const state = temporaryStateRoot("pi-real-matrix-");
    const root: string = state.path;
    const agentDir = join(root, "agent");
    const extensions = join(agentDir, "extensions");
    const project = join(root, "project");
    mkdirSync(join(agentDir, "skills", "global-skill"), { recursive: true });
    mkdirSync(join(project, ".pi", "skills", "project-skill"), { recursive: true });
    mkdirSync(extensions, { recursive: true });
    writeFileSync(join(agentDir, "SYSTEM.md"), "GLOBAL_CONTEXT_MARKER");
    writeFileSync(join(project, "AGENTS.md"), "PROJECT_CONTEXT_MARKER");
    writeFileSync(join(agentDir, "skills", "global-skill", "SKILL.md"), "---\nname: global-skill\ndescription: GLOBAL_SKILL_MARKER\n---\n");
    writeFileSync(join(project, ".pi", "skills", "project-skill", "SKILL.md"), "---\nname: project-skill\ndescription: PROJECT_SKILL_MARKER\n---\n");
    symlinkSync(fileURLToPath(new URL("..", import.meta.url)), join(extensions, "pi-subagents"));
    symlinkSync(fileURLToPath(new URL("fixtures/mock-provider-extension.ts", import.meta.url)), join(extensions, "mock-provider-extension.ts"));
    const client = new RpcClient({
      cliPath: PI_EXECUTABLE, cwd: project,
      env: adaptParentPiEnvironmentForRpcClient(createParentPiEnvironment({ agentDir, home: root })), provider: "mock-provider", model: "mock-model", args: ["--approve", "--offline"],
    });
    try {
      await client.start();
      await client.setThinkingLevel("high");
      await client.promptAndWait("CALL_SPAWN_TASK|REPORT_CONTEXT|mock-provider/mock-model:minimal", undefined, 20_000);
      const first = decodeStartResult(await client.getLastAssistantText());
      expect(first.agentId).toBeString();
      expect(first.runId).toMatch(/^[0-9a-f]{8}$/);
      await client.promptAndWait("CALL_AWAIT", undefined, 20_000);
      const contextResult = (await client.getLastAssistantText()) ?? "";
      expect(contextResult).toContain("GLOBAL_CONTEXT_MARKER");
      expect(contextResult).toContain("PROJECT_CONTEXT_MARKER");
      expect(contextResult).toContain("global-skill");
      expect(contextResult).toContain("project-skill");

      await client.promptAndWait("CALL_SPAWN_TASK|REPORT_TOOLS", undefined, 20_000);
      await client.promptAndWait("CALL_AWAIT", undefined, 20_000);
      const toolsResult = (await client.getLastAssistantText()) ?? "";
      expect(toolsResult).toContain("bash");
      expect(toolsResult).toContain("edit");
      expect(toolsResult).toContain("mock_child_extension");
      expect(toolsResult).not.toContain("spawn_agent");
      expect(toolsResult).not.toContain("await_agent");

      await client.promptAndWait("CALL_SPAWN_TASK|CHILD_COMPLETE|||read,missing-tool", undefined, 20_000);
      expect(await client.getLastAssistantText()).toContain("invalid_input");
      const transcript = readFileSync(findChildTranscript(agentDir, first.agentId), "utf8");
      expect(transcript).toContain('"thinkingLevel":"minimal"');
      expect(transcript).toContain('"provider":"mock-provider"');
    } finally { await client.stop(); state.cleanup(); }
  }, 40_000);

  test("real composition surrenders containment exactly once before constructing a launch", () => {
    const order: string[] = [];
    const runtime = { abort: async () => {}, contain: async () => testVerifiedReceiptPath("/tmp/pi-subagents-test/receipt") };
    const result = launchAfterSurrender(
      runtime,
      (owned) => { expect(owned).toBe(runtime); order.push("surrender"); },
      () => { order.push("launch"); return 42; },
    );
    expect(result).toBe(42);
    expect(order).toEqual(["surrender", "launch"]);
  });

  test("a no-process containment receipt is accepted for the matching attempt", () => {
    const state = temporaryStateRoot("pi-receipt-");
    const root: string = state.path;
    try {
      const path = join(root, "receipt.json");
      const attempt = "attempt-real-pi";
      writeFileSync(path, JSON.stringify({ version: 1, attemptId: attempt, pgid: null, outcome: "no_process", timestamp: new Date().toISOString() }));
      expect(String(verifyContainmentReceipt(containmentReceiptPath(path, path), testAttemptId(attempt), Date.now() - 1_000).path)).toBe(path);
      expect(readFileSync(path, "utf8")).toContain(attempt);
    } finally {
      state.cleanup();
    }
  });
});

describe("deterministic network-free real-Pi matrix", () => {
  test("00 inherited child suppression is removed before parent tool registration", async () => {
    await withFixture("inherited-child-marker", async ({ client }) => {
      await client.promptAndWait("REPORT_TOOLS", undefined, 20_000);
      expect(parseStringArray(await client.getLastAssistantText())).toEqual(expect.arrayContaining([
        "spawn_agent",
        "send_input",
        "await_agent",
        "stop_agent",
      ]));
    }, { ...process.env, PI_SUBAGENT_CHILD: "1" });
  }, 30_000);

  test("state snapshots detect modifications to existing file contents", () => {
    const state = temporaryStateRoot("pi-state-snapshot-");
    const root: string = state.path;
    try {
      const path = join(root, "state.json");
      writeFileSync(path, "before");
      const before = snapshotTree(root);
      writeFileSync(path, "after!");
      expect(snapshotTree(root)).not.toEqual(before);
    } finally {
      state.cleanup();
    }
  });

  test("01 trusted cwd discovers global/project context and skills", async () => {
    await withFixture("discovery", async ({ client }) => {
      await client.promptAndWait("CALL_SPAWN_TASK|REPORT_CONTEXT", undefined, 20_000);
      await client.promptAndWait("CALL_AWAIT", undefined, 20_000);
      const result = (await client.getLastAssistantText()) ?? "";
      expect(result).toContain("GLOBAL_CONTEXT_MARKER");
      expect(result).toContain("PROJECT_CONTEXT_MARKER");
      expect(result).toContain("global-skill");
      expect(result).toContain("project-skill");
    });
  }, 30_000);

  test("01b trusted project settings use Pi's exported configuration directory", async () => {
    await withFixture("config-dir-settings", async ({ client }) => {
      await client.promptAndWait("CALL_SPAWN_TASK|CHILD_HANG", undefined, 20_000);
      expect(decodeStartResult(await client.getLastAssistantText()).state).toBe("running");
      await client.promptAndWait("CALL_SPAWN", undefined, 20_000);
      expect(await client.getLastAssistantText()).toContain("capacity_exceeded");
    }, process.env, undefined, ({ project }) => {
      mkdirSync(join(project, CONFIG_DIR_NAME), { recursive: true });
      writeFileSync(join(project, CONFIG_DIR_NAME, "settings.json"), JSON.stringify({
        subagents: { maxConcurrentRuns: 1 },
      }));
    });
  }, 30_000);

  test("02 spawn creates a persistent child session beneath its parent partition", async () => {
    await withFixture("partition", async ({ client, agentDir }) => {
      const started = await spawn(client);
      const transcript = findChildTranscript(agentDir, started.agentId);
      const relative = transcript.slice(join(agentDir, "pi-subagents").length + 1).split("/");
      expect(relative).toHaveLength(3);
      expect(relative[1]).toBe("sessions");
      expect(existsSync(transcript)).toBeTrue();
    });
  }, 30_000);

  test("03 public agent ID is the native child session ID", async () => {
    await withFixture("agent-id", async ({ client, agentDir }) => {
      const started = await spawn(client);
      const native = SessionManager.open(findChildTranscript(agentDir, started.agentId));
      expect(native.getSessionId()).toBe(started.agentId);
    });
  }, 30_000);

  test("04 each spawn/resume run ID is its exact literal assignment user-entry ID", async () => {
    await withFixture("run-id", async ({ client, agentDir }) => {
      const started = await spawn(client);
      await client.promptAndWait("CALL_AWAIT", undefined, 20_000);
      let entries = SessionManager.open(findChildTranscript(agentDir, started.agentId)).getEntries();
      expect(exactUserEntryId(entries, "CHILD_COMPLETE")).toBe(started.runId);
      await client.promptAndWait(`CALL_SEND|${started.agentId}|CHILD_COMPLETE_AGAIN`, undefined, 20_000);
      const resumed = decodeStartResult(await client.getLastAssistantText());
      expect(resumed.agentId).toBe(started.agentId);
      expect(resumed.runId).not.toBe(started.runId);
      entries = SessionManager.open(findChildTranscript(agentDir, started.agentId)).getEntries();
      expect(exactUserEntryId(entries, "CHILD_COMPLETE_AGAIN")).toBe(resumed.runId);
    });
  }, 30_000);

  test("04b transformed child assignment evidence is contained without RunStarted", async () => {
    await withFixture("transformed-identity", async ({ client }) => {
      await client.promptAndWait("CALL_SPAWN", undefined, 20_000);
      expect(await client.getLastAssistantText()).toContain("spawn_failed");
      const events = lifecycleEntries((await client.getEntries()).entries);
      const launch = events.map(lifecyclePayload).find((payload) => payload.attemptId !== undefined);
      expect(launch).toBeDefined();
      const attemptId = String(launch!.attemptId);
      expect(lifecycleEventTypes(events)).not.toContain("run_started");
      const receipt = String(launch!.containmentReceiptPath);
      expect(String(verifyContainmentReceipt(containmentReceiptPath(receipt, receipt), testAttemptId(attemptId)).path)).toBe(receipt);
    }, process.env, () => ({ MOCK_CHILD_IDENTITY_FIXTURE: "transform" }));
  }, 30_000);

  test("04c child input completes immediately before agent_start", async () => {
    await withFixture("input-order", async ({ client, root }) => {
      const orderPath = join(root, "input-order.log");
      const started = await spawn(client);
      expect(readFileSync(orderPath, "utf8")).toBe("input-complete\nagent-start\n");
      expect(started.runId).toMatch(/^[0-9a-f]{8}$/);
    }, process.env, ({ root }) => ({ MOCK_CHILD_INPUT_ORDER_PATH: join(root, "input-order.log") }));
  }, 30_000);

  test("05 extension-owned model patterns, thinking inheritance and effective running fields", async () => {
    await withFixture("model", async ({ client, agentDir }) => {
      await client.setThinkingLevel("high");
      await client.promptAndWait("CALL_SPAWN_TASK|REPORT_TOOLS|mock-model||mock_child_extension", undefined, 20_000);
      const bare = decodeStartResult(await client.getLastAssistantText());
      expect(bare).toMatchObject({
        state: "running", model: "mock-provider/mock-model", thinkingLevel: "high",
        tools: ["mock_child_extension"],
      });
      expect(await awaitReportedTools(client)).toEqual(["mock_child_extension"]);

      await client.promptAndWait("CALL_SPAWN_TASK|REPORT_TOOLS|mock-provider/mock-model:minimal||<none>", undefined, 20_000);
      const explicit = decodeStartResult(await client.getLastAssistantText());
      expect(explicit).toMatchObject({
        state: "running", model: "mock-provider/mock-model", thinkingLevel: "minimal", tools: [],
      });
      expect(await awaitReportedTools(client)).toEqual([]);
      expect(readFileSync(findChildTranscript(agentDir, explicit.agentId), "utf8")).toContain('"thinkingLevel":"minimal"');

      await client.promptAndWait("REPORT_TOOLS", undefined, 20_000);
      const parentActiveTools = parseStringArray(await client.getLastAssistantText());
      const expectedInheritedTools = parentActiveTools.filter((tool) =>
        !LIFECYCLE_TOOLS.includes(tool as typeof LIFECYCLE_TOOLS[number]));
      await client.promptAndWait("CALL_SPAWN_TASK|REPORT_TOOLS", undefined, 20_000);
      const inherited = decodeStartResult(await client.getLastAssistantText());
      expect(inherited).toMatchObject({
        state: "running", model: "mock-provider/mock-model", thinkingLevel: "high",
      });
      expect([...inherited.tools!].sort()).toEqual(expectedInheritedTools);
      const childReportedTools = await awaitReportedTools(client);
      expect(childReportedTools).toEqual(expectedInheritedTools);
      expect(expectedInheritedTools).toContain("mock_child_extension");
      for (const lifecycleTool of LIFECYCLE_TOOLS) {
        expect(inherited.tools).not.toContain(lifecycleTool);
        expect(childReportedTools).not.toContain(lifecycleTool);
      }

      await client.promptAndWait("CALL_SPAWN_TASK|REPORT_TOOLS|mock-provider/plain-model", undefined, 20_000);
      const clamped = decodeStartResult(await client.getLastAssistantText());
      expect(clamped).toMatchObject({
        state: "running", model: "mock-provider/plain-model", thinkingLevel: "high",
      });
      expect(await awaitReportedTools(client)).toEqual([...clamped.tools!].sort());
      const transcript = readFileSync(findChildTranscript(agentDir, clamped.agentId), "utf8");
      expect(transcript).toContain('"modelId":"plain-model"');
      expect(transcript).toContain('"thinkingLevel":"off"');
    });
  }, 40_000);

  test("05a managed depth-two delegation exposes lifecycle tools only below the boundary", async () => {
    await withFixture("nested-delegation", async ({ client, childLaunchDir, agentDir }) => {
      await client.promptAndWait("CALL_SPAWN_TASK|NESTED_DELEGATION", undefined, 20_000);
      const child = decodeStartResult(await client.getLastAssistantText());
      expect(child.tools).toEqual(expect.arrayContaining(["spawn_agent", "await_agent"]));

      await client.promptAndWait("CALL_AWAIT", undefined, 20_000);
      const received = parseJsonRecord(await client.getLastAssistantText());
      const completions = received.completions;
      if (!Array.isArray(completions) || completions.length !== 1) throw new Error("missing nested child completion");
      const childOutput = requireJsonRecord(requireJsonRecord(completions[0]).output).text;
      if (typeof childOutput !== "string") throw new Error("missing nested child output");
      const nested = parseJsonRecord(childOutput);
      expect(nested.childTools).toEqual(expect.arrayContaining(["spawn_agent", "await_agent"]));
      const grandchildReceive = requireJsonRecord(nested.grandchildReceive);
      const grandchildCompletions = grandchildReceive.completions;
      if (!Array.isArray(grandchildCompletions) || grandchildCompletions.length !== 1) {
        throw new Error("missing grandchild completion");
      }
      const grandchild = requireJsonRecord(grandchildCompletions[0]);
      const grandchildText = requireJsonRecord(grandchild.output).text;
      if (typeof grandchildText !== "string") throw new Error("missing grandchild output");
      const grandchildTools = parseStringArray(grandchildText);
      for (const lifecycleTool of LIFECYCLE_TOOLS) expect(grandchildTools).not.toContain(lifecycleTool);

      const childTranscript = SessionManager.open(findChildTranscript(agentDir, child.agentId)).getEntries();
      expect(transcriptToolNames(childTranscript)).toEqual(expect.arrayContaining(["spawn_agent", "await_agent"]));
      expect(transcriptToolNames(childTranscript)).not.toContain("bash");
      expect(containsPiCommand(transcriptAssistantText(childTranscript))).toBeFalse();
      if (typeof grandchild.agentId !== "string") throw new Error("missing grandchild agent ID");
      const grandchildTranscript = SessionManager.open(findChildTranscript(agentDir, grandchild.agentId)).getEntries();
      expect(transcriptToolNames(grandchildTranscript)).not.toContain("bash");
      expect(containsPiCommand(transcriptAssistantText(grandchildTranscript))).toBeFalse();

      expect(childLaunchPids(childLaunchDir)).toHaveLength(2);
      expect(childLaunchPids(childLaunchDir).every(processAbsent)).toBeTrue();
    }, process.env, undefined, ({ agentDir }) => {
      writeFileSync(join(agentDir, "settings.json"), JSON.stringify({
        defaultProvider: "mock-provider",
        defaultModel: "mock-model",
        defaultThinkingLevel: "high",
        subagents: { maxConcurrentRuns: 2, maxDepth: 2 },
      }));
    });
  }, 40_000);

  test("05b child model selection does not change Pi's global defaults", async () => {
    await withFixture("model-defaults", async ({ client, agentDir }) => {
      const settingsPath = join(agentDir, "settings.json");
      const defaultsBefore = readFileSync(settingsPath, "utf8");

      await client.promptAndWait("CALL_SPAWN_TASK|REPORT_TOOLS|mock-provider/luna:minimal||<none>", undefined, 20_000);
      const started = decodeStartResult(await client.getLastAssistantText());
      expect(started).toMatchObject({
        state: "running", model: "mock-provider/luna", thinkingLevel: "minimal", tools: [],
      });
      expect(await awaitReportedTools(client)).toEqual([]);

      expect(readFileSync(settingsPath, "utf8")).toBe(defaultsBefore);
    });
  }, 30_000);

  test("06 built-in, extension, mixed and empty tool allowlists are exact", async () => {
    await withFixture("tools", async ({ client }) => {
      for (const tools of [["read"], ["mock_child_extension"], ["read", "mock_child_extension"]] as const) {
        await client.promptAndWait(`CALL_SPAWN_TASK|REPORT_TOOLS|||${tools.join(",")}`, undefined, 20_000);
        expect(decodeStartResult(await client.getLastAssistantText())).toMatchObject({ state: "running", tools: [...tools] });
        expect(await awaitReportedTools(client)).toEqual([...tools].sort());
      }
      await client.promptAndWait("CALL_SPAWN_TASK|REPORT_TOOLS|||<none>", undefined, 20_000);
      expect(decodeStartResult(await client.getLastAssistantText())).toMatchObject({ state: "running", tools: [] });
      expect(await awaitReportedTools(client)).toEqual([]);
    });
  }, 40_000);

  test("07 inactive and lifecycle tool rejection has no lifecycle, state or child-launch side effects", async () => {
    await withFixture("rejection", async ({ client, agentDir, childLaunchDir }) => {
      await client.promptAndWait("CALL_SPAWN_TASK|CHILD_COMPLETE|||<none>", undefined, 20_000);
      expect(decodeStartResult(await client.getLastAssistantText()).state).toBe("running");
      await client.promptAndWait("CALL_AWAIT", undefined, 20_000);
      expect(snapshotTree(childLaunchDir)).toHaveLength(1);
      expect(childLaunchPids(childLaunchDir).every(processAbsent)).toBeTrue();
      for (const rejectedTool of ["missing-tool", "spawn_agent", "await_agent"]) {
        const lifecycleBefore = lifecycleEntries((await client.getEntries()).entries);
        const stateBefore = snapshotTree(join(agentDir, "pi-subagents"));
        const launchesBefore = snapshotTree(childLaunchDir);
        await client.promptAndWait(`CALL_SPAWN_TASK|CHILD_COMPLETE|||${rejectedTool}`, undefined, 20_000);
        const invalid = (await client.getLastAssistantText()) ?? "";
        expect(invalid).toContain("invalid_input");
        expect(invalid).toContain(`\"${rejectedTool}\"`);
        expect(Buffer.byteLength(invalid)).toBeLessThan(10_000);
        expect(lifecycleEntries((await client.getEntries()).entries)).toEqual(lifecycleBefore);
        expect(snapshotTree(join(agentDir, "pi-subagents"))).toEqual(stateBefore);
        expect(snapshotTree(childLaunchDir)).toEqual(launchesBefore);
      }
    });
  }, 30_000);

  test("08 spawn_agent provider metadata describes extension-owned selection semantics", async () => {
    await withFixture("schema", async ({ client }) => {
      await client.promptAndWait("REPORT_SPAWN_SCHEMA", undefined, 20_000);
      const metadata = parseJsonRecord(await client.getLastAssistantText());
      expect(metadata.description).toBe("Start a persistent child assignment asynchronously; collect completion with await_agent.");
      const parameters = requireJsonRecord(metadata.parameters);
      expect(parameters.description).toBe("Start a fresh persistent child session asynchronously; collect completion with await_agent.");
      const properties = requireJsonRecord(parameters.properties);
      expect(requireJsonRecord(properties.task).description).toBe("Literal first assignment for the fresh child session.");
      expect(requireJsonRecord(properties.model).description).toContain("child model pattern");
      expect(requireJsonRecord(properties.cwd).description).toContain("defaults to the parent working directory");
      expect(requireJsonRecord(properties.tools).description).toContain("exact allowlist from parent-active tools");
      expect(requireJsonRecord(properties.tools).description).toContain("[] enables none");
    });
  }, 30_000);

  test("09 qualified unknown model uses the projected custom-model fallback warning", async () => {
    await withFixture("fallback", async ({ client }) => {
      await client.setThinkingLevel("high");
      await client.promptAndWait("CALL_SPAWN_TASK|REPORT_TOOLS|mock-provider/new-model||<none>", undefined, 20_000);
      const started = decodeStartResult(await client.getLastAssistantText());
      expect(started).toMatchObject({
        state: "running", model: "mock-provider/new-model", thinkingLevel: "high", tools: [],
        warning: 'Model pattern "mock-provider/new-model" uses the custom model-id fallback.',
      });
      expect(started.warning).not.toContain('Model "new-model" not found');
      expect(await awaitReportedTools(client)).toEqual([]);
    });
  }, 30_000);

  test("10 stopped-child resume preserves native conversation context", async () => {
    await withFixture("conversation", async ({ client }) => {
      const started = await spawn(client);
      await client.promptAndWait("CALL_AWAIT", undefined, 20_000);
      await client.promptAndWait(`CALL_SEND|${started.agentId}|CHILD_COMPLETE_AGAIN`, undefined, 20_000);
      await client.promptAndWait("CALL_AWAIT", undefined, 20_000);
      expect(await client.getLastAssistantText()).toContain("CHILD_COMPLETE>CHILD_COMPLETE_AGAIN");
    });
  }, 30_000);

  test("11 child confirmation is forwarded and cancelled when the parent has no UI", async () => {
    await withFixture("confirmation", async ({ client }) => {
      await client.promptAndWait("CALL_SPAWN_TASK|CHILD_CONFIRM", undefined, 20_000);
      await client.promptAndWait("CALL_AWAIT", undefined, 20_000);
      const result = (await client.getLastAssistantText()) ?? "";
      expect(result).toContain("active");
      expect(result).not.toContain("confirmed");
    });
  }, 30_000);

  test("12 external cwd receives no inherited trust approval", async () => {
    await withFixture("external-trust", async ({ client, external }) => {
      await client.promptAndWait(`CALL_SPAWN_TASK|REPORT_PROCESS||${external}`, undefined, 20_000);
      await client.promptAndWait("CALL_AWAIT", undefined, 20_000);
      const result = (await client.getLastAssistantText()) ?? "";
      expect(result).toContain(`\\\"cwd\\\":\\\"${external}\\\"`);
      expect(result).not.toContain("--approve");
    });
  }, 30_000);

  test("13 parent custom entries survive compaction, process reload and resume", async () => {
    await withFixture("custom-entries", async ({ client, options }) => {
      const started = await spawn(client);
      await client.promptAndWait("CALL_AWAIT", undefined, 20_000);
      const before = await client.getEntries();
      const customBefore = lifecycleEntries(before.entries);
      expect(customBefore.length).toBeGreaterThanOrEqual(4);
      expect(lifecycleEventTypes(customBefore).slice(-4)).toEqual(["spawned", "run_launch_requested", "run_started", "run_completed"]);
      await client.promptAndWait(`COMPACTION_PAYLOAD:${"x".repeat(100_000)}`, undefined, 20_000);
      await client.compact("Return a short deterministic summary.");
      expect(lifecycleEntries((await client.getEntries()).entries)).toEqual(customBefore);
      const parentFile = (await client.getState()).sessionFile;
      expect(parentFile).toBeString();
      await client.stop();
      const resumed = new RpcClient({ ...options, args: [...options.args, "--session", parentFile!] });
      try {
        await resumed.start();
        await resumed.promptAndWait("ACK_RESTORATION_NOTIFICATION", undefined, 20_000);
        await resumed.promptAndWait("CALL_AWAIT", undefined, 20_000);
        expect(await resumed.getLastAssistantText()).toContain(started.agentId);
        expect(lifecycleEntries((await resumed.getEntries()).entries)).toEqual(customBefore);
      } finally { await resumed.stop(); }
    });
  }, 40_000);

  test("14 parent shutdown persists and restores the exact parent_shutdown cancellation reason", async () => {
    await withFixture("shutdown-reason", async ({ client, options }) => {
      await client.promptAndWait("CALL_SPAWN_TASK|CHILD_HANG", undefined, 20_000);
      const started = decodeStartResult(await client.getLastAssistantText());
      const parentFile = (await client.getState()).sessionFile;
      expect(parentFile).toBeString();

      await client.stop();
      publishDeferredV2Receipt(parentFile!, started.agentId);

      const persisted = lifecycleEntries(SessionManager.open(parentFile!).getEntries());
      expect(lifecycleEventTypes(persisted).slice(-4)).toEqual([
        "run_launch_requested", "run_started", "run_stopping", "run_completed",
      ]);
      expect(lifecyclePayload(persisted.at(-2))).toMatchObject({
        agentId: started.agentId,
        runId: started.runId,
        reason: "parent_shutdown",
      });
      const cancelled = lifecyclePayload(persisted.at(-1));
      expect(cancelled).toMatchObject({
        agentId: started.agentId,
        runId: started.runId,
        state: "cancelled",
        reason: "parent_shutdown",
      });
      const committedPath = String(cancelled.outputPath);
      expect(lstatSync(committedPath).isFile()).toBeTrue();
      expect(lstatSync(committedPath).mode & 0o777).toBe(0o600);
      expect(readFileSync(committedPath, "utf8")).toBe("");
      expect(readdirSync(join(committedPath, "..")).filter((name) => name.startsWith(".tmp-"))).toEqual([]);

      const resumed = new RpcClient({ ...options, args: [...options.args, "--session", parentFile!] });
      try {
        await resumed.start();
        await resumed.promptAndWait("ACK_RESTORATION_NOTIFICATION", undefined, 20_000);
        await resumed.promptAndWait("CALL_AWAIT", undefined, 20_000);
        const result = (await resumed.getLastAssistantText()) ?? "";
        expect(result).toContain(started.runId);
        expect(result).toContain("parent_shutdown");
        const restored = lifecycleEntries((await resumed.getEntries()).entries);
        expect(lifecycleEventTypes(restored).at(-1)).toBe("run_completed");
        expect(lifecyclePayload(restored.at(-1))).toMatchObject({
          agentId: started.agentId,
          runId: started.runId,
          state: "cancelled",
          reason: "parent_shutdown",
        });
      } finally { await resumed.stop(); }
    });
  }, 40_000);

  test("14a restart recovery replaces a stale destination from authoritative child transcript evidence", async () => {
    await withFixture("stale-output-recovery", async ({ client, options }) => {
      const started = await spawn(client);
      await client.promptAndWait("CALL_AWAIT", undefined, 20_000);
      const parentFile = (await client.getState()).sessionFile;
      expect(parentFile).toBeString();
      const completed = lifecycleEntries((await client.getEntries()).entries)
        .map(lifecyclePayload)
        .find((payload) => payload.agentId === started.agentId && payload.state === "completed");
      expect(completed).toBeDefined();
      const committedPath = String(completed!.outputPath);
      expect(readFileSync(committedPath, "utf8")).toContain("child-complete");
      await client.stop();
      publishDeferredV2Receipt(parentFile!, started.agentId);

      removeLifecycleEvents(parentFile!, started.agentId, new Set(["run_completed"]));
      writeFileSync(committedPath, "deliberately stale", { mode: 0o600 });
      const resumed = new RpcClient({ ...options, args: [...options.args, "--session", parentFile!] });
      try {
        await resumed.start();
        await resumed.promptAndWait("ACK_RESTORATION_NOTIFICATION", undefined, 20_000);
        expect(readFileSync(committedPath, "utf8")).toContain("child-complete");
        expect(readFileSync(committedPath, "utf8")).not.toContain("deliberately stale");
        expect(readdirSync(join(committedPath, "..")).filter((name) => name.startsWith(".tmp-"))).toEqual([]);
        const restored = lifecycleEntries((await resumed.getEntries()).entries).map(lifecyclePayload);
        expect(restored.find((payload) => payload.agentId === started.agentId && payload.state === "failed" &&
          isJsonRecord(payload.error) && payload.error.code === "run_interrupted")).toBeDefined();
      } finally { await resumed.stop(); }
    });
  }, 40_000);

  test("14b interrupted no-assistant recovery publishes an empty sidecar and releases its obligation", async () => {
    await withFixture("empty-output-recovery", async ({ client, options, agentDir }) => {
      await client.promptAndWait("CALL_SPAWN_TASK|CHILD_HANG", undefined, 20_000);
      const started = decodeStartResult(await client.getLastAssistantText());
      const parentFile = (await client.getState()).sessionFile;
      expect(parentFile).toBeString();
      await client.stop();
      publishDeferredV2Receipt(parentFile!, started.agentId);

      const cancelled = lifecycleEntries(SessionManager.open(parentFile!).getEntries()).map(lifecyclePayload)
        .find((payload) => payload.agentId === started.agentId && payload.state === "cancelled");
      expect(cancelled).toBeDefined();
      const committedPath = String(cancelled!.outputPath);
      removeLifecycleEvents(parentFile!, started.agentId, new Set(["run_stopping", "run_completed"]));
      rmSync(committedPath, { force: true });
      writeFileSync(join(agentDir, "settings.json"), JSON.stringify({
        defaultProvider: "mock-provider", defaultModel: "mock-model", defaultThinkingLevel: "high",
        subagents: { maxConcurrentRuns: 1 },
      }));

      const resumed = new RpcClient({ ...options, args: [...options.args, "--session", parentFile!] });
      try {
        await resumed.start();
        await resumed.promptAndWait("ACK_RESTORATION_NOTIFICATION", undefined, 20_000);
        const restored = lifecycleEntries((await resumed.getEntries()).entries).map(lifecyclePayload);
        const interrupted = restored.find((payload) => payload.agentId === started.agentId && payload.state === "failed" &&
          isJsonRecord(payload.error) && payload.error.code === "run_interrupted");
        expect(interrupted).toBeDefined();
        expect(String(interrupted!.outputPath)).toBe(committedPath);
        expect(lstatSync(committedPath).isFile()).toBeTrue();
        expect(lstatSync(committedPath).mode & 0o777).toBe(0o600);
        expect(readFileSync(committedPath, "utf8")).toBe("");
        expect(readdirSync(join(committedPath, "..")).filter((name) => name.startsWith(".tmp-"))).toEqual([]);

        await resumed.promptAndWait("CALL_SPAWN", undefined, 20_000);
        expect(decodeStartResult(await resumed.getLastAssistantText()).runId).toMatch(/^[0-9a-f]{8}$/);
        await resumed.promptAndWait("CALL_AWAIT", undefined, 20_000);
      } finally { await resumed.stop(); }
    });
  }, 40_000);

  test("15 parent shutdown kills every real-Pi setsid descendant and removes its cgroup attempt", async () => {
    await withFixture("setsid-parent-shutdown", async ({ client, root }) => {
      const pidPath = join(root, "setsid-pids.json");
      await client.promptAndWait("CALL_SPAWN_TASK|CHILD_SETSID_HANG|||bash", undefined, 20_000);
      const started = decodeStartResult(await client.getLastAssistantText());
      const pids = await waitForRecordedPids(pidPath);
      const parentFile = (await client.getState()).sessionFile;
      expect(parentFile).toBeString();

      await client.stop();

      for (const pid of [pids.launcher, pids.child, pids.detached]) expect(processAbsent(pid)).toBeTrue();
      const launch = lifecycleEntries(SessionManager.open(parentFile!).getEntries()).map(requireJsonRecord)
        .find((event) => event.eventType === "run_launch_requested" && lifecyclePayload(event).agentId === started.agentId);
      expect(launch).toMatchObject({ schemaVersion: 2 });
      const payload = lifecyclePayload(launch);
      const descriptor = requireJsonRecord(payload.containment);
      const receipt = requireJsonRecord(JSON.parse(readFileSync(String(payload.containmentReceiptPath), "utf8")));
      expect(descriptor).toEqual({ backend: "cgroup-v2", scopePath: receipt.scopePath });
      expect(Object.keys(receipt).sort()).toEqual([
        "attemptId", "backend", "outcome", "populated", "scopePath", "timestamp", "version",
      ]);
      expect(receipt).toMatchObject({ version: 2, backend: "cgroup-v2", scopePath: descriptor.scopePath, populated: false });
      expect(existsSync(String(descriptor.scopePath))).toBeFalse();
    }, process.env, ({ root }) => ({
      MOCK_SETSID_FIXTURE_PATH: fileURLToPath(new URL("fixtures/setsid-descendant.mjs", import.meta.url)),
      MOCK_SETSID_PATH: resolveSetsid(),
      MOCK_SETSID_PID_PATH: join(root, "setsid-pids.json"),
    }));
  }, 40_000);

  test("15a unsupported configured root fails before lifecycle launch or Pi child creation", async () => {
    await withFixture("unsupported-cgroup-root", async ({ client, childLaunchDir }) => {
      const launchesBefore = snapshotTree(childLaunchDir);
      await client.promptAndWait("CALL_SPAWN", undefined, 20_000);
      expect(parseContainmentFailedResult(await client.getLastAssistantText())).toEqual({
        code: "containment_failed",
        message: "cgroup-v2 containment is unavailable",
      });
      expect(snapshotTree(childLaunchDir)).toEqual(launchesBefore);
      const events = lifecycleEntries((await client.getEntries()).entries);
      expect(lifecycleEventTypes(events)).not.toContain("run_launch_requested");
    }, process.env, undefined, ({ root, agentDir }) => {
      writeFileSync(join(agentDir, "settings.json"), JSON.stringify({
        defaultProvider: "mock-provider", defaultModel: "mock-model", defaultThinkingLevel: "high",
        subagents: { maxConcurrentRuns: 2, cgroupRoot: join(root, "deliberately-unsupported") },
      }));
    });
  }, 30_000);

  test("15 stop of an unacknowledging child returns after verified containment", async () => {
    await withFixture("bounded-stop", async ({ client }) => {
      await client.promptAndWait("CALL_SPAWN_TASK|CHILD_HANG", undefined, 20_000);
      const started = decodeStartResult(await client.getLastAssistantText());
      const launched = lifecycleEntries((await client.getEntries()).entries)
        .map(lifecyclePayload)
        .find((payload) => payload.agentId === started.agentId && payload.attemptId !== undefined);
      expect(launched).toBeDefined();
      const receiptPath = String(launched!.containmentReceiptPath);
      const attemptId = String(launched!.attemptId);

      const outcome = await Promise.race([
        client.promptAndWait(`CALL_STOP|${started.agentId}`, undefined, 15_000).then(() => "returned" as const),
        Bun.sleep(15_000).then(() => "timed_out" as const),
      ]);

      expect(outcome).toBe("returned");
      const completed = lifecycleEntries((await client.getEntries()).entries).map(lifecyclePayload).at(-1);
      expect(completed).toMatchObject({
        agentId: started.agentId,
        runId: started.runId,
        state: "cancelled",
        reason: "stop_requested",
      });
      expect(String(verifyContainmentReceipt(containmentReceiptPath(receiptPath, receiptPath), testAttemptId(attemptId)).path)).toBe(receiptPath);
      const receipt = JSON.parse(readFileSync(receiptPath, "utf8")) as {
        version: number;
        backend: string;
        populated: boolean;
        scopePath: string;
      };
      expect(Object.keys(receipt).sort()).toEqual([
        "attemptId", "backend", "outcome", "populated", "scopePath", "timestamp", "version",
      ]);
      expect(receipt).toMatchObject({
        version: 2,
        backend: "cgroup-v2",
        populated: false,
        scopePath: expect.stringMatching(/^\//),
      });
      await client.promptAndWait("CALL_AWAIT", undefined, 20_000);
      expect(await client.getLastAssistantText()).toContain(started.runId);
      expect(await client.getLastAssistantText()).toContain("stop_requested");
    });
  }, 40_000);
});

function transcriptToolNames(entries: readonly SessionEntry[]): string[] {
  return entries.flatMap((entry) => entry.type === "message" && entry.message.role === "assistant"
    ? entry.message.content.flatMap((part) => part.type === "toolCall" ? [part.name] : [])
    : []);
}

function transcriptAssistantText(entries: readonly SessionEntry[]): string {
  return entries.flatMap((entry) => entry.type === "message" && entry.message.role === "assistant"
    ? entry.message.content.flatMap((part) => part.type === "text" ? [part.text] : [])
    : []).join("\n");
}

function containsPiCommand(text: string): boolean {
  return text.split("\n").some((line) => /(?:^|[;&|]\s*)(?:\S+\/)?pi(?:\s|$)/i.test(line.trim()));
}

function findChildTranscript(agentDir: string, childId: string): string {
  const state = join(agentDir, "pi-subagents");
  for (const parent of requireDirectoryNames(state)) {
    const sessions = join(state, parent, "sessions");
    for (const name of requireDirectoryNames(sessions)) if (name.includes(childId)) return join(sessions, name);
  }
  throw new Error(`missing child transcript for ${childId}`);
}

function requireDirectoryNames(path: string): string[] {
  return readdirSync(path);
}

interface RealFixture {
  client: RpcClient;
  options: ConstructorParameters<typeof RpcClient>[0] & { args: string[] };
  root: string;
  agentDir: string;
  project: string;
  external: string;
  childLaunchDir: string;
}

async function withFixture(
  name: string,
  run: (fixture: RealFixture) => Promise<void>,
  baseEnvironment: NodeJS.ProcessEnv = process.env,
  childEnvironment?: (paths: Pick<RealFixture, "root" | "agentDir" | "project" | "childLaunchDir">) => NodeJS.ProcessEnv,
  beforeStart?: (paths: Pick<RealFixture, "root" | "agentDir" | "project" | "childLaunchDir">) => void,
): Promise<void> {
  const state = temporaryStateRoot(`pi-real-${name}-`);
  const root: string = state.path;
  const agentDir = join(root, "agent");
  const project = join(root, "project");
  const external = join(root, "external");
  const childLaunchDir = join(root, "child-launches");
  mkdirSync(join(agentDir, "extensions"), { recursive: true });
  mkdirSync(join(agentDir, "skills", "global-skill"), { recursive: true });
  mkdirSync(join(project, ".pi", "skills", "project-skill"), { recursive: true });
  mkdirSync(external);
  mkdirSync(childLaunchDir);
  writeFileSync(join(agentDir, "SYSTEM.md"), "GLOBAL_CONTEXT_MARKER");
  writeFileSync(join(project, "AGENTS.md"), "PROJECT_CONTEXT_MARKER");
  writeFileSync(join(agentDir, "skills", "global-skill", "SKILL.md"), "---\nname: global-skill\ndescription: GLOBAL_SKILL_MARKER\n---\n");
  writeFileSync(join(project, ".pi", "skills", "project-skill", "SKILL.md"), "---\nname: project-skill\ndescription: PROJECT_SKILL_MARKER\n---\n");
  symlinkSync(fileURLToPath(new URL("..", import.meta.url)), join(agentDir, "extensions", "pi-subagents"));
  symlinkSync(fileURLToPath(new URL("fixtures/mock-provider-extension.ts", import.meta.url)), join(agentDir, "extensions", "mock-provider-extension.ts"));
  writeFileSync(join(agentDir, "settings.json"), JSON.stringify({
    defaultProvider: "mock-provider",
    defaultModel: "mock-model",
    defaultThinkingLevel: "high",
    subagents: { maxConcurrentRuns: 2 },
  }));
  const fixturePaths = { root, agentDir, project, childLaunchDir };
  beforeStart?.(fixturePaths);
  const options = {
    cliPath: PI_EXECUTABLE,
    cwd: project,
    env: adaptParentPiEnvironmentForRpcClient(createParentPiEnvironment({
      base: { ...baseEnvironment, ...childEnvironment?.(fixturePaths) },
      agentDir,
      home: root,
      childLaunchDir,
    })), 
    provider: "mock-provider",
    model: "mock-model",
    args: ["--approve", "--offline"],
  };
  const client = new RpcClient(options);
  try {
    await client.start();
    await run({ client, options, root, agentDir, project, external, childLaunchDir });
  } finally {
    await client.stop();
    state.cleanup();
  }
}

async function spawn(client: RpcClient): Promise<{ agentId: string; runId: string }> {
  await client.promptAndWait("CALL_SPAWN", undefined, 20_000);
  const result = decodeStartResult(await client.getLastAssistantText());
  expect(result.agentId).toBeString();
  expect(result.runId).toMatch(/^[0-9a-f]{8}$/);
  return result;
}

interface DecodedStartResult {
  agentId: string;
  runId: string;
  state?: string;
  model?: string;
  thinkingLevel?: string;
  tools?: string[];
  warning?: string;
}

function decodeStartResult(text: string | null | undefined): DecodedStartResult {
  const value: unknown = JSON.parse(text ?? "{}");
  if (!isJsonRecord(value) || typeof value.agentId !== "string" || typeof value.runId !== "string" ||
      value.state !== undefined && typeof value.state !== "string" ||
      value.model !== undefined && typeof value.model !== "string" ||
      value.thinkingLevel !== undefined && typeof value.thinkingLevel !== "string" ||
      value.tools !== undefined && (!Array.isArray(value.tools) || value.tools.some((tool) => typeof tool !== "string")) ||
      value.warning !== undefined && typeof value.warning !== "string") {
    throw new Error(`invalid real-Pi start result: ${text ?? "<none>"}`);
  }
  return {
    agentId: value.agentId,
    runId: value.runId,
    ...(value.state === undefined ? {} : { state: value.state }),
    ...(value.model === undefined ? {} : { model: value.model }),
    ...(value.thinkingLevel === undefined ? {} : { thinkingLevel: value.thinkingLevel }),
    ...(value.tools === undefined ? {} : { tools: value.tools as string[] }),
    ...(value.warning === undefined ? {} : { warning: value.warning }),
  };
}

async function awaitReportedTools(client: RpcClient): Promise<string[]> {
  await client.promptAndWait("CALL_AWAIT", undefined, 20_000);
  const received = parseJsonRecord(await client.getLastAssistantText());
  if (!Array.isArray(received.completions) || received.completions.length !== 1) throw new Error("missing real-Pi completion");
  const completion = requireJsonRecord(received.completions[0]);
  const output = requireJsonRecord(completion.output);
  if (typeof output.text !== "string") throw new Error("missing real-Pi completion output");
  return parseStringArray(output.text);
}

function parseContainmentFailedResult(text: string | null | undefined): { code: "containment_failed"; message: "cgroup-v2 containment is unavailable" } {
  const value = text?.trim();
  const match = /^(containment_failed): (cgroup-v2 containment is unavailable)$/.exec(value ?? "");
  if (match === null) throw new Error(`invalid containment failure result: ${value ?? "<none>"}`);
  return { code: match[1] as "containment_failed", message: match[2] as "cgroup-v2 containment is unavailable" };
}

function parseStringArray(text: string | null | undefined): string[] {
  const values: unknown = JSON.parse(text ?? "[]");
  if (!Array.isArray(values) || values.some((value) => typeof value !== "string")) {
    throw new Error("expected JSON string array");
  }
  return values;
}

function parseJsonRecord(text: string | null | undefined): Record<string, unknown> {
  return requireJsonRecord(JSON.parse(text ?? "{}"));
}

function requireJsonRecord(value: unknown): Record<string, unknown> {
  if (!isJsonRecord(value)) throw new Error("expected JSON object");
  return value;
}

function snapshotTree(root: string): string[] {
  if (!existsSync(root)) return [];
  const result: string[] = [];
  const visit = (path: string, relative: string): void => {
    for (const entry of readdirSync(path, { withFileTypes: true }).sort((left, right) => left.name.localeCompare(right.name))) {
      const childPath = join(path, entry.name);
      const childRelative = relative === "" ? entry.name : join(relative, entry.name);
      const stat = lstatSync(childPath);
      if (stat.isDirectory()) {
        result.push(`d:${childRelative}`);
        visit(childPath, childRelative);
      } else if (stat.isFile()) {
        result.push(`f:${childRelative}:${stat.size}:${hashFile(childPath)}`);
      } else if (stat.isSymbolicLink()) {
        result.push(`l:${childRelative}:${readlinkSync(childPath)}`);
      } else {
        result.push(`o:${childRelative}:${stat.mode}:${stat.size}`);
      }
    }
  };
  visit(root, "");
  return result;
}

function hashFile(path: string): string {
  const hash = createHash("sha256");
  const buffer = Buffer.allocUnsafe(64 * 1024);
  const descriptor = openSync(path, "r");
  try {
    for (let bytesRead = readSync(descriptor, buffer, 0, buffer.length, null); bytesRead > 0;
      bytesRead = readSync(descriptor, buffer, 0, buffer.length, null)) {
      hash.update(buffer.subarray(0, bytesRead));
    }
  } finally {
    closeSync(descriptor);
  }
  return hash.digest("hex");
}

function childLaunchPids(root: string): number[] {
  return readdirSync(root).map((name) => {
    const marker = parseJsonRecord(readFileSync(join(root, name), "utf8"));
    if (typeof marker.pid !== "number") throw new Error("invalid child launch marker");
    return marker.pid;
  });
}

function processAbsent(pid: number): boolean {
  try { process.kill(pid, 0); return false; }
  catch (error) { return (error as NodeJS.ErrnoException).code === "ESRCH"; }
}

function resolveSetsid(): string {
  for (const directory of (process.env.PATH ?? "").split(":")) {
    const candidate = join(directory || ".", "setsid");
    try {
      accessSync(candidate, constants.X_OK);
      const resolved = realpathSync(candidate);
      if (resolved.startsWith("/")) return resolved;
    } catch { /* keep searching PATH */ }
  }
  throw new Error("real-Pi integration prerequisite missing: system setsid executable was not found on PATH");
}

async function waitForRecordedPids(path: string): Promise<{ launcher: number; child: number; detached: number }> {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    if (existsSync(path)) return requireJsonRecord(JSON.parse(readFileSync(path, "utf8"))) as { launcher: number; child: number; detached: number };
    await Bun.sleep(20);
  }
  throw new Error("real-Pi setsid fixture did not record PIDs");
}

function isJsonRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function exactUserEntryId(entries: readonly unknown[], literal: string): string | undefined {
  const matches = entries.flatMap((entry) => {
    if (!isJsonRecord(entry) || entry.type !== "message" || typeof entry.id !== "string" || !isJsonRecord(entry.message) || entry.message.role !== "user") return [];
    const content = entry.message.content;
    if (typeof content === "string") return content === literal ? [entry.id] : [];
    if (!Array.isArray(content)) return [];
    let text = "";
    for (const block of content) {
      if (!isJsonRecord(block) || block.type !== "text" || typeof block.text !== "string") return [];
      text += block.text;
    }
    return text === literal ? [entry.id] : [];
  });
  return matches.length === 1 ? matches[0] : undefined;
}

function lifecycleEntries(entries: readonly { type: string; customType?: string; data?: unknown }[]): unknown[] {
  return entries.filter((entry) => entry.type === "custom" && entry.customType === "pi-subagents:event").map((entry) => entry.data);
}

function lifecycleEventTypes(events: readonly unknown[]): string[] {
  return events.flatMap((event) => {
    if (typeof event !== "object" || event === null || !("eventType" in event)) return [];
    const eventType = event.eventType;
    return typeof eventType === "string" ? [eventType] : [];
  });
}

function lifecyclePayload(event: unknown): Record<string, unknown> {
  if (!isJsonRecord(event) || !isJsonRecord(event.payload)) throw new Error("invalid lifecycle event payload");
  return event.payload;
}

function publishDeferredV2Receipt(parentFile: string, childId: string): void {
  const launches = lifecycleEntries(SessionManager.open(parentFile).getEntries())
    .filter((event) => lifecycleEventTypes([event])[0] === "run_launch_requested")
    .map((event) => ({ event: requireJsonRecord(event), payload: lifecyclePayload(event) }));
  let launch: (typeof launches)[number] | undefined;
  for (let index = launches.length - 1; index >= 0; index--) {
    const candidate = launches[index];
    if (candidate?.payload.agentId === childId) { launch = candidate; break; }
  }
  if (launch === undefined || launch.event.schemaVersion !== 2 || typeof launch.payload.attemptId !== "string" ||
      typeof launch.payload.containmentReceiptPath !== "string" || !isJsonRecord(launch.payload.containment) ||
      launch.payload.containment.backend !== "cgroup-v2" || typeof launch.payload.containment.scopePath !== "string") {
    throw new Error("missing deferred v2 launch evidence");
  }
  writeFileSync(launch.payload.containmentReceiptPath, JSON.stringify({
    version: 2,
    attemptId: launch.payload.attemptId,
    backend: "cgroup-v2",
    scopePath: launch.payload.containment.scopePath,
    outcome: "terminated",
    timestamp: new Date().toISOString(),
    populated: false,
  }), { mode: 0o600 });
}

function removeLifecycleEvents(parentFile: string, childId: string, eventTypes: ReadonlySet<string>): void {
  const lines = readFileSync(parentFile, "utf8").trimEnd().split("\n");
  const retained = lines.map((line) => {
    const entry: unknown = JSON.parse(line);
    if (!isJsonRecord(entry) || entry.type !== "custom" || entry.customType !== "pi-subagents:event" ||
        !isJsonRecord(entry.data) || typeof entry.data.eventType !== "string" || !isJsonRecord(entry.data.payload) ||
        entry.data.payload.agentId !== childId || !eventTypes.has(entry.data.eventType)) return line;
    return JSON.stringify({ ...entry, customType: "pi-subagents:test-suppressed-event", data: null });
  });
  writeFileSync(parentFile, `${retained.join("\n")}\n`);
}

function seedLegacySpawnedModel(parentFile: string, childId: string, provider: string, modelId: string): void {
  const lines = readFileSync(parentFile, "utf8").trimEnd().split("\n");
  const seeded = lines.map((line) => {
    const entry: unknown = JSON.parse(line);
    if (!isJsonRecord(entry) || entry.type !== "custom" || entry.customType !== "pi-subagents:event" ||
        !isJsonRecord(entry.data) || entry.data.eventType !== "spawned" || !isJsonRecord(entry.data.payload) ||
        entry.data.payload.agentId !== childId) return line;
    return JSON.stringify({
      ...entry,
      data: { ...entry.data, payload: { ...entry.data.payload, provider, modelId } },
    });
  });
  writeFileSync(parentFile, `${seeded.join("\n")}\n`);
}


