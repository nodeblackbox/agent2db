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
