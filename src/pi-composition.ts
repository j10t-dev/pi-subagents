import { mkdirSync } from "node:fs";
import { join } from "node:path";

import { SessionManager, type ExtensionAPI, type ExtensionContext, type ResolveCliModelResult, type SessionEntry } from "@earendil-works/pi-coding-agent";

import {
  SubagentController,
  type LaunchSession,
  type LaunchTransport,
  type PiControllerComposition,
  type SendPreparation,
  type SpawnAgentRequest,
  type SpawnPreparation,
  type SurrenderContainment,
} from "./controller.ts";
import { AgentEventAppender, foldAgentEvents, type RestoredAgentRecord } from "./persistence.ts";
import { buildRpcLaunchSpec, resolvePiInvocation } from "./pi-launcher.ts";
import { isLocalOutputPublicationError, RpcRunClient } from "./rpc-client.ts";
import { OutputStore } from "./output-store.ts";
import { UIForwarder } from "./ui-forwarder.ts";
import { WatchdogClient, WatchdogContainmentUnresolvedError, verifyContainmentReceipt } from "./watchdog-client.ts";
import {
  AgentErrorCode,
  CancellationReason,
  CodedError,
  CompletionState,
  PublicPreflightError,
  agentId,
  createRunAttemptId,
  modelSpec,
  runIdFromEntry,
  sessionEntryId,
  toAgentError,
  retainUtf8Tail,
  verifiedContainmentReceiptPath,
  type AbsolutePath,
  type AgentCompletion,
  type AgentId,
  type ContainmentReceiptPath,
  type ModelSpec,
  type RunAttemptId,
  type RunId,
  type SessionEntryId,
  type ThinkingLevel,
} from "./domain.ts";
import { absolutePath, containmentReceiptPath, diagnosticsPath, sessionPath, writeOwnerOnlyFile } from "./paths.ts";
import type { RunRecord, RunRuntime, Settlement } from "./run-controller.ts";
import { resolveChildSelection } from "./child-selection.ts";
import { ensureDurableDirectorySync } from "./durable-fs.ts";
import { createContainmentProvider, type ContainmentProvider } from "./cgroup-v2.ts";
import type { ContainmentBackend } from "./containment.ts";

interface ChildRecord {
  readonly session: LaunchSession;
  readonly cwd: AbsolutePath;
  readonly model: ModelSpec;
  readonly thinking: ThinkingLevel;
  readonly tools: readonly string[];
  outputStore?: OutputStore;
  client?: RpcRunClient;
}

export interface ProductionControllerOptions {
  capacity: number;
  stateRoot: string;
  cgroupRoot?: string;
  onStatusChange?: () => void;
}

/** The single production capability gate. No launch-side continuation runs before it succeeds. */
export async function withProductionContainmentPreflight<T>(
  provider: ContainmentProvider,
  continuePreparation: (backend: ContainmentBackend) => T | Promise<T>,
): Promise<T> {
  let backend: ContainmentBackend;
  try {
    if (provider.kind === "unavailable") return provider.requireAvailable();
    backend = provider.backend;
    await backend.preflight();
  } catch (error) {
    if (error instanceof PublicPreflightError && error.code === AgentErrorCode.ContainmentFailed) {
      throw error;
    }
    throw new PublicPreflightError(
      AgentErrorCode.ContainmentFailed,
      "cgroup-v2 containment is unavailable",
    );
  }
  return await continuePreparation(backend);
}

/** Builds the concrete Pi/watchdog composition for one parent-session extension instance. */
export function createProductionController(
  context: ExtensionContext,
  pi: ExtensionAPI,
  options: ProductionControllerOptions,
): SubagentController {
  const parentId = agentId(context.sessionManager.getSessionId());
  const root = absolutePath(join(options.stateRoot, parentId));
  ensureDurableDirectorySync(root);
  const appender = new AgentEventAppender((customType, data) => pi.appendEntry(customType, data));
  const containment = createContainmentProvider({
    parentSessionId: context.sessionManager.getSessionId(),
    ...(options.cgroupRoot === undefined ? {} : { configuredRoot: options.cgroupRoot }),
    receiptPathFor: (attemptId) => receiptFor(root, attemptId),
    diagnostic: (message) => context.ui.notify(message, "warning"),
  });
  const children = new Map<AgentId, ChildRecord>();
  const uiForwarder = new UIForwarder(context);
  restoreChildRegistry();
  const composition: PiControllerComposition = {
    prepareSpawn: async (input) => prepareSpawn(input),
    prepareSend: async (id) => prepareSend(id),
    persistStopping: async (record, reason) => {
      const child = requireChild(children, record.agentId);
      if (record.runId === undefined) return;
      await appender.appendRunStopping({
        agentId: record.agentId,
        runId: record.runId,
        reason,
        containmentReceiptPath: child.session.containmentReceiptPath,
      });
    },
    finaliseRun: async (record, settlement) => finalise(record, settlement),
    shutdownStart: () => uiForwarder.close(),
    shutdownComplete: async () => {
      if (containment.kind === "available") await containment.backend.shutdown();
    },
  };
  return new SubagentController({
    capacity: options.capacity,
    ...(options.onStatusChange === undefined ? {} : { onStatusChange: options.onStatusChange }),
    composition,
    restoration: {
      stateRoot: root,
      getBranch: () => context.sessionManager.getBranch(),
      resolveContainment: async ({ attemptId, receiptPath, descriptor, eventVersion }) => {
        let receipt: ReturnType<typeof verifyContainmentReceipt> | undefined;
        try { receipt = verifyContainmentReceipt(receiptPath, attemptId); }
        catch { /* unresolved work is handled below without trusting malformed proof */ }
        if (receipt !== undefined) {
          if (eventVersion === 1 && descriptor === undefined && receipt.version === 1) {
            return { kind: "contained", receipt: receipt.path };
          }
          if (eventVersion === 2 && descriptor !== undefined && receipt.version === 2 &&
              receipt.descriptor.backend === descriptor.backend &&
              receipt.descriptor.scopePath === descriptor.scopePath && containment.kind === "available") {
            const restored = containment.backend.restoreAttempt(attemptId, descriptor);
            try {
              await restored.cleanup(receipt.path);
              return { kind: "contained", receipt: receipt.path };
            } catch {
              return {
                kind: "requires-containment",
                runtime: { abort: async () => {}, contain: () => restored.terminate("terminated") },
              };
            }
          }
        }
        if (eventVersion === 1) {
          const runtime: RunRuntime = {
            abort: async () => {},
            contain: async () => {
              const later = verifyContainmentReceipt(receiptPath, attemptId);
              if (later.version !== 1) throw new Error("invalid historical containment receipt");
              return later.path;
            },
          };
          return { kind: "unresolved-historical", runtime };
        }
        const runtime = restoredCgroupRuntime(containment, attemptId, descriptor);
        return { kind: "requires-containment", runtime };
      },
      firstUserEntryAfter: async (path, cursor) => {
        const entries = SessionManager.open(path).getEntries();
        return firstUserEntryAfterCursor(entries, cursor);
      },
      finaliseContained: (record, nativeRunId, settlement) => restoredCompletion(record, nativeRunId, settlement),
      appender,
    },
    parent: {
      isBusy: () => !context.isIdle(),
      sendMessage: (text, delivery) => pi.sendMessage({ customType: "pi-subagents:notification", content: text, display: true }, {
        deliverAs: delivery.deliverAs,
        triggerTurn: delivery.triggerTurn,
      }),
      warn: (message) => context.ui.notify(message, "warning"),
    },
  });

  function restoreChildRegistry(): void {
    const folded = foldAgentEvents(context.sessionManager.getBranch(), root);
    for (const record of folded.agents.values()) {
      let leaf: LaunchSession["previousLeafId"] = null;
      try {
        const value = SessionManager.open(record.sessionPath).getLeafId();
        leaf = value === null ? null : sessionEntryId(value);
      } catch { /* restoration will retain unavailable sessions as non-resumable */ }
      const attemptId = record.pendingLaunch?.attemptId ?? record.currentAttemptId ?? record.latestCompletionAttemptId ?? createRunAttemptId();
      const receipt = record.pendingLaunch?.containmentReceiptPath ?? record.currentReceiptPath ?? record.latestCompletionReceiptPath ?? receiptFor(root, attemptId);
      children.set(record.agentId, {
        session: { agentId: record.agentId, transcriptPath: record.sessionPath, previousLeafId: leaf, attemptId, containmentReceiptPath: receipt },
        cwd: record.cwd,
        model: modelSpec(`${record.provider}/${record.modelId}`),
        thinking: record.thinkingLevel,
        tools: record.tools,
      });
    }
  }

  async function restoredCompletion(
    record: RestoredAgentRecord,
    nativeRunId: AgentCompletion["runId"],
    settlement: { kind: "interrupted" } | { kind: "cancelled"; reason: CancellationReason },
  ): Promise<AgentCompletion> {
    const store = new OutputStore({ workDir: join(root, "output", record.agentId) });
    store.restoreRun(nativeRunId);
    const durable = store.ensureDurable(nativeRunId, record.sessionPath);
    const base = { agentId: record.agentId, runId: nativeRunId, output: durable.output,
      outputPath: durable.committedPath, transcriptPath: record.sessionPath };
    return settlement.kind === "cancelled"
      ? { ...base, state: CompletionState.Cancelled, reason: settlement.reason }
      : { ...base, state: CompletionState.Failed, error: toAgentError(AgentErrorCode.RunInterrupted) };
  }

  async function prepareSpawn(input: SpawnAgentRequest): Promise<SpawnPreparation> {
    const cwd = absolutePath(input.cwd ?? context.cwd);
    const selection = resolveChildSelection({
      ...(input.model === undefined ? {} : { requestedModel: input.model }),
      ...(input.tools === undefined ? {} : { requestedTools: input.tools }),
      parentModel: requireParentModel(context.model),
      parentThinking: pi.getThinkingLevel(),
      parentActiveTools: pi.getActiveTools(),
      modelRegistry: context.modelRegistry,
    });
    return withProductionContainmentPreflight(containment, async (backend) => {
    let child: ChildRecord | undefined;
    return {
      selection,
      createSession: async () => {
        const childDir = absolutePath(join(root, "sessions"));
        mkdirSync(childDir, { recursive: true, mode: 0o700 });
        const native = SessionManager.create(cwd, childDir);
        const file = native.getSessionFile();
        if (file === undefined) throw new Error("session_unavailable: child session file was not created");
        writeOwnerOnlyFile(absolutePath(file), `${JSON.stringify(native.getHeader())}\n`);
        const attemptId = createRunAttemptId();
        const session: LaunchSession = {
          agentId: agentId(native.getSessionId()),
          transcriptPath: sessionPath(file, file),
          previousLeafId: null,
          attemptId,
          containmentReceiptPath: receiptFor(root, attemptId),
        };
        const record: ChildRecord = { session, cwd, model: selection.model, thinking: selection.thinkingLevel, tools: selection.tools };
        child = record;
        children.set(session.agentId, record);
        return session;
      },
      persistSpawned: async (session) => {
        const record = child ?? requireChild(children, session.agentId);
        await appender.appendSpawned({ agentId: session.agentId, sessionPath: session.transcriptPath, cwd,
          provider: modelProvider(record.model), modelId: modelId(record.model), thinkingLevel: record.thinking, tools: record.tools });
      },
      createLaunch: async (session, surrender) => createLaunch(requireChild(children, session.agentId), backend, surrender),
    };
    });
  }

  async function prepareSend(id: AgentId): Promise<SendPreparation> {
    return withProductionContainmentPreflight(containment, async (backend) => {
    const child = requireChild(children, id);
    const native = SessionManager.open(child.session.transcriptPath);
    const leaf = native.getLeafId();
    const attemptId = createRunAttemptId();
    const session: LaunchSession = {
      ...child.session,
      previousLeafId: leaf === null ? null : sessionEntryId(leaf),
      attemptId,
      containmentReceiptPath: receiptFor(root, attemptId),
    };
    children.set(id, { ...child, session });
    return { session, createLaunch: async (surrender) => createLaunch(requireChild(children, id), backend, surrender) };
    });
  }

  async function createLaunch(
    child: ChildRecord,
    backend: ContainmentBackend,
    surrender: SurrenderContainment,
  ): Promise<LaunchTransport> {
    const attempt = backend.prepareAttempt(child.session.attemptId);
    const outputDir = absolutePath(join(root, "output", child.session.agentId));
    const outputStore = new OutputStore({ workDir: outputDir });
    let watchdog: WatchdogClient | undefined;
    let client: RpcRunClient | undefined;
    const runtime: RunRuntime = {
      abort: async () => {
        try { await client?.abort(); } finally { watchdog?.escalate(); }
      },
      contain: async () => {
        try {
          if (client !== undefined) await client.shutdown();
          else if (watchdog !== undefined) await watchdog.close();
          else return await attempt.terminate("no_process");
          if (watchdog === undefined) throw new Error("containment_unavailable:watchdog ownership");
          return await watchdog.waitForReceipt();
        } catch (error) {
          if (error instanceof WatchdogContainmentUnresolvedError) throw error;
          const outcome = watchdog?.launchPhase === "pi_spawned"
            ? "terminated"
            : watchdog?.launchPhase === "launcher_authorised"
              ? "spawn_failed"
              : "no_process";
          try { return await attempt.terminate(outcome); }
          catch (fallbackError) {
            const path = diagnosticsPath(join(root, "diagnostics", child.session.agentId), `${child.session.attemptId}.containment.log`);
            outputStore.appendDiagnostics(`${error instanceof Error ? error.message : String(error)}; fallback=${fallbackError instanceof Error ? fallbackError.message : String(fallbackError)}`);
            writeOwnerOnlyFile(path, outputStore.getDiagnosticsTail());
            throw fallbackError;
          }
        }
      },
    };
    watchdog = constructContainedLaunch(runtime, surrender, () => new WatchdogClient({
      attemptId: child.session.attemptId,
      receiptPath: child.session.containmentReceiptPath,
      attempt,
    }));
    const spec = buildRpcLaunchSpec({
      invocation: resolvePiInvocation(), cwd: child.cwd, childSessionDir: absolutePath(join(root, "sessions")),
      existingSession: child.session.transcriptPath, effectiveTools: child.tools, effectiveModel: child.model,
      effectiveThinking: child.thinking, ...(context.isProjectTrusted() ? { trustedRoot: absolutePath(context.cwd) } : {}),
    });
    client = new RpcRunClient({
      launchTransport: async () => {
        const launch = await watchdog!.launch(spec);
        return { stdin: launch.stdin, stdout: launch.stdout, stderr: launch.stderr, exited: launch.exited,
          terminate: async () => {
            launch.stdin.destroy();
            launch.stdout.destroy();
            launch.stderr.destroy();
            await watchdog!.close();
          } };
      },
      outputStore,
      uiForwarder,
      agentId: child.session.agentId,
      runAttemptId: child.session.attemptId,
    });
    child.outputStore = outputStore;
    child.client = client;
    return {
      containment: attempt.descriptor,
      runtime,
      ready: async () => { await watchdog!.ready(); },
      persistLaunchRequested: () => appender.appendRunLaunchRequested({
        agentId: child.session.agentId, previousLeafId: child.session.previousLeafId,
        attemptId: child.session.attemptId, containmentReceiptPath: child.session.containmentReceiptPath,
        containment: attempt.descriptor,
      }),
      persistRunStarted: (runId) => appender.appendRunStarted({ agentId: child.session.agentId, runId, attemptId: child.session.attemptId }),
      start: () => client!.start(),
      getEntries: (since) => client!.getEntries(since),
      prompt: (message) => client!.prompt(message),
      waitForAgentStart: () => client!.waitForAgentStart(),
      bindRun: (runId) => client!.bindRun(runId),
      waitSettled: () => client!.waitSettled(),
      recordFailure: (error) => {
        if (isLocalOutputPublicationError(error)) return;
        const path = diagnosticsPath(join(root, "diagnostics", child.session.agentId), `${child.session.attemptId}.launch.log`);
        outputStore.appendDiagnostics(error instanceof Error ? error.message : String(error));
        writeOwnerOnlyFile(path, outputStore.getDiagnosticsTail());
      },
    };
  }

  async function finalise(record: Readonly<RunRecord>, settlement: Settlement): Promise<AgentCompletion> {
    if (record.runId === undefined) throw new Error("invalid_state: terminal run has no identity");
    const child = requireChild(children, record.agentId);
    const store = child.outputStore;
    if (store === undefined) throw new Error("invalid_state: terminal run has no output store");
    const durable = store.ensureDurable(record.runId, child.session.transcriptPath);
    const usage = child.client?.getUsage();
    const base = { agentId: record.agentId, runId: record.runId, output: durable.output, outputPath: durable.committedPath,
      transcriptPath: child.session.transcriptPath, ...(usage === undefined ? {} : { usage }) };
    let completion: AgentCompletion;
    if (settlement.kind === "completed") completion = { ...base, state: CompletionState.Completed };
    else if (settlement.kind === "cancelled") completion = {
      ...base,
      state: CompletionState.Cancelled,
      reason: settlement.reason ?? CancellationReason.StopRequested,
    };
    else {
      const failure = "cause" in settlement ? settlement.cause : undefined;
      if (failure === undefined) throw new Error("invalid_state: failed settlement has no cause");
      const diagnostic = retainUtf8Tail(store.getDiagnosticsTail() + store.getStderrTail(), 50_000);
      const path = diagnosticsPath(join(root, "diagnostics", record.agentId), `${record.runId}.log`);
      if (diagnostic.length > 0) writeOwnerOnlyFile(path, diagnostic);
      completion = { ...base, state: CompletionState.Failed,
        error: toAgentError(failure.code, diagnostic.length > 0 ? path : undefined) };
    }
    await appender.appendRunCompleted(completion);
    return completion;
  }
}

/** Returns the first assignment after an existing cursor; a missing cursor is unavailable. */
export function firstUserEntryAfterCursor(entries: readonly SessionEntry[], cursor: SessionEntryId | null): RunId | undefined {
  const cursorIndex = cursor === null ? -1 : entries.findIndex((entry) => entry.id === cursor);
  if (cursor !== null && cursorIndex < 0) throw new Error("session_unavailable: restoration cursor is missing");
  for (let index = cursorIndex + 1; index < entries.length; index++) {
    const candidate = runIdFromEntry(entries[index]!);
    if (candidate !== undefined) return candidate;
  }
  return undefined;
}

/**
 * The single process-creation gate used by production composition. The runtime is transferred
 * to controller ownership synchronously before the watchdog factory is permitted to run.
 */
export function constructContainedLaunch<T>(
  runtime: RunRuntime,
  surrender: SurrenderContainment,
  createWatchdog: () => T,
): T {
  surrender(runtime);
  return createWatchdog();
}

function restoredCgroupRuntime(
  provider: ContainmentProvider,
  attemptId: RunAttemptId,
  descriptor: import("./containment.ts").ContainmentDescriptor | undefined,
): RunRuntime {
  if (provider.kind !== "available" || descriptor === undefined) {
    return {
      abort: async () => {},
      contain: async () => { throw new Error("containment_unavailable:restoration backend"); },
    };
  }
  let attempt: ReturnType<ContainmentBackend["restoreAttempt"]>;
  try { attempt = provider.backend.restoreAttempt(attemptId, descriptor); }
  catch {
    return {
      abort: async () => {},
      contain: async () => { throw new Error("containment_unavailable:attempt descriptor"); },
    };
  }
  return {
    abort: async () => {},
    contain: () => attempt.terminate("terminated"),
  };
}

function requireChild(children: ReadonlyMap<AgentId, ChildRecord>, id: AgentId): ChildRecord {
  const child = children.get(id);
  if (child === undefined) throw new CodedError(AgentErrorCode.InvalidAgent);
  return child;
}

function requireParentModel(value: ResolveCliModelResult["model"]): NonNullable<ResolveCliModelResult["model"]> {
  if (value === undefined) {
    throw new PublicPreflightError(
      AgentErrorCode.ModelUnavailable,
      "parent has no selected model; select a parent model before spawning",
    );
  }
  return value;
}

function modelProvider(model: ModelSpec): string { return model.slice(0, model.indexOf("/")); }
function modelId(model: ModelSpec): ModelSpec { return modelSpec(model.slice(model.indexOf("/") + 1)); }
function receiptFor(root: AbsolutePath, attempt: RunAttemptId): ContainmentReceiptPath {
  return containmentReceiptPath(join(root, "receipts"), `${attempt}.json`);
}
