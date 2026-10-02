# Database

> Status: implemented (v0.2). Last updated 2026-10-02.

## Two kinds of database

1. **App database** (`DATABASE_URL`, or `AGENT2DB_APP_DSN` to split it out): Agent2DB's own state in
   schema `agent2db` — sessions, runs, events, approvals, saved queries, facts, schema index, and the
   LangGraph checkpoint tables.
2. **Target databases**: whatever the user connects to and asks questions about. During development
   the app DB doubles as a target: `public` (Stripe tables) and `sandbox_data` (seeded sample).

The two never share a role: `agent2db_ro` / `agent2db_rw` have **no** privileges on schema `agent2db`,
and the schema index skips that schema, so the agent cannot see its own session data.

## Extensions

| Extension | Needed for | Dev container (PostgreSQL 16.15) |
|---|---|---|
| none required | — | — |
| `pg_trgm` | optional fuzzy matching later | available, installed |
| `pg_stat_statements` | Postgres MCP Pro `get_top_queries` | available, needs `shared_preload_libraries` (not set) |
| `vector` (pgvector) | not used | **not available** in this image |
| `hypopg` | hypothetical index analysis | not available |

Embeddings for schema ranking are stored as `real[]` and compared in Python; full-text search uses
built-in `tsvector`. Nothing here needs a non-default image.

## Roles (least privilege)

Create them with the helper (needs a DSN that can create roles; the dev `agent2db` user is a superuser):

```bash
uv run --project services/agent agent2db-setup-roles --schema public --schema sandbox_data --ddl --write-env
```

| Role | Settings | Grants |
|---|---|---|
| `agent2db_ro` | `default_transaction_read_only = on`, `statement_timeout = 30s` | CONNECT; USAGE + SELECT on the listed schemas (and future tables via default privileges) |
| `agent2db_rw` | `statement_timeout = 60s`, `lock_timeout = 5s` | CONNECT; SELECT/INSERT/UPDATE/DELETE + sequences on the listed schemas; CREATE with `--ddl` |

Both get `REVOKE ALL ON SCHEMA agent2db`. Passwords are generated and written to `.env` only
(`--write-env`); re-running rotates them.

Verified on the dev DB: the read role gets `cannot execute INSERT in a read-only transaction` and
`permission denied for schema agent2db`; the write role can create and drop tables in `sandbox_data`
but not read `agent2db.sessions`.

## App schema (`services/agent/migrations/0001_init.sql`)

| Table | Purpose | Notes |
|---|---|---|
| `schema_migrations` | applied migration versions | files named `NNNN_*.sql`, applied at backend start |
| `sessions` | chat sessions | id, title (first message), model, timestamps |
| `runs` | one agent run per user message | status, message, answer, tokens_in/out, cost_usd, steps, error, backend_id (owner), timestamps |
| `backends` | live backend processes | id, hostname, pid, version, heartbeat_at; recovery adopts runs whose owner is stale (60s) |
| `settings` | key/value app settings | `rag_enabled` |
| `documents` | uploaded files for RAG | name, kind, size, sha256 (dedupe), status (pending/processing/ready/failed), chunk_count, pages, embedding_model |
| `chunks` | document chunks | document_id, idx, heading, page, content, embedding real[] (NULL when Qdrant holds the vector), generated `search` tsvector |
| `run_events` | streamed trace, replayable | (run_id, seq) → type, payload jsonb |
| `approvals` | every write approval request and its outcome | sql, statement_types, warnings, estimate jsonb, decision, feedback |
| `saved_queries` | reusable SQL | name (unique), description, sql, tables[], tags[], use_count, generated `search` tsvector |
| `facts` | long-term memory | content, subject (table/column), tags[], source (agent/user), generated `search` tsvector |
| `schema_index` | one card per target table | kind, comment, description, ddl, columns jsonb, foreign_keys jsonb, row_estimate, embedding real[] |
| `schema_index_meta` | index freshness | fingerprint (md5 of all columns/types), table_count, embedding_model, indexed_at |
| `checkpoints`, `checkpoint_blobs`, `checkpoint_writes`, `checkpoint_migrations` | LangGraph state per session thread | created by `langgraph-checkpoint-postgres`; connections use `search_path=agent2db` |

`agent2db.join_words(text[])` is an IMMUTABLE wrapper over `array_to_string` so array columns can
feed the generated tsvector columns.

## Migrations

Plain SQL files in `services/agent/migrations/`, applied in a transaction each by `AppStore` at
startup. Alembic was not needed for this size; revisit if the schema grows.

## Open Questions

1. Should the app DB default to a separate database (not just a separate schema) in production?
2. Embedding dimension is whatever the configured model returns (1536 for `text-embedding-3-small`);
   changing the model requires a reindex (`POST /schema/reindex`).
