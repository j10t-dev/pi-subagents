import type {
  AbsolutePath,
  CgroupScopePath,
  RunAttemptId,
  VerifiedContainmentReceiptPath,
} from "./domain.ts";

export interface ContainmentCandidateDescriptor {
  readonly backend: "cgroup-v2";
  readonly scopePath: AbsolutePath;
}

export interface RestorationContainmentDescriptor {
  readonly backend: "cgroup-v2";
  readonly scopePath: AbsolutePath;
}

export interface ContainmentDescriptor {
  readonly backend: "cgroup-v2";
  readonly scopePath: CgroupScopePath;
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
  /** Deterministic lexical preparation; this does not claim that the scope exists. */
  readonly candidate: ContainmentCandidateDescriptor;
  /** Promotes matching runtime evidence only after canonical scope containment is proven. */
  proveRuntimeDescriptor(evidence: RestorationContainmentDescriptor): ContainmentDescriptor;
  terminate(outcome: ContainmentOutcome): Promise<VerifiedContainmentReceiptPath>;
  verifyEmpty(): Promise<void>;
  cleanup(proof?: VerifiedContainmentReceiptPath): Promise<void>;
}

export interface ContainmentBackend {
  readonly root: AbsolutePath;
  readonly parentScope: AbsolutePath;
  preflight(): Promise<void>;
  prepareAttempt(attemptId: RunAttemptId): ContainmentAttempt;
  restoreAttempt(
    attemptId: RunAttemptId,
    descriptor: RestorationContainmentDescriptor,
  ): ContainmentAttempt;
  shutdown(): Promise<void>;
}
