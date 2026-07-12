import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { closeSync, existsSync, fstatSync, mkdtempSync, openSync, readFileSync, readSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createRunAttemptId, runId as brandRunId } from "../src/domain.ts";
import type { RunAttemptId, RunId, SessionPath } from "../src/domain.ts";
import { OutputStore, type TranscriptFileSystem } from "../src/output-store.ts";
import { systemDurableFileSystem, type DurableFileSystem } from "../src/durable-fs.ts";
import type { WireAssistantMessage } from "../src/rpc-wire.ts";

const RUN: RunId = brandRunId("b2c3d4e5");
const OTHER_RUN: RunId = brandRunId("c3d4e5f6");

function assistantMessage(text: string, overrides: Partial<WireAssistantMessage> = {}): WireAssistantMessage {
  return {
    role: "assistant",
    content: text.length > 0 ? [{ type: "text", text }] : [],
    usage: {
      input: 1,
      output: 1,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 2,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: "stop",
    ...overrides,
  };
}

function sessionLine(entry: Record<string, unknown>): string {
  return `${JSON.stringify(entry)}\n`;
}

function userEntry(id: string) {
  return { type: "message", id, parentId: null, timestamp: "2026-01-01T00:00:00.000Z", message: { role: "user", content: "go" } };
}

function faultFileSystem(failOperation: string, trace: string[] = []): DurableFileSystem {
  let failed = false;
  const record = (operation: string) => {
    trace.push(operation);
    if (!failed && operation === failOperation) {
      failed = true;
      throw new Error(`injected ${operation} failure`);
    }
  };
  return {
    ...systemDurableFileSystem,
    open(path, flags, mode) {
      const operation = flags === "wx" ? "temporary:open" : path.endsWith(".committed") ? "file:open" : "directory:open";
      record(operation);
      return systemDurableFileSystem.open(path, flags, mode);
    },
    write(fd, data) { record("write"); systemDurableFileSystem.write(fd, data); },
    sync(fd) { record("sync"); systemDurableFileSystem.sync(fd); },
    rename(source, destination) { record("rename"); systemDurableFileSystem.rename(source, destination); },
  };
}

function tracingFileSystem(trace: string[], failOperation?: string, failOccurrence = 1): DurableFileSystem {
  const directories = new Set<number>();
  let occurrences = 0;
  const record = (operation: string) => {
    trace.push(operation);
    if (operation === failOperation && ++occurrences === failOccurrence) throw new Error(`injected ${operation} failure`);
  };
  return {
    ...systemDurableFileSystem,
    open(path, flags, mode) {
      const directory = existsSync(path) && statSync(path).isDirectory();
      record(directory ? "directory:open" : flags === "wx" ? "temporary:open" : "file:open");
      const fd = systemDurableFileSystem.open(path, flags, mode);
      if (directory) directories.add(fd);
      return fd;
    },
    write(fd, data) { record("write"); systemDurableFileSystem.write(fd, data); },
    sync(fd) { record(directories.has(fd) ? "directory:sync" : "file:sync"); systemDurableFileSystem.sync(fd); },
    close(fd) { directories.delete(fd); systemDurableFileSystem.close(fd); },
    rename(source, destination) { record("rename"); systemDurableFileSystem.rename(source, destination); },
  };
}

function assistantEntry(id: string, text: string) {
  return {
    type: "message",
    id,
    parentId: null,
    timestamp: "2026-01-01T00:00:01.000Z",
    message: assistantMessage(text),
  };
}

describe("OutputStore", () => {
  let workDir: string;
  let store: OutputStore;

  beforeEach(() => {
    workDir = mkdtempSync(join(tmpdir(), "output-store-test-"));
    store = new OutputStore({ workDir });
  });

  afterEach(() => {
    rmSync(workDir, { recursive: true, force: true });
  });

  test("stages pre-run-ID assistant events into an attempt workspace", () => {
    const attemptId: RunAttemptId = createRunAttemptId();
    store.beginAttempt(attemptId);
    store.onAttemptMessageStart(attemptId, assistantMessage(""));
    store.onAttemptTextDelta(attemptId, 0, "pre-bind");
    store.onAttemptMessageEnd(attemptId, assistantMessage("pre-bind"));
    store.bindRun(attemptId, RUN);
    expect(store.currentOutput(RUN).output.text).toBe("pre-bind");
  });

  test("stages many large deltas in one attempt file without retaining their text in JS state", () => {
    const attemptId = createRunAttemptId();
    store.beginAttempt(attemptId);
    const delta = "x".repeat(64_000);
    for (let i = 0; i < 128; i++) store.onAttemptTextDelta(attemptId, 0, delta);

    const staged = readdirSync(workDir).filter((name) => name.endsWith(".candidate"));
    expect(staged).toHaveLength(1);
    expect(Bun.file(join(workDir, staged[0]!)).size).toBe(128 * 64_000);
    expect(JSON.stringify(store)).not.toContain(delta);
  });

  test("binding keeps a partial attempt candidate separate from an empty committed sidecar", () => {
    const attemptId = createRunAttemptId();
    store.beginAttempt(attemptId);
    store.onAttemptTextDelta(attemptId, 0, "partial bytes");
    const staged = join(workDir, readdirSync(workDir).find((name) => name.endsWith(".candidate"))!);

    const committedPath = store.bindRun(attemptId, RUN);

    expect(readFileSync(committedPath, "utf8")).toBe("");
    expect(readFileSync(staged, "utf8")).toBe("partial bytes");
    expect(readdirSync(workDir).filter((name) => name.startsWith(".tmp-"))).toEqual([]);
  });

  test("finalises staged pre-bind deltas after binding", () => {
    const attemptId = createRunAttemptId();
    store.beginAttempt(attemptId);
    store.onAttemptTextDelta(attemptId, 0, "partial bytes");
    const committedPath = store.bindRun(attemptId, RUN);

    store.onMessageEnd(RUN, assistantMessage("final bytes"));

    expect(readFileSync(committedPath, "utf8")).toBe("final bytes");
    expect(readdirSync(workDir).filter((name) => name.endsWith(".candidate"))).toEqual([]);
  });

  test("binding a run creates an empty committed sidecar atomically", () => {
    const attemptId = createRunAttemptId();
    store.beginAttempt(attemptId);
    const committedPath = store.bindRun(attemptId, RUN);
    expect(Bun.file(committedPath).size).toBe(0);
  });

  test("orders text_delta appends and never reads text_end.content", () => {
    const attemptId = createRunAttemptId();
    store.beginAttempt(attemptId);
    store.bindRun(attemptId, RUN);
    store.onMessageStart(RUN, assistantMessage(""));
    store.onTextDelta(RUN, 0, "hel");
    store.onTextDelta(RUN, 0, "lo");
    store.onMessageEnd(RUN, assistantMessage("hello"));
    expect(store.currentOutput(RUN).output.text).toBe("hello");
  });

  test("the last finalised assistant message wins, including empty and tool-only messages", () => {
    const attemptId = createRunAttemptId();
    store.beginAttempt(attemptId);
    store.bindRun(attemptId, RUN);
    store.onMessageEnd(RUN, assistantMessage("first"));
    store.onMessageEnd(RUN, assistantMessage(""));
    expect(store.currentOutput(RUN).output.text).toBe("");
    expect(store.currentOutput(RUN).transportIncomplete).toBe(false);
  });

  test("a finalised message authoritatively replaces a different streamed candidate", () => {
    const attemptId = createRunAttemptId();
    store.beginAttempt(attemptId);
    const committedPath = store.bindRun(attemptId, RUN);
    store.onMessageStart(RUN, assistantMessage(""));
    store.onTextDelta(RUN, 0, "streamed but not authoritative");
    store.onMessageEnd(RUN, assistantMessage("final"));
    expect(readFileSync(committedPath, "utf8")).toBe("final");
    expect(readdirSync(workDir).filter((name) => name.endsWith(".candidate"))).toEqual([]);
  });

  test("discarding a run removes only its partial candidate sidecar", () => {
    const attemptId = createRunAttemptId();
    store.beginAttempt(attemptId);
    store.onAttemptTextDelta(attemptId, 0, "partial");
    const committedPath = store.bindRun(attemptId, RUN);
    store.discardPartial(RUN);
    expect(readFileSync(committedPath, "utf8")).toBe("");
    expect(readdirSync(workDir).filter((name) => name.endsWith(".candidate"))).toEqual([]);
  });

  test("starting a new message never removes the committed sidecar", () => {
    const attemptId = createRunAttemptId();
    store.beginAttempt(attemptId);
    store.onAttemptTextDelta(attemptId, 0, "unfinished");
    const committedPath = store.bindRun(attemptId, RUN);

    store.onMessageStart(RUN, assistantMessage(""));

    expect(readFileSync(committedPath, "utf8")).toBe("");
  });

  test("rejects a duplicate attempt without leaking or replacing its candidate", () => {
    const attemptId = createRunAttemptId();
    store.beginAttempt(attemptId);
    store.onAttemptTextDelta(attemptId, 0, "preserved");
    const candidate = join(workDir, readdirSync(workDir).find((name) => name.endsWith(".candidate"))!);

    expect(() => store.beginAttempt(attemptId)).toThrow(/already exists/);
    expect(readFileSync(candidate, "utf8")).toBe("preserved");
    expect(readdirSync(workDir).filter((name) => name.endsWith(".candidate"))).toHaveLength(1);
  });

  test("partial candidates are discarded: no message_end leaves the run transport-incomplete", () => {
    const attemptId = createRunAttemptId();
    store.beginAttempt(attemptId);
    store.bindRun(attemptId, RUN);
    store.onMessageStart(RUN, assistantMessage(""));
    store.onTextDelta(RUN, 0, "partial only");
    const { output, transportIncomplete } = store.currentOutput(RUN);
    expect(transportIncomplete).toBe(true);
    expect(output.text).toBe("");
  });

  test("a recovered complete assistant entry replaces a transport-incomplete candidate", () => {
    const attemptId = createRunAttemptId();
    store.beginAttempt(attemptId);
    store.bindRun(attemptId, RUN);
    store.onMessageStart(RUN, assistantMessage(""));
    store.onTextDelta(RUN, 0, "never finished");

    const sessionPath = join(workDir, "child-session.jsonl") as SessionPath;
    writeFileSync(sessionPath, sessionLine(userEntry(RUN)) + sessionLine(assistantEntry("aaaaaaaa", "recovered text")));

    const result = store.recover(RUN, sessionPath);
    expect(result.recovered).toBe(true);
    if (result.recovered) {
      expect(result.output.text).toBe("recovered text");
    }
    expect(store.currentOutput(RUN).transportIncomplete).toBe(false);
  });

  test("transport loss after a final message permits recovery to replace stale output", () => {
    const attemptId = createRunAttemptId();
    store.beginAttempt(attemptId);
    store.bindRun(attemptId, RUN);
    store.onMessageEnd(RUN, assistantMessage("stale live output"));
    store.markTransportIncomplete(RUN);
    expect(store.currentOutput(RUN).transportIncomplete).toBe(true);
    const sessionPath = join(workDir, "child-session.jsonl") as SessionPath;
    writeFileSync(sessionPath, sessionLine(userEntry(RUN)) + sessionLine(assistantEntry("aaaaaaaa", "recovered final")));
    const result = store.recover(RUN, sessionPath);
    expect(result).toEqual({ recovered: true, output: expect.objectContaining({ text: "recovered final" }) });
  });

  test("transport loss before bind is promoted to the bound run", () => {
    const attemptId = createRunAttemptId();
    store.beginAttempt(attemptId);
    store.markAttemptTransportIncomplete(attemptId);
    store.bindRun(attemptId, RUN);
    expect(store.currentOutput(RUN).transportIncomplete).toBe(true);
  });

  test("an earlier assistant does not prevent authoritative empty recovery after the matching cursor", () => {
    const attemptId = createRunAttemptId();
    store.beginAttempt(attemptId);
    store.bindRun(attemptId, OTHER_RUN);

    const sessionPath = join(workDir, "child-session.jsonl") as SessionPath;
    writeFileSync(
      sessionPath,
      sessionLine(assistantEntry("aaaaaaaa", "stale from a previous run")) + sessionLine(userEntry(OTHER_RUN)),
    );

    const result = store.recover(OTHER_RUN, sessionPath);
    expect(result).toEqual({ recovered: true, output: expect.objectContaining({ text: "" }) });
  });

  test("does not recover from an assistant-only session", () => {
    const attemptId = createRunAttemptId(); store.beginAttempt(attemptId); store.bindRun(attemptId, RUN);
    const sessionPath = join(workDir, "assistant-only.jsonl") as SessionPath;
    writeFileSync(sessionPath, sessionLine(assistantEntry("aaaaaaaa", "unrelated")));
    expect(store.recover(RUN, sessionPath).recovered).toBe(false);
  });

  test("does not recover when the matching cursor is missing", () => {
    const attemptId = createRunAttemptId(); store.beginAttempt(attemptId); store.bindRun(attemptId, RUN);
    const sessionPath = join(workDir, "missing-cursor.jsonl") as SessionPath;
    writeFileSync(sessionPath, sessionLine(userEntry(OTHER_RUN)) + sessionLine(assistantEntry("aaaaaaaa", "unrelated")));
    expect(store.recover(RUN, sessionPath).recovered).toBe(false);
  });

  test("recovers when the matching cursor is the first line at byte zero", () => {
    const attemptId = createRunAttemptId(); store.beginAttempt(attemptId); store.bindRun(attemptId, RUN);
    const sessionPath = join(workDir, "cursor-first.jsonl") as SessionPath;
    writeFileSync(sessionPath, sessionLine(userEntry(RUN)) + sessionLine(assistantEntry("aaaaaaaa", "right")));
    expect(store.recover(RUN, sessionPath)).toEqual({ recovered: true, output: expect.objectContaining({ text: "right" }) });
  });

  test("selects only the last complete assistant after the matching cursor", () => {
    const attemptId = createRunAttemptId(); store.beginAttempt(attemptId); store.bindRun(attemptId, RUN);
    const sessionPath = join(workDir, "later-runs.jsonl") as SessionPath;
    writeFileSync(sessionPath, sessionLine(userEntry(RUN)) + sessionLine(assistantEntry("a", "ours")) + sessionLine(userEntry(OTHER_RUN)) + sessionLine(assistantEntry("b", "later run")));
    expect(store.recover(RUN, sessionPath)).toEqual({ recovered: true, output: expect.objectContaining({ text: "ours" }) });
  });

  test("final assistant JSON crossing a tail-read boundary still recovers", () => {
    const attemptId = createRunAttemptId();
    store.beginAttempt(attemptId);
    store.bindRun(attemptId, RUN);

    const sessionPath = join(workDir, "child-session.jsonl") as SessionPath;
    const padding = "x".repeat(500);
    const userLine = sessionLine(userEntry(RUN));
    const paddingLine = sessionLine({ type: "thinking_level_change", id: "ffffffff", parentId: null, timestamp: "t", thinkingLevel: padding });
    const assistantLine = sessionLine(assistantEntry("aaaaaaaa", "boundary crossing text"));
    writeFileSync(sessionPath, userLine + paddingLine + assistantLine);

    const smallStore = new OutputStore({ workDir, maxRecoveryBytes: Buffer.byteLength(userLine + paddingLine + assistantLine) });
    const attempt2 = createRunAttemptId();
    smallStore.beginAttempt(attempt2);
    smallStore.bindRun(attempt2, RUN);

    const result = smallStore.recover(RUN, sessionPath);
    expect(result.recovered).toBe(true);
    if (result.recovered) {
      expect(result.output.text).toBe("boundary crossing text");
    }
  });

  test("a matching cursor at complete EOF proves authoritative empty output", () => {
    const attemptId = createRunAttemptId();
    store.beginAttempt(attemptId);
    store.bindRun(attemptId, RUN);

    const sessionPath = join(workDir, "child-session.jsonl") as SessionPath;
    writeFileSync(sessionPath, sessionLine(userEntry(RUN)));

    const result = store.recover(RUN, sessionPath);
    expect(result).toEqual({ recovered: true, output: expect.objectContaining({ text: "" }) });
  });

  test("persisted output truncates to a valid UTF-8 prefix at 50 KB while the sidecar remains complete", () => {
    const attemptId = createRunAttemptId();
    store.beginAttempt(attemptId);
    const committedPath = store.bindRun(attemptId, RUN);
    const bigText = "a".repeat(60_000);
    store.onMessageEnd(RUN, assistantMessage(bigText));

    const { output } = store.currentOutput(RUN);
    expect(output.truncated).toBe(true);
    expect(new TextEncoder().encode(output.text).byteLength).toBeLessThanOrEqual(50_000);
    expect(Bun.file(committedPath).size).toBe(60_000);
  });

  test("candidate-read failure occurs only after run insertion and ownership transfer", () => {
    const attemptId = createRunAttemptId();
    let failCandidateRead = true;
    const candidateReadFault: DurableFileSystem = {
      ...systemDurableFileSystem,
      readFile(path) {
        if (failCandidateRead && path.endsWith(".candidate")) {
          failCandidateRead = false;
          throw new Error("injected candidate read failure");
        }
        return systemDurableFileSystem.readFile(path);
      },
    };
    const failedStore = new OutputStore({ workDir, durableFileSystem: candidateReadFault });
    failedStore.beginAttempt(attemptId);
    failedStore.onAttemptMessageEnd(attemptId, assistantMessage("candidate"));

    expect(() => failedStore.adoptRun(attemptId, RUN)).toThrow("injected candidate read failure");
    expect(failedStore.currentOutput(RUN)).toEqual({
      output: expect.objectContaining({ text: "" }),
      transportIncomplete: true,
    });
    expect(() => failedStore.adoptRun(attemptId, OTHER_RUN)).toThrow(/unknown run attempt/);

    const sessionPath = join(workDir, "candidate-read-recovery.jsonl") as SessionPath;
    writeFileSync(sessionPath, sessionLine(userEntry(RUN)) + sessionLine(assistantEntry("a", "authoritative")));
    const durable = failedStore.ensureDurable(RUN, sessionPath);
    expect(durable.output).toEqual(expect.objectContaining({ text: "authoritative" }));
    expect(typeof durable.committedPath).toBe("string");
  });

  test("adopts run identity before a failed initial publication and remains durably addressable", () => {
    const attemptId = createRunAttemptId();
    const failedStore = new OutputStore({ workDir, durableFileSystem: faultFileSystem("write") });
    failedStore.beginAttempt(attemptId);
    failedStore.adoptRun(attemptId, RUN);
    expect(() => failedStore.publishInitial(RUN)).toThrow(/injected write failure/);
    expect(failedStore.currentOutput(RUN).output.text).toBe("");
    const sessionPath = join(workDir, "empty.jsonl") as SessionPath;
    writeFileSync(sessionPath, sessionLine(userEntry(RUN)));
    const durable = failedStore.ensureDurable(RUN, sessionPath);
    expect(durable.output).toEqual(expect.objectContaining({ text: "" }));
    expect(typeof durable.committedPath).toBe("string");
  });

  test("pre-bind candidate promotion crosses the shared file-sync, rename, directory-sync boundary", () => {
    const trace: string[] = [];
    const tracedStore = new OutputStore({ workDir, durableFileSystem: tracingFileSystem(trace) });
    const attemptId = createRunAttemptId();
    tracedStore.beginAttempt(attemptId);
    tracedStore.onAttemptMessageEnd(attemptId, assistantMessage("promoted"));
    trace.length = 0;

    const committed = tracedStore.bindRun(attemptId, RUN);

    expect(trace.indexOf("file:sync")).toBeLessThan(trace.indexOf("rename"));
    expect(trace.indexOf("rename")).toBeLessThan(trace.lastIndexOf("directory:sync"));
    expect(readFileSync(committed, "utf8")).toBe("promoted");
  });

  test("final rewrite retains hidden pending output after post-rename failure and retries in place when transport is complete", () => {
    const trace: string[] = [];
    const tracedStore = new OutputStore({ workDir, durableFileSystem: tracingFileSystem(trace, "directory:sync", 5) });
    const attemptId = createRunAttemptId();
    tracedStore.beginAttempt(attemptId);
    const committed = tracedStore.bindRun(attemptId, RUN);
    trace.length = 0;

    expect(() => tracedStore.onMessageEnd(RUN, assistantMessage("renamed but unsynced"))).toThrow(/directory:sync/);
    expect(readFileSync(committed, "utf8")).toBe("renamed but unsynced");
    expect(tracedStore.currentOutput(RUN)).toEqual({
      output: expect.objectContaining({ text: "" }),
      transportIncomplete: false,
    });

    trace.length = 0;
    const sessionPath = join(workDir, "unused-complete-transcript.jsonl") as SessionPath;
    const durable = tracedStore.ensureDurable(RUN, sessionPath);
    expect(durable.output.text).toBe("renamed but unsynced");
    expect(trace).not.toContain("write");
    expect(trace).not.toContain("rename");
    expect(trace.slice(-4)).toEqual(["file:open", "file:sync", "directory:open", "directory:sync"]);
  });

  test.each(["temporary:open", "write", "file:sync", "rename", "directory:open", "directory:sync"])(
    "retries an injected final-publication %s failure without exposing pending output",
    (operation) => {
      const failureOccurrence = operation.startsWith("directory:") ? 5 : 2;
      const tracedStore = new OutputStore({ workDir, durableFileSystem: tracingFileSystem([], operation, failureOccurrence) });
      const attemptId = createRunAttemptId();
      tracedStore.beginAttempt(attemptId);
      const committed = tracedStore.bindRun(attemptId, RUN);

      expect(() => tracedStore.onMessageEnd(RUN, assistantMessage("authoritative"))).toThrow(`injected ${operation} failure`);
      expect(tracedStore.currentOutput(RUN).output.text).toBe("");
      if (["temporary:open", "write", "file:sync", "rename"].includes(operation)) {
        expect(readFileSync(committed, "utf8")).toBe("");
      } else {
        expect(readFileSync(committed, "utf8")).toBe("authoritative");
      }

      const sessionPath = join(workDir, `retry-${operation}.jsonl`) as SessionPath;
      writeFileSync(sessionPath, sessionLine(userEntry(RUN)) + sessionLine(assistantEntry("a", "authoritative")));
      expect(tracedStore.ensureDurable(RUN, sessionPath).output.text).toBe("authoritative");
      expect(readFileSync(committed, "utf8")).toBe("authoritative");
      expect(readdirSync(workDir).filter((name) => name.startsWith(".tmp-"))).toEqual([]);
    },
  );

  test("transport-incomplete retry never blesses pending bytes and republishes transcript projection", () => {
    const tracedStore = new OutputStore({ workDir, durableFileSystem: tracingFileSystem([], "directory:sync", 5) });
    const attemptId = createRunAttemptId();
    tracedStore.beginAttempt(attemptId);
    const committed = tracedStore.bindRun(attemptId, RUN);
    expect(() => tracedStore.onMessageEnd(RUN, assistantMessage("pending"))).toThrow(/directory:sync/);
    tracedStore.markTransportIncomplete(RUN);
    const sessionPath = join(workDir, "incomplete-pending.jsonl") as SessionPath;
    writeFileSync(sessionPath, sessionLine(userEntry(RUN)) + sessionLine(assistantEntry("a", "transcript wins")));

    expect(tracedStore.ensureDurable(RUN, sessionPath).output.text).toBe("transcript wins");
    expect(readFileSync(committed, "utf8")).toBe("transcript wins");
  });

  test("a missing committed destination is reconstructed from transcript evidence", () => {
    store.restoreRun(RUN);
    const sessionPath = join(workDir, "missing-destination.jsonl") as SessionPath;
    writeFileSync(sessionPath, sessionLine(userEntry(RUN)) + sessionLine(assistantEntry("a", "reconstructed")));

    const durable = store.ensureDurable(RUN, sessionPath);

    expect(readFileSync(durable.committedPath, "utf8")).toBe("reconstructed");
    expect(readdirSync(workDir).filter((name) => name.startsWith(".tmp-"))).toEqual([]);
  });

  test("a pre-rename publication failure preserves committed bytes and in-memory output", () => {
    const attemptId = createRunAttemptId();
    store.beginAttempt(attemptId); store.bindRun(attemptId, RUN);
    store.onMessageEnd(RUN, assistantMessage("previous"));
    const committed = store.restoreRun(RUN);
    const failed = new OutputStore({ workDir, durableFileSystem: faultFileSystem("write") });
    failed.restoreRun(RUN);
    expect(() => failed.recoverMessage(RUN, assistantMessage("next"))).toThrow(/injected write failure/);
    expect(readFileSync(committed, "utf8")).toBe("previous");
    expect(failed.currentOutput(RUN).output.text).toBe("");
    expect(readdirSync(workDir).filter((name) => name.startsWith(".tmp-"))).toEqual([]);
  });

  test("transport-incomplete durability recovery republishes transcript evidence over stale output", () => {
    const attemptId = createRunAttemptId(); store.beginAttempt(attemptId); store.bindRun(attemptId, RUN);
    store.onMessageEnd(RUN, assistantMessage("stale live"));
    store.markTransportIncomplete(RUN);
    const committed = store.restoreRun(RUN);
    writeFileSync(committed, "stale destination");
    const sessionPath = join(workDir, "recover.jsonl") as SessionPath;
    writeFileSync(sessionPath, sessionLine(userEntry(RUN)) + sessionLine(assistantEntry("a", "authoritative")));
    expect(store.ensureDurable(RUN, sessionPath)).toEqual({
      output: expect.objectContaining({ text: "authoritative" }),
      committedPath: committed,
    });
    expect(readFileSync(committed, "utf8")).toBe("authoritative");
  });

  test.each([
    ["next user cursor", sessionLine(userEntry(RUN)) + sessionLine(userEntry(OTHER_RUN))],
    ["complete EOF", sessionLine(userEntry(RUN))],
  ])("matching cursor with no assistant at %s is authoritative empty", (_case, transcript) => {
    store.restoreRun(RUN);
    const sessionPath = join(workDir, "authoritative-empty.jsonl") as SessionPath;
    writeFileSync(sessionPath, transcript);
    expect(store.ensureDurable(RUN, sessionPath).output.text).toBe("");
  });

  test.each([
    ["missing cursor", sessionLine(userEntry(OTHER_RUN))],
    ["invalid UTF-8", Buffer.from([0xff, 0x0a])],
    ["incomplete trailing record", sessionLine(userEntry(RUN)) + "{\"type\":"],
  ])("rejects %s transcript recovery evidence", (_case, transcript) => {
    store.restoreRun(RUN);
    const sessionPath = join(workDir, "bad.jsonl") as SessionPath;
    writeFileSync(sessionPath, transcript);
    expect(() => store.ensureDurable(RUN, sessionPath)).toThrow(/output_error/);
  });

  test("rejects unreadable and bounded-window-missed transcript evidence", () => {
    store.restoreRun(RUN);
    const missingPath = join(workDir, "missing.jsonl") as SessionPath;
    expect(() => store.ensureDurable(RUN, missingPath)).toThrow(/unreadable/);

    const boundedStore = new OutputStore({ workDir, maxRecoveryBytes: 100 });
    boundedStore.restoreRun(OTHER_RUN);
    const sessionPath = join(workDir, "bounded-miss.jsonl") as SessionPath;
    writeFileSync(sessionPath, sessionLine(userEntry(OTHER_RUN)) + sessionLine({ type: "metadata", padding: "x".repeat(200) }));
    expect(() => boundedStore.ensureDurable(OTHER_RUN, sessionPath)).toThrow(/no matching assignment cursor|no complete record/);
  });

  test("loops over legal short transcript reads and parses only the bytes actually read", () => {
    let reads = 0;
    const transcriptFileSystem: TranscriptFileSystem = {
      open: openSync,
      fstat: fstatSync,
      read(fd, buffer, offset, length, position) {
        reads++;
        return readSync(fd, buffer, offset, Math.min(length, 7), position);
      },
      close: closeSync,
    };
    const shortReadStore = new OutputStore({ workDir, transcriptFileSystem });
    shortReadStore.restoreRun(RUN);
    const sessionPath = join(workDir, "short-reads.jsonl") as SessionPath;
    writeFileSync(sessionPath, sessionLine(userEntry(RUN)) + sessionLine(assistantEntry("a", "short-read recovery")));

    expect(shortReadStore.ensureDurable(RUN, sessionPath).output.text).toBe("short-read recovery");
    expect(reads).toBeGreaterThan(1);
  });

  test("ignores an inflated fstat tail after complete transcript bytes reach EOF", () => {
    const transcript = Buffer.from(
      sessionLine(userEntry(RUN)) + sessionLine(assistantEntry("a", "inflated-size recovery")),
    );
    let sourceOffset = 0;
    let reads = 0;
    const transcriptFileSystem: TranscriptFileSystem = {
      open() { return 123; },
      fstat() { return { size: transcript.byteLength + 4_096 }; },
      read(_fd, buffer, offset, length) {
        reads++;
        if (sourceOffset === transcript.byteLength) return 0;
        const bytesRead = Math.min(length, transcript.byteLength - sourceOffset);
        transcript.copy(buffer, offset, sourceOffset, sourceOffset + bytesRead);
        sourceOffset += bytesRead;
        return bytesRead;
      },
      close() {},
    };
    const shortReadStore = new OutputStore({ workDir, transcriptFileSystem });
    shortReadStore.restoreRun(RUN);

    expect(shortReadStore.ensureDurable(RUN, join(workDir, "inflated.jsonl") as SessionPath).output.text)
      .toBe("inflated-size recovery");
    expect(reads).toBe(2);
  });

  test("maps a transcript close-only failure to bounded output_error without raw details", () => {
    const transcriptFileSystem: TranscriptFileSystem = {
      open: openSync,
      fstat: fstatSync,
      read: readSync,
      close(fd) { closeSync(fd); throw new Error("raw close secret"); },
    };
    const failedStore = new OutputStore({ workDir, transcriptFileSystem });
    failedStore.restoreRun(RUN);
    const sessionPath = join(workDir, "close-failure.jsonl") as SessionPath;
    writeFileSync(sessionPath, sessionLine(userEntry(RUN)));

    expect(() => failedStore.ensureDurable(RUN, sessionPath)).toThrow("output_error: session file could not be closed");
    try { failedStore.ensureDurable(RUN, sessionPath); }
    catch (error) { expect(String(error)).not.toContain("raw close secret"); }
  });

  test("retains a primary transcript read failure when close also fails", () => {
    let closed = false;
    const transcriptFileSystem: TranscriptFileSystem = {
      open: openSync,
      fstat: fstatSync,
      read() { throw new Error("raw read secret"); },
      close(fd) { closed = true; closeSync(fd); throw new Error("raw close secret"); },
    };
    const failedStore = new OutputStore({ workDir, transcriptFileSystem });
    failedStore.restoreRun(RUN);
    const sessionPath = join(workDir, "read-close-failure.jsonl") as SessionPath;
    writeFileSync(sessionPath, sessionLine(userEntry(RUN)));

    expect(() => failedStore.ensureDurable(RUN, sessionPath)).toThrow("output_error: session file is unreadable");
    expect(closed).toBeTrue();
  });

  test("returns bounded output while preserving full recovered sidecar bytes", () => {
    const text = "x".repeat(60_000);
    store.restoreRun(RUN);
    const sessionPath = join(workDir, "large.jsonl") as SessionPath;
    writeFileSync(sessionPath, sessionLine(userEntry(RUN)) + sessionLine(assistantEntry("a", text)));
    const durable = store.ensureDurable(RUN, sessionPath);
    expect(durable.output.retainedBytes).toBeLessThanOrEqual(50_000);
    expect(readFileSync(durable.committedPath).byteLength).toBe(60_000);
  });

  test("stderr and diagnostics retain only their configured tails", () => {
    const boundedStore = new OutputStore({ workDir, maxTailBytes: 16 });
    boundedStore.appendStderr("0123456789");
    boundedStore.appendStderr("0123456789");
    expect(new TextEncoder().encode(boundedStore.getStderrTail()).byteLength).toBeLessThanOrEqual(16);

    boundedStore.appendDiagnostics("0123456789");
    boundedStore.appendDiagnostics("0123456789");
    expect(new TextEncoder().encode(boundedStore.getDiagnosticsTail()).byteLength).toBeLessThanOrEqual(16);
  });
});
