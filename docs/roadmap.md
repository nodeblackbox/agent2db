# Roadmap

> Status: proposed (planning). Last updated 2026-10-02. Phases are scoped by outcome, not dates.

## Phase 0 — Foundations

- [ ] Confirm open decisions (Python agent core, Docker for sandbox, UI kit).
- [ ] Initialise git; add `.gitignore` check, `gitleaks` pre-commit hook.
- [x] Monorepo skeleton: `pnpm-workspace.yaml`, `apps/desktop`, `services/agent` (uv).
- [ ] Record dev Postgres image/version; enable pgvector. (PostgreSQL 16.15; `vector` is available but not yet enabled)
- [ ] Rotate exposed keys; create Agent2DB-specific provider keys.

**Done when:** `pnpm dev` opens an Electron window that shows backend `/health` = ok.

## Phase 1 — Read-only agent (MVP)

- [ ] Connection management with keychain storage; role setup helper (`agent2db_ro`).
- [x] `postgres-read` MCP server (Postgres MCP Pro, restricted) wired via config.
- [x] LangGraph graph: retrieve (schema digest + tools) → agent → approval → tools, step cap, SSE events.
- [x] LiteLLM with OpenAI + Anthropic (others by key); capability rules with tests. (No fallback router yet.)
- [x] Pulled forward from Phase 2: `postgres-write` with approval interrupt, pglast classification.
- [x] Chat UI with tool-call trace, result grid and approval dialog (verified against the real backend).

**Done when:** asking "top 10 customers by revenue last month" on a sample DB returns correct
SQL, results and an explanation, with a visible trace.

## Phase 2 — Safe writes and memory

- [ ] `postgres-write` MCP server with `agent2db_rw`; approval interrupt + dialog.
- [ ] `pglast` validation and `EXPLAIN` row estimate before approval.
- [ ] Postgres checkpointer; resume after restart.
- [ ] Saved queries; schema index with pgvector ranking.

**Done when:** an UPDATE request pauses for approval, shows the statement and estimate, and only
runs after approval; the read role provably cannot write.

## Phase 3 — Snippets, skills, knowledge

- [ ] Docker sandbox and Python snippet runner; snippet library with search.
- [ ] Skills loader and first five skills.
- [ ] Knowledge graph facts linked to tables/columns; used in retrieval.
- [ ] `agent2db-mcp` server for external clients.

## Phase 4 — Polish and distribution

- [ ] Packaging (electron-builder + bundled backend), code signing, auto-update.
- [ ] Optional GraphQL layer; more MCP servers; more databases.

## Evaluation (all phases)

Keep a small benchmark of natural-language questions with expected SQL/results on a sample
database; run it on every agent change and track accuracy, steps and cost per question.
