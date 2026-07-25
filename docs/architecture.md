# Architecture

This document maps ownership and representative execution paths. Public behaviour remains in the root [README](../README.md); lifecycle details are in [Lifecycle and persistence](lifecycle-and-persistence.md).

## Authority model

| Concern | Authority | Projection or evidence |
|---|---|---|
| Live agent and run ownership | `SubagentController` and `RunController` | observation store, widget, tool output |
| Durable lifecycle | Pi custom entries written by `AgentEventAppender` | restored controller state |
| Child execution | Pi child session and RPC transport | bounded transcript and usage observations |
| Process containment | cgroup backend, watchdog and receipts | restored containment descriptors |
| Completion output | committed `OutputStore` publication | bounded inline output |

Projection failures must not mutate lifecycle authority. Reconciliation repairs projections from controller state.

## Responsibility map

### Entrypoints and presentation

- `index.ts` registers lifecycle tools, serialises Pi session events and owns controller replacement.
- `agent-widget.ts` and `src/agent-widget/` mount and render the bounded agent widget.
- `src/agent-observation*.ts`, `src/context-observation.ts`, `src/observation-registry.ts`, `src/tool-presentation.ts` and `src/ui-forwarder.ts` project bounded status. They do not own lifecycle state.

### Orchestration

- `src/controller.ts` owns admission, capacity, lifecycle operations, restoration application and shutdown.
- `src/run-controller.ts` owns one agent's active attempt and terminal settlement.
- `src/completion-service.ts` owns completion delivery, inventory paging and restored-result visibility.
- `src/pi-composition.ts` binds production dependencies and transfers containment to controller ownership before launch construction.

### Selection and host integration

- `src/child-selection.ts` resolves provider, model, thinking and tools.
- `src/delegation-policy.ts` owns depth and descendant-capacity policy.
- `src/settings.ts` validates global and trusted-project configuration.
- `src/pi-launcher.ts` resolves the current Pi invocation and builds RPC launch specifications. PATH fallback is forbidden.

### Transport and output

- `src/rpc-wire.ts` owns RPC framing and structural decoding.
- `src/rpc-client.ts` owns child RPC commands, events and settlement observation.
- `src/output-store.ts` stages diagnostics and publishes durable completion output.
- `src/jsonl.ts` and `src/durable-fs.ts` provide bounded framing and durable filesystem operations.

### Persistence and restoration

- `src/persistence.ts` owns lifecycle event encoding, ordered append, decoding and history folding.
- `src/restoration.ts` collects evidence, plans obligations and applies restoration actions.
- `src/schemas.ts` owns external structural schemas; `src/domain.ts` owns validated branded values and state literals.

### Launch and containment

- `src/containment.ts` defines containment ownership contracts.
- `src/cgroup-v2.ts` proves host capability and owns cgroup scopes.
- `src/watchdog-client.ts` controls the external watchdog and verifies receipts.
- `watchdog.mjs` creates and verifies the attempt scope before authorising launch.
- `launcher.mjs` is the sole process that spawns the Pi RPC child from an authorised launch specification.

## Spawn and relaunch

```text
spawn_agent or send_input
  → tools.ts
  → SubagentController
  → child/model/tool/depth selection
  → cgroup preflight and attempt preparation
  → pi-composition transfers containment ownership
  → pi-launcher builds the RPC specification
  → WatchdogClient → watchdog.mjs → launcher.mjs → Pi RPC
  → RpcRunClient resolves assignment identity
  → RunStarted is persisted
  → run settles and output is durably published
  → RunCompleted is persisted
  → await_agent delivers the completion
```

`send_input` reuses an owned stopped child session but creates a new attempt and `runId`. Depth-sensitive lifecycle tools are recalculated on relaunch rather than replayed blindly from persistence.

## Restoration

```text
full branch custom-entry history
  → persistence decode and fold
  → restoration evidence collection
  → restoration plan
  → containment, start or completion obligations
  → controller inventory and completion service
```

The complete branch history is authoritative, including entries outside compacted model context. Historical schema versions retain their original meaning.

## Observation path

```text
RPC events
  → RpcRunClient
  → observation adapters and store
  → bounded snapshot
  → widget and lifecycle-tool presentation
```

Observation is deliberately total and bounded: malformed or unsupported observation data may degrade presentation but must not break lifecycle operations.

## Dependency direction

Domain and boundary modules must not depend on controller, Pi host or presentation modules. Persistence and transport expose validated data to orchestration. Presentation consumes projections and cannot append lifecycle events or launch processes. Production Pi creation remains behind the watchdog/launcher boundary.

## Where to change behaviour

- Public tool shape or rendering: `src/tools.ts`, `src/tool-presentation.ts`.
- Admission, stop, shutdown or completion timing: `src/controller.ts`, `src/run-controller.ts`.
- Model/tool/depth selection: selection and delegation-policy modules.
- Event schema or restoration: persistence and restoration together, preserving historical decoding.
- RPC limits or event handling: wire/client plus context-safety tests.
- Child process ownership: containment, watchdog and launcher as one boundary.
- Widget behaviour: `src/agent-widget/` and observation projections, never controller authority.
