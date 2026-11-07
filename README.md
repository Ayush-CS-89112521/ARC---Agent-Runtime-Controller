# Agent Runtime Controller (ARC)

Agent Runtime Controller (ARC) runs YAML workflows and gives developers a way to review agent plans before they touch a workspace. It handles validation, tool permissions, cancellation, and reporting.

The project is for developers who want to see what an agent can do before letting it change a workspace. You can run a YAML workflow, ask Copilot to prepare a plan for the Builder, or exercise the runtime with local fixtures. PostgreSQL and Temporal are optional and run separately from the basic CLI.

## How it works

```text
YAML file -> parser and validator -> workflow engine -> Copilot prompts -> run artifacts
Prompt    -> Architect planner   -> validated plan  -> Builder         -> execution report
                                                          |
                                              permissions and approval
                                                          |
                                             local tools or MCP adapters

Optional Temporal worker -> Builder execution, cancellation and local write recovery
Optional PostgreSQL      -> vector retrieval -> reference context for planning
```

The YAML runner treats Copilot replies as text or JSON and writes configured artifacts after its output safety checks. The Builder path invokes registered tools and checks grants and approval on each call. The default runtime grants no tool permissions. An operator can enable local file tools or explicitly allow tools from a trusted MCP stdio server.

The root CLI uses TypeScript and Bun. The separate `arc/` package is a small Node.js tool CLI, and `arc-ui/` is a standalone terminal UI demo. The optional worker uses the Temporal TypeScript SDK. RAG uses PostgreSQL, pgvector, and local CPU embeddings through Transformers.js and ONNX Runtime.

## Install and try it

Use Node.js 24 and npm. The root lockfile installs the Bun runtime used by the npm scripts. A global Bun install is optional. Windows x64 is the verified native runtime environment.

```sh
npm ci
npm run dev -- --help
npm run build
```

For a deterministic walk through planning, approval, file operations, and MCP, run the adapter test with the repository's Bun executable.

```sh
npm exec -- bun test tests/reliability/executable-adapters.test.ts
```

For a no-write preview in the standalone tool CLI, install its dependencies and run the dry-run command.

```sh
npm --prefix arc ci
npm --prefix arc run arc -- run port.free --port 3000 --dry-run
```

For the terminal demo, run `npm --prefix arc-ui ci` and then `npm --prefix arc-ui run demo:dry`.

## Run a workflow

The following commands use an authenticated GitHub Copilot CLI and can consume account usage. Check that `gh copilot -- --version` works before using them.

```sh
npm run dev -- assets/demos/demo-simple.yaml
```

For a planned workflow, put a harmless text file named `notes.txt` in the workspace. Copy [the runtime example](examples/arc-runtime.example.json) to `arc-runtime.local.json` and add `files.read` to its permission list. The example starts with no grants. In PowerShell:

```powershell
$env:ARC_RUNTIME_CONFIG = (Resolve-Path ./arc-runtime.local.json).Path
npm run dev -- "Read notes.txt" --plan
```

The runtime guide covers [local tool registration, approval, and MCP](docs/RUNTIME_ADAPTERS.md). The [workflow reference](docs/API.md) describes YAML step options.

## Optional services and configuration

| Setting | Use |
|---|---|
| `ARC_RUNTIME_CONFIG` | Path to an operator-owned adapter config. Treat MCP commands and arguments as executable configuration. |
| `DATABASE_URL` | PostgreSQL connection. The isolated setup generates credentials and writes this value to ignored `.env`. |
| `ARC_LOCAL_EMBEDDING_PATH` | Directory containing a trusted local BERT/WordPiece bundle with a 384-dimensional quantized ONNX export. |
| `TEMPORAL_ADDRESS`, `TEMPORAL_NAMESPACE`, `TEMPORAL_TASK_QUEUE` | Worker and client connection settings. The test setup creates an ignored `.env.temporal-test`. |
| `ARC_TEMPORAL_WORKSPACE_ROOT` | Directory for prepared Builder run workspaces and write journals. |
| `ENABLE_WEB_SCRAPING`, `ANTHROPIC_API_KEY` | Optional paid documentation extraction for the CLI. Both must be set to enable it. |

[Environment template](.env.example) · [PostgreSQL setup](docs/POSTGRES_TEST_SETUP.md) · [Temporal and model setup](docs/DEPLOYMENT.md)

## Verification

```sh
npm run type-check
npm run lint
npm run build
npm test -- --timeout 15000
```

The default tests use controlled planner responses and a local MCP process. For the isolated integration checks, start Docker and use the commands below.

```sh
npm run db:setup
npm run db:verify
npm run rag:verify
npm run embedding:verify
npm run temporal:start
npm run temporal:verify
```

`embedding:verify` uses a small synthetic ONNX graph and needs the build output and test database. `embedding:pretrained` uses an existing compatible local model and the same database. Neither verifier downloads model weights. See the [testing guide](docs/TESTING.md) for scope and prerequisites.

## Limits

The runtime is designed for trusted local workspaces and operator-selected tools. Grants and approvals limit what the registered adapters can do. They do not make arbitrary MCP servers or hostile filesystem processes safe.

Prepared Temporal writes can reconcile a published file after a worker restart when the journal and workspace remain on the same hard-link-capable filesystem. The production Builder activity uses one attempt. Other effects can require operator reconciliation after an ambiguous failure.

Pretrained cosine ranking performed well on a small local benchmark. The current Temporal retrieval cutoff of 0.7 retained only one of its 24 labelled answers, so ranking performance does not establish default retrieval coverage. Provider availability and model billing depend on the account and installed CLI.

## Contributing and license

Use the [contribution guide](CONTRIBUTING.md) for local checks and review expectations. The repository includes the [MIT license](LICENSE).
