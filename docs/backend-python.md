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

## Implemented (v0.1)

Code lives in `services/agent` (see its README). It is verified live against the dev DB with
`anthropic/claude-sonnet-5-5` and `openai/gpt-5-mini`: create table, insert, count, a rejected
drop, an approved drop, and follow-up questions in the same session.

- Checkpointer is `InMemorySaver` for now (sessions are lost on restart; Postgres checkpointer is Phase 2).
- MCP client: official MCP SDK 2.x, not LangChain (see mcp-integration.md).
- SSE event types: `step`, `token`, `message`, `tool_call`, `tool_result`, `approval_required`,
  `error`, `done{status: completed|awaiting_approval|failed|cancelled}`. Every event has an
  increasing `id`. After a resume, reconnect with `GET /runs/{id}/events?after=<last id>`.
- Run request: `{message, session_id?, model?}`. Resume: `{decision: approve|reject, feedback?}`.

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
