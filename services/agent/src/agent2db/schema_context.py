"""Compact schema digest injected before the model's first step, so it rarely has to guess table names.

Small databases get every table with columns and keys; large ones get table names only and the
model drills in with the MCP tools (list_objects / get_object_details).
"""

from __future__ import annotations

import asyncio
import logging
from collections import defaultdict

import psycopg

log = logging.getLogger(__name__)

_COLUMNS_SQL = """
select c.table_schema, c.table_name, c.column_name, c.data_type, c.is_nullable
from information_schema.columns c
join information_schema.tables t
  on t.table_schema = c.table_schema and t.table_name = c.table_name
where c.table_schema not in ('pg_catalog', 'information_schema', 'pg_toast')
  and t.table_type in ('BASE TABLE', 'VIEW')
order by c.table_schema, c.table_name, c.ordinal_position
"""

_KEYS_SQL = """
select n.nspname, cl.relname, con.contype, pg_get_constraintdef(con.oid)
from pg_constraint con
join pg_class cl on cl.oid = con.conrelid
join pg_namespace n on n.oid = cl.relnamespace
where con.contype in ('p', 'f') and n.nspname not in ('pg_catalog', 'information_schema')
"""

_ROWS_SQL = """
select n.nspname, c.relname, greatest(c.reltuples, 0)::bigint
from pg_class c join pg_namespace n on n.oid = c.relnamespace
where c.relkind in ('r', 'p') and n.nspname not in ('pg_catalog', 'information_schema', 'pg_toast')
"""


def build_schema_digest(dsn: str, max_tables: int = 60, max_chars: int = 12000) -> str:
    # Sync psycopg: async psycopg needs a selector event loop, but MCP stdio on Windows needs Proactor.
    with psycopg.connect(dsn, connect_timeout=5, autocommit=True) as conn:
        conn.execute("set statement_timeout = '5s'")
        conn.execute("set default_transaction_read_only = on")
        columns = conn.execute(_COLUMNS_SQL).fetchall()
        keys = conn.execute(_KEYS_SQL).fetchall()
        rows = conn.execute(_ROWS_SQL).fetchall()

    tables: dict[str, list[str]] = defaultdict(list)
    for schema, table, column, data_type, nullable in columns:
        tables[f"{schema}.{table}"].append(f"{column} {data_type}{'' if nullable == 'YES' else ' not null'}")
    constraints: dict[str, list[str]] = defaultdict(list)
    for schema, table, kind, definition in keys:
        constraints[f"{schema}.{table}"].append(definition if kind == "f" else definition.replace("PRIMARY KEY", "pk"))
    row_counts = {f"{schema}.{table}": count for schema, table, count in rows}

    if not tables:
        return "The database has no user tables yet."

    lines = [f"Database has {len(tables)} tables/views."]
    detailed = len(tables) <= max_tables
    for name, cols in tables.items():
        estimate = row_counts.get(name)
        suffix = f"  -- ~{estimate} rows" if estimate else ""
        if detailed:
            keys_text = "; ".join(constraints.get(name, []))
            lines.append(f"{name}({', '.join(cols)}){' ' + keys_text if keys_text else ''}{suffix}")
        else:
            lines.append(f"{name}{suffix}")
    digest = "\n".join(lines)
    if not detailed:
        digest += "\n(Columns omitted because the database is large; use the schema tools for details.)"
    if len(digest) > max_chars:
        digest = digest[:max_chars] + "\n... (truncated; use the schema tools for the rest)"
    return digest


async def safe_schema_digest(dsn: str | None) -> str:
    if not dsn:
        return "No database connection configured for schema preview."
    try:
        return await asyncio.to_thread(build_schema_digest, dsn)
    except Exception as exc:  # noqa: BLE001 - the agent can still work through the MCP tools
        log.warning("schema digest failed: %s", exc)
        return f"Schema preview unavailable ({type(exc).__name__}); use the schema tools."
