"""Estimate what a write will touch before the user approves it.

- DML (INSERT/UPDATE/DELETE/MERGE): `EXPLAIN (FORMAT JSON)` inside a read-only transaction. The
  planner's row estimate for the ModifyTable node is the number of rows the statement will touch.
  Nothing executes.
- DROP/TRUNCATE: the planner cannot help, so report the row estimates of the named tables.
- DDL and everything else: no estimate.
"""

from __future__ import annotations

import asyncio
import logging
from typing import Any

import psycopg

from agent2db.sql_safety import DESTRUCTIVE_KINDS, DML_KINDS, SqlAnalysis

log = logging.getLogger(__name__)


def _modify_rows(plan: dict[str, Any]) -> float | None:
    # Since PostgreSQL 14 the ModifyTable node itself reports 0 rows (nothing is returned); the
    # number of rows it will modify is the row estimate of its input plan.
    if plan.get("Node Type") == "ModifyTable":
        children = plan.get("Plans") or ()
        if children:
            return sum(float(child.get("Plan Rows") or 0) for child in children)
        return plan.get("Plan Rows")
    for child in plan.get("Plans") or ():
        found = _modify_rows(child)
        if found is not None:
            return found
    return plan.get("Plan Rows")


def _explain_sync(dsn: str, sql: str) -> dict[str, Any]:
    with psycopg.connect(dsn, connect_timeout=5) as conn:
        conn.execute("set transaction read only")
        conn.execute("set local statement_timeout = '5s'")
        row = conn.execute(f"explain (format json) {sql}").fetchone()
        conn.rollback()
    plan = row[0][0]["Plan"]
    rows = _modify_rows(plan)
    return {
        "kind": "rows",
        "rows": int(rows) if rows is not None else None,
        "relation": plan.get("Relation Name"),
        "operation": plan.get("Operation"),
    }


def _table_rows_sync(dsn: str, tables: list[str]) -> dict[str, Any]:
    with psycopg.connect(dsn, connect_timeout=5, autocommit=True) as conn:
        conn.execute("set statement_timeout = '5s'")
        out: dict[str, int | None] = {}
        for name in tables:
            try:
                row = conn.execute(
                    "select greatest(c.reltuples, 0)::bigint from pg_class c where c.oid = %s::regclass", (name,)
                ).fetchone()
                out[name] = int(row[0]) if row else None
            except psycopg.Error:
                out[name] = None
    return {"kind": "table_rows", "tables": out}


async def estimate_impact(dsn: str | None, sql: str, analysis: SqlAnalysis) -> dict[str, Any] | None:
    """Best-effort impact estimate; never raises, returns None when nothing useful can be said."""
    if not dsn or analysis.parse_error or len(analysis.statement_types) != 1:
        return None
    kinds = analysis.kinds
    try:
        if kinds & DML_KINDS and not any("CTE" in t for t in analysis.statement_types):
            return await asyncio.to_thread(_explain_sync, dsn, sql)
        if kinds & DESTRUCTIVE_KINDS and analysis.tables:
            return await asyncio.to_thread(_table_rows_sync, dsn, analysis.tables)
    except Exception as exc:  # noqa: BLE001 - an estimate is a nicety, approval still proceeds
        log.info("impact estimate unavailable: %s", exc)
        return {"kind": "unavailable", "reason": str(exc).strip().splitlines()[0][:200]}
    return None


def describe_estimate(estimate: dict[str, Any] | None) -> str | None:
    """One human line for the approval dialog."""
    if not estimate:
        return None
    kind = estimate.get("kind")
    if kind == "rows":
        rows = estimate.get("rows")
        rel = estimate.get("relation")
        if rows is None:
            return None
        where = f" in {rel}" if rel else ""
        return f"Planner estimate: ~{rows} row{'s' if rows != 1 else ''} affected{where}."
    if kind == "table_rows":
        parts = [f"{name} (~{count} rows)" if count is not None else name for name, count in estimate["tables"].items()]
        return "Affects all data in: " + ", ".join(parts) + "."
    if kind == "unavailable":
        return f"No impact estimate: {estimate.get('reason')}"
    return None
