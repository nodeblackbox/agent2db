import json

import pytest

from agent2db.mcp_hub import ServerConfig, Tool, load_config, normalize_result_text, resolve_vars


def test_resolve_vars_uses_value_then_fallback():
    env = {"A": "a-value", "DATABASE_URL": "postgresql://db"}
    assert resolve_vars("${A}", env) == "a-value"
    assert resolve_vars("${MISSING:-${DATABASE_URL}}", env) == "postgresql://db"
    assert resolve_vars("${EMPTY:-x}", {"EMPTY": ""}) == "x"


def test_resolve_vars_raises_for_missing_without_fallback():
    with pytest.raises(KeyError):
        resolve_vars("${NOPE}", {})


def test_load_config_reads_approval_and_allow_list(tmp_path):
    path = tmp_path / "mcp.json"
    path.write_text(json.dumps({"mcpServers": {
        "pg-write": {"command": "uvx", "args": ["x"], "tools": ["execute_sql"], "requiresApproval": True},
        "mine": {"command": "uv", "requiresApproval": ["delete_snippet"], "enabled": False},
    }}))
    write, mine = load_config(path)
    assert write.tools == ["execute_sql"] and write.needs_approval("execute_sql")
    assert not mine.enabled and mine.needs_approval("delete_snippet") and not mine.needs_approval("get_snippet")


def test_server_names_cannot_contain_separator(tmp_path):
    path = tmp_path / "mcp.json"
    path.write_text(json.dumps({"mcpServers": {"bad__name": {"command": "x"}}}))
    with pytest.raises(ValueError):
        load_config(path)


def test_example_config_is_valid():
    from agent2db.config import REPO_ROOT

    servers = {s.name: s for s in load_config(REPO_ROOT / "config" / "mcp.example.json")}
    assert not servers["postgres-read"].needs_approval("execute_sql")
    assert servers["postgres-write"].needs_approval("execute_sql")


def test_tool_is_namespaced_for_the_model():
    server = ServerConfig("postgres-write", "uvx", [], {}, requires_approval=True)
    spec = Tool(server, "execute_sql", "Execute SQL", {"type": "object"}).to_openai()
    assert spec["function"]["name"] == "postgres-write__execute_sql"
    assert "approves" in spec["function"]["description"]


def test_python_repr_results_become_json():
    assert json.loads(normalize_result_text("[{'x': 1, 'name': 'a'}]")) == [{"x": 1, "name": "a"}]
    not_a_literal = "[{'d': Decimal('1.5')}]"
    assert normalize_result_text(not_a_literal) == not_a_literal
    assert normalize_result_text("Error: boom") == "Error: boom"


async def test_tool_call_timeout_returns_error_instead_of_hanging():
    import asyncio

    from agent2db.mcp_hub import McpHub

    class StuckSession:
        async def call_tool(self, name, args, read_timeout_seconds=None):
            await asyncio.sleep(10)

    server = ServerConfig("pg", "x", [], {})
    hub = McpHub([server], tool_timeout=0.05)
    hub.tools["pg__execute_sql"] = Tool(server, "execute_sql", "d", {})
    hub._sessions["pg"] = StuckSession()
    hub.status["pg"] = "connected"
    result = await hub.call("pg__execute_sql", {"sql": "select pg_sleep(100)"})
    assert result.is_error and "did not answer" in result.content
    assert hub.status["pg"].startswith("error: last call timed out")


async def test_tool_call_exception_is_reported_not_raised():
    from agent2db.mcp_hub import McpHub

    class BrokenSession:
        async def call_tool(self, name, args, read_timeout_seconds=None):
            raise RuntimeError("pipe closed")

    server = ServerConfig("pg", "x", [], {})
    hub = McpHub([server])
    hub.tools["pg__execute_sql"] = Tool(server, "execute_sql", "d", {})
    hub._sessions["pg"] = BrokenSession()
    result = await hub.call("pg__execute_sql", {})
    assert result.is_error and "pipe closed" in result.content


def test_child_stderr_goes_to_a_log_file(tmp_path):
    from agent2db.mcp_hub import McpHub

    server = ServerConfig("pg", "x", [], {})
    hub = McpHub([server], log_dir=tmp_path / "logs")
    handle = hub._errlog(server)
    assert handle.name.endswith("mcp-pg.log") and (tmp_path / "logs" / "mcp-pg.log").exists()
    handle.close()
    assert McpHub([server], log_dir=None)._errlog(server) is __import__("sys").stderr
