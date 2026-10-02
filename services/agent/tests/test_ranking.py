from agent2db.ranking import BM25, Document, mentioned_tables, reciprocal_rank_fusion, tokenize
from agent2db.schema_index import render_card


def test_tokenize_splits_identifiers_and_singularises():
    assert tokenize("orderItems customer_id Invoices") == ["order", "item", "customer", "id", "invoice"]
    assert tokenize("Show me the top 10 customers by revenue") == ["customer", "revenue"]


def test_bm25_prefers_tables_whose_columns_match_the_question():
    docs = [
        Document("public.orders", "orders public id customer_id status ordered_at total"),
        Document("public.customers", "customers public id email full_name country"),
        Document("public.audit_log", "audit log public id actor action payload"),
    ]
    ranked = BM25(docs).rank("which customers ordered the most")
    assert [k for k, _ in ranked][:2] == ["public.orders", "public.customers"] or [k for k, _ in ranked][:2] == ["public.customers", "public.orders"]
    assert "public.audit_log" not in [k for k, _ in ranked]


def test_mentioned_tables_matches_plural_and_multiword_names():
    names = ["public.orders", "public.order_items", "public.stripe_customers", "sandbox_data.products"]
    assert mentioned_tables("show order items for the biggest order", names) == ["public.orders", "public.order_items"]
    assert mentioned_tables("count stripe customers", names) == ["public.stripe_customers"]
    assert mentioned_tables("what products exist", names) == ["sandbox_data.products"]
    assert mentioned_tables("hello", names) == []


def test_reciprocal_rank_fusion_rewards_agreement():
    fused = reciprocal_rank_fusion([["a", "b", "c"], ["b", "a", "d"]])
    keys = [k for k, _ in fused]
    assert keys[:2] == ["a", "b"] or keys[:2] == ["b", "a"]
    assert keys.index("c") > keys.index("a") and keys.index("d") > keys.index("b")


def test_render_card_produces_ddl_with_keys_values_and_indexes():
    card = {
        "table_name": "public.orders",
        "kind": "table",
        "comment": "One row per checkout",
        "row_estimate": 12500,
        "columns": [
            {"name": "id", "type": "bigint", "nullable": False, "default": "nextval('orders_id_seq'::regclass)"},
            {"name": "status", "type": "text", "nullable": False, "values": ["paid", "refunded"]},
            {"name": "note", "type": "character varying", "nullable": True, "max_len": 80, "comment": "free text"},
        ],
        "constraints": [
            {"name": "orders_pkey", "type": "p", "definition": "PRIMARY KEY (id)"},
            {"name": "orders_customer_fk", "type": "f", "definition": "FOREIGN KEY (customer_id) REFERENCES customers(id)"},
        ],
        "indexes": [
            {"name": "orders_pkey", "definition": "CREATE UNIQUE INDEX orders_pkey ON public.orders USING btree (id)", "short": "x", "is_pkey": True},
            {"name": "orders_status_idx", "definition": "CREATE INDEX orders_status_idx ON public.orders USING btree (status)", "short": "orders_status_idx btree(status)", "is_pkey": False},
        ],
    }
    text = render_card(card)
    assert text.startswith("-- public.orders (table, ~12.5k rows): One row per checkout")
    assert "id bigint NOT NULL GENERATED (serial)" in text
    assert "status text NOT NULL  -- values: paid, refunded" in text
    assert "note character varying(80)  -- free text" in text
    assert "PRIMARY KEY (id)" in text and "FOREIGN KEY (customer_id)" in text
    assert text.rstrip().endswith("-- indexes: orders_status_idx btree(status)")
