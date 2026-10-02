# Roadmap

> Status: Phase 2 done (2026-10-02). Phases are scoped by outcome, not dates.

## Phase 0 — Foundations

- [ ] Confirm open decisions (Docker for sandbox, UI kit).
- [x] Python agent core (decided by building it; see backend-python.md).
- [x] Initialise git. [ ] Add a `gitleaks` pre-commit hook.
- [x] Monorepo skeleton: `pnpm-workspace.yaml`, `apps/desktop`, `services/agent` (uv).
- [x] Record dev Postgres image/version: PostgreSQL 16.15 (Debian). `vector` is **not** available in
      this image; `pg_trgm` and `pg_stat_statements` are. The schema index works without pgvector.
- [ ] Rotate exposed keys; create Agent2DB-specific provider keys.

**Done when:** `pnpm dev` opens an Electron window that shows backend `/health` = ok. (Met.)

## Phase 1 — Read-only agent (MVP)

- [ ] Connection management with keychain storage in the desktop app (backend still reads `.env`).
- [x] Role setup helper: `agent2db-setup-roles` creates `agent2db_ro` / `agent2db_rw`.
- [x] `postgres-read` MCP server (Postgres MCP Pro, restricted) wired via config.
- [x] LangGraph graph: retrieve → agent → approval → tools, step cap, SSE events.
- [x] LiteLLM with OpenAI + Anthropic (others by key); capability rules with tests; fallback models.
- [x] Chat UI with tool-call trace, result grid, approval dialog, token/cost display.

**Done when:** asking "top 10 customers by revenue last month" on a sample DB returns correct SQL,
results and an explanation, with a visible trace. (Met: `agent2db-eval` 6/6 on `sandbox_data`,
one tool call per question with `anthropic/claude-sonnet-5-5`.)

## Phase 2 — Safe writes and memory

- [x] `postgres-write` MCP server with `agent2db_rw`; approval interrupt + dialog.
- [x] `pglast` validation and `EXPLAIN` row estimate before approval (table row counts for DROP/TRUNCATE).
- [x] Postgres checkpointer; a pending approval survives a backend restart and can be resumed.
- [x] Sessions, runs, events and approvals persisted; history endpoints.
- [x] Saved queries and facts (long-term memory) with full-text search, exposed as agent tools and
      injected into the prompt when relevant.
- [x] Schema index: per-table cards, fingerprint-based refresh, BM25 + optional embeddings, FK
      expansion, explicit-mention boost, budgeted DDL rendering.
- [x] Token/cost accounting per run, history trimming by size.
- [x] Sample data seeding and a question benchmark (`agent2db-eval`).

**Done when:** an UPDATE request pauses for approval, shows the statement and estimate, and only
runs after approval; the read role provably cannot write. (Met: verified live on 2026-10-02.)

## Phase 3 — Snippets, skills, knowledge

- [ ] Docker sandbox and Python snippet runner; snippet library with search.
- [ ] Skills loader and first five skills.
- [ ] Knowledge graph: link facts to tables/columns (facts exist; linking and graph queries do not).
- [ ] `agent2db-mcp` server for external clients.
- [ ] Desktop: session list / reopen history (backend endpoints exist), saved-query and facts panels,
      schema browser backed by `/schema`.
- [ ] Background re-indexing for large schemas (today the first request after a schema change
      rebuilds the index inline).

## Phase 4 — Polish and distribution

- [ ] Packaging (electron-builder + bundled backend), code signing, auto-update.
- [ ] Optional GraphQL layer; more MCP servers; more databases.

## Evaluation (all phases)

`services/agent/evals/questions.json` holds natural-language questions with an `expected_sql` whose
result must appear in the answer. `agent2db-eval` reports pass/fail, tool calls, tokens and cost per
question and writes `evals/last_run.json`. Run it on every agent change.
