from agent2db.impact import describe_estimate
from agent2db.sql_safety import analyze_sql


def test_referenced_tables_are_extracted_without_ctes():
    result = analyze_sql(
        "with recent as (select * from public.orders where ordered_at > now() - interval '1 day') "
        "update customers c set last_seen = now() from recent where recent.customer_id = c.id"
    )
    assert sorted(result.tables) == ["customers", "public.orders"]
    assert result.kinds == {"UPDATE"}


def test_drop_lists_every_table():
    assert analyze_sql("drop table a, sandbox.b").tables == ["a", "sandbox.b"]
    assert analyze_sql("truncate orders").tables == ["orders"]


def test_describe_estimate_lines():
    assert describe_estimate(None) is None
    assert describe_estimate({"kind": "rows", "rows": 1, "relation": "orders"}) == "Planner estimate: ~1 row affected in orders."
    assert describe_estimate({"kind": "rows", "rows": 250, "relation": None}) == "Planner estimate: ~250 rows affected."
    assert describe_estimate({"kind": "table_rows", "tables": {"orders": 1200, "x": None}}) == "Affects all data in: orders (~1200 rows), x."
    assert describe_estimate({"kind": "unavailable", "reason": "boom"}) == "No impact estimate: boom"
