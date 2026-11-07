# Architecture

The root Bun CLI has two execution paths. The YAML parser validates step structure and checks references to earlier steps before the workflow engine runs. The engine resolves prompt variables, calls Copilot in prompt mode, checks the output, and records the result under `workflow-executions/`.

The Architect takes a user request and tool descriptions and returns a structured plan. The converter validates it against the available catalog. The Builder schedules the resulting steps and calls the executable registry with the current grants and approval state. Discovery records describe tools. An executable adapter must be registered separately.

| Directory | Responsibility |
|---|---|
| `src/agents/`, `src/services/`, `src/parsers/` | Planner, Builder, and conversion from YAML or a structured plan |
| `src/engine/`, `src/execution/`, `src/context/` | YAML execution, subprocesses, variable resolution, and run reports |
| `src/tools/`, `src/interactive/`, `src/safety/` | Registry, adapters, steering, output checks, and credential masking |
| `src/rag/` | Local embedding loader and PostgreSQL retrieval |
| `src/temporal/` | Optional client, workflow, worker, and activity boundaries |
| `arc/`, `arc-ui/` | Separate Node.js tool CLI and terminal UI demo |
| `tests/`, `scripts/`, `examples/` | Test fixtures, verifiers, and example configuration |

Temporal is a separate execution surface for prepared Builder workflows. The activity creates a per-run workspace and intersects requested permissions with worker grants. The local write journal uses a staged hard link and an operation ID scoped to the activity and step. Cancellation propagates through the activity and tool signal. Other external effects require their own reconciliation.

PostgreSQL scopes vector rows by corpus and embedding fingerprint before exact cosine ranking. Retrieved excerpts remain separate from the user request and are supplied to the Architect as reference data. Corpus labels support local retrieval scoping. This project has no authenticated multi-tenant data boundary.

See [runtime adapters](RUNTIME_ADAPTERS.md) and [local services](DEPLOYMENT.md).
