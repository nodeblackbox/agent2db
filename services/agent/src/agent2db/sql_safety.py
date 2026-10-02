"""Classify SQL with Postgres's own parser (pglast) so approvals show what a statement really does."""

from __future__ import annotations

from dataclasses import dataclass, field

import pglast
from pglast import ast

_READ_ONLY = {"SELECT", "EXPLAIN", "SHOW"}

_TYPE_NAMES = {
    "SelectStmt": "SELECT",
    "InsertStmt": "INSERT",
    "UpdateStmt": "UPDATE",
    "DeleteStmt": "DELETE",
    "MergeStmt": "MERGE",
    "CreateStmt": "CREATE TABLE",
    "CreateTableAsStmt": "CREATE TABLE AS",
    "ViewStmt": "CREATE VIEW",
    "IndexStmt": "CREATE INDEX",
    "CreateSchemaStmt": "CREATE SCHEMA",
    "CreateExtensionStmt": "CREATE EXTENSION",
    "CreateFunctionStmt": "CREATE FUNCTION",
    "AlterTableStmt": "ALTER TABLE",
    "RenameStmt": "RENAME",
    "DropStmt": "DROP",
    "TruncateStmt": "TRUNCATE",
    "GrantStmt": "GRANT",
    "GrantRoleStmt": "GRANT ROLE",
    "CreateRoleStmt": "CREATE ROLE",
    "AlterRoleStmt": "ALTER ROLE",
    "DropRoleStmt": "DROP ROLE",
    "TransactionStmt": "TRANSACTION",
    "ExplainStmt": "EXPLAIN",
    "VariableShowStmt": "SHOW",
    "VariableSetStmt": "SET",
    "CopyStmt": "COPY",
    "DoStmt": "DO",
    "CallStmt": "CALL",
    "VacuumStmt": "VACUUM",
}


@dataclass
class SqlAnalysis:
    statement_types: list[str] = field(default_factory=list)
    warnings: list[str] = field(default_factory=list)
    parse_error: str | None = None

    @property
    def read_only(self) -> bool:
        return (
            self.parse_error is None
            and bool(self.statement_types)
            and all(t in _READ_ONLY for t in self.statement_types)
        )


def _has_data_modifying_cte(stmt: ast.Node) -> bool:
    with_clause = getattr(stmt, "withClause", None)
    for cte in getattr(with_clause, "ctes", None) or ():
        if not isinstance(cte.ctequery, ast.SelectStmt):
            return True
    return False


def analyze_sql(sql: str) -> SqlAnalysis:
    result = SqlAnalysis()
    try:
        statements = pglast.parse_sql(sql)
    except pglast.parser.ParseError as exc:
        result.parse_error = str(exc)
        result.warnings.append(f"Could not parse SQL: {exc}")
        return result

    if len(statements) > 1:
        result.warnings.append(f"{len(statements)} statements in one call.")
    for raw in statements:
        stmt = raw.stmt
        kind = _TYPE_NAMES.get(type(stmt).__name__, type(stmt).__name__.removesuffix("Stmt").upper())
        result.statement_types.append(kind)

        if isinstance(stmt, (ast.UpdateStmt, ast.DeleteStmt)) and stmt.whereClause is None:
            result.warnings.append(f"{kind} without WHERE affects every row of the table.")
        if isinstance(stmt, (ast.DropStmt, ast.TruncateStmt)):
            result.warnings.append(f"{kind} permanently removes data.")
        if isinstance(stmt, ast.TransactionStmt):
            result.warnings.append("Transaction control inside agent SQL.")
        if isinstance(stmt, ast.SelectStmt) and stmt.intoClause is not None:
            result.statement_types[-1] = "SELECT INTO"
        if isinstance(stmt, ast.ExplainStmt):
            options = {getattr(o, "defname", "") for o in stmt.options or ()}
            if "analyze" in options and not isinstance(stmt.query, ast.SelectStmt):
                result.statement_types[-1] = "EXPLAIN ANALYZE (executes)"
        if _has_data_modifying_cte(stmt):
            result.statement_types[-1] = f"{kind} (data-modifying CTE)"
    return result
