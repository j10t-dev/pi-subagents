import { expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { join } from "node:path";

import {
  AuthStorage,
  ModelRegistry,
  RpcClient,
  SessionManager,
  getAgentDir,
  type SessionEntry,
} from "@earendil-works/pi-coding-agent";

const MODEL_PROVIDER = "openai-codex";
const MODEL_ID = "gpt-5.6-luna";
const PROMPT = "Launch a gpt-5.6-luna subagent with web_fetch to retrieve London's current temperature.";
const prerequisiteFailure = await findPrerequisiteFailure();

if (prerequisiteFailure !== undefined) {
  test.skip(`live model smoke skipped: ${prerequisiteFailure}`, () => {});
} else {
  test("a live model directly spawns, fetches and receives without a nested Pi command", async () => {
    const client = new RpcClient({
      cliPath: resolvePiExecutable(),
      cwd: process.cwd(),
      provider: MODEL_PROVIDER,
      model: MODEL_ID,
      args: ["--approve", "--tools", "spawn_agent,receive_agent,web_fetch"],
    });
    try {
      await client.start();
      await client.promptAndWait(PROMPT, undefined, 120_000);

      const parentEntries = (await client.getEntries()).entries;
      const parentCalls = toolCalls(parentEntries);
      const spawn = parentCalls.find((call) => call.name === "spawn_agent");
      expect(spawn).toBeDefined();
      expect(spawn!.arguments).toMatchObject({ model: MODEL_ID, tools: ["web_fetch"] });
      expect(String(spawn!.arguments.model)).not.toContain("/");

      const spawnResult = toolResults(parentEntries).find((result) => result.name === "spawn_agent");
      expect(spawnResult?.details).toMatchObject({
        state: "running", model: `${MODEL_PROVIDER}/${MODEL_ID}`, tools: ["web_fetch"],
      });

      const receiveIndex = parentCalls.findIndex((call) => call.name === "receive_agent");
      expect(receiveIndex).toBeGreaterThan(parentCalls.indexOf(spawn!));
      const receiveResult = toolResults(parentEntries).find((result) => {
        if (result.name !== "receive_agent" || !isRecord(result.details)) return false;
        return Array.isArray(result.details.completions) && result.details.completions.length > 0;
      });
      const receiveDetails = requireRecord(receiveResult?.details);
      expect(Array.isArray(receiveDetails.completions)).toBeTrue();
      expect(receiveDetails.completions).not.toHaveLength(0);
      const completion = requireRecord((receiveDetails.completions as readonly unknown[])[0]);
      expect(completion.state).toBe("completed");

      const transcriptPath = completion.transcriptPath;
      expect(typeof transcriptPath).toBe("string");
      const childEntries = SessionManager.open(transcriptPath as string).getEntries();
      expect(toolCalls(childEntries).map((call) => call.name)).toContain("web_fetch");

      const allEntries = [...parentEntries, ...childEntries];
      expect(toolCalls(allEntries).some((call) => call.name === "bash")).toBeFalse();
      expect(assistantText(allEntries)).not.toMatch(/(?:^|[\s`])pi\s+(?:--|[-\w/]*\.js\b)/mu);
    } finally {
      await client.stop();
    }
  }, 120_000);
}

async function findPrerequisiteFailure(): Promise<string | undefined> {
  if (process.env.PI_SUBAGENTS_LIVE_SMOKE !== "1") return "missing PI_SUBAGENTS_LIVE_SMOKE=1 opt-in flag";
  const agentDir = getAgentDir();
  const authStorage = AuthStorage.create(join(agentDir, "auth.json"));
  const registry = ModelRegistry.create(authStorage, join(agentDir, "models.json"));
  const model = registry.find(MODEL_PROVIDER, MODEL_ID);
  if (model === undefined) return `missing model ${MODEL_PROVIDER}/${MODEL_ID}`;
  const auth = await registry.getApiKeyAndHeaders(model);
  if (!auth.ok || auth.apiKey === undefined || auth.apiKey.length === 0) {
    return `missing usable ${MODEL_PROVIDER} credential for ${MODEL_PROVIDER}/${MODEL_ID}`;
  }
  return undefined;
}

interface CapturedToolCall {
  name: string;
  arguments: Record<string, unknown>;
}

interface CapturedToolResult {
  name: string;
  details: unknown;
}

function toolCalls(entries: readonly SessionEntry[]): CapturedToolCall[] {
  return entries.flatMap((entry) => {
    if (entry.type !== "message" || entry.message.role !== "assistant") return [];
    return entry.message.content.flatMap((part) => part.type === "toolCall"
      ? [{ name: part.name, arguments: requireRecord(part.arguments) }]
      : []);
  });
}

function toolResults(entries: readonly SessionEntry[]): CapturedToolResult[] {
  return entries.flatMap((entry) => entry.type === "message" && entry.message.role === "toolResult"
    ? [{ name: entry.message.toolName, details: entry.message.details }]
    : []);
}

function assistantText(entries: readonly SessionEntry[]): string {
  return entries.flatMap((entry) => entry.type === "message" && entry.message.role === "assistant"
    ? entry.message.content.flatMap((part) => part.type === "text" ? [part.text] : [])
    : []).join("\n");
}

function requireRecord(value: unknown): Record<string, unknown> {
  if (!isRecord(value)) throw new Error("expected transcript record");
  return value as Record<string, unknown>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function resolvePiExecutable(): string {
  const executable = execFileSync("sh", ["-c", "command -v pi"], { encoding: "utf8" }).trim();
  if (executable === "") throw new Error("normal pi executable is unavailable on PATH");
  return executable;
}
