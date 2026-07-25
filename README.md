# Pi subagents extension

Linux-only global extension for Pi. It requires Node 22.19 or newer.

## Tools

- `spawn_agent({ task, model?, cwd?, tools? })` starts a fresh persistent child session and returns its native Pi session ID as `agentId` and first assignment user-entry ID as `runId`.
- `send_input({ agentId, message })` resumes an owned child. The child must be stopped; concurrent or pre-emptive input is rejected.
- `await_agent({ timeoutMs?, afterAgentId? })` returns at most one newly ready completion plus a lexical page of the current owned-agent inventory. A zero timeout polls. Each page contains at most 100 complete summaries; pass `nextAfterAgentId` back as `afterAgentId` to continue strictly after that native ID. Exact `total`, `omitted`, and `remaining` metadata describes the current page.
- `stop_agent({ agentIds })` stops one or more owned children and returns one outcome per supplied ID.

Children discover normal global and trusted-project context, extensions, prompts, and skills. Lifecycle tools are suppressed when `PI_SUBAGENT_CHILD=1`; unrelated child extensions remain active. Trust is inherited only when the child's real working directory is within the trusted parent project; external working directories perform Pi's normal trust check.

Model selection uses extension-owned patterns over Pi's public model catalogue. Omit `model` to inherit the parent's provider, model, and thinking level. Supply a bare model, qualified model, or thinking suffix explicitly:

```text
spawn_agent({ task: "Check the release notes." })
spawn_agent({ task: "Check the release notes.", model: "gpt-5.6-luna" })
spawn_agent({ task: "Check the release notes.", model: "openai-codex/gpt-5.6-luna" })
spawn_agent({ task: "Check the release notes.", model: "openai-codex/gpt-5.6-luna:minimal" })
```

Exact qualified identifiers take precedence. An exact bare identifier prefers the parent model's provider, then resolves when unique across providers; it is rejected when multiple non-parent providers remain ambiguous. Partial matching is case-insensitive across IDs and display names, prefers aliases over dated releases, and resolves remaining ties by descending `provider/id`. A qualified ID that remains unmatched after exact and partial resolution under a known provider uses a custom model-ID fallback and reports a warning.

An explicit model without a thinking suffix retains the parent's thinking level. Pi applies its existing model-specific clamping when that level is unsupported. Child model and thinking selection are process-startup overrides; they do not change Pi's global defaults for later parent sessions.

Omitting `tools` inherits every eligible parent-active tool. Explicit tools form an exact allowlist over parent-active built-in, extension, and custom tools. Configured but inactive tools cannot be re-enabled by a child. An empty list enables no tools:

```text
spawn_agent({ task: "Inspect the current project." })
spawn_agent({ task: "Retrieve the current temperature.", tools: ["web_fetch"] })
spawn_agent({ task: "Reason without tools.", tools: [] })
```

## Configuration

The default concurrency limit is `4`. Override it in global `~/.pi/agent/settings.json` without adding an extension path:

```json
{
  "subagents": {
    "maxConcurrentRuns": 4,
    "maxDepth": 2,
    "cgroupRoot": "/sys/fs/cgroup/my-delegated-subtree"
  }
}
```

`maxDepth` is global-only. Its default is `1`, `0` is the kill switch, and the hard maximum is `8`. Depth zero is the root, depth one is a child, and depth two is a grandchild. Recursive configurations that could create more than 100 child processes fall back to depth one. Managed descendants inherit the concurrency capacity; they cannot override it locally. With capacity four and depth two, the maximum is 20 concurrent children: four children and 16 grandchildren.

Lifecycle tools are inherited or allowlisted only below the depth boundary. A restored allowlist can lose lifecycle tools when a lower depth policy applies, but it never gains tools omitted by the original allowlist. The `spawn_agent` prompt guideline remains unchanged and applies only while that tool is active.

cgroup v2 with writable delegation is mandatory for new launches. `subagents.cgroupRoot` is accepted only in global `settings.json`; it must be pre-provisioned, absolute, and beneath the cgroup-v2 mount. A configured `cgroupRoot` is used only by the managed root controller; descendants derive roots beneath their current ancestor-owned cgroup. A configured root is never removed. Without it, the extension creates a `pi-subagents` child below the current unified cgroup and removes that root only when it created it, its parent scope was removed, and it is empty. Forced containment kills descendants, but orphaned nested state may require manual cleanup. Unsupported environments fail before launcher or Pi child creation with stable `containment_failed`.

Run `bun run check:cgroup` before deployment to verify the host prerequisite. Version-1 receipts remain restoration compatibility only; new launches publish version-2 cgroup receipts.

Child sessions are stored beneath the extension state directory, partitioned by parent session ID. Each completion includes its durable output and child transcript paths. Failure objects may include a diagnostics path. Containment receipts live beside the corresponding run state. These paths are authoritative when inline output is truncated.

## Context-safety limits

- ordinary RPC record: 16 MiB plus the decoder's UTF-8 carry;
- stderr tail: 50 KB;
- persisted completion output: 50 KB;
- persisted and model-visible error: 10 KB;
- final provider-visible JSON per `await_agent`: 50 KB; the complete envelope, page metadata and cursor, optional completion metadata, and at least one eligible complete summary are reserved first, then the single completion output receives the deterministic residual allowance at a complete UTF-8 code-point boundary;
- bounded transcript recovery tail: 32 MiB.

Oversized or malformed records are discarded or converted to bounded diagnostics. Full output remains in the sidecar or transcript. A later `await_agent` and unrelated parent tools remain usable.

## Lifecycle semantics

Human-facing agent ordinals derive from accepted unique `Spawned` positions in one active parent branch. They are stable within that branch, rejected agents retain their reserved positions, and ordinals are re-derived after branch replacement; they are display identities rather than native IDs.

Parent shutdown contains every active process group before returning. There is no detached execution: quit, reload, new-session, resume, and fork shutdown paths own cancellation. Version 1 does not persist collection attempts or inspect parent tool-result entries. Restoration re-exposes each owned agent’s latest persisted completion to the next `await_agent` and may therefore return a completion that was collected before reload or resume. No automatic message is sent on restoration; `agents: … result(s) ready` in the status bar is the passive discovery surface. The stable `runId` identifies duplicate visibility of the same durable outcome. Lifecycle ownership follows persisted parent custom entries and therefore survives compaction; branch navigation is rejected while active children would make ownership ambiguous. Reload closes the old controller before restoring its replacement.

## Contributor documentation

Architecture, lifecycle invariants and the canonical verification matrix live in [`docs/`](docs/README.md).
