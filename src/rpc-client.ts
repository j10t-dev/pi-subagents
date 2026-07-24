/**
 * Bounded RPC transport client for one child Pi process (one subagent's own turn).
 *
 * Speaks the minimal validated wire subset from `rpc-wire.ts` over strict LF framing
 * (`jsonl.ts`). Correlates commands to responses by request ID, routes `text_delta`/
 * `message_start`/`message_end` into an `OutputStore` run (staging pre-run-ID events until
 * `bindRun` supplies the native `RunId`, since the RPC wire's `prompt` acknowledgement never
 * carries one — the caller must discover it via `getEntries()`), accumulates usage from
 * finalised assistant `message_end` events, and forwards `extension_ui_request` records
 * directly to the real parent `ExtensionContext.ui` via `UIForwarder` (see ui-forwarder.ts for
 * why this is safe: subtask 2.3's real-Pi spike proved direct mid-turn forwarding works).
 *
 * `agent_settled` is the sole normal run boundary. A process exit before that point is an
 * abnormal boundary reported the same way (via `waitSettled()`), so the caller can fall back to
 * `OutputStore.recover()` reading the child's own session file.
 */
import type { Readable, Writable } from "node:stream";
import { StringDecoder } from "node:string_decoder";
import { Type } from "typebox";
import { Value } from "typebox/value";

import {
  AgentErrorCode,
  createRpcRequestId,
  rpcRequestId,
  sessionEntryId,
  terminalFailureCause,
  type AgentId,
  type AgentUsage,
  type RpcRequestId,
  type RunAttemptId,
  type RunId,
  type SessionEntryId,
  type TerminalFailureCause,
  type Usage,
} from "./domain.ts";
import { BoundedJsonlDecoder, serializeJsonlRecord } from "./jsonl.ts";
import {
  classifyInboundRecord,
  type RecognizedRpcCommand,
  type RpcInboundRecord,
} from "./rpc-wire.ts";
import { OutputStore } from "./output-store.ts";
import { UIForwarder, type UIForwardOutcome } from "./ui-forwarder.ts";
import { AgentUsageSchema, AssistantMessageSchema, UsageSchema, type WireAssistantMessage, type WireExtensionUIDialog } from "./schemas.ts";
import type { RpcLaunchSpec } from "./pi-launcher.ts";
import { launchWatchdogRpcTransport, type WatchdogClient } from "./watchdog-client.ts";
import { MAX_RPC_RECORD_BYTES } from "./constants.ts";

const GetEntriesDataSchema = Type.Object({
  entries: Type.Array(Type.Unknown()),
  leafId: Type.Union([Type.String({ pattern: "^[0-9a-f]{8}$" }), Type.Null()]),
});

export interface RpcRunClientOptions {
  /** Test seam. Production callers omit this and provide watchdogClient plus launchSpec. */
  launchTransport?: () => Promise<RpcLaunchTransport>;
  watchdogClient?: WatchdogClient;
  launchSpec?: RpcLaunchSpec;
  outputStore: OutputStore;
  uiForwarder: UIForwarder;
  agentId: AgentId;
  runAttemptId: RunAttemptId;
}

export interface RpcLaunchTransport {
  stdin: Writable;
  stdout: Readable;
  stderr: Readable;
  exited: Promise<{ code: number | null; signal: NodeJS.Signals | null }>;
  terminate?: () => void | Promise<void>;
}

export type SettleResult =
  | { reason: "agent_settled"; stopReason: "stop" | "length" | "error" | "aborted" | "toolUse"; toolSequenceCompleted?: boolean; failureCause?: TerminalFailureCause }
  | { reason: "process_exited"; code: number | null; signal: NodeJS.Signals | null; failureCause: TerminalFailureCause };

interface PendingRequest {
  resolve: (data: unknown) => void;
  reject: (error: Error) => void;
  command: RecognizedRpcCommand;
}
type PendingMessageEvent =
  | { kind: "message_start"; message: WireAssistantMessage }
  | { kind: "message_end"; message: WireAssistantMessage };

const SHUTDOWN_ERROR_MESSAGE = "rpc client was shut down";

export class LocalOutputPublicationError extends Error {
  constructor() {
    super("local output publication failed");
    this.name = "LocalOutputPublicationError";
  }
}

export function isLocalOutputPublicationError(error: unknown): error is LocalOutputPublicationError {
  return error instanceof LocalOutputPublicationError;
}
const RECOVERABLE_OVERSIZED_EVENT_TYPES: ReadonlySet<string> = new Set([
  "message_update",
  "model_change",
  "tool_execution_start",
  "tool_execution_update",
  "tool_execution_end",
]);

/** Drives one child Pi process over the bounded RPC transport. */
export class RpcRunClient {
  private readonly options: RpcRunClientOptions;
  private launchTransport: (() => Promise<RpcLaunchTransport>) | undefined;
  private child: RpcLaunchTransport | undefined;
  private launchPromise: Promise<void> | undefined;
  private readonly pending = new Map<RpcRequestId, PendingRequest>();
  private readonly decoder: BoundedJsonlDecoder;
  private readonly runLifetime = new AbortController();
  private runId: RunId | undefined;
  private readonly stderrDecoder = new StringDecoder("utf8");
  private usage: AgentUsage | undefined;
  private settleResult: SettleResult | undefined;
  private settleWaiters: Array<(result: SettleResult) => void> = [];
  private shutDown = false;
  private terminalCleaned = false;
  private started = false;
  private transportFailure: Promise<void> | undefined;
  private finalAssistant: WireAssistantMessage | undefined;
  private settlementRecovery: Promise<void> | undefined;
  private agentStarted = false;
  private agentStartError: Error | undefined;
  private agentStartWaiters: Array<{ resolve(): void; reject(error: Error): void }> = [];

  constructor(options: RpcRunClientOptions) {
    this.options = options;
    if (options.launchTransport !== undefined) this.launchTransport = options.launchTransport;
    else if (options.watchdogClient !== undefined && options.launchSpec !== undefined) this.launchTransport = () => launchWatchdogRpcTransport(options.watchdogClient!, options.launchSpec!);
    else throw new Error("invalid_input: production rpc client requires watchdogClient and launchSpec");
    this.options.outputStore.beginAttempt(this.options.runAttemptId);
    this.decoder = new BoundedJsonlDecoder({
      onRecord: (value) => this.handleRecord(value),
      onOversize: (approxBytes) => {
        this.markTransportIncomplete();
        this.options.outputStore.appendDiagnostics(`recovery_needed: oversized rpc record (~${approxBytes} bytes)\n`);
      },
      onOversizeRecord: (metadata) => this.handleOversizedRecord(metadata),
      onDecodeError: (reason) => {
        void this.failTransport(new Error(`protocol_error: rpc decode error: ${reason}`));
      },
      maxRecordBytes: MAX_RPC_RECORD_BYTES,
    });
  }

  /** Spawns the child process and begins reading its RPC stream. */
  start(): Promise<void> {
    if (this.shutDown) {
      throw new Error("invalid_state: rpc client has been shut down");
    }
    if (this.terminalCleaned) {
      throw new Error("invalid_state: rpc client has already terminated");
    }
    if (this.started) {
      throw new Error("invalid_state: rpc client has already been started");
    }
    this.started = true;
    this.launchPromise = this.launch().catch((error: Error) => {
      this.options.outputStore.appendDiagnostics(`child process error: ${error.message}\n`);
      this.terminate(processExit(null, null, AgentErrorCode.ProcessExited), error);
      throw error;
    });
    return this.launchPromise;
  }

  private async launch(): Promise<void> {
    const launchTransport = this.launchTransport;
    if (launchTransport === undefined) throw new Error("invalid_state: rpc launch transport is unavailable");
    const child = await launchTransport();
    this.launchTransport = undefined;
    this.child = child;
    if (this.shutDown) {
      await child.terminate?.();
      return;
    }

    child.stdout.on("data", (chunk: Buffer) => {
      this.decoder.push(chunk);
    });
    child.stderr.on("data", (chunk: Buffer) => {
      this.options.outputStore.appendStderr(this.stderrDecoder.write(chunk));
    });
    void child.exited.then(({ code, signal }) => {
      this.decoder.end();
      this.terminate(processExit(code, signal, AgentErrorCode.ProcessExited), new Error(`rpc child terminated (code=${code}, signal=${signal})`));
    }, (error: Error) => {
      this.options.outputStore.appendDiagnostics(`child process error: ${error.message}\n`);
      this.terminate(processExit(null, null, AgentErrorCode.ProcessExited), error);
    });
  }

  /** Binds the native `RunId` discovered via `getEntries()`, replaying buffered pre-bind events. */
  bindRun(runId: RunId): void {
    if (this.runId !== undefined) throw new Error(`invalid_state: rpc client is already bound to run ${this.runId}`);
    try {
      this.options.outputStore.adoptRun(this.options.runAttemptId, runId, () => { this.runId = runId; });
      this.options.outputStore.publishInitial(runId);
    } catch (error) {
      if (this.runId === undefined) throw error;
      this.failLocalOutput();
      throw new LocalOutputPublicationError();
    }
  }

  async getEntries(
    since?: SessionEntryId | null,
  ): Promise<{ entries: readonly unknown[]; leafId: SessionEntryId | null }> {
    const data = await this.send(
      "get_entries",
      since === undefined || since === null ? {} : { since },
    );
    if (!Value.Check(GetEntriesDataSchema, data)) {
      throw new Error("protocol_error: malformed get_entries response data");
    }
    const decoded = Value.Decode(GetEntriesDataSchema, data);
    return {
      entries: decoded.entries,
      leafId: decoded.leafId === null ? null : sessionEntryId(decoded.leafId),
    };
  }

  async prompt(message: string): Promise<void> {
    await this.send("prompt", { message });
  }

  async abort(): Promise<void> {
    try {
      await this.send("abort", {});
    } finally {
      this.runLifetime.abort();
    }
  }

  /** Resolves once Pi closes the initial input pipeline for this prompt. */
  waitForAgentStart(): Promise<void> {
    if (this.agentStarted) return Promise.resolve();
    if (this.agentStartError !== undefined) return Promise.reject(this.agentStartError);
    return new Promise<void>((resolve, reject) => this.agentStartWaiters.push({ resolve, reject }));
  }

  /** Resolves once the run reaches its boundary: `agent_settled`, or process exit beforehand. */
  waitSettled(): Promise<SettleResult> {
    if (this.settleResult !== undefined) {
      return Promise.resolve(this.settleResult);
    }
    return new Promise((resolve) => {
      this.settleWaiters.push(resolve);
    });
  }

  getUsage(): AgentUsage | undefined {
    return this.usage;
  }

  /** Terminates the child, detaches all listeners, and rejects still-pending requests. */
  async shutdown(): Promise<void> {
    if (this.shutDown) {
      return;
    }
    this.shutDown = true;
    this.runLifetime.abort();
    if (this.transportFailure !== undefined) {
      await this.transportFailure;
      return;
    }
    const child = this.child;
    this.terminate(processExit(null, null, AgentErrorCode.RunInterrupted), new Error(SHUTDOWN_ERROR_MESSAGE));
    await child?.terminate?.();
  }

  private async send(command: RecognizedRpcCommand, fields: Record<string, unknown>): Promise<unknown> {
    if (this.shutDown) {
      return Promise.reject(new Error(SHUTDOWN_ERROR_MESSAGE));
    }
    if (this.terminalCleaned) {
      return Promise.reject(new Error("rpc child has exited"));
    }
    await this.launchPromise;
    if (this.shutDown) return Promise.reject(new Error(SHUTDOWN_ERROR_MESSAGE));
    if (this.terminalCleaned) return Promise.reject(new Error("rpc child has exited"));
    const child = this.child;
    if (child === undefined) {
      return Promise.reject(new Error("invalid_state: rpc client has not been started"));
    }
    const id = createRpcRequestId();
    return new Promise<unknown>((resolve, reject) => {
      this.pending.set(id, {
        resolve,
        reject,
        command,
      });
      child.stdin.write(serializeJsonlRecord({ type: command, id, ...fields }), (error) => {
        if (error !== null && error !== undefined) this.terminate(processExit(null, null, AgentErrorCode.ProcessExited), error);
      });
    });
  }

  private handleRecord(value: unknown): void {
    if (this.transportFailure !== undefined) return;
    const result = classifyInboundRecord(value);
    if (!result.ok) {
      void this.failTransport(new Error(`protocol_error: ${result.reason}`));
      return;
    }
    this.dispatch(result.record);
  }

  private handleOversizedRecord(metadata: { type?: string; id?: string; command?: string }): void {
    if (metadata.type === "response") {
      let id: RpcRequestId;
      try {
        if (metadata.id === undefined) throw new Error("missing correlation id");
        id = rpcRequestId(metadata.id);
      } catch {
        for (const request of this.pending.values()) request.reject(new Error("protocol_error: oversized uncorrelated response"));
        this.pending.clear();
        void this.failTransport(new Error("protocol_error: oversized response with unidentifiable correlation id"));
        return;
      }
      const pending = this.pending.get(id);
      if (pending !== undefined) {
        this.pending.delete(id);
        pending.reject(new Error(`protocol_error: oversized ${metadata.command ?? pending.command} response`));
      } else {
        void this.failTransport(new Error("protocol_error: oversized response with unknown correlation id"));
      }
      return;
    }
    // An oversized record cannot be structurally validated. Only Pi event types whose
    // complete payload is irrelevant to this client are safe to discard.
    if (metadata.type !== undefined && RECOVERABLE_OVERSIZED_EVENT_TYPES.has(metadata.type)) return;
    void this.failTransport(new Error(`protocol_error: oversized ${metadata.type ?? "unidentified"} rpc record`));
  }

  private dispatch(record: RpcInboundRecord): void {
    switch (record.kind) {
      case "response": {
        const pending = this.pending.get(record.id);
        if (pending === undefined) {
          return;
        }
        this.pending.delete(record.id);
        if (pending.command !== record.command) {
          pending.reject(new Error(`protocol_error: response command mismatch for ${record.id}`));
          void this.failTransport(new Error(`protocol_error: response command mismatch for ${record.id}`));
          return;
        }
        if (record.success) {
          pending.resolve(record.data);
        } else {
          pending.reject(new Error(record.error));
        }
        return;
      }
      case "message_start":
        this.routeOutputMutation(() => this.routeMessageEvent({ kind: "message_start", message: record.message }));
        return;
      case "text_delta":
        this.routeOutputMutation(() => this.routeTextDelta(record.contentIndex, record.delta));
        return;
      case "message_update_other":
        return;
      case "message_end":
        if (!this.accumulateUsage(record.message)) return;
        if (!this.routeOutputMutation(() => this.routeMessageEvent({ kind: "message_end", message: record.message }))) return;
        this.finalAssistant = record.message;
        return;
      case "agent_settled":
        this.settlementRecovery ??= this.recoverSettlementEvidence();
        return;
      case "agent_start":
        if (!this.agentStarted) {
          this.agentStarted = true;
          for (const waiter of this.agentStartWaiters.splice(0)) waiter.resolve();
        }
        return;
      case "extension_ui_dialog":
        void this.forwardUIDialog(record.request);
        return;
      case "extension_ui_notification":
        this.options.uiForwarder.forwardNotification(this.options.agentId, record.request, this.runLifetime.signal);
        return;
      case "ignored":
        return;
    }
  }

  private routeMessageEvent(event: PendingMessageEvent): void {
    if (this.runId === undefined) {
      if (event.kind === "message_start") this.options.outputStore.onAttemptMessageStart(this.options.runAttemptId, event.message);
      else this.options.outputStore.onAttemptMessageEnd(this.options.runAttemptId, event.message);
      return;
    }
    this.applyMessageEvent(this.runId, event);
  }

  private applyMessageEvent(runId: RunId, event: PendingMessageEvent): void {
    if (event.kind === "message_start") {
      this.options.outputStore.onMessageStart(runId, event.message);
    } else {
      this.options.outputStore.onMessageEnd(runId, event.message);
    }
  }

  private routeTextDelta(contentIndex: number, delta: string): void {
    if (this.runId === undefined) {
      this.options.outputStore.onAttemptTextDelta(this.options.runAttemptId, contentIndex, delta);
      return;
    }
    this.options.outputStore.onTextDelta(this.runId, contentIndex, delta);
  }

  private accumulateUsage(message: WireAssistantMessage): boolean {
    const previous = this.usage;
    const candidate: AgentUsage = {
      turns: (previous?.turns ?? 0) + 1,
      usage: previous === undefined ? message.usage : addUsage(previous.usage, message.usage),
    };
    if (!Value.Check(AgentUsageSchema, candidate)) {
      void this.failTransport(new Error("protocol_error: invalid aggregate assistant usage"));
      return false;
    }
    this.usage = Value.Decode(AgentUsageSchema, candidate);
    return true;
  }

  private async recoverSettlementEvidence(): Promise<void> {
    let scan: AuthoritativeSettlementScan = { kind: "absent" };
    try { scan = authoritativeSettlement((await this.getEntries(this.runId)).entries); }
    catch (error) { this.options.outputStore.appendDiagnostics(`settlement_recovery_error: ${error instanceof Error ? error.message : String(error)}\n`); }
    if (scan.kind === "invalid") {
      await this.failTransport(new Error("protocol_error: invalid assistant settlement evidence"));
      this.settle({ reason: "agent_settled", stopReason: "error", failureCause: terminalFailureCause(AgentErrorCode.ProtocolError) });
      return;
    }
    if (scan.kind === "absent") {
      this.markTransportIncomplete();
      this.settle({ reason: "agent_settled", stopReason: "error", failureCause: terminalFailureCause(AgentErrorCode.ProtocolError) });
      return;
    }
    const { evidence } = scan;
    const recovered = this.routeOutputMutation(() => {
      if (this.runId === undefined) this.options.outputStore.recoverAttemptMessage(this.options.runAttemptId, evidence.message);
      else this.options.outputStore.recoverMessage(this.runId, evidence.message);
    });
    if (!recovered) return;
    const stopReason = normaliseStopReason(evidence.message.stopReason);
    const failureCause = terminalCauseFor(stopReason, evidence.message.errorMessage);
    this.settle({ reason: "agent_settled", stopReason,
      ...(stopReason === "toolUse" ? { toolSequenceCompleted: evidence.toolSequenceCompleted } : {}),
      ...(failureCause === undefined ? {} : { failureCause }) });
  }

  private async forwardUIDialog(request: WireExtensionUIDialog): Promise<void> {
    const outcome = await this.options.uiForwarder.forward(
      this.options.agentId,
      request,
      this.runLifetime.signal,
    );
    const child = this.child;
    if (child === undefined || this.shutDown) {
      return;
    }
    child.stdin.write(serializeJsonlRecord(toOutboundResponse(outcome)), (error) => {
      if (error !== null && error !== undefined) this.terminate(processExit(null, null, AgentErrorCode.ProcessExited), error);
    });
  }

  private settle(result: SettleResult): void {
    if (this.settleResult !== undefined) {
      return;
    }
    this.settleResult = result;
    this.runLifetime.abort();
    const waiters = this.settleWaiters;
    this.settleWaiters = [];
    for (const waiter of waiters) {
      waiter(result);
    }
  }

  private markTransportIncomplete(): void {
    if (this.runId === undefined) this.options.outputStore.markAttemptTransportIncomplete(this.options.runAttemptId);
    else this.options.outputStore.markTransportIncomplete(this.runId);
  }

  private routeOutputMutation(operation: () => void): boolean {
    try {
      operation();
      return true;
    } catch {
      this.failLocalOutput();
      return false;
    }
  }

  private failLocalOutput(): void {
    this.establishTransportFailure(
      processExit(null, null, AgentErrorCode.ProcessExited),
      new Error("local output publication failed"),
      "local_output_error: authoritative output publication failed\n",
    );
  }

  private failTransport(error: Error): Promise<void> {
    return this.establishTransportFailure(
      processExit(null, null, AgentErrorCode.ProtocolError),
      error,
      `${error.message}\n`,
    );
  }

  private establishTransportFailure(result: SettleResult, error: Error, diagnostic: string): Promise<void> {
    if (this.transportFailure !== undefined) return this.transportFailure;
    let resolve!: () => void;
    let reject!: (error: Error) => void;
    const sentinel = new Promise<void>((resolvePromise, rejectPromise) => {
      resolve = resolvePromise;
      reject = rejectPromise;
    });
    this.transportFailure = sentinel;
    try {
      this.markTransportIncomplete();
      this.options.outputStore.appendDiagnostics(diagnostic);
      void this.stopFailedTransport(result, error).then(resolve, reject);
    } catch (transitionError) {
      reject(transitionError instanceof Error ? transitionError : new Error(String(transitionError)));
    }
    return sentinel;
  }

  private stopFailedTransport(result: SettleResult, error: Error): Promise<void> {
    const child = this.child;
    this.terminate(result, error);
    return Promise.resolve().then(async () => {
      try { await child?.terminate?.(); }
      catch (containmentError) { this.options.outputStore.appendDiagnostics(`containment_error: ${containmentError instanceof Error ? containmentError.message : String(containmentError)}\n`); }
    });
  }

  private rejectAgentStart(error: Error): void {
    if (this.agentStarted || this.agentStartError !== undefined) return;
    this.agentStartError = error;
    for (const waiter of this.agentStartWaiters.splice(0)) waiter.reject(error);
  }

  private terminate(result: SettleResult, error: Error): void {
    this.runLifetime.abort();
    if (!this.terminalCleaned) {
      this.terminalCleaned = true;
      if (this.settleResult?.reason !== "agent_settled" && this.settlementRecovery === undefined) this.markTransportIncomplete();
      this.options.outputStore.discardPartial(this.runId ?? this.options.runAttemptId);
      this.rejectAgentStart(error);
      for (const request of this.pending.values()) request.reject(error);
      this.pending.clear();
      const child = this.child;
      if (child !== undefined) {
        const stderrRemainder = this.stderrDecoder.end();
        if (stderrRemainder.length > 0) this.options.outputStore.appendStderr(stderrRemainder);
        child.stdout.removeAllListeners(); child.stderr.removeAllListeners();
        child.stdin.removeAllListeners();
        this.child = undefined;
      }
    }
    if (this.settlementRecovery === undefined) this.settle(result);
  }
}

function processExit(
  code: number | null,
  signal: NodeJS.Signals | null,
  causeCode: typeof AgentErrorCode.ProcessExited | typeof AgentErrorCode.ProtocolError | typeof AgentErrorCode.RunInterrupted,
): Extract<SettleResult, { reason: "process_exited" }> {
  return { reason: "process_exited", code, signal, failureCause: terminalFailureCause(causeCode) };
}

function terminalCauseFor(
  stopReason: "stop" | "length" | "error" | "aborted" | "toolUse",
  errorMessage: string | undefined,
): TerminalFailureCause | undefined {
  if (stopReason === "error" || errorMessage !== undefined) return terminalFailureCause(AgentErrorCode.ProtocolError);
  if (stopReason === "aborted" || stopReason === "toolUse") return terminalFailureCause(AgentErrorCode.RunInterrupted);
  return undefined;
}

function toOutboundResponse(outcome: UIForwardOutcome): Record<string, unknown> {
  if ("value" in outcome) {
    return { type: outcome.type, id: outcome.id, value: outcome.value };
  }
  if ("confirmed" in outcome) {
    return { type: outcome.type, id: outcome.id, confirmed: outcome.confirmed };
  }
  return { type: outcome.type, id: outcome.id, cancelled: true };
}

function addUsage(a: Usage, b: Usage): Usage {
  return {
    input: a.input + b.input,
    output: a.output + b.output,
    cacheRead: a.cacheRead + b.cacheRead,
    cacheWrite: a.cacheWrite + b.cacheWrite,
    ...addOptionalUsage(a, b, "cacheWrite1h"),
    ...addOptionalUsage(a, b, "reasoning"),
    totalTokens: a.totalTokens + b.totalTokens,
    cost: {
      input: a.cost.input + b.cost.input,
      output: a.cost.output + b.cost.output,
      cacheRead: a.cost.cacheRead + b.cost.cacheRead,
      cacheWrite: a.cost.cacheWrite + b.cost.cacheWrite,
      total: a.cost.total + b.cost.total,
    },
  };
}

function addOptionalUsage(a: Usage, b: Usage, field: "cacheWrite1h" | "reasoning"): Partial<Usage> {
  const left = a[field];
  const right = b[field];
  return left === undefined && right === undefined ? {} : { [field]: (left ?? 0) + (right ?? 0) };
}

function normaliseStopReason(value: string | undefined): "stop" | "length" | "error" | "aborted" | "toolUse" {
  return value === "stop" || value === "length" || value === "aborted" || value === "toolUse" ? value : "error";
}

export interface AuthoritativeSettlement { message: WireAssistantMessage; toolSequenceCompleted: boolean }

export type AuthoritativeSettlementScan =
  | { kind: "found"; evidence: AuthoritativeSettlement }
  | { kind: "absent" }
  | { kind: "invalid" };

export function authoritativeSettlement(entries: readonly unknown[]): AuthoritativeSettlementScan {
  let final: WireAssistantMessage | undefined;
  const outstanding = new Set<string>();
  for (const value of entries) {
    if (typeof value !== "object" || value === null) continue;
    const entry = value as { type?: unknown; message?: unknown };
    if (entry.type !== "message" || typeof entry.message !== "object" || entry.message === null) continue;
    const message = entry.message as { role?: unknown };
    if (message.role === "assistant") {
      if (!Value.Check(AssistantMessageSchema, entry.message)) return { kind: "invalid" };
      final = Value.Decode(AssistantMessageSchema, entry.message);
      outstanding.clear();
      for (const item of final.content) if (item.type === "toolCall" && typeof item.id === "string") outstanding.add(item.id);
    } else if (message.role === "toolResult") {
      const toolCallId = (entry.message as { toolCallId?: unknown }).toolCallId;
      if (typeof toolCallId === "string") outstanding.delete(toolCallId);
    }
  }
  return final === undefined
    ? { kind: "absent" }
    : { kind: "found", evidence: { message: final, toolSequenceCompleted: outstanding.size === 0 } };
}

