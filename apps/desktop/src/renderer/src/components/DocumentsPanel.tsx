import { useCallback, useEffect, useState, type DragEvent } from 'react';
import { ArrowLeft, FileText, Loader2, Search, Sparkles, Trash2, Upload, X } from 'lucide-react';
import type { DocumentDetail, DocumentHit, DocumentInfo, DocumentsOverview } from '../../../shared/types';
import { Btn, Card, CardHead, Empty, Tag, fmtWhen } from './primitives';
import { PanelShell } from './Panels';

const emptyOverview: DocumentsOverview = { documents: [], ready: 0, chunks: 0, vectorIndex: 'postgres', embeddingModel: null, ragEnabled: false };

function fmtBytes(n: number): string {
  if (n >= 1_048_576) return `${(n / 1_048_576).toFixed(1)} MB`;
  if (n >= 1024) return `${Math.round(n / 1024)} KB`;
  return `${n} B`;
}

function StatusTag({ doc }: { doc: DocumentInfo }) {
  if (doc.status === 'ready') return <Tag tone="ok">ready</Tag>;
  if (doc.status === 'failed') return <Tag tone="danger">failed</Tag>;
  return (
    <span className="inline-flex items-center gap-1 text-[11px] text-indigo-300">
      <Loader2 size={11} className="animate-spin" /> {doc.status}
    </span>
  );
}

export function RagToggle({ enabled, onChange, compact = false }: { enabled: boolean; onChange: (v: boolean) => void; compact?: boolean }) {
  return (
    <button
      onClick={() => onChange(!enabled)}
      title={enabled ? 'RAG is on: relevant passages from your documents are added to every request' : 'RAG is off: documents are only used when the agent searches them explicitly'}
      className={`inline-flex items-center gap-1.5 rounded-lg px-2 py-1 text-[11.5px] transition-colors ${enabled ? 'bg-indigo-500/15 text-indigo-200 border border-indigo-500/30' : 'text-zinc-500 border border-zinc-800 hover:text-zinc-200 hover:bg-zinc-800/60'}`}
    >
      <Sparkles size={12} />
      {compact ? 'RAG' : 'Use documents in answers'}
      <span className={`h-3.5 w-6 rounded-full relative transition-colors ${enabled ? 'bg-indigo-400' : 'bg-zinc-700'}`}>
        <span className={`absolute top-0.5 h-2.5 w-2.5 rounded-full bg-zinc-950 transition-all ${enabled ? 'left-3' : 'left-0.5'}`} />
      </span>
    </button>
  );
}

function DocumentView({ id, onBack }: { id: number; onBack: () => void }) {
  const api = window.agent2db;
  const [doc, setDoc] = useState<DocumentDetail | null>(null);
  useEffect(() => {
    let alive = true;
    void api.documentDetail(id).then((d) => alive && setDoc(d));
    return () => {
      alive = false;
    };
  }, [api, id]);
  if (!doc) return <Empty>Loading…</Empty>;
  return (
    <PanelShell title={doc.name} onBack={onBack} wide>
      <div className="flex flex-wrap items-center gap-2 text-[12px] text-zinc-500 -mt-2">
        <Tag>{doc.kind}</Tag>
        <StatusTag doc={doc} />
        <span>{fmtBytes(doc.sizeBytes)}</span>
        <span>· {doc.chunkCount} chunks</span>
        <span>· {doc.charCount.toLocaleString()} characters</span>
        {doc.pages !== null && <span>· {doc.pages} pages</span>}
        {doc.embeddingModel ? <span>· embedded with {doc.embeddingModel}</span> : <span>· lexical only (no embedding model)</span>}
      </div>
      {doc.error && <div className="rounded-lg border border-rose-900/50 bg-rose-500/5 px-3 py-2 text-[12.5px] text-rose-300">{doc.error}</div>}
      <div className="flex flex-col gap-2">
        {doc.chunks.map((c) => (
          <Card key={c.id}>
            <div className="px-4 py-2 flex items-center gap-2 text-[11.5px] text-zinc-500 border-b border-zinc-800/60">
              <span className="mono">#{c.idx + 1}</span>
              {c.heading && <span className="text-zinc-300 truncate">{c.heading}</span>}
              {c.page !== null && <span>· p. {c.page}</span>}
              <span className="ml-auto">{c.charCount} chars</span>
              {c.embedded && <Tag tone="info">vector</Tag>}
            </div>
            <pre className="px-4 py-3 text-[12px] leading-relaxed text-zinc-300 whitespace-pre-wrap break-words font-[inherit]">{c.content}</pre>
          </Card>
        ))}
      </div>
    </PanelShell>
  );
}

export function DocumentsPanel({ onBack, overview, onOverview }: { onBack: () => void; overview: DocumentsOverview | null; onOverview: (o: DocumentsOverview) => void }) {
  const api = window.agent2db;
  const data = overview ?? emptyOverview;
  const [open, setOpen] = useState<number | null>(null);
  const [uploading, setUploading] = useState(false);
  const [dragging, setDragging] = useState(false);
  const [query, setQuery] = useState('');
  const [hits, setHits] = useState<DocumentHit[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(() => {
    api
      .listDocuments()
      .then(onOverview)
      .catch((e) => setError((e as Error).message));
  }, [api, onOverview]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  // Poll while something is still being ingested.
  const processing = data.documents.some((d) => d.status === 'pending' || d.status === 'processing');
  useEffect(() => {
    if (!processing) return;
    const t = setInterval(refresh, 1500);
    return () => clearInterval(t);
  }, [processing, refresh]);

  const pick = async (): Promise<void> => {
    setUploading(true);
    try {
      await api.uploadDocumentsDialog();
      refresh();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setUploading(false);
    }
  };

  const onDrop = async (e: DragEvent): Promise<void> => {
    e.preventDefault();
    setDragging(false);
    setUploading(true);
    try {
      for (const file of Array.from(e.dataTransfer.files)) {
        await api.uploadDocument({ name: file.name, data: await file.arrayBuffer() });
      }
      refresh();
    } catch (err) {
      setError((err as Error).message.replace(/^Error invoking remote method '[^']+': (Error: )?/, ''));
    } finally {
      setUploading(false);
    }
  };

  useEffect(() => {
    const q = query.trim();
    if (!q) {
      setHits(null);
      return;
    }
    const t = setTimeout(() => {
      void api.searchDocuments(q).then(setHits).catch(() => setHits([]));
    }, 250);
    return () => clearTimeout(t);
  }, [query, api]);

  if (open !== null) return <DocumentView id={open} onBack={() => setOpen(null)} />;

  return (
    <PanelShell
      title="Documents"
      onBack={onBack}
      action={
        <div className="flex items-center gap-2">
          <RagToggle enabled={data.ragEnabled} onChange={(v) => void api.setRag(v).then(refresh)} />
          <Btn variant="primary" onClick={() => void pick()} disabled={uploading}>
            {uploading ? <Loader2 size={13} className="animate-spin" /> : <Upload size={13} />} Add documents
          </Btn>
        </div>
      }
    >
      <div className="text-[12px] text-zinc-500 -mt-2">
        PDF, Word (.docx), Markdown, HTML and text files are split into heading-aware chunks, indexed for full-text search
        {data.embeddingModel ? ` and embedded with ${data.embeddingModel} (${data.vectorIndex})` : ' (no embedding model configured, lexical search only)'}.
        {' '}
        {data.ragEnabled ? 'RAG is on: the best passages are added to every request.' : 'RAG is off: the agent only reads documents when it calls documents__search.'}
      </div>
      {error && (
        <div className="flex items-center gap-2 rounded-lg border border-rose-900/50 bg-rose-500/5 px-3 py-2 text-[12.5px] text-rose-300">
          <span className="flex-1">{error}</span>
          <button onClick={() => setError(null)}>
            <X size={13} />
          </button>
        </div>
      )}

      <div
        onDragOver={(e) => {
          e.preventDefault();
          setDragging(true);
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={(e) => void onDrop(e)}
        className={`rounded-xl border border-dashed px-4 py-5 text-center text-[12.5px] transition-colors ${dragging ? 'border-indigo-400 bg-indigo-500/5 text-indigo-200' : 'border-zinc-800 text-zinc-600'}`}
      >
        Drop files here, or use <span className="text-zinc-400">Add documents</span>.
      </div>

      <Card>
        <CardHead icon={<Search size={14} className="text-zinc-400" />} title="Try a search" meta={hits ? `${hits.length} passages` : undefined} />
        <div className="px-4 pb-3">
          <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="What would the agent find for… e.g. refund policy" className="w-full rounded-lg border border-zinc-800 bg-zinc-950 px-3 py-1.5 text-[12.5px] text-zinc-200 placeholder-zinc-600 outline-none focus:border-zinc-600" />
          {hits && (
            <div className="mt-2 flex flex-col gap-1.5">
              {hits.length === 0 && <div className="text-[12px] text-zinc-600">No matching passages.</div>}
              {hits.map((h) => (
                <div key={h.id} className="rounded-lg border border-zinc-800 bg-zinc-900/40 px-3 py-2">
                  <div className="flex items-center gap-2 text-[11.5px] text-zinc-500">
                    <FileText size={12} />
                    <button onClick={() => setOpen(h.documentId)} className="text-zinc-300 hover:text-zinc-100 truncate">
                      {h.document}
                    </button>
                    {h.heading && <span className="truncate">› {h.heading}</span>}
                    {h.page !== null && <span>p. {h.page}</span>}
                    <span className="ml-auto mono">{h.similarity > 0 ? `sim ${h.similarity.toFixed(2)}` : 'text match'}</span>
                  </div>
                  <div className="text-[12px] text-zinc-300 mt-1 line-clamp-3 whitespace-pre-wrap">{h.content}</div>
                </div>
              ))}
            </div>
          )}
        </div>
      </Card>

      <div className="flex items-center gap-2 text-[11.5px] text-zinc-500 uppercase tracking-wide mt-1">
        Library <span className="text-zinc-700">{data.documents.length}</span>
        <span className="normal-case tracking-normal text-zinc-600">· {data.ready} ready · {data.chunks} chunks</span>
      </div>
      {data.documents.length === 0 && <Empty>No documents yet. Add policies, specs or notes so the agent can use them.</Empty>}
      <div className="flex flex-col gap-1.5">
        {data.documents.map((d) => (
          <div key={d.id} className="group rounded-lg border border-zinc-800 bg-zinc-900/40 px-3 py-2 flex items-center gap-3">
            <FileText size={14} className="text-zinc-500 shrink-0" />
            <button onClick={() => setOpen(d.id)} className="flex-1 min-w-0 text-left">
              <div className="text-[12.5px] text-zinc-200 truncate">{d.name}</div>
              <div className="text-[11px] text-zinc-600 truncate">
                {d.kind} · {fmtBytes(d.sizeBytes)} · {d.chunkCount} chunks{d.pages !== null ? ` · ${d.pages} pages` : ''} · {fmtWhen(d.createdAt)}
                {d.error ? ` · ${d.error}` : ''}
              </div>
            </button>
            <StatusTag doc={d} />
            <button onClick={() => void api.deleteDocument(d.id).then(refresh)} title="Delete" className="opacity-0 group-hover:opacity-100 text-zinc-600 hover:text-rose-300">
              <Trash2 size={13} />
            </button>
          </div>
        ))}
      </div>
      <div className="text-[11px] text-zinc-700 flex items-center gap-1">
        <ArrowLeft size={11} /> Back to chat to ask questions that use these documents.
      </div>
    </PanelShell>
  );
}
