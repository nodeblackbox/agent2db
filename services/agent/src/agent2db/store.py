"""The app database: sessions, runs, events, approvals, saved queries, facts and the schema index.

Uses a synchronous psycopg pool driven through `asyncio.to_thread`. Async psycopg needs a selector
event loop, but the MCP stdio transport on Windows needs the Proactor loop, so the backend stays
on sync connections in worker threads.
"""

from __future__ import annotations

import asyncio
import json
import logging
import re
from datetime import datetime
from pathlib import Path
from typing import Any

import psycopg
from psycopg.rows import dict_row
from psycopg.types.json import Jsonb
from psycopg_pool import ConnectionPool

from agent2db.config import MIGRATIONS_DIR

log = logging.getLogger(__name__)

SCHEMA = "agent2db"


def _dsn_with_search_path(dsn: str, search_path: str) -> str:
    """Return a DSN whose connections default to `search_path` (used for the checkpointer tables)."""
    info = psycopg.conninfo.conninfo_to_dict(dsn)
    options = str(info.get("options") or "")
    info["options"] = f"{options} -c search_path={search_path}".strip()
    return psycopg.conninfo.make_conninfo(**info)


class AppStore:
    """All app-DB access. Every public method is async and runs its SQL in a worker thread."""

    def __init__(self, dsn: str, *, min_size: int = 1, max_size: int = 6) -> None:
        self.dsn = dsn
        self.checkpoint_dsn = _dsn_with_search_path(dsn, SCHEMA)
        self._pool = ConnectionPool(
            dsn,
            min_size=min_size,
            max_size=max_size,
            open=False,
            kwargs={"row_factory": dict_row, "connect_timeout": 10, "autocommit": True},
        )
        self.ready = False
        self.migrations_applied: list[int] = []

    # ---------- lifecycle ----------

    async def open(self) -> None:
        await asyncio.to_thread(self._open_sync)

    def _open_sync(self) -> None:
        self._pool.open(wait=True, timeout=30)
        self._migrate()
        self.ready = True

    async def close(self) -> None:
        if self._pool.closed:
            return
        await asyncio.to_thread(self._pool.close)

    def _migrate(self) -> None:
        with self._pool.connection() as conn:
            conn.execute(f"create schema if not exists {SCHEMA}")
            conn.execute(
                f"create table if not exists {SCHEMA}.schema_migrations "
                "(version integer primary key, applied_at timestamptz not null default now())"
            )
            done = {row["version"] for row in conn.execute(f"select version from {SCHEMA}.schema_migrations")}
            for path in sorted(MIGRATIONS_DIR.glob("*.sql")):
                version = int(re.match(r"(\d+)", path.name).group(1))
                if version in done:
                    continue
                log.info("applying migration %s", path.name)
                with conn.transaction():
                    conn.execute(path.read_text(encoding="utf-8"))
                    conn.execute(f"insert into {SCHEMA}.schema_migrations (version) values (%s)", (version,))
                self.migrations_applied.append(version)

    async def _run(self, fn, *args):
        return await asyncio.to_thread(self._with_conn, fn, *args)

    def _with_conn(self, fn, *args):
        with self._pool.connection() as conn:
            return fn(conn, *args)

    # ---------- sessions and runs ----------

    async def ensure_session(self, session_id: str, title_hint: str, model: str | None) -> None:
        title = title_hint.strip().splitlines()[0][:80] if title_hint.strip() else "New chat"

        def fn(conn):
            conn.execute(
                f"insert into {SCHEMA}.sessions (id, title, model) values (%s, %s, %s) "
                "on conflict (id) do update set updated_at = now()",
                (session_id, title, model),
            )

        await self._run(fn)

    async def create_run(self, run_id: str, session_id: str, message: str, model: str | None) -> None:
        def fn(conn):
            conn.execute(
                f"insert into {SCHEMA}.runs (id, session_id, status, model, message) values (%s, %s, 'running', %s, %s)",
                (run_id, session_id, model, message),
            )

        await self._run(fn)

    async def finish_run(
        self,
        run_id: str,
        status: str,
        *,
        answer: str | None = None,
        usage: dict[str, Any] | None = None,
        steps: int | None = None,
        error: str | None = None,
    ) -> None:
        usage = usage or {}

        def fn(conn):
            conn.execute(
                f"""update {SCHEMA}.runs set status = %s,
                       answer = coalesce(%s, answer),
                       tokens_in = coalesce(%s, tokens_in), tokens_out = coalesce(%s, tokens_out),
                       cost_usd = coalesce(%s, cost_usd), steps = coalesce(%s, steps),
                       error = coalesce(%s, error),
                       ended_at = case when %s in ('completed', 'failed', 'cancelled') then now() else ended_at end
                   where id = %s""",
                (
                    status,
                    answer,
                    usage.get("tokens_in"),
                    usage.get("tokens_out"),
                    usage.get("cost_usd"),
                    steps,
                    error,
                    status,
                    run_id,
                ),
            )
            conn.execute(
                f"update {SCHEMA}.sessions set updated_at = now() where id = (select session_id from {SCHEMA}.runs where id = %s)",
                (run_id,),
            )

        await self._run(fn)

    async def set_run_status(self, run_id: str, status: str) -> None:
        await self.finish_run(run_id, status)

    async def append_event(self, run_id: str, seq: int, event_type: str, payload: dict[str, Any]) -> None:
        def fn(conn):
            conn.execute(
                f"insert into {SCHEMA}.run_events (run_id, seq, type, payload) values (%s, %s, %s, %s) on conflict do nothing",
                (run_id, seq, event_type, Jsonb(payload, dumps=lambda o: json.dumps(o, default=str))),
            )

        await self._run(fn)

    async def get_run(self, run_id: str) -> dict[str, Any] | None:
        def fn(conn):
            return conn.execute(f"select * from {SCHEMA}.runs where id = %s", (run_id,)).fetchone()

        return await self._run(fn)

    async def list_run_events(self, run_id: str, after: int = 0) -> list[tuple[int, str, dict[str, Any]]]:
        def fn(conn):
            rows = conn.execute(
                f"select seq, type, payload from {SCHEMA}.run_events where run_id = %s and seq > %s order by seq",
                (run_id, after),
            ).fetchall()
            return [(r["seq"], r["type"], r["payload"]) for r in rows]

        return await self._run(fn)

    async def pending_runs(self) -> list[dict[str, Any]]:
        """Runs that were waiting for approval (or still running) when the backend last stopped."""

        def fn(conn):
            return conn.execute(
                f"select * from {SCHEMA}.runs where status in ('awaiting_approval', 'running') order by started_at"
            ).fetchall()

        return await self._run(fn)

    async def list_sessions(self, limit: int = 50) -> list[dict[str, Any]]:
        def fn(conn):
            return conn.execute(
                f"""select s.id, s.title, s.model, s.created_at, s.updated_at,
                           count(r.id) as run_count,
                           coalesce(sum(r.tokens_in), 0) as tokens_in, coalesce(sum(r.tokens_out), 0) as tokens_out,
                           coalesce(sum(r.cost_usd), 0) as cost_usd
                    from {SCHEMA}.sessions s left join {SCHEMA}.runs r on r.session_id = s.id
                    group by s.id order by s.updated_at desc limit %s""",
                (limit,),
            ).fetchall()

        return await self._run(fn)

    async def list_session_runs(self, session_id: str) -> list[dict[str, Any]]:
        def fn(conn):
            return conn.execute(
                f"select * from {SCHEMA}.runs where session_id = %s order by started_at", (session_id,)
            ).fetchall()

        return await self._run(fn)

    async def delete_session(self, session_id: str) -> bool:
        def fn(conn):
            return conn.execute(f"delete from {SCHEMA}.sessions where id = %s", (session_id,)).rowcount > 0

        return await self._run(fn)

    # ---------- approvals ----------

    async def record_approval_request(self, run_id: str, payload: dict[str, Any]) -> None:
        def fn(conn):
            conn.execute(
                f"""insert into {SCHEMA}.approvals (run_id, tool_call_id, tool_name, sql, statement_types, warnings, estimate)
                    values (%s, %s, %s, %s, %s, %s, %s)
                    on conflict (run_id, tool_call_id) do nothing""",
                (
                    run_id,
                    payload["tool_call_id"],
                    payload["name"],
                    payload.get("sql"),
                    list(payload.get("statement_types") or []),
                    list(payload.get("warnings") or []),
                    Jsonb(payload.get("estimate")) if payload.get("estimate") is not None else None,
                ),
            )

        await self._run(fn)

    async def record_approval_decision(self, run_id: str, tool_call_id: str, decision: str, feedback: str | None) -> None:
        def fn(conn):
            conn.execute(
                f"update {SCHEMA}.approvals set decision = %s, feedback = %s, decided_at = now() "
                "where run_id = %s and tool_call_id = %s",
                (decision, feedback, run_id, tool_call_id),
            )

        await self._run(fn)

    async def list_approvals(self, limit: int = 100) -> list[dict[str, Any]]:
        def fn(conn):
            return conn.execute(
                f"select * from {SCHEMA}.approvals order by requested_at desc limit %s", (limit,)
            ).fetchall()

        return await self._run(fn)

    # ---------- saved queries ----------

    async def save_query(
        self, name: str, sql: str, description: str = "", tables: list[str] | None = None, tags: list[str] | None = None
    ) -> dict[str, Any]:
        def fn(conn):
            return conn.execute(
                f"""insert into {SCHEMA}.saved_queries (name, description, sql, tables, tags)
                    values (%s, %s, %s, %s, %s)
                    on conflict (name) do update set description = excluded.description, sql = excluded.sql,
                        tables = excluded.tables, tags = excluded.tags, updated_at = now()
                    returning id, name, description, sql, tables, tags, use_count, created_at, updated_at""",
                (name.strip(), description.strip(), sql.strip(), tables or [], tags or []),
            ).fetchone()

        return await self._run(fn)

    async def search_saved_queries(self, query: str, limit: int = 5) -> list[dict[str, Any]]:
        return await self._run(self._search_sync, "saved_queries", query, limit)

    async def list_saved_queries(self, limit: int = 100) -> list[dict[str, Any]]:
        def fn(conn):
            return conn.execute(
                f"select id, name, description, sql, tables, tags, use_count, created_at, updated_at "
                f"from {SCHEMA}.saved_queries order by updated_at desc limit %s",
                (limit,),
            ).fetchall()

        return await self._run(fn)

    async def delete_saved_query(self, query_id: int) -> bool:
        def fn(conn):
            return conn.execute(f"delete from {SCHEMA}.saved_queries where id = %s", (query_id,)).rowcount > 0

        return await self._run(fn)

    async def bump_query_use(self, query_id: int) -> None:
        def fn(conn):
            conn.execute(f"update {SCHEMA}.saved_queries set use_count = use_count + 1 where id = %s", (query_id,))

        await self._run(fn)

    # ---------- facts (long-term memory) ----------

    async def add_fact(self, content: str, subject: str | None = None, tags: list[str] | None = None, source: str = "agent") -> dict[str, Any]:
        def fn(conn):
            return conn.execute(
                f"insert into {SCHEMA}.facts (content, subject, tags, source) values (%s, %s, %s, %s) "
                "returning id, content, subject, tags, source, created_at",
                (content.strip(), (subject or "").strip() or None, tags or [], source),
            ).fetchone()

        return await self._run(fn)

    async def search_facts(self, query: str, limit: int = 8) -> list[dict[str, Any]]:
        return await self._run(self._search_sync, "facts", query, limit)

    async def list_facts(self, limit: int = 200) -> list[dict[str, Any]]:
        def fn(conn):
            return conn.execute(
                f"select id, content, subject, tags, source, created_at from {SCHEMA}.facts order by created_at desc limit %s",
                (limit,),
            ).fetchall()

        return await self._run(fn)

    async def delete_fact(self, fact_id: int) -> bool:
        def fn(conn):
            return conn.execute(f"delete from {SCHEMA}.facts where id = %s", (fact_id,)).rowcount > 0

        return await self._run(fn)

    @staticmethod
    def _search_sync(conn, table: str, query: str, limit: int) -> list[dict[str, Any]]:
        """Full-text search with a trigram-free fallback: websearch_to_tsquery, then plain ILIKE on words."""
        columns = (
            "id, name, description, sql, tables, tags, use_count"
            if table == "saved_queries"
            else "id, content, subject, tags, source"
        )
        rows = conn.execute(
            f"""select {columns}, ts_rank(search, q) as rank
                from {SCHEMA}.{table}, websearch_to_tsquery('english', %s) q
                where search @@ q order by rank desc limit %s""",
            (query, limit),
        ).fetchall()
        if rows:
            return rows
        words = [w for w in re.findall(r"[A-Za-z0-9_]{3,}", query)][:6]
        if not words:
            return []
        text_expr = "name || ' ' || description || ' ' || sql" if table == "saved_queries" else "content || ' ' || coalesce(subject, '')"
        clauses = " or ".join(f"({text_expr}) ilike %s" for _ in words)
        return conn.execute(
            f"select {columns}, 0::real as rank from {SCHEMA}.{table} where {clauses} limit %s",
            tuple(f"%{w}%" for w in words) + (limit,),
        ).fetchall()

    # ---------- schema index ----------

    async def get_schema_meta(self, connection_id: str = "default") -> dict[str, Any] | None:
        def fn(conn):
            return conn.execute(
                f"select * from {SCHEMA}.schema_index_meta where connection_id = %s", (connection_id,)
            ).fetchone()

        return await self._run(fn)

    async def replace_schema_index(
        self, cards: list[dict[str, Any]], fingerprint: str, embedding_model: str | None, connection_id: str = "default"
    ) -> None:
        def fn(conn):
            with conn.transaction():
                conn.execute(f"delete from {SCHEMA}.schema_index where connection_id = %s", (connection_id,))
                with conn.cursor() as cur:
                    cur.executemany(
                        f"""insert into {SCHEMA}.schema_index
                            (connection_id, table_name, kind, comment, description, ddl, columns, foreign_keys, row_estimate, embedding)
                            values (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s)""",
                        [
                            (
                                connection_id,
                                c["table_name"],
                                c["kind"],
                                c.get("comment"),
                                c["description"],
                                c["ddl"],
                                Jsonb(c["columns"]),
                                Jsonb(c.get("foreign_keys") or []),
                                c.get("row_estimate"),
                                c.get("embedding"),
                            )
                            for c in cards
                        ],
                    )
                conn.execute(
                    f"""insert into {SCHEMA}.schema_index_meta (connection_id, fingerprint, table_count, embedding_model, indexed_at)
                        values (%s, %s, %s, %s, now())
                        on conflict (connection_id) do update set fingerprint = excluded.fingerprint,
                            table_count = excluded.table_count, embedding_model = excluded.embedding_model, indexed_at = now()""",
                    (connection_id, fingerprint, len(cards), embedding_model),
                )

        await self._run(fn)

    async def load_schema_cards(self, connection_id: str = "default", with_embeddings: bool = True) -> list[dict[str, Any]]:
        def fn(conn):
            cols = "table_name, kind, comment, description, ddl, columns, foreign_keys, row_estimate" + (
                ", embedding" if with_embeddings else ""
            )
            return conn.execute(
                f"select {cols} from {SCHEMA}.schema_index where connection_id = %s order by table_name", (connection_id,)
            ).fetchall()

        return await self._run(fn)

    async def get_schema_card(self, table_name: str, connection_id: str = "default") -> dict[str, Any] | None:
        def fn(conn):
            return conn.execute(
                f"""select table_name, kind, comment, description, ddl, columns, foreign_keys, row_estimate, indexed_at
                    from {SCHEMA}.schema_index where connection_id = %s and (table_name = %s or table_name = 'public.' || %s)""",
                (connection_id, table_name, table_name),
            ).fetchone()

        return await self._run(fn)

    # ---------- stats ----------

    async def stats(self) -> dict[str, Any]:
        def fn(conn):
            row = conn.execute(
                f"""select (select count(*) from {SCHEMA}.sessions) as sessions,
                           (select count(*) from {SCHEMA}.runs) as runs,
                           (select count(*) from {SCHEMA}.saved_queries) as saved_queries,
                           (select count(*) from {SCHEMA}.facts) as facts,
                           (select count(*) from {SCHEMA}.schema_index) as indexed_tables"""
            ).fetchone()
            return dict(row)

        return await self._run(fn)


def json_ready(value: Any) -> Any:
    """Make store rows JSON-serialisable for API responses."""
    if isinstance(value, dict):
        return {k: json_ready(v) for k, v in value.items()}
    if isinstance(value, list):
        return [json_ready(v) for v in value]
    if isinstance(value, datetime):
        return value.isoformat()
    if isinstance(value, Path):
        return str(value)
    if hasattr(value, "__float__") and not isinstance(value, (int, float, bool)):
        return float(value)
    return value
