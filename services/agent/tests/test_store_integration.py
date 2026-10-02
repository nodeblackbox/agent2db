"""Integration tests against the dev Postgres (skipped when DATABASE_URL is not set).

They use the real app schema in `agent2db` and the real catalog, but only touch rows they create.
"""

import os
import uuid

import pytest

from agent2db.config import load_env
from agent2db.impact import estimate_impact
from agent2db.schema_index import SchemaIndex, build_cards_sync
from agent2db.sql_safety import analyze_sql
from agent2db.store import AppStore

load_env()
DSN = os.environ.get("AGENT2DB_TEST_DSN") or os.environ.get("DATABASE_URL")
pytestmark = pytest.mark.skipif(not DSN, reason="DATABASE_URL not set")


@pytest.fixture
async def store():
    s = AppStore(DSN, max_size=2)
    await s.open()
    yield s
    await s.close()


async def test_migrations_apply_and_runs_persist(store):
    session = "test-" + uuid.uuid4().hex[:8]
    run_id = uuid.uuid4().hex
    await store.ensure_session(session, "how many orders?", "test/model")
    await store.create_run(run_id, session, "how many orders?", "test/model")
    await store.append_event(run_id, 1, "step", {"node": "agent"})
    await store.append_event(run_id, 2, "done", {"status": "completed"})
    await store.finish_run(run_id, "completed", answer="42", usage={"tokens_in": 10, "tokens_out": 2, "cost_usd": 0.001}, steps=1)
    row = await store.get_run(run_id)
    assert row["status"] == "completed" and row["answer"] == "42" and row["tokens_in"] == 10 and row["ended_at"]
    events = await store.list_run_events(run_id, after=1)
    assert events == [(2, "done", {"status": "completed"})]
    sessions = await store.list_sessions()
    assert any(s["id"] == session and s["run_count"] == 1 for s in sessions)
    assert await store.delete_session(session)
    assert await store.get_run(run_id) is None


async def test_saved_queries_and_facts_are_searchable(store):
    name = "test_revenue_" + uuid.uuid4().hex[:6]
    saved = await store.save_query(name, "select sum(total) from orders", "Monthly revenue by customer", ["orders"], ["kpi"])
    try:
        hits = await store.search_saved_queries("revenue customers")
        assert any(h["id"] == saved["id"] for h in hits)
        hits = await store.search_saved_queries(name)  # ILIKE fallback for names that are not English words
        assert any(h["id"] == saved["id"] for h in hits)
    finally:
        assert await store.delete_saved_query(saved["id"])

    fact = await store.add_fact("orders.status = 3 means refunded", "public.orders.status", ["codes"])
    try:
        hits = await store.search_facts("what does refunded status mean")
        assert any(h["id"] == fact["id"] for h in hits)
    finally:
        assert await store.delete_fact(fact["id"])


async def test_approvals_are_recorded(store):
    session = "test-" + uuid.uuid4().hex[:8]
    run_id = uuid.uuid4().hex
    await store.ensure_session(session, "x", None)
    await store.create_run(run_id, session, "x", None)
    payload = {"tool_call_id": "c1", "name": "postgres-write__execute_sql", "sql": "delete from t", "statement_types": ["DELETE"], "warnings": ["w"], "estimate": {"kind": "rows", "rows": 3}}
    await store.record_approval_request(run_id, payload)
    await store.record_approval_decision(run_id, "c1", "reject", "no")
    row = next(a for a in await store.list_approvals() if a["run_id"] == run_id)
    assert row["decision"] == "reject" and row["feedback"] == "no" and row["estimate"] == {"kind": "rows", "rows": 3}
    await store.delete_session(session)


async def test_schema_index_builds_from_catalog_and_excludes_app_schema(store):
    cards, fingerprint = build_cards_sync(DSN)
    assert fingerprint and cards
    names = {c["table_name"] for c in cards}
    assert not any(n.startswith("agent2db.") for n in names)
    for card in cards:
        assert card["ddl"].startswith("-- " + card["table_name"])
        assert card["columns"]

    index = SchemaIndex(store, DSN, embedding_model=None)
    assert await index.ensure_fresh(force=True)
    assert len(index.cards) == len(cards)
    assert not await index.ensure_fresh()  # unchanged fingerprint -> no rebuild
    meta = await store.get_schema_meta()
    assert meta["fingerprint"] == fingerprint and meta["table_count"] == len(cards)

    fresh = SchemaIndex(store, DSN)
    await fresh.load()
    assert fresh.fingerprint == fingerprint and fresh.by_name.keys() == index.by_name.keys()

    first = cards[0]["table_name"]
    ddl = await fresh.describe(first.split(".")[-1])
    assert ddl is not None and ddl.startswith("-- " + first)
    context = await fresh.context("anything", max_tables=2, max_chars=4000)
    assert "CREATE" in context


async def test_estimate_impact_uses_explain_in_a_read_only_transaction():
    cards, _ = build_cards_sync(DSN)
    table = next((c for c in cards if c["kind"] == "table"), None)
    if table is None:
        pytest.skip("no tables to explain against")
    sql = f"delete from {table['table_name']}"
    estimate = await estimate_impact(DSN, sql, analyze_sql(sql))
    assert estimate is not None and estimate["kind"] == "rows" and estimate["rows"] is not None
    drop = f"drop table {table['table_name']}"
    estimate = await estimate_impact(DSN, drop, analyze_sql(drop))
    assert estimate == {"kind": "table_rows", "tables": {table["table_name"]: table["row_estimate"] or 0}} or estimate["kind"] == "table_rows"


async def test_restart_recovery_only_claims_runs_whose_backend_is_gone(store):
    """Two backends share one app DB: a live backend's runs must not be marked failed by the other."""
    from agent2db.runs import RunManager

    live, dead = "live-" + uuid.uuid4().hex[:6], "dead-" + uuid.uuid4().hex[:6]
    await store.register_backend(live, "test")
    session = "test-" + uuid.uuid4().hex[:8]
    await store.ensure_session(session, "x", None)
    owned_by_live, owned_by_dead, unowned = (uuid.uuid4().hex for _ in range(3))
    await store.create_run(owned_by_live, session, "a", None, backend_id=live)
    await store.create_run(owned_by_dead, session, "b", None, backend_id=dead)  # never registered -> gone
    await store.create_run(unowned, session, "c", None)  # pre-ownership row

    orphans = {r["id"] for r in await store.orphaned_runs(stale_after_seconds=60)}
    assert owned_by_dead in orphans and unowned in orphans and owned_by_live not in orphans

    class NoGraph:
        async def aget_state(self, config):
            raise AssertionError("not needed for running rows")

    manager = RunManager(NoGraph(), store, backend_id="new-" + uuid.uuid4().hex[:6])
    await manager.restore()
    assert (await store.get_run(owned_by_live))["status"] == "running"
    assert (await store.get_run(owned_by_dead))["status"] == "failed"
    assert (await store.get_run(owned_by_dead))["backend_id"] == manager.backend_id
    assert (await store.get_run(unowned))["status"] == "failed"

    # The live backend finishing its run clears any stale error and keeps ownership.
    await store.finish_run(owned_by_live, "completed", answer="done")
    row = await store.get_run(owned_by_live)
    assert row["status"] == "completed" and row["error"] is None and row["backend_id"] == live
    await store.delete_session(session)
