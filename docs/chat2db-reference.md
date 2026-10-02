# Chat2DB Reference: How Its Agent Works

> Status: analysis of `../Chat2DB` (Community, commit dc2b80a3b) on 2026-10-02.
> Agent2DB is **not** a port. This file records what to keep and what to improve.
> Paths are relative to `Chat2DB/chat2db-community-server/`.

## Summary

There is no secret sauce. Chat2DB uses Spring AI's built-in tool loop with six database tools
and long hand-written system prompts. The parts worth copying are its schema output format and
its write guard; the parts worth beating are schema selection, memory, budgets and extensibility.

## 1. Chat request path

- `AiChatController` (`/api/v3/ai`) → `AiChatStreamAdapter.stream()` (web module, ~line 301).
- Builds a Spring AI `ChatClient` via `AiModelFactory`, persists the user message, loads
  history, builds a tool context and a system prompt, then streams.
- History: last 5 rounds (10 messages), no token counting, no summarisation.
- Streaming over SSE with event types `reasoning`, `tool_call`, `tool_result`, `answer`,
  `done`, `error`. `<think>` tags are split out of model text.

## 2. Agent loop

- `internalToolExecutionEnabled(true)` makes Spring AI's `DefaultToolCallingManager` run the
  model → tool → model cycle. No planner, no sub-agents, **no iteration cap** found.
- Tools (`AiToolAdapter`): `list_all_datasources`, `list_all_databases`, `list_all_schemas`,
  `list_all_tables`, `get_tables_schema`, `execute_sql`.

## 3. Schema retrieval (the "optimisation")

- Nothing is preloaded except dialect, database and schema names. The model discovers schema
  through tools.
- `list_all_tables`: up to 500 tables as `name [type] - comment`.
- `get_tables_schema`: up to 20 tables per call; returns real `CREATE TABLE` DDL (fallback:
  column list), then primary keys, indexes, foreign keys. Prompt says "prefer DDL".
- No embeddings, no ranking, no pruning. Large schemas depend on the model's guesswork.

**Keep:** DDL + keys + indexes per table — models read real DDL best.
**Beat:** rank tables before the model sees them (see [agent-design.md](agent-design.md)).

## 4. Query types

Prompt modes, all Java text blocks in `AiChatStreamAdapter`: NL→SQL ("SQL only, no
markdown"), DDL create/alter, explain, optimise, debug, dialect conversion. Most forbid
execution. A hard-coded content-policy block is appended to every prompt.

## 5. Write safety

- `execute_sql` parses with the dialect parser, falls back to keyword checks, and auto-runs
  only SELECT/SHOW/DESCRIBE. Anything else returns "manual confirmation required" with the SQL.
- Results capped at 50 rows, cells at 200 chars. Every AI query is logged as `AI_TOOL`.

**Keep:** parse-then-allow-list, result caps, audit log.
**Beat:** enforce with database roles too; parsing alone has been bypassed in other MCP servers.

## 6. MCP server

Off by default. Exposes the same six tools plus `text2sql` at `/mcp` (streamable HTTP). A
`mcpAuthToken` setting exists; where it is enforced was not verified.

## 7. Provider handling

Hand-rolled per provider and went stale: GPT-5/o-series models were sent `max_tokens` and a
custom temperature, which they reject (fixed locally on 2026-10-02). Gemini works only via
Vertex AI. Lesson: route all providers through one maintained abstraction (LiteLLM) and keep
model-capability rules in one place.

## What Agent2DB adds that Chat2DB lacks

Ranked schema retrieval, explicit graph with budgets, DB-role-enforced read/write split,
human approval via interrupts, saved snippets and queries, knowledge graph, skills, sandboxed
Python, pluggable MCP servers.
