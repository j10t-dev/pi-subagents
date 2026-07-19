import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, watch, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { PassThrough } from "node:stream";

import { AgentErrorCode, agentId, createRunAttemptId, runId as brandRunId, terminalFailureCause } from "../src/domain.ts";
import type { AgentId, RunId, SessionPath, Usage } from "../src/domain.ts";
import { OutputStore } from "../src/output-store.ts";
import { systemDurableFileSystem, type DurableFileSystem } from "../src/durable-fs.ts";
import { authoritativeSettlement, RpcRunClient } from "../src/rpc-client.ts";
import { UIForwarder } from "../src/ui-forwarder.ts";
import { deferred } from "./support/async.ts";
import type { ExtensionUIContextLike } from "../src/ui-forwarder.ts";

const FIXTURE = join(import.meta.dir, "fixtures", "fake-rpc-child.mjs");
const AGENT: AgentId = agentId("agent-1");

const validUsage: Usage = { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, cacheWrite1h: 1, reasoning: 1, totalTokens: 2,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
const evidenceUsage = validUsage;
const invalidUsageCases = [
  ["negative token", (usage: Usage) => ({ ...usage, input: -1 })],
  ["NaN token", (usage: Usage) => ({ ...usage, output: Number.NaN })],
  ["infinite token", (usage: Usage) => ({ ...usage, cacheRead: Number.POSITIVE_INFINITY })],
  ["negative optional", (usage: Usage) => ({ ...usage, reasoning: -1 })],
  ["missing totalTokens", (usage: Usage) => { const { totalTokens: _removed, ...rest } = usage; return rest; }],
  ["missing cost field", (usage: Usage) => { const { cacheWrite: _removed, ...cost } = usage.cost; return { ...usage, cost }; }],
] as const;

describe("authoritativeSettlement", () => {
  test.each(invalidUsageCases)("rejects shared invalid usage: %s", (_label, mutate) => {
    expect(authoritativeSettlement([{ type: "message", message: { role: "assistant", stopReason: "stop", usage: mutate(validUsage), content: [] } }])).toEqual({ kind: "invalid" });
  });

  test("accepts the shared valid usage fixture", () => {
    expect(authoritativeSettlement([{ type: "message", message: { role: "assistant", stopReason: "stop", usage: validUsage, content: [] } }])).toMatchObject({ kind: "found" });
  });

  const assistant = (overrides: Record<string, unknown> = {}) => ({
    type: "message",
    message: { role: "assistant", stopReason: "stop", usage: evidenceUsage, content: [], ...overrides },
  });
  const result = (id: string, isError = false) => ({ type: "message", message: { role: "toolResult", toolCallId: id, isError } });

  test("returns found evidence for a valid assistant with completed tools", () => {
    const toolAssistant = assistant({ stopReason: "toolUse", content: [{ type: "toolCall", id: "call-1" }] });
    expect(authoritativeSettlement([toolAssistant, result("call-1")])).toMatchObject({ kind: "found", evidence: { toolSequenceCompleted: true } });
  });

  test("returns absent when no assistant evidence exists", () => {
    expect(authoritativeSettlement([result("call-1")])).toEqual({ kind: "absent" });
  });

  test("returns invalid for an assistant with negative usage", () => {
    expect(authoritativeSettlement([assistant({ usage: { ...evidenceUsage, input: -1 } })])).toEqual({ kind: "invalid" });
  });

  test("returns invalid rather than earlier valid evidence when a later assistant is malformed", () => {
    expect(authoritativeSettlement([assistant(), assistant({ usage: { ...evidenceUsage, input: -1 } })])).toEqual({ kind: "invalid" });
  });

  test("ignores malformed non-assistant messages", () => {
    expect(authoritativeSettlement([{ type: "message", message: { role: "user", usage: { input: -1 } } }, assistant()])).toMatchObject({ kind: "found" });
  });

  test("accepts valid optional usage fields", () => {
    expect(authoritativeSettlement([assistant({ usage: { ...evidenceUsage, cacheWrite1h: 2, reasoning: 3 } })])).toMatchObject({ kind: "found" });
  });

  test("matches every final assistant tool call only to later tool results", () => {
    const toolAssistant = (ids: string[]) => ({ type: "message", message: { role: "assistant", stopReason: "toolUse", usage: evidenceUsage,
      content: ids.map((id) => ({ type: "toolCall", id })) } });
    expect(authoritativeSettlement([toolAssistant(["old"]), toolAssistant(["a", "b"]), result("a"), result("b", true)])).toMatchObject({ kind: "found", evidence: { toolSequenceCompleted: true } });
    expect(authoritativeSettlement([result("a"), toolAssistant(["a", "b"]), result("a")])).toMatchObject({ kind: "found", evidence: { toolSequenceCompleted: false } });
    expect(authoritativeSettlement([toolAssistant([])])).toMatchObject({ kind: "found", evidence: { toolSequenceCompleted: true } });
  });
});

function failingDirectorySyncFileSystem(directory: string, failureNumber: number): DurableFileSystem {
  const directories = new Set<number>();
  let directorySyncs = 0;
  return {
    ...systemDurableFileSystem,
    open(path, flags, mode) {
      const fd = systemDurableFileSystem.open(path, flags, mode);
      if (path === directory) directories.add(fd);
      return fd;
    },
    sync(fd) {
      if (directories.has(fd) && ++directorySyncs === failureNumber) throw new Error(`sensitive path ${directory}`);
      systemDurableFileSystem.sync(fd);
    },
    close(fd) { directories.delete(fd); systemDurableFileSystem.close(fd); },
  };
}

class ReentrantDiscardOutputStore extends OutputStore {
  onDiscard: (() => void) | undefined;
  discardCalls = 0;

  override discardPartial(id: Parameters<OutputStore["discardPartial"]>[0]): void {
    this.discardCalls++;
    this.onDiscard?.();
    super.discardPartial(id);
  }
}


function makeClient(
  scenario: string,
  workDir: string,
  uiOverrides: Partial<ExtensionUIContextLike> = {},
  command = process.execPath,
  envOverrides: NodeJS.ProcessEnv = {},
  sharedForwarder?: UIForwarder,
  owner: AgentId = AGENT,
) {
  const outputStore = new OutputStore({ workDir });
  const forwarder = sharedForwarder ?? new UIForwarder({
    hasUI: true,
    ui: {
      select: async () => undefined,
      confirm: async () => true,
      input: async () => undefined,
      editor: async () => undefined,
      notify: () => {},
      setStatus: () => {},
      setWidget: () => {},
      ...uiOverrides,
    },
  });
  const client = new RpcRunClient({
    launchTransport: async () => {
      const child = spawn(command, [FIXTURE], { cwd: workDir, env: { ...process.env, FAKE_RPC_SCENARIO: scenario, ...envOverrides }, stdio: ["pipe", "pipe", "pipe"] });
      await new Promise<void>((resolve, reject) => { child.once("spawn", resolve); child.once("error", reject); });
      return { stdin: child.stdin, stdout: child.stdout, stderr: child.stderr, exited: new Promise((resolve) => child.once("exit", (code, signal) => resolve({ code, signal }))), terminate: () => { child.kill(); } };
    },
    outputStore,
    uiForwarder: forwarder,
    agentId: owner,
    runAttemptId: createRunAttemptId(),
  });
  return { client, outputStore };
}

describe("RpcRunClient", () => {
  let workDir: string;

  beforeEach(() => {
    workDir = mkdtempSync(join(tmpdir(), "rpc-client-test-"));
  });

  afterEach(() => {
    rmSync(workDir, { recursive: true, force: true });
  });

  test("issues unique, non-empty request IDs across commands", async () => {
    const { client } = makeClient("normal", workDir);
    client.start();
    const [a, b] = await Promise.all([client.getEntries(), client.getEntries()]);
    expect(a).toBeDefined();
    expect(b).toBeDefined();
    await client.shutdown();
  });

  test("rejects a sequential repeated start while retaining control of the first child", async () => {
    const launchMarker = join(workDir, "launches");
    const { client } = makeClient("normal", workDir, {}, process.execPath, { FAKE_RPC_LAUNCH_MARKER: launchMarker });
    client.start();

    expect(() => client.start()).toThrow(/already been started/);
    await expect(client.getEntries()).resolves.toEqual({ entries: [], leafId: null });
    expect(readFileSync(launchMarker, "utf8")).toBe("started\n");
    await client.shutdown();
  });

  test("rejects start after shutdown without spawning or mutating output", async () => {
    const launchMarker = join(workDir, "launches");
    const { client } = makeClient("normal", workDir, {}, process.execPath, { FAKE_RPC_LAUNCH_MARKER: launchMarker });
    await client.shutdown();
    const outputFilesAfterShutdown = readdirSync(workDir);

    expect(() => client.start()).toThrow(/invalid_state.*shut down/);
    await Bun.sleep(50);

    expect(readdirSync(workDir)).toEqual(outputFilesAfterShutdown);
    expect(() => readFileSync(launchMarker, "utf8")).toThrow();
  });

  test("permits only one of two concurrent start attempts and retains one child", async () => {
    const launchMarker = join(workDir, "launches");
    const { client } = makeClient("normal", workDir, {}, process.execPath, { FAKE_RPC_LAUNCH_MARKER: launchMarker });

    const results = await Promise.allSettled([
      Promise.resolve().then(() => client.start()),
      Promise.resolve().then(() => client.start()),
    ]);

    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((result) => result.status === "rejected")).toHaveLength(1);
    await expect(client.getEntries()).resolves.toEqual({ entries: [], leafId: null });
    expect(readFileSync(launchMarker, "utf8")).toBe("started\n");
    await client.shutdown();
  });

  test("correlates out-of-order responses to the correct pending request", async () => {
    const { client } = makeClient("normal", workDir);
    client.start();
    const results = await Promise.all([client.getEntries(), client.getEntries(), client.getEntries()]);
    for (const result of results) {
      expect(result.entries).toEqual([]);
    }
    await client.shutdown();
  });

  test("rejects the caller's promise on command failure", async () => {
    const { client } = makeClient("normal", workDir);
    client.start();
    await expect(client.getEntries("force-fail")).rejects.toThrow(/Entry not found/);
    await client.shutdown();
  });

  test("prompt resolves once the child acknowledges receipt", async () => {
    const { client } = makeClient("normal", workDir);
    client.start();
    await expect(client.prompt("hello")).resolves.toBeUndefined();
    const settled = await client.waitSettled();
    expect(settled).toMatchObject({ reason: "agent_settled", stopReason: "stop" });
    await client.shutdown();
  });

  test.each(["agent-start-before-ack", "agent-start-after-ack"])(
    "latches agent_start in %s ordering",
    async (scenario) => {
      const { client } = makeClient(scenario, workDir);
      await client.start();
      await client.prompt("literal");
      await expect(client.waitForAgentStart()).resolves.toBeUndefined();
      await expect(client.waitForAgentStart()).resolves.toBeUndefined();
      await client.shutdown();
    },
  );

  test("releases an outstanding agent_start waiter on shutdown", async () => {
    const { client } = makeClient("pending-command", workDir);
    await client.start();
    const waiting = client.waitForAgentStart();
    await client.shutdown();
    await expect(waiting).rejects.toThrow(/shut down|exited/);
  });

  test("uses an injected launch transport without mutating model defaults through RPC", async () => {
    const marker = join(workDir, "commands");
    const outputStore = new OutputStore({ workDir });
    const forwarder = new UIForwarder({ hasUI: false, ui: { select: async () => undefined, confirm: async () => false, input: async () => undefined, editor: async () => undefined, notify: () => {}, setStatus: () => {}, setWidget: () => {} } });
    const child = spawn(process.execPath, [FIXTURE], { cwd: workDir, env: { ...process.env, FAKE_RPC_COMMAND_MARKER: marker }, stdio: ["pipe", "pipe", "pipe"] });
    let launches = 0;
    const client = new RpcRunClient({
      launchTransport: async () => { launches++; return { stdin: child.stdin, stdout: child.stdout, stderr: child.stderr, exited: new Promise((resolve) => child.once("exit", (code, signal) => resolve({ code, signal }))), terminate: () => { child.kill(); } }; },
      outputStore, uiForwarder: forwarder, agentId: AGENT, runAttemptId: createRunAttemptId(),
    });
    client.start();
    await client.prompt("hello");
    expect(launches).toBe(1);
    expect(readFileSync(marker, "utf8")).toBe("prompt:hello\n");
    await client.shutdown();
  });

  test("get_entries returns entries and a leaf cursor", async () => {
    const { client } = makeClient("normal", workDir);
    client.start();
    const result = await client.getEntries();
    expect(result).toEqual({ entries: [], leafId: null });
    await client.shutdown();
  });

  test("agent_settled resolves waitSettled with the sole normal run boundary", async () => {
    const { client } = makeClient("normal", workDir);
    client.start();
    await client.prompt("hello");
    const settled = await client.waitSettled();
    expect(settled).toMatchObject({ reason: "agent_settled", stopReason: "stop" });
    await client.shutdown();
  });

  for (const [scenario, expected] of [
    ["settled-error", { stopReason: "error", failureCause: terminalFailureCause(AgentErrorCode.ProtocolError) }],
    ["settled-length", { stopReason: "length" }],
    ["settled-aborted", { stopReason: "aborted", failureCause: terminalFailureCause(AgentErrorCode.RunInterrupted) }],
    ["incomplete-tool-use", { stopReason: "toolUse", toolSequenceCompleted: false, failureCause: terminalFailureCause(AgentErrorCode.RunInterrupted) }],
  ] as const) test(`uses authoritative session evidence for ${scenario}`, async () => {
    const { client } = makeClient(scenario, workDir);
    client.start(); await client.prompt("hello");
    await expect(client.waitSettled()).resolves.toMatchObject({ reason: "agent_settled", ...expected });
    await client.shutdown();
  });

  test("process exit before settlement resolves waitSettled with process_exited", async () => {
    const { client } = makeClient("crash", workDir);
    client.start();
    await client.prompt("hello");
    const settled = await client.waitSettled();
    expect(settled).toMatchObject({ reason: "process_exited", failureCause: terminalFailureCause(AgentErrorCode.ProcessExited) });
    await client.shutdown();
    expect(readdirSync(workDir).filter((name) => name.endsWith(".candidate"))).toEqual([]);
  });

  test("a run can still bind to an empty sidecar after an unbound partial candidate is discarded on exit", async () => {
    const runId: RunId = brandRunId("aaaaaaaa");
    const { client, outputStore } = makeClient("crash", workDir);
    client.start();
    await client.prompt("hello");
    await client.waitSettled();
    client.bindRun(runId);
    expect(outputStore.currentOutput(runId)).toEqual({ output: expect.objectContaining({ text: "" }), transportIncomplete: true });
    await client.shutdown();
  });

  test("commands issued after process exit reject immediately", async () => {
    const { client } = makeClient("crash", workDir);
    client.start();
    await client.prompt("hello");
    await client.waitSettled();
    await expect(client.getEntries()).rejects.toThrow(/terminated|exited/);
    await client.shutdown();
  });

  test("native abort is acknowledged and the run still settles via agent_settled", async () => {
    const { client } = makeClient("abort", workDir);
    client.start();
    await client.prompt("hello");
    await expect(client.abort()).resolves.toBeUndefined();
    const settled = await client.waitSettled();
    expect(settled).toMatchObject({ reason: "agent_settled", stopReason: "error" });
    await client.shutdown();
  });

  test("retains a bounded stderr tail without crashing", async () => {
    const { client, outputStore } = makeClient("stderr-flood", workDir);
    client.start();
    await client.prompt("hello");
    await client.waitSettled();
    const tail = outputStore.getStderrTail();
    expect(new TextEncoder().encode(tail).byteLength).toBeLessThanOrEqual(50_000);
    await client.shutdown();
  });

  test("retains the newest UTF-8-safe 50 KB suffix from one oversized stderr chunk", async () => {
    const { client, outputStore } = makeClient("stderr-single-chunk", workDir);
    client.start();
    await client.prompt("hello");
    await client.waitSettled();
    const tail = outputStore.getStderrTail();
    expect(new TextEncoder().encode(tail).byteLength).toBeLessThanOrEqual(50_000);
    expect(tail.endsWith("NEWEST-STDERR-END")).toBe(true);
    expect(tail.includes("OLDEST-STDERR-START")).toBe(false);
    expect(tail).not.toContain("�");
    await client.shutdown();
  });

  test("malformed required events contain the transport before settlement", async () => {
    const { client } = makeClient("malformed", workDir);
    client.start();
    await client.prompt("hello");
    const settled = await client.waitSettled();
    expect(settled).toEqual({ reason: "process_exited", code: null, signal: null, failureCause: terminalFailureCause(AgentErrorCode.ProtocolError) });
    await client.shutdown();
  });

  test("an oversized ordinary record is discarded and settlement continues", async () => {
    const runId: RunId = brandRunId("aaaaaaaa");
    const { client, outputStore } = makeClient("oversized", workDir);
    client.start();
    client.bindRun(runId);
    await client.prompt("hello");
    const settled = await client.waitSettled();
    expect(settled).toMatchObject({ reason: "agent_settled", stopReason: "stop" });
    expect(outputStore.currentOutput(runId).transportIncomplete).toBe(false);
    await client.shutdown();
  });

  test("an oversized Pi message_update is discarded through LF and recovered authoritatively", async () => {
    const runId: RunId = brandRunId("aaaaaaaa");
    const { client, outputStore } = makeClient("oversized-message-update", workDir);
    client.start();
    client.bindRun(runId);
    await client.prompt("hello");

    await expect(client.waitSettled()).resolves.toMatchObject({ reason: "agent_settled", stopReason: "stop" });
    expect(outputStore.currentOutput(runId)).toEqual({
      output: expect.objectContaining({ text: "authoritative recovered output" }),
      transportIncomplete: false,
    });
    expect(outputStore.getDiagnosticsTail()).toContain("recovery_needed: oversized rpc record");
    await client.shutdown();
  });

  test.each(["missing", "overlong", "truncated", "unidentified"])(
    "an oversized %s-correlation response rejects pending work and contains the transport",
    async (kind) => {
      const { client } = makeClient(`oversized-response-${kind}`, workDir);
      client.start();
      await expect(client.getEntries()).rejects.toThrow(/protocol_error/);
      await expect(client.getEntries()).rejects.toThrow(/exited|terminated|protocol_error/);
      await expect(client.waitSettled()).resolves.toEqual({ reason: "process_exited", code: null, signal: null, failureCause: terminalFailureCause(AgentErrorCode.ProtocolError) });
      await client.shutdown();
    },
  );

  test("a known correlated oversized response rejects only that request and transport remains usable", async () => {
    const { client } = makeClient("oversized-response-known", workDir);
    client.start();
    await expect(client.getEntries()).rejects.toThrow(/oversized get_entries response/);
    await expect(client.getEntries()).resolves.toEqual({ entries: [], leafId: null });
    await client.shutdown();
  });

  test("an irrelevant malformed ordinary record does not hide later authoritative settlement", async () => {
    const { client } = makeClient("malformed-ordinary", workDir);
    client.start(); await client.prompt("hello");
    await expect(client.waitSettled()).resolves.toMatchObject({ reason: "agent_settled", stopReason: "stop" });
    await client.shutdown();
  });

  test("routes text_delta into the bound OutputStore run and settles with the final text", async () => {
    const runId: RunId = brandRunId("aaaaaaaa");
    const { client, outputStore } = makeClient("normal", workDir);
    client.start();
    client.bindRun(runId);
    await client.prompt("hello");
    await client.waitSettled();
    expect(outputStore.currentOutput(runId).output.text).toBe("hello world");
    expect(outputStore.currentOutput(runId).transportIncomplete).toBe(false);
    await client.shutdown();
  });

  test("a poisoned text_end reaches neither current output, committed output, diagnostics nor settlement", async () => {
    const runId: RunId = brandRunId("aaaaaaaa");
    const { client, outputStore: store } = makeClient("poison-text-end", workDir);
    client.start();
    client.bindRun(runId);
    await client.prompt("hello");

    await expect(client.waitSettled()).resolves.toEqual({ reason: "agent_settled", stopReason: "stop" });
    expect(store.currentOutput(runId).output.text).toBe("authoritative final");
    expect(readFileSync(store.restoreRun(runId), "utf8")).toBe("authoritative final");
    expect(store.currentOutput(runId).output.text).not.toContain("POISONED");
    expect(store.getDiagnosticsTail()).not.toContain("POISONED");
    await client.shutdown();
  });

  test("promotes message boundaries and text deltas received before binding", async () => {
    const runId: RunId = brandRunId("aaaaaaaa");
    const { client, outputStore } = makeClient("normal", workDir);
    client.start();
    await client.prompt("hello");
    await client.waitSettled();
    client.bindRun(runId);
    expect(outputStore.currentOutput(runId)).toEqual({ output: expect.objectContaining({ text: "hello world" }), transportIncomplete: false });
    await client.shutdown();
  });

  test("preserves finalised pre-bind output through shutdown after settlement", async () => {
    const runId: RunId = brandRunId("aaaaaaaa");
    const { client, outputStore } = makeClient("normal", workDir);
    client.start();
    await client.prompt("hello");
    await client.waitSettled();
    await client.shutdown();

    client.bindRun(runId);

    expect(outputStore.currentOutput(runId)).toEqual({
      output: expect.objectContaining({ text: "hello world" }),
      transportIncomplete: false,
    });
  });

  test("preserves finalised pre-bind output through natural exit after settlement", async () => {
    const runId: RunId = brandRunId("aaaaaaaa");
    const { client, outputStore } = makeClient("settled-exit", workDir);
    client.start();
    await client.prompt("hello");
    await client.waitSettled();
    await Bun.sleep(50);

    client.bindRun(runId);

    expect(outputStore.currentOutput(runId)).toEqual({
      output: expect.objectContaining({ text: "hello world" }),
      transportIncomplete: false,
    });
    await client.shutdown();
  });

  test("failed repeated binds retain the original binding for later events and cleanup", async () => {
    const originalRunId: RunId = brandRunId("aaaaaaaa");
    const differentRunId: RunId = brandRunId("bbbbbbbb");
    const { client, outputStore } = makeClient("delayed-protocol-loss", workDir);
    client.start();
    client.bindRun(originalRunId);

    expect(() => client.bindRun(originalRunId)).toThrow(/invalid_state/);
    expect(() => client.bindRun(differentRunId)).toThrow(/invalid_state/);

    await client.prompt("hello");
    await client.waitSettled();
    await client.shutdown();
    expect(outputStore.currentOutput(originalRunId)).toEqual({
      output: expect.objectContaining({ text: "original binding" }),
      transportIncomplete: true,
    });
    expect(() => outputStore.currentOutput(differentRunId)).toThrow(/unknown or unbound/);
  });

  test("a store-level bind failure does not mutate the client binding", async () => {
    const occupiedRunId: RunId = brandRunId("aaaaaaaa");
    const clientRunId: RunId = brandRunId("bbbbbbbb");
    const { client, outputStore } = makeClient("normal", workDir);
    const occupyingAttempt = createRunAttemptId();
    outputStore.beginAttempt(occupyingAttempt);
    outputStore.bindRun(occupyingAttempt, occupiedRunId);
    client.start();

    expect(() => client.bindRun(occupiedRunId)).toThrow(/already bound/);
    client.bindRun(clientRunId);
    await client.prompt("hello");
    await client.waitSettled();
    await client.shutdown();

    expect(outputStore.currentOutput(clientRunId).output.text).toBe("hello world");
    expect(outputStore.currentOutput(occupiedRunId).output.text).toBe("");
  });

  test("contains candidate-read failure after ownership transfer with aligned run identity", async () => {
    const runId: RunId = brandRunId("aaaaaaaa");
    let failCandidateRead = true;
    const outputStore = new OutputStore({
      workDir,
      durableFileSystem: {
        ...systemDurableFileSystem,
        readFile(path) {
          if (failCandidateRead && path.endsWith(".candidate")) {
            failCandidateRead = false;
            throw new Error(`sensitive candidate path ${path}`);
          }
          return systemDurableFileSystem.readFile(path);
        },
      },
    });
    const stdout = new PassThrough();
    let terminated = 0;
    const client = new RpcRunClient({
      launchTransport: async () => ({
        stdin: new PassThrough(), stdout, stderr: new PassThrough(), exited: new Promise(() => {}),
        terminate: () => { terminated++; },
      }),
      outputStore,
      uiForwarder: new UIForwarder({ hasUI: false, ui: { select: async () => undefined, confirm: async () => false, input: async () => undefined, editor: async () => undefined, notify: () => {}, setStatus: () => {}, setWidget: () => {} } }),
      agentId: AGENT,
      runAttemptId: createRunAttemptId(),
    });
    await client.start();
    stdout.write(`${JSON.stringify({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "candidate" }], usage: evidenceUsage, stopReason: "stop" } })}\n`);

    expect(() => client.bindRun(runId)).toThrow("local output publication failed");
    expect(outputStore.currentOutput(runId)).toEqual({
      output: expect.objectContaining({ text: "" }),
      transportIncomplete: true,
    });
    expect(outputStore.getDiagnosticsTail()).toBe("local_output_error: authoritative output publication failed\n");
    expect(outputStore.getDiagnosticsTail()).not.toContain(workDir);
    await expect(client.waitSettled()).resolves.toMatchObject({ reason: "process_exited" });
    await expect(client.shutdown()).resolves.toBeUndefined();
    expect(terminated).toBe(1);

    const transcriptPath = join(workDir, "candidate-read-session.jsonl") as SessionPath;
    writeFileSync(transcriptPath,
      `${JSON.stringify({ type: "message", id: runId, message: { role: "user" } })}\n` +
      `${JSON.stringify({ type: "message", id: "assistant", message: { role: "assistant", content: [{ type: "text", text: "authoritative" }] } })}\n`);
    const durable = outputStore.ensureDurable(runId, transcriptPath);
    expect(durable.output.text).toBe("authoritative");
    expect(typeof durable.committedPath).toBe("string");
    expect(String(durable.committedPath)).toBe(join(workDir, `${runId}.committed`));
  });

  test("retains aligned run identity when initial output publication fails", async () => {
    const runId: RunId = brandRunId("aaaaaaaa");
    const outputStore = new OutputStore({ workDir, durableFileSystem: failingDirectorySyncFileSystem(workDir, 1) });
    const stdout = new PassThrough();
    let terminated = 0;
    const client = new RpcRunClient({
      launchTransport: async () => ({ stdin: new PassThrough(), stdout, stderr: new PassThrough(), exited: new Promise(() => {}), terminate: () => { terminated++; } }),
      outputStore,
      uiForwarder: new UIForwarder({ hasUI: false, ui: { select: async () => undefined, confirm: async () => false, input: async () => undefined, editor: async () => undefined, notify: () => {}, setStatus: () => {}, setWidget: () => {} } }),
      agentId: AGENT,
      runAttemptId: createRunAttemptId(),
    });
    await client.start();
    expect(() => client.bindRun(runId)).toThrow("local output publication failed");
    expect(outputStore.currentOutput(runId).transportIncomplete).toBe(true);
    await client.shutdown();
    expect(terminated).toBe(1);
  });

  test("contains committed publication failure at dispatch and ignores later assistant output", async () => {
    const runId: RunId = brandRunId("aaaaaaaa");
    const outputStore = new OutputStore({ workDir, durableFileSystem: failingDirectorySyncFileSystem(workDir, 2) });
    const stdout = new PassThrough();
    let terminated = 0;
    const client = new RpcRunClient({
      launchTransport: async () => ({ stdin: new PassThrough(), stdout, stderr: new PassThrough(), exited: new Promise(() => {}), terminate: () => { terminated++; } }),
      outputStore,
      uiForwarder: new UIForwarder({ hasUI: false, ui: { select: async () => undefined, confirm: async () => false, input: async () => undefined, editor: async () => undefined, notify: () => {}, setStatus: () => {}, setWidget: () => {} } }),
      agentId: AGENT,
      runAttemptId: createRunAttemptId(),
    });
    await client.start();
    client.bindRun(runId);
    const event = (text: string) => `${JSON.stringify({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text }], usage: evidenceUsage, stopReason: "stop" } })}\n`;
    expect(() => stdout.write(event("first"))).not.toThrow();
    stdout.write(event("second"));
    await expect(client.waitSettled()).resolves.toMatchObject({ reason: "process_exited" });
    expect(terminated).toBe(1);
    expect(outputStore.currentOutput(runId)).toEqual({ output: expect.objectContaining({ text: "" }), transportIncomplete: true });
    expect(outputStore.getDiagnosticsTail()).toBe("local_output_error: authoritative output publication failed\n");
    expect(outputStore.getDiagnosticsTail()).not.toContain(workDir);
  });

  test("linearises local-output failure before synchronous termination re-enters dispatch", async () => {
    const runId: RunId = brandRunId("aaaaaaaa");
    const outputStore = new ReentrantDiscardOutputStore({ workDir, durableFileSystem: failingDirectorySyncFileSystem(workDir, 2) });
    const stdout = new PassThrough();
    let terminated = 0;
    const event = (text: string) => `${JSON.stringify({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text }], usage: evidenceUsage, stopReason: "stop" } })}\n`;
    const client = new RpcRunClient({
      launchTransport: async () => ({
        stdin: new PassThrough(), stdout, stderr: new PassThrough(), exited: new Promise(() => {}),
        terminate: () => { terminated++; },
      }),
      outputStore,
      uiForwarder: new UIForwarder({ hasUI: false, ui: { select: async () => undefined, confirm: async () => false, input: async () => undefined, editor: async () => undefined, notify: () => {}, setStatus: () => {}, setWidget: () => {} } }),
      agentId: AGENT,
      runAttemptId: createRunAttemptId(),
    });
    await client.start();
    client.bindRun(runId);
    const dispatchData = stdout.listeners("data")[0] as (chunk: Buffer) => void;
    outputStore.onDiscard = () => dispatchData(Buffer.from(event("re-entered")));

    stdout.write(event("first"));
    await expect(client.waitSettled()).resolves.toMatchObject({ reason: "process_exited" });
    await client.shutdown();

    expect(outputStore.discardCalls).toBe(1);
    expect(terminated).toBe(1);
    expect(outputStore.getDiagnosticsTail()).toBe("local_output_error: authoritative output publication failed\n");
    expect(outputStore.currentOutput(runId)).toEqual({
      output: expect.objectContaining({ text: "" }),
      transportIncomplete: true,
    });
  });

  test("protocol loss marks a previously finalised output transport-incomplete", async () => {
    const runId: RunId = brandRunId("aaaaaaaa");
    const { client, outputStore } = makeClient("protocol-loss", workDir);
    client.start(); client.bindRun(runId); await client.prompt("hello"); await client.waitSettled();
    expect(outputStore.currentOutput(runId).transportIncomplete).toBe(true);
    await client.shutdown();
  });

  test("process exit rejects pending commands and resolves settlement once", async () => {
    const { client } = makeClient("pending-command", workDir);
    client.start();
    const pending = client.getEntries();
    const settled = client.waitSettled();
    await client.shutdown();
    await expect(pending).rejects.toThrow(/terminated|shut down/);
    expect((await settled).reason).toBe("process_exited");
  });

  test("spawn error rejects pending commands and resolves settlement", async () => {
    const { client } = makeClient("normal", workDir, {}, join(workDir, "missing-executable"));
    client.start();
    const pending = client.getEntries();
    const settled = client.waitSettled();
    await expect(pending).rejects.toThrow(/terminated|ENOENT/);
    expect((await settled).reason).toBe("process_exited");
    await client.shutdown();
  });

  test("shutdown resolves all waitSettled callers exactly once", async () => {
    const { client } = makeClient("pending-command", workDir);
    client.start();
    const a = client.waitSettled(); const b = client.waitSettled();
    await client.shutdown();
    expect(await a).toEqual(await b);
    expect((await client.waitSettled()).reason).toBe("process_exited");
  });

  test("forwards a real extension_ui_request and sends back the correlated response", async () => {
    const marker = join(workDir, "ui-commands");
    const { client } = makeClient("ui", workDir, { confirm: async () => true }, process.execPath, {
      FAKE_RPC_COMMAND_MARKER: marker,
    });
    client.start();
    await client.prompt("hello");
    const settled = await client.waitSettled();
    expect(settled).toMatchObject({ reason: "agent_settled", stopReason: "stop" });
    expect(readFileSync(marker, "utf8")).toContain(
      'extension_ui_response:{"type":"extension_ui_response","id":"ui-request-1","confirmed":true}',
    );
    await client.shutdown();
  });

  test("forwards extension_ui notifications without responses", async () => {
    const marker = join(workDir, "notification-commands");
    const calls: string[] = [];
    const { client } = makeClient("ui-notifications", workDir, {
      notify: (message) => calls.push(message),
      setStatus: (_key, text) => calls.push(`status:${text}`),
      setWidget: (_key, lines) => calls.push(`widget:${lines?.join(",")}`),
    }, process.execPath, { FAKE_RPC_COMMAND_MARKER: marker });
    client.start();
    await client.prompt("hello");
    await expect(client.waitSettled()).resolves.toMatchObject({ reason: "agent_settled", stopReason: "stop" });
    expect(calls).toEqual(["[agent-1] done", "status:running", "widget:one", "status:undefined", "widget:undefined"]);
    expect(readFileSync(marker, "utf8")).not.toContain("extension_ui_response");
    await client.shutdown();
  });

  for (const [boundary, scenario, finish] of [
    ["natural settlement", "ui-resource-settled", async (client: RpcRunClient) => { await client.waitSettled(); }],
    ["abort", "ui-resource-abort", async (client: RpcRunClient) => { await client.abort(); }],
    ["process exit", "ui-resource-crash", async (client: RpcRunClient) => { await client.waitSettled(); }],
    ["malformed-record transport failure", "ui-resource-malformed", async (client: RpcRunClient) => { await client.waitSettled(); }],
    ["shutdown", "ui-resource-pending", async (client: RpcRunClient) => { await client.shutdown(); }],
  ] as const) test(`${boundary} clears derived status and widget keys`, async () => {
    const statuses: Array<[string, string | undefined]> = [];
    const widgets: Array<[string, string[] | undefined]> = [];
    const resourcesReady = deferred<void>();
    const { client } = makeClient(scenario, workDir, {
      setStatus: (key, text) => statuses.push([key, text]),
      setWidget: (key, lines) => { widgets.push([key, lines]); if (lines !== undefined) resourcesReady.resolve(); },
    });
    const statusKey = expectedParentKey(AGENT, "build");
    const widgetKey = expectedParentKey(AGENT, "jobs");

    client.start();
    await client.prompt("hello");
    await resourcesReady.promise;
    await finish(client);

    expect(statuses).toEqual([[statusKey, "running"], [statusKey, undefined]]);
    expect(widgets).toEqual([[widgetKey, ["one"]], [widgetKey, undefined]]);
    await client.shutdown();
  });

  test("a malformed notification fails the protocol, terminates transport, and does not call parent UI", async () => {
    const stdin = new PassThrough();
    const stdout = new PassThrough();
    const stderr = new PassThrough();
    const calls: string[] = [];
    let terminated = false;
    const forwarder = new UIForwarder({ hasUI: true, ui: {
      select: async () => undefined, confirm: async () => false, input: async () => undefined, editor: async () => undefined,
      notify: () => calls.push("notify"), setStatus: () => calls.push("status"), setWidget: () => calls.push("widget"),
    } });
    const client = new RpcRunClient({
      launchTransport: async () => ({ stdin, stdout, stderr, exited: new Promise(() => {}), terminate: () => { terminated = true; } }),
      outputStore: new OutputStore({ workDir }), uiForwarder: forwarder, agentId: AGENT, runAttemptId: createRunAttemptId(),
    });

    await client.start();
    stdout.write(`${JSON.stringify({ type: "extension_ui_request", id: "bad-widget", method: "setWidget", widgetKey: "jobs", widgetLines: [1] })}\n`);

    await expect(client.waitSettled()).resolves.toEqual({ reason: "process_exited", code: null, signal: null, failureCause: terminalFailureCause(AgentErrorCode.ProtocolError) });
    expect(terminated).toBeTrue();
    expect(calls).toEqual([]);
    await client.shutdown();
  });

  test("two clients sharing a broker serialise extension_ui and receive correlated responses", async () => {
    const firstEntered = deferred<void>();
    const releaseFirst = deferred<void>();
    const titles: string[] = [];
    const broker = new UIForwarder({ hasUI: true, ui: {
      notify: () => {}, setStatus: () => {}, setWidget: () => {},
      select: async () => undefined,
      confirm: async (title) => {
        titles.push(title);
        if (titles.length === 1) { firstEntered.resolve(); await releaseFirst.promise; }
        return true;
      },
      input: async () => undefined,
      editor: async () => undefined,
    } });
    const markerA = join(workDir, "ui-a");
    const markerB = join(workDir, "ui-b");
    const { client: clientA } = makeClient("ui", workDir, {}, process.execPath,
      { FAKE_RPC_COMMAND_MARKER: markerA }, broker, agentId("agent-a"));
    const { client: clientB } = makeClient("ui", workDir, {}, process.execPath,
      { FAKE_RPC_COMMAND_MARKER: markerB }, broker, agentId("agent-b"));

    try {
      await Promise.all([clientA.start(), clientB.start()]);
      await clientA.prompt("a");
      await firstEntered.promise;
      await clientB.prompt("b");
      expect(titles).toEqual(["[agent-a] Confirm?"]);
      releaseFirst.resolve();
      await Promise.all([clientA.waitSettled(), clientB.waitSettled()]);
      expect(titles).toEqual(["[agent-a] Confirm?", "[agent-b] Confirm?"]);
      expect(readFileSync(markerA, "utf8")).toContain('extension_ui_response:{"type":"extension_ui_response","id":"ui-request-1","confirmed":true}');
      expect(readFileSync(markerB, "utf8")).toContain('extension_ui_response:{"type":"extension_ui_response","id":"ui-request-1","confirmed":true}');
    } finally {
      releaseFirst.resolve();
      await Promise.all([clientA.shutdown(), clientB.shutdown()]);
    }
  });

  test("shutdown cancels that client's queued dialog without opening it", async () => {
    const firstEntered = deferred<void>();
    const releaseFirst = deferred<void>();
    const titles: string[] = [];
    const broker = new UIForwarder({ hasUI: true, ui: {
      notify: () => {}, setStatus: () => {}, setWidget: () => {},
      select: async () => undefined,
      confirm: async (title) => {
        titles.push(title);
        if (titles.length === 1) { firstEntered.resolve(); await releaseFirst.promise; }
        return true;
      },
      input: async () => undefined,
      editor: async () => undefined,
    } });
    const { client: clientA } = makeClient("ui", workDir, {}, process.execPath, {}, broker, agentId("agent-a"));
    const stdin = new PassThrough();
    const stdout = new PassThrough();
    const stderr = new PassThrough();
    const clientB = new RpcRunClient({
      launchTransport: async () => ({ stdin, stdout, stderr, exited: new Promise(() => {}), terminate: () => {} }),
      outputStore: new OutputStore({ workDir }), uiForwarder: broker,
      agentId: agentId("agent-b"), runAttemptId: createRunAttemptId(),
    });

    try {
      await Promise.all([clientA.start(), clientB.start()]);
      await clientA.prompt("a");
      await firstEntered.promise;
      stdout.write(`${JSON.stringify({ type: "extension_ui_request", method: "confirm", id: "queued-b", title: "Confirm", message: "Proceed?" })}\n`);
      await clientB.shutdown();
      releaseFirst.resolve();
      await clientA.waitSettled();
      expect(titles).toEqual(["[agent-a] Confirm?"]);
    } finally {
      releaseFirst.resolve();
      await Promise.all([clientA.shutdown(), clientB.shutdown()]);
    }
  });

  test("authoritative natural settlement cancels that client's queued dialog", async () => {
    const firstEntered = deferred<void>();
    const releaseFirst = deferred<void>();
    const titles: string[] = [];
    const broker = new UIForwarder({ hasUI: true, ui: {
      notify: () => {}, setStatus: () => {}, setWidget: () => {},
      select: async () => undefined,
      confirm: async (title) => {
        titles.push(title);
        if (titles.length === 1) { firstEntered.resolve(); await releaseFirst.promise; }
        return true;
      },
      input: async () => undefined,
      editor: async () => undefined,
    } });
    const { client: clientA } = makeClient("ui", workDir, {}, process.execPath, {}, broker, agentId("agent-a"));
    const stdin = new PassThrough();
    const stdout = new PassThrough();
    const stderr = new PassThrough();
    let input = "";
    stdin.on("data", (chunk: Buffer) => {
      input += chunk.toString("utf8");
      for (;;) {
        const newline = input.indexOf("\n");
        if (newline < 0) break;
        const line = input.slice(0, newline);
        input = input.slice(newline + 1);
        const command = JSON.parse(line) as { type: string; id: string };
        if (command.type === "get_entries") stdout.write(`${JSON.stringify({
          type: "response", command: "get_entries", id: command.id, success: true,
          data: { entries: [{ type: "message", message: { role: "assistant", content: [], usage: evidenceUsage, stopReason: "stop" } }], leafId: null },
        })}\n`);
      }
    });
    const clientB = new RpcRunClient({
      launchTransport: async () => ({ stdin, stdout, stderr, exited: new Promise(() => {}), terminate: () => {} }),
      outputStore: new OutputStore({ workDir }), uiForwarder: broker,
      agentId: agentId("agent-b"), runAttemptId: createRunAttemptId(),
    });

    try {
      await Promise.all([clientA.start(), clientB.start()]);
      await clientA.prompt("a");
      await firstEntered.promise;
      stdout.write(`${JSON.stringify({ type: "extension_ui_request", method: "confirm", id: "queued-b", title: "Confirm", message: "Proceed?" })}\n`);
      stdout.write(`${JSON.stringify({ type: "agent_settled" })}\n`);
      await expect(clientB.waitSettled()).resolves.toMatchObject({ reason: "agent_settled", stopReason: "stop" });
      releaseFirst.resolve();
      await clientA.waitSettled();
      expect(titles).toEqual(["[agent-a] Confirm?"]);
    } finally {
      releaseFirst.resolve();
      await Promise.all([clientA.shutdown(), clientB.shutdown()]);
    }
  });

  test("sends a correlated cancellation when the parent UI rejects", async () => {
    const { client } = makeClient("ui", workDir, { confirm: async () => { throw new Error("dialog failed"); } });
    client.start();
    await client.prompt("hello");
    await expect(client.waitSettled()).resolves.toMatchObject({ reason: "agent_settled", stopReason: "stop" });
    await client.shutdown();
  });

  test("fails transport for overflowed aggregate usage without exposing the invalid candidate", async () => {
    const runId: RunId = brandRunId("aaaaaaaa");
    const { client, outputStore } = makeClient("overflowed-aggregate-usage", workDir);
    client.start();
    client.bindRun(runId);
    await client.prompt("hello");

    await expect(client.waitSettled()).resolves.toEqual({
      reason: "process_exited",
      code: null,
      signal: null,
      failureCause: terminalFailureCause(AgentErrorCode.ProtocolError),
    });
    expect(outputStore.currentOutput(runId).transportIncomplete).toBe(true);
    expect(client.getUsage()).toEqual(expect.objectContaining({
      turns: 1,
      usage: expect.objectContaining({ input: Number.MAX_VALUE }),
    }));
    expect(Number.isFinite(client.getUsage()?.usage.input)).toBe(true);
    await client.shutdown();
  });

  test("waitForFixtureMarker resolves a marker that already exists", async () => {
    const marker = join(workDir, "already-exists");
    writeFileSync(marker, "ready\n");

    await waitForFixtureMarker(marker);
  }, 100);

  test("fails settlement recovery for invalid assistant usage evidence", async () => {
    const runId: RunId = brandRunId("aaaaaaaa");
    const terminationMarker = join(workDir, "terminated");
    const { client, outputStore } = makeClient(
      "settlement-invalid-usage",
      workDir,
      {},
      process.execPath,
      { FAKE_RPC_TERMINATION_MARKER: terminationMarker },
    );
    const terminationObserved = waitForFixtureMarker(terminationMarker);
    client.start();
    client.bindRun(runId);
    await client.prompt("hello");

    await expect(client.waitSettled()).resolves.toEqual({
      reason: "agent_settled",
      stopReason: "error",
      failureCause: terminalFailureCause(AgentErrorCode.ProtocolError),
    });
    expect(outputStore.currentOutput(runId).transportIncomplete).toBe(true);
    await terminationObserved;
    expect(readFileSync(terminationMarker, "utf8")).toBe("terminated\n");
    expect(client.getUsage()).toBeUndefined();
    await client.shutdown();
  });

  test("immediate exit after acknowledgement settles once as process_exited with no pending command", async () => {
    const { client } = makeClient("exit-immediate", workDir);
    client.start();
    await client.prompt("hello");

    const first = client.waitSettled();
    const second = client.waitSettled();
    expect(await first).toMatchObject({
      reason: "process_exited",
      failureCause: { code: AgentErrorCode.ProcessExited },
    });
    expect(await second).toEqual(await first);
    await expect(client.getEntries()).rejects.toThrow("rpc child has exited");
    await expect(client.shutdown()).resolves.toBeUndefined();
  });

  test("exit while the correlated get_entries is outstanding terminates settlement recovery", async () => {
    const runId: RunId = brandRunId("aaaaaaaa");
    const { client, outputStore } = makeClient("exit-pending-get-entries", workDir, {}, process.execPath, {
      FAKE_RPC_HANDSHAKE_DIR: workDir,
    });
    client.start();
    client.bindRun(runId);
    await client.prompt("hello");
    await waitForFixtureMarker(join(workDir, "get-entries-received"));

    const settlement = client.waitSettled();
    const alsoSettlement = client.waitSettled();
    const stillPending = Symbol("still-pending");
    expect(await Promise.race([settlement, Promise.resolve().then().then(() => stillPending)]))
      .toBe(stillPending);

    writeFileSync(join(workDir, "release-pending-get-entries"), "release\n");

    expect(await settlement).toEqual({
      reason: "agent_settled",
      stopReason: "error",
      failureCause: terminalFailureCause(AgentErrorCode.ProtocolError),
    });
    expect(await alsoSettlement).toEqual(await settlement);
    expect(outputStore.currentOutput(runId).transportIncomplete).toBeTrue();
    await expect(client.shutdown()).resolves.toBeUndefined();
  });

  test("aggregates optional usage counters across finalised assistant messages", async () => {
    const { client } = makeClient("multi-turn-usage", workDir);
    client.start();
    await client.prompt("hello");
    await client.waitSettled();
    expect(client.getUsage()).toEqual(expect.objectContaining({
      turns: 3,
      usage: expect.objectContaining({ cacheWrite1h: 10, reasoning: 16 }),
    }));
    await client.shutdown();
  });

  test("keeps optional usage counters undefined when no finalised message reports them", async () => {
    const { client } = makeClient("multi-turn-usage-undefined", workDir);
    client.start();
    await client.prompt("hello");
    await client.waitSettled();
    expect(client.getUsage()?.usage.cacheWrite1h).toBeUndefined();
    expect(client.getUsage()?.usage.reasoning).toBeUndefined();
    await client.shutdown();
  });

  test("shutdown rejects any pending requests and leaves no dangling promises", async () => {
    const { client } = makeClient("normal", workDir);
    client.start();
    const pending = client.getEntries();
    await client.shutdown();
    await expect(pending).rejects.toThrow();
    await expect(client.getEntries()).rejects.toThrow();
  });
});

function waitForFixtureMarker(path: string): Promise<void> {
  return new Promise((resolve, reject) => {
    let settled = false;
    let watcher: ReturnType<typeof watch> | undefined;
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      watcher?.close();
      if (error === undefined) resolve();
      else reject(error);
    };
    const markerExists = () => existsSync(path);

    try {
      if (markerExists()) {
        finish();
        return;
      }
      watcher = watch(join(path, ".."), (_event, filename) => {
        if (filename === basename(path) && markerExists()) finish();
      });
      watcher.once("error", finish);
      if (markerExists()) finish();
    } catch (error) {
      finish(error instanceof Error ? error : new Error("failed to watch fixture marker"));
    }
  });
}

function expectedParentKey(agent: AgentId, childKey: string): string {
  return `pi-subagents:${createHash("sha256").update(agent).update("\0").update(childKey).digest("hex").slice(0, 24)}`;
}
