"""Ingestion, hybrid search and the DB viewer against the dev Postgres (skipped without DATABASE_URL)."""

import asyncio
import os

import pytest

from agent2db.config import load_env
from agent2db.dbviewer import run_query, table_rows
from agent2db.documents import DocumentService
from agent2db.store import AppStore

load_env()
DSN = os.environ.get("AGENT2DB_TEST_DSN") or os.environ.get("DATABASE_URL")
pytestmark = pytest.mark.skipif(not DSN, reason="DATABASE_URL not set")

DOC = b"""# Refund policy

Customers may request a refund within 30 days of purchase. Refunds are issued to the original payment method.

## Exceptions

Final-sale accessories are not refundable. Enterprise contracts follow their own terms.

# Shipping

Orders ship within two business days.
"""


@pytest.fixture
async def store():
    s = AppStore(DSN, max_size=2)
    await s.open()
    yield s
    await s.close()


async def test_ingest_search_and_rag_toggle_without_embeddings(store):
    service = DocumentService(store, embedding_model=None)
    row = await service.add_document("policy-test.md", DOC)
    try:
        for _ in range(50):
            doc = await service.get_document(row["id"])
            if doc["status"] in ("ready", "failed"):
                break
            await asyncio.sleep(0.1)
        assert doc["status"] == "ready", doc.get("error")
        assert doc["chunk_count"] >= 2 and doc["kind"] == "markdown"
        chunks = await service.list_chunks(row["id"])
        assert any(c["heading"] == "Refund policy > Exceptions" for c in chunks)

        hits = await service.search("are accessories refundable", limit=3)
        assert hits and hits[0]["document"] == "policy-test.md"
        assert any("Final-sale accessories" in h["content"] for h in hits)

        context = await service.context("refund window")
        assert "policy-test.md" in context and "30 days" in context

        await service.set_rag_enabled(True)
        assert await service.rag_enabled() is True
        await service.set_rag_enabled(False)
        assert await service.rag_enabled() is False

        # Re-uploading the same bytes is a no-op (same sha).
        again = await service.add_document("policy-test.md", DOC)
        assert again["id"] == row["id"]
    finally:
        assert await service.delete_document(row["id"])
        assert await service.get_document(row["id"]) is None


async def test_viewer_rows_and_read_only_queries():
    page = await table_rows(DSN, "sandbox_data.customers", limit=5, offset=5, order_by="id")
    assert page["columns"][:2] == ["id", "email"] and len(page["rows"]) == 5 and page["rows"][0][0] == 6
    assert page["total"] == 120
    filtered = await table_rows(DSN, "sandbox_data.customers", limit=5, where="segment = 'enterprise'")
    assert filtered["total"] == 13
    with pytest.raises(ValueError):
        await table_rows(DSN, "sandbox_data.customers; drop table x", limit=5)

    ok = await run_query(DSN, "select count(*) as n from sandbox_data.orders")
    assert ok["columns"] == ["n"] and ok["rows"][0][0] == 1500 and "error" not in ok
    blocked = await run_query(DSN, "delete from sandbox_data.orders")
    assert "Only read-only" in blocked["error"]
    bad = await run_query(DSN, "select * from nope_table")
    assert "nope_table" in bad["error"]
    capped = await run_query(DSN, "select * from sandbox_data.order_items", max_rows=10)
    assert capped["truncated"] and capped["row_count"] == 10
