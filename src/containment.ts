import type {
  AbsolutePath,
  RunAttemptId,
  VerifiedContainmentReceiptPath,
} from "./domain.ts";

export interface ContainmentDescriptor {
  readonly backend: "cgroup-v2";
  readonly scopePath: AbsolutePath;
}

export type ContainmentOutcome =
  | "no_process"
  | "terminated"
  | "spawn_failed"
  | "invalid_launch";

export interface ContainmentAttempt {
  readonly attemptId: RunAttemptId;
  /** Canonical parent scope resolved by the containment backend. */
  readonly parentScope: AbsolutePath;
  readonly descriptor: ContainmentDescriptor;
  terminate(outcome: ContainmentOutcome): Promise<VerifiedContainmentReceiptPath>;
  verifyEmpty(): Promise<void>;
  cleanup(proof?: VerifiedContainmentReceiptPath): Promise<void>;
}

export interface ContainmentBackend {
  readonly root: AbsolutePath;
  readonly parentScope: AbsolutePath;
  preflight(): Promise<void>;
  prepareAttempt(attemptId: RunAttemptId): ContainmentAttempt;
  restoreAttempt(attemptId: RunAttemptId, descriptor: ContainmentDescriptor): ContainmentAttempt;
  shutdown(): Promise<void>;
}
