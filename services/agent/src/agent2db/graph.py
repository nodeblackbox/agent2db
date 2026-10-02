"""The agent as an explicit LangGraph state machine.

START -> retrieve_context -> agent -> (no tool calls) -> END
                               ^   +-> approval (interrupt for write tools) -> tools --+
                               +-------------------------------------------------------+
"""

from __future__ import annotations

import json
import operator
from collections.abc import Awaitable, Callable
from contextvars import ContextVar
from typing import Annotated, Any, TypedDict

from langgraph.checkpoint.memory import InMemorySaver
from langgraph.graph import END, START, StateGraph
from langgraph.types import interrupt

from agent2db.config import PROMPTS_DIR, Settings
from agent2db.llm import stream_completion
from agent2db.mcp_hub import McpHub
from agent2db.schema_context import safe_schema_digest
from agent2db.sql_safety import analyze_sql

Emit = Callable[[str, dict[str, Any]], Awaitable[None]]


async def _no_emit(_type: str, _data: dict[str, Any]) -> None:
    return None


# Set by the run manager for the duration of a run; LangGraph copies the context into node tasks.
current_emit: ContextVar[Emit] = ContextVar("current_emit", default=_no_emit)
current_model: ContextVar[str | None] = ContextVar("current_model", default=None)


class AgentState(TypedDict, total=False):
    messages: Annotated[list[dict[str, Any]], operator.add]
    steps: int
    schema: str
    decisions: dict[str, dict[str, Any]]


def tool_calls_of(message: dict[str, Any] | None) -> list[dict[str, Any]]:
    return list((message or {}).get("tool_calls") or [])


def parse_args(call: dict[str, Any]) -> tuple[dict[str, Any] | None, str | None]:
    raw = call["function"].get("arguments") or "{}"
    try:
        args = json.loads(raw)
    except json.JSONDecodeError as exc:
        return None, f"Arguments were not valid JSON: {exc}"
    if not isinstance(args, dict):
        return None, "Arguments must be a JSON object."
    return args, None


def close_dangling_tool_calls(messages: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """Every assistant tool call needs a tool result before the next turn (cancelled runs leave gaps)."""
    out: list[dict[str, Any]] = []
    pending: list[str] = []

    def flush() -> None:
        for call_id in pending:
            out.append({"role": "tool", "tool_call_id": call_id, "content": "Not executed: the run was interrupted."})
        pending.clear()

    for message in messages:
        if message.get("role") == "tool":
            if message.get("tool_call_id") in pending:
                pending.remove(message["tool_call_id"])
                out.append(message)
            continue  # drop orphan tool results
        flush()
        out.append(message)
        pending.extend(call["id"] for call in tool_calls_of(message))
    flush()
    return out


def approval_payload(call: dict[str, Any], args: dict[str, Any]) -> dict[str, Any]:
    sql = args.get("sql") if isinstance(args.get("sql"), str) else None
    analysis = analyze_sql(sql) if sql else None
    return {
        "tool_call_id": call["id"],
        "name": call["function"]["name"],
        "args": args,
        "sql": sql,
        "statement_types": analysis.statement_types if analysis else [],
        "warnings": analysis.warnings if analysis else [],
    }


def build_graph(settings: Settings, hub: McpHub, checkpointer: Any | None = None):
    system_template = (PROMPTS_DIR / "system.md").read_text(encoding="utf-8")

    async def retrieve_context(state: AgentState) -> dict[str, Any]:
        await current_emit.get()("step", {"node": "retrieve_context"})
        return {"schema": await safe_schema_digest(settings.read_dsn), "steps": 0, "decisions": {}}

    async def agent(state: AgentState) -> dict[str, Any]:
        emit = current_emit.get()
        await emit("step", {"node": "agent"})
        steps = state.get("steps", 0)
        system = system_template.replace("{schema}", state.get("schema", "")).replace(
            "{max_steps}", str(settings.max_steps)
        )
        messages = [{"role": "system", "content": system}, *close_dangling_tool_calls(state.get("messages", []))]
        tools = hub.openai_tools()
        if steps >= settings.max_steps:
            tools = []
            messages.append(
                {"role": "user", "content": "Tool budget reached. Answer now with what you have; say what is unfinished."}
            )

        async def on_text(text: str) -> None:
            await emit("token", {"text": text})

        model = current_model.get() or settings.model
        reply = await stream_completion(model, messages, tools or None, settings.max_tokens, on_text)
        await emit("message", {"text": reply.get("content") or ""})
        for call in tool_calls_of(reply):
            args, _ = parse_args(call)
            await emit("tool_call", {"id": call["id"], "name": call["function"]["name"], "args": args or {}})
        return {"messages": [reply]}

    def after_agent(state: AgentState) -> str:
        return "approval" if tool_calls_of(state["messages"][-1]) else END

    async def approval(state: AgentState) -> dict[str, Any]:
        # No side effects before interrupt(): LangGraph re-runs this node from the top on resume.
        decisions: dict[str, dict[str, Any]] = {}
        for call in tool_calls_of(state["messages"][-1]):
            tool = hub.tools.get(call["function"]["name"])
            args, error = parse_args(call)
            if tool is None or error or not tool.needs_approval:
                continue
            payload = approval_payload(call, args or {})
            if payload["sql"] and analyze_sql(payload["sql"]).read_only:
                continue  # a plain SELECT through the write server needs no approval
            answer = interrupt(payload)
            decisions[call["id"]] = answer if isinstance(answer, dict) else {"decision": str(answer)}
        return {"decisions": decisions}

    async def tools(state: AgentState) -> dict[str, Any]:
        emit = current_emit.get()
        await emit("step", {"node": "tools"})
        decisions = state.get("decisions") or {}
        results = []
        for call in tool_calls_of(state["messages"][-1]):
            name = call["function"]["name"]
            args, error = parse_args(call)
            decision = decisions.get(call["id"], {})
            if error:
                content, is_error = error, True
            elif decision.get("decision") == "reject":
                feedback = (decision.get("feedback") or "").strip()
                content = "The user rejected this call." + (f" Feedback: {feedback}" if feedback else "")
                is_error = True
            else:
                try:
                    result = await hub.call(name, args or {})
                    content, is_error = result.content, result.is_error
                except Exception as exc:  # noqa: BLE001 - surface tool failures to the model
                    content, is_error = f"Tool failed: {exc}", True
            truncated = len(content) > settings.max_tool_chars
            model_content = content[: settings.max_tool_chars] + ("\n... (truncated)" if truncated else "")
            await emit(
                "tool_result",
                {"id": call["id"], "name": name, "content": content[:200_000], "is_error": is_error, "truncated": truncated},
            )
            results.append({"role": "tool", "tool_call_id": call["id"], "content": model_content})
        return {"messages": results, "steps": state.get("steps", 0) + 1, "decisions": {}}

    builder = StateGraph(AgentState)
    builder.add_node("retrieve_context", retrieve_context)
    builder.add_node("agent", agent)
    builder.add_node("approval", approval)
    builder.add_node("tools", tools)
    builder.add_edge(START, "retrieve_context")
    builder.add_edge("retrieve_context", "agent")
    builder.add_conditional_edges("agent", after_agent, ["approval", END])
    builder.add_edge("approval", "tools")
    builder.add_edge("tools", "agent")
    return builder.compile(checkpointer=checkpointer or InMemorySaver())
