# Agent Design

> Status: proposed (planning). Last updated 2026-10-02.

## Principles

1. **Explicit graph, not a black-box loop.** Every step is a LangGraph node with typed state,
   so runs can be paused, resumed, replayed and inspected.
2. **Least privilege by default.** Reads use a read-only DB role. Writes need a different role
   *and* human approval.
3. **Budgets everywhere.** Step cap, token budget, statement timeout and row cap per run.
4. **Data is untrusted.** Text from tables, tool results and web pages is never treated as
   instructions (prompt-injection defence).
5. **Learn across sessions.** Successful queries, snippets and schema notes are saved and reused.

## Agent graph (LangGraph, Python)

```
START
  └─► route_intent ──► (chat | nl2sql | explain | optimise | change | analyse_python)
          │
          ▼
      retrieve_context      ranked tables + DDL, saved queries, relevant skills, KG facts
          │
          ▼
      plan / act  ◄──────────────┐   LLM with bound tools (MCP + internal)
          │                      │
          ▼                      │
      tool_router ───────────────┤   read tools run immediately
          │                      │
          ├─ write/DDL/terminal ─► validate ─► approval (interrupt) ─► execute ─┘
          │                       (pglast parse, EXPLAIN, row estimate)
          ▼
      summarise ─► persist (run trace, SQL, results, learnings) ─► END
```

- **Checkpointer:** `langgraph-checkpoint-postgres` in the app DB, so a run survives restarts
  and approvals can wait indefinitely.
- **Step cap:** default 15 tool calls per run; graceful stop with a resumable checkpoint
  (LangGraph v1.2 graceful shutdown).
- **Token budget:** history trimmed by tokens, oldest turns summarised into session memory.

## Schema context strategy (the big upgrade over Chat2DB) — implemented in `schema_index.py`

1. **Index once per connection, refresh on schema change.** Every table becomes a card: kind,
   comment, columns (type, nullability, default, comment), PK/FK/unique/check constraints, indexes,
   row estimate (`pg_class.reltuples`), and sample values for enum-like columns (native enums, or
   text columns named like `status`/`type`/`category`... with ≤ 8 distinct values in a 5000-row
   sample). Cards are stored in `agent2db.schema_index`. A fingerprint (md5 over every
   schema.table.column:type) is computed with one catalog query at the start of each request; a
   mismatch rebuilds the index.
2. **At question time:** BM25 over the card descriptions (identifier-aware tokeniser: `orderItems`
   → `order item`, plurals singularised), fused by reciprocal rank with cosine similarity over
   embeddings when an embedding model is configured (`real[]`, compared in Python — no pgvector
   needed); tables the user named are forced to the top; the top-k is expanded one hop along
   foreign keys; rendering stops at a character budget. Small databases (≤ k tables) are shown in
   full. Remaining tables are listed by name with row counts.
3. **Render as real DDL** plus keys and indexes (proven format from Chat2DB), with the sample
   values as comments.
4. **Fallback tools** `schema__search_tables` / `schema__describe_table` (served from the index,
   no catalog round-trip) and the MCP `list_objects` / `get_object_details` stay available.

## Query types (prompt modes as nodes)

| Mode | Executes? | Notes |
|---|---|---|
| chat | read tools only | general Q&A over data |
| nl2sql | optional read | returns SQL + explanation; run on request |
| explain | `EXPLAIN` only | plain-language plan explanation |
| optimise | `EXPLAIN`, hypopg | index suggestions via Postgres MCP Pro tools |
| change | write, with approval | DML/DDL; shows statement and affected-row estimate |
| analyse_python | sandbox | writes a snippet, runs it on exported query results |

Prompts live as versioned files in `services/agent/prompts/`, not inline strings.

## Write safety (three layers)

1. **Database role:** reads go through `agent2db_ro` (`default_transaction_read_only = on`,
   `statement_timeout`). Writes go through `agent2db_rw` only.
2. **Parser:** `pglast` classifies statements; multi-statement payloads and
   `COMMIT`/`ROLLBACK` inside user SQL are rejected.
3. **Human approval:** LangGraph `interrupt()` shows the exact statement, an `EXPLAIN`
   estimate of affected rows, and runs inside a transaction the user can see.

## Tools

- **MCP tools** (pluggable, see [mcp-integration.md](mcp-integration.md)): Postgres read,
  Postgres write, our own `agent2db-mcp`, plus any future servers.
- **Internal tools:** `save_snippet`, `run_snippet`, `search_snippets`, `remember_fact`,
  `load_skill`.
- **Terminal tool:** only inside the sandbox container, always behind approval.

## Python snippets and sandbox

- The agent writes a Python snippet; it is saved (name, description, code, inputs, tags,
  embedding) in the app DB so it can be found and reused later.
- Execution happens in a Docker container: no network, read-only root filesystem, CPU/memory/
  time limits, non-root user, a temp work dir. Query results are passed in as Parquet/CSV files;
  outputs (tables, charts, text) come back as files.
- The sandbox gets **no database credentials** by default. If a snippet needs live DB access,
  that is a separate approval and gets the read-only DSN only.

## Skills

Same format as Anthropic Agent Skills: a folder per skill with `SKILL.md` (YAML frontmatter
`name`, `description`, then instructions) and optional scripts/resources.

- Only names and descriptions are in the system prompt; the full skill is loaded on demand via
  `load_skill` (progressive disclosure keeps context small).
- Example skills: `postgres-index-tuning`, `safe-migration`, `data-quality-check`,
  `write-report`, `pandas-analysis`.

## Memory and knowledge graph

- **Session memory (implemented):** the full history lives in the LangGraph checkpoint; the prompt
  gets a size-trimmed view (`trim_history`): older tool results are shortened first, then whole
  old turns are dropped behind a one-line note. Summarisation of dropped turns is not done yet.
- **Long-term memory (implemented):** `agent2db.facts` ("`orders.status` 3 = refunded", with an
  optional subject table/column) and `agent2db.saved_queries`, both with full-text search. The
  agent reads and writes them through `memory__remember` / `memory__recall` /
  `memory__save_query` / `memory__search_saved_queries`; `retrieve_context` injects the matches
  for the current question into the prompt. The UI and external tools manage them via `/facts`
  and `/saved-queries`.
- **Knowledge graph (not yet):** facts carry a `subject` but there are no edges or graph queries.
  Plain tables are enough for now; Apache AGE remains optional later.

## Budgets and accounting (implemented)

- Step cap per request (`AGENT2DB_MAX_STEPS`): when reached, tools are removed and the model must answer.
- Tool output cap for the model (`AGENT2DB_MAX_TOOL_CHARS`); the UI gets the full result.
- History cap (`AGENT2DB_MAX_HISTORY_CHARS`); schema cap (`AGENT2DB_SCHEMA_MAX_TABLES/CHARS`).
- Tokens and cost per model call are captured from LiteLLM (`stream_options.include_usage`,
  `completion_cost`), accumulated per run, streamed as `usage` events and stored on the run.
- Model fallbacks (`AGENT2DB_FALLBACK_MODELS`) on rate limits, outages, auth errors and timeouts,
  but only before any text has been streamed for that turn.

## Model access (LiteLLM)

- LiteLLM **Python SDK in-process**, not the LiteLLM proxy server (the proxy's MCP endpoints had
  an RCE, CVE-2026-42271). One config maps logical names (`fast`, `smart`, `cheap`) to provider
  models with fallbacks.
- Pin LiteLLM ≥ 1.83.7 with hash-locked installs. Never install 1.82.7 or 1.82.8 (malicious
  PyPI releases, March 2026).
- Model-capability rules (e.g. GPT-5/o-series use `max_completion_tokens`, default temperature)
  live in one module with tests.

## Open Questions

1. Default model per mode, and monthly cost ceiling?
2. Is a Docker requirement acceptable for snippet execution on every user machine, or do we
   need a no-Docker fallback (e.g. a restricted subprocess, clearly labelled less safe)?
3. Should approved writes always run inside an explicit transaction the user commits manually?
