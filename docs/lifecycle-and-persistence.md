# Lifecycle and persistence

This document defines internal invariants. User-visible lifecycle semantics remain in the root [README](../README.md). See [Architecture](architecture.md) for module ownership.

## Identities

- `agentId` is the native Pi child-session identity and durable ownership key.
- `runId` is the native user-entry identity for one accepted assignment and identifies one durable outcome.
- A display ordinal is derived from accepted `Spawned` positions in the active branch. It is not a native or durable process identity.
- `attemptId` identifies one launch or relaunch containment attempt.

Do not substitute one identity for another or represent internal identities as unbranded strings.

## Agent state

Legal transitions are:

```text
stopped → running
running → settling → stopped
running → stopping → stopped
```

- `running` admits no concurrent assignment for the same agent.
- `settling` means execution ended but containment or terminal persistence is unresolved.
- `stopping` means cancellation was persisted and containment is in progress.
- `stopped` is reusable only after the active attempt's obligations are resolved.

Completion states are `completed`, `failed` and `cancelled`. They are durable outcomes, not agent lifecycle states.

## Persisted events

Lifecycle events are Pi custom entries appended through `AgentEventAppender`:

1. `Spawned` records immutable child identity, session path, working directory, model, thinking and accepted tools.
2. `RunLaunchRequested` records the attempt and containment evidence required to reconcile an interrupted launch.
3. `RunStarted` binds the attempt to its authoritative `runId`.
4. `RunStopping` records cancellation intent before abort or forced containment.
5. `RunCompleted` records the durable completion DTO.

A normal completed run omits `RunStopping`. Multi-event terminal transitions reserve the shared persistence sequencer so another operation cannot interleave between their events.

New writes use the current event schema. Historical schema version 1 remains restoration input; its launch-request event lacks the version-2 containment descriptor and must retain historical interpretation.

## Publication ordering

A completion is not durable merely because the provider stopped producing output.

```text
provider settlement
  → recover/stage bounded output and diagnostics
  → atomically publish committed output
  → append RunCompleted
  → publish completion to inventory and observations
```

The committed output path is authoritative after publication. Inline output is bounded context; the committed sidecar and child transcript remain authoritative when truncation occurs.

Raw provider, RPC and stderr data must not cross into public completion results. Public failures use stable codes and bounded messages; detailed diagnostics belong in owner-only files referenced by path.

## Containment and capacity

There is no detached execution. Parent shutdown, reload, resume, new-session and fork replacement own cancellation and process containment.

Capacity remains occupied while any of these are unresolved:

- a launch may have created a process;
- cgroup emptiness has not been proved;
- a containment receipt has not been verified;
- terminal output publication failed;
- `RunCompleted` has not been durably appended.

Cleanup and containment operations must be idempotent. A watchdog remains outside the child cgroup so it can terminate and verify that scope. A configured cgroup root is never removed by the extension; extension-created roots are removed only under their ownership conditions.

## Restoration authority

Restoration reads all lifecycle custom entries in the active parent branch, not only entries retained in compacted model context. Invalid records or impossible sequences produce bounded diagnostics and do not acquire ownership.

Restoration separates three stages:

```text
collect durable evidence
  → plan required actions
  → apply containment, start or completion obligations
```

Important consequences:

- an accepted `Spawned` event reserves its display position even if launch later fails;
- launch evidence without a terminal event may require containment before capacity is released;
- a provider-visible assignment may require a missing `RunStarted` event to be repaired;
- durable terminal evidence may require completion publication to be repaired;
- restoration may re-expose a completion that was collected before reload because collection attempts are not persisted;
- duplicate visibility is recognised by stable `runId`.

Restoration never grants lifecycle tools omitted by the persisted allowlist. It may remove them when the current depth policy is more restrictive.

## Completion delivery

`await_agent` delivers at most one newly ready completion and a bounded lexical inventory page. Paging cursors operate on native agent IDs, not display ordinals. Complete summaries are never sliced to fit the provider envelope; inventory metadata reports omissions and remaining entries.

A completion leaving the ready queue does not erase its durable event or output. Restoration can reconstruct visibility from persistence.

## Branch and replacement safety

Lifecycle ownership follows persisted branch entries. Branch navigation is rejected while active children would make ownership ambiguous. Controller replacement is serialised: the old controller closes and contains its work before a restored replacement becomes active.

## Change checklist

When changing lifecycle or persistence:

- update state, event payload, decoder, fold and restoration behaviour together;
- preserve historical schema semantics;
- prove output durability before terminal persistence;
- keep containment and terminal-persistence failures capacity-owning;
- test shutdown, interrupted launch, stopping, restoration and duplicate visibility;
- update projections only after the authoritative transition is defined.
