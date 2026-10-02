"""Drive the real LangGraph graph with a scripted model and a fake MCP hub (no network, no database)."""

import json

import pytest
from langgraph.types import Command

from agent2db import graph as graph_module
from agent2db.config import Settings
from agent2db.graph import build_graph, close_dangling_tool_calls
from agent2db.mcp_hub import ServerConfig, Tool, ToolResult


class FakeHub:
    def __init__(self):
        read = ServerConfig("postgres-read", "x", [], {})
        write = ServerConfig("postgres-write", "x", [], {}, requires_approval=True)
        self.tools = {
            t.qualified_name: t for t in (Tool(read, "execute_sql", "read", {}), Tool(write, "execute_sql", "write", {}))
        }
        self.calls = []

    def openai_tools(self):
        return [t.to_openai() for t in self.tools.values()]

    async def call(self, name, args):
        self.calls.append((name, args))
        return ToolResult(json.dumps([{"ok": 1}]), False)


def call(call_id, name, sql):
    return {"id": call_id, "type": "function", "function": {"name": name, "arguments": json.dumps({"sql": sql})}}


def tool_reply(*calls):
    return {"role": "assistant", "content": "", "tool_calls": list(calls)}


def text_reply(text):
    return {"role": "assistant", "content": text}


@pytest.fixture
def settings():
    return Settings(model="test/model", max_steps=3, max_tool_chars=1000, max_tokens=100, mcp_config=None, read_dsn=None)


@pytest.fixture
def scripted(monkeypatch):
    replies = []

    async def fake_stream(model, messages, tools, max_tokens, on_text):
        reply = replies.pop(0)
        if reply.get("content"):
            await on_text(reply["content"])
        return reply

    monkeypatch.setattr(graph_module, "stream_completion", fake_stream)
    return replies


async def run_graph(graph, graph_input, thread="t1"):
    events = []

    async def emit(kind, data):
        events.append((kind, data))

    graph_module.current_emit.set(emit)
    config = {"configurable": {"thread_id": thread}}
    async for _ in graph.astream(graph_input, config):
        pass
    return events, await graph.aget_state(config)


def user(text):
    return {"messages": [{"role": "user", "content": text}]}


async def test_read_tool_runs_without_approval(settings, scripted):
    hub = FakeHub()
    scripted += [tool_reply(call("c1", "postgres-read__execute_sql", "select 1")), text_reply("Done: 1")]
    events, state = await run_graph(build_graph(settings, hub), user("hi"))
    assert hub.calls == [("postgres-read__execute_sql", {"sql": "select 1"})]
    assert not state.interrupts
    assert [k for k, _ in events if k in ("tool_call", "tool_result")] == ["tool_call", "tool_result"]
    assert state.values["messages"][-1]["content"] == "Done: 1"


async def test_write_waits_for_approval_then_runs(settings, scripted):
    hub = FakeHub()
    sql = "create table users (id int)"
    scripted += [tool_reply(call("w1", "postgres-write__execute_sql", sql)), text_reply("Created.")]
    graph = build_graph(settings, hub)
    _, state = await run_graph(graph, user("make users"))
    assert hub.calls == []
    payload = state.interrupts[0].value
    assert payload["sql"] == sql and payload["statement_types"] == ["CREATE TABLE"]

    _, state = await run_graph(graph, Command(resume={"decision": "approve"}))
    assert hub.calls == [("postgres-write__execute_sql", {"sql": sql})]
    assert state.values["messages"][-1]["content"] == "Created."


async def test_two_writes_in_one_turn_each_need_approval(settings, scripted):
    hub = FakeHub()
    scripted += [
        tool_reply(
            call("w1", "postgres-write__execute_sql", "create table a (id int)"),
            call("w2", "postgres-write__execute_sql", "drop table b"),
        ),
        text_reply("Done."),
    ]
    graph = build_graph(settings, hub)
    _, state = await run_graph(graph, user("both"))
    assert state.interrupts[0].value["tool_call_id"] == "w1"
    _, state = await run_graph(graph, Command(resume={"decision": "approve"}))
    assert state.interrupts[0].value["tool_call_id"] == "w2"
    _, state = await run_graph(graph, Command(resume={"decision": "reject", "feedback": "keep b"}))
    assert hub.calls == [("postgres-write__execute_sql", {"sql": "create table a (id int)"})]
    assert not state.interrupts


async def test_rejected_write_is_not_run_and_feedback_reaches_model(settings, scripted):
    hub = FakeHub()
    scripted += [tool_reply(call("w1", "postgres-write__execute_sql", "drop table users")), text_reply("OK.")]
    graph = build_graph(settings, hub)
    await run_graph(graph, user("drop it"))
    _, state = await run_graph(graph, Command(resume={"decision": "reject", "feedback": "keep it"}))
    assert hub.calls == []
    tool_msg = [m for m in state.values["messages"] if m["role"] == "tool"][-1]
    assert "rejected" in tool_msg["content"] and "keep it" in tool_msg["content"]


async def test_select_through_write_server_skips_approval(settings, scripted):
    hub = FakeHub()
    scripted += [tool_reply(call("w1", "postgres-write__execute_sql", "select 1")), text_reply("1")]
    _, state = await run_graph(build_graph(settings, hub), user("q"))
    assert not state.interrupts and len(hub.calls) == 1


async def test_step_budget_removes_tools_and_forces_an_answer(settings, scripted):
    hub = FakeHub()
    scripted += [tool_reply(call(f"r{i}", "postgres-read__execute_sql", "select 1")) for i in range(3)]
    scripted.append(text_reply("Budget reached."))
    _, state = await run_graph(build_graph(settings, hub), user("loop"))
    assert len(hub.calls) == 3
    assert state.values["messages"][-1]["content"] == "Budget reached."


async def test_second_request_in_session_keeps_history_and_resets_budget(settings, scripted):
    hub = FakeHub()
    graph = build_graph(settings, hub)
    scripted += [tool_reply(call(f"r{i}", "postgres-read__execute_sql", "select 1")) for i in range(3)]
    scripted.append(text_reply("first"))
    await run_graph(graph, user("one"))
    scripted += [tool_reply(call("again", "postgres-read__execute_sql", "select 2")), text_reply("second")]
    _, state = await run_graph(graph, user("two"))
    assert len(hub.calls) == 4  # the budget was reset, so the 4th call was allowed
    assert [m["content"] for m in state.values["messages"] if m["role"] == "user"] == ["one", "two"]


def test_close_dangling_tool_calls_adds_missing_results():
    messages = [
        {"role": "user", "content": "x"},
        tool_reply(call("a", "t", "select 1"), call("b", "t", "select 2")),
        {"role": "tool", "tool_call_id": "a", "content": "ok"},
        {"role": "user", "content": "next"},
    ]
    fixed = close_dangling_tool_calls(messages)
    assert [m.get("tool_call_id") for m in fixed if m["role"] == "tool"] == ["a", "b"]
    assert fixed[-1] == {"role": "user", "content": "next"}
