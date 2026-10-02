"""Database viewer backend: paged table data, read-only ad-hoc queries and a Mermaid ER diagram.

Everything runs on the read DSN inside a read-only transaction with a statement timeout, so the
viewer can never change data; changes go through the agent and its approval flow.
"""

from __future__ import annotations

import asyncio
import json
import re
import time
from typing import Any

import psycopg

from agent2db.sql_safety import analyze_sql

_IDENT = re.compile(r"^[A-Za-z_][A-Za-z0-9_$]*$")
MAX_ROWS = 500


def _quote(name: str) -> str:
    return '"' + name.replace('"', '""') + '"'


def qualified(table: str) -> str:
    """`schema.table` -> `"schema"."table"`; rejects anything that is not a plain identifier pair."""
    parts = table.split(".")
    if len(parts) != 2 or not all(_IDENT.match(p) for p in parts):
        raise ValueError(f"Invalid table name {table!r}; expected schema.table")
    return ".".join(_quote(p) for p in parts)


def _json_row(row: tuple[Any, ...]) -> list[Any]:
    return json.loads(json.dumps(list(row), default=str))


def _rows_sync(dsn: str, table: str, limit: int, offset: int, order_by: str | None, descending: bool, where: str | None) -> dict[str, Any]:
    target = qualified(table)
    order = ""
    if order_by:
        if not _IDENT.match(order_by):
            raise ValueError("Invalid order column")
        order = f" order by {_quote(order_by)} {'desc' if descending else 'asc'}"
    filter_sql = ""
    if where and where.strip():
        probe = analyze_sql(f"select 1 from {target} where {where}")
        if not probe.read_only or len(probe.statement_types) != 1:
            raise ValueError("Filter must be a plain WHERE expression")
        filter_sql = f" where {where}"
    with psycopg.connect(dsn, connect_timeout=5) as conn:
        conn.execute("set transaction read only")
        conn.execute("set local statement_timeout = '20s'")
        schema, name = table.split(".")
        est = conn.execute(
            "select greatest(c.reltuples, 0)::bigint from pg_class c join pg_namespace n on n.oid = c.relnamespace where n.nspname = %s and c.relname = %s",
            (schema, name),
        ).fetchone()
        estimate = int(est[0]) if est else 0
        total: int | None = None
        if estimate < 200_000 or filter_sql:
            total = int(conn.execute(f"select count(*) from {target}{filter_sql}").fetchone()[0])
        cur = conn.execute(f"select * from {target}{filter_sql}{order} limit %s offset %s", (limit, offset))
        columns = [d.name for d in cur.description or []]
        rows = [_json_row(r) for r in cur.fetchall()]
        conn.rollback()
    return {"table": table, "columns": columns, "rows": rows, "limit": limit, "offset": offset, "total": total, "estimate": estimate}


async def table_rows(dsn: str, table: str, *, limit: int = 50, offset: int = 0, order_by: str | None = None, descending: bool = False, where: str | None = None) -> dict[str, Any]:
    limit = max(1, min(limit, MAX_ROWS))
    return await asyncio.to_thread(_rows_sync, dsn, table, limit, max(0, offset), order_by, descending, where)


def _query_sync(dsn: str, sql: str, max_rows: int) -> dict[str, Any]:
    analysis = analyze_sql(sql)
    if analysis.parse_error:
        return {"error": f"Could not parse SQL: {analysis.parse_error}", "columns": [], "rows": [], "row_count": 0, "truncated": False, "ms": 0}
    if not analysis.read_only:
        return {
            "error": "Only read-only statements run here (" + ", ".join(analysis.statement_types) + "). Ask the agent to make changes; it will request your approval.",
            "columns": [],
            "rows": [],
            "row_count": 0,
            "truncated": False,
            "ms": 0,
        }
    started = time.perf_counter()
    with psycopg.connect(dsn, connect_timeout=5) as conn:
        conn.execute("set transaction read only")
        conn.execute("set local statement_timeout = '30s'")
        try:
            cur = conn.execute(sql)
            columns = [d.name for d in cur.description or []]
            fetched = cur.fetchmany(max_rows + 1) if cur.description else []
        except psycopg.Error as exc:
            conn.rollback()
            return {"error": str(exc).strip().splitlines()[0], "columns": [], "rows": [], "row_count": 0, "truncated": False, "ms": round((time.perf_counter() - started) * 1000)}
        conn.rollback()
    truncated = len(fetched) > max_rows
    rows = [_json_row(r) for r in fetched[:max_rows]]
    return {"columns": columns, "rows": rows, "row_count": len(rows), "truncated": truncated, "ms": round((time.perf_counter() - started) * 1000), "statement_types": analysis.statement_types}


async def run_query(dsn: str, sql: str, *, max_rows: int = MAX_ROWS) -> dict[str, Any]:
    return await asyncio.to_thread(_query_sync, dsn, sql, max(1, min(max_rows, MAX_ROWS)))


# ---------------------------------------------------------------- Mermaid ER diagram

_TYPE_ALIASES = {
    "character varying": "varchar",
    "character": "char",
    "timestamp with time zone": "timestamptz",
    "timestamp without time zone": "timestamp",
    "time with time zone": "timetz",
    "time without time zone": "time",
    "double precision": "float8",
    "bit varying": "varbit",
}


def _mermaid_type(type_name: str) -> str:
    t = _TYPE_ALIASES.get(type_name.lower(), type_name)
    t = re.sub(r"\(.*\)", "", t)
    t = re.sub(r"[^A-Za-z0-9_]", "_", t).strip("_")
    return t or "unknown"


def _entity(name: str, single_schema: bool) -> str:
    schema, _, table = name.partition(".")
    base = table if single_schema else f"{schema}_{table}"
    return re.sub(r"[^A-Za-z0-9_]", "_", base)


def mermaid_erd(cards: list[dict[str, Any]], *, max_columns: int = 24, tables: list[str] | None = None) -> str:
    """Build a Mermaid `erDiagram` from schema-index cards (columns, PK/FK constraints).

    Keys: PK for primary-key columns, FK for foreign-key columns, UK for single-column uniques.
    Relationships use crow's foot: parent ||--o{ child.
    """
    selected = [c for c in cards if not tables or c["table_name"] in tables]
    if not selected:
        return "erDiagram\n"
    schemas = {c["table_name"].split(".")[0] for c in selected}
    single = len(schemas) == 1
    names = {c["table_name"] for c in selected}
    lines = ["erDiagram"]
    for card in selected:
        entity = _entity(card["table_name"], single)
        pk = {col for con in card.get("constraints") or [] if con["type"] == "p" for col in con.get("columns") or []}
        uk = {col for con in card.get("constraints") or [] if con["type"] == "u" and len(con.get("columns") or []) == 1 for col in con["columns"]}
        fk = {col for f in card.get("foreign_keys") or [] for col in f.get("columns") or []}
        lines.append(f"    {entity} {{")
        for col in (card.get("columns") or [])[:max_columns]:
            keys = [k for k, has in (("PK", col["name"] in pk), ("FK", col["name"] in fk), ("UK", col["name"] in uk)) if has]
            key_text = f" {','.join(keys)}" if keys else ""
            comment = (col.get("comment") or "").replace('"', "'")
            if not comment and col.get("values"):
                comment = "values: " + ", ".join(str(v) for v in col["values"][:5])
            comment_text = f' "{comment[:60]}"' if comment else ""
            lines.append(f"        {_mermaid_type(col['type'])} {re.sub(r'[^A-Za-z0-9_]', '_', col['name'])}{key_text}{comment_text}")
        extra = len(card.get("columns") or []) - max_columns
        if extra > 0:
            lines.append(f'        more _{extra}_more_columns "not shown"')
        lines.append("    }")
    for card in selected:
        child = _entity(card["table_name"], single)
        for f in card.get("foreign_keys") or []:
            if f["ref_table"] not in names:
                continue
            parent = _entity(f["ref_table"], single)
            label = ",".join(f.get("columns") or []) or "fk"
            lines.append(f'    {parent} ||--o{{ {child} : "{label}"')
    return "\n".join(lines) + "\n"
