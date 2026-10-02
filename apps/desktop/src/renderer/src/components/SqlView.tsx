import { useMemo } from 'react';
import { tokenizeSql, type SqlTokenKind } from '../../../shared/sql';
import { CopyButton } from './primitives';

const CLASS: Record<SqlTokenKind, string> = {
  keyword: 'kw',
  function: 'fn',
  string: 'str',
  number: 'num',
  comment: 'cm',
  operator: 'op',
  identifier: 'id',
  punct: 'op',
  space: '',
};

/** Syntax-highlighted SQL with a copy button. */
export function SqlView({ sql, className = '', copy = true, maxHeight }: { sql: string; className?: string; copy?: boolean; maxHeight?: number }) {
  const tokens = useMemo(() => tokenizeSql(sql), [sql]);
  return (
    <div className={`relative group ${className}`}>
      <pre className="sql m-0 px-4 py-3 overflow-auto thread-scroll" style={maxHeight ? { maxHeight } : undefined}>
        {tokens.map((t, i) => (CLASS[t.kind] ? <span key={i} className={CLASS[t.kind]}>{t.text}</span> : t.text))}
      </pre>
      {copy && (
        <div className="absolute top-1.5 right-1.5 opacity-0 group-hover:opacity-100 transition-opacity">
          <CopyButton text={sql} label="SQL" className="bg-zinc-900/90 border border-zinc-800" />
        </div>
      )}
    </div>
  );
}
