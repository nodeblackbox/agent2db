import { useEffect, useRef, type ReactNode } from 'react';
import { AlertTriangle, Bot, Database, Loader2, Shield } from 'lucide-react';
import type { ChatItem, ChatState } from '../state';
import { Markdown } from './Markdown';
import { Card, CardHead } from './primitives';
import { ToolCard } from './ToolCard';

function UserMessage({ text }: { text: string }) {
  return (
    <div className="flex justify-end">
      <div className="max-w-[78%] rounded-2xl rounded-br-md bg-zinc-800/80 px-4 py-2.5 text-[13.5px] leading-relaxed text-zinc-100 whitespace-pre-wrap break-words">{text}</div>
    </div>
  );
}

function AssistantText({ text, streaming }: { text: string; streaming: boolean }) {
  return (
    <div className="flex items-start gap-3">
      <div className="mt-0.5 shrink-0 h-6 w-6 rounded-lg bg-zinc-800 flex items-center justify-center">
        <Bot size={13} className="text-zinc-300" />
      </div>
      <div className={`flex-1 min-w-0 ${streaming ? 'cursor' : ''}`}>
        <Markdown text={text} />
      </div>
    </div>
  );
}

const STEP_LABEL: Record<string, string> = {
  retrieve_context: 'Reading the schema…',
  index_schema: 'Indexing the schema…',
  agent: 'Thinking…',
  approval: 'Waiting for approval…',
  tools: 'Running tools…',
};

export function Timeline({ chat, deciding, onDecide, suggestions, onSuggest }: { chat: ChatState; deciding: boolean; onDecide: (d: 'approve' | 'reject', feedback?: string) => void; suggestions: string[]; onSuggest: (text: string) => void }) {
  const ref = useRef<HTMLDivElement>(null);
  const stick = useRef(true);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const atBottom = (): boolean => el.scrollHeight - el.scrollTop - el.clientHeight < 80;
    // Only a deliberate scroll up (wheel, touch, keys) releases the stick; a plain scroll event can
    // also come from the browser's own scroll anchoring when content is inserted.
    const onWheel = (e: WheelEvent): void => {
      if (e.deltaY < 0) stick.current = false;
    };
    const onTouch = (): void => {
      stick.current = false;
    };
    const onKey = (e: KeyboardEvent): void => {
      if (['ArrowUp', 'PageUp', 'Home'].includes(e.key)) stick.current = false;
    };
    const onScroll = (): void => {
      if (atBottom()) stick.current = true;
    };
    el.addEventListener('wheel', onWheel, { passive: true });
    el.addEventListener('touchmove', onTouch, { passive: true });
    el.addEventListener('keydown', onKey);
    el.addEventListener('scroll', onScroll, { passive: true });
    return () => {
      el.removeEventListener('wheel', onWheel);
      el.removeEventListener('touchmove', onTouch);
      el.removeEventListener('keydown', onKey);
      el.removeEventListener('scroll', onScroll);
    };
  }, []);
  useEffect(() => {
    const el = ref.current;
    if (el && stick.current) el.scrollTop = el.scrollHeight;
  });

  const streaming = chat.items.some((it) => it.kind === 'assistant' && it.streaming);
  const toolRunning = chat.items.some((it) => it.kind === 'tool' && (it.status === 'running' || it.status === 'approved'));
  const waiting = chat.run?.status === 'running' && !streaming && !toolRunning;

  const render = (it: ChatItem): ReactNode => {
    switch (it.kind) {
      case 'user':
        return <UserMessage text={it.text} />;
      case 'assistant':
        return <AssistantText text={it.text} streaming={it.streaming} />;
      case 'tool':
        return <ToolCard it={it} busy={deciding} onDecide={onDecide} />;
      case 'notice':
        return it.tone === 'error' ? (
          <Card tone="error">
            <CardHead icon={<AlertTriangle size={14} className="text-rose-400" />} title="Error" />
            <pre className="px-4 pb-3 text-[12px] leading-[1.7] mono whitespace-pre-wrap break-words text-rose-300/90">{it.text}</pre>
          </Card>
        ) : (
          <div className="flex items-center gap-2 pl-4 text-[12px] text-zinc-500">
            <Shield size={12} />
            <span>{it.text}</span>
          </div>
        );
    }
  };

  return (
    <div ref={ref} tabIndex={-1} className="flex-1 overflow-y-auto thread-scroll px-6 py-6 outline-none [overflow-anchor:none]">
      <div className="max-w-3xl mx-auto flex flex-col gap-3">
        {chat.items.length === 0 && (
          <div className="flex flex-col items-center justify-center text-center gap-3 py-24">
            <div className="h-11 w-11 rounded-xl bg-zinc-900 border border-zinc-800 flex items-center justify-center">
              <Database size={17} className="text-zinc-500" />
            </div>
            <div className="text-[14px] text-zinc-200">Ask your database anything</div>
            <div className="text-[12.5px] text-zinc-500 max-w-md">
              The agent reads the schema, writes and runs SQL, and explains what it found. Anything that writes pauses here for your approval.
            </div>
            {suggestions.length > 0 && (
              <div className="flex flex-wrap justify-center gap-2 mt-2 max-w-xl">
                {suggestions.map((s) => (
                  <button key={s} onClick={() => onSuggest(s)} className="text-[12px] rounded-full border border-zinc-800 bg-zinc-900/60 px-3 py-1.5 text-zinc-400 hover:text-zinc-100 hover:border-zinc-700">
                    {s}
                  </button>
                ))}
              </div>
            )}
          </div>
        )}
        {chat.items.map((it) => (
          <div key={it.id}>{render(it)}</div>
        ))}
        {(waiting || chat.starting) && (
          <div className="flex items-center gap-2 pl-1 text-[12px] text-zinc-500">
            <Loader2 size={12} className="animate-spin" /> {chat.starting ? 'Starting…' : STEP_LABEL[chat.run?.step ?? ''] ?? 'Waiting for the model…'}
          </div>
        )}
      </div>
    </div>
  );
}
