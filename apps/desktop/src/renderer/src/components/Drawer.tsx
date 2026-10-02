import { useEffect, useState } from 'react';
import { ArrowLeft, BookmarkPlus, Brain, Loader2, RefreshCw, Search, ShieldCheck, Table2, X } from 'lucide-react';
import type { ApprovalRecord, Fact, SavedQuery, SchemaSearchHit, SchemaTableDetail, SchemaTableSummary } from '../../../shared/types';
import { Empty, Tag, fmtRows, fmtWhen } from './primitives';
import { SqlView } from './SqlView';

export type DrawerTab = 'schema' | 'memory' | 'approvals';

/** Loads a list once and whenever `refreshKey` changes; returns [data, loading, reload]. */
export function useLoader<T>(load: () => Promise<T>, refreshKey: unknown, initial: T): [T, boolean, () => void, string | null] {
  const [data, setData] = useState<T>(initial);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [tick, setTick] = useState(0);
  useEffect(() => {
    let alive = true;
    setLoading(true);
    load()
      .then((d) => {
        if (alive) {
          setData(d);
          setError(null);
        }
      })
      .catch((e) => alive && setError((e as Error).message))
      .finally(() => alive && setLoading(false));
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [refreshKey, tick]);
  return [data, loading, () => setTick((t) => t + 1), error];
}

export function SchemaBrowser({ refreshKey, compact = false }: { refreshKey: unknown; compact?: boolean }) {
  const api = window.agent2db;
  const [tables, loading, reload] = useLoader<SchemaTableSummary[]>(() => api.schemaTables(), refreshKey, []);
  const [query, setQuery] = useState('');
  const [hits, setHits] = useState<SchemaSearchHit[] | null>(null);
  const [selected, setSelected] = useState<SchemaTableDetail | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    const q = query.trim();
    if (!q) {
      setHits(null);
      return;
    }
    const t = setTimeout(() => {
      void api.schemaSearch(q).then(setHits).catch(() => setHits([]));
    }, 200);
    return () => clearTimeout(t);
  }, [query, api]);

  const open = (name: string): void => {
    setBusy(true);
    void api
      .schemaTable(name)
      .then(setSelected)
      .finally(() => setBusy(false));
  };

  const reindex = (): void => {
    setBusy(true);
    void api
      .schemaReindex()
      .then(() => reload())
      .finally(() => setBusy(false));
  };

  if (selected) {
    return (
      <div className="flex flex-col h-full min-h-0">
        <div className="flex items-center gap-2 px-3 py-2 border-b border-zinc-800/70">
          <button onClick={() => setSelected(null)} className="text-zinc-500 hover:text-zinc-200">
            <ArrowLeft size={14} />
          </button>
          <span className="text-[12.5px] text-zinc-200 mono truncate">{selected.table}</span>
          <Tag>{selected.kind}</Tag>
          {selected.rows !== null && <span className="text-[11px] text-zinc-600">{fmtRows(selected.rows)}</span>}
        </div>
        {selected.comment && <div className="px-3 py-2 text-[12px] text-zinc-400 border-b border-zinc-800/70">{selected.comment}</div>}
        <div className="flex-1 overflow-auto thread-scroll">
          <SqlView sql={selected.ddl} copy />
        </div>
      </div>
    );
  }

  const list = hits ?? null;
  return (
    <div className="flex flex-col h-full min-h-0">
      <div className="flex items-center gap-2 px-3 py-2 border-b border-zinc-800/70">
        <div className="flex-1 flex items-center gap-1.5 rounded-lg border border-zinc-800 bg-zinc-950 px-2 py-1">
          <Search size={12} className="text-zinc-600" />
          <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search tables by name, column or comment" className="flex-1 bg-transparent outline-none text-[12px] text-zinc-200 placeholder-zinc-600" />
          {query && (
            <button onClick={() => setQuery('')} className="text-zinc-600 hover:text-zinc-300">
              <X size={12} />
            </button>
          )}
        </div>
        <button onClick={reindex} disabled={busy} title="Rebuild the schema index" className="text-zinc-500 hover:text-zinc-200 p-1 rounded-md hover:bg-zinc-800/70 disabled:opacity-40">
          {busy || loading ? <Loader2 size={13} className="animate-spin" /> : <RefreshCw size={13} />}
        </button>
      </div>
      <div className="flex-1 overflow-y-auto thread-scroll p-1.5">
        {list
          ? list.map((h) => (
              <button key={h.table} onClick={() => open(h.table)} className="w-full text-left rounded-lg px-2.5 py-2 hover:bg-zinc-900 flex flex-col gap-0.5">
                <span className="flex items-center gap-2 min-w-0">
                  <Table2 size={12} className="text-zinc-600 shrink-0" />
                  <span className="text-[12.5px] text-zinc-200 mono truncate">{h.table}</span>
                  <span className="text-[10.5px] text-zinc-600 ml-auto shrink-0">{fmtRows(h.rows)}</span>
                </span>
                <span className="text-[11px] text-zinc-600 pl-5 truncate">{h.comment ?? h.columns.slice(0, 8).join(', ')}</span>
              </button>
            ))
          : tables.map((t) => (
              <button key={t.table} onClick={() => open(t.table)} className="w-full text-left rounded-lg px-2.5 py-1.5 hover:bg-zinc-900 flex items-center gap-2">
                <Table2 size={12} className="text-zinc-600 shrink-0" />
                <span className="text-[12.5px] text-zinc-300 mono truncate">{t.table}</span>
                <span className="text-[10.5px] text-zinc-600 ml-auto shrink-0">
                  {t.columns} cols{t.rows !== null && !compact ? ` · ${fmtRows(t.rows)}` : ''}
                </span>
              </button>
            ))}
        {!loading && (list ? list.length === 0 : tables.length === 0) && <Empty>{list ? 'No matching tables.' : 'No tables indexed yet. The index builds on the first question.'}</Empty>}
      </div>
    </div>
  );
}

export function MemoryList({ refreshKey }: { refreshKey: unknown }) {
  const api = window.agent2db;
  const [facts, , reloadFacts] = useLoader<Fact[]>(() => api.listFacts(), refreshKey, []);
  const [queries, , reloadQueries] = useLoader<SavedQuery[]>(() => api.listSavedQueries(), refreshKey, []);
  return (
    <div className="flex-1 overflow-y-auto thread-scroll p-3 flex flex-col gap-4">
      <section>
        <div className="flex items-center gap-2 text-[11.5px] text-zinc-500 uppercase tracking-wide mb-2">
          <Brain size={12} /> Facts <span className="text-zinc-700">{facts.length}</span>
        </div>
        {facts.length === 0 && <div className="text-[12px] text-zinc-600">Nothing remembered yet. Confirmed facts the agent stores show up here.</div>}
        <div className="flex flex-col gap-1.5">
          {facts.map((f) => (
            <div key={f.id} className="group rounded-lg border border-zinc-800 bg-zinc-900/40 px-3 py-2 flex items-start gap-2">
              <div className="flex-1 min-w-0">
                <div className="text-[12.5px] text-zinc-200 leading-relaxed">{f.content}</div>
                <div className="text-[11px] text-zinc-600 mt-0.5 truncate">
                  {f.subject && <span className="mono">{f.subject} · </span>}
                  {f.source} · {fmtWhen(f.createdAt)}
                </div>
              </div>
              <button onClick={() => void api.deleteFact(f.id).then(reloadFacts)} title="Forget" className="opacity-0 group-hover:opacity-100 text-zinc-600 hover:text-rose-300">
                <X size={12} />
              </button>
            </div>
          ))}
        </div>
      </section>
      <section>
        <div className="flex items-center gap-2 text-[11.5px] text-zinc-500 uppercase tracking-wide mb-2">
          <BookmarkPlus size={12} /> Saved queries <span className="text-zinc-700">{queries.length}</span>
        </div>
        {queries.length === 0 && <div className="text-[12px] text-zinc-600">No saved queries yet. Ask the agent to save a query you will reuse.</div>}
        <div className="flex flex-col gap-1.5">
          {queries.map((q) => (
            <SavedQueryCard key={q.id} q={q} onDelete={() => void api.deleteSavedQuery(q.id).then(reloadQueries)} />
          ))}
        </div>
      </section>
    </div>
  );
}

function SavedQueryCard({ q, onDelete }: { q: SavedQuery; onDelete: () => void }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="group rounded-lg border border-zinc-800 bg-zinc-900/40 overflow-hidden">
      <div className="px-3 py-2 flex items-start gap-2 cursor-pointer" onClick={() => setOpen((o) => !o)}>
        <div className="flex-1 min-w-0">
          <div className="text-[12.5px] text-zinc-200 mono truncate">{q.name}</div>
          {q.description && <div className="text-[11.5px] text-zinc-500 mt-0.5">{q.description}</div>}
          <div className="text-[11px] text-zinc-600 mt-0.5 truncate">
            {q.tables.join(', ')}
            {q.tables.length > 0 && ' · '}used {q.useCount}× · {fmtWhen(q.updatedAt)}
          </div>
        </div>
        <button
          onClick={(e) => {
            e.stopPropagation();
            onDelete();
          }}
          title="Delete"
          className="opacity-0 group-hover:opacity-100 text-zinc-600 hover:text-rose-300"
        >
          <X size={12} />
        </button>
      </div>
      {open && (
        <div className="border-t border-zinc-800/70">
          <SqlView sql={q.sql} maxHeight={260} />
        </div>
      )}
    </div>
  );
}

export function ApprovalsList({ refreshKey }: { refreshKey: unknown }) {
  const api = window.agent2db;
  const [rows] = useLoader<ApprovalRecord[]>(() => api.listApprovals(), refreshKey, []);
  return (
    <div className="flex-1 overflow-y-auto thread-scroll p-3 flex flex-col gap-1.5">
      {rows.length === 0 && <Empty>No write approvals recorded yet.</Empty>}
      {rows.map((a) => (
        <div key={a.id} className="rounded-lg border border-zinc-800 bg-zinc-900/40 overflow-hidden">
          <div className="px-3 py-2 flex items-center gap-2">
            <ShieldCheck size={13} className={a.decision === 'approve' ? 'text-emerald-400' : a.decision === 'reject' ? 'text-rose-400' : 'text-amber-300'} />
            {a.statementTypes.map((t) => (
              <Tag key={t} tone={['DROP', 'TRUNCATE', 'DELETE'].some((k) => t.startsWith(k)) ? 'danger' : 'warn'}>
                {t}
              </Tag>
            ))}
            <span className={`text-[11px] ml-auto ${a.decision === 'approve' ? 'text-emerald-300' : a.decision === 'reject' ? 'text-rose-300' : 'text-amber-300'}`}>{a.decision ?? 'pending'}</span>
            <span className="text-[11px] text-zinc-600">{fmtWhen(a.requestedAt)}</span>
          </div>
          {a.sql && <SqlView sql={a.sql} maxHeight={160} copy={false} className="border-t border-zinc-800/70" />}
          {a.feedback && <div className="px-3 py-1.5 border-t border-zinc-800/70 text-[11.5px] text-zinc-400">Feedback: {a.feedback}</div>}
        </div>
      ))}
    </div>
  );
}

export function RightDrawer({ tab, setTab, onClose, refreshKey }: { tab: DrawerTab; setTab: (t: DrawerTab) => void; onClose: () => void; refreshKey: unknown }) {
  const tabs: Array<{ id: DrawerTab; label: string }> = [
    { id: 'schema', label: 'Schema' },
    { id: 'memory', label: 'Memory' },
    { id: 'approvals', label: 'Approvals' },
  ];
  return (
    <div className="flex flex-col h-full">
      <div className="flex items-center border-b border-zinc-800 px-1">
        {tabs.map((t) => (
          <button key={t.id} onClick={() => setTab(t.id)} className={`px-3 py-2.5 text-[12.5px] border-b-2 -mb-px ${tab === t.id ? 'border-zinc-100 text-zinc-100' : 'border-transparent text-zinc-500 hover:text-zinc-300'}`}>
            {t.label}
          </button>
        ))}
        <div className="flex-1" />
        <button onClick={onClose} className="mr-1 p-1.5 text-zinc-600 hover:text-zinc-300" title="Close panel">
          <X size={14} />
        </button>
      </div>
      <div className="flex-1 min-h-0 flex flex-col">
        {tab === 'schema' && <SchemaBrowser refreshKey={refreshKey} compact />}
        {tab === 'memory' && <MemoryList refreshKey={refreshKey} />}
        {tab === 'approvals' && <ApprovalsList refreshKey={refreshKey} />}
      </div>
    </div>
  );
}
