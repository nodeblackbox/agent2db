"""Internal tools (memory, saved queries, schema index) and the Toolbox that merges them with MCP tools.

The graph only talks to a Toolbox: `tools` (name -> tool with `needs_approval`), `openai_tools()` and
`call()`. MCP tools keep their `<server>__<tool>` names; internal tools use the pseudo-servers
`memory` and `schema` so the UI renders them the same way.
"""

from __future__ import annotations

import json
from collections.abc import Awaitable, Callable
from dataclasses import dataclass
from typing import TYPE_CHECKING, Any

from agent2db.mcp_hub import SEPARATOR, ToolResult

if TYPE_CHECKING:
    from agent2db.schema_index import SchemaIndex
    from agent2db.store import AppStore

Handler = Callable[[dict[str, Any]], Awaitable[str]]


@dataclass
class InternalTool:
    server_name: str
    name: str
    description: str
    parameters: dict[str, Any]
    handler: Handler
    needs_approval: bool = False

    @property
    def qualified_name(self) -> str:
        return f"{self.server_name}{SEPARATOR}{self.name}"

    def to_openai(self) -> dict[str, Any]:
        return {
            "type": "function",
            "function": {
                "name": self.qualified_name,
                "description": f"[{self.server_name}] {self.description}",
                "parameters": self.parameters,
            },
        }


def _schema(properties: dict[str, Any], required: list[str]) -> dict[str, Any]:
    return {"type": "object", "properties": properties, "required": required, "additionalProperties": False}


def _dumps(value: Any) -> str:
    return json.dumps(value, default=str, ensure_ascii=False)


def memory_tools(store: AppStore) -> list[InternalTool]:
    async def save_query(args: dict[str, Any]) -> str:
        row = await store.save_query(
            name=str(args["name"]),
            sql=str(args["sql"]),
            description=str(args.get("description") or ""),
            tables=[str(t) for t in args.get("tables") or []],
            tags=[str(t) for t in args.get("tags") or []],
        )
        return _dumps({"saved": True, "id": row["id"], "name": row["name"]})

    async def search_saved_queries(args: dict[str, Any]) -> str:
        rows = await store.search_saved_queries(str(args["query"]), limit=int(args.get("limit") or 5))
        return _dumps([{k: r[k] for k in ("id", "name", "description", "sql", "tables", "tags")} for r in rows])

    async def remember(args: dict[str, Any]) -> str:
        row = await store.add_fact(
            content=str(args["fact"]),
            subject=str(args.get("subject") or "") or None,
            tags=[str(t) for t in args.get("tags") or []],
        )
        return _dumps({"remembered": True, "id": row["id"]})

    async def recall(args: dict[str, Any]) -> str:
        rows = await store.search_facts(str(args["query"]), limit=int(args.get("limit") or 8))
        return _dumps([{k: r[k] for k in ("id", "content", "subject", "tags")} for r in rows])

    return [
        InternalTool(
            "memory",
            "save_query",
            "Save a working SQL query so it can be reused in later sessions. Use after a query the user is likely "
            "to want again (reports, KPIs, recurring questions). Same name overwrites.",
            _schema(
                {
                    "name": {"type": "string", "description": "Short unique name, e.g. monthly_revenue_by_customer"},
                    "sql": {"type": "string"},
                    "description": {"type": "string", "description": "What it answers and any caveats"},
                    "tables": {"type": "array", "items": {"type": "string"}},
                    "tags": {"type": "array", "items": {"type": "string"}},
                },
                ["name", "sql"],
            ),
            save_query,
        ),
        InternalTool(
            "memory",
            "search_saved_queries",
            "Find previously saved SQL queries by topic, table or name.",
            _schema({"query": {"type": "string"}, "limit": {"type": "integer", "minimum": 1, "maximum": 20}}, ["query"]),
            search_saved_queries,
        ),
        InternalTool(
            "memory",
            "remember",
            "Store a durable fact about this database or the user's business rules, e.g. "
            "'orders.status = 3 means refunded' or 'revenue excludes test customers (email like %@example.com)'. "
            "Only store facts confirmed by data or by the user, never guesses.",
            _schema(
                {
                    "fact": {"type": "string"},
                    "subject": {"type": "string", "description": "Table or column it is about, e.g. public.orders.status"},
                    "tags": {"type": "array", "items": {"type": "string"}},
                },
                ["fact"],
            ),
            remember,
        ),
        InternalTool(
            "memory",
            "recall",
            "Search stored facts about this database (meanings of codes, business rules, known data quirks).",
            _schema({"query": {"type": "string"}, "limit": {"type": "integer", "minimum": 1, "maximum": 20}}, ["query"]),
            recall,
        ),
    ]


def schema_tools(index: SchemaIndex) -> list[InternalTool]:
    async def describe_table(args: dict[str, Any]) -> str:
        card = await index.describe(str(args["table"]))
        if card is None:
            return f"Error: no table named {args['table']!r} in the schema index. Use schema__search_tables or list_objects."
        return card

    async def search_tables(args: dict[str, Any]) -> str:
        hits = await index.search(str(args["query"]), limit=int(args.get("limit") or 8))
        return _dumps(hits)

    return [
        InternalTool(
            "schema",
            "describe_table",
            "Full definition of one table from the schema index: columns, types, keys, indexes, foreign keys, "
            "row estimate and sample values of enum-like columns. Cheaper than querying the catalog.",
            _schema({"table": {"type": "string", "description": "Table name, optionally schema-qualified"}}, ["table"]),
            describe_table,
        ),
        InternalTool(
            "schema",
            "search_tables",
            "Rank tables by relevance to a topic (names, comments, columns). Use when the schema shown in the "
            "prompt does not contain what you need.",
            _schema({"query": {"type": "string"}, "limit": {"type": "integer", "minimum": 1, "maximum": 30}}, ["query"]),
            search_tables,
        ),
    ]


class Toolbox:
    """MCP tools plus internal tools behind one interface."""

    def __init__(self, hub: Any, internal: list[InternalTool] | None = None) -> None:
        self.hub = hub
        self.internal: dict[str, InternalTool] = {t.qualified_name: t for t in internal or []}

    @property
    def tools(self) -> dict[str, Any]:
        merged: dict[str, Any] = dict(self.hub.tools) if self.hub is not None else {}
        merged.update(self.internal)
        return merged

    def openai_tools(self) -> list[dict[str, Any]]:
        specs = list(self.hub.openai_tools()) if self.hub is not None else []
        specs.extend(t.to_openai() for t in self.internal.values())
        return specs

    async def call(self, name: str, args: dict[str, Any]) -> ToolResult:
        tool = self.internal.get(name)
        if tool is None:
            if self.hub is None:
                return ToolResult(f"Unknown tool {name!r}.", True)
            return await self.hub.call(name, args)
        try:
            text = await tool.handler(args)
        except KeyError as exc:
            return ToolResult(f"Error: missing argument {exc}.", True)
        except Exception as exc:  # noqa: BLE001 - report to the model
            return ToolResult(f"Error: {exc}", True)
        return ToolResult(text, text.startswith("Error:"))
