import { useState } from 'react';
import { MessageSquare, Plus, Search, Trash2 } from 'lucide-react';
import type { SessionSummary } from '../../../shared/types';
import { StatusDot, fmtUsd, fmtWhen } from './primitives';

export function SessionList({
  sessions,
  activeId,
  activeTitle,
  activeStatus,
  onSelect,
  onNew,
  onDelete,
}: {
  sessions: SessionSummary[];
  activeId: string | null;
  activeTitle: string;
  activeStatus: 'running' | 'awaiting_approval' | null;
  onSelect: (id: string) => void;
  onNew: () => void;
  onDelete: (id: string) => void;
}) {
  const [filter, setFilter] = useState('');
  const shown = filter.trim() ? sessions.filter((s) => s.title.toLowerCase().includes(filter.toLowerCase())) : sessions;
  return (
    <div className="shrink-0 border-r border-zinc-800/80 flex flex-col overflow-hidden" style={{ width: 248 }}>
      <div className="flex items-center justify-between px-3 py-2.5 border-b border-zinc-800/80">
        <span className="text-[12px] text-zinc-400">Chats</span>
        <button onClick={onNew} title="New chat" className="text-zinc-500 hover:text-zinc-100 rounded-md p-1 hover:bg-zinc-800/70">
          <Plus size={14} />
        </button>
      </div>
      {sessions.length > 6 && (
        <div className="px-2 pt-2">
          <div className="flex items-center gap-1.5 rounded-lg border border-zinc-800 bg-zinc-950 px-2 py-1">
            <Search size={12} className="text-zinc-600" />
            <input value={filter} onChange={(e) => setFilter(e.target.value)} placeholder="Filter chats" className="flex-1 bg-transparent outline-none text-[12px] text-zinc-200 placeholder-zinc-600" />
          </div>
        </div>
      )}
      <div className="flex-1 overflow-y-auto thread-scroll p-1.5">
        {(activeId === null || !sessions.some((s) => s.id === activeId)) && (
          <div className="rounded-lg px-2.5 py-2 mb-0.5 flex items-center gap-2 bg-zinc-800/70 text-[12.5px] text-zinc-200">
            <StatusDot status={activeStatus === 'running' ? 'running' : activeStatus === 'awaiting_approval' ? 'waiting' : 'idle'} />
            <span className="truncate">{activeTitle || 'New chat'}</span>
          </div>
        )}
        {shown.map((s) => {
          const active = s.id === activeId;
          const status = active ? (activeStatus === 'running' ? 'running' : activeStatus === 'awaiting_approval' ? 'waiting' : 'idle') : 'idle';
          return (
            <div
              key={s.id}
              className={`group w-full rounded-lg px-2.5 py-2 mb-0.5 flex items-start gap-2 cursor-pointer ${active ? 'bg-zinc-800/70' : 'hover:bg-zinc-900'}`}
              onClick={() => onSelect(s.id)}
            >
              <div className="flex-1 min-w-0 flex flex-col gap-0.5">
                <div className="flex items-center gap-2 min-w-0">
                  <StatusDot status={status} />
                  <span className={`text-[12.5px] truncate ${active ? 'text-zinc-100' : 'text-zinc-300'}`}>{s.title}</span>
                </div>
                <span className="text-[11px] text-zinc-600 pl-4 truncate">
                  {fmtWhen(s.updatedAt)} · {s.runCount} {s.runCount === 1 ? 'turn' : 'turns'}
                  {s.costUsd > 0 && ` · ${fmtUsd(s.costUsd)}`}
                </span>
              </div>
              <button
                onClick={(e) => {
                  e.stopPropagation();
                  onDelete(s.id);
                }}
                title="Delete chat"
                className="opacity-0 group-hover:opacity-100 text-zinc-600 hover:text-rose-300 mt-0.5"
              >
                <Trash2 size={12} />
              </button>
            </div>
          );
        })}
        {sessions.length === 0 && activeId !== null && (
          <div className="flex flex-col items-center gap-2 text-center text-[12px] text-zinc-600 py-10 px-4">
            <MessageSquare size={16} className="text-zinc-700" />
            No chats yet.
          </div>
        )}
      </div>
    </div>
  );
}
