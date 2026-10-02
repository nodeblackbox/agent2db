/**
 * Small SQL tokenizer for syntax highlighting. Pure and dependency-free; good enough for the SQL
 * an agent writes (PostgreSQL dialect). Not a parser: it only classifies spans.
 */

export type SqlTokenKind = 'keyword' | 'function' | 'string' | 'number' | 'comment' | 'operator' | 'identifier' | 'punct' | 'space';

export interface SqlToken {
  kind: SqlTokenKind;
  text: string;
}

const KEYWORDS = new Set(
  (
    'select from where and or not in is null as join inner left right full outer cross on group by order ' +
    'having limit offset insert into values update set delete truncate create table view index drop alter ' +
    'add column primary key foreign references unique check default constraint with recursive union all ' +
    'except intersect distinct case when then else end exists between like ilike similar to asc desc nulls ' +
    'first last returning begin commit rollback transaction explain analyze verbose format cascade restrict ' +
    'if replace schema grant revoke using natural lateral over partition window rows range unbounded ' +
    'preceding following current row filter within materialized temp temporary unlogged type enum domain ' +
    'function returns language immutable stable volatile interval true false boolean int integer bigint ' +
    'smallint numeric decimal real double precision text varchar char date time timestamp timestamptz ' +
    'json jsonb uuid serial bigserial array any some only vacuum merge matched do nothing conflict'
  ).split(/\s+/),
);

const FUNCTIONS = new Set(
  (
    'count sum avg min max coalesce nullif greatest least now current_date current_timestamp date_trunc ' +
    'extract to_char to_date to_timestamp cast round floor ceil abs length lower upper trim substring ' +
    'position concat concat_ws string_agg array_agg json_agg jsonb_agg row_number rank dense_rank lag lead ' +
    'first_value last_value percentile_cont percentile_disc generate_series unnest exists age make_interval ' +
    'regexp_replace regexp_matches split_part left right replace format md5 random'
  ).split(/\s+/),
);

const RE = /(--[^\n]*|\/\*[\s\S]*?\*\/)|('(?:[^']|'')*'|\$\$[\s\S]*?\$\$|E'(?:[^'\\]|\\.)*')|("(?:[^"]|"")*")|(\b\d+(?:\.\d+)?(?:e[+-]?\d+)?\b)|([A-Za-z_][A-Za-z0-9_]*)|(::|<>|!=|<=|>=|\|\||[-+*/<>=%^|&~@#!?])|([(),;.\[\]:])|(\s+)/g;

/** Tokenise SQL into highlightable spans. Unknown characters are emitted as punctuation. */
export function tokenizeSql(sql: string): SqlToken[] {
  const out: SqlToken[] = [];
  let last = 0;
  RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = RE.exec(sql))) {
    if (m.index > last) out.push({ kind: 'punct', text: sql.slice(last, m.index) });
    const [text] = m;
    let kind: SqlTokenKind;
    if (m[1] !== undefined) kind = 'comment';
    else if (m[2] !== undefined) kind = 'string';
    else if (m[3] !== undefined) kind = 'identifier';
    else if (m[4] !== undefined) kind = 'number';
    else if (m[5] !== undefined) {
      const lower = text.toLowerCase();
      const next = sql.slice(m.index + text.length).match(/^\s*\(/);
      kind = KEYWORDS.has(lower) && !(next && FUNCTIONS.has(lower)) ? 'keyword' : FUNCTIONS.has(lower) && next ? 'function' : 'identifier';
    } else if (m[6] !== undefined) kind = 'operator';
    else if (m[7] !== undefined) kind = 'punct';
    else kind = 'space';
    out.push({ kind, text });
    last = m.index + text.length;
  }
  if (last < sql.length) out.push({ kind: 'punct', text: sql.slice(last) });
  return out;
}

/** First meaningful words of a statement, for card titles: "SELECT … FROM orders". */
export function summarizeSql(sql: string, max = 90): string {
  const flat = sql
    .replace(/--[^\n]*/g, ' ')
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return flat.length > max ? flat.slice(0, max - 1) + '…' : flat;
}

/** Statement verb for icons and tones: SELECT, INSERT, UPDATE, DELETE, CREATE, DROP, ALTER, … */
export function sqlVerb(sql: string): string {
  const tokens = tokenizeSql(sql).filter((t) => t.kind !== 'space' && t.kind !== 'comment');
  const first = tokens[0]?.text.toUpperCase() ?? '';
  if (first === 'WITH') {
    // Skip to the statement after the CTE list: the first top-level keyword after the closing paren.
    let depth = 0;
    for (let i = 1; i < tokens.length; i++) {
      const t = tokens[i];
      if (t.text === '(') depth++;
      else if (t.text === ')') depth--;
      else if (depth === 0 && t.kind === 'keyword' && ['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'MERGE'].includes(t.text.toUpperCase())) {
        return t.text.toUpperCase();
      }
    }
    return 'WITH';
  }
  if (first === 'EXPLAIN') return 'EXPLAIN';
  return first;
}
