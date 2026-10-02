# Agent2DB agent backend

FastAPI + LangGraph + MCP + LiteLLM. Design: [`../../docs/agent-design.md`](../../docs/agent-design.md),
API contract: [`../../docs/backend-python.md`](../../docs/backend-python.md).

## Run

From the repo root (reads the repo-root `.env`; never put keys anywhere else):

```bash
uv run --project services/agent agent2db-backend
```

Without `AGENT2DB_TOKEN` it generates a token and prints it to stderr; the Electron app always
passes its own. `AGENT2DB_PORT` defaults to a free port; the chosen port is printed on stdout as
`{"ready": true, "port": N}`.

| Variable | Default | Purpose |
|---|---|---|
| `AGENT2DB_MODEL` | first provider with a key: `anthropic/claude-sonnet-5-5`, `openai/gpt-5-mini`, ... | LiteLLM model id; a run can override it |
| `AGENT2DB_MAX_STEPS` | 15 | tool rounds per request before the agent must answer |
| `AGENT2DB_MAX_TOOL_CHARS` | 12000 | tool output the model sees (UI gets the full result) |
| `AGENT2DB_MCP_CONFIG` | `config/mcp.json`, else `config/mcp.example.json` | MCP servers |
| `AGENT2DB_RO_DSN` / `AGENT2DB_RW_DSN` | fall back to `DATABASE_URL` | DSNs for the read and write MCP servers |

## Test

```bash
cd services/agent
uv run pytest -q
```

The graph tests drive the real LangGraph graph with a scripted model and a fake MCP hub, so
they need no network or database.

## Layout

| Module | Role |
|---|---|
| `server.py` | process entry: loopback socket, token, ready line |
| `api.py` | REST + SSE endpoints, bearer auth |
| `runs.py` | run lifecycle, event log with replay (`?after=`), resume/cancel |
| `graph.py` | LangGraph: `retrieve_context -> agent -> approval -> tools -> agent` |
| `mcp_hub.py` | `mcpServers` config, `${VAR:-fallback}` resolution, namespaced tools, approval policy |
| `sql_safety.py` | pglast statement classification and warnings shown in approvals |
| `schema_context.py` | live schema digest put in the system prompt |
| `llm.py` | LiteLLM streaming + per-model request rules (GPT-5/o-series) |
| `prompts/system.md` | system prompt |
