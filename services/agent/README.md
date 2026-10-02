# Agent2DB agent backend

FastAPI + LangGraph + MCP + LiteLLM. Design: [`../../docs/agent-design.md`](../../docs/agent-design.md),
API contract: [`../../docs/backend-python.md`](../../docs/backend-python.md).

## Run

From the repo root (reads the repo-root `.env`; never put keys anywhere else):

```bash
uv run --project services/agent agent2db-backend
```

Without `AGENT2DB_TOKEN` it generates a token and prints it to stderr; the Electron app always
passes its own. `AGENT2DB_PORT` defaults to a free port; the chosen port is printed on stdout as
`{"ready": true, "port": N}`.

| Variable | Default | Purpose |
|---|---|---|
| `DATABASE_URL` / `AGENT2DB_APP_DSN` | — | app database (schema `agent2db`: sessions, runs, approvals, memory, schema index, checkpoints) |
| `AGENT2DB_RO_DSN` / `AGENT2DB_RW_DSN` | fall back to `DATABASE_URL` | DSNs for the read and write MCP servers; the write DSN also runs `EXPLAIN` for impact estimates |
| `AGENT2DB_MODEL` | first provider with a key: `anthropic/claude-sonnet-5-5`, `openai/gpt-5-mini`, ... | LiteLLM model id; a run can override it |
| `AGENT2DB_FALLBACK_MODELS` | — | comma-separated models tried when the primary fails (rate limit, outage, bad key) |
| `AGENT2DB_EMBEDDING_MODEL` | first provider with a key (`openai/text-embedding-3-small`, `gemini/gemini-embedding-001`), `off` to disable | hybrid schema ranking; BM25 always works without it |
| `AGENT2DB_MAX_STEPS` | 15 | tool rounds per request before the agent must answer |
| `AGENT2DB_MAX_TOOL_CHARS` | 12000 | tool output the model sees (UI gets the full result) |
| `AGENT2DB_MAX_HISTORY_CHARS` | 60000 | conversation history sent to the model; older tool results are shortened, then whole turns dropped |
| `AGENT2DB_SCHEMA_MAX_TABLES` / `AGENT2DB_SCHEMA_MAX_CHARS` | 12 / 14000 | tables shown in full per request (plus FK neighbours) and their size cap |
| `AGENT2DB_MCP_CONFIG` | `config/mcp.json`, else `config/mcp.example.json` | MCP servers |

## CLIs

```bash
uv run --project services/agent agent2db-setup-roles --schema public --schema sandbox_data --ddl --write-env
uv run --project services/agent agent2db-seed-sample          # sandbox_data: customers, products, orders, order_items
uv run --project services/agent agent2db-eval [-v] [--only id] # evals/questions.json against the live model
```

`agent2db-setup-roles` creates `agent2db_ro` (read-only transactions, 30s timeout) and `agent2db_rw`
(DML, plus DDL with `--ddl`) with generated passwords, grants them the listed schemas, revokes the
`agent2db` app schema from both, and with `--write-env` appends the DSNs to `.env`.

## Test

```bash
cd services/agent
uv run pytest -q
```

Graph tests drive the real LangGraph graph with a scripted model and a fake toolbox (no network or
database). `tests/test_store_integration.py` runs against `DATABASE_URL` when set (migrations, memory
search, schema index build, EXPLAIN estimates) and only touches rows it creates.

## Layout

| Module | Role |
|---|---|
| `server.py` | process entry: loopback socket, token, ready line |
| `api.py` | REST + SSE endpoints, bearer auth; wires store, checkpointer, MCP hub, schema index, toolbox |
| `runs.py` | run lifecycle, event log with replay (`?after=`), resume/cancel, persistence, restore after restart |
| `graph.py` | LangGraph: `retrieve_context -> agent -> approval -> tools -> agent`; history trimming; usage |
| `store.py` | app DB (sync psycopg pool in worker threads): sessions, runs, events, approvals, saved queries, facts, schema index |
| `checkpointer.py` | LangGraph `PostgresSaver` driven from threads (async psycopg clashes with MCP stdio on Windows) |
| `schema_index.py` | table cards from the catalog (DDL, keys, indexes, FKs, row estimates, enum-like samples), fingerprint-based refresh, ranking + FK expansion, prompt rendering |
| `ranking.py` | pure helpers: identifier tokenisation, BM25, cosine, reciprocal rank fusion, table mentions |
| `impact.py` | pre-approval estimates: `EXPLAIN` row counts for DML, table row counts for DROP/TRUNCATE |
| `tools.py` | internal tools (`schema__*`, `memory__*`) and the Toolbox that merges them with MCP tools |
| `mcp_hub.py` | `mcpServers` config, `${VAR:-fallback}` resolution, namespaced tools, approval policy |
| `sql_safety.py` | pglast statement classification, warnings and referenced tables |
| `llm.py` | LiteLLM streaming, usage/cost capture, fallbacks, per-model request rules (GPT-5/o-series) |
| `roles.py`, `seed.py`, `evaluate.py` | the CLIs above |
| `migrations/*.sql` | app schema, applied at startup (tracked in `agent2db.schema_migrations`) |
| `prompts/system.md` | system prompt (`{schema}`, `{memory}`, `{max_steps}` placeholders) |
| `evals/questions.json` | benchmark cases: question + `expected_sql` whose result must appear in the answer |

## HTTP API

All routes need `Authorization: Bearer <token>`.

| Method | Path | Purpose |
|---|---|---|
| GET | `/health` | status, model, MCP servers, tools, store/checkpointer state, schema index status |
| POST | `/runs` | `{message, session_id?, model?}` → `{run_id, session_id}` |
| GET | `/runs/{id}` | summary (status, usage, pending approval) |
| GET | `/runs/{id}/events?after=N` | SSE: `step`, `token`, `message`, `tool_call`, `tool_result`, `usage`, `approval_required`, `error`, `done{status, usage, steps}` |
| POST | `/runs/{id}/resume` | `{decision: approve\|reject, feedback?}` |
| POST | `/runs/{id}/cancel` | |
| GET/DELETE | `/sessions`, `/sessions/{id}`, `/sessions/{id}/events` | history for rebuilding a chat after restart |
| GET | `/approvals` | audit log of every write approval and its outcome |
| GET/POST/DELETE | `/saved-queries`, `/facts` | memory management (`?q=` searches) |
| GET/POST | `/schema`, `/schema/reindex`, `/schema/search?q=`, `/schema/tables/{name}` | schema index |
