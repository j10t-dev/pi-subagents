# Verification

Use the smallest check that proves the claim, then run the complete required gates before committing code. The optimised runner groups independent suites and replays their output in a deterministic order.

## Standard gates

```sh
bun install --frozen-lockfile
bun run check
bun run test
```

`bun run check` aggregates the static gates. Run any of them on its own when it gives the shortest feedback loop:

```sh
bun run typecheck
bun run lint
bun run check:architecture
```

- `bun run typecheck` owns strict TypeScript checking without emission.
- `bun run lint` owns the typed ESLint rules over `index.ts`, `src`, `test` and `scripts`.
- `bun run check:architecture` owns the production dependency policy: no runtime cycles, no upward foundation dependency and no authority dependency from projection modules.
- `bun run check` runs those three in the displayed order and is fail-fast, so a failure stops the aggregate before the later tools start and the failing tool is unambiguous.
- Failures retain each tool's native diagnostics; the aggregate adds no wrapper formatting.
- dependency-cruiser runs entirely local from a development dependency. It contacts no network service and publishes no report.
- `bun run test` remains the independently grouped suite and is not part of `check`. It discovers every non-live `*.test.ts`, requires exactly one group owner and runs groups concurrently where safe.
- The live-model smoke is deliberately excluded from normal discovery.

Documentation-only changes require link/path inspection and the standard gates when they alter executable command guidance. If unrelated concurrent code prevents a standard gate, report that evidence rather than treating the documentation as verified by assumption.

### Advisory dead-code audit

Knip was evaluated once during the change that introduced these gates. It is not installed, not scripted and not required: the repository carries no Knip dependency, script or configuration, and no gate depends on it. Recurring adoption needs a separate approved design covering its entry-point model and the handling of its false positives.

## Test groups

| Command | Boundary |
|---|---|
| `bun run test:unit` | Pure domain, selection, persistence helpers, widget models and runner behaviour |
| `bun run test:transport` | JSONL, RPC, output bounds, context observation and UI forwarding |
| `bun run test:process` | cgroup, watchdog, launcher and abrupt-process behaviour |
| `bun run test:controller` | Lifecycle, restoration, extension and tool scenarios |
| `bun run test:integration` | Real Pi registration and RPC integration |

A new normal test must be assigned in `scripts/test-groups.ts`. Keep opt-in live tests explicitly separate.

Run a focused test during development when it gives the shortest feedback loop:

```sh
bun test test/<name>.test.ts
```

A focused pass does not replace the standard gates.

## Host containment prerequisite

New launches require Linux cgroup v2 with writable delegation. Check the host before deployment or when investigating containment failures:

```sh
bun run check:cgroup
```

`subagents.cgroupRoot` is configured through global Pi settings. `PI_SUBAGENTS_CGROUP_ROOT` is accepted by the standalone check script for probing a pre-provisioned root; it is not extension configuration.

Process and integration suites may fail before product behaviour when the host cannot delegate cgroups or the global Pi entrypoint cannot be resolved. Preserve the reported prerequisite failure.

## Integration tests

Use these after changes to production composition, lifecycle registration, RPC launch or restoration:

```sh
bun run test:process
bun run test:integration
```

Integration tests target the globally installed Pi runtime. Never add a fixed Pi release requirement to make a fixture pass.

## Live-model smoke

The opt-in smoke covers parent `spawn_agent`, child `web_fetch`, parent `await_agent` and successful completion through a real provider:

```sh
bun run test:live-model
```

It requires:

- `PI_SUBAGENTS_LIVE_SMOKE=1`, set by the package script;
- the smoke's requested model in the current Pi registry;
- usable provider credentials;
- an active `web_fetch` tool.

Missing opt-in, model or credentials is an explicit pre-start skip, not a product pass. Missing `web_fetch`, failure to use it, child launch failure or lifecycle failure is a test failure. Run this separately from default and integration suites; it is evidence for the covered journey only.

## Failure interpretation

- A TDD red is expected only when deliberately proving a missing behaviour before implementation.
- A prerequisite skip is neither a pass nor a regression.
- A timeout, missing export, provider-registry failure or malformed fixture is a harness failure until classified.
- Completion claims require fresh command output and exit status.
- When output is truncated, use the authoritative transcript, output or diagnostics path.

## Change-to-check guide

| Change | Minimum additional evidence |
|---|---|
| Domain type, schema or parser | focused test, typecheck, standard tests |
| RPC framing or output bounds | transport group |
| Controller, events or restoration | controller group |
| Watchdog, launcher or cgroup | process group and `check:cgroup` where available |
| Pi composition or extension registration | integration group |
| Live provider/tool journey | opt-in live-model smoke |
| Widget interaction or focus | relevant widget test and real-Pi gate when behaviour crosses the TUI boundary |
