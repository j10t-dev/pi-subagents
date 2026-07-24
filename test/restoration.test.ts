import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import {
  AgentEventAppender,
  decodeAgentEvent,
  foldAgentEvents,
  type FoldedAgentRecord,
} from "../src/persistence.ts";
import {
  RestorationApplicationError,
  applyRestoration,
  collectRestorationEvidence,
  planRestoration,
  type RestorationApplicationState,
} from "../src/restoration.ts";
import type { RestoreAdmission } from "../src/run-controller.ts";
import { firstUserEntryAfterCursor } from "../src/pi-composition.ts";
import { SubagentController, type RestorationPort } from "../src/controller.ts";
import { MAX_COMPLETION_OUTPUT_BYTES } from "../src/constants.ts";
import { systemDurableFileSystem, type DurableFileSystem } from "../src/durable-fs.ts";
import { OutputStore } from "../src/output-store.ts";
import { outputPath, sessionPath } from "../src/paths.ts";
import { testAbsolutePath, testAgentId, testAttemptId, testCommittedOutputPath, testContainmentAttempt, testMilliseconds, testModelId, testProviderId, testReceiptPath, testRunId, testSessionPath, testVerifiedReceiptPath } from "./support/brands.ts";
import { testBarrier } from "./support/barriers.ts";
import { testRuntime } from "./support/launches.ts";
import { completedEntry, launchEntry, spawnedEntry, startedEntry, stoppingEntry, testRestorationPort, type RestorationEventEntry } from "./support/restoration.ts";
import { completedCompletion } from "./support/messages.ts";
import {
  AgentEventType,
  AgentState,
  CancellationReason,
  CompletionState,
  agentRunKey,
  runCapacity,
  truncateUtf8,
  utf8Bytes,
  type AgentCompletion,
  type RestorableAgentCompletion,
} from "../src/domain.ts";
import { temporaryStateRoot } from "./support/temp-state.ts";

function completionArray<T>(result: { readonly completion?: T }): T[] {
  return result.completion === undefined ? [] : [result.completion];
}

const TEST_STATE_ROOT = testAbsolutePath("/tmp");

describe("restoration evidence collection", () => {
  test("a stopped agent without an action performs no containment or session lookup", async () => {
    let resolutions = 0;
    let lookups = 0;
    const evidence = await collectRestorationEvidence(
      foldAgentEvents([spawned()], TEST_STATE_ROOT),
      testRestorationPort({
        resolveContainment: async () => { resolutions++; throw new Error("must not resolve"); },
        firstUserEntryAfter: async () => { lookups++; throw new Error("must not look up"); },
      }),
      () => testRuntime(),
    );

    expect(evidence.size).toBe(0);
    expect({ resolutions, lookups }).toEqual({ resolutions: 0, lookups: 0 });
  });

  test("identical actions share one complete containment decision", async () => {
    const registry = foldAgentEvents([spawned(), launch()], TEST_STATE_ROOT);
    const action = registry.actions[0]!;
    const secondAgent = testAgentId("agent-b");
    const secondRecord = { ...registry.agents.get(action.agentId)!, agentId: secondAgent };
    registry.agents.set(secondAgent, secondRecord);
    registry.actions.push({ ...action, agentId: secondAgent });
    let resolutions = 0;
    let containments = 0;
    const evidence = await collectRestorationEvidence(registry, testRestorationPort({
      resolveContainment: async () => {
        resolutions++;
        return { kind: "requires-containment", runtime: testRuntime({ contain: async () => {
          containments++;
          return testVerifiedReceiptPath();
        } }) };
      },
    }), () => testRuntime());

    expect({ resolutions, containments }).toEqual({ resolutions: 1, containments: 1 });
    expect(evidence.get(action.agentId)?.containment.kind).toBe("contained");
    expect(evidence.get(secondAgent)?.containment.kind).toBe("contained");
  });

  test("requires-containment contains once and preserves its runtime after success", async () => {
    const registry = foldAgentEvents([spawned(), launch(), started()], TEST_STATE_ROOT);
    let containments = 0;
    const runtime = testRuntime({ contain: async () => {
      containments++;
      return testVerifiedReceiptPath();
    } });
    const evidence = await collectRestorationEvidence(registry, testRestorationPort({
      resolveContainment: async () => ({ kind: "requires-containment", runtime }),
    }), () => testRuntime());

    expect(containments).toBe(1);
    expect(evidence.get(testAgentId())?.containment).toEqual({ kind: "contained", runtime });
  });

  test("resolver and containment errors become uncontained evidence", async () => {
    const registry = foldAgentEvents([spawned(), launch(), started()], TEST_STATE_ROOT);
    const action = registry.actions[0]!;
    const secondAgent = testAgentId("agent-b");
    registry.agents.set(secondAgent, { ...registry.agents.get(action.agentId)!, agentId: secondAgent });
    registry.actions.push({ ...action, agentId: secondAgent, attemptId: testAttemptId("other") });
    const evidence = await collectRestorationEvidence(registry, testRestorationPort({
      resolveContainment: async (input) => input.attemptId === testAttemptId("other")
        ? { kind: "requires-containment", runtime: testRuntime({ contain: async () => { throw new Error("containment failed"); } }) }
        : Promise.reject(new Error("resolver failed")),
    }), () => testRuntime());

    expect(evidence.get(action.agentId)?.containment.kind).toBe("uncontained");
    expect(evidence.get(secondAgent)?.containment.kind).toBe("uncontained");
  });

  test("historical decisions stay distinct without containment", async () => {
    const registry = foldAgentEvents([spawned(), launch(), started()], TEST_STATE_ROOT);
    let containments = 0;
    const runtime = testRuntime({ contain: async () => { containments++; return testVerifiedReceiptPath(); } });
    const evidence = await collectRestorationEvidence(registry, testRestorationPort({
      resolveContainment: async () => ({ kind: "unresolved-historical", runtime }),
    }), () => testRuntime());

    expect(evidence.get(testAgentId())?.containment).toEqual({ kind: "historical-unresolved", runtime });
    expect(containments).toBe(0);
  });

  test("completed-receipt failure uses completed runtime for retry", async () => {
    const registry = foldAgentEvents([spawned(), launch(), started(), completed()], TEST_STATE_ROOT);
    const retryRuntime = testRuntime();
    let completedInputs = 0;
    const evidence = await collectRestorationEvidence(registry, testRestorationPort({
      resolveContainment: async () => ({ kind: "requires-containment", runtime: testRuntime({ contain: async () => { throw new Error("invalid receipt"); } }) }),
    }), () => { completedInputs++; return retryRuntime; });

    expect(completedInputs).toBe(1);
    expect(evidence.get(testAgentId())?.containment).toEqual({ kind: "uncontained", runtime: retryRuntime });
  });

  test("historically unresolved completed receipts use the re-resolving completed runtime", async () => {
    const registry = foldAgentEvents([spawned(), launch(), started(), completed()], TEST_STATE_ROOT);
    const retryRuntime = testRuntime();
    const evidence = await collectRestorationEvidence(registry, testRestorationPort({
      resolveContainment: async () => ({ kind: "unresolved-historical", runtime: testRuntime() }),
    }), () => retryRuntime);

    expect(evidence.get(testAgentId())?.containment).toEqual({ kind: "historical-unresolved", runtime: retryRuntime });
  });

  test("only contained launches look up their cursor and convert lookup outcomes", async () => {
    const registry = foldAgentEvents([spawned(), launch()], TEST_STATE_ROOT);
    const action = registry.actions[0]!;
    if (action.type !== "reconcile_launch") throw new Error("expected launch action");
    const noRunAgent = testAgentId("agent-b");
    const failedAgent = testAgentId("agent-c");
    const uncontainedAgent = testAgentId("agent-d");
    for (const agentIdValue of [noRunAgent, failedAgent, uncontainedAgent]) {
      registry.agents.set(agentIdValue, { ...registry.agents.get(action.agentId)!, agentId: agentIdValue });
      registry.actions.push({ ...action, agentId: agentIdValue, ...(agentIdValue === uncontainedAgent ? { attemptId: testAttemptId("blocked") } : {}) });
    }
    const lookups: string[] = [];
    const evidence = await collectRestorationEvidence(registry, testRestorationPort({
      resolveContainment: async (input) => input.attemptId === testAttemptId("blocked")
        ? { kind: "requires-containment", runtime: testRuntime({ contain: async () => { throw new Error("blocked"); } }) }
        : { kind: "contained", receipt: testVerifiedReceiptPath() },
      firstUserEntryAfter: async (path, cursor) => {
        lookups.push(`${path}:${cursor}`);
        if (lookups.length === 1) return testRunId("cafebabe");
        if (lookups.length === 2) return undefined;
        throw new Error("session unavailable");
      },
    }), () => testRuntime());

    expect(evidence.get(uncontainedAgent)?.containment.kind).toBe("uncontained");
    expect(lookups).toEqual([
      `${registry.agents.get(action.agentId)!.sessionPath}:${action.previousLeafId}`,
      `${registry.agents.get(noRunAgent)!.sessionPath}:${action.previousLeafId}`,
      `${registry.agents.get(failedAgent)!.sessionPath}:${action.previousLeafId}`,
    ]);
    expect(evidence.get(action.agentId)?.launchIdentity).toEqual({ kind: "run-found", runId: testRunId("cafebabe") });
    expect(evidence.get(noRunAgent)?.launchIdentity).toEqual({ kind: "no-run" });
    expect(evidence.get(failedAgent)?.launchIdentity).toEqual({ kind: "lookup-failed" });
  });
});

describe("completed output restoration", () => {
  test.each([1, 2] as const)(
    "schema v%s completion beneath a symlinked state root restores its canonical output",
    (schemaVersion) => {
      const state = temporaryStateRoot("restored-completion-symlink-root-");
      try {
        const physicalRoot = join(state.path, "physical-state");
        const logicalRoot = testAbsolutePath(join(state.path, "state"));
        const workDir = testAbsolutePath(join(logicalRoot, "output", "agent-a"));
        const destination = join(workDir, `${testRunId()}.committed`);
        const transcript = join(logicalRoot, "session.jsonl");
        const text = "persisted output";
        mkdirSync(join(physicalRoot, "output", "agent-a"), { recursive: true, mode: 0o700 });
        symlinkSync(physicalRoot, logicalRoot, "dir");
        writeFileSync(destination, text, { mode: 0o600 });
        writeTranscript(transcript, testRunId(), text);
        const decoded = decodeAgentEvent({
          schemaVersion,
          eventType: AgentEventType.RunCompleted,
          payload: {
            agentId: testAgentId(),
            runId: testRunId(),
            state: CompletionState.Completed,
            output: truncateUtf8(text, MAX_COMPLETION_OUTPUT_BYTES),
            outputPath: destination,
            transcriptPath: transcript,
          },
        }, logicalRoot);
        if (decoded.eventType !== AgentEventType.RunCompleted) throw new Error("expected completion");
        const trace: string[] = [];

        const restored = new OutputStore({ workDir, durableFileSystem: tracedDurableFileSystem(trace) })
          .restoreCompletion(decoded.payload, decoded.payload.transcriptPath);

        expect(String(restored.outputPath)).toBe(destination);
        expect(restored.output).toEqual(decoded.payload.output);
        expect(trace).toContain("output:file-sync");
        expect(trace).toContain("output:directory-sync");
        expect(trace).not.toContain("output:write");
        expect(trace).not.toContain("output:rename");
      } finally {
        state.cleanup();
      }
    },
  );

  test("matching managed output is synchronised and promoted without rewriting", () => {
    const state = temporaryStateRoot("restored-completion-match-");
    try {
      const workDir = testAbsolutePath(join(state.path, "output", "agent-a"));
      const transcript = sessionPath(state.path, "session.jsonl");
      const text = "persisted output";
      const candidate = restorableCompletion(workDir, transcript, text);
      writeFileSync(candidate.outputPath, text, { mode: 0o600 });
      writeTranscript(transcript, candidate.runId, text);
      const trace: string[] = [];
      const store = new OutputStore({ workDir, durableFileSystem: tracedDurableFileSystem(trace) });

      const restored: AgentCompletion = store.restoreCompletion(candidate, transcript);

      expect(restored.output).toEqual(candidate.output);
      expect(String(restored.outputPath)).toBe(String(candidate.outputPath));
      expect(trace).toContain("output:file-sync");
      expect(trace).toContain("output:directory-sync");
      expect(trace).not.toContain("output:write");
      expect(trace).not.toContain("output:rename");
    } finally {
      state.cleanup();
    }
  });

  test("canonicalises restored output destinations through the injected filesystem", () => {
    const state = temporaryStateRoot("restored-completion-injected-realpath-");
    try {
      const workDir = testAbsolutePath(join(state.path, "output", "agent-a"));
      const transcript = sessionPath(state.path, "session.jsonl");
      const candidate = restorableCompletion(workDir, transcript, "persisted output");
      writeFileSync(candidate.outputPath, "persisted output", { mode: 0o600 });
      writeTranscript(transcript, candidate.runId, "persisted output");
      const trace: string[] = [];
      const durableFileSystem = {
        ...tracedDurableFileSystem(trace),
        realpath(path: string) {
          trace.push(`realpath:${path}`);
          return systemDurableFileSystem.realpath(path);
        },
      };

      new OutputStore({ workDir, durableFileSystem }).restoreCompletion(candidate, transcript);

      expect(trace.filter((entry) => entry.startsWith("realpath:"))).toHaveLength(2);
    } finally {
      state.cleanup();
    }
  });

  test.each([
    ["missing", "persisted candidate", undefined],
    ["original-byte-mismatching", "persisted candidate", "different visible bytes"],
    ["metadata-mismatching", "persisted candidate", "persisted candidatf"],
    ["invalid-UTF-8", "x", Buffer.from([0xff])],
  ] as const)("%s managed output is reconstructed from the authoritative transcript", (_case, persisted, visible) => {
    const state = temporaryStateRoot("restored-completion-reconstruct-");
    try {
      const workDir = testAbsolutePath(join(state.path, "output", "agent-a"));
      const transcript = sessionPath(state.path, "session.jsonl");
      const authoritative = "authoritative transcript output";
      const candidate = restorableCompletion(workDir, transcript, persisted);
      if (visible !== undefined) writeFileSync(candidate.outputPath, visible, { mode: 0o600 });
      writeTranscript(transcript, candidate.runId, authoritative);
      const trace: string[] = [];
      const store = new OutputStore({ workDir, durableFileSystem: tracedDurableFileSystem(trace) });

      const restored: AgentCompletion = store.restoreCompletion(candidate, transcript);

      expect(restored.output).toEqual(truncateUtf8(authoritative, MAX_COMPLETION_OUTPUT_BYTES));
      expect(String(restored.outputPath)).toBe(String(candidate.outputPath));
      expect(readFileSync(restored.outputPath, "utf8")).toBe(authoritative);
      expect(trace).toContain("output:write");
      expect(trace).toContain("output:rename");
    } finally {
      state.cleanup();
    }
  });

  test("historical full sidecars compare against bounded persisted output metadata", () => {
    const state = temporaryStateRoot("restored-completion-long-");
    try {
      const workDir = testAbsolutePath(join(state.path, "output", "agent-a"));
      const transcript = sessionPath(state.path, "session.jsonl");
      const text = "x".repeat(MAX_COMPLETION_OUTPUT_BYTES + 1_000);
      const candidate = restorableCompletion(workDir, transcript, text);
      writeFileSync(candidate.outputPath, text, { mode: 0o600 });
      writeTranscript(transcript, candidate.runId, text);
      const trace: string[] = [];

      const restored = new OutputStore({ workDir, durableFileSystem: tracedDurableFileSystem(trace) })
        .restoreCompletion(candidate, transcript);

      expect(restored.output).toEqual(truncateUtf8(text, MAX_COMPLETION_OUTPUT_BYTES));
      expect(trace).not.toContain("output:write");
      expect(trace).not.toContain("output:rename");
    } finally {
      state.cleanup();
    }
  });

  test.each([CompletionState.Failed, CompletionState.Cancelled] as const)(
    "authoritative reconstruction preserves %s completion state metadata",
    (completionState) => {
      const state = temporaryStateRoot("restored-completion-state-");
      try {
        const workDir = testAbsolutePath(join(state.path, "output", "agent-a"));
        const transcript = sessionPath(state.path, "session.jsonl");
        const base = restorableCompletion(workDir, transcript, "persisted");
        const usage = {
          turns: 1,
          usage: {
            input: 1,
            output: 2,
            cacheRead: 3,
            cacheWrite: 4,
            totalTokens: 10,
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
          },
        };
        const candidate: RestorableAgentCompletion = completionState === CompletionState.Failed
          ? {
              ...base,
              state: CompletionState.Failed,
              error: { code: "process_exited", message: "child process exited unexpectedly" },
              usage,
            }
          : {
              ...base,
              state: CompletionState.Cancelled,
              reason: CancellationReason.ParentShutdown,
              usage,
            };
        writeTranscript(transcript, candidate.runId, "authoritative");

        const restored = new OutputStore({ workDir }).restoreCompletion(candidate, transcript);

        expect(restored.state).toBe(completionState);
        expect(restored.usage).toEqual(usage);
        if (restored.state === CompletionState.Failed) {
          if (candidate.state !== CompletionState.Failed) throw new Error("expected failed candidate");
          expect(restored.error).toEqual(candidate.error);
        }
        if (restored.state === CompletionState.Cancelled) {
          expect(restored.reason).toBe(CancellationReason.ParentShutdown);
        }
      } finally {
        state.cleanup();
      }
    },
  );

  test("a candidate destination outside the managed output root is rejected", () => {
    const state = temporaryStateRoot("restored-completion-escape-");
    try {
      const workDir = testAbsolutePath(join(state.path, "output", "agent-a"));
      const transcript = sessionPath(state.path, "session.jsonl");
      const candidate = {
        ...restorableCompletion(workDir, transcript, "persisted"),
        outputPath: outputPath(state.path, "outside.committed"),
      };
      writeTranscript(transcript, candidate.runId, "authoritative");

      expect(() => new OutputStore({ workDir }).restoreCompletion(candidate, transcript)).toThrow(/output_error/);
    } finally {
      state.cleanup();
    }
  });

  test.each(["matching", "reconstructed"] as const)(
    "%s completion stays unproved when output synchronisation fails",
    (mode) => {
      const state = temporaryStateRoot("restored-completion-sync-failure-");
      try {
        const workDir = testAbsolutePath(join(state.path, "output", "agent-a"));
        const transcript = sessionPath(state.path, "session.jsonl");
        const candidate = restorableCompletion(workDir, transcript, "persisted");
        if (mode === "matching") writeFileSync(candidate.outputPath, "persisted", { mode: 0o600 });
        writeTranscript(transcript, candidate.runId, mode === "matching" ? "persisted" : "authoritative");
        const failed = tracedDurableFileSystem([], "output:file-sync");

        expect(() => new OutputStore({ workDir, durableFileSystem: failed }).restoreCompletion(candidate, transcript))
          .toThrow(/output_error/);
      } finally {
        state.cleanup();
      }
    },
  );

  test("application reproves a cached historical completion after its destination changes", async () => {
    const state = temporaryStateRoot("restored-completion-cached-history-");
    try {
      const runId = testRunId();
      const agentId = testAgentId();
      const transcript = sessionPath(state.path, "session.jsonl");
      const workDir = testAbsolutePath(join(state.path, "output", agentId));
      const committed = testCommittedOutputPath({ workDir: testAbsolutePath(workDir), runId });
      const candidateOutput = truncateUtf8("", MAX_COMPLETION_OUTPUT_BYTES);
      const registry = foldAgentEvents([
        spawnedEntry({ agentId, sessionPath: transcript, cwd: state.path }, 1),
        launchEntry({ agentId }, 1),
        startedEntry({ agentId, runId }, 1),
        completedEntry({
          agentId,
          runId,
          output: candidateOutput,
          outputPath: committed,
          transcriptPath: transcript,
        }, 1),
      ], TEST_STATE_ROOT);
      const trace: string[] = [];
      let restorationProofs = 0;
      const port = testRestorationPort({
        restoreCompletion: async (record) => {
          restorationProofs++;
          return new OutputStore({ workDir, durableFileSystem: tracedDurableFileSystem(trace) })
            .restoreCompletion(record.completion.payload, record.sessionPath);
        },
      });
      const evidence = await collectRestorationEvidence(registry, port, () => testRuntime());
      const plan = planRestoration(registry, evidence);
      const application = applicationState();
      application.durableCompletions.set(agentRunKey(agentId, runId), completedCompletion({
        agentId,
        runId,
        output: candidateOutput,
        outputPath: committed,
        transcriptPath: transcript,
      }));
      const authoritative = "reconstructed after cache preload";
      writeFileSync(committed, "changed after cache preload", { mode: 0o600 });
      writeTranscript(transcript, runId, authoritative);

      const restored = await applyRestoration(plan, tracedAdmission([]), port, application);

      expect(restorationProofs).toBe(1);
      expect(restored[0]?.completion?.payload.output).toEqual(
        truncateUtf8(authoritative, MAX_COMPLETION_OUTPUT_BYTES),
      );
      expect(readFileSync(committed, "utf8")).toBe(authoritative);
      expect(trace).toContain("output:write");
      expect(trace).toContain("output:rename");
    } finally {
      state.cleanup();
    }
  });

  test("application verifies a contained completion before admission and hides it on proof failure", async () => {
    const trace: string[] = [];
    const registry = foldAgentEvents([spawned(), launch(), started(), completed()], TEST_STATE_ROOT);
    const basePort = testRestorationPort({
      resolveContainment: async () => {
        trace.push("containment:verified");
        return { kind: "contained", receipt: testVerifiedReceiptPath() };
      },
    });
    const proofPort = Object.assign(basePort, {
      restoreCompletion: async (record: FoldedAgentRecord & { completion: NonNullable<FoldedAgentRecord["completion"]> }) => {
        trace.push("completion:verify-or-reconstruct", "output:file-sync", "output:directory-sync");
        return completedCompletion({
          agentId: record.agentId,
          runId: record.completion.payload.runId,
          transcriptPath: record.sessionPath,
        });
      },
    });
    const evidence = await collectRestorationEvidence(registry, proofPort, () => testRuntime());
    const plan = planRestoration(registry, evidence);
    const admission: RestoreAdmission = {
      reserve: () => {},
      replace: () => {},
      commit: () => { trace.push("admission:commit"); },
      release: () => {},
    };

    const restored = await applyRestoration(plan, admission, proofPort, applicationState());

    expect(restored[0]?.completion?.payload.outputPath).toBeDefined();
    expect(trace).toEqual([
      "containment:verified",
      "completion:verify-or-reconstruct",
      "output:file-sync",
      "output:directory-sync",
      "admission:commit",
    ]);

    const failedPort = Object.assign(testRestorationPort(), {
      restoreCompletion: async () => { throw new Error("output sync failed"); },
    });
    const failedState = applicationState();
    const failed = await applyRestoration(plan, tracedAdmission([]), failedPort, failedState);
    expect(failed[0]?.completion).toBeUndefined();
    expect([...failedState.restoredRecords.keys()]).toEqual([testAgentId()]);
  });
});

describe("restoration application", () => {
  test("isolates an unreadable restored completion and retains only its retry obligation", async () => {
    const agentB = testAgentId("agent-b");
    const runB = testRunId("feedface");
    const registry = foldAgentEvents([
      spawned(), launch(), started(), completed(),
      spawnedFor("agent-b", "b.jsonl"), launchFor("agent-b", "attempt-b"),
      startedFor("agent-b", "feedface", "attempt-b"), completedFor("agent-b", "feedface", "b.jsonl"),
    ], TEST_STATE_ROOT);
    const basePort = testRestorationPort();
    const evidence = await collectRestorationEvidence(registry, basePort, () => testRuntime());
    const plan = planRestoration(registry, evidence);
    const attempts: string[] = [];
    const port = testRestorationPort({
      restoreCompletion: async (record) => {
        attempts.push(record.agentId);
        if (record.agentId === testAgentId()) throw new Error("output unreadable");
        return completedCompletion({
          agentId: record.agentId,
          runId: record.completion.payload.runId,
          transcriptPath: record.sessionPath,
        });
      },
    });
    const state = applicationState();

    const restored = await applyRestoration(plan, tracedAdmission([]), port, state);

    expect(attempts).toEqual([testAgentId(), agentB]);
    expect(restored.find((record) => record.agentId === testAgentId())?.completion).toBeUndefined();
    expect(restored.find((record) => record.agentId === agentB)?.completion?.payload.runId).toBe(runB);
    expect([...state.restoredRecords.keys()]).toEqual([testAgentId()]);
  });

  test("applies durable work in transactional order before committing stopped records", async () => {
    const trace: string[] = [];
    const { plan, port: basePort } = await applicationFixture();
    const port = testRestorationPort({
      ...basePort,
      finaliseContained: async (_record, id) => {
        trace.push("finalise:output");
        return completedCompletion({ runId: id });
      },
      appender: new AgentEventAppender((_type, event) => {
        trace.push((event as { eventType: AgentEventType }).eventType === AgentEventType.RunStarted ? "append:run-started" : "append:run-completed");
      }),
    });
    const admission = tracedAdmission(trace);
    const state = applicationState();

    const restored = await applyRestoration(plan, admission, port, state);

    expect(trace).toEqual([
      "reserve",
      "append:run-started",
      "finalise:output",
      "append:run-completed",
      "replace:stopped",
      "commit",
    ]);
    expect(restored).toMatchObject([{ state: AgentState.Stopped, completion: { payload: { runId: testRunId("cafebabe") } } }]);
    expect(state.durableCompletions.has(agentRunKey(testAgentId(), testRunId("cafebabe")))).toBeTrue();
    expect(state.restoredRecords.size).toBe(0);
  });

  test("keeps batch durable phases non-interleaved and installs stopped ownership before commit", async () => {
    const trace: string[] = [];
    const { plan, port: basePort } = await multiApplicationFixture();
    const port = testRestorationPort({
      ...basePort,
      finaliseContained: async (record, id) => {
        trace.push(`finalise:${record.agentId}`);
        return completedCompletion({ agentId: record.agentId, runId: id });
      },
      appender: new AgentEventAppender((_type, event) => {
        const restoredEvent = event as { eventType: AgentEventType; payload: { agentId: string } };
        trace.push(`${restoredEvent.eventType === AgentEventType.RunStarted ? "start" : "complete"}:${restoredEvent.payload.agentId}`);
      }),
    });
    const restoredRecords = new Map(plan.obligations);
    const remove = restoredRecords.delete.bind(restoredRecords);
    restoredRecords.delete = (agentIdValue) => {
      trace.push(`ownership:stopped:${agentIdValue}`);
      return remove(agentIdValue);
    };
    const state: RestorationApplicationState = {
      durableCompletions: new Map(),
      restoredStartedAppends: new Set(),
      restoredRecords,
    };
    const admission: RestoreAdmission = {
      reserve: () => { trace.push("reserve"); },
      replace: (record) => { trace.push(`replace:${record.agentId}`); },
      commit: () => { trace.push("commit"); },
      release: () => {},
    };

    await applyRestoration(plan, admission, port, state);

    expect(trace).toEqual([
      "reserve",
      `start:${testAgentId()}`,
      `start:${testAgentId("agent-b")}`,
      `finalise:${testAgentId()}`,
      `finalise:${testAgentId("agent-b")}`,
      `complete:${testAgentId()}`,
      `complete:${testAgentId("agent-b")}`,
      `replace:${testAgentId()}`,
      `replace:${testAgentId("agent-b")}`,
      `ownership:stopped:${testAgentId()}`,
      `ownership:stopped:${testAgentId("agent-b")}`,
      "commit",
    ]);
    expect(restoredRecords.size).toBe(0);
  });

  test("a post-reserve failure commits every terminal obligation and reports the planned inventory", async () => {
    const trace: string[] = [];
    const failure = new Error("output unavailable");
    const { plan, port: basePort } = await applicationFixture();
    const port = testRestorationPort({
      ...basePort,
      finaliseContained: async () => { trace.push("finalise:output"); throw failure; },
      appender: new AgentEventAppender((_type, event) => {
        trace.push((event as { eventType: AgentEventType }).eventType === AgentEventType.RunStarted ? "append:run-started" : "append:run-completed");
      }),
    });
    const state = applicationState();

    const error = await applyRestoration(plan, tracedAdmission(trace), port, state).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(RestorationApplicationError);
    expect((error as RestorationApplicationError).cause).toBe(failure);
    expect((error as RestorationApplicationError).restored).not.toBe(plan.restored);
    expect((error as RestorationApplicationError).restored.every((record) => record.completion === undefined))
      .toBeTrue();
    expect(trace).toEqual(["reserve", "append:run-started", "finalise:output", "commit"]);
    expect([...state.restoredRecords.keys()]).toEqual([...plan.obligations.keys()]);
  });

  test("a RunStarted append failure retains the original record, capacity, and obligation", async () => {
    const failure = new Error("start append unavailable");
    const trace: string[] = [];
    const { plan, port: basePort } = await applicationFixture();
    const port = testRestorationPort({
      ...basePort,
      finaliseContained: async () => { throw new Error("must not finalise"); },
      appender: new AgentEventAppender((_type, event) => {
        trace.push((event as { eventType: AgentEventType }).eventType);
        throw failure;
      }),
    });
    let active = 0;
    let committed: readonly { state: AgentState }[] = [];
    const admission: RestoreAdmission = {
      reserve: (records) => { active = [...records].filter((record) => record.state !== AgentState.Stopped).length; },
      replace: () => { throw new Error("must not replace"); },
      commit: () => { committed = plan.runtimeRecords; },
      release: () => {},
    };
    const state = applicationState();

    const error = await applyRestoration(plan, admission, port, state).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(RestorationApplicationError);
    expect((error as RestorationApplicationError).cause).toBe(failure);
    expect(trace).toEqual([AgentEventType.RunStarted]);
    expect(active).toBe(1);
    expect(committed).toBe(plan.runtimeRecords);
    expect([...state.restoredRecords.keys()]).toEqual([...plan.obligations.keys()]);
  });

  test("a replacement failure rolls earlier replacements back before committing retained obligations", async () => {
    const { plan, port } = await multiApplicationFixture();
    const state = applicationState();
    const failure = new Error("second replacement unavailable");
    const staged = new Map<string, (typeof plan.runtimeRecords)[number]>();
    const trace: string[] = [];
    let active = 0;
    let committed: readonly (typeof plan.runtimeRecords)[number][] = [];
    const admission: RestoreAdmission = {
      reserve: (records) => {
        for (const record of records) staged.set(record.agentId, record);
        active = [...staged.values()].filter((record) => record.state !== AgentState.Stopped).length;
      },
      replace: (record) => {
        trace.push(`replace:${record.agentId}:${record.state}`);
        if (record.agentId === testAgentId("agent-b") && record.state === AgentState.Stopped) throw failure;
        const previous = staged.get(record.agentId)!;
        if (previous.state !== AgentState.Stopped && record.state === AgentState.Stopped) active--;
        if (previous.state === AgentState.Stopped && record.state !== AgentState.Stopped) active++;
        staged.set(record.agentId, record);
      },
      commit: () => { trace.push("commit"); committed = [...staged.values()]; },
      release: () => {},
    };

    const error = await applyRestoration(plan, admission, port, state).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(RestorationApplicationError);
    expect((error as RestorationApplicationError).cause).toBe(failure);
    expect(trace).toEqual([
      `replace:${testAgentId()}:stopped`,
      `replace:${testAgentId("agent-b")}:stopped`,
      `replace:${testAgentId()}:settling`,
      "commit",
    ]);
    expect(active).toBe(2);
    expect(committed).toEqual(plan.runtimeRecords);
    expect([...state.restoredRecords.keys()]).toEqual([...plan.obligations.keys()]);
    expect(committed.every((record) => record.state !== AgentState.Stopped && state.restoredRecords.has(record.agentId))).toBeTrue();
  });

  test("a rollback failure skips recovery commit and preserves both application and rollback causes", async () => {
    const { plan, port } = await multiApplicationFixture();
    const state = applicationState();
    const original = new Error("second replacement unavailable");
    const recovery = new Error("rollback replacement unavailable");
    let commits = 0;
    const admission: RestoreAdmission = {
      reserve: () => {},
      replace: (record) => {
        if (record.agentId === testAgentId("agent-b") && record.state === AgentState.Stopped) throw original;
        if (record.agentId === testAgentId() && record.state !== AgentState.Stopped) throw recovery;
      },
      commit: () => { commits++; },
      release: () => {},
    };

    const error = await applyRestoration(plan, admission, port, state).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(RestorationApplicationError);
    expect((error as RestorationApplicationError).cause).toBe(original);
    expect((error as RestorationApplicationError).recoveryCause).toBe(recovery);
    expect((error as RestorationApplicationError).admissionCommitted).toBeFalse();
    expect(commits).toBe(0);
    expect([...state.restoredRecords.keys()]).toEqual([...plan.obligations.keys()]);
  });

  test("a recovery commit failure preserves application classification and the original commit cause", async () => {
    const { plan, port } = await applicationFixture();
    const state = applicationState();
    const original = new Error("normal commit unavailable");
    const recovery = new Error("recovery commit unavailable");
    let commits = 0;
    const admission: RestoreAdmission = {
      reserve: () => {},
      replace: () => {},
      commit: () => { throw ++commits === 1 ? original : recovery; },
      release: () => {},
    };

    const error = await applyRestoration(plan, admission, port, state).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(RestorationApplicationError);
    expect((error as RestorationApplicationError).cause).toBe(original);
    expect((error as RestorationApplicationError & { recoveryCause?: unknown }).recoveryCause).toBe(recovery);
    expect((error as RestorationApplicationError & { admissionCommitted?: boolean }).admissionCommitted).toBeFalse();
    expect(commits).toBe(2);
    expect([...state.restoredRecords.keys()]).toEqual([...plan.obligations.keys()]);
  });

  test("a staged retry reuses durable work without duplicate appends or stale stopped obligations", async () => {
    const { plan, port: basePort } = await applicationFixture();
    let starts = 0;
    let completionAttempts = 0;
    let finalisations = 0;
    const port = testRestorationPort({
      ...basePort,
      finaliseContained: async (_record, id) => {
        finalisations++;
        return completedCompletion({ runId: id });
      },
      appender: new AgentEventAppender((_type, event) => {
        const eventType = (event as { eventType: AgentEventType }).eventType;
        if (eventType === AgentEventType.RunStarted) starts++;
        if (eventType === AgentEventType.RunCompleted && ++completionAttempts === 1) throw new Error("disk unavailable");
      }),
    });
    const state = applicationState();

    await expect(applyRestoration(plan, tracedAdmission([]), port, state)).rejects.toBeInstanceOf(RestorationApplicationError);
    await expect(applyRestoration(plan, tracedAdmission([]), port, state)).resolves.toMatchObject([{ state: AgentState.Stopped }]);

    expect({ starts, completionAttempts, finalisations }).toEqual({ starts: 1, completionAttempts: 2, finalisations: 1 });
    expect(state.restoredRecords.size).toBe(0);
  });

  test("a reserve failure escapes raw without committing or installing obligations", async () => {
    const failure = new Error("reserve unavailable");
    const { plan, port } = await applicationFixture();
    const state = applicationState();
    const admission: RestoreAdmission = {
      reserve: () => { throw failure; },
      replace: () => { throw new Error("must not replace"); },
      commit: () => { throw new Error("must not commit"); },
      release: () => {},
    };

    const error = await applyRestoration(plan, admission, port, state).catch((caught: unknown) => caught);

    expect(error).toBe(failure);
    expect(error).not.toBeInstanceOf(RestorationApplicationError);
    expect(state.restoredRecords.size).toBe(0);
    expect(state.durableCompletions.size).toBe(0);
  });
});

describe("branch restoration", () => {
  test("a missing non-null restoration cursor is session unavailable and never scans from zero", () => {
    const entries = [{ id: "deadbeef", type: "message", message: { role: "user" } }];
    // malformed trust-boundary fixture: Pi entry decoding must reject this incomplete wire value.
    const malformedEntries = entries as unknown as SessionEntry[];
    expect(() => firstUserEntryAfterCursor(malformedEntries, testRunId("cafebabe"))).toThrow("session_unavailable");
  });
  test("receipt decision completes before shutdown", async () => {
    const deciding = testBarrier("receipt-decision-first");
    let completeDecision!: () => void;
    const decisionCompleted = new Promise<void>((resolve) => { completeDecision = resolve; });
    const writes: unknown[] = [], pings: unknown[] = [];
    const order: string[] = [];
    let validations = 0;
    const restoration = port([spawned(), launch(), started()], false, writes);
    // The first decision is the restoration receipt; later calls are the shutdown containment retry.
    restoration.validateReceipt = async () => {
      if (++validations > 1) return true;
      await deciding.enterAndWait();
      return false;
    };
    const resolveContainment = restoration.resolveContainment.bind(restoration);
    restoration.resolveContainment = async (input) => {
      const decision = await resolveContainment(input);
      order.push("receipt-decision:constructed");
      completeDecision();
      return decision;
    };
    const c = new SubagentController({ restoration, parent: { isBusy: () => false, sendMessage: async (_text, options) => { pings.push(options); } } });

    // Minimal pair with the row below: the decision is released *before* shutdown starts,
    // but shutdown still overlaps the in-flight restoration — it must join it, not race it.
    const restoring = c.restore();
    await deciding.entered;
    expect(validations).toBe(1);
    deciding.release();
    await decisionCompleted;
    order.push("shutdown:started");
    const shuttingDown = c.shutdown();
    await Promise.all([restoring, shuttingDown]);

    expect(order).toEqual(["receipt-decision:constructed", "shutdown:started"]);
    expect({ validations, writes: writes.length, active: c.runs.activeCount(), queued: c.completions.queuedCount(), pings: pings.length })
      .toEqual({ validations: 2, writes: 1, active: 0, queued: 1, pings: 0 });
    expect(c.runs.snapshots()).toMatchObject([{ state: "stopped" }]);
  });

  test("shutdown starts before receipt decision", async () => {
    const deciding = testBarrier("receipt-decision");
    const writes: unknown[] = [], pings: unknown[] = [];
    let validations = 0;
    const restoration = port([spawned(), launch(), started()], false, writes);
    restoration.validateReceipt = async () => {
      if (++validations > 1) return true;
      await deciding.enterAndWait();
      return false;
    };
    const c = new SubagentController({ restoration, parent: { isBusy: () => false, sendMessage: async (_text, options) => { pings.push(options); } } });

    const restoring = c.restore();
    await deciding.entered;
    const shuttingDown = c.shutdown();
    deciding.release();
    await Promise.all([restoring, shuttingDown]);

    expect({ validations, writes: writes.length, active: c.runs.activeCount(), queued: c.completions.queuedCount(), pings: pings.length })
      .toEqual({ validations: 2, writes: 1, active: 0, queued: 1, pings: 0 });
    expect(c.runs.snapshots()).toMatchObject([{ state: "stopped" }]);
  });

  test("restoration stages before shutdown and commits", async () => {
    const committing = testBarrier("restore-commit");
    const writes: unknown[] = [], pings: unknown[] = [];
    const restoration = port([spawned(), launch(), started()], true, writes);
    const appendCompleted = restoration.appender.appendRunCompleted.bind(restoration.appender);
    restoration.appender.appendRunCompleted = async (completion) => {
      await committing.enterAndWait();
      return appendCompleted(completion);
    };
    const c = new SubagentController({ restoration, parent: { isBusy: () => false, sendMessage: async (_text, options) => { pings.push(options); } } });

    const restoring = c.restore();
    await committing.entered;
    const shuttingDown = c.shutdown();
    committing.release();
    await Promise.all([restoring, shuttingDown]);

    expect(writes.map((value) => (value as { eventType: string }).eventType)).toEqual([AgentEventType.RunCompleted]);
    expect({ active: c.runs.activeCount(), queued: c.completions.queuedCount(), pings: pings.length })
      .toEqual({ active: 0, queued: 1, pings: 0 });
    expect(c.runs.snapshots()).toMatchObject([{ state: "stopped" }]);
  });

  test("restoration stages before shutdown and rolls back", async () => {
    const committing = testBarrier("restore-commit-rollback");
    const writes: unknown[] = [], pings: unknown[] = [];
    let attempts = 0;
    const restoration = port([spawned(), launch(), started()], true, writes);
    const appendCompleted = restoration.appender.appendRunCompleted.bind(restoration.appender);
    restoration.appender.appendRunCompleted = async (completion) => {
      if (++attempts > 1) return appendCompleted(completion);
      await committing.enterAndWait();
      throw new Error("disk unavailable");
    };
    const c = new SubagentController({ restoration, parent: { isBusy: () => false, sendMessage: async (_text, options) => { pings.push(options); } } });

    const restoring = c.restore();
    await committing.entered;
    const shuttingDown = c.shutdown();
    committing.release();

    await expect(restoring).rejects.toThrow("disk unavailable");
    await expect(shuttingDown).resolves.toBeUndefined();
    expect(writes.map((value) => (value as { eventType: string }).eventType)).toEqual([AgentEventType.RunCompleted]);
    expect({ attempts, active: c.runs.activeCount(), queued: c.completions.queuedCount(), pings: pings.length })
      .toEqual({ attempts: 2, active: 0, queued: 1, pings: 0 });
    expect(c.runs.snapshots()).toMatchObject([{ state: "stopped" }]);
  });

  test("restore requested after shutdown rejects without reading the branch", async () => {
    let reads = 0;
    const restoration = port([], true, []);
    restoration.getBranch = () => { reads++; return []; };
    const c = new SubagentController({ restoration });
    await c.shutdown();
    await expect(c.restore()).rejects.toThrow("invalid_state:");
    expect(reads).toBe(0);
  });

  test("restores a clean stopped agent without requiring a receipt", async () => {
    const c = new SubagentController({ restoration: port([spawned()], true, []) });
    await c.restore();
    expect(c.runs.snapshots()).toMatchObject([{ state: "stopped" }]);
    expect(completionArray(await c.awaitReady())).toEqual([]);
  });

  test("receipt-gates interrupted runs, persists one failure, and reconstructs capacity", async () => {
    const writes: unknown[] = [];
    const branch = [spawned(), launch(), started()];
    const c = new SubagentController({ capacity: runCapacity(1), restoration: port(branch, true, writes) });
    await c.restore();
    expect(c.runs.activeCount()).toBe(0);
    const received = await c.awaitReady();
    expect(completionArray(received)[0]?.runId as string | undefined).toBe("deadbeef");
    expect(completionArray(received)[0]?.state).toBe("failed");
    expect(writes).toHaveLength(1);
  });

  test("orders restored completion persistence after durable output finalisation", async () => {
    const trace: string[] = [];
    const writes: unknown[] = [];
    const restoration = port([spawned(), launch(), started()], true, writes);
    restoration.validateReceipt = async () => { trace.push("receipt:verified"); return true; };
    restoration.finaliseContained = async (_record, id) => {
      trace.push("transcript:recovered", "output:file-sync", "output:rename", "output:directory-sync");
      return { ...completedCompletion({ runId: id }), state: CompletionState.Failed, error: { code: "run_interrupted", message: "run was interrupted before completion" } };
    };
    const append = restoration.appender.appendRunCompleted.bind(restoration.appender);
    restoration.appender.appendRunCompleted = async (completion) => { trace.push("persist:run-completed"); await append(completion); };

    const c = new SubagentController({ restoration });
    await c.restore();

    expect(trace).toEqual([
      "receipt:verified",
      "transcript:recovered",
      "output:file-sync",
      "output:rename",
      "output:directory-sync",
      "persist:run-completed",
    ]);
  });

  test("retains restored terminal ownership and capacity when durable finalisation fails, then retries", async () => {
    const writes: unknown[] = [];
    const restoration = port([spawned(), launch(), started()], true, writes);
    const finalise = restoration.finaliseContained;
    let attempts = 0;
    restoration.finaliseContained = async (...args) => {
      if (++attempts === 1) throw new Error("publication failed");
      return finalise(...args);
    };
    const c = new SubagentController({ capacity: runCapacity(1), restoration });

    await expect(c.restore()).rejects.toThrow("publication failed");
    expect(c.runs.snapshot(testAgentId("agent-a"))?.state).toBe("settling");
    expect(c.runs.activeCount()).toBe(1);
    expect(writes).toEqual([]);
    expect(completionArray(await c.awaitReady({ timeoutMs: testMilliseconds(1) }))).toEqual([]);

    await c.stop(testAgentId("agent-a"));
    expect(c.runs.activeCount()).toBe(0);
    expect(writes).toHaveLength(1);
    expect(completionArray(await c.awaitReady())).toHaveLength(1);
  });

  test("unresolved v1 launch retains historical responsibility without inspecting native identity", async () => {
    const warnings: string[] = [];
    let identityLookups = 0;
    const restoration = port([spawned(), launch()], false, []);
    restoration.firstUserEntryAfter = async () => { identityLookups++; return testRunId("cafebabe"); };
    const c = new SubagentController({
      capacity: runCapacity(1),
      restoration,
      parent: { isBusy: () => false, sendMessage: async () => {}, warn: (message) => warnings.push(message) },
    });

    await c.restore();

    expect(c.runs.snapshot(testAgentId("agent-a"))).toMatchObject({
      state: "stopping",
      containmentResponsibility: "historical-unresolved",
    });
    expect(c.runs.activeCount()).toBe(1);
    expect(identityLookups).toBe(0);
    expect(warnings).toHaveLength(1);
  });

  test("unresolved v2 started work contains immediately and retains capacity until retry succeeds", async () => {
    const writes: unknown[] = [];
    const branch = [spawned(), launchV2(), started()];
    const restoration = port(branch, false, writes);
    let containmentAttempts = 0;
    restoration.resolveContainment = async (input) => {
      expect(input.eventVersion).toBe(2);
      expect(input.descriptor?.backend).toBe("cgroup-v2");
      expect(String(input.descriptor?.scopePath)).toBe(
        String(testContainmentAttempt(testAttemptId("attempt")).descriptor.scopePath),
      );
      return {
        kind: "requires-containment",
        runtime: {
          abort: async () => {},
          contain: async () => {
            containmentAttempts++;
            if (containmentAttempts === 1) throw new Error("cgroup kill failed");
            return testVerifiedReceiptPath(input.receiptPath);
          },
        },
      };
    };
    const c = new SubagentController({ capacity: runCapacity(1), restoration });

    await c.restore();
    expect(containmentAttempts).toBe(1);
    expect(c.runs.activeCount()).toBe(1);
    expect(c.runs.snapshot(testAgentId("agent-a"))?.state).toBe("settling");

    await c.stop(testAgentId("agent-a"));
    expect(containmentAttempts).toBe(2);
    expect(c.runs.activeCount()).toBe(0);
    expect(writes).toHaveLength(1);
  });

  test("missing receipt retains non-resumable state and capacity without completion", async () => {
    const writes: unknown[] = [];
    const c = new SubagentController({ capacity: runCapacity(1), restoration: port([spawned(), launch(), started()], false, writes) });
    await c.restore();
    expect(c.runs.activeCount()).toBe(1);
    expect(c.runs.snapshots()[0]?.state).toBe("settling");
    expect(writes).toEqual([]);
  });

  test("unmatched launch uses the first native user entry after its cursor", async () => {
    const writes: unknown[] = [];
    const c = new SubagentController({ restoration: port([spawned(), launch()], true, writes, testRunId("cafebabe")) });
    await c.restore();
    const received = await c.awaitReady();
    expect(completionArray(received)[0]?.runId as string | undefined).toBe("cafebabe");
    expect(writes).toHaveLength(2);
  });

  test("an unaccepted unmatched launch becomes stopped only after its matching receipt", async () => {
    const writes: unknown[] = [];
    const seen: string[] = [];
    const c = new SubagentController({ restoration: port([spawned(), launch()], true, writes, undefined, seen) });
    await c.restore();
    expect(c.runs.snapshots()[0]?.state).toBe("stopped");
    expect(c.runs.activeCount()).toBe(0);
    expect(writes).toEqual([]);
    expect(seen).toEqual(["attempt"]);
  });

  for (const reason of [CancellationReason.StopRequested, CancellationReason.ParentShutdown]) {
    test(`restores unmatched stopping as ${reason} cancellation`, async () => {
      const writes: unknown[] = [];
      const c = new SubagentController({ restoration: port([spawned(), launch(), started(), stopping(reason)], true, writes) });
      await c.restore();
      expect(completionArray(await c.awaitReady())).toMatchObject([{ state: "cancelled", reason }]);
      expect(writes).toHaveLength(1);
      expect(c.runs.activeCount()).toBe(0);
    });
  }

  test("re-exposes only the latest completion without a restoration ping", async () => {
    const pings: unknown[] = [];
    const branch = [spawned(), launch(), started(), completed("deadbeef"), launch("attempt-2"), started("feedface", "attempt-2"), completed("feedface")];
    const c = new SubagentController({ restoration: port(branch, true, []), parent: { isBusy: () => false, sendMessage: async (_text, options) => { pings.push(options); } } });
    await c.restore();
    expect(completionArray(await c.awaitReady()).map((value) => value.runId as string)).toEqual(["feedface"]);
    expect(pings).toEqual([]);
  });

  test("invalid latest-completion receipt retains capacity and does not expose completion", async () => {
    const warnings: string[] = [];
    const c = new SubagentController({ capacity: runCapacity(1), restoration: port([spawned(), launch(), started(), completed()], false, []), parent: { isBusy: () => false, sendMessage: async () => {}, warn: (message) => warnings.push(message) } });
    await c.restore();
    expect(c.runs.activeCount()).toBe(1);
    expect(completionArray(await c.awaitReady({ timeoutMs: testMilliseconds(1) }))).toEqual([]);
    expect(warnings[0]).toContain("containment_failed");
  });

  test.each([
    ["version 1", 1 as const],
    ["version 2", 2 as const],
  ])("invalid-then-valid completed %s receipt restores the durable completion exactly once", async (_label, version) => {
    const writes: unknown[] = [];
    const branch = version === 1
      ? [spawned(), launch(), started(), completed()]
      : [spawned(), launchV2(), startedV2(), completedV2()];
    const restoration = port(branch, false, writes);
    let receiptValid = false;
    let resolutions = 0;
    let failedContainments = 0;
    let finalisations = 0;
    let completionRestorations = 0;
    let releases = 0;
    restoration.resolveContainment = async (input) => {
      resolutions++;
      expect(input.eventVersion).toBe(version);
      expect(input.descriptor?.backend).toBe(version === 2 ? "cgroup-v2" : undefined);
      if (receiptValid) return { kind: "contained", receipt: testVerifiedReceiptPath(input.receiptPath) };
      const runtime = {
        abort: async () => {},
        contain: async () => { failedContainments++; throw new Error("receipt unavailable"); },
      };
      return version === 1
        ? { kind: "unresolved-historical", runtime }
        : { kind: "requires-containment", runtime };
    };
    restoration.finaliseContained = async () => {
      finalisations++;
      throw new Error("must not fabricate an already-durable completion");
    };
    const restoreCompletion = restoration.restoreCompletion;
    restoration.restoreCompletion = async (...args) => {
      completionRestorations++;
      return restoreCompletion(...args);
    };
    const c = new SubagentController({
      capacity: runCapacity(1),
      restoration,
      onStatusChange: () => { releases++; },
    });

    await c.restore();

    expect(c.runs.activeCount()).toBe(1);
    expect(c.runs.snapshot(testAgentId("agent-a"))?.state).toBe("settling");
    expect(completionArray(await c.awaitReady({ timeoutMs: testMilliseconds(1) }))).toEqual([]);
    let resumed = false;
    await expect(c.runs.launch(testAgentId("agent-a"), async () => {
      resumed = true;
      throw new Error("must not resume");
    })).rejects.toThrow("invalid_state:");
    expect(resumed).toBeFalse();

    receiptValid = true;
    await Promise.all([
      c.stop(testAgentId("agent-a")),
      c.stop(testAgentId("agent-a")),
    ]);

    expect(resolutions).toBe(2);
    expect(failedContainments).toBe(version === 2 ? 1 : 0);
    expect(finalisations).toBe(0);
    expect(completionRestorations).toBe(1);
    expect(writes).toEqual([]);
    expect(releases).toBe(1);
    expect(c.runs.activeCount()).toBe(0);
    const restored = await c.awaitReady();
    expect(completionArray(restored)).toMatchObject([{
      agentId: testAgentId("agent-a"),
      runId: testRunId("deadbeef"),
      state: CompletionState.Completed,
      output: { text: "", originalBytes: 0, retainedBytes: 0, truncated: false },
    }]);
    expect(completionArray(await c.awaitReady())).toEqual([]);
  });

  test("receipt validation errors retain nonterminal state", async () => {
    const warnings: string[] = [];
    const restoration = port([spawned(), launch()], true, []);
    restoration.validateReceipt = async () => { throw new Error("malformed receipt"); };
    const c = new SubagentController({ restoration, parent: { isBusy: () => false, sendMessage: async () => {}, warn: (message) => warnings.push(message) } });
    await c.restore();
    expect(c.runs.activeCount()).toBe(1);
    expect(warnings[0]).toContain("containment_failed");
  });

  test("an unmatched launch with a later valid receipt finishes pre-native containment without a completion", async () => {
    const writes: unknown[] = [];
    let valid = false;
    const restoration = port([spawned(), launch()], false, writes);
    restoration.validateReceipt = async () => valid;
    const c = new SubagentController({ capacity: runCapacity(1), restoration });
    await c.restore();
    expect(await c.stop(testAgentId("agent-a"))).toMatchObject({ state: "failed", agentState: "stopping" });
    valid = true;
    await Promise.all([c.stop(testAgentId("agent-a")), c.shutdown()]);
    expect(c.runs.snapshots()).toMatchObject([{ agentId: testAgentId("agent-a"), state: "stopped", transcriptPath: "/tmp/pi-subagents-test/a.jsonl" }]);
    expect(c.runs.activeCount()).toBe(0);
    expect(writes).toEqual([]);
    expect(completionArray(await c.awaitReady())).toEqual([]);
  });

  test("receipt-false-then-true reconciles a historical pre-native cursor and releases capacity", async () => {
    const writes: unknown[] = [];
    let valid = false;
    let cursorReconciliations = 0;
    let restoredFinalisations = 0;
    let liveFinalisations = 0;
    const restoration = port([spawned(), launch()], false, writes, testRunId("cafebabe"));
    restoration.validateReceipt = async () => valid;
    const firstUserEntryAfter = restoration.firstUserEntryAfter;
    restoration.firstUserEntryAfter = async (...args) => {
      cursorReconciliations++;
      return firstUserEntryAfter(...args);
    };
    const finaliseContained = restoration.finaliseContained;
    restoration.finaliseContained = async (...args) => {
      restoredFinalisations++;
      return finaliseContained(...args);
    };
    const c = new SubagentController({ capacity: runCapacity(1), restoration, composition: {
      prepareSpawn: async () => { throw new Error("unused"); },
      prepareSend: async () => { throw new Error("unused"); },
      finaliseRun: async () => { liveFinalisations++; throw new Error("must not use live finalisation"); },
    } });

    await c.restore();
    expect(c.runs.snapshot(testAgentId("agent-a"))?.state).toBe("stopping");
    expect(c.runs.activeCount()).toBe(1);
    expect(cursorReconciliations).toBe(0);

    valid = true;
    await c.stop(testAgentId("agent-a"));

    expect(c.runs.snapshot(testAgentId("agent-a"))).toMatchObject({ state: "stopped", runId: testRunId("cafebabe") });
    expect(c.runs.activeCount()).toBe(0);
    expect(cursorReconciliations).toBe(1);
    expect(restoredFinalisations).toBe(1);
    expect(liveFinalisations).toBe(0);
    expect(writes.map((value) => (value as { eventType: string }).eventType)).toEqual([
      AgentEventType.RunStarted,
      AgentEventType.RunCompleted,
    ]);
    expect(completionArray(await c.awaitReady())).toMatchObject([{ state: "failed", runId: "cafebabe" }]);
  });

  test("a later valid receipt finalises a restored settling run exactly once", async () => {
    const writes: unknown[] = [];
    let valid = false;
    const restoration = port([spawned(), launch(), started()], false, writes);
    restoration.validateReceipt = async () => valid;
    const c = new SubagentController({ capacity: runCapacity(1), restoration });
    await c.restore();
    expect(await c.stop(testAgentId("agent-a"))).toMatchObject({ state: "failed", agentState: "settling", error: { code: "containment_failed" } });
    expect(writes).toHaveLength(0);
    valid = true;
    expect(await c.stop(testAgentId("agent-a"))).toMatchObject({ state: "already_stopped" });
    expect(writes).toHaveLength(1);
    expect(completionArray(await c.awaitReady())).toMatchObject([{ state: "failed", runId: "deadbeef" }]);
    expect(c.runs.activeCount()).toBe(0);
  });

  test("an unavailable child session after verified containment retains nonterminal state", async () => {
    const warnings: string[] = [];
    const restoration = port([spawned(), launch()], true, []);
    restoration.firstUserEntryAfter = async () => { throw new Error("session unavailable"); };
    const c = new SubagentController({ restoration, parent: { isBusy: () => false, sendMessage: async () => {}, warn: (message) => warnings.push(message) } });
    await c.restore();
    expect(c.runs.activeCount()).toBe(1);
    expect(c.runs.snapshots()[0]?.state).toBe("stopping");
    expect(warnings[0]).toContain("containment_failed");
  });

  test("waits for the bounded receipt decision before retaining capacity", async () => {
    let decide!: (valid: boolean) => void;
    const barrier = new Promise<boolean>((resolve) => { decide = resolve; });
    const restoration = port([spawned(), launch(), started()], true, []);
    restoration.validateReceipt = async () => barrier;
    const c = new SubagentController({ restoration });
    const restoring = c.restore();
    expect(c.runs.snapshots()).toEqual([]);
    decide(false);
    await restoring;
    expect(c.runs.activeCount()).toBe(1);
  });

  test("a reserve failure retains the controller's folded branch snapshot on retry", async () => {
    const conflictingBranch = [spawned()];
    let reads = 0;
    const restoration = port(conflictingBranch, true, []);
    restoration.getBranch = () => { reads++; return []; };
    const c = new SubagentController({ restoration });
    c.runs.register({ agentId: testAgentId(), state: AgentState.Stopped, transcriptPath: testSessionPath() });

    await expect(c.restore()).rejects.toThrow("invalid_agent:");
    await expect(c.restore()).rejects.toThrow("invalid_agent:");

    expect(reads).toBe(0);
    expect(c.runs.snapshots()).toHaveLength(1);
  });

  test("repeated restore is idempotent and sends no parent message", async () => {
    const writes: unknown[] = [];
    const pings: unknown[] = [];
    const c = new SubagentController({
      restoration: port([spawned(), launch(), started()], true, writes),
      parent: { isBusy: () => false, sendMessage: async (_text, options) => { pings.push(options); } },
    });
    await c.restore();
    await c.restore();
    expect(writes).toHaveLength(1);
    expect(c.runs.activeCount()).toBe(0);
    expect(completionArray(await c.awaitReady())).toMatchObject([{ agentId: testAgentId(), runId: testRunId("deadbeef") }]);
    expect(pings).toEqual([]);
  });

  test("a restore retry sends no parent message after preserving durable work", async () => {
    const writes: unknown[] = [];
    const pings: unknown[] = [];
    let completionAttempts = 0;
    const restoration = port([
      spawned(), launch(),
      spawnedFor("agent-b", "/tmp/b.jsonl"), launchFor("agent-b", "attempt-b"), startedFor("agent-b", "feedface", "attempt-b"),
      completedEntry({
        agentId: testAgentId("agent-b"), runId: testRunId("feedface"),
        transcriptPath: testSessionPath("/tmp/pi-subagents-test/b.jsonl"),
        outputPath: testCommittedOutputPath({
          workDir: testAbsolutePath("/tmp/pi-subagents-test/output/agent-b"),
          runId: testRunId("feedface"),
        }), output: truncateUtf8("ready", utf8Bytes(50_000)),
      }, 1),
    ], true, writes, testRunId("cafebabe"));
    const appendCompleted = restoration.appender.appendRunCompleted.bind(restoration.appender);
    restoration.appender.appendRunCompleted = async (completion) => {
      if (++completionAttempts === 1) throw new Error("disk unavailable");
      return appendCompleted(completion);
    };
    const c = new SubagentController({ capacity: runCapacity(1), restoration, parent: {
      isBusy: () => false,
      sendMessage: async (_text, options) => { pings.push(options); },
    } });

    await expect(c.restore()).rejects.toThrow("disk unavailable");
    expect(c.runs.snapshot(testAgentId())?.state).toBe("settling");
    expect(c.runs.activeCount()).toBe(1);
    pings.length = 0;

    await c.stop(testAgentId());
    expect(c.runs.activeCount()).toBe(0);
    expect(writes.map((value) => (value as { eventType: string }).eventType)).toEqual([AgentEventType.RunStarted, AgentEventType.RunCompleted]);
    pings.length = 0;

    await c.restore();
    expect(pings).toEqual([]);
    expect((await c.awaitReady()).completion?.runId).toBe(testRunId("feedface"));
    expect((await c.awaitReady()).completion?.runId).toBe(testRunId("cafebabe"));
  });

  test("a second restore caller joins the in-flight receipt decision and shares one durable record, reservation, and completion", async () => {
    let validations = 0;
    const deciding = testBarrier("shared-receipt-decision");
    const writes: unknown[] = [], pings: unknown[] = [];
    const restoration = port([spawned(), launch(), started()], true, writes);
    restoration.validateReceipt = async () => { validations++; await deciding.enterAndWait(); return true; };
    const c = new SubagentController({ restoration, parent: {
      isBusy: () => false,
      sendMessage: async (_text, options) => { pings.push(options); },
    } });

    const first = c.restore();
    await deciding.entered;
    const second = c.restore();
    deciding.release();
    await Promise.all([first, second]);

    expect(validations).toBe(1);
    expect(writes).toHaveLength(1);
    expect(c.runs.snapshots()).toHaveLength(1);
    expect(c.runs.activeCount()).toBe(0);
    expect(c.completions.queuedCount()).toBe(1);
    expect(pings).toEqual([]);
  });

  test("restore failure clears the in-flight promise and retry does not duplicate durable appends", async () => {
    const writes: unknown[] = [];
    let completionAttempts = 0;
    const restoration = port([spawned(), launch()], true, writes, testRunId("cafebabe"));
    const appendCompleted = restoration.appender.appendRunCompleted.bind(restoration.appender);
    restoration.appender.appendRunCompleted = async (completion) => {
      completionAttempts++;
      if (completionAttempts === 1) throw new Error("disk unavailable");
      return appendCompleted(completion);
    };
    const c = new SubagentController({ restoration });
    await expect(Promise.all([c.restore(), c.restore()])).rejects.toThrow("disk unavailable");
    expect(c.runs.snapshots()).toMatchObject([{ state: "settling" }]);
    expect(c.runs.activeCount()).toBe(1);
    await c.stop(testAgentId("agent-a"));
    await c.restore();
    expect(writes).toHaveLength(2);
    expect(writes.map((value) => (value as { eventType: string }).eventType)).toEqual([AgentEventType.RunStarted, AgentEventType.RunCompleted]);
    expect(completionArray(await c.awaitReady())).toHaveLength(1);
  });

  for (const decisions of [[true, false], [false, true]] as const) {
    test(`retry preserves the staged ${decisions[0]} receipt decision after RunCompleted failure`, async () => {
      const writes: unknown[] = [];
      let calls = 0;
      let completionAttempts = 0;
      const restoration = port([spawned(), launch()], false, writes, testRunId("cafebabe"));
      restoration.validateReceipt = async () => decisions[calls++]!;
      const appendCompleted = restoration.appender.appendRunCompleted.bind(restoration.appender);
      restoration.appender.appendRunCompleted = async (completion) => {
        if (++completionAttempts === 1) throw new Error("disk unavailable");
        return appendCompleted(completion);
      };
      const c = new SubagentController({ capacity: runCapacity(1), restoration });

      if (decisions[0]) {
        await expect(c.restore()).rejects.toThrow("disk unavailable");
        await c.stop(testAgentId("agent-a"));
        expect(writes.map((value) => (value as { eventType: string }).eventType)).toEqual([AgentEventType.RunStarted, AgentEventType.RunCompleted]);
        expect(completionArray(await c.awaitReady())).toHaveLength(1);
      } else {
        await c.restore();
        expect(writes).toEqual([]);
        expect(c.runs.activeCount()).toBe(1);
      }
      expect(calls).toBe(1);
    });
  }

  test("restores inherited obligations above capacity and releases them only as each terminalises", async () => {
    const writes: unknown[] = [], pings: unknown[] = [];
    let valid = false;
    const branch = [
      spawnedFor("agent-a", "/tmp/a.jsonl"), launchFor("agent-a", "attempt-a"), startedFor("agent-a", "deadbeef", "attempt-a"),
      spawnedFor("agent-b", "/tmp/b.jsonl"), launchFor("agent-b", "attempt-b"), startedFor("agent-b", "cafebabe", "attempt-b"),
    ];
    const restoration = port(branch, false, writes);
    restoration.validateReceipt = async () => valid;
    const c = new SubagentController({ capacity: runCapacity(1), restoration, parent: {
      isBusy: () => false,
      sendMessage: async (_text, options) => { pings.push(options); },
    } });

    await Promise.all([c.restore(), c.restore()]);
    expect(c.runs.snapshots()).toHaveLength(2);
    expect(c.runs.activeCount()).toBe(2);
    await expect(c.runs.spawnNew(async () => { throw new Error("must not run"); })).rejects.toThrow("capacity_exceeded:");

    valid = true;
    await c.stop(testAgentId("agent-a"));
    expect(c.runs.activeCount()).toBe(1);
    await expect(c.runs.spawnNew(async () => { throw new Error("must not run"); })).rejects.toThrow("capacity_exceeded:");
    await c.stop(testAgentId("agent-b"));
    expect(c.runs.activeCount()).toBe(0);
    expect(c.completions.queuedCount()).toBe(2);
    expect(writes).toHaveLength(2);
  });

  test("mixed receipt decisions finalise contained records and retain other inherited ownership", async () => {
    const writes: unknown[] = [], pings: unknown[] = [];
    let secondContained = false;
    const branch = [
      spawnedFor("agent-a", "/tmp/a.jsonl"), launchFor("agent-a", "attempt-a"), startedFor("agent-a", "deadbeef", "attempt-a"),
      spawnedFor("agent-b", "/tmp/b.jsonl"), launchFor("agent-b", "attempt-b"), startedFor("agent-b", "cafebabe", "attempt-b"),
      spawnedFor("agent-c", "/tmp/c.jsonl"), launchFor("agent-c", "attempt-c"), startedFor("agent-c", "facefeed", "attempt-c"),
    ];
    const restoration = port(branch, false, writes);
    restoration.validateReceipt = async (_path, attemptId) => attemptId === "attempt-a" || secondContained;
    const c = new SubagentController({ capacity: runCapacity(1), restoration, parent: {
      isBusy: () => false,
      sendMessage: async (_text, options) => { pings.push(options); },
    } });

    await c.restore();
    expect(writes).toHaveLength(1);
    expect(c.runs.snapshots()).toHaveLength(3);
    expect(c.runs.activeCount()).toBe(2);
    expect(c.completions.queuedCount()).toBe(1);

    secondContained = true;
    await c.stop(testAgentId("agent-b"));
    await c.stop(testAgentId("agent-c"));
    expect(writes).toHaveLength(3);
    expect(c.runs.activeCount()).toBe(0);
    expect(c.completions.queuedCount()).toBe(3);
  });

  for (const decisions of [[true, false], [false, true]] as const) {
    test(`uses one receipt decision when verifier would return ${decisions.join(" then ")}`, async () => {
      let calls = 0;
      const restoration = port([spawned(), launch(), started(), completed()], false, []);
      restoration.validateReceipt = async () => decisions[calls++]!;
      const c = new SubagentController({ capacity: runCapacity(1), restoration });

      await c.restore();

      expect(calls).toBe(1);
      if (decisions[0]) {
        expect(c.runs.activeCount()).toBe(0);
        expect(completionArray(await c.awaitReady())).toHaveLength(1);
      } else {
        expect(c.runs.activeCount()).toBe(1);
        expect(completionArray(await c.awaitReady({ timeoutMs: testMilliseconds(1) }))).toEqual([]);
      }
    });
  }
});

async function applicationFixture() {
  const registry = foldAgentEvents([spawned(), launch()], TEST_STATE_ROOT);
  const port = testRestorationPort({ firstUserEntryAfter: async () => testRunId("cafebabe") });
  const evidence = await collectRestorationEvidence(registry, port, () => testRuntime());
  return { plan: planRestoration(registry, evidence), port };
}

async function multiApplicationFixture() {
  const registry = foldAgentEvents([
    spawned(),
    launch(),
    spawnedFor("agent-b", "b.jsonl"),
    launchFor("agent-b", "attempt-b"),
  ], TEST_STATE_ROOT);
  const port = testRestorationPort({
    firstUserEntryAfter: async (path) => String(path).endsWith("b.jsonl") ? testRunId("feedface") : testRunId("cafebabe"),
  });
  const evidence = await collectRestorationEvidence(registry, port, () => testRuntime());
  return { plan: planRestoration(registry, evidence), port };
}

function applicationState(): RestorationApplicationState {
  return { durableCompletions: new Map(), restoredStartedAppends: new Set(), restoredRecords: new Map() };
}

function tracedAdmission(trace: string[]): RestoreAdmission {
  return {
    reserve: () => { trace.push("reserve"); },
    replace: (record) => { trace.push(`replace:${record.state}`); },
    commit: () => { trace.push("commit"); },
    release: () => {},
  };
}

function spawned() { return spawnedEntry({ agentId: testAgentId(), sessionPath: testSessionPath("/tmp/pi-subagents-test/a.jsonl"), cwd: testAbsolutePath("/tmp"), provider: testProviderId("p"), modelId: testModelId("m"), tools: [] }, 1); }
function spawnedFor(id: string, path: string) { return spawnedEntry({ agentId: testAgentId(id), sessionPath: testSessionPath(`/tmp/pi-subagents-test/${path.split("/").at(-1)!}`), cwd: testAbsolutePath("/tmp"), provider: testProviderId("p"), modelId: testModelId("m"), tools: [] }, 1); }
function launch(attemptId = "attempt") { return launchEntry({ agentId: testAgentId(), attemptId: testAttemptId(attemptId), containmentReceiptPath: testReceiptPath(`/tmp/pi-subagents-test/${attemptId}.receipt`) }, 1); }
function launchV2(attemptId = "attempt") { return launchEntry({ agentId: testAgentId(), attemptId: testAttemptId(attemptId), containmentReceiptPath: testReceiptPath(`/tmp/pi-subagents-test/${attemptId}.receipt`), containment: testContainmentAttempt(testAttemptId(attemptId)).descriptor }, 2); }
function launchFor(id: string, attemptId: string) { return launchEntry({ agentId: testAgentId(id), attemptId: testAttemptId(attemptId), containmentReceiptPath: testReceiptPath(`/tmp/pi-subagents-test/${attemptId}.receipt`) }, 1); }
function started(id = "deadbeef", attemptId = "attempt") { return startedEntry({ agentId: testAgentId(), runId: testRunId(id), attemptId: testAttemptId(attemptId) }, 1); }
function startedV2(id = "deadbeef", attemptId = "attempt") { return startedEntry({ agentId: testAgentId(), runId: testRunId(id), attemptId: testAttemptId(attemptId) }, 2); }
function startedFor(id: string, nativeRunId: string, attemptId: string) { return startedEntry({ agentId: testAgentId(id), runId: testRunId(nativeRunId), attemptId: testAttemptId(attemptId) }, 1); }
function stopping(reason: CancellationReason) { return stoppingEntry({ reason, containmentReceiptPath: testReceiptPath("/tmp/pi-subagents-test/attempt.receipt") }, 1); }
function completed(id = "deadbeef") {
  return completedEntry({
    runId: testRunId(id), transcriptPath: testSessionPath("/tmp/pi-subagents-test/a.jsonl"),
    outputPath: testCommittedOutputPath({
      workDir: testAbsolutePath("/tmp/pi-subagents-test/output/agent-a"),
      runId: testRunId(id),
    }), output: truncateUtf8("", utf8Bytes(50_000)),
  }, 1);
}
function completedFor(agent: string, id: string, transcript: string) {
  return completedEntry({
    agentId: testAgentId(agent),
    runId: testRunId(id),
    transcriptPath: testSessionPath(`/tmp/pi-subagents-test/${transcript}`),
    outputPath: testCommittedOutputPath({
      workDir: testAbsolutePath(`/tmp/pi-subagents-test/output/${agent}`),
      runId: testRunId(id),
    }),
    output: truncateUtf8("", utf8Bytes(50_000)),
  }, 1);
}
function completedV2(id = "deadbeef") {
  return completedEntry({
    runId: testRunId(id), transcriptPath: testSessionPath("/tmp/pi-subagents-test/a.jsonl"),
    outputPath: testCommittedOutputPath({
      workDir: testAbsolutePath("/tmp/pi-subagents-test/output/agent-a"),
      runId: testRunId(id),
    }), output: truncateUtf8("", utf8Bytes(50_000)),
  }, 2);
}

function restorableCompletion(
  workDir: string,
  transcriptPath: ReturnType<typeof sessionPath>,
  text: string,
): RestorableAgentCompletion {
  mkdirSync(workDir, { recursive: true, mode: 0o700 });
  return {
    agentId: testAgentId(),
    runId: testRunId(),
    state: CompletionState.Completed,
    output: truncateUtf8(text, MAX_COMPLETION_OUTPUT_BYTES),
    outputPath: outputPath(workDir, `${testRunId()}.committed`),
    transcriptPath,
  };
}

function writeTranscript(path: string, runId: string, text: string): void {
  const entries = [
    { type: "message", id: runId, message: { role: "user", content: "task" } },
    { type: "message", id: "aaaaaaaa", message: { role: "assistant", content: [{ type: "text", text }] } },
  ];
  writeFileSync(path, `${entries.map((entry) => JSON.stringify(entry)).join("\n")}\n`, { mode: 0o600 });
}

function tracedDurableFileSystem(trace: string[], failOperation?: string): DurableFileSystem {
  const directories = new Set<number>();
  const record = (operation: string): void => {
    trace.push(operation);
    if (operation === failOperation) throw new Error(`injected ${operation} failure`);
  };
  return {
    ...systemDurableFileSystem,
    open(path, flags, mode) {
      const directory = existsSync(path) && statSync(path).isDirectory();
      const fd = systemDurableFileSystem.open(path, flags, mode);
      if (directory) directories.add(fd);
      return fd;
    },
    write(fd, data) {
      record("output:write");
      systemDurableFileSystem.write(fd, data);
    },
    sync(fd) {
      record(directories.has(fd) ? "output:directory-sync" : "output:file-sync");
      systemDurableFileSystem.sync(fd);
    },
    close(fd) {
      directories.delete(fd);
      systemDurableFileSystem.close(fd);
    },
    rename(source, destination) {
      record("output:rename");
      systemDurableFileSystem.rename(source, destination);
    },
  };
}

type TestRestorationPort = RestorationPort & {
  getBranch(): readonly { readonly type: string; readonly customType?: string; readonly data?: unknown }[];
  validateReceipt(path: unknown, attemptId: unknown): Promise<boolean>;
};

function port(branch: RestorationEventEntry[], valid: boolean, writes: unknown[], found?: ReturnType<typeof testRunId>, attempts?: string[]): TestRestorationPort {
  const appender = new AgentEventAppender((_type, data) => { writes.push(data); });
  let result!: TestRestorationPort;
  result = Object.assign(testRestorationPort({
    stateRoot: testAbsolutePath("/tmp"),
    getBranch: () => branch,
    resolveContainment: async (input) => {
      if (await result.validateReceipt(input.receiptPath, input.attemptId)) return { kind: "contained", receipt: testVerifiedReceiptPath(input.receiptPath) };
      return {
        kind: "unresolved-historical",
        runtime: testRuntime({ contain: async () => {
          if (!await result.validateReceipt(input.receiptPath, input.attemptId)) throw new Error("containment receipt unavailable");
          return testVerifiedReceiptPath(input.receiptPath);
        } }),
      };
    },
    firstUserEntryAfter: async () => found,
    finaliseContained: async (_record, id, settlement) => settlement.kind === "cancelled"
      ? { ...completedCompletion({ runId: id }), state: CompletionState.Cancelled, reason: settlement.reason }
      : { ...completedCompletion({ runId: id }), state: CompletionState.Failed, error: { code: "run_interrupted", message: "run was interrupted before completion" } },
    appender,
  }), {
    validateReceipt: async (_path: unknown, attemptId: unknown) => { attempts?.push(String(attemptId)); return valid; },
  });
  return result;
}
