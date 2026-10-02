import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import { ArrowDown, ArrowUp, ChevronLeft, ChevronRight, Database, GitFork, Loader2, Maximize2, Minus, Play, Plus, RefreshCw, Search, Table2 } from 'lucide-react';
import type { ErdResult, QueryResult, SchemaTableDetail, SchemaTableSummary, TableRows } from '../../../shared/types';
import { formatCell } from '../../../shared/resultTable';
import { useLoader } from './Drawer';
import { Btn, CopyButton, Empty, Tag, fmtDuration, fmtRows } from './primitives';
import { SqlView } from './SqlView';

type Tab = 'data' | 'structure' | 'query' | 'erd';
const PAGE_SIZES = [25, 50, 100, 200];
const NUMERIC = /^-?\d+(\.\d+)?$/;

/** Plain grid for row arrays (viewer results are positional, unlike tool results). */
function RowGrid({ columns, rows, numeric, onSort, sort }: { columns: string[]; rows: unknown[][]; numeric: Set<number>; onSort?: (col: string) => void; sort?: { col: string; desc: boolean } | null }) {
  return (
    <div className="datagrid-wrap thread-scroll flex-1 min-h-0" style={{ maxHeight: 'none' }}>
      <table className="datagrid">
        <thead>
          <tr>
            <th className="idx">#</th>
            {columns.map((c, i) => (
              <th key={c} className={`${numeric.has(i) ? 'num' : ''} ${onSort ? 'cursor-pointer hover:text-zinc-100' : ''}`} onClick={onSort ? () => onSort(c) : undefined} title={onSort ? `Sort by ${c}` : c}>
                <span className="inline-flex items-center gap-1">
                  {c}
                  {sort?.col === c && (sort.desc ? <ArrowDown size={11} /> : <ArrowUp size={11} />)}
                </span>
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row, r) => (
            <tr key={r}>
              <td className="idx">{r + 1}</td>
              {columns.map((c, i) => {
                const v = row[i];
                const isNull = v === null || v === undefined;
                const text = formatCell(v);
                return (
                  <td key={c} className={`${isNull ? 'null' : ''} ${numeric.has(i) ? 'num' : ''}`} title={isNull ? undefined : text}>
                    {text}
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
      {rows.length === 0 && <div className="px-4 py-8 text-center text-[12.5px] text-zinc-600">No rows.</div>}
    </div>
  );
}

function numericColumns(columns: string[], rows: unknown[][]): Set<number> {
  const out = new Set<number>();
  columns.forEach((_, i) => {
    let saw = false;
    let ok = true;
    for (const row of rows) {
      const v = row[i];
      if (v === null || v === undefined) continue;
      saw = true;
      if (!(typeof v === 'number' || (typeof v === 'string' && NUMERIC.test(v)))) {
        ok = false;
        break;
      }
    }
    if (saw && ok) out.add(i);
  });
  return out;
}

function DataTab({ table }: { table: string }) {
  const api = window.agent2db;
  const [pageSize, setPageSize] = useState(50);
  const [offset, setOffset] = useState(0);
  const [sort, setSort] = useState<{ col: string; desc: boolean } | null>(null);
  const [where, setWhere] = useState('');
  const [applied, setApplied] = useState('');
  const [data, setData] = useState<TableRows | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    setOffset(0);
    setSort(null);
    setWhere('');
    setApplied('');
  }, [table]);

  useEffect(() => {
    let alive = true;
    setLoading(true);
    api
      .dbRows({ table, limit: pageSize, offset, orderBy: sort?.col, desc: sort?.desc, where: applied || undefined })
      .then((d) => {
        if (!alive) return;
        setData(d);
        setError(null);
      })
      .catch((e) => alive && setError((e as Error).message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '')))
      .finally(() => alive && setLoading(false));
    return () => {
      alive = false;
    };
  }, [api, table, pageSize, offset, sort, applied]);

  const numeric = useMemo(() => (data ? numericColumns(data.columns, data.rows) : new Set<number>()), [data]);
  const total = data?.total ?? null;
  const from = offset + 1;
  const to = data ? offset + data.rows.length : offset;
  const hasNext = data ? (total !== null ? offset + pageSize < total : data.rows.length === pageSize) : false;

  return (
    <div className="flex flex-col h-full min-h-0">
      <div className="flex items-center gap-2 px-3 py-2 border-b border-zinc-800/70">
        <div className="flex-1 flex items-center gap-1.5 rounded-lg border border-zinc-800 bg-zinc-950 px-2 py-1">
          <Search size={12} className="text-zinc-600" />
          <input
            value={where}
            onChange={(e) => setWhere(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                setOffset(0);
                setApplied(where.trim());
              }
            }}
            placeholder="WHERE filter, e.g. status = 'paid' AND total > 100   (Enter to apply)"
            className="flex-1 bg-transparent outline-none text-[12px] mono text-zinc-200 placeholder-zinc-600"
          />
          {applied && (
            <button
              onClick={() => {
                setWhere('');
                setApplied('');
                setOffset(0);
              }}
              className="text-[11px] text-zinc-500 hover:text-zinc-200"
            >
              clear
            </button>
          )}
        </div>
        <select value={pageSize} onChange={(e) => { setPageSize(Number(e.target.value)); setOffset(0); }} className="rounded-lg border border-zinc-800 bg-zinc-950 text-[12px] text-zinc-300 px-2 py-1 outline-none">
          {PAGE_SIZES.map((n) => (
            <option key={n} value={n}>
              {n} rows
            </option>
          ))}
        </select>
      </div>
      {error && <div className="px-3 py-2 text-[12px] text-rose-300 border-b border-rose-900/40 bg-rose-500/5 mono">{error}</div>}
      {data && <RowGrid columns={data.columns} rows={data.rows} numeric={numeric} sort={sort} onSort={(col) => { setOffset(0); setSort((s) => (s?.col === col ? { col, desc: !s.desc } : { col, desc: false })); }} />}
      <div className="flex items-center gap-2 px-3 py-2 border-t border-zinc-800/70 text-[11.5px] text-zinc-500">
        {loading && <Loader2 size={12} className="animate-spin" />}
        <span>
          {data && data.rows.length > 0 ? `Rows ${from.toLocaleString()}–${to.toLocaleString()}` : 'No rows'}
          {total !== null ? ` of ${total.toLocaleString()}` : data && data.estimate ? ` of ~${data.estimate.toLocaleString()} (estimate)` : ''}
          {applied && ' · filtered'}
        </span>
        <div className="flex-1" />
        <Btn size="icon" disabled={offset === 0} onClick={() => setOffset(Math.max(0, offset - pageSize))} title="Previous page">
          <ChevronLeft size={14} />
        </Btn>
        <Btn size="icon" disabled={!hasNext} onClick={() => setOffset(offset + pageSize)} title="Next page">
          <ChevronRight size={14} />
        </Btn>
      </div>
    </div>
  );
}

function StructureTab({ table }: { table: string }) {
  const api = window.agent2db;
  const [detail] = useLoader<SchemaTableDetail | null>(() => api.schemaTable(table), table, null);
  if (!detail) return <Empty>Loading…</Empty>;
  const cols = detail.columns as Array<Record<string, unknown>>;
  return (
    <div className="flex flex-col h-full min-h-0 overflow-y-auto thread-scroll">
      <div className="px-4 py-3 border-b border-zinc-800/70 flex items-center gap-2 text-[12.5px]">
        <Tag>{detail.kind}</Tag>
        {detail.rows !== null && <span className="text-zinc-500">{fmtRows(detail.rows)}</span>}
        {detail.comment && <span className="text-zinc-400">— {detail.comment}</span>}
      </div>
      <table className="datagrid">
        <thead>
          <tr>
            <th>column</th>
            <th>type</th>
            <th>nullable</th>
            <th>default</th>
            <th>notes</th>
          </tr>
        </thead>
        <tbody>
          {cols.map((c) => (
            <tr key={String(c.name)}>
              <td className="text-zinc-100">{String(c.name)}</td>
              <td>{String(c.type)}{c.max_len ? `(${String(c.max_len)})` : ''}</td>
              <td className={c.nullable === false ? 'text-zinc-500' : 'null'}>{c.nullable === false ? 'not null' : 'null'}</td>
              <td className={c.default ? '' : 'null'}>{c.default ? String(c.default) : 'NULL'}</td>
              <td className="text-zinc-500">{[c.comment ? String(c.comment) : '', Array.isArray(c.values) ? `values: ${(c.values as unknown[]).join(', ')}` : ''].filter(Boolean).join(' · ')}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {detail.foreignKeys.length > 0 && (
        <div className="px-4 py-3 border-t border-zinc-800/70">
          <div className="text-[11.5px] text-zinc-500 uppercase tracking-wide mb-1.5">Foreign keys</div>
          {detail.foreignKeys.map((fk, i) => (
            <div key={i} className="text-[12px] mono text-zinc-300">
              {String((fk.columns as unknown[] | undefined)?.join(', '))} → {String(fk.ref_table)}({String((fk.ref_columns as unknown[] | undefined)?.join(', '))})
            </div>
          ))}
        </div>
      )}
      <div className="border-t border-zinc-800/70">
        <div className="px-4 pt-2 text-[11.5px] text-zinc-500 uppercase tracking-wide">Definition</div>
        <SqlView sql={detail.ddl} />
      </div>
    </div>
  );
}

function QueryTab({ initialSql }: { initialSql: string }) {
  const api = window.agent2db;
  const [sql, setSql] = useState(initialSql);
  const [result, setResult] = useState<QueryResult | null>(null);
  const [running, setRunning] = useState(false);
  useEffect(() => setSql(initialSql), [initialSql]);
  const run = useCallback(() => {
    if (!sql.trim() || running) return;
    setRunning(true);
    api
      .dbQuery(sql)
      .then(setResult)
      .catch((e) => setResult({ columns: [], rows: [], rowCount: 0, truncated: false, ms: 0, error: (e as Error).message, statementTypes: [] }))
      .finally(() => setRunning(false));
  }, [api, sql, running]);
  const onKey = (e: KeyboardEvent<HTMLTextAreaElement>): void => {
    if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
      e.preventDefault();
      run();
    }
  };
  const numeric = useMemo(() => (result ? numericColumns(result.columns, result.rows) : new Set<number>()), [result]);
  return (
    <div className="flex flex-col h-full min-h-0">
      <div className="border-b border-zinc-800/70">
        <textarea
          value={sql}
          onChange={(e) => setSql(e.target.value)}
          onKeyDown={onKey}
          spellCheck={false}
          rows={6}
          placeholder="SELECT … (read-only; Ctrl+Enter to run)"
          className="w-full bg-zinc-950/60 outline-none text-[12.5px] mono leading-relaxed text-zinc-100 placeholder-zinc-600 px-4 py-3 resize-y thread-scroll"
        />
        <div className="flex items-center gap-2 px-3 py-2 border-t border-zinc-800/70">
          <Btn variant="primary" size="xs" onClick={run} disabled={running || !sql.trim()}>
            {running ? <Loader2 size={12} className="animate-spin" /> : <Play size={12} />} Run
          </Btn>
          <span className="text-[11px] text-zinc-600">Read-only: SELECT, EXPLAIN and SHOW only. Changes go through the agent with approval.</span>
          <div className="flex-1" />
          {result && !result.error && (
            <span className="text-[11.5px] text-zinc-500 mono">
              {result.rowCount} row{result.rowCount === 1 ? '' : 's'}
              {result.truncated && ' (capped at 500)'} · {fmtDuration(result.ms)}
            </span>
          )}
        </div>
      </div>
      {result?.error && <div className="px-4 py-3 text-[12px] text-rose-300 mono whitespace-pre-wrap">{result.error}</div>}
      {result && !result.error && <RowGrid columns={result.columns} rows={result.rows} numeric={numeric} />}
      {!result && <Empty>Run a query to see results here.</Empty>}
    </div>
  );
}

function ErdTab() {
  const api = window.agent2db;
  const [erd] = useLoader<ErdResult | null>(() => api.dbErd(), 0, null);
  const [svg, setSvg] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [scale, setScale] = useState(1);
  const [pan, setPan] = useState({ x: 24, y: 24 });
  const drag = useRef<{ x: number; y: number; px: number; py: number } | null>(null);

  useEffect(() => {
    if (!erd) return;
    let alive = true;
    (async () => {
      try {
        const mermaid = (await import('mermaid')).default;
        mermaid.initialize({ startOnLoad: false, theme: 'dark', securityLevel: 'strict', er: { useMaxWidth: false }, fontFamily: 'var(--font-mono)' });
        const { svg: rendered } = await mermaid.render(`erd-${Date.now()}`, erd.mermaid);
        if (alive) setSvg(rendered);
      } catch (e) {
        if (alive) setError((e as Error).message);
      }
    })();
    return () => {
      alive = false;
    };
  }, [erd]);

  // React registers wheel listeners as passive, so the page would still scroll; attach a
  // non-passive listener directly to zoom without scrolling the panel.
  const canvas = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = canvas.current;
    if (!el) return;
    const onWheel = (e: WheelEvent): void => {
      e.preventDefault();
      const factor = e.deltaY < 0 ? 1.1 : 0.9;
      setScale((s) => Math.min(4, Math.max(0.2, s * factor)));
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, []);
  const onDown = (e: React.MouseEvent): void => {
    drag.current = { x: e.clientX, y: e.clientY, px: pan.x, py: pan.y };
  };
  const onMove = (e: React.MouseEvent): void => {
    if (!drag.current) return;
    setPan({ x: drag.current.px + (e.clientX - drag.current.x), y: drag.current.py + (e.clientY - drag.current.y) });
  };
  const onUp = (): void => {
    drag.current = null;
  };

  return (
    <div className="flex flex-col h-full min-h-0">
      <div className="flex items-center gap-1 px-3 py-2 border-b border-zinc-800/70">
        <span className="text-[12px] text-zinc-400 mr-2">{erd ? `${erd.tables} tables` : 'Loading…'}</span>
        <Btn size="icon" onClick={() => setScale((s) => Math.min(4, s * 1.2))} title="Zoom in">
          <Plus size={13} />
        </Btn>
        <Btn size="icon" onClick={() => setScale((s) => Math.max(0.2, s / 1.2))} title="Zoom out">
          <Minus size={13} />
        </Btn>
        <Btn size="icon" onClick={() => { setScale(1); setPan({ x: 24, y: 24 }); }} title="Reset view">
          <Maximize2 size={13} />
        </Btn>
        <span className="text-[11px] text-zinc-600 ml-1 mono">{Math.round(scale * 100)}%</span>
        <div className="flex-1" />
        {erd && <CopyButton text={erd.mermaid} label="Mermaid source" />}
        {svg && <CopyButton text={svg} label="SVG" />}
      </div>
      <div ref={canvas} className="flex-1 min-h-0 overflow-hidden relative bg-[#0b0b0d] cursor-grab active:cursor-grabbing select-none" onMouseDown={onDown} onMouseMove={onMove} onMouseUp={onUp} onMouseLeave={onUp}>
        {error && <div className="p-4 text-[12px] text-rose-300 mono whitespace-pre-wrap">{error}</div>}
        {!svg && !error && (
          <div className="absolute inset-0 flex items-center justify-center text-[12.5px] text-zinc-600">
            <Loader2 size={14} className="animate-spin mr-2" /> Rendering diagram…
          </div>
        )}
        {svg && (
          <div style={{ transform: `translate(${pan.x}px, ${pan.y}px) scale(${scale})`, transformOrigin: '0 0' }} className="inline-block [&_svg]:max-w-none" dangerouslySetInnerHTML={{ __html: svg }} />
        )}
      </div>
      <div className="px-3 py-1.5 border-t border-zinc-800/70 text-[11px] text-zinc-600">Scroll to zoom, drag to pan. Crow’s foot: parent ||—o{'{'} child.</div>
    </div>
  );
}

export function DatabasePanel({ refreshKey, onAsk }: { refreshKey: unknown; onAsk: (text: string) => void }) {
  const api = window.agent2db;
  const [tables, loading, reload] = useLoader<SchemaTableSummary[]>(() => api.schemaTables(), refreshKey, []);
  const [selected, setSelected] = useState<string | null>(null);
  const [tab, setTab] = useState<Tab>('data');
  const [filter, setFilter] = useState('');
  const [reindexing, setReindexing] = useState(false);
  const current = selected ?? tables[0]?.table ?? null;
  const shown = filter ? tables.filter((t) => t.table.toLowerCase().includes(filter.toLowerCase())) : tables;
  const bySchema = useMemo(() => {
    const groups = new Map<string, SchemaTableSummary[]>();
    for (const t of shown) {
      const schema = t.table.split('.')[0];
      groups.set(schema, [...(groups.get(schema) ?? []), t]);
    }
    return [...groups.entries()];
  }, [shown]);
  const reindex = (): void => {
    setReindexing(true);
    void api.schemaReindex().then(reload).finally(() => setReindexing(false));
  };
  const tabs: Array<{ id: Tab; label: string }> = [
    { id: 'data', label: 'Data' },
    { id: 'structure', label: 'Structure' },
    { id: 'query', label: 'Query' },
    { id: 'erd', label: 'Diagram' },
  ];

  return (
    <div className="flex h-full min-h-0">
      <div className="shrink-0 border-r border-zinc-800/80 flex flex-col" style={{ width: 260 }}>
        <div className="flex items-center gap-2 px-3 py-2 border-b border-zinc-800/80">
          <Database size={13} className="text-zinc-500" />
          <span className="text-[12px] text-zinc-400 flex-1">Tables</span>
          <button onClick={reindex} disabled={reindexing} title="Refresh (rebuild schema index)" className="text-zinc-500 hover:text-zinc-200 p-1 rounded-md hover:bg-zinc-800/70 disabled:opacity-40">
            {reindexing || loading ? <Loader2 size={13} className="animate-spin" /> : <RefreshCw size={13} />}
          </button>
        </div>
        <div className="px-2 pt-2">
          <div className="flex items-center gap-1.5 rounded-lg border border-zinc-800 bg-zinc-950 px-2 py-1">
            <Search size={12} className="text-zinc-600" />
            <input value={filter} onChange={(e) => setFilter(e.target.value)} placeholder="Filter tables" className="flex-1 bg-transparent outline-none text-[12px] text-zinc-200 placeholder-zinc-600" />
          </div>
        </div>
        <div className="flex-1 overflow-y-auto thread-scroll p-1.5">
          {bySchema.map(([schema, list]) => (
            <div key={schema} className="mb-1">
              <div className="px-2 pt-2 pb-1 text-[10.5px] uppercase tracking-wide text-zinc-600">{schema}</div>
              {list.map((t) => {
                const active = t.table === current;
                return (
                  <button key={t.table} onClick={() => setSelected(t.table)} className={`w-full text-left rounded-lg px-2.5 py-1.5 flex items-center gap-2 ${active ? 'bg-zinc-800/70 text-zinc-100' : 'text-zinc-300 hover:bg-zinc-900'}`}>
                    <Table2 size={12} className={active ? 'text-indigo-300' : 'text-zinc-600'} />
                    <span className="text-[12.5px] mono truncate">{t.table.split('.')[1]}</span>
                    <span className="text-[10.5px] text-zinc-600 ml-auto shrink-0">{t.rows !== null ? fmtRows(t.rows).replace('~', '') : ''}</span>
                  </button>
                );
              })}
            </div>
          ))}
          {!loading && tables.length === 0 && <Empty>No tables indexed yet.</Empty>}
        </div>
      </div>
      <div className="flex-1 flex flex-col min-w-0">
        <div className="h-11 shrink-0 flex items-center px-3 gap-1 border-b border-zinc-800/80">
          {current && (
            <span className="text-[12.5px] text-zinc-200 mono mr-3 truncate">
              {current}
            </span>
          )}
          {tabs.map((t) => (
            <button key={t.id} onClick={() => setTab(t.id)} className={`px-2.5 py-1.5 rounded-lg text-[12px] ${tab === t.id ? 'bg-zinc-800/70 text-zinc-100' : 'text-zinc-500 hover:text-zinc-200 hover:bg-zinc-900'}`}>
              {t.id === 'erd' && <GitFork size={12} className="inline mr-1 -mt-0.5" />}
              {t.label}
            </button>
          ))}
          <div className="flex-1" />
          {current && (
            <Btn variant="outline" size="xs" onClick={() => onAsk(`Tell me about the table ${current}: what it contains, how it relates to other tables, and a few sample rows.`)}>
              Ask the agent about this table
            </Btn>
          )}
        </div>
        <div className="flex-1 min-h-0">
          {tab === 'erd' ? (
            <ErdTab />
          ) : !current ? (
            <Empty>Select a table.</Empty>
          ) : tab === 'data' ? (
            <DataTab table={current} />
          ) : tab === 'structure' ? (
            <StructureTab table={current} />
          ) : (
            <QueryTab initialSql={`SELECT *\nFROM ${current}\nLIMIT 100;`} />
          )}
        </div>
      </div>
    </div>
  );
}
