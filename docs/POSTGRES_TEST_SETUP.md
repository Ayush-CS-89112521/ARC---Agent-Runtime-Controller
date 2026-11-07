# Local PostgreSQL / pgvector test setup

Start Docker before running the isolated setup.

| Item | Value |
|---|---|
| PostgreSQL | 17.11 |
| pgvector | 0.8.7 |
| Image | `pgvector/pgvector:0.8.7-pg17-trixie` |
| Host / port | `127.0.0.1:15432` |
| Database | `arc_test` |
| Application role | `arc_app`, non-superuser |
| Compose project | `arc-test` |
| Persistent volume | `arc-test_postgres-test-data` |

This Compose project uses a dedicated test volume and a loopback port.

## Credentials and application connection

`DATABASE_URL` is saved in the project's **git-ignored `.env`**. Bun loads that file automatically when run from the project folder. The Docker administrator and app credentials are generated randomly and retained in **git-ignored `.env.postgres-test`**. Do not publish either file or paste their contents into chat.

The setup creates the pgvector extension using the dedicated container administrator. Application queries use the separate `arc_app` login. The database listens only on the host loopback address.

Node programs that do not automatically load dotenv files can load the project environment with `node --env-file=.env <script>`. A separately opened PowerShell session does not automatically inherit values from `.env`; the repository's Bun commands do.

## Commands from the project folder

```powershell
# Initialize the test database and application role
npm run db:setup

# Start a previously initialized database
npm run db:start

# Verify actual PostgreSQL and vector operations
npm run db:verify

# Stop the database, keeping its saved data
npm run db:stop

```

The compose file is `compose.postgres-test.yaml`. Setup refuses to overwrite an unrelated existing `DATABASE_URL`. The compose volume keeps data across container stop/start. Do not remove the volume unless you intentionally want to reset this test database.

## Verification

`npm run db:verify` checks schema initialization, persistence, rollback, concurrent clients, vector dimensions, and similarity ordering. `npm run rag:verify` exercises the repository KnowledgeBase against the same database. See [Testing](TESTING.md) for the embedding verifiers.
