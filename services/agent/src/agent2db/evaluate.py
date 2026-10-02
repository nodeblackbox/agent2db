"""Benchmark the agent on known questions (`agent2db-eval`).

Each case in `evals/questions.json` has a natural-language question and an `expected_sql` whose
result (run directly on the database) must appear in the agent's final answer. The runner drives
the real graph in-process with real MCP servers and the real model, and reports accuracy, steps,
tokens and cost per question so agent changes can be compared.

    uv run --project services/agent agent2db-eval [--only top_customers] [--model openai/gpt-5-mini]
"""

from __future__ import annotations

import argparse
import asyncio
import json
import re
import sys
import time
from pathlib import Path
from typing import Any

import psycopg

from agent2db.config import SERVICE_DIR, Settings, load_env
from agent2db.graph import build_graph, current_emit, current_model
from agent2db.mcp_hub import McpHub, load_config
from agent2db.schema_index import SchemaIndex
from agent2db.store import AppStore
from agent2db.tools import Toolbox, memory_tools, schema_tools

CASES = SERVICE_DIR / "evals" / "questions.json"


def _numbers(text: str) -> set[str]:
    out = set()
    for raw in re.findall(r"-?\d[\d,]*\.?\d*", text):
        cleaned = raw.replace(",", "")
        try:
            value = float(cleaned)
        except ValueError:
            continue
        out.add(f"{value:.2f}".rstrip("0").rstrip("."))
    return out


def _expected_values(dsn: str, sql: str) -> list[str]:
    with psycopg.connect(dsn, autocommit=True) as conn:
        conn.execute("set default_transaction_read_only = on")
        rows = conn.execute(sql).fetchall()
    values: list[str] = []
    for row in rows:
        for cell in row:
            values.append(str(cell))
    return values


def _matches(answer: str, expected: list[str], mode: str) -> tuple[bool, list[str]]:
    missing = []
    answer_numbers = _numbers(answer)
    lowered = answer.lower()
    for value in expected:
        if mode == "numbers" or re.fullmatch(r"-?\d[\d,]*\.?\d*", value):
            key = _numbers(value)
            if not key or not key <= answer_numbers:
                missing.append(value)
        elif value.lower() not in lowered:
            missing.append(value)
    return not missing, missing


async def run_case(graph: Any, case: dict[str, Any], model: str | None) -> dict[str, Any]:
    events: list[tuple[str, dict[str, Any]]] = []

    async def emit(kind: str, data: dict[str, Any]) -> None:
        events.append((kind, data))

    current_emit.set(emit)
    current_model.set(model)
    thread = f"eval-{case['id']}-{int(time.time())}"
    config = {"configurable": {"thread_id": thread}, "recursion_limit": 200}
    started = time.perf_counter()
    async for _ in graph.astream({"messages": [{"role": "user", "content": case["question"]}]}, config, stream_mode="updates"):
        pass
    snapshot = await graph.aget_state(config)
    messages = snapshot.values.get("messages") or []
    answer = next((m["content"] for m in reversed(messages) if m.get("role") == "assistant" and m.get("content")), "")
    usage = snapshot.values.get("usage") or {}
    tool_calls = [d for k, d in events if k == "tool_call"]
    return {
        "id": case["id"],
        "answer": answer,
        "seconds": round(time.perf_counter() - started, 1),
        "tool_calls": len(tool_calls),
        "sql": [c["args"].get("sql") for c in tool_calls if isinstance(c.get("args"), dict) and c["args"].get("sql")],
        "usage": usage,
        "interrupted": bool(snapshot.interrupts),
    }


async def run_all(only: list[str], model: str | None, verbose: bool) -> int:
    load_env()
    settings = Settings.from_env()
    cases = json.loads(CASES.read_text(encoding="utf-8"))
    if only:
        cases = [c for c in cases if c["id"] in only]
    if not cases:
        print("No matching cases.", file=sys.stderr)
        return 2
    if not settings.read_dsn:
        print("DATABASE_URL / AGENT2DB_RO_DSN is required.", file=sys.stderr)
        return 2

    store = AppStore(settings.app_dsn) if settings.app_dsn else None
    if store:
        await store.open()
    hub = McpHub(load_config(settings.mcp_config))
    await hub.start()
    index = SchemaIndex(store, settings.read_dsn, embedding_model=settings.embedding_model)
    await index.load()
    await index.ensure_fresh()
    toolbox = Toolbox(hub, schema_tools(index) + (memory_tools(store) if store else []))
    graph = build_graph(settings, toolbox, schema_index=index, store=store)

    results = []
    try:
        for case in cases:
            expected = _expected_values(settings.read_dsn, case["expected_sql"])
            result = await run_case(graph, case, model)
            ok, missing = _matches(result["answer"], expected, case.get("match", "auto"))
            result.update({"ok": ok, "missing": missing, "expected": expected})
            results.append(result)
            usage = result["usage"]
            print(
                f"[{'PASS' if ok else 'FAIL'}] {case['id']}: {result['tool_calls']} tool calls, {result['seconds']}s, "
                f"{usage.get('tokens_in', 0)}+{usage.get('tokens_out', 0)} tokens, ${usage.get('cost_usd', 0):.4f}"
            )
            if not ok or verbose:
                print(f"   expected: {expected}")
                if missing:
                    print(f"   missing:  {missing}")
                print("   answer:   " + result["answer"].replace("\n", "\n             ")[:1500])
    finally:
        await hub.close()
        if store:
            await store.close()

    passed = sum(r["ok"] for r in results)
    cost = sum(float(r["usage"].get("cost_usd") or 0) for r in results)
    steps = sum(r["tool_calls"] for r in results) / len(results)
    print(f"\n{passed}/{len(results)} passed, avg {steps:.1f} tool calls, total ${cost:.4f}")
    out = SERVICE_DIR / "evals" / "last_run.json"
    out.write_text(json.dumps({"model": model or settings.model, "results": results}, indent=2, default=str), encoding="utf-8")
    return 0 if passed == len(results) else 1


def main() -> None:
    parser = argparse.ArgumentParser(description="Run the Agent2DB question benchmark.")
    parser.add_argument("--only", action="append", default=[], help="case id (repeatable)")
    parser.add_argument("--model", default=None)
    parser.add_argument("-v", "--verbose", action="store_true")
    args = parser.parse_args()
    sys.exit(asyncio.run(run_all(args.only, args.model, args.verbose)))


if __name__ == "__main__":
    main()
