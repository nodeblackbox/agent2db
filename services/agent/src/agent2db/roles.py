"""Create the least-privilege roles the MCP servers use (`agent2db-setup-roles`).

    uv run --project services/agent agent2db-setup-roles [--schema public ...] [--ddl] [--write-env]

Connects with DATABASE_URL (must be allowed to create roles), creates or updates:

- agent2db_ro: read-only transactions by default, 30s statement timeout, SELECT on the target schemas
- agent2db_rw: SELECT/INSERT/UPDATE/DELETE on the target schemas (plus CREATE with --ddl)

Neither role gets any access to the `agent2db` schema (Agent2DB's own tables). Passwords are
generated and printed once as DSNs; with --write-env they are appended to the repo-root .env.
"""

from __future__ import annotations

import argparse
import secrets
import sys

import psycopg
from psycopg import sql

from agent2db.config import REPO_ROOT, load_env
from agent2db.store import SCHEMA as APP_SCHEMA


def _role_exists(conn: psycopg.Connection, name: str) -> bool:
    return conn.execute("select 1 from pg_roles where rolname = %s", (name,)).fetchone() is not None


def setup_roles(dsn: str, schemas: list[str], *, allow_ddl: bool, ro_name: str = "agent2db_ro", rw_name: str = "agent2db_rw") -> dict[str, str]:
    info = psycopg.conninfo.conninfo_to_dict(dsn)
    passwords = {ro_name: secrets.token_urlsafe(24), rw_name: secrets.token_urlsafe(24)}
    with psycopg.connect(dsn, autocommit=True) as conn:
        dbname = conn.execute("select current_database()").fetchone()[0]
        for role, password in passwords.items():
            if _role_exists(conn, role):
                conn.execute(sql.SQL("alter role {} with login password {}").format(sql.Identifier(role), sql.Literal(password)))
            else:
                conn.execute(sql.SQL("create role {} with login password {}").format(sql.Identifier(role), sql.Literal(password)))
            conn.execute(sql.SQL("grant connect on database {} to {}").format(sql.Identifier(dbname), sql.Identifier(role)))
            conn.execute(sql.SQL("revoke all on schema {} from {}").format(sql.Identifier(APP_SCHEMA), sql.Identifier(role)))
        conn.execute(sql.SQL("alter role {} set default_transaction_read_only = on").format(sql.Identifier(ro_name)))
        conn.execute(sql.SQL("alter role {} set statement_timeout = '30s'").format(sql.Identifier(ro_name)))
        conn.execute(sql.SQL("alter role {} set statement_timeout = '60s'").format(sql.Identifier(rw_name)))
        conn.execute(sql.SQL("alter role {} set lock_timeout = '5s'").format(sql.Identifier(rw_name)))
        for schema in schemas:
            s = sql.Identifier(schema)
            conn.execute(sql.SQL("grant usage on schema {} to {}, {}").format(s, sql.Identifier(ro_name), sql.Identifier(rw_name)))
            conn.execute(sql.SQL("grant select on all tables in schema {} to {}").format(s, sql.Identifier(ro_name)))
            conn.execute(sql.SQL("grant select on all sequences in schema {} to {}").format(s, sql.Identifier(ro_name)))
            conn.execute(sql.SQL("alter default privileges in schema {} grant select on tables to {}").format(s, sql.Identifier(ro_name)))
            conn.execute(sql.SQL("grant select, insert, update, delete on all tables in schema {} to {}").format(s, sql.Identifier(rw_name)))
            conn.execute(sql.SQL("grant usage, select, update on all sequences in schema {} to {}").format(s, sql.Identifier(rw_name)))
            conn.execute(
                sql.SQL("alter default privileges in schema {} grant select, insert, update, delete on tables to {}").format(s, sql.Identifier(rw_name))
            )
            if allow_ddl:
                conn.execute(sql.SQL("grant create on schema {} to {}").format(s, sql.Identifier(rw_name)))
                # Tables created by the rw role are its own; make sure the ro role can still read them.
                conn.execute(
                    sql.SQL("alter default privileges for role {} in schema {} grant select on tables to {}").format(
                        sql.Identifier(rw_name), s, sql.Identifier(ro_name)
                    )
                )
    host, port = info.get("host", "localhost"), info.get("port", "5432")
    out = {}
    for role, password in passwords.items():
        out[role] = psycopg.conninfo.make_conninfo("", user=role, password=password, host=host, port=port, dbname=dbname)
    return out


def main() -> None:
    parser = argparse.ArgumentParser(description="Create agent2db_ro / agent2db_rw roles on the target database.")
    parser.add_argument("--dsn", help="admin DSN (default: DATABASE_URL from .env)")
    parser.add_argument("--schema", action="append", default=None, help="target schema (repeatable; default: public)")
    parser.add_argument("--ddl", action="store_true", help="also let agent2db_rw create tables in the target schemas")
    parser.add_argument("--write-env", action="store_true", help="append AGENT2DB_RO_DSN / AGENT2DB_RW_DSN to the repo-root .env")
    args = parser.parse_args()

    load_env()
    import os

    dsn = args.dsn or os.environ.get("DATABASE_URL")
    if not dsn:
        sys.exit("No DSN: pass --dsn or set DATABASE_URL.")
    dsns = setup_roles(dsn, args.schema or ["public"], allow_ddl=args.ddl)
    ro = psycopg.conninfo.conninfo_to_dict(dsns["agent2db_ro"])
    rw = psycopg.conninfo.conninfo_to_dict(dsns["agent2db_rw"])
    lines = [
        f"AGENT2DB_RO_DSN=postgresql://{ro['user']}:{ro['password']}@{ro['host']}:{ro['port']}/{ro['dbname']}",
        f"AGENT2DB_RW_DSN=postgresql://{rw['user']}:{rw['password']}@{rw['host']}:{rw['port']}/{rw['dbname']}",
    ]
    if args.write_env:
        env_path = REPO_ROOT / ".env"
        existing = env_path.read_text(encoding="utf-8") if env_path.is_file() else ""
        kept = [l for l in existing.splitlines() if not l.startswith(("AGENT2DB_RO_DSN=", "AGENT2DB_RW_DSN="))]
        env_path.write_text("\n".join(kept).rstrip("\n") + "\n\n# Least-privilege MCP roles (generated by agent2db-setup-roles)\n" + "\n".join(lines) + "\n", encoding="utf-8")
        print(f"Roles created; DSNs written to {env_path}", file=sys.stderr)
    else:
        print("Roles created. Add these to your .env:", file=sys.stderr)
        print("\n".join(lines))


if __name__ == "__main__":
    main()
