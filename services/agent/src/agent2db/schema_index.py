"""Ranked schema retrieval: index every table once, show the model only the relevant ones.

Chat2DB lists up to 500 table names and lets the model guess. Here each table becomes a card
(DDL, keys, indexes, foreign keys, row estimate, comments, enum-like sample values) stored in the
app DB. At question time the cards are ranked with BM25 (plus embeddings when an embedding model
is configured), tables the user named are forced in, the selection is expanded one hop along
foreign keys, and the result is rendered as real DDL within a character budget.

No pgvector needed: embeddings are stored as `real[]` and compared in Python, which is fine for
the few thousand tables a desktop tool will see.
"""

from __future__ import annotations

import asyncio
import hashlib
import logging
import re
from collections import defaultdict
from dataclasses import dataclass, field
from typing import TYPE_CHECKING, Any

import psycopg

from agent2db.ranking import BM25, Document, cosine, mentioned_tables, reciprocal_rank_fusion

if TYPE_CHECKING:
    from agent2db.store import AppStore

log = logging.getLogger(__name__)

EXCLUDED_SCHEMAS = ("pg_catalog", "information_schema", "pg_toast", "agent2db")
_ENUMISH_NAME = re.compile(r"(status|state|type|kind|category|currency|role|level|tier|stage|mode|method|source|channel|country|region|plan|interval|reason|code)$", re.IGNORECASE)
_TEXT_TYPES = {"text", "character varying", "character", "USER-DEFINED", "bpchar", "varchar"}

_FINGERPRINT_SQL = f"""
select coalesce(md5(string_agg(c.table_schema || '.' || c.table_name || '.' || c.column_name || ':' || c.data_type,
                               ',' order by c.table_schema, c.table_name, c.ordinal_position)), 'empty') as fp,
       count(distinct c.table_schema || '.' || c.table_name) as tables
from information_schema.columns c
where c.table_schema not in {EXCLUDED_SCHEMAS!r}
"""

_TABLES_SQL = f"""
select n.nspname as schema, c.relname as name, c.relkind as kind, greatest(c.reltuples, 0)::bigint as rows,
       obj_description(c.oid, 'pg_class') as comment
from pg_class c join pg_namespace n on n.oid = c.relnamespace
where c.relkind in ('r', 'p', 'v', 'm', 'f') and n.nspname not in {EXCLUDED_SCHEMAS!r}
  and n.nspname not like 'pg_temp%'
order by n.nspname, c.relname
"""

_COLUMNS_SQL = f"""
select c.table_schema as schema, c.table_name as table, c.column_name as name,
       case when c.data_type = 'USER-DEFINED' then c.udt_name
            when c.data_type = 'ARRAY' then c.udt_name
            else c.data_type end as type,
       c.data_type as base_type, c.is_nullable = 'YES' as nullable, c.column_default as "default",
       c.character_maximum_length as max_len,
       col_description(format('%I.%I', c.table_schema, c.table_name)::regclass, c.ordinal_position) as comment
from information_schema.columns c
where c.table_schema not in {EXCLUDED_SCHEMAS!r}
order by c.table_schema, c.table_name, c.ordinal_position
"""

_CONSTRAINTS_SQL = f"""
select n.nspname as schema, cl.relname as table, con.conname as name, con.contype as type,
       pg_get_constraintdef(con.oid) as definition,
       (select array_agg(a.attname order by k.ord) from unnest(con.conkey) with ordinality k(attnum, ord)
          join pg_attribute a on a.attrelid = con.conrelid and a.attnum = k.attnum) as columns,
       fn.nspname as ref_schema, fcl.relname as ref_table,
       (select array_agg(a.attname order by k.ord) from unnest(con.confkey) with ordinality k(attnum, ord)
          join pg_attribute a on a.attrelid = con.confrelid and a.attnum = k.attnum) as ref_columns
from pg_constraint con
join pg_class cl on cl.oid = con.conrelid
join pg_namespace n on n.oid = cl.relnamespace
left join pg_class fcl on fcl.oid = con.confrelid
left join pg_namespace fn on fn.oid = fcl.relnamespace
where con.contype in ('p', 'f', 'u', 'c') and n.nspname not in {EXCLUDED_SCHEMAS!r}
order by n.nspname, cl.relname, con.contype, con.conname
"""

_INDEXES_SQL = f"""
select schemaname as schema, tablename as table, indexname as name, indexdef as definition
from pg_indexes where schemaname not in {EXCLUDED_SCHEMAS!r}
order by schemaname, tablename, indexname
"""

_ENUM_SQL = """
select n.nspname || '.' || t.typname as name, array_agg(e.enumlabel order by e.enumsortorder) as labels
from pg_type t join pg_enum e on e.enumtypid = t.oid join pg_namespace n on n.oid = t.typnamespace
group by 1
"""

_KIND_NAMES = {"r": "table", "p": "partitioned table", "v": "view", "m": "materialized view", "f": "foreign table"}


def _qualify(schema: str, name: str) -> str:
    return f"{schema}.{name}"


def _ident(name: str) -> str:
    return name if re.fullmatch(r"[a-z_][a-z0-9_]*", name) else '"' + name.replace('"', '""') + '"'


def _display(table_name: str) -> str:
    schema, _, name = table_name.partition(".")
    return f"{_ident(schema)}.{_ident(name)}"


def _fmt_rows(rows: int | None) -> str:
    if rows is None:
        return ""
    if rows >= 1_000_000:
        return f"~{rows / 1_000_000:.1f}M rows"
    if rows >= 1_000:
        return f"~{rows / 1_000:.1f}k rows"
    return f"~{rows} rows"


def render_card(card: dict[str, Any]) -> str:
    """DDL-like text for one table card (what the model reads)."""
    name = card["table_name"]
    kind = card.get("kind") or "table"
    header = f"-- {name} ({kind}"
    rows = _fmt_rows(card.get("row_estimate"))
    header += f", {rows})" if rows else ")"
    if card.get("comment"):
        header += f": {card['comment']}"
    lines = [header, f"CREATE {'VIEW' if 'view' in kind else 'TABLE'} {_display(name)} ("]
    body: list[str] = []
    for col in card["columns"]:
        text = f"  {_ident(col['name'])} {col['type']}"
        if col.get("max_len"):
            text += f"({col['max_len']})"
        if not col.get("nullable", True):
            text += " NOT NULL"
        default = col.get("default")
        if default and "nextval(" not in default and len(default) <= 40:
            text += f" DEFAULT {default}"
        elif default and "nextval(" in default:
            text += " GENERATED (serial)"
        notes = []
        if col.get("comment"):
            notes.append(col["comment"])
        if col.get("values"):
            notes.append("values: " + ", ".join(str(v) for v in col["values"]))
        if notes:
            text += "  -- " + "; ".join(notes)
        body.append(text)
    for con in card.get("constraints") or []:
        if con["type"] in ("p", "u", "f", "c"):
            body.append(f"  {con['definition']}")
    lines.append(",\n".join(body))
    lines.append(");")
    indexes = [i for i in card.get("indexes") or [] if not i.get("is_pkey")]
    if indexes:
        lines.append("-- indexes: " + "; ".join(i["short"] for i in indexes))
    return "\n".join(lines)


def _index_short(definition: str) -> str:
    match = re.search(r"INDEX (\S+) ON \S+ USING (\w+) \((.*)\)(.*)$", definition)
    if not match:
        return definition
    name, method, cols, rest = match.groups()
    unique = "UNIQUE " if definition.startswith("CREATE UNIQUE") else ""
    return f"{unique}{name} {method}({cols}){rest.strip() and ' ' + rest.strip()}"


def _description(card: dict[str, Any]) -> str:
    parts = [card["table_name"].split(".")[-1], card["table_name"].split(".")[0]]
    if card.get("comment"):
        parts.append(card["comment"])
    for col in card["columns"]:
        parts.append(col["name"])
        if col.get("comment"):
            parts.append(col["comment"])
        for value in col.get("values") or []:
            parts.append(str(value))
    for fk in card.get("foreign_keys") or []:
        parts.append(fk["ref_table"].split(".")[-1])
    return " ".join(parts)


@dataclass
class _Catalog:
    tables: dict[str, dict[str, Any]] = field(default_factory=dict)


def build_cards_sync(dsn: str, *, sample_limit: int = 60) -> tuple[list[dict[str, Any]], str]:
    """Read the catalog and return (cards, fingerprint). Sync: run in a thread."""
    with psycopg.connect(dsn, connect_timeout=10, autocommit=True) as conn:
        conn.execute("set statement_timeout = '30s'")
        conn.execute("set default_transaction_read_only = on")
        fp_row = conn.execute(_FINGERPRINT_SQL).fetchone()
        fingerprint = fp_row[0]
        cards: dict[str, dict[str, Any]] = {}
        for schema, name, relkind, rows, comment in conn.execute(_TABLES_SQL):
            cards[_qualify(schema, name)] = {
                "table_name": _qualify(schema, name),
                "kind": _KIND_NAMES.get(relkind, relkind),
                "comment": comment,
                "row_estimate": int(rows) if rows is not None else None,
                "columns": [],
                "constraints": [],
                "foreign_keys": [],
                "indexes": [],
            }
        enums = {name: labels for name, labels in conn.execute(_ENUM_SQL)}
        for schema, table, col, ctype, base_type, nullable, default, max_len, comment in conn.execute(_COLUMNS_SQL):
            card = cards.get(_qualify(schema, table))
            if card is None:
                continue
            column = {
                "name": col,
                "type": ctype,
                "base_type": base_type,
                "nullable": bool(nullable),
                "default": default,
                "max_len": max_len,
                "comment": comment,
            }
            for enum_name, labels in enums.items():
                if enum_name.split(".")[-1] == ctype:
                    column["values"] = list(labels)[:12]
            card["columns"].append(column)
        for schema, table, name, ctype, definition, columns, ref_schema, ref_table, ref_columns in conn.execute(_CONSTRAINTS_SQL):
            card = cards.get(_qualify(schema, table))
            if card is None:
                continue
            card["constraints"].append({"name": name, "type": ctype, "definition": definition, "columns": list(columns or [])})
            if ctype == "f" and ref_table:
                card["foreign_keys"].append(
                    {"columns": list(columns or []), "ref_table": _qualify(ref_schema, ref_table), "ref_columns": list(ref_columns or [])}
                )
        for schema, table, name, definition in conn.execute(_INDEXES_SQL):
            card = cards.get(_qualify(schema, table))
            if card is None:
                continue
            is_pkey = any(c["type"] == "p" and c["name"] == name for c in card["constraints"])
            card["indexes"].append({"name": name, "definition": definition, "short": _index_short(definition), "is_pkey": is_pkey})

        # Sample values for enum-like text columns (bounded work).
        budget = sample_limit
        for card in cards.values():
            if budget <= 0:
                break
            if card["kind"] not in ("table", "partitioned table") or not card["row_estimate"]:
                continue
            for column in card["columns"]:
                if budget <= 0:
                    break
                if column.get("values") or column["base_type"] not in _TEXT_TYPES or not _ENUMISH_NAME.search(column["name"]):
                    continue
                budget -= 1
                try:
                    rows = conn.execute(
                        f"select v, count(*) from (select {_ident(column['name'])} as v from {_display(card['table_name'])} "
                        f"limit 5000) s where v is not null group by v order by 2 desc limit 9"
                    ).fetchall()
                except psycopg.Error:
                    continue
                if 0 < len(rows) <= 8 and all(len(str(v)) <= 40 for v, _ in rows):
                    column["values"] = [v for v, _ in rows]

    out = []
    for card in cards.values():
        card["ddl"] = render_card(card)
        card["description"] = _description(card)
        out.append(card)
    return out, fingerprint


def fingerprint_sync(dsn: str) -> str:
    with psycopg.connect(dsn, connect_timeout=5, autocommit=True) as conn:
        conn.execute("set statement_timeout = '10s'")
        return conn.execute(_FINGERPRINT_SQL).fetchone()[0]


class SchemaIndex:
    def __init__(self, store: AppStore | None, read_dsn: str | None, *, embedding_model: str | None = None) -> None:
        self.store = store
        self.dsn = read_dsn
        self.embedding_model = embedding_model
        self.cards: list[dict[str, Any]] = []
        self.by_name: dict[str, dict[str, Any]] = {}
        self.fingerprint: str | None = None
        self.indexed_at: Any = None
        self.last_error: str | None = None
        self._bm25: BM25 | None = None
        self._lock = asyncio.Lock()

    # ---------- lifecycle ----------

    @property
    def status(self) -> dict[str, Any]:
        return {
            "tables": len(self.cards),
            "fingerprint": self.fingerprint,
            "indexed_at": self.indexed_at.isoformat() if hasattr(self.indexed_at, "isoformat") else self.indexed_at,
            "embeddings": bool(self.cards) and any(c.get("embedding") for c in self.cards),
            "embedding_model": self.embedding_model,
            "error": self.last_error,
        }

    async def load(self) -> None:
        """Load cards from the app DB (fast) without touching the target database."""
        if self.store is None:
            return
        meta = await self.store.get_schema_meta()
        if not meta:
            return
        cards = await self.store.load_schema_cards()
        self._install([dict(c) for c in cards], meta["fingerprint"], meta.get("indexed_at"))

    async def ensure_fresh(self, *, force: bool = False) -> bool:
        """Rebuild when the target schema changed (or on demand). Returns True if rebuilt."""
        if not self.dsn:
            return False
        async with self._lock:
            try:
                current = await asyncio.to_thread(fingerprint_sync, self.dsn)
            except Exception as exc:  # noqa: BLE001 - keep serving the cached index
                self.last_error = f"fingerprint failed: {exc}"
                log.warning("schema fingerprint failed: %s", exc)
                return False
            if not force and self.cards and current == self.fingerprint:
                return False
            try:
                cards, fingerprint = await asyncio.to_thread(build_cards_sync, self.dsn)
            except Exception as exc:  # noqa: BLE001
                self.last_error = f"index build failed: {exc}"
                log.warning("schema index build failed: %s", exc)
                return False
            await self._embed(cards)
            if self.store is not None:
                try:
                    await self.store.replace_schema_index(cards, fingerprint, self.embedding_model if any(c.get("embedding") for c in cards) else None)
                    meta = await self.store.get_schema_meta()
                    self.indexed_at = meta.get("indexed_at") if meta else None
                except Exception as exc:  # noqa: BLE001 - index still usable in memory
                    log.warning("could not persist schema index: %s", exc)
            self._install(cards, fingerprint, self.indexed_at)
            self.last_error = None
            log.info("schema index built: %d tables", len(cards))
            return True

    def _install(self, cards: list[dict[str, Any]], fingerprint: str, indexed_at: Any) -> None:
        self.cards = cards
        self.by_name = {c["table_name"]: c for c in cards}
        self.fingerprint = fingerprint
        self.indexed_at = indexed_at
        self._bm25 = BM25(Document(c["table_name"], c["description"]) for c in cards)

    async def _embed(self, cards: list[dict[str, Any]]) -> None:
        if not self.embedding_model or not cards:
            return
        try:
            import litellm

            texts = [f"{c['table_name']}: {c['description']}"[:4000] for c in cards]
            vectors: list[list[float]] = []
            for start in range(0, len(texts), 64):
                response = await litellm.aembedding(model=self.embedding_model, input=texts[start : start + 64])
                vectors.extend([item["embedding"] for item in response.data])
            for card, vector in zip(cards, vectors):
                card["embedding"] = [float(x) for x in vector]
        except Exception as exc:  # noqa: BLE001 - lexical ranking still works
            log.warning("schema embeddings skipped: %s", exc)

    async def _embed_query(self, text: str) -> list[float] | None:
        if not self.embedding_model or not any(c.get("embedding") for c in self.cards):
            return None
        try:
            import litellm

            response = await litellm.aembedding(model=self.embedding_model, input=[text[:4000]])
            return [float(x) for x in response.data[0]["embedding"]]
        except Exception as exc:  # noqa: BLE001
            log.info("query embedding skipped: %s", exc)
            return None

    # ---------- retrieval ----------

    def _fk_neighbours(self, name: str) -> list[str]:
        card = self.by_name.get(name)
        if not card:
            return []
        out = [fk["ref_table"] for fk in card.get("foreign_keys") or [] if fk["ref_table"] in self.by_name]
        for other in self.cards:
            if any(fk["ref_table"] == name for fk in other.get("foreign_keys") or []) and other["table_name"] != name:
                out.append(other["table_name"])
        return out

    async def rank(self, question: str, *, context: str = "") -> list[tuple[str, float]]:
        """All tables ordered by relevance; explicit mentions first."""
        if not self.cards or self._bm25 is None:
            return []
        text = question if not context else f"{question}\n{context}"
        lexical = [k for k, _ in self._bm25.rank(text)]
        rankings = [lexical]
        vector = await self._embed_query(question)
        if vector:
            sims = [(c["table_name"], cosine(vector, c["embedding"])) for c in self.cards if c.get("embedding")]
            sims.sort(key=lambda item: item[1], reverse=True)
            rankings.append([k for k, s in sims if s > 0.1][: max(20, len(lexical))])
        fused = reciprocal_rank_fusion(rankings)
        mentioned = mentioned_tables(question, self.by_name.keys())
        order: list[tuple[str, float]] = [(name, 10.0) for name in mentioned]
        seen = set(mentioned)
        for name, score in fused:
            if name not in seen:
                order.append((name, score))
                seen.add(name)
        return order

    async def search(self, query: str, limit: int = 8) -> list[dict[str, Any]]:
        ranked = await self.rank(query)
        out = []
        for name, score in ranked[:limit]:
            card = self.by_name[name]
            out.append(
                {
                    "table": name,
                    "kind": card["kind"],
                    "score": round(score, 4),
                    "rows": card.get("row_estimate"),
                    "comment": card.get("comment"),
                    "columns": [c["name"] for c in card["columns"]][:40],
                }
            )
        return out

    async def describe(self, table: str) -> str | None:
        card = self.by_name.get(table)
        if card is None:
            lowered = table.lower()
            matches = [c for n, c in self.by_name.items() if n.lower() == lowered or n.lower().endswith("." + lowered)]
            card = matches[0] if len(matches) == 1 else None
        return card["ddl"] if card else None

    async def context(self, question: str, *, history: str = "", max_tables: int = 12, max_chars: int = 14_000) -> str:
        """The schema block for the system prompt."""
        if not self.cards:
            return "No schema index is available; use the schema tools to explore."
        total = len(self.cards)
        if total <= max_tables:
            selected = [c["table_name"] for c in self.cards]
            intro = f"Database has {total} tables/views. Full definitions:"
        else:
            ranked = await self.rank(question, context=history)
            selected = [name for name, _ in ranked[:max_tables]]
            for name in list(selected):
                for neighbour in self._fk_neighbours(name):
                    if neighbour not in selected and len(selected) < max_tables + max_tables // 2:
                        selected.append(neighbour)
            if not selected:
                selected = [c["table_name"] for c in sorted(self.cards, key=lambda c: -(c.get("row_estimate") or 0))[:max_tables]]
            intro = (
                f"Database has {total} tables/views. The {len(selected)} most relevant to this request are shown in "
                "full; the rest are listed by name. Use schema__search_tables / schema__describe_table for others."
            )
        blocks = [intro]
        used = len(intro)
        shown: list[str] = []
        for name in selected:
            ddl = self.by_name[name]["ddl"]
            if used + len(ddl) > max_chars and shown:
                break
            blocks.append(ddl)
            used += len(ddl) + 2
            shown.append(name)
        rest = [c for c in self.cards if c["table_name"] not in shown]
        if rest:
            names = ", ".join(f"{c['table_name']}" + (f" ({_fmt_rows(c.get('row_estimate'))})" if c.get("row_estimate") else "") for c in rest)
            if len(names) > 3000:
                names = names[:3000] + " ..."
            blocks.append(f"Other tables: {names}")
        return "\n\n".join(blocks)

    def fk_graph(self) -> dict[str, list[str]]:
        graph: dict[str, list[str]] = defaultdict(list)
        for card in self.cards:
            for fk in card.get("foreign_keys") or []:
                graph[card["table_name"]].append(fk["ref_table"])
        return dict(graph)


def fingerprint_of(cards: list[dict[str, Any]]) -> str:
    """Fingerprint of an in-memory card list (used in tests, mirrors the SQL definition loosely)."""
    text = ",".join(f"{c['table_name']}.{col['name']}:{col['type']}" for c in cards for col in c["columns"])
    return hashlib.md5(text.encode()).hexdigest()
