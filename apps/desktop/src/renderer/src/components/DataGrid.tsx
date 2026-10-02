import { useMemo, useState } from 'react';
import { formatCell, tableToCsv, type ResultTable } from '../../../shared/resultTable';
import { CopyButton } from './primitives';

const PAGE = 50;

/** Query results as a sticky-header grid with numeric alignment, NULL styling, paging and copy. */
export function DataGrid({ table, truncated }: { table: ResultTable; truncated: boolean }) {
  const [limit, setLimit] = useState(PAGE);
  const rows = table.rows.slice(0, limit);
  const csv = useMemo(() => tableToCsv(table), [table]);
  const json = useMemo(() => JSON.stringify(table.rows, null, 2), [table]);
  const shown = rows.length;
  return (
    <div>
      <div className="datagrid-wrap thread-scroll">
        <table className="datagrid">
          <thead>
            <tr>
              <th className="idx">#</th>
              {table.columns.map((c) => (
                <th key={c} className={table.numeric.has(c) ? 'num' : undefined} title={c}>
                  {c}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((row, i) => (
              <tr key={i}>
                <td className="idx">{i + 1}</td>
                {table.columns.map((c) => {
                  const v = row[c];
                  const isNull = v === null || v === undefined;
                  const text = formatCell(v);
                  return (
                    <td key={c} className={`${isNull ? 'null' : ''} ${table.numeric.has(c) ? 'num' : ''}`} title={isNull ? undefined : text}>
                      {text}
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="flex items-center gap-3 px-4 py-2 border-t border-zinc-800/70 text-[11.5px] text-zinc-500">
        <span>
          {table.totalRows > shown ? `Showing ${shown} of ${table.totalRows} rows` : `${table.totalRows} row${table.totalRows === 1 ? '' : 's'}`}
          {' · '}
          {table.columns.length} column{table.columns.length === 1 ? '' : 's'}
          {truncated && <span className="text-amber-300/80"> · truncated by backend</span>}
        </span>
        {table.rows.length > shown && (
          <button onClick={() => setLimit((l) => l + PAGE)} className="text-zinc-400 hover:text-zinc-100">
            Show {Math.min(PAGE, table.rows.length - shown)} more
          </button>
        )}
        <div className="flex-1" />
        <CopyButton text={csv} label="CSV" />
        <CopyButton text={json} label="JSON" />
      </div>
    </div>
  );
}
