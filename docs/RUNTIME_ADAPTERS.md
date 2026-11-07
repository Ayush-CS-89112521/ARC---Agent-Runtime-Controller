# Runtime adapters

The root workflow CLI (`bun src/cli.ts`) and the small Node tool CLI (`arc/`) have different entry points. Both expose the `arc` command. The workflow CLI now executes registered local/MCP adapters; discovery metadata alone cannot execute a tool.

## Setup and checks

Install root dependencies with `npm ci`, then run:

```powershell
npm run type-check
npm run lint
npm test
npm run build
```

The `arc/` and `arc-ui/` projects retain their own manifests. Run `npm ci` in those directories before their builds/demos. Tests use the pinned local Bun dependency; the MCP fixture uses Node. If installing with lifecycle scripts disabled, explicitly run `npm rebuild bun` to initialize its executable. Temporal SDKs compile with the project, but a worker requires a separately configured Temporal service.

## Explicit permissions

Copy `examples/arc-runtime.example.json` to the ignored `arc-runtime.local.json`. It starts with an empty grant list. For a read-only exercise, add `files.read` and create `notes.txt` with harmless content.

```powershell
$env:ARC_RUNTIME_CONFIG = (Resolve-Path './arc-runtime.local.json').Path
npm run dev -- "Read notes.txt" --plan
```

The command requires an authenticated Copilot CLI. Modifying tools require their grant and approval. `--auto-approve` explicitly approves the workflow, while `--no-steering` only disables interactive steering. Without a selected config, the runtime has no permissions.

Built-in adapters:

| Tool | Input | Permission | Approval |
|---|---|---|---|
| `local.read_file` | `{ "path": "notes.txt" }` | `files.read` | No |
| `local.write_file` | `{ "path": "notes.txt", "content": "hello" }` | `files.write` | Yes |

Paths resolve within the selected workspace. Reads check real paths; writes check the real parent and use exclusive creation, refusing existing files and final symlinks. Parent directories must already exist. This is a constrained adapter, not an operating-system security sandbox against a hostile local process racing filesystem changes.

## MCP servers

Only a trusted runtime config can select a server command. Model output cannot launch a process. Example config for an existing server:

```json
{
  "permissions": ["mcp:workspace:echo"],
  "mcpServers": [{
    "id": "workspace",
    "command": "node",
    "args": ["/absolute/path/to/your/server.mjs"],
    "allowedTools": ["echo"]
  }]
}
```

The server must already be installed. Discovery only registers explicitly allowed tools. Input/output JSON schemas are checked; MCP error results fail execution. Tool IDs become `workspace.echo`. Every MCP call requires approval and its individual permission. Connections close when CLI execution ends. Untrusted server stderr is drained without forwarding it to logs.

## Programmatic execution and steering

Legacy explicitly injected executable tools require a `tool:<id>` permission and step approval; metadata alone remains non-executable.

Use `ExecutableRegistry` plus `registerLocalTools` or `connectMcpServer`, then pass the registry to `BuilderAgent`. Supply `permissions`, `approved`, and an optional `signal`/`executionId` to `execute`. Permission grants are checked for each call. `getAuditTrail(executionId)` returns a separate snapshot; the last 100 completed runs are retained in memory.

`handleSteeringInput(stepId, action, executionId)` supports approve, modifying a future prompt, skip, and terminate. A running tool cannot be redirected by replacing its prompt; skip or terminate it first. Concurrent executions require an explicit execution ID for steering. There is no implemented pause/resume protocol or durable Builder checkpoint.

Cancellation forwards an AbortSignal to local IO and MCP requests, stops future scheduling, and discards cancelled results. Timeouts abort the run. Remote servers must cooperate with cancellation; cancelling a request cannot undo a completed remote side effect. Non-idempotent Temporal execution activities are not automatically retried.

## Output handling

Root and Node CLIs buffer complete output lines before masking them. This prevents credentials split between writes from escaping, and preserves UTF-8 decoding. Selected token formats, generic secret assignments and private-key blocks are masked; oversized incomplete lines fail closed. Partial lines are flushed at normal completion or explicit exit. Interactive confirmation emits a newline so its question is visible before waiting. Arbitrarily named or encoded secrets still require application-specific patterns.

## Verification boundaries

The automated suite starts a real local MCP fixture and executes real temporary file operations. It does not establish that arbitrary external MCP servers honor cancellation. Live Copilot requires authentication; PostgreSQL and Temporal runtime checks require isolated service configuration. These integrations are reported separately from compiler and deterministic test success.
