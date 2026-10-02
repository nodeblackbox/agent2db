"""Seed a small, deterministic sample dataset for development and evaluation (`agent2db-seed-sample`).

Creates schema `sandbox_data` with customers, products, orders and order_items (plus comments and
an enum-like status column) so questions like "top 10 customers by revenue last month" have a
known answer. Safe to re-run: the schema is dropped and recreated.
"""

from __future__ import annotations

import argparse
import os
import random
import sys
from datetime import date, timedelta

import psycopg

from agent2db.config import load_env

SCHEMA = "sandbox_data"

DDL = f"""
drop schema if exists {SCHEMA} cascade;
create schema {SCHEMA};

create table {SCHEMA}.customers (
    id          bigserial primary key,
    email       text not null unique,
    full_name   text not null,
    country     text not null,
    segment     text not null check (segment in ('consumer', 'smb', 'enterprise')),
    created_at  timestamptz not null
);
comment on table {SCHEMA}.customers is 'People and companies who place orders';
comment on column {SCHEMA}.customers.segment is 'consumer = individual, smb = small business, enterprise = large account';

create table {SCHEMA}.products (
    id          bigserial primary key,
    sku         text not null unique,
    name        text not null,
    category    text not null,
    unit_price  numeric(10,2) not null,
    active      boolean not null default true
);
comment on table {SCHEMA}.products is 'Catalog of sellable items';

create table {SCHEMA}.orders (
    id          bigserial primary key,
    customer_id bigint not null references {SCHEMA}.customers(id),
    status      text not null check (status in ('pending', 'paid', 'shipped', 'refunded', 'cancelled')),
    ordered_at  timestamptz not null,
    currency    text not null default 'USD'
);
comment on table {SCHEMA}.orders is 'One row per checkout; revenue counts only paid and shipped orders';
create index orders_customer_idx on {SCHEMA}.orders (customer_id);
create index orders_ordered_at_idx on {SCHEMA}.orders (ordered_at);

create table {SCHEMA}.order_items (
    id          bigserial primary key,
    order_id    bigint not null references {SCHEMA}.orders(id) on delete cascade,
    product_id  bigint not null references {SCHEMA}.products(id),
    quantity    integer not null check (quantity > 0),
    unit_price  numeric(10,2) not null
);
create index order_items_order_idx on {SCHEMA}.order_items (order_id);
"""

FIRST = ["Ada", "Grace", "Linus", "Margaret", "Alan", "Barbara", "Dennis", "Ken", "Radia", "Tim", "Hedy", "Guido", "Yukihiro", "Anders", "Bjarne", "Brendan"]
LAST = ["Lovelace", "Hopper", "Torvalds", "Hamilton", "Turing", "Liskov", "Ritchie", "Thompson", "Perlman", "Berners-Lee", "Lamarr", "van Rossum", "Matsumoto", "Hejlsberg", "Stroustrup", "Eich"]
COUNTRIES = ["US", "US", "US", "GB", "DE", "FR", "CA", "AU", "JP", "BR"]
CATEGORIES = {"hardware": (49, 899), "software": (9, 299), "accessories": (5, 79), "services": (99, 2499)}


def seed(dsn: str, *, customers: int = 120, products: int = 40, orders: int = 1500, seed_value: int = 42, today: date | None = None) -> dict[str, int]:
    rng = random.Random(seed_value)
    today = today or date.today()
    with psycopg.connect(dsn, autocommit=False) as conn:
        conn.execute(DDL)
        with conn.cursor() as cur:
            customer_rows = []
            for i in range(customers):
                first, last = rng.choice(FIRST), rng.choice(LAST)
                customer_rows.append(
                    (
                        f"{first.lower()}.{last.lower().replace(' ', '')}{i}@example.com",
                        f"{first} {last}",
                        rng.choice(COUNTRIES),
                        rng.choices(["consumer", "smb", "enterprise"], weights=[6, 3, 1])[0],
                        today - timedelta(days=rng.randint(30, 900)),
                    )
                )
            cur.executemany(
                f"insert into {SCHEMA}.customers (email, full_name, country, segment, created_at) values (%s, %s, %s, %s, %s)",
                customer_rows,
            )
            product_rows = []
            for i in range(products):
                category = rng.choice(list(CATEGORIES))
                low, high = CATEGORIES[category]
                product_rows.append((f"SKU-{i + 1:04d}", f"{category.title()} item {i + 1}", category, round(rng.uniform(low, high), 2), rng.random() > 0.1))
            cur.executemany(
                f"insert into {SCHEMA}.products (sku, name, category, unit_price, active) values (%s, %s, %s, %s, %s)", product_rows
            )
            prices = {i + 1: p[3] for i, p in enumerate(product_rows)}
            order_rows = []
            for _ in range(orders):
                customer = rng.randint(1, customers)
                days_ago = int(rng.expovariate(1 / 120))
                ordered_at = today - timedelta(days=min(days_ago, 720), hours=rng.randint(0, 23))
                status = rng.choices(["pending", "paid", "shipped", "refunded", "cancelled"], weights=[5, 40, 40, 8, 7])[0]
                order_rows.append((customer, status, ordered_at))
            cur.executemany(f"insert into {SCHEMA}.orders (customer_id, status, ordered_at) values (%s, %s, %s)", order_rows)
            item_rows = []
            for order_id in range(1, orders + 1):
                for product_id in rng.sample(range(1, products + 1), rng.randint(1, 4)):
                    item_rows.append((order_id, product_id, rng.randint(1, 5), prices[product_id]))
            cur.executemany(
                f"insert into {SCHEMA}.order_items (order_id, product_id, quantity, unit_price) values (%s, %s, %s, %s)", item_rows
            )
        conn.execute(f"analyze {SCHEMA}.customers; analyze {SCHEMA}.products; analyze {SCHEMA}.orders; analyze {SCHEMA}.order_items")
        conn.commit()
    return {"customers": customers, "products": products, "orders": orders, "order_items": len(item_rows)}


def main() -> None:
    parser = argparse.ArgumentParser(description="Seed the sandbox_data sample schema.")
    parser.add_argument("--dsn", help="DSN (default: DATABASE_URL from .env)")
    parser.add_argument("--orders", type=int, default=1500)
    args = parser.parse_args()
    load_env()
    dsn = args.dsn or os.environ.get("DATABASE_URL")
    if not dsn:
        sys.exit("No DSN: pass --dsn or set DATABASE_URL.")
    counts = seed(dsn, orders=args.orders)
    print(f"Seeded {SCHEMA}: " + ", ".join(f"{k}={v}" for k, v in counts.items()))


if __name__ == "__main__":
    main()
