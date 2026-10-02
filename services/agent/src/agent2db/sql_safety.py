"""Classify SQL with Postgres's own parser (pglast) so approvals show what a statement really does."""

from __future__ import annotations

from dataclasses import dataclass, field

import pglast
from pglast import ast
from pglast.visitors import Visitor

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

# Statement kinds whose impact can be estimated with EXPLAIN (row estimate of the ModifyTable node).
DML_KINDS = {"INSERT", "UPDATE", "DELETE", "MERGE"}
# Statement kinds whose impact is "every row of the named tables".
DESTRUCTIVE_KINDS = {"DROP", "TRUNCATE"}


@dataclass
class SqlAnalysis:
    statement_types: list[str] = field(default_factory=list)
    warnings: list[str] = field(default_factory=list)
    tables: list[str] = field(default_factory=list)
    parse_error: str | None = None

    @property
    def read_only(self) -> bool:
        return (
            self.parse_error is None
            and bool(self.statement_types)
            and all(t in _READ_ONLY for t in self.statement_types)
        )

    @property
    def kinds(self) -> set[str]:
        """Base statement kinds without the qualifiers added in parentheses."""
        return {t.split(" (")[0] for t in self.statement_types}


def _has_data_modifying_cte(stmt: ast.Node) -> bool:
    with_clause = getattr(stmt, "withClause", None)
    for cte in getattr(with_clause, "ctes", None) or ():
        if not isinstance(cte.ctequery, ast.SelectStmt):
            return True
    return False


class _TableCollector(Visitor):
    def __init__(self) -> None:
        self.tables: list[str] = []
        self.ctes: set[str] = set()

    def visit_CommonTableExpr(self, ancestors, node):  # noqa: N802 - pglast naming
        self.ctes.add(node.ctename)

    def visit_RangeVar(self, ancestors, node):  # noqa: N802 - pglast naming
        self._add(f"{node.schemaname}.{node.relname}" if node.schemaname else node.relname)

    def visit_DropStmt(self, ancestors, node):  # noqa: N802 - pglast naming
        # DROP TABLE a, s.b: objects are lists of String parts, not RangeVars.
        for obj in node.objects or ():
            parts = [getattr(part, "sval", None) for part in (obj if isinstance(obj, (list, tuple)) else [obj])]
            if parts and all(parts):
                self._add(".".join(parts))

    def _add(self, name: str) -> None:
        if name not in self.tables:
            self.tables.append(name)


def referenced_tables(statements) -> list[str]:
    """Schema-qualified-when-written table names a parsed statement list touches (CTE names removed)."""
    collector = _TableCollector()
    for raw in statements:
        collector(raw)
    return [t for t in collector.tables if t not in collector.ctes]


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
    try:
        result.tables = referenced_tables(statements)
    except Exception:  # noqa: BLE001 - table extraction is best effort
        result.tables = []
    return result
