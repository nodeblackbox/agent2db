# Agent2DB

A desktop database agent: connect PostgreSQL, ask questions in plain language, and let an agent
explore the schema, write and run SQL, and remember what it learns — with a human approving every
write. Conceptually in the same space as Chat2DB, but **not** a port of it; lessons from analysing
Chat2DB are recorded in [`docs/chat2db-reference.md`](docs/chat2db-reference.md).

## Status

Phase 2 (safe writes and memory) is implemented and verified live against the dev database:

- Read-only agent with a ranked schema index (BM25 + optional embeddings, FK expansion), not a
  500-table name dump.
- Writes pause for approval with the parsed statement type, warnings and a planner row estimate;
  they run through a separate write role.
- Sessions, runs, events, approvals, saved queries and facts are persisted in the app database.
  Pending approvals survive a backend restart (LangGraph Postgres checkpointer).
- Token and cost tracking per run, model fallbacks, history trimming.
- Least-privilege role setup, sample data seeding and a question benchmark as CLIs.
- Desktop UI: chat list, icon rail (Schema, Tools & MCP, Memory, Approvals, Settings), side
  drawer, highlighted SQL cards with result grids and inline approval bars
  (see [`docs/frontend-electron.md`](docs/frontend-electron.md)).

What is still open is in [`docs/roadmap.md`](docs/roadmap.md) (sandboxed Python snippets, skills,
knowledge graph, packaging).

## Stack

| Layer | Choice |
|---|---|
| Desktop app | Electron + React + TypeScript, pnpm, electron-vite |
| Agent backend | Python 3.12, FastAPI, LangGraph, uv |
| LLM access | LiteLLM Python SDK (in-process, no proxy) |
| Database | PostgreSQL 16 (app DB and target DB; no extensions required) |
| Integration | MCP: Postgres MCP Pro (read + write instances) |

## Quick start (development)

```bash
cp .env.example .env            # fill in DATABASE_URL and at least one provider key
cd services/agent && uv sync    # Python backend
cd ../.. && pnpm install        # desktop app

# one-off setup on the dev database
uv run --project services/agent agent2db-seed-sample                                   # sample schema sandbox_data
uv run --project services/agent agent2db-setup-roles --schema public --schema sandbox_data --ddl --write-env

# run
pnpm --filter @agent2db/desktop dev          # Electron app (spawns the backend itself)
uv run --project services/agent agent2db-backend   # or the backend alone (prints its port)

# verify
cd services/agent && uv run pytest -q         # unit + DB integration tests
uv run --project services/agent agent2db-eval # question benchmark against the live model
```

## Local dev database

A local PostgreSQL 16 instance runs in Docker for development (plain `docker run`, container
`agent2db-postgres`, see `.env`). The same database is both the **app DB** (schema `agent2db`)
and a **target DB** (`public` holds Stripe tables, `sandbox_data` holds the seeded sample).

| Setting  | Value               |
|----------|---------------------|
| Host     | localhost           |
| Port     | 5433                |
| Database | agent2db            |
| User     | agent2db            |
| Password | see `.env`          |

## Secrets

Never commit `.env` or real keys. Copy `.env.example` to `.env` and fill in values locally.
MCP config uses `${VAR}` placeholders only. See
[`docs/environment-and-secrets.md`](docs/environment-and-secrets.md).

## Docs

- [`docs/architecture.md`](docs/architecture.md) — components, process model, repo layout
- [`docs/agent-design.md`](docs/agent-design.md) — LangGraph agent, schema retrieval, write safety, memory
- [`docs/mcp-integration.md`](docs/mcp-integration.md) — Postgres MCP choice, read/write split, config format
- [`docs/database.md`](docs/database.md) — app schema, roles, migrations
- [`docs/backend-python.md`](docs/backend-python.md) — backend stack, API, Electron contract
- [`docs/frontend-electron.md`](docs/frontend-electron.md) — UI stack, security baseline, screens
- [`docs/environment-and-secrets.md`](docs/environment-and-secrets.md) — secret handling rules
- [`docs/graphql-api.md`](docs/graphql-api.md) — deferred; when to add it
- [`docs/roadmap.md`](docs/roadmap.md) — phases and done-criteria
- [`docs/chat2db-reference.md`](docs/chat2db-reference.md) — how Chat2DB's agent works
- [`services/agent/README.md`](services/agent/README.md) — backend modules, env vars, CLIs
- [`config/mcp.example.json`](config/mcp.example.json) — MCP server config template
