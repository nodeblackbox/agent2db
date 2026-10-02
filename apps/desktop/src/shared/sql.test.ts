import { describe, expect, it } from 'vitest';
import { sqlVerb, summarizeSql, tokenizeSql } from './sql';

describe('tokenizeSql', () => {
  it('classifies keywords, functions, strings, numbers, comments and identifiers', () => {
    const tokens = tokenizeSql("select count(*) as n, 'a''b' from public.orders -- hi\nwhere id >= 10.5");
    const kinds = tokens.filter((t) => t.kind !== 'space').map((t) => `${t.kind}:${t.text}`);
    expect(kinds).toEqual([
      'keyword:select',
      'function:count',
      'punct:(',
      'operator:*',
      'punct:)',
      'keyword:as',
      'identifier:n',
      'punct:,',
      "string:'a''b'",
      'keyword:from',
      'identifier:public',
      'punct:.',
      'identifier:orders',
      'comment:-- hi',
      'keyword:where',
      'identifier:id',
      'operator:>=',
      'number:10.5',
    ]);
  });

  it('round-trips the input text exactly', () => {
    const sql = 'UPDATE "Weird Table" SET x = $$dollar$$ WHERE y::int <> 3; /* c */';
    expect(tokenizeSql(sql).map((t) => t.text).join('')).toBe(sql);
  });

  it('treats a keyword used as a function call as a function (left(), right())', () => {
    const tokens = tokenizeSql('select left(name, 3), right from t');
    expect(tokens.find((t) => t.text === 'left')?.kind).toBe('function');
    expect(tokens.find((t) => t.text === 'right')?.kind).toBe('keyword');
  });
});

describe('sqlVerb / summarizeSql', () => {
  it('finds the statement verb, looking past CTEs', () => {
    expect(sqlVerb('  -- note\n SELECT 1')).toBe('SELECT');
    expect(sqlVerb('with a as (select 1), b as (delete from x returning 1) update t set y = 1')).toBe('UPDATE');
    expect(sqlVerb('explain analyze delete from t')).toBe('EXPLAIN');
    expect(sqlVerb('')).toBe('');
  });

  it('summarises to one line', () => {
    expect(summarizeSql('select   *\n  from -- c\n  orders')).toBe('select * from orders');
    expect(summarizeSql('x'.repeat(200), 20)).toHaveLength(20);
  });
});
