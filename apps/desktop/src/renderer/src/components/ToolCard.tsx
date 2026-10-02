import { useMemo, useState } from 'react';
import { extractSql, formatCell, parseResultTable, splitToolName } from '../../../shared/resultTable';
import type { ToolResult } from '../state';

const MAX_TEXT_CHARS = 20_000;

function ResultView({ result }: { result: ToolResult }) {
  const table = useMemo(() => parseResultTable(result.content), [result.content]);
  if (table) {
    return (
      <div className="result-table-wrap">
        <table className="result-table">
          <thead>
            <tr>
              {table.columns.map((c) => (
                <th key={c}>{c}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {table.rows.map((row, i) => (
              <tr key={i}>
                {table.columns.map((c) => {
                  const v = row[c];
                  return (
                    <td key={c} className={v === null || v === undefined ? 'null' : undefined}>
                      {formatCell(v)}
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
        <div className="result-meta">
          {table.totalRows > table.rows.length
            ? `Showing ${table.rows.length} of ${table.totalRows} rows`
            : `${table.totalRows} row${table.totalRows === 1 ? '' : 's'}`}
          {result.truncated && ' · result truncated by backend'}
        </div>
      </div>
    );
  }
  const text = result.content.length > MAX_TEXT_CHARS ? result.content.slice(0, MAX_TEXT_CHARS) + '\n…' : result.content;
  return (
    <>
      <pre className={`code ${result.isError ? 'code-error' : ''}`}>{text || '(empty)'}</pre>
      {result.truncated && <div className="result-meta">Result truncated by backend</div>}
    </>
  );
}

export function ToolCard({
  name,
  args,
  result,
}: {
  name: string;
  args: Record<string, unknown>;
  result: ToolResult | null;
}) {
  const [open, setOpen] = useState(false);
  const { server, tool } = splitToolName(name);
  const { sql, rest } = extractSql(args);
  const hasRest = Object.keys(rest).length > 0;
  const state = result === null ? 'running' : result.isError ? 'error' : 'ok';

  return (
    <div className={`tool-card tool-${state}`}>
      <button className="tool-head" onClick={() => setOpen((o) => !o)} aria-expanded={open}>
        <span className="chevron">{open ? '▾' : '▸'}</span>
        <span className="tool-name">
          {server && <span className="tool-server">{server} / </span>}
          {tool}
        </span>
        {sql && !open && <span className="tool-preview">{sql.replace(/\s+/g, ' ').slice(0, 80)}</span>}
        <span className={`tool-state tool-state-${state}`}>
          {state === 'running' ? 'running…' : state === 'error' ? 'error' : 'done'}
        </span>
      </button>
      {open && (
        <div className="tool-body">
          {sql && (
            <>
              <div className="label">SQL</div>
              <pre className="code sql">{sql}</pre>
            </>
          )}
          {(hasRest || !sql) && (
            <>
              <div className="label">Arguments</div>
              <pre className="code">{JSON.stringify(rest, null, 2)}</pre>
            </>
          )}
          {result && (
            <>
              <div className="label">Result</div>
              <ResultView result={result} />
            </>
          )}
        </div>
      )}
    </div>
  );
}
