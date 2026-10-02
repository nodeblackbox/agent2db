import { useEffect, useRef, useState, type KeyboardEvent } from 'react';
import { FileText, Send, Sparkles, StopCircle } from 'lucide-react';
import type { UsageTotals } from '../state';
import { fmtTokens, fmtUsd } from './primitives';

export function Composer({
  disabled,
  running,
  model,
  usage,
  rag,
  onToggleRag,
  onSend,
  onStop,
}: {
  disabled: boolean;
  running: boolean;
  model: string;
  usage: UsageTotals;
  /** null until the backend reports the documents overview. */
  rag: { enabled: boolean; documents: number } | null;
  onToggleRag: (enabled: boolean) => void;
  onSend: (text: string) => void;
  onStop: () => void;
}) {
  const [text, setText] = useState('');
  const ref = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, 220)}px`;
  }, [text]);

  const send = (): void => {
    const t = text.trim();
    if (!t || disabled || running) return;
    onSend(t);
    setText('');
  };

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>): void => {
    if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      send();
    }
  };

  const tokens = usage.tokensIn + usage.tokensOut;

  return (
    <div className="shrink-0 px-6 pb-5 pt-2">
      <div className="max-w-3xl mx-auto">
        <div className={`rounded-2xl border bg-zinc-900/70 transition-colors ${disabled ? 'border-zinc-800/60' : 'border-zinc-800 focus-within:border-zinc-600'}`}>
          <textarea
            ref={ref}
            value={text}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={onKeyDown}
            placeholder={disabled ? 'Waiting for the backend…' : running ? 'The agent is working… you can queue your next question after it finishes.' : 'Ask about your data, or tell the agent what to change…'}
            rows={2}
            maxLength={100_000}
            disabled={disabled}
            className="w-full bg-transparent resize-none outline-none text-[13.5px] leading-relaxed text-zinc-100 placeholder-zinc-600 px-4 pt-3.5 pb-2 thread-scroll disabled:opacity-60"
          />
          <div className="flex items-center gap-1 px-2.5 pb-2.5">
            <span className="inline-flex items-center gap-1.5 rounded-lg px-2 py-1 text-[11.5px] text-zinc-500 min-w-0" title={`Model used for this chat: ${model} (AGENT2DB_MODEL)`}>
              <Sparkles size={12} className="text-indigo-300 shrink-0" />
              <span className="mono truncate max-w-[220px]">{model.split('/').pop()}</span>
            </span>
            {rag && (
              <button
                onClick={() => onToggleRag(!rag.enabled)}
                title={
                  rag.enabled
                    ? `RAG on: passages from your ${rag.documents} ready document${rag.documents === 1 ? '' : 's'} are added to each request. Click to turn off.`
                    : rag.documents > 0
                      ? `RAG off: ${rag.documents} document${rag.documents === 1 ? '' : 's'} available. Click to use them in answers.`
                      : 'No documents uploaded yet (Documents panel).'
                }
                className={`inline-flex items-center gap-1.5 rounded-lg px-2 py-1 text-[11.5px] transition-colors ${rag.enabled ? 'bg-indigo-500/15 text-indigo-200' : 'text-zinc-500 hover:text-zinc-200 hover:bg-zinc-800/60'}`}
              >
                <FileText size={12} />
                RAG {rag.enabled ? 'on' : 'off'}
                {rag.documents > 0 && <span className="text-[10.5px] opacity-70">· {rag.documents}</span>}
              </button>
            )}
            <div className="flex-1" />
            {tokens > 0 && (
              <span className="text-[11px] text-zinc-600 mr-2 mono whitespace-nowrap" title={`${fmtTokens(usage.tokensIn)} in · ${fmtTokens(usage.tokensOut)} out`}>
                {fmtUsd(usage.costUsd)} · {fmtTokens(tokens)} tok
              </span>
            )}
            <span className="text-[11px] text-zinc-700 mr-2 whitespace-nowrap hidden lg:inline">Enter to send · Shift+Enter for a new line</span>
            {running ? (
              <button onClick={onStop} className="inline-flex items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-[12px] bg-rose-500/10 border border-rose-900/50 text-rose-300 hover:bg-rose-500/15">
                <StopCircle size={13} /> Stop
              </button>
            ) : (
              <button onClick={send} disabled={disabled || !text.trim()} title="Send" className={`rounded-lg p-2 transition-colors ${text.trim() && !disabled ? 'bg-zinc-100 text-zinc-950 hover:bg-white' : 'bg-zinc-800 text-zinc-600'}`}>
                <Send size={14} />
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
