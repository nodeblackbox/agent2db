import pytest

from agent2db.dbviewer import mermaid_erd, qualified

CARDS = [
    {
        "table_name": "public.customers",
        "columns": [{"name": "id", "type": "bigint"}, {"name": "email", "type": "character varying", "comment": 'Login "email"'}],
        "constraints": [{"type": "p", "columns": ["id"]}, {"type": "u", "columns": ["email"]}],
        "foreign_keys": [],
    },
    {
        "table_name": "public.orders",
        "columns": [{"name": "id", "type": "bigint"}, {"name": "customer_id", "type": "bigint"}, {"name": "status", "type": "text", "values": ["paid", "refunded"]}, {"name": "ordered_at", "type": "timestamp with time zone"}],
        "constraints": [{"type": "p", "columns": ["id"]}],
        "foreign_keys": [{"columns": ["customer_id"], "ref_table": "public.customers", "ref_columns": ["id"]}],
    },
]


def test_mermaid_erd_single_schema_drops_prefix_and_marks_keys():
    text = mermaid_erd(CARDS)
    assert text.startswith("erDiagram\n")
    assert "    customers {" in text and "    orders {" in text
    assert "        bigint id PK" in text
    assert "        varchar email UK \"Login 'email'\"" in text
    assert "        bigint customer_id FK" in text
    assert '        text status "values: paid, refunded"' in text
    assert "        timestamptz ordered_at" in text
    assert '    customers ||--o{ orders : "customer_id"' in text


def test_mermaid_erd_multi_schema_prefixes_and_filters():
    cards = CARDS + [{"table_name": "sales.invoices", "columns": [{"name": "id", "type": "int"}], "constraints": [], "foreign_keys": [{"columns": ["order_id"], "ref_table": "public.orders"}]}]
    text = mermaid_erd(cards)
    assert "    public_orders {" in text and "    sales_invoices {" in text
    assert '    public_orders ||--o{ sales_invoices : "order_id"' in text
    only = mermaid_erd(cards, tables=["public.orders"])
    assert "customers" not in only.replace("customer_id", "") and "orders {" in only


def test_qualified_rejects_injection():
    assert qualified("public.orders") == '"public"."orders"'
    for bad in ["orders", "public.orders; drop table x", 'a."b"', "public.or-ders"]:
        with pytest.raises(ValueError):
            qualified(bad)
