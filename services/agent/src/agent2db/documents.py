"""Document ingestion and retrieval (RAG).

Pipeline: upload -> extract text (PDF, DOCX, Markdown, HTML, plain text) -> heading-aware chunks
with overlap -> store chunks in Postgres (full-text indexed) -> embed in batches -> vectors in
Postgres (`real[]`) or Qdrant when `QDRANT_URL` is set. Search is hybrid: BM25-style full-text
ranking from Postgres fused (reciprocal rank) with cosine similarity over embeddings.

The pure parts (`extract_text`, `chunk_text`, `_mermaid`-free helpers) have no I/O so they are unit
tested; `DocumentService` wires them to the store, the embedding model and the vector index.
"""

from __future__ import annotations

import asyncio
import hashlib
import html
import io
import json
import logging
import re
from dataclasses import dataclass, field
from typing import TYPE_CHECKING, Any

from psycopg.types.json import Jsonb

from agent2db.ranking import cosine, reciprocal_rank_fusion

if TYPE_CHECKING:
    from agent2db.store import AppStore

log = logging.getLogger(__name__)

SCHEMA = "agent2db"
RAG_SETTING = "rag_enabled"

# ---------------------------------------------------------------- text extraction


@dataclass
class Extracted:
    text: str
    kind: str
    pages: int | None = None
    # Character offsets where each page starts (PDF only), for page numbers on chunks.
    page_starts: list[int] = field(default_factory=list)


_HTML_TAG = re.compile(r"<[^>]+>")
_HTML_BLOCK = re.compile(r"</?(p|div|br|li|ul|ol|h[1-6]|tr|table|section|article|blockquote|pre)[^>]*>", re.IGNORECASE)


def kind_of(filename: str, content_type: str | None = None) -> str:
    name = filename.lower()
    if name.endswith(".pdf") or content_type == "application/pdf":
        return "pdf"
    if name.endswith(".docx") or (content_type or "").endswith("wordprocessingml.document"):
        return "docx"
    if name.endswith((".md", ".markdown", ".mdx")):
        return "markdown"
    if name.endswith((".html", ".htm")):
        return "html"
    if name.endswith((".txt", ".csv", ".log", ".json", ".yaml", ".yml", ".sql", ".py", ".ts", ".js", ".rst")):
        return "text"
    if content_type and content_type.startswith("text/"):
        return "markdown" if "markdown" in content_type else "text"
    raise ValueError(f"Unsupported file type: {filename}. Use PDF, DOCX, Markdown, HTML or plain text.")


def extract_text(filename: str, data: bytes, content_type: str | None = None) -> Extracted:
    kind = kind_of(filename, content_type)
    if kind == "pdf":
        from pypdf import PdfReader

        reader = PdfReader(io.BytesIO(data))
        parts: list[str] = []
        starts: list[int] = []
        offset = 0
        for page in reader.pages:
            text = (page.extract_text() or "").strip()
            starts.append(offset)
            parts.append(text)
            offset += len(text) + 2
        return Extracted("\n\n".join(parts), "pdf", pages=len(reader.pages), page_starts=starts)
    if kind == "docx":
        import docx

        document = docx.Document(io.BytesIO(data))
        lines: list[str] = []
        for para in document.paragraphs:
            text = para.text.strip()
            if not text:
                continue
            style = (para.style.name or "").lower() if para.style is not None else ""
            match = re.match(r"heading (\d)", style)
            if match:
                lines.append("#" * min(int(match.group(1)), 6) + " " + text)
            elif style == "title":
                lines.append("# " + text)
            else:
                lines.append(text)
        for table in document.tables:
            for row in table.rows:
                cells = [c.text.strip().replace("\n", " ") for c in row.cells]
                if any(cells):
                    lines.append(" | ".join(cells))
        return Extracted("\n\n".join(lines), "docx")
    text = data.decode("utf-8", errors="replace")
    if kind == "html":
        text = re.sub(r"<(script|style)[^>]*>[\s\S]*?</\1>", " ", text, flags=re.IGNORECASE)
        text = re.sub(r"<h([1-6])[^>]*>", lambda m: "\n\n" + "#" * int(m.group(1)) + " ", text, flags=re.IGNORECASE)
        text = _HTML_BLOCK.sub("\n", text)
        text = html.unescape(_HTML_TAG.sub(" ", text))
        text = re.sub(r"[ \t]+", " ", text)
        text = re.sub(r"\n{3,}", "\n\n", text)
        return Extracted(text.strip(), "html")
    return Extracted(text.replace("\r\n", "\n").replace("\r", "\n"), kind)


# ---------------------------------------------------------------- chunking


@dataclass
class Chunk:
    idx: int
    content: str
    heading: str | None = None
    page: int | None = None

    @property
    def char_count(self) -> int:
        return len(self.content)


_HEADING = re.compile(r"^(#{1,6})\s+(.*\S)\s*$")


def _split_paragraphs(text: str) -> list[str]:
    return [p.strip() for p in re.split(r"\n\s*\n", text) if p.strip()]


def _split_long(paragraph: str, max_chars: int) -> list[str]:
    """Split one oversized paragraph at sentence boundaries, then hard-wrap if still too long."""
    if len(paragraph) <= max_chars:
        return [paragraph]
    sentences = re.split(r"(?<=[.!?])\s+", paragraph)
    out: list[str] = []
    current = ""
    for sentence in sentences:
        while len(sentence) > max_chars:
            out.append(sentence[:max_chars])
            sentence = sentence[max_chars:]
        if current and len(current) + 1 + len(sentence) > max_chars:
            out.append(current)
            current = sentence
        else:
            current = f"{current} {sentence}".strip()
    if current:
        out.append(current)
    return out


def chunk_text(extracted: Extracted | str, *, max_chars: int = 1200, overlap: int = 150, min_chars: int = 200) -> list[Chunk]:
    """Heading-aware chunking: Markdown headings open a new section and are prefixed to its chunks.

    Paragraphs are packed into chunks up to `max_chars`; the tail of the previous chunk is carried
    over as `overlap` so sentences cut at a boundary remain findable. Tiny trailing chunks are
    merged into the previous one.
    """
    if isinstance(extracted, str):
        extracted = Extracted(extracted, "text")
    text = extracted.text
    sections: list[tuple[str | None, str]] = []
    heading_path: list[tuple[int, str]] = []
    buffer: list[str] = []
    current_heading: str | None = None
    for line in text.split("\n"):
        match = _HEADING.match(line)
        if match and extracted.kind in ("markdown", "docx", "html"):
            if buffer:
                sections.append((current_heading, "\n".join(buffer)))
                buffer = []
            level, title = len(match.group(1)), match.group(2).strip()
            heading_path = [(lv, t) for lv, t in heading_path if lv < level] + [(level, title)]
            current_heading = " > ".join(t for _, t in heading_path)
            continue
        buffer.append(line)
    if buffer:
        sections.append((current_heading, "\n".join(buffer)))

    chunks: list[Chunk] = []
    carry = ""
    for heading, body in sections:
        pieces: list[str] = []
        for paragraph in _split_paragraphs(body):
            pieces.extend(_split_long(paragraph, max_chars))
        current = carry
        for piece in pieces:
            if current and len(current) + 2 + len(piece) > max_chars:
                chunks.append(Chunk(len(chunks), current.strip(), heading))
                current = (current[-overlap:].strip() + "\n\n" if overlap else "") + piece
            else:
                current = f"{current}\n\n{piece}".strip() if current else piece
        if current.strip():
            chunks.append(Chunk(len(chunks), current.strip(), heading))
        carry = ""
    # Merge tiny trailing chunks into their predecessor (same heading).
    merged: list[Chunk] = []
    for chunk in chunks:
        if merged and chunk.char_count < min_chars and merged[-1].heading == chunk.heading and merged[-1].char_count + chunk.char_count <= max_chars + min_chars:
            merged[-1] = Chunk(merged[-1].idx, merged[-1].content + "\n\n" + chunk.content, chunk.heading)
        else:
            merged.append(Chunk(len(merged), chunk.content, chunk.heading))
    if extracted.page_starts:
        starts = extracted.page_starts
        offset = 0
        for chunk in merged:
            position = text.find(chunk.content[:80], offset)
            if position >= 0:
                offset = position
            page = sum(1 for s in starts if s <= max(position, 0))
            chunk.page = max(page, 1)
    return merged


# ---------------------------------------------------------------- embeddings


async def embed_texts(model: str, texts: list[str], batch: int = 64) -> list[list[float]]:
    import litellm

    vectors: list[list[float]] = []
    for start in range(0, len(texts), batch):
        response = await litellm.aembedding(model=model, input=[t[:6000] for t in texts[start : start + batch]])
        vectors.extend([[float(x) for x in item["embedding"]] for item in response.data])
    return vectors


# ---------------------------------------------------------------- vector indexes


class PostgresVectorIndex:
    """Embeddings in `chunks.embedding`; cosine computed in Python over an in-memory cache."""

    def __init__(self, store: AppStore) -> None:
        self.store = store
        self._cache: list[tuple[int, list[float]]] | None = None
        self.name = "postgres"

    async def upsert(self, items: list[tuple[int, list[float]]]) -> None:
        def fn(conn):
            with conn.cursor() as cur:
                cur.executemany(f"update {SCHEMA}.chunks set embedding = %s where id = %s", [(vec, cid) for cid, vec in items])

        await self.store._run(fn)
        self._cache = None

    async def delete_document(self, document_id: int) -> None:  # rows cascade; just drop the cache
        self._cache = None

    async def search(self, vector: list[float], limit: int) -> list[tuple[int, float]]:
        if self._cache is None:

            def fn(conn):
                return [(r["id"], r["embedding"]) for r in conn.execute(f"select id, embedding from {SCHEMA}.chunks where embedding is not null")]

            self._cache = await self.store._run(fn)
        scored = [(cid, cosine(vector, emb)) for cid, emb in self._cache]
        scored.sort(key=lambda item: item[1], reverse=True)
        return scored[:limit]


class QdrantVectorIndex:
    """Vectors in a Qdrant collection (set QDRANT_URL, optional QDRANT_API_KEY)."""

    def __init__(self, url: str, api_key: str | None, collection: str = "agent2db_chunks") -> None:
        from qdrant_client import AsyncQdrantClient

        self.client = AsyncQdrantClient(url=url, api_key=api_key)
        self.collection = collection
        self.name = f"qdrant ({url})"
        self._ready = False

    async def _ensure(self, dim: int) -> None:
        if self._ready:
            return
        from qdrant_client.models import Distance, VectorParams

        if not await self.client.collection_exists(self.collection):
            await self.client.create_collection(self.collection, vectors_config=VectorParams(size=dim, distance=Distance.COSINE))
        self._ready = True

    async def upsert(self, items: list[tuple[int, list[float]]]) -> None:
        if not items:
            return
        from qdrant_client.models import PointStruct

        await self._ensure(len(items[0][1]))
        await self.client.upsert(self.collection, points=[PointStruct(id=cid, vector=vec, payload={"chunk_id": cid}) for cid, vec in items])

    async def delete_document(self, document_id: int) -> None:
        return None  # chunk ids are deleted via delete_points when the document's chunk ids are known

    async def delete_points(self, chunk_ids: list[int]) -> None:
        if chunk_ids and self._ready or chunk_ids:
            try:
                await self.client.delete(self.collection, points_selector=chunk_ids)
            except Exception as exc:  # noqa: BLE001
                log.info("qdrant delete skipped: %s", exc)

    async def search(self, vector: list[float], limit: int) -> list[tuple[int, float]]:
        try:
            result = await self.client.query_points(self.collection, query=vector, limit=limit)
        except Exception as exc:  # noqa: BLE001 - collection may not exist yet
            log.info("qdrant search failed: %s", exc)
            return []
        return [(int(p.id), float(p.score)) for p in result.points]


# ---------------------------------------------------------------- service


class DocumentService:
    def __init__(self, store: AppStore, embedding_model: str | None, *, qdrant_url: str | None = None, qdrant_api_key: str | None = None) -> None:
        self.store = store
        self.embedding_model = embedding_model
        self.index: PostgresVectorIndex | QdrantVectorIndex
        if qdrant_url:
            try:
                self.index = QdrantVectorIndex(qdrant_url, qdrant_api_key)
            except Exception as exc:  # noqa: BLE001
                log.warning("Qdrant client unavailable (%s); using Postgres vectors", exc)
                self.index = PostgresVectorIndex(store)
        else:
            self.index = PostgresVectorIndex(store)
        self._tasks: set[asyncio.Task] = set()

    # ---------- settings ----------

    async def rag_enabled(self) -> bool:
        def fn(conn):
            row = conn.execute(f"select value from {SCHEMA}.settings where key = %s", (RAG_SETTING,)).fetchone()
            return bool(row["value"]) if row else False

        return await self.store._run(fn)

    async def set_rag_enabled(self, enabled: bool) -> None:
        def fn(conn):
            conn.execute(
                f"insert into {SCHEMA}.settings (key, value) values (%s, %s) on conflict (key) do update set value = excluded.value, updated_at = now()",
                (RAG_SETTING, Jsonb(bool(enabled))),
            )

        await self.store._run(fn)

    # ---------- documents ----------

    async def list_documents(self) -> list[dict[str, Any]]:
        def fn(conn):
            return [dict(r) for r in conn.execute(f"select * from {SCHEMA}.documents order by created_at desc")]

        return await self.store._run(fn)

    async def get_document(self, document_id: int) -> dict[str, Any] | None:
        def fn(conn):
            row = conn.execute(f"select * from {SCHEMA}.documents where id = %s", (document_id,)).fetchone()
            return dict(row) if row else None

        return await self.store._run(fn)

    async def list_chunks(self, document_id: int, limit: int = 200) -> list[dict[str, Any]]:
        def fn(conn):
            return [
                dict(r)
                for r in conn.execute(
                    f"select id, idx, heading, page, content, char_count, embedding is not null as embedded from {SCHEMA}.chunks where document_id = %s order by idx limit %s",
                    (document_id, limit),
                )
            ]

        return await self.store._run(fn)

    async def delete_document(self, document_id: int) -> bool:
        def fn(conn):
            ids = [r["id"] for r in conn.execute(f"select id from {SCHEMA}.chunks where document_id = %s", (document_id,))]
            deleted = conn.execute(f"delete from {SCHEMA}.documents where id = %s", (document_id,)).rowcount > 0
            return deleted, ids

        deleted, ids = await self.store._run(fn)
        if isinstance(self.index, QdrantVectorIndex):
            await self.index.delete_points(ids)
        else:
            await self.index.delete_document(document_id)
        return deleted

    async def add_document(self, filename: str, data: bytes, content_type: str | None = None, tags: list[str] | None = None) -> dict[str, Any]:
        """Register the upload and start ingestion in the background. Returns the document row."""
        kind = kind_of(filename, content_type)
        sha = hashlib.sha256(data).hexdigest()

        def fn(conn):
            existing = conn.execute(f"select * from {SCHEMA}.documents where sha256 = %s", (sha,)).fetchone()
            if existing:
                return dict(existing), False
            row = conn.execute(
                f"insert into {SCHEMA}.documents (name, kind, size_bytes, sha256, tags, embedding_model) values (%s, %s, %s, %s, %s, %s) returning *",
                (filename, kind, len(data), sha, tags or [], self.embedding_model),
            ).fetchone()
            return dict(row), True

        row, created = await self.store._run(fn)
        if created or row["status"] in ("failed", "pending"):
            task = asyncio.create_task(self._ingest(row["id"], filename, data, content_type))
            self._tasks.add(task)
            task.add_done_callback(self._tasks.discard)
        return row

    async def _set_status(self, document_id: int, status: str, **fields: Any) -> None:
        def fn(conn):
            sets = ", ".join(f"{k} = %s" for k in fields)
            conn.execute(
                f"update {SCHEMA}.documents set status = %s, updated_at = now(){', ' + sets if sets else ''} where id = %s",
                (status, *fields.values(), document_id),
            )

        await self.store._run(fn)

    async def _ingest(self, document_id: int, filename: str, data: bytes, content_type: str | None) -> None:
        try:
            await self._set_status(document_id, "processing", error=None)
            extracted = await asyncio.to_thread(extract_text, filename, data, content_type)
            if not extracted.text.strip():
                raise ValueError("No text could be extracted from this file (scanned PDF? try OCR first).")
            chunks = chunk_text(extracted)

            def insert(conn):
                conn.execute(f"delete from {SCHEMA}.chunks where document_id = %s", (document_id,))
                with conn.cursor() as cur:
                    cur.executemany(
                        f"insert into {SCHEMA}.chunks (document_id, idx, heading, page, content, char_count) values (%s, %s, %s, %s, %s, %s)",
                        [(document_id, c.idx, c.heading, c.page, c.content, c.char_count) for c in chunks],
                    )
                return [r["id"] for r in conn.execute(f"select id from {SCHEMA}.chunks where document_id = %s order by idx", (document_id,))]

            ids = await self.store._run(insert)
            await self._set_status(document_id, "processing", chunk_count=len(chunks), char_count=len(extracted.text), pages=extracted.pages)
            if self.embedding_model and chunks:
                vectors = await embed_texts(self.embedding_model, [f"{c.heading}\n{c.content}" if c.heading else c.content for c in chunks])
                await self.index.upsert(list(zip(ids, vectors)))
            await self._set_status(document_id, "ready", embedding_model=self.embedding_model if self.embedding_model else None)
            log.info("ingested document %s: %d chunks", document_id, len(chunks))
        except Exception as exc:  # noqa: BLE001 - surface the failure on the document row
            log.exception("ingestion failed for document %s", document_id)
            await self._set_status(document_id, "failed", error=str(exc)[:500])

    # ---------- search ----------

    async def _lexical(self, query: str, limit: int) -> list[dict[str, Any]]:
        """Full-text ranking: all terms first (websearch syntax), then any term, so a question with
        one unknown word still finds the passages about the other words."""
        words = re.findall(r"[A-Za-z0-9]{2,}", query)
        any_terms = " | ".join(dict.fromkeys(w.lower() for w in words)) or query

        def fn(conn):
            sql = f"""select c.id, c.document_id, c.idx, c.heading, c.page, c.content, d.name as document, ts_rank(c.search, q) as rank
                      from {SCHEMA}.chunks c join {SCHEMA}.documents d on d.id = c.document_id, {{q}} q
                      where c.search @@ q and d.status = 'ready' order by rank desc limit %s"""
            rows = conn.execute(sql.format(q="websearch_to_tsquery('english', %s)"), (query, limit)).fetchall()
            if not rows:
                rows = conn.execute(sql.format(q="to_tsquery('english', %s)"), (any_terms, limit)).fetchall()
            return [dict(r) for r in rows]

        return await self.store._run(fn)

    async def _by_ids(self, ids: list[int]) -> dict[int, dict[str, Any]]:
        if not ids:
            return {}

        def fn(conn):
            rows = conn.execute(
                f"""select c.id, c.document_id, c.idx, c.heading, c.page, c.content, d.name as document
                    from {SCHEMA}.chunks c join {SCHEMA}.documents d on d.id = c.document_id where c.id = any(%s) and d.status = 'ready'""",
                (ids,),
            ).fetchall()
            return {r["id"]: dict(r) for r in rows}

        return await self.store._run(fn)

    async def search(self, query: str, limit: int = 6) -> list[dict[str, Any]]:
        """Hybrid search; each hit has document, heading, page, content and a fused score."""
        lexical = await self._lexical(query, limit * 3)
        rankings = [[r["id"] for r in lexical]]
        vector_hits: list[tuple[int, float]] = []
        if self.embedding_model:
            try:
                [vector] = await embed_texts(self.embedding_model, [query])
                vector_hits = await self.index.search(vector, limit * 3)
                rankings.append([cid for cid, score in vector_hits if score > 0.1])
            except Exception as exc:  # noqa: BLE001 - lexical results still work
                log.info("vector search skipped: %s", exc)
        fused = reciprocal_rank_fusion(rankings)
        wanted = [cid for cid, _ in fused[:limit]]
        rows = {r["id"]: r for r in lexical}
        missing = [cid for cid in wanted if cid not in rows]
        rows.update(await self._by_ids(missing))
        sims = dict(vector_hits)
        out = []
        for cid, score in fused[:limit]:
            row = rows.get(cid)
            if row:
                out.append({**row, "score": round(score, 4), "similarity": round(sims.get(cid, 0.0), 4)})
        return out

    async def context(self, question: str, *, limit: int = 5, max_chars: int = 6000) -> str:
        hits = await self.search(question, limit=limit)
        if not hits:
            return ""
        blocks = []
        used = 0
        for hit in hits:
            where = hit["document"] + (f" › {hit['heading']}" if hit.get("heading") else "") + (f" (p. {hit['page']})" if hit.get("page") else "")
            text = hit["content"]
            if used + len(text) > max_chars:
                text = text[: max(0, max_chars - used)]
            if not text:
                break
            blocks.append(f"[{where}]\n{text}")
            used += len(text)
        return "\n\n".join(blocks)

    async def stats(self) -> dict[str, Any]:
        def fn(conn):
            row = conn.execute(
                f"""select count(*) as documents, count(*) filter (where status = 'ready') as ready,
                           coalesce(sum(chunk_count), 0) as chunks from {SCHEMA}.documents"""
            ).fetchone()
            return dict(row)

        data = await self.store._run(fn)
        data.update({"vector_index": self.index.name, "embedding_model": self.embedding_model, "rag_enabled": await self.rag_enabled()})
        return data


def json_safe(value: Any) -> Any:
    return json.loads(json.dumps(value, default=str))
