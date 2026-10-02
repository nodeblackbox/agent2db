# Database

> Status: proposed (planning). Last updated 2026-10-02.

## Two kinds of database

1. **App database** `agent2db` (local dev container on `localhost:5433`, see README): Agent2DB's
   own state — sessions, runs, snippets, knowledge graph, LangGraph checkpoints.
2. **Target databases**: whatever the user connects to and asks questions about. During
   development the app DB doubles as a target, using a separate `sandbox_data` schema.

Never mix the two in one role: the agent's MCP roles must not be able to read Agent2DB's own
tables (they contain connection metadata).

## Extensions

| Extension | Needed for | In official `postgres` image? |
|---|---|---|
| `vector` (pgvector) | schema ranking, snippet/fact search | No — use `pgvector/pgvector:pg17` image |
| `pg_stat_statements` | Postgres MCP Pro `get_top_queries` | Yes (needs `shared_preload_libraries`) |
| `hypopg` | hypothetical index analysis | No — optional, install later |

The current dev container's image and version are not recorded yet; check with
`SELECT version();` and `\dx` before relying on any of these.

## Roles (least privilege)

Run once as a superuser on each target database. Passwords come from your secret store, not
from this file.

```sql
-- read-only role used by the postgres-read MCP server
CREATE ROLE agent2db_ro LOGIN PASSWORD :'ro_password';
ALTER ROLE agent2db_ro SET default_transaction_read_only = on;
ALTER ROLE agent2db_ro SET statement_timeout = '30s';
GRANT CONNECT ON DATABASE target_db TO agent2db_ro;
GRANT USAGE ON SCHEMA public TO agent2db_ro;
GRANT SELECT ON ALL TABLES IN SCHEMA public TO agent2db_ro;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT ON TABLES TO agent2db_ro;

-- write role used only by the postgres-write MCP server, behind human approval
CREATE ROLE agent2db_rw LOGIN PASSWORD :'rw_password';
ALTER ROLE agent2db_rw SET statement_timeout = '60s';
ALTER ROLE agent2db_rw SET lock_timeout = '5s';
GRANT CONNECT ON DATABASE target_db TO agent2db_rw;
GRANT USAGE ON SCHEMA public TO agent2db_rw;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO agent2db_rw;
-- DDL rights (CREATE on schema) only if schema changes are in scope for that database
```

## App schema (v1 sketch)

| Table | Purpose | Key columns |
|---|---|---|
| `connections` | target DB metadata (no passwords; those live in the OS keychain) | id, name, host, port, db, ro_secret_ref, rw_secret_ref |
| `sessions` | chat sessions | id, connection_id, title, created_at |
| `runs` | one agent run per user message | id, session_id, status, model, tokens_in/out, cost, started/ended |
| `run_events` | streamed trace | run_id, seq, type, payload jsonb |
| `approvals` | write approvals and their outcome | run_id, statement, estimate, decision, decided_at |
| `saved_queries` | reusable SQL | id, connection_id, name, sql, description, embedding vector |
| `snippets` | reusable Python | id, name, description, code, inputs jsonb, tags, embedding vector |
| `schema_index` | ranked schema retrieval | connection_id, table, ddl, description, row_estimate, embedding vector |
| `kg_nodes` / `kg_edges` | knowledge graph | node: id, kind, label, props jsonb, embedding; edge: src, dst, rel, props |
| LangGraph checkpoint tables | created by `langgraph-checkpoint-postgres` | managed by the library |

## Migrations

Proposed: Alembic in `services/agent` (Python owns the schema). Migrations live in
`db/migrations/` and run on backend start in dev, explicitly in releases.

## Open Questions

1. Record the dev container's image/version; switch to `pgvector/pgvector` if needed.
2. Embedding model and dimension (affects `vector(N)` columns).
