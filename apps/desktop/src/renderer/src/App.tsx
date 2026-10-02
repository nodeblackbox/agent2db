import { useCallback, useEffect, useReducer, useRef, useState } from 'react';
import type { BackendStatus } from '../../shared/types';
import { ApprovalDialog } from './components/ApprovalDialog';
import { Composer } from './components/Composer';
import { Header } from './components/Header';
import { Markdown } from './components/Markdown';
import { ToolCard } from './components/ToolCard';
import { chatReducer, formatUsage, initialChatState, isBusy, totalUsage } from './state';

const api = window.agent2db;

const errorMessage = (e: unknown): string => {
  const msg = e instanceof Error ? e.message : String(e);
  // Electron prefixes errors thrown in ipcMain handlers; strip it for display.
  return msg.replace(/^Error invoking remote method '[^']+': (Error: )?/, '');
};

export function App() {
  const [status, setStatus] = useState<BackendStatus>({ state: 'starting' });
  const [chat, dispatch] = useReducer(chatReducer, initialChatState);
  const [deciding, setDeciding] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);
  const stickToBottom = useRef(true);

  useEffect(() => {
    const offStatus = api.onStatus(setStatus);
    const offEvents = api.onRunEvent((env) => dispatch({ type: 'event', env }));
    api.getStatus().then(setStatus).catch(() => undefined);
    return () => {
      offStatus();
      offEvents();
    };
  }, []);

  useEffect(() => {
    const el = scrollRef.current;
    if (el && stickToBottom.current) el.scrollTop = el.scrollHeight;
  }, [chat.items]);

  const onScroll = (): void => {
    const el = scrollRef.current;
    if (el) stickToBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
  };

  const send = useCallback(
    async (text: string) => {
      stickToBottom.current = true;
      dispatch({ type: 'user_sent', text });
      try {
        const r = await api.startRun({ message: text, sessionId: chat.sessionId ?? undefined });
        dispatch({ type: 'run_started', runId: r.runId, sessionId: r.sessionId });
      } catch (e) {
        dispatch({ type: 'run_start_failed', message: errorMessage(e) });
      }
    },
    [chat.sessionId],
  );

  const stop = useCallback(async () => {
    if (!chat.run) return;
    try {
      await api.cancelRun(chat.run.runId);
    } catch (e) {
      dispatch({ type: 'local_error', message: `Cancel failed: ${errorMessage(e)}` });
    }
  }, [chat.run]);

  const decide = useCallback(
    async (decision: 'approve' | 'reject', feedback?: string) => {
      if (!chat.run) return;
      setDeciding(true);
      try {
        await api.resumeRun(chat.run.runId, decision, feedback);
        dispatch({ type: 'approval_decided', decision, feedback });
      } catch (e) {
        dispatch({ type: 'local_error', message: `Could not send decision: ${errorMessage(e)}` });
      } finally {
        setDeciding(false);
      }
    },
    [chat.run],
  );

  const busy = isBusy(chat);
  const usage = totalUsage(chat);
  const ready = status.state === 'ready';
  const awaiting = chat.run?.status === 'awaiting_approval';

  return (
    <div className="app">
      <Header
        status={status}
        onRestart={() => void api.restartBackend()}
        onNewChat={() => dispatch({ type: 'new_chat' })}
        newChatDisabled={busy || chat.items.length === 0}
      />
      {status.state === 'error' && <div className="banner banner-error">{status.message}</div>}

      <main className="chat" ref={scrollRef} onScroll={onScroll}>
        {chat.items.length === 0 && (
          <div className="empty">
            <h1>Ask your database anything</h1>
            <p className="muted">
              The agent explores the schema, writes SQL and runs it. Anything that writes needs your approval.
            </p>
          </div>
        )}
        {chat.items.map((it) => {
          switch (it.kind) {
            case 'user':
              return (
                <div key={it.id} className="msg msg-user">
                  {it.text}
                </div>
              );
            case 'assistant':
              return (
                <div key={it.id} className={`msg msg-assistant ${it.streaming ? 'streaming' : ''}`}>
                  <Markdown text={it.text} />
                </div>
              );
            case 'tool':
              return <ToolCard key={it.id} name={it.name} args={it.args} result={it.result} />;
            case 'notice':
              return (
                <div key={it.id} className={`notice notice-${it.tone}`}>
                  {it.text}
                </div>
              );
          }
        })}
        {busy && !awaiting && (
          <div className="run-status">
            <span className="spinner" /> {chat.starting ? 'Starting…' : chat.run?.step ? `Working: ${chat.run.step}` : 'Working…'}
            {chat.run && chat.run.usage.tokensIn > 0 && <span className="muted"> · {formatUsage(chat.run.usage)}</span>}
          </div>
        )}
        {!busy && chat.items.length > 0 && usage.tokensIn + usage.tokensOut > 0 && (
          <div className="run-status muted" title="Tokens and estimated cost for this chat">
            This chat: {formatUsage(usage)}
          </div>
        )}
      </main>

      <Composer disabled={!ready} running={busy} onSend={(t) => void send(t)} onStop={() => void stop()} />

      {awaiting && <ApprovalDialog key={chat.run?.lastSeq} request={chat.approval} busy={deciding} onDecide={(d, f) => void decide(d, f)} />}
    </div>
  );
}
