/** Helpers for presenting tool results and arguments. Pure, shared with tests. */

export interface ResultTable {
  columns: string[];
  rows: Record<string, unknown>[];
  totalRows: number;
}

export const DEFAULT_MAX_ROWS = 200;

const isPlainObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

/**
 * If `content` is a JSON array of objects, return it as a table (rows capped at `maxRows`).
 * Otherwise null — the caller shows preformatted text.
 */
export function parseResultTable(content: string, maxRows = DEFAULT_MAX_ROWS): ResultTable | null {
  const trimmed = content.trim();
  if (!trimmed.startsWith('[')) return null;
  let value: unknown;
  try {
    value = JSON.parse(trimmed);
  } catch {
    return null;
  }
  if (!Array.isArray(value) || value.length === 0 || !value.every(isPlainObject)) return null;
  const rows = value as Record<string, unknown>[];
  const columns: string[] = [];
  const seen = new Set<string>();
  for (const row of rows.slice(0, maxRows)) {
    for (const key of Object.keys(row)) {
      if (!seen.has(key)) {
        seen.add(key);
        columns.push(key);
      }
    }
  }
  return { columns, rows: rows.slice(0, maxRows), totalRows: rows.length };
}

/** Render one cell value as display text. */
export function formatCell(v: unknown): string {
  if (v === null || v === undefined) return 'NULL';
  if (typeof v === 'string') return v;
  if (typeof v === 'number' || typeof v === 'boolean' || typeof v === 'bigint') return String(v);
  try {
    return JSON.stringify(v);
  } catch {
    return String(v);
  }
}

/** Pull a SQL statement out of tool args, if the tool looks like it takes one. */
export function extractSql(args: Record<string, unknown>): { sql: string | null; rest: Record<string, unknown> } {
  for (const key of ['sql', 'query', 'statement']) {
    const v = args[key];
    if (typeof v === 'string') {
      const rest = { ...args };
      delete rest[key];
      return { sql: v, rest };
    }
  }
  return { sql: null, rest: args };
}

/** Split "server__tool" into its parts for display. */
export function splitToolName(name: string): { server: string | null; tool: string } {
  const i = name.indexOf('__');
  if (i <= 0) return { server: null, tool: name };
  return { server: name.slice(0, i), tool: name.slice(i + 2) };
}
