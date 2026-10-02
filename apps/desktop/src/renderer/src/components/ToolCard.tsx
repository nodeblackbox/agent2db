import { useMemo, useState } from 'react';
import { AlertTriangle, Ban, BookmarkPlus, Brain, Check, Database, Loader2, PencilLine, Plug, Search, Table2, X } from 'lucide-react';
import { isEmptyResult, parseResultTable, splitToolName } from '../../../shared/resultTable';
import { sqlVerb, summarizeSql } from '../../../shared/sql';
import type { ApprovalRequest, ToolItem } from '../state';
import { DataGrid } from './DataGrid';
import { Btn, Card, CardHead, Collapsible, Tag, fmtDuration, type Tone } from './primitives';
import { SqlView } from './SqlView';

const WRITE_VERBS = new Set(['INSERT', 'UPDATE', 'DELETE', 'MERGE', 'CREATE', 'DROP', 'ALTER', 'TRUNCATE', 'GRANT', 'REVOKE']);
const MAX_TEXT = 20_000;

function toneFor(it: ToolItem, write: boolean): Tone {
  if (it.status === 'awaiting_approval') return 'pending';
  if (it.status === 'error' || it.status === 'rejected') return 'error';
  if (it.status === 'done' && write) return 'success';
  return 'default';
}

function StatusMeta({ it }: { it: ToolItem }) {
  if (it.status === 'running') return <Loader2 size={13} className="text-indigo-400 animate-spin" />;
  if (it.status === 'approved') return <Loader2 size={13} className="text-emerald-400 animate-spin" />;
  if (it.status === 'awaiting_approval') return <span className="text-[11px] text-amber-300">needs approval</span>;
  if (it.status === 'rejected')
    return (
      <span className="text-[11px] text-rose-300 inline-flex items-center gap-1">
        <X size={12} /> rejected
      </span>
    );
  if (it.status === 'error')
    return (
      <span className="text-[11px] text-rose-300 inline-flex items-center gap-1">
        <Ban size={12} /> error
      </span>
    );
  const ms = it.endedAt && it.startedAt ? it.endedAt - it.startedAt : 0;
  return <span className="text-[11px] text-zinc-600 mono">{ms > 0 ? fmtDuration(ms) : 'done'}</span>;
}

function ApprovalBar({ approval, busy, onDecide }: { approval: ApprovalRequest; busy: boolean; onDecide: (d: 'approve' | 'reject', feedback?: string) => void }) {
  const [rejecting, setRejecting] = useState(false);
  const [feedback, setFeedback] = useState('');
  const estimateLine = approval.warnings.find((w) => w.startsWith('Planner estimate') || w.startsWith('Affects all data'));
  const otherWarnings = approval.warnings.filter((w) => w !== estimateLine);
  return (
    <div className="px-4 py-3 border-t border-amber-900/40 bg-amber-500/[0.04] flex flex-col gap-2.5">
      <div className="flex flex-wrap items-center gap-1.5">
        {approval.statementTypes.map((t) => (
          <Tag key={t} tone={['DROP', 'TRUNCATE', 'DELETE'].some((k) => t.startsWith(k)) ? 'danger' : 'warn'}>
            {t}
          </Tag>
        ))}
        {approval.tables.map((t) => (
          <Tag key={t}>{t}</Tag>
        ))}
        {estimateLine && <span className="text-[12px] text-amber-200/90 ml-1">{estimateLine}</span>}
      </div>
      {otherWarnings.length > 0 && (
        <ul className="flex flex-col gap-1">
          {otherWarnings.map((w, i) => (
            <li key={i} className="flex items-center gap-1.5 text-[12px] text-amber-300">
              <AlertTriangle size={13} className="shrink-0" /> {w}
            </li>
          ))}
        </ul>
      )}
      {rejecting ? (
        <div className="flex items-center gap-2">
          <input
            autoFocus
            value={feedback}
            onChange={(e) => setFeedback(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') onDecide('reject', feedback);
              if (e.key === 'Escape') setRejecting(false);
            }}
            placeholder="Tell the agent what to do instead (optional)"
            maxLength={10_000}
            className="flex-1 rounded-lg border border-zinc-800 bg-zinc-950 px-2.5 py-1.5 text-[12.5px] text-zinc-200 placeholder-zinc-600 outline-none focus:border-zinc-600"
          />
          <Btn variant="danger" size="xs" disabled={busy} onClick={() => onDecide('reject', feedback)}>
            Reject
          </Btn>
          <Btn variant="ghost" size="xs" onClick={() => setRejecting(false)}>
            Back
          </Btn>
        </div>
      ) : (
        <div className="flex items-center gap-2">
          <Btn variant="primary" disabled={busy} onClick={() => onDecide('approve')}>
            <Check size={13} /> Approve and run
          </Btn>
          <Btn variant="outline" disabled={busy} onClick={() => setRejecting(true)}>
            Reject…
          </Btn>
          <span className="text-[11.5px] text-zinc-600 ml-1">Runs through the write role only after you approve.</span>
        </div>
      )}
    </div>
  );
}

function TextResult({ text, isError }: { text: string; isError: boolean }) {
  const shown = text.length > MAX_TEXT ? text.slice(0, MAX_TEXT) + '\n…' : text;
  return <pre className={`px-4 py-2.5 text-[12px] leading-[1.7] mono whitespace-pre-wrap break-words max-h-80 overflow-y-auto thread-scroll ${isError ? 'text-rose-300/90' : 'text-zinc-400'}`}>{shown || '(empty)'}</pre>;
}

function ResultBody({ it }: { it: ToolItem }) {
  const result = it.result;
  const table = useMemo(() => (result && !result.isError ? parseResultTable(result.content) : null), [result]);
  if (!result) return null;
  if (table) return <DataGrid table={table} truncated={result.truncated} />;
  if (!result.isError && isEmptyResult(result.content)) {
    return <div className="px-4 py-2.5 text-[12px] text-zinc-500">No rows returned.</div>;
  }
  return <TextResult text={result.content} isError={result.isError} />;
}

function SqlCard({ it, sql, busy, onDecide }: { it: ToolItem; sql: string; busy: boolean; onDecide: (d: 'approve' | 'reject', feedback?: string) => void }) {
  const verb = sqlVerb(sql);
  const write = WRITE_VERBS.has(verb) || it.approval !== null;
  const tone = toneFor(it, write);
  const { server } = splitToolName(it.name);
  const [open, setOpen] = useState(true);
  const icon = write ? <PencilLine size={14} className={tone === 'success' ? 'text-emerald-400' : tone === 'error' ? 'text-rose-400' : 'text-amber-300'} /> : <Database size={14} className="text-zinc-400" />;
  return (
    <Card tone={tone}>
      <CardHead
        icon={icon}
        title={verb || 'SQL'}
        meta={summarizeSql(sql)}
        right={
          <span className="flex items-center gap-2">
            {server && <Tag tone={write ? 'warn' : 'default'}>{server}</Tag>}
            <StatusMeta it={it} />
          </span>
        }
        onClick={() => setOpen((o) => !o)}
        open={open}
      />
      {open && (
        <>
          <div className="border-t border-zinc-800/70">
            <SqlView sql={sql} maxHeight={320} />
          </div>
          {it.status === 'awaiting_approval' && it.approval && <ApprovalBar approval={it.approval} busy={busy} onDecide={onDecide} />}
          {it.status === 'rejected' && (
            <div className="px-4 py-2 border-t border-rose-900/40 text-[12px] text-rose-300/90 flex items-center gap-1.5">
              <X size={12} /> Rejected{it.feedback ? `: ${it.feedback}` : '.'}
            </div>
          )}
          {it.result && it.status !== 'rejected' && (
            <div className="border-t border-zinc-800/70">
              <ResultBody it={it} />
            </div>
          )}
        </>
      )}
    </Card>
  );
}

function MemoryLine({ it }: { it: ToolItem }) {
  const { tool } = splitToolName(it.name);
  const args = it.args;
  const icon = tool === 'save_query' ? <BookmarkPlus size={13} /> : <Brain size={13} />;
  let text: string;
  if (tool === 'remember') text = `Remembered: ${String(args.fact ?? '')}`;
  else if (tool === 'save_query') text = `Saved query “${String(args.name ?? '')}”`;
  else if (tool === 'recall') text = `Recalled facts about “${String(args.query ?? '')}”`;
  else text = `Searched saved queries for “${String(args.query ?? '')}”`;
  return (
    <div className={`flex items-center gap-2 pl-1 text-[12px] ${it.status === 'error' ? 'text-rose-300' : 'text-zinc-500'}`}>
      {it.status === 'running' ? <Loader2 size={12} className="animate-spin" /> : icon}
      <span className="truncate">{text}</span>
      {it.status === 'error' && it.result && <span className="truncate text-rose-300/80">· {it.result.content.slice(0, 120)}</span>}
    </div>
  );
}

function SchemaCard({ it }: { it: ToolItem }) {
  const { tool } = splitToolName(it.name);
  const [open, setOpen] = useState(false);
  const title = tool === 'describe_table' ? `Describe ${String(it.args.table ?? '')}` : `Find tables: ${String(it.args.query ?? '')}`;
  return (
    <Card tone={toneFor(it, false)}>
      <CardHead icon={tool === 'describe_table' ? <Table2 size={14} className="text-zinc-400" /> : <Search size={14} className="text-zinc-400" />} title={title} right={<StatusMeta it={it} />} onClick={() => setOpen((o) => !o)} open={open} />
      {open && it.result && (
        <div className="border-t border-zinc-800/70">
          {tool === 'describe_table' && !it.result.isError ? <SqlView sql={it.result.content} maxHeight={360} copy={false} /> : <ResultBody it={it} />}
        </div>
      )}
    </Card>
  );
}

function GenericCard({ it, busy, onDecide }: { it: ToolItem; busy: boolean; onDecide: (d: 'approve' | 'reject', feedback?: string) => void }) {
  const { server, tool } = splitToolName(it.name);
  const [open, setOpen] = useState(it.status === 'awaiting_approval');
  return (
    <Card tone={toneFor(it, it.approval !== null)}>
      <CardHead
        icon={<Plug size={14} className="text-zinc-400" />}
        title={tool}
        meta={server ?? undefined}
        right={<StatusMeta it={it} />}
        onClick={() => setOpen((o) => !o)}
        open={open || it.status === 'awaiting_approval'}
      />
      {(open || it.status === 'awaiting_approval') && (
        <>
          {Object.keys(it.args).length > 0 && (
            <Collapsible title="arguments" defaultOpen>
              <pre className="px-4 pb-2.5 text-[12px] leading-[1.7] mono text-zinc-400 whitespace-pre-wrap break-words max-h-60 overflow-y-auto thread-scroll">{JSON.stringify(it.args, null, 2)}</pre>
            </Collapsible>
          )}
          {it.status === 'awaiting_approval' && it.approval && <ApprovalBar approval={it.approval} busy={busy} onDecide={onDecide} />}
          {it.result && (
            <div className="border-t border-zinc-800/70">
              <ResultBody it={it} />
            </div>
          )}
        </>
      )}
    </Card>
  );
}

export function ToolCard({ it, busy, onDecide }: { it: ToolItem; busy: boolean; onDecide: (d: 'approve' | 'reject', feedback?: string) => void }) {
  const { server } = splitToolName(it.name);
  const sql = typeof it.args.sql === 'string' ? it.args.sql : typeof it.args.query === 'string' && server?.startsWith('postgres') ? it.args.query : null;
  if (sql !== null) return <SqlCard it={it} sql={sql} busy={busy} onDecide={onDecide} />;
  if (server === 'memory') return <MemoryLine it={it} />;
  if (server === 'schema') return <SchemaCard it={it} />;
  return <GenericCard it={it} busy={busy} onDecide={onDecide} />;
}
