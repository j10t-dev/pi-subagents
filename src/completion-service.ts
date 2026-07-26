import {
  agentRunKey,
  AgentErrorCode,
  AgentState,
  CodedError,
  CompletionState,
  type AgentCompletion,
  type AgentId,
  type AgentRunKey,
  agentCount,
  type AgentCount,
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

export interface AwaitOptions {
  readonly timeoutMs?: Milliseconds;
  readonly signal?: AbortSignal;
}

export interface CompletionAwaitResult {
  readonly completion?: AgentCompletion;
  readonly remainingCompletions: AgentCount;
  readonly agents: readonly AgentSummary[];
  readonly timedOut: boolean;
}

export interface CompletionAuthoritySnapshot {
  readonly agents: readonly AgentSummary[];
  readonly pendingDelivery: ReadonlySet<AgentRunKey>;
}

export interface ReadyNotificationCandidate {
  readonly epoch: AgentRunKey;
  readonly readyCount: AgentCount;
}

/** Stable DTO consumed by `restore()` and populated by the planner adapter. */
export interface RestorableAgent {
  agentId: AgentId;
  state: AgentState;
  sessionPath: SessionPath;
  currentRunId?: RunId;
  latestCompletion?: AgentCompletion;
}

interface CompletionWaiter {
  readonly id: symbol;
  wake(): void;
}

/**
 * Durable bounded run-outcome queue with one-at-a-time delivery, modelled on a Java completion
 * service / Tokio join set. Completion arrival, receiver wake-up, timeout, and cancellation are
 * all arbitrated under one short mutex so a race between them always has exactly one winner.
 */
export class CompletionService {
  private readonly mutex = new Mutex();
  private readonly queue: AgentCompletion[] = [];
  private readonly publishedRuns = new Set<AgentRunKey>();
  private readonly agents = new Map<AgentId, AgentSummary>();
  private waitingReceiver: CompletionWaiter | undefined;
  private notificationEpoch: AgentRunKey | undefined;
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

  /** Publishes a terminal completion and creates an eligible notification candidate when needed. */
  async publish(completion: AgentCompletion): Promise<void> {
    this.liveOperationsStarted = true;
    await this.mutex.runExclusive(() => {
      const key = completionKey(completion);
      if (this.publishedRuns.has(key)) return;
      this.publishedRuns.add(key);
      const wasEmpty = this.queue.length === 0;
      this.queue.push(completion);
      this.upsertCompletionSummaryLocked(completion);

      const waiting = this.waitingReceiver;
      if (waiting !== undefined) {
        this.waitingReceiver = undefined;
        waiting.wake();
        return;
      }

      if (wasEmpty) this.notificationEpoch = key;
    });
  }

  async readyNotification(): Promise<ReadyNotificationCandidate | undefined> {
    return this.mutex.runExclusive(() => this.notificationEpoch === undefined
      ? undefined
      : { epoch: this.notificationEpoch, readyCount: agentCount(this.queue.length) });
  }

  async acknowledgeReadyNotification(epoch: AgentRunKey): Promise<void> {
    await this.mutex.runExclusive(() => {
      if (this.notificationEpoch === epoch) this.notificationEpoch = undefined;
    });
  }

  /**
   * Drains queued completions immediately when present; otherwise blocks while an agent is
   * `Running` or `Stopping`, until a completion arrives, the timeout elapses, or `signal` aborts.
   * Returns an empty, non-timed-out batch immediately when nothing is queued and no run is active.
   */
  async awaitReady(options: AwaitOptions = {}): Promise<CompletionAwaitResult> {
    this.liveOperationsStarted = true;
    let resolveFn!: (result: CompletionAwaitResult) => void;
    let rejectFn!: (error: unknown) => void;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let settled = false;
    const promise = new Promise<CompletionAwaitResult>((resolve, reject) => {
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
    const finish = (result: CompletionAwaitResult): void => {
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
        const completion = this.tryDrainLocked();
        finish({
          ...(completion === undefined ? {} : { completion }),
          remainingCompletions: agentCount(this.queue.length),
          agents: this.snapshotAgentsLocked(),
          timedOut: false,
        });
      },
    };
    const onAbort = (): void => {
      void this.finishWaitLocked(waiter, () => fail(new AbortError()));
    };

    const outcome = await this.mutex.runExclusive(() => {
      const completion = this.tryDrainLocked();
      if (completion !== undefined) return { kind: "immediate" as const, completion, remainingCompletions: agentCount(this.queue.length), agents: this.snapshotAgentsLocked() };
      if (!this.hasActiveRunsLocked()) return { kind: "empty" as const, agents: this.snapshotAgentsLocked() };
      if (options.timeoutMs === 0) return { kind: "poll" as const, agents: this.snapshotAgentsLocked() };
      if (this.waitingReceiver !== undefined) return { kind: "rejected" as const };
      this.waitingReceiver = waiter;
      return { kind: "pending" as const };
    });

    if (outcome.kind === "immediate") {
      return { completion: outcome.completion, remainingCompletions: outcome.remainingCompletions, agents: outcome.agents, timedOut: false };
    }
    if (outcome.kind === "empty") {
      return { remainingCompletions: agentCount(0), agents: outcome.agents, timedOut: false };
    }
    if (outcome.kind === "poll") {
      return { remainingCompletions: agentCount(0), agents: outcome.agents, timedOut: true };
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
              finish({ remainingCompletions: agentCount(this.queue.length), agents: this.snapshotAgentsLocked(), timedOut: true });
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
  restore(records: Iterable<RestorableAgent>): void {
    if (this.liveOperationsStarted) throw new Error("invalid_state: restoration is sealed after live completion operations begin");
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
        }
      }
    }
  }

  /** Non-destructive authoritative inventory and exact queued delivery identities. */
  authoritySnapshot(): CompletionAuthoritySnapshot {
    return {
      agents: Object.freeze(this.snapshotAgentsLocked().map((summary) => Object.freeze(summary))),
      pendingDelivery: new Set(this.queue.map(completionKey)),
    };
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

  private tryDrainLocked(): AgentCompletion | undefined {
    const completion = this.queue.shift();
    if (completion === undefined) return undefined;
    this.notificationEpoch = undefined;
    return {
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
    };
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

export function completionKey(
  completion: Pick<AgentCompletion, "agentId" | "runId">,
): AgentRunKey {
  return agentRunKey(completion.agentId, completion.runId);
}
