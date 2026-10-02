"""The agent as an explicit LangGraph state machine.

START -> retrieve_context -> agent -> (no tool calls) -> END
                               ^   +-> approval (interrupt for write tools) -> tools --+
                               +-------------------------------------------------------+

retrieve_context ranks the schema for this request and pulls relevant saved queries and facts.
approval shows every write with its parsed statement types, warnings and an impact estimate.
tools runs MCP and internal tools, truncating output for the model while the UI gets it in full.
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
from agent2db.impact import describe_estimate, estimate_impact
from agent2db.llm import Usage, stream_completion
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
    memory: str
    decisions: dict[str, dict[str, Any]]
    usage: dict[str, Any]


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


def _size(message: dict[str, Any]) -> int:
    size = len(message.get("content") or "")
    for call in tool_calls_of(message):
        size += len(call["function"].get("arguments") or "") + len(call["function"].get("name") or "")
    return size


def trim_history(messages: list[dict[str, Any]], max_chars: int) -> list[dict[str, Any]]:
    """Keep the most recent messages within a character budget, cutting only at user-turn boundaries.

    Older tool results are shortened first, since they are the bulkiest and least useful later.
    The first user message of the trimmed-away part is replaced by a one-line note.
    """
    if sum(_size(m) for m in messages) <= max_chars:
        return messages
    # Pass 1: shrink old tool outputs (everything before the last user message).
    last_user = max((i for i, m in enumerate(messages) if m.get("role") == "user"), default=0)
    shrunk: list[dict[str, Any]] = []
    for i, message in enumerate(messages):
        if i < last_user and message.get("role") == "tool" and len(message.get("content") or "") > 400:
            shrunk.append({**message, "content": (message["content"][:300] + "\n... (older result shortened)")})
        else:
            shrunk.append(message)
    if sum(_size(m) for m in shrunk) <= max_chars:
        return shrunk
    # Pass 2: drop whole turns from the front, keeping the latest user turn and everything after it.
    boundaries = [i for i, m in enumerate(shrunk) if m.get("role") == "user"]
    for start in boundaries:
        tail = shrunk[start:]
        if sum(_size(m) for m in tail) <= max_chars or start == boundaries[-1]:
            dropped = start
            note = {"role": "user", "content": f"[Earlier conversation trimmed: {dropped} messages omitted for length.]"}
            return [note, *tail] if dropped else tail
    return shrunk


async def approval_payload(call: dict[str, Any], args: dict[str, Any], read_dsn: str | None) -> dict[str, Any]:
    sql = args.get("sql") if isinstance(args.get("sql"), str) else None
    analysis = analyze_sql(sql) if sql else None
    estimate = await estimate_impact(read_dsn, sql, analysis) if sql and analysis else None
    warnings = list(analysis.warnings) if analysis else []
    estimate_line = describe_estimate(estimate)
    if estimate_line:
        warnings.insert(0, estimate_line)
    return {
        "tool_call_id": call["id"],
        "name": call["function"]["name"],
        "args": args,
        "sql": sql,
        "statement_types": analysis.statement_types if analysis else [],
        "warnings": warnings,
        "tables": analysis.tables if analysis else [],
        "estimate": estimate,
    }


def _render_memory(saved: list[dict[str, Any]], facts: list[dict[str, Any]]) -> str:
    parts = []
    if facts:
        parts.append("Known facts about this database (confirmed earlier; trust them over guesses):")
        parts.extend(f"- {f['content']}" + (f" [{f['subject']}]" if f.get("subject") else "") for f in facts)
    if saved:
        parts.append("Saved queries that may apply (reuse or adapt; call memory__search_saved_queries for more):")
        for q in saved:
            sql = q["sql"].strip()
            if len(sql) > 600:
                sql = sql[:600] + " ..."
            parts.append(f"- {q['name']}: {q.get('description') or ''}\n  {sql}")
    return "\n".join(parts) if parts else "None yet."


def build_graph(
    settings: Settings,
    toolbox: Any,
    checkpointer: Any | None = None,
    *,
    schema_index: Any | None = None,
    store: Any | None = None,
):
    """`toolbox` is anything with `.tools`, `.openai_tools()` and `.call()` (Toolbox, McpHub or a fake)."""
    system_template = (PROMPTS_DIR / "system.md").read_text(encoding="utf-8")

    async def retrieve_context(state: AgentState) -> dict[str, Any]:
        emit = current_emit.get()
        await emit("step", {"node": "retrieve_context"})
        messages = state.get("messages", [])
        question = next((m["content"] for m in reversed(messages) if m.get("role") == "user"), "")
        earlier = [m["content"] for m in messages[:-1] if m.get("role") == "user"][-2:]

        schema_text: str | None = None
        if schema_index is not None:
            try:
                rebuilt = await schema_index.ensure_fresh()
                if rebuilt:
                    await emit("step", {"node": "index_schema"})
                if schema_index.cards:
                    schema_text = await schema_index.context(
                        question,
                        history="\n".join(earlier),
                        max_tables=settings.schema_max_tables,
                        max_chars=settings.schema_max_chars,
                    )
            except Exception as exc:  # noqa: BLE001 - fall back to the live digest
                await emit("step", {"node": "retrieve_context", "warning": f"schema index unavailable: {exc}"})
        if schema_text is None:
            schema_text = await safe_schema_digest(settings.read_dsn)

        memory_text = "None yet."
        if store is not None:
            try:
                saved = await store.search_saved_queries(question, limit=3)
                facts = await store.search_facts(question, limit=6)
                memory_text = _render_memory(saved, facts)
            except Exception as exc:  # noqa: BLE001
                memory_text = f"(memory unavailable: {exc})"
        return {"schema": schema_text, "memory": memory_text, "steps": 0, "decisions": {}, "usage": Usage().as_dict()}

    async def agent(state: AgentState) -> dict[str, Any]:
        emit = current_emit.get()
        await emit("step", {"node": "agent"})
        steps = state.get("steps", 0)
        system = (
            system_template.replace("{schema}", state.get("schema", ""))
            .replace("{memory}", state.get("memory", "None yet."))
            .replace("{max_steps}", str(settings.max_steps))
        )
        history = trim_history(close_dangling_tool_calls(state.get("messages", [])), settings.max_history_chars)
        messages = [{"role": "system", "content": system}, *history]
        tools = toolbox.openai_tools()
        if steps >= settings.max_steps:
            tools = []
            messages.append(
                {"role": "user", "content": "Tool budget reached. Answer now with what you have; say what is unfinished."}
            )

        async def on_text(text: str) -> None:
            await emit("token", {"text": text})

        model = current_model.get() or settings.model
        completion = await stream_completion(
            model, messages, tools or None, settings.max_tokens, on_text, fallbacks=settings.fallback_models
        )
        reply = completion.message
        usage = Usage.from_dict(state.get("usage")).add(completion.usage)
        await emit("message", {"text": reply.get("content") or ""})
        for call in tool_calls_of(reply):
            args, _ = parse_args(call)
            await emit("tool_call", {"id": call["id"], "name": call["function"]["name"], "args": args or {}})
        await emit("usage", {**usage.as_dict(), "model": completion.model or model})
        return {"messages": [reply], "usage": usage.as_dict()}

    def after_agent(state: AgentState) -> str:
        return "approval" if tool_calls_of(state["messages"][-1]) else END

    async def approval(state: AgentState) -> dict[str, Any]:
        # No side effects before interrupt(): LangGraph re-runs this node from the top on resume.
        decisions: dict[str, dict[str, Any]] = {}
        for call in tool_calls_of(state["messages"][-1]):
            tool = toolbox.tools.get(call["function"]["name"])
            args, error = parse_args(call)
            if tool is None or error or not tool.needs_approval:
                continue
            sql = args.get("sql") if args and isinstance(args.get("sql"), str) else None
            if sql and analyze_sql(sql).read_only:
                continue  # a plain SELECT through the write server needs no approval
            payload = await approval_payload(call, args or {}, settings.write_dsn or settings.read_dsn)
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
                    result = await toolbox.call(name, args or {})
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
