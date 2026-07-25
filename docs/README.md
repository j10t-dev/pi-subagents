# Contributor documentation

Use this page as a route map. Read only the document relevant to the change.

| Change concerns | Read |
|---|---|
| Module ownership, execution paths, RPC, containment or UI boundaries | [Architecture](architecture.md) |
| Agent state, persisted events, restoration, identity or completion delivery | [Lifecycle and persistence](lifecycle-and-persistence.md) |
| Tests, typechecking, host prerequisites or release evidence | [Verification](verification.md) |

The root [README](../README.md) owns installation, configuration, public tools and user-visible behaviour. These documents own contributor context and must not duplicate that reference.

## Ground rules

- Treat controller state and persisted lifecycle events as authoritative; observations and widgets are projections.
- Target the globally installed Pi runtime. Do not pin a Pi release in source, tests or documentation.
- Construct semantic identifiers through the branded types in `src/domain.ts`.
- Verify claims using the command appropriate to the affected boundary.
