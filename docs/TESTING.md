# Testing

Run `npm run verify` for type checking, lint, the build, and the deterministic tests. To run the tests separately, use `npm test -- --timeout 15000`.

| Command | Requirements and coverage |
|---|---|
| `npm run db:verify` | Isolated PostgreSQL, vector persistence, rollback and query checks |
| `npm run rag:verify` | Isolated PostgreSQL, fixture-vector ingestion, retrieval, filtering and prompt assembly |
| `npm run embedding:verify` | Root build and isolated PostgreSQL, generated ONNX fixture and independent Node reopen |
| `npm run embedding:pretrained` | Same services plus a configured pretrained model, labelled semantic queries and persisted retrieval |
| `npm run temporal:verify` | Isolated Temporal server, real workers, cancellation, crashes and history replay |

Use [local service setup](DEPLOYMENT.md) for the integration prerequisites. Automated planner and YAML tests use controlled responses. The MCP test starts a real local stdio server. The bounded watchdog cases exercise child CPU use, memory growth, and cleanup. External Copilot or paid scraping verification is outside the default suite. Keep any local results under ignored `.audit/`.
