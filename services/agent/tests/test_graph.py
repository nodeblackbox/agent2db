"""Drive the real LangGraph graph with a scripted model and a fake toolbox (no network, no database)."""

import json

import pytest
from langgraph.types import Command

from agent2db import graph as graph_module
from agent2db.config import Settings
from agent2db.graph import build_graph, close_dangling_tool_calls, trim_history
from agent2db.llm import Completion, Usage
from agent2db.mcp_hub import ServerConfig, Tool, ToolResult
from agent2db.tools import InternalTool, Toolbox


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

    async def fake_stream(model, messages, tools, max_tokens, on_text, fallbacks=None):
        reply = replies.pop(0)
        if reply.get("content"):
            await on_text(reply["content"])
        return Completion(reply, Usage(tokens_in=10, tokens_out=5, cost_usd=0.001, calls=1), model)

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


async def test_usage_accumulates_across_turns_and_is_emitted(settings, scripted):
    hub = FakeHub()
    scripted += [tool_reply(call("c1", "postgres-read__execute_sql", "select 1")), text_reply("Done")]
    events, state = await run_graph(build_graph(settings, hub), user("hi"))
    assert state.values["usage"] == {"tokens_in": 20, "tokens_out": 10, "cost_usd": 0.002, "calls": 2}
    usage_events = [d for k, d in events if k == "usage"]
    assert usage_events[-1]["tokens_in"] == 20 and usage_events[-1]["model"] == "test/model"


async def test_write_waits_for_approval_then_runs(settings, scripted):
    hub = FakeHub()
    sql = "create table users (id int)"
    scripted += [tool_reply(call("w1", "postgres-write__execute_sql", sql)), text_reply("Created.")]
    graph = build_graph(settings, hub)
    _, state = await run_graph(graph, user("make users"))
    assert hub.calls == []
    payload = state.interrupts[0].value
    assert payload["sql"] == sql and payload["statement_types"] == ["CREATE TABLE"]
    assert payload["tables"] == ["users"] and payload["estimate"] is None

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


async def test_internal_tools_run_through_the_toolbox(settings, scripted):
    seen = []

    async def handler(args):
        seen.append(args)
        return json.dumps({"remembered": True})

    tool = InternalTool("memory", "remember", "store", {"type": "object", "properties": {}}, handler)
    toolbox = Toolbox(FakeHub(), [tool])
    assert "memory__remember" in toolbox.tools and len(toolbox.openai_tools()) == 3
    scripted += [
        {"role": "assistant", "content": "", "tool_calls": [{"id": "m1", "type": "function", "function": {"name": "memory__remember", "arguments": json.dumps({"fact": "x"})}}]},
        text_reply("ok"),
    ]
    _, state = await run_graph(build_graph(settings, toolbox), user("remember x"))
    assert seen == [{"fact": "x"}] and not state.interrupts


async def test_memory_and_schema_index_feed_the_prompt(settings, scripted, monkeypatch):
    captured = {}

    async def fake_stream(model, messages, tools, max_tokens, on_text, fallbacks=None):
        captured["system"] = messages[0]["content"]
        return Completion(text_reply("hi"), Usage(), model)

    monkeypatch.setattr(graph_module, "stream_completion", fake_stream)

    class FakeIndex:
        cards = [{"table_name": "public.orders"}]

        async def ensure_fresh(self, force=False):
            return False

        async def context(self, question, history="", max_tables=12, max_chars=14000):
            return f"RANKED SCHEMA for {question!r}"

    class FakeStore:
        async def search_saved_queries(self, q, limit=3):
            return [{"name": "rev", "description": "revenue", "sql": "select 1"}]

        async def search_facts(self, q, limit=6):
            return [{"content": "status 3 = refunded", "subject": "orders.status"}]

    graph = build_graph(settings, FakeHub(), schema_index=FakeIndex(), store=FakeStore())
    await run_graph(graph, user("revenue?"))
    system = captured["system"]
    assert "RANKED SCHEMA for 'revenue?'" in system
    assert "status 3 = refunded" in system and "rev: revenue" in system


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


def test_trim_history_shortens_old_tool_results_first():
    big = "x" * 5000
    messages = [
        {"role": "user", "content": "one"},
        tool_reply(call("a", "t", "select 1")),
        {"role": "tool", "tool_call_id": "a", "content": big},
        {"role": "assistant", "content": "answer one"},
        {"role": "user", "content": "two"},
        tool_reply(call("b", "t", "select 2")),
        {"role": "tool", "tool_call_id": "b", "content": big},
    ]
    trimmed = trim_history(messages, 6000)
    assert len(trimmed) == len(messages)
    assert "shortened" in trimmed[2]["content"] and trimmed[6]["content"] == big  # current turn untouched


def test_trim_history_drops_whole_old_turns_when_still_too_long():
    messages = []
    for i in range(6):
        messages += [{"role": "user", "content": f"q{i} " + "y" * 900}, {"role": "assistant", "content": "a" * 900}]
    trimmed = trim_history(messages, 4000)
    assert trimmed[0]["content"].startswith("[Earlier conversation trimmed")
    assert trimmed[1]["role"] == "user" and trimmed[-1]["content"] == "a" * 900
    assert sum(len(m["content"]) for m in trimmed) <= 4100


def test_trim_history_keeps_short_history_untouched():
    messages = [{"role": "user", "content": "hi"}, {"role": "assistant", "content": "hello"}]
    assert trim_history(messages, 1000) is messages
