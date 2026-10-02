# Agent2DB

A desktop database agent: connect PostgreSQL, ask questions in plain language, and let an agent
explore the schema, write and run SQL and Python, and remember what it learns — with a human
approving every write. Conceptually in the same space as Chat2DB, but **not** a port of it;
lessons from analysing Chat2DB are recorded in [`docs/chat2db-reference.md`](docs/chat2db-reference.md).

## Status

Planning stage. No application code yet. Decisions marked *Proposed* in the docs still need
sign-off.

## Planned stack

| Layer | Choice | Status |
|---|---|---|
| Desktop app | Electron + React + TypeScript, pnpm, electron-vite | Decided (pnpm, Electron, TS) |
| Agent backend | Python 3.12, FastAPI, LangGraph, uv | Proposed |
| LLM access | LiteLLM Python SDK (≥ 1.83.7, in-process, no proxy) | Proposed |
| Database | PostgreSQL + pgvector | Decided (Postgres) |
| Integration | MCP: Postgres MCP Pro (read + write instances) and our own `agent2db-mcp` | Proposed |
| Code execution | Docker sandbox for Python snippets | Proposed |
| GraphQL | Deferred | — |

## Local dev database

A local PostgreSQL instance is already running in Docker for development (see `.env` for
connection details). This is a plain `docker run` container, not managed by a compose file in
this repo — a proper Docker setup (e.g. `docker-compose.yml`) is intentionally deferred until
the project is further along.

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
- [`docs/agent-design.md`](docs/agent-design.md) — LangGraph agent, schema retrieval, write safety, sandbox, skills, memory
- [`docs/mcp-integration.md`](docs/mcp-integration.md) — Postgres MCP choice, read/write split, config format
- [`docs/database.md`](docs/database.md) — app schema, extensions, least-privilege roles
- [`docs/backend-python.md`](docs/backend-python.md) — backend stack, API, Electron contract
- [`docs/frontend-electron.md`](docs/frontend-electron.md) — UI stack, security baseline, screens
- [`docs/environment-and-secrets.md`](docs/environment-and-secrets.md) — secret handling rules
- [`docs/graphql-api.md`](docs/graphql-api.md) — deferred; when to add it
- [`docs/roadmap.md`](docs/roadmap.md) — phases and done-criteria
- [`docs/chat2db-reference.md`](docs/chat2db-reference.md) — how Chat2DB's agent works
- [`config/mcp.example.json`](config/mcp.example.json) — MCP server config template
