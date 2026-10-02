import { useCallback, useEffect, useReducer, useRef, useState, type ComponentType } from 'react';
import { Brain, MessageSquare, PanelRight, Plug, Settings as SettingsIcon, ShieldCheck, StopCircle, Table2 } from 'lucide-react';
import type { BackendStatus, SessionSummary, WindowState } from '../../shared/types';
import { Composer } from './components/Composer';
import { RightDrawer, type DrawerTab } from './components/Drawer';
import { ApprovalsPanel, McpPanel, MemoryPanel, SchemaPanel, SettingsPanel } from './components/Panels';
import { SessionList } from './components/SessionList';
import { Timeline } from './components/Timeline';
import { TitleBar } from './components/TitleBar';
import { Btn, StatusDot, fmtDuration } from './components/primitives';
import { chatReducer, initialChatState, isBusy, replayHistory, totalUsage, type ChatAction, type ChatState } from './state';

const api = window.agent2db;

type RailTab = 'chats' | 'schema' | 'tools' | 'memory' | 'approvals' | 'settings';

const RAIL: Array<{ id: RailTab; label: string; icon: ComponentType<{ size?: number }> }> = [
  { id: 'chats', label: 'Chats', icon: MessageSquare },
  { id: 'schema', label: 'Schema', icon: Table2 },
  { id: 'tools', label: 'Tools & MCP', icon: Plug },
  { id: 'memory', label: 'Memory', icon: Brain },
  { id: 'approvals', label: 'Approvals', icon: ShieldCheck },
  { id: 'settings', label: 'Settings', icon: SettingsIcon },
];

const SUGGESTIONS = [
  'What tables do we have and how are they related?',
  'Who are the top 10 customers by revenue?',
  'Show me the row counts of every table',
  'Are there orders with no items?',
];

const errorMessage = (e: unknown): string => {
  const msg = e instanceof Error ? e.message : String(e);
  // Electron prefixes errors thrown in ipcMain handlers; strip it for display.
  return msg.replace(/^Error invoking remote method '[^']+': (Error: )?/, '');
};

function useNow(active: boolean): number {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    if (!active) return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [active]);
  return now;
}

export function App() {
  const [status, setStatus] = useState<BackendStatus>({ state: 'starting' });
  const [win, setWin] = useState<WindowState>({ maximized: false, focused: true });
  const [chat, dispatch] = useReducer((s: ChatState, a: ChatAction) => chatReducer(s, a), initialChatState);
  const [sessions, setSessions] = useState<SessionSummary[]>([]);
  const [rail, setRail] = useState<RailTab>('chats');
  const [sessionsOpen, setSessionsOpen] = useState(true);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [drawerTab, setDrawerTab] = useState<DrawerTab>('schema');
  const [deciding, setDeciding] = useState(false);
  const [refreshKey, setRefreshKey] = useState(0);
  const chatRef = useRef(chat);
  chatRef.current = chat;

  const ready = status.state === 'ready';
  const health = status.state === 'ready' ? status.health : null;
  const busy = isBusy(chat);
  const awaiting = chat.run?.status === 'awaiting_approval';
  const now = useNow(busy);
  const usage = totalUsage(chat);

  const loadSessions = useCallback(() => {
    api
      .listSessions()
      .then(setSessions)
      .catch(() => undefined);
  }, []);

  useEffect(() => {
    const offStatus = api.onStatus(setStatus);
    const offEvents = api.onRunEvent((env) => dispatch({ type: 'event', env }));
    const offWin = api.onWindowState(setWin);
    api.getStatus().then(setStatus).catch(() => undefined);
    return () => {
      offStatus();
      offEvents();
      offWin();
    };
  }, []);

  // Session list and panels refresh when the backend becomes ready and when a run finishes.
  useEffect(() => {
    if (ready) loadSessions();
  }, [ready, loadSessions]);
  const runActive = chat.run !== null;
  useEffect(() => {
    if (!runActive && ready) {
      loadSessions();
      setRefreshKey((k) => k + 1);
    }
  }, [runActive, ready, loadSessions]);

  const send = useCallback(
    async (text: string) => {
      dispatch({ type: 'user_sent', text });
      try {
        const r = await api.startRun({ message: text, sessionId: chatRef.current.sessionId ?? undefined });
        dispatch({ type: 'run_started', runId: r.runId, sessionId: r.sessionId });
        setRail('chats');
      } catch (e) {
        dispatch({ type: 'run_start_failed', message: errorMessage(e) });
      }
    },
    [],
  );

  const stop = useCallback(async () => {
    const run = chatRef.current.run;
    if (!run) return;
    try {
      await api.cancelRun(run.runId);
    } catch (e) {
      dispatch({ type: 'local_error', message: `Cancel failed: ${errorMessage(e)}` });
    }
  }, []);

  const decide = useCallback(async (decision: 'approve' | 'reject', feedback?: string) => {
    const run = chatRef.current.run;
    if (!run) return;
    setDeciding(true);
    try {
      await api.resumeRun(run.runId, decision, feedback);
      dispatch({ type: 'approval_decided', decision, feedback });
    } catch (e) {
      dispatch({ type: 'local_error', message: `Could not send decision: ${errorMessage(e)}` });
    } finally {
      setDeciding(false);
    }
  }, []);

  const openSession = useCallback(async (id: string) => {
    if (chatRef.current.sessionId === id) {
      setRail('chats');
      return;
    }
    try {
      const history = await api.sessionHistory(id);
      dispatch({ type: 'replace', state: replayHistory(id, history) });
      setRail('chats');
    } catch (e) {
      dispatch({ type: 'local_error', message: `Could not open chat: ${errorMessage(e)}` });
    }
  }, []);

  const newChat = useCallback(() => {
    if (isBusy(chatRef.current)) return;
    dispatch({ type: 'new_chat' });
    setRail('chats');
  }, []);

  const deleteSession = useCallback(
    async (id: string) => {
      try {
        await api.deleteSession(id);
        if (chatRef.current.sessionId === id) dispatch({ type: 'new_chat' });
        loadSessions();
      } catch (e) {
        dispatch({ type: 'local_error', message: `Could not delete chat: ${errorMessage(e)}` });
      }
    },
    [loadSessions],
  );

  const onRail = (id: RailTab): void => {
    if (id === 'chats') {
      if (rail === 'chats') setSessionsOpen((o) => !o);
      else setSessionsOpen(true);
    }
    setRail(id);
  };
  const goChat = (): void => setRail('chats');

  const activeSession = sessions.find((s) => s.id === chat.sessionId);
  const title = activeSession?.title ?? (chat.items.find((it) => it.kind === 'user') as { text?: string } | undefined)?.text?.slice(0, 80) ?? '';
  const runLabel = awaiting ? 'Waiting for your approval' : chat.starting ? 'Starting' : busy ? 'Working' : null;

  return (
    <div className="h-screen w-full text-zinc-100 flex flex-col overflow-hidden bg-[#09090b]">
      <TitleBar win={win} title={rail === 'chats' ? title : ''} />
      {status.state === 'error' && (
        <div className="shrink-0 flex items-center gap-3 px-4 py-2 bg-rose-500/10 border-b border-rose-900/50 text-[12.5px] text-rose-200">
          <span className="truncate flex-1">{status.message}</span>
          <Btn variant="danger" size="xs" onClick={() => void api.restartBackend()}>
            Restart backend
          </Btn>
        </div>
      )}
      <div className="flex-1 flex min-h-0 overflow-hidden">
        {/* Rail */}
        <div className="shrink-0 border-r border-zinc-800/80 flex flex-col items-center py-2 gap-0.5" style={{ width: 52 }}>
          {RAIL.map((r) => {
            const Icon = r.icon;
            const active = rail === r.id;
            return (
              <button key={r.id} onClick={() => onRail(r.id)} title={r.label} className={`relative w-10 h-10 rounded-lg flex items-center justify-center transition-colors ${active ? 'text-zinc-100 bg-zinc-800/70' : 'text-zinc-600 hover:text-zinc-300 hover:bg-zinc-900'}`}>
                <Icon size={17} />
                {r.id === 'chats' && busy && <span className={`absolute top-2 right-2 h-1.5 w-1.5 rounded-full ${awaiting ? 'bg-amber-300' : 'bg-[var(--accent)]'}`} />}
              </button>
            );
          })}
          <div className="flex-1" />
          <div className="pb-2" title={status.state === 'ready' ? `Backend v${status.health.version} · ${status.health.model}` : status.state === 'error' ? status.message : 'Starting backend…'}>
            <StatusDot status={status.state === 'ready' ? 'ok' : status.state === 'error' ? 'error' : 'running'} />
          </div>
        </div>

        {/* Sessions list */}
        {rail === 'chats' && sessionsOpen && (
          <SessionList sessions={sessions} activeId={chat.sessionId} activeTitle={title} activeStatus={chat.run?.status ?? null} onSelect={(id) => void openSession(id)} onNew={newChat} onDelete={(id) => void deleteSession(id)} />
        )}

        {/* Main */}
        <div className="flex-1 flex flex-col min-w-0">
          {rail === 'chats' ? (
            <>
              <div className="h-11 shrink-0 flex items-center px-3 gap-2 border-b border-zinc-800/80">
                <span className="text-[12.5px] text-zinc-200 truncate pl-1">{title || 'New chat'}</span>
                {health && <span className="text-[10.5px] rounded-md px-1.5 py-0.5 bg-zinc-900 border border-zinc-800 text-zinc-500 mono shrink-0">{health.model.split('/').pop()}</span>}
                <div className="flex-1" />
                {runLabel && chat.run && (
                  <div className="inline-flex items-center gap-2 text-[11.5px] text-zinc-400 mr-1">
                    <StatusDot status={awaiting ? 'waiting' : 'running'} /> {runLabel} · {fmtDuration(now - chat.run.startedAt)}
                  </div>
                )}
                {busy && !awaiting && (
                  <Btn variant="danger" size="xs" onClick={() => void stop()}>
                    <StopCircle size={12} /> Stop
                  </Btn>
                )}
                <button onClick={() => setDrawerOpen((o) => !o)} title="Toggle side panel" className={`rounded-lg p-1.5 ${drawerOpen ? 'text-zinc-100 bg-zinc-800/70' : 'text-zinc-500 hover:text-zinc-200 hover:bg-zinc-900'}`}>
                  <PanelRight size={15} />
                </button>
              </div>
              <div className="flex-1 flex min-h-0">
                <div className="flex-1 flex flex-col min-w-0">
                  <Timeline chat={chat} deciding={deciding} onDecide={(d, f) => void decide(d, f)} suggestions={ready ? SUGGESTIONS : []} onSuggest={(t) => void send(t)} />
                  <Composer disabled={!ready} running={busy} model={health?.model ?? '…'} usage={usage} onSend={(t) => void send(t)} onStop={() => void stop()} />
                </div>
                {drawerOpen && (
                  <div className="shrink-0 border-l border-zinc-800/80" style={{ width: 380 }}>
                    <RightDrawer tab={drawerTab} setTab={setDrawerTab} onClose={() => setDrawerOpen(false)} refreshKey={refreshKey} />
                  </div>
                )}
              </div>
            </>
          ) : (
            <div className="flex-1 overflow-y-auto thread-scroll">
              {rail === 'schema' && <SchemaPanel onBack={goChat} refreshKey={refreshKey} />}
              {rail === 'tools' && <McpPanel onBack={goChat} health={health} />}
              {rail === 'memory' && <MemoryPanel onBack={goChat} refreshKey={refreshKey} />}
              {rail === 'approvals' && <ApprovalsPanel onBack={goChat} refreshKey={refreshKey} />}
              {rail === 'settings' && <SettingsPanel onBack={goChat} status={status} onRestart={() => void api.restartBackend()} />}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
