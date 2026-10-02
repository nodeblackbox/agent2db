# MCP Integration

> Status: proposed (planning). Research done 2026-10-02; re-check versions before building.

## Goals

- Read **and** write access to Postgres through MCP, with writes provably separated from reads.
- Pluggable: adding a new MCP server is a config change, not a code change.
- Our own MCP server exposes Agent2DB's snippets, saved queries and knowledge so other clients
  (Claude Code, IDEs) can use them too.

## Postgres MCP server choice

| Option | Read/write | Notes | Verdict |
|---|---|---|---|
| `@modelcontextprotocol/server-postgres` (reference) | read-only (claimed) | **Archived July 2025.** SQL injection lets `COMMIT; DROP ...` escape read-only mode | **Do not use** |
| **Postgres MCP Pro** (`crystaldba/postgres-mcp`, MIT, Python) | `--access-mode=restricted` or `unrestricted` | Tools: `list_schemas`, `list_objects`, `get_object_details`, `execute_sql`, `explain_query`, `get_top_queries`, `analyze_workload_indexes`, `analyze_query_indexes`, `analyze_db_health`. Restricted mode uses read-only transactions, `pglast` parsing, time limits. stdio or SSE. | **Recommended** |
| MCP Toolbox for Databases (`googleapis/mcp-toolbox`) | per tool, defined in `tools.yaml` | Parameterised SQL tools with `readOnlyHint`; good for fixed, curated actions | Optional later, for curated write actions |
| `@zeddotdev/postgres-context-server` | read-only | Patched fork of the reference server | Fallback only |

Caveats for Postgres MCP Pro:
- Restricted mode relies on parsing; its docs note unsafe stored-procedure languages could
  bypass it. That is why we **also** use a read-only database role.
- Index tools need the `pg_stat_statements` and `hypopg` extensions. `hypopg` is not in the
  official `postgres` Docker image; optimisation tools degrade without it.
- Last release seen: v0.3.0 (adds Windows support). It documents stdio and SSE, not
  streamable HTTP. We use stdio, so this is fine.

## Server set (v1)

| Name | Server | Mode | DB role | Approval |
|---|---|---|---|---|
| `postgres-read` | Postgres MCP Pro | `restricted` | `agent2db_ro` | none |
| `postgres-write` | Postgres MCP Pro | `unrestricted` | `agent2db_rw` | every call |
| `agent2db` | our own (FastMCP, Python) | n/a | app DB role | for deletes |

Running two instances of the same server with different roles gives a hard boundary: even if
the model or a prompt injection tricks the read server, the database refuses the write.

## Config format

Standard `mcpServers` JSON (same shape as Claude Desktop / Claude Code), so users can reuse
configs. Template: [`../config/mcp.example.json`](../config/mcp.example.json).

Rules:
- Secrets are **never** written in the config. Values like `${AGENT2DB_RO_DSN}` are resolved
  from the backend's environment at spawn time.
- Each server entry may set `"requiresApproval": true` (all tools) or a list of tool names.
- Each entry may set `"enabled": false`.
- The user config lives in the app data folder, not in the repo. Only the example is committed.

## Client side

- Backend uses LangChain's MCP client: `langchain.mcp` (ships in `langchain` ≥ 1.4, **beta** as
  of Sep 2026) or the older `langchain-mcp-adapters` until `langchain.mcp` leaves beta.
- MCP elicitation (a server asking a question mid-call) maps to a LangGraph interrupt, which the
  UI shows like an approval prompt.
- Servers run as stdio child processes of the backend, started on demand and stopped on idle.
- Tool names are namespaced `<server>.<tool>` so two Postgres servers never collide.

## Our MCP server: `agent2db-mcp`

Tools (proposed): `search_snippets`, `get_snippet`, `save_snippet`, `search_saved_queries`,
`save_query`, `kg_search`, `kg_add_fact`, `list_skills`, `get_skill`. Resources: skills as
`skill://<name>`. Built with FastMCP; stdio for the desktop app, optional streamable HTTP with a
token for external clients, bound to `127.0.0.1`.

## Relationship to Agent Runs

Every MCP tool call is a node event in the run trace (server, tool, arguments, duration,
result size). Write-capable calls pass through the approval node first. Results over the row cap
are truncated for the model and stored in full for the UI.

## Open Questions

1. Do we need write access to databases other than the dev DB in v1? If yes, per-connection
   role setup must be part of onboarding.
2. Expose `agent2db-mcp` to external clients in v1, or desktop-only first?

## Sources

- [crystaldba/postgres-mcp](https://github.com/crystaldba/postgres-mcp) and its releases page
- [Reference server SQL injection advisory](https://postgres-mcp.dev/security/)
- [server-postgres deprecated and archived](https://datamcp.app/blog/modelcontextprotocol-server-postgres-deprecated)
- [MCP Toolbox for Databases](https://github.com/googleapis/mcp-toolbox)
- [LangChain changelog (langchain.mcp, LangGraph 1.2)](https://docs.langchain.com/oss/python/releases/changelog)
- [LangGraph interrupts](https://docs.langchain.com/oss/python/langgraph/interrupts)
