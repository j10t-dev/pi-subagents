import {
  agentRunKey,
  AgentErrorCode,
  AgentState,
  CodedError,
  CompletionState,
  type AgentCompletion,
  type AgentId,
  type CommittedOutputPath,
  type Milliseconds,
  type RunId,
  type SessionPath,
} from "./domain.ts";
import { AbortError, Mutex } from "./async-primitives.ts";

/**
 * Live inventory entry for one owned agent. Registered/updated by the caller (the run
 * controller, wired in a later task) through `upsertAgent()`, and refreshed automatically by
 * `publish()` whenever a completion arrives for that agent.
 */
export interface AgentSummary {
  agentId: AgentId;
  state: AgentState;
  transcriptPath: SessionPath;
  currentRunId?: RunId;
  latestCompletionState?: CompletionState;
  latestOutputPath?: CommittedOutputPath;
}

export interface ReceiveOptions {
  timeoutMs?: Milliseconds;
  signal?: AbortSignal;
}

export interface ReceiveAgentResult {
  completions: AgentCompletion[];
  agents: AgentSummary[];
  timedOut: boolean;
}

export interface PublishResult {
  /** True only on an empty-to-non-empty queue transition with no active receiver. */
  shouldNotify: boolean;
  queueSize: number;
}

/** Minimal restored-agent shape `restore()` needs; matches `persistence.ts`'s `RestoredAgentRecord`. */
export interface RestorableAgent {
  agentId: AgentId;
  state: AgentState;
  sessionPath: SessionPath;
  currentRunId?: RunId;
  latestCompletion?: AgentCompletion;
}

export interface RestoreResult {
  /** Number of agents whose latest completion became queued again for delivery. */
  backPingCount: number;
}

interface CompletionWaiter {
  readonly id: symbol;
  wake(): void;
}

/**
 * Durable bounded run-outcome queue with batched draining, modelled on a Java completion
 * service / Tokio join set. Completion arrival, receiver wake-up, timeout, and cancellation are
 * all arbitrated under one short mutex so a race between them always has exactly one winner.
 */
export class CompletionService {
  private readonly mutex = new Mutex();
  private readonly queue: AgentCompletion[] = [];
  private readonly publishedRuns = new Set<string>();
  private readonly agents = new Map<AgentId, AgentSummary>();
  private waitingReceiver: CompletionWaiter | undefined;
  private notifiedSinceEmpty = false;
  private liveOperationsStarted = false;


  /** Registers or updates the live state of an owned agent (spawn, run start, run stop, ...). */
  upsertAgent(summary: AgentSummary): void {
    this.liveOperationsStarted = true;
    const previous = this.agents.get(summary.agentId);
    this.agents.set(summary.agentId, {
      ...summary,
      ...(summary.latestCompletionState !== undefined || previous?.latestCompletionState === undefined
        ? {} : { latestCompletionState: previous.latestCompletionState }),
      ...(summary.latestOutputPath !== undefined || previous?.latestOutputPath === undefined
        ? {} : { latestOutputPath: previous.latestOutputPath }),
    });
  }

  /**
   * Publishes a terminal completion. Wakes an active receiver if one is waiting; otherwise
   * reports whether this is an empty-to-non-empty transition that should trigger a back-ping.
   */
  async publish(completion: AgentCompletion): Promise<PublishResult> {
    this.liveOperationsStarted = true;
    return this.mutex.runExclusive(() => {
      const key = completionKey(completion);
      if (this.publishedRuns.has(key)) return { shouldNotify: false, queueSize: this.queue.length };
      this.publishedRuns.add(key);
      const wasEmpty = this.queue.length === 0;
      this.queue.push(completion);
      this.upsertCompletionSummaryLocked(completion);

      const waiting = this.waitingReceiver;
      if (waiting !== undefined) {
        this.waitingReceiver = undefined;
        waiting.wake();
        return { shouldNotify: false, queueSize: this.queue.length };
      }

      if (wasEmpty && !this.notifiedSinceEmpty) {
        this.notifiedSinceEmpty = true;
        return { shouldNotify: true, queueSize: this.queue.length };
      }
      return { shouldNotify: false, queueSize: this.queue.length };
    });
  }

  /**
   * Drains queued completions immediately when present; otherwise blocks while an agent is
   * `Running` or `Stopping`, until a completion arrives, the timeout elapses, or `signal` aborts.
   * Returns an empty, non-timed-out batch immediately when nothing is queued and no run is active.
   */
  async receive(options: ReceiveOptions = {}): Promise<ReceiveAgentResult> {
    this.liveOperationsStarted = true;
    let resolveFn!: (result: ReceiveAgentResult) => void;
    let rejectFn!: (error: unknown) => void;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let settled = false;
    const promise = new Promise<ReceiveAgentResult>((resolve, reject) => {
      resolveFn = resolve;
      rejectFn = reject;
    });
    const cleanup = (): void => {
      if (timer !== undefined) {
        clearTimeout(timer);
        timer = undefined;
      }
      options.signal?.removeEventListener("abort", onAbort);
    };
    const finish = (result: ReceiveAgentResult): void => {
      if (settled) return;
      settled = true;
      cleanup();
      resolveFn(result);
    };
    const fail = (error: unknown): void => {
      if (settled) return;
      settled = true;
      cleanup();
      rejectFn(error);
    };
    const waiter: CompletionWaiter = {
      id: Symbol("completion-receiver"),
      wake: () => {
        finish({
          completions: this.tryDrainLocked() ?? [],
          agents: this.snapshotAgentsLocked(),
          timedOut: false,
        });
      },
    };
    const onAbort = (): void => {
      void this.finishWaitLocked(waiter, () => fail(new AbortError()));
    };

    const outcome = await this.mutex.runExclusive(() => {
      const drained = this.tryDrainLocked();
      if (drained !== undefined) return { kind: "immediate" as const, completions: drained };
      if (!this.hasActiveRunsLocked()) return { kind: "empty" as const };
      if (options.timeoutMs === 0) return { kind: "poll" as const };
      if (this.waitingReceiver !== undefined) return { kind: "rejected" as const };
      this.waitingReceiver = waiter;
      return { kind: "pending" as const };
    });

    if (outcome.kind === "immediate") {
      return { completions: outcome.completions, agents: this.snapshotAgents(), timedOut: false };
    }
    if (outcome.kind === "empty") {
      return { completions: [], agents: this.snapshotAgents(), timedOut: false };
    }
    if (outcome.kind === "poll") {
      return { completions: [], agents: this.snapshotAgents(), timedOut: true };
    }
    if (outcome.kind === "rejected") {
      fail(new CodedError(AgentErrorCode.InvalidState));
      return promise;
    }

    if (!settled) {
      if (options.signal?.aborted) {
        await this.finishWaitLocked(waiter, () => fail(new AbortError()));
      } else {
        options.signal?.addEventListener("abort", onAbort, { once: true });
        if (options.timeoutMs !== undefined) {
          timer = setTimeout(() => {
            void this.finishWaitLocked(waiter, () => {
              finish({ completions: [], agents: this.snapshotAgentsLocked(), timedOut: true });
            });
          }, options.timeoutMs);
        }
      }
    }

    return promise;
  }

  /**
   * Hydrates the inventory from a restored branch fold and re-queues each agent's latest
   * completion for duplicate-visibility delivery, per restoration semantics. This startup-only
   * mutation is sealed as soon as a live upsert, publish, or receive operation begins.
   */
  restore(records: Iterable<RestorableAgent>): RestoreResult {
    if (this.liveOperationsStarted) throw new Error("invalid_state: restoration is sealed after live completion operations begin");
    let backPingCount = 0;
    for (const record of records) {
      const summary: AgentSummary = {
        agentId: record.agentId,
        state: record.state,
        transcriptPath: record.sessionPath,
      };
      if (record.currentRunId !== undefined) {
        summary.currentRunId = record.currentRunId;
      }
      if (record.latestCompletion !== undefined) {
        summary.latestCompletionState = record.latestCompletion.state;
        summary.latestOutputPath = record.latestCompletion.outputPath;
      }
      this.agents.set(record.agentId, summary);
      if (record.latestCompletion !== undefined) {
        const key = completionKey(record.latestCompletion);
        if (!this.publishedRuns.has(key)) {
          this.publishedRuns.add(key);
          this.queue.push(record.latestCompletion);
          backPingCount += 1;
        }
      }
    }
    return { backPingCount };
  }

  /** Full inventory of every owned agent, including agents with no completion yet. */
  snapshotAgents(): AgentSummary[] {
    return this.snapshotAgentsLocked();
  }

  queuedCount(): number { return this.queue.length; }

  private snapshotAgentsLocked(): AgentSummary[] {
    return Array.from(this.agents.values(), (summary) => ({ ...summary }));
  }

  private hasActiveRunsLocked(): boolean {
    for (const summary of this.agents.values()) {
      if (summary.state === AgentState.Running || summary.state === AgentState.Settling || summary.state === AgentState.Stopping) {
        return true;
      }
    }
    return false;
  }

  private tryDrainLocked(): AgentCompletion[] | undefined {
    if (this.queue.length === 0) {
      return undefined;
    }
    const drained = this.queue.splice(0, this.queue.length);
    this.notifiedSinceEmpty = false;
    return drained.map((completion) => ({
      ...completion,
      output: { ...completion.output },
      ...(completion.state === CompletionState.Failed ? { error: { ...completion.error } } : {}),
      ...(completion.usage === undefined
        ? {}
        : {
            usage: {
              ...completion.usage,
              usage: {
                ...completion.usage.usage,
                cost: { ...completion.usage.usage.cost },
              },
            },
          }),
    }));
  }

  private upsertCompletionSummaryLocked(completion: AgentCompletion): void {
    this.agents.set(completion.agentId, {
      agentId: completion.agentId,
      state: AgentState.Stopped,
      transcriptPath: completion.transcriptPath,
      latestCompletionState: completion.state,
      latestOutputPath: completion.outputPath,
    });
  }

  private async finishWaitLocked(waiter: CompletionWaiter, finish: () => void): Promise<void> {
    await this.mutex.runExclusive(() => {
      if (this.waitingReceiver !== waiter) return;
      this.waitingReceiver = undefined;
      finish();
    });
  }
}

function completionKey(completion: Pick<AgentCompletion, "agentId" | "runId">): string {
  return agentRunKey(completion.agentId, completion.runId);
}
