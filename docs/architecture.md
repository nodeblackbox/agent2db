# Architecture

> Status: proposed (planning). Last updated 2026-10-02.
> Decisions marked **Decided** are agreed; **Proposed** items need sign-off; see Open Questions.

## Goals

Agent2DB is a desktop database agent. A user connects one or more PostgreSQL databases, asks
questions or requests changes in natural language, and an agent explores the schema, writes and
runs SQL, writes and runs Python snippets, and remembers what it learned — with a human approving
anything that writes.

What it must do better than the Chat2DB reference (see [chat2db-reference.md](chat2db-reference.md)):

| Area | Chat2DB today | Agent2DB target |
|---|---|---|
| Agent loop | One opaque Spring AI tool loop, no step cap | Explicit LangGraph state machine with step/token budgets |
| Schema context | Model lists up to 500 tables and guesses | Ranked schema retrieval (embeddings + FK graph) |
| Write safety | SQL keyword/parser allow-list | Separate DB roles **and** parser **and** human approval |
| Memory | None across sessions | Saved snippets, saved queries, knowledge graph |
| Tools | 6 hard-wired tools | MCP servers (pluggable) + skills |
| Code execution | None | Sandboxed Python snippets |

## Components

```
┌──────────────────────────── Electron app (TypeScript, pnpm) ────────────────────────────┐
│ Renderer (React, sandboxed)  ⇄  preload (typed contextBridge)  ⇄  main process          │
│   chat, schema browser,                                         - spawns/stops backend │
│   approval dialogs, snippets                                    - holds OS keychain     │
└────────────────────────────────────────────┬────────────────────────────────────────────┘
                                             │ HTTP + SSE on 127.0.0.1:<random port>
                                             │ bearer token generated per launch
┌────────────────────────────────────────────▼────────────────────────────────────────────┐
│ Agent backend (Python 3.12, FastAPI, uv)                                                │
│   LangGraph agent graph ── checkpointer (Postgres) ── LiteLLM SDK (in-process)          │
│   MCP client (langchain.mcp) ──► MCP servers (stdio child processes)                    │
│   Skills loader      Snippet runner ──► sandbox (Docker, no network)                    │
└───────┬───────────────────────────────┬──────────────────────────────┬─────────────────┘
        │                               │                              │
        ▼                               ▼                              ▼
  App DB "agent2db"            postgres-read MCP              postgres-write MCP
  (sessions, runs, snippets,   role: agent2db_ro              role: agent2db_rw
   knowledge graph, pgvector)  access-mode=restricted         access-mode=unrestricted
                                        └──────── target database(s) ─────┘
```

- **Decided:** Electron + TypeScript frontend, PostgreSQL, MCP, pnpm for JS packages.
- **Proposed:** Python owns the agent core. Reason: LangGraph, LiteLLM, the official MCP Python SDK
  and the mature Postgres MCP servers are Python-first, and the agent must run Python snippets
  anyway. TypeScript owns everything the user sees. See Open Questions if you want an all-TS core.
- **Proposed:** Renderer ↔ backend uses REST for commands and SSE for streamed agent events.
  GraphQL is deferred (see [graphql-api.md](graphql-api.md)).

## Data flow: one agent run

1. Renderer sends `POST /runs {session_id, message, connection_id}` via the preload bridge.
2. Backend starts (or resumes) a LangGraph thread keyed by `session_id`.
3. Graph nodes stream events over SSE: `step`, `tool_call`, `tool_result`, `token`,
   `approval_required`, `error`, `done` (same idea as Chat2DB's trace events).
4. Any write SQL, DDL, terminal command or network-using snippet raises a LangGraph `interrupt`.
   The UI shows the exact statement and estimated impact; the user approves or rejects with
   `POST /runs/{id}/resume`.
5. Results, the generated SQL and the run trace are persisted in the app DB.

The full graph is in [agent-design.md](agent-design.md).

## Process model and trust boundaries

| Process | Trust | Holds secrets? |
|---|---|---|
| Renderer | Untrusted (shows LLM output and DB data) | Never |
| Electron main | Trusted | Reads OS keychain, passes secrets to backend env at spawn |
| Agent backend | Trusted | Provider keys and DB DSNs in memory only |
| MCP servers | Semi-trusted third-party code | Only the DSN for their own role |
| Snippet sandbox | Untrusted (LLM-written code) | Nothing by default |

Everything binds to `127.0.0.1`. Nothing listens on `0.0.0.0`.

## Repository layout (proposed)

```
Agent2DB/
  apps/desktop/            Electron + React + TS (electron-vite)
  packages/shared-types/   TS types generated from the backend OpenAPI schema
  services/agent/          Python: FastAPI + LangGraph + MCP client (uv project)
  services/agent2db-mcp/   Python: our own MCP server (snippets, knowledge, saved queries)
  skills/                  Agent skills (SKILL.md folders)
  sandbox/                 Dockerfile for the Python snippet sandbox
  db/migrations/           App DB migrations
  config/mcp.example.json  MCP server config template (no secrets)
  docs/
  pnpm-workspace.yaml  package.json  .env.example
```

## Open Questions

1. Confirm Python agent core vs all-TypeScript (LangGraph.js + Vercel AI SDK, no LiteLLM).
2. Single-user desktop only, or will the backend ever be shared/remote? (Affects auth design.)
3. Which databases besides Postgres, if any, in v1?
