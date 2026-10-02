# Backend (Python)

> Status: proposed (planning). Last updated 2026-10-02.

## Stack

| Concern | Choice | Why |
|---|---|---|
| Runtime | Python 3.12 | broad library support |
| Packaging | `uv` with a lockfile (`uv.lock`, hashes) | fast installs; hash locking protects against tampered PyPI uploads |
| HTTP | FastAPI + Uvicorn, SSE via `sse-starlette` | typed, generates OpenAPI for TS type generation |
| Agent | LangGraph (≥ 1.2) | interrupts, checkpoints, graceful shutdown |
| Checkpoints | `langgraph-checkpoint-postgres` | runs survive restarts |
| MCP client | `langchain.mcp` (beta) or `langchain-mcp-adapters` | multi-transport, elicitation → interrupt |
| MCP server (ours) | FastMCP | same library LangChain's client now builds on |
| LLM access | LiteLLM Python SDK, pinned ≥ 1.83.7 | one API for OpenAI, Anthropic, Gemini, Groq, xAI |
| DB driver | `psycopg` 3 (async pool) | app DB and checkpointer |
| SQL parsing | `pglast` | Postgres's own parser |
| Migrations | Alembic | |
| Tests | pytest, pytest-asyncio | |

## Layout

```
services/agent/
  pyproject.toml  uv.lock
  src/agent2db/
    api/          FastAPI routes: /health /runs /runs/{id}/resume /connections /snippets
    graph/        LangGraph state, nodes, edges
    llm/          LiteLLM router config + model capability rules
    mcp/          MCP client, config loader, ${ENV} resolution, approval policy
    schema_index/ table indexing, embeddings, ranking
    sandbox/      snippet runner (Docker)
    skills/       skill loader
    store/        psycopg repositories
  prompts/        versioned prompt files
  tests/
```

## Process contract with Electron

- Electron main spawns the backend with environment variables (secrets included) and a random
  port and token: `AGENT2DB_PORT`, `AGENT2DB_TOKEN`.
- Backend binds `127.0.0.1` only and rejects requests without `Authorization: Bearer <token>`.
- Backend prints one JSON line `{"ready": true, "port": N}` to stdout when ready.
- Health: `GET /health`. Shutdown: Electron sends SIGTERM (Windows: terminates the process
  tree), backend checkpoints in-flight runs.

## Implemented (v0.2)

Code lives in `services/agent` (see its README for modules, env vars, CLIs and the full route table).
Verified live against the dev DB on 2026-10-02 with `anthropic/claude-sonnet-5-5`: read questions,
an UPDATE that paused for approval with a planner estimate, a backend kill and restart with the
approval still pending, resume, execution and verification; `agent2db-eval` 6/6.

- Checkpointer: `langgraph-checkpoint-postgres` in the app DB, driven from worker threads
  (`checkpointer.py`), so sessions and pending approvals survive restarts. Falls back to
  `InMemorySaver` if the app DB is unavailable.
- Persistence: sessions, runs, events, approvals, saved queries, facts, schema index (`store.py`,
  sync psycopg pool + `asyncio.to_thread`; async psycopg needs a selector loop, MCP stdio on Windows
  needs Proactor).
- Schema retrieval: `schema_index.py` (cards + fingerprint refresh + BM25/embeddings + FK expansion).
- MCP client: official MCP SDK 2.x, not LangChain (see mcp-integration.md). Internal tools
  (`schema__*`, `memory__*`) are merged with MCP tools in `tools.Toolbox`.
- SSE event types: `step`, `token`, `message`, `tool_call`, `tool_result`, `usage`
  (cumulative tokens/cost for the run), `approval_required` (with `estimate` and `tables`),
  `error`, `done{status, usage, steps}`. Every event has an increasing `id`. After a resume or
  reconnect, use `GET /runs/{id}/events?after=<last id>`.
- Run request: `{message, session_id?, model?}`. Resume: `{decision: approve|reject, feedback?}`.
- Migrations: SQL files in `services/agent/migrations/`, applied at startup (not Alembic).

## API sketch

| Method | Path | Purpose |
|---|---|---|
| POST | `/runs` | start a run; returns run id |
| GET | `/runs/{id}/events` | SSE stream of run events |
| POST | `/runs/{id}/resume` | answer an interrupt (approve/reject/edit) |
| POST | `/runs/{id}/cancel` | cancel |
| CRUD | `/connections`, `/snippets`, `/saved-queries`, `/skills` | management |
| POST | `/connections/{id}/index` | (re)build schema index |

## Supply-chain rules

- Install only from the lockfile (`uv sync --locked`). Review diffs to `uv.lock` in PRs.
- Never install LiteLLM 1.82.7 or 1.82.8. Don't run the LiteLLM proxy server.
- Third-party MCP servers run as separate processes with only the env vars they need.

## Open Questions

1. Packaging the backend for end users: PyInstaller binary vs bundled `uv` + venv.
2. Windows process-tree shutdown details for the sandbox containers.
