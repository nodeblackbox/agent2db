import { describe, expect, it } from 'vitest';
import { extractSql, formatCell, parseResultTable, splitToolName } from './resultTable';

describe('parseResultTable', () => {
  it('builds columns from the union of keys in first-seen order', () => {
    const t = parseResultTable('[{"a":1,"b":2},{"b":3,"c":null}]');
    expect(t).toEqual({ columns: ['a', 'b', 'c'], rows: [{ a: 1, b: 2 }, { b: 3, c: null }], totalRows: 2, numeric: new Set(['a', 'b']) });
  });

  it('detects numeric columns, including numeric strings from Postgres numerics', () => {
    const t = parseResultTable('[{"n":"12.50","s":"x","m":null},{"n":3,"s":"7","m":null}]')!;
    expect([...t.numeric]).toEqual(['n']);
  });

  it('caps displayed rows but reports the total', () => {
    const rows = Array.from({ length: 10 }, (_, i) => ({ i }));
    const t = parseResultTable(JSON.stringify(rows), 4)!;
    expect(t.rows).toHaveLength(4);
    expect(t.totalRows).toBe(10);
  });

  it('returns null for non-tabular content', () => {
    expect(parseResultTable('UPDATE 3')).toBeNull();
    expect(parseResultTable('[]')).toBeNull();
    expect(parseResultTable('[1,2,3]')).toBeNull();
    expect(parseResultTable('[{"a":1}, [1]]')).toBeNull();
    expect(parseResultTable('[{"a":1}')).toBeNull();
    expect(parseResultTable('{"a":1}')).toBeNull();
  });
});

describe('helpers', () => {
  it('formats cells', () => {
    expect(formatCell(null)).toBe('NULL');
    expect(formatCell(5)).toBe('5');
    expect(formatCell({ x: 1 })).toBe('{"x":1}');
  });

  it('extracts SQL from tool args', () => {
    expect(extractSql({ sql: 'SELECT 1', limit: 5 })).toEqual({ sql: 'SELECT 1', rest: { limit: 5 } });
    expect(extractSql({ table: 't' })).toEqual({ sql: null, rest: { table: 't' } });
  });

  it('splits MCP tool names', () => {
    expect(splitToolName('postgres-read__execute_sql')).toEqual({ server: 'postgres-read', tool: 'execute_sql' });
    expect(splitToolName('plain_tool')).toEqual({ server: null, tool: 'plain_tool' });
  });
});
