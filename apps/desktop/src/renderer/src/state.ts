import { parseRunEvent, type HistoryEvent, type RunEvent, type RunEventEnvelope } from '../../shared/types';

export interface ToolResult {
  content: string;
  isError: boolean;
  truncated: boolean;
}

export type ApprovalRequest = Extract<RunEvent, { type: 'approval_required' }>;

export type ToolStatus = 'running' | 'awaiting_approval' | 'approved' | 'rejected' | 'done' | 'error';

export interface ToolItem {
  kind: 'tool';
  id: number;
  callId: string;
  name: string;
  args: Record<string, unknown>;
  result: ToolResult | null;
  status: ToolStatus;
  approval: ApprovalRequest | null;
  feedback: string | null;
  startedAt: number;
  endedAt: number | null;
}

export type ChatItem =
  | { kind: 'user'; id: number; text: string }
  | { kind: 'assistant'; id: number; text: string; streaming: boolean }
  | ToolItem
  | { kind: 'notice'; id: number; tone: 'error' | 'info'; text: string };

export interface UsageTotals {
  tokensIn: number;
  tokensOut: number;
  costUsd: number;
}

export const zeroUsage: UsageTotals = { tokensIn: 0, tokensOut: 0, costUsd: 0 };

export interface ActiveRun {
  runId: string;
  status: 'running' | 'awaiting_approval';
  step: string | null;
  lastSeq: number;
  /** Assistant item receiving streamed tokens for the current LLM turn, if any. */
  turnItemId: number | null;
  /** Cumulative usage reported by the backend for this run so far. */
  usage: UsageTotals;
  startedAt: number;
}

export interface ChatState {
  items: ChatItem[];
  sessionId: string | null;
  /** True between sending a message and the backend accepting the run. */
  starting: boolean;
  run: ActiveRun | null;
  /** The approval currently waiting for a decision (also attached to its tool item). */
  approval: ApprovalRequest | null;
  nextId: number;
  /** Usage of finished runs in this chat; add `run.usage` for the live total. */
  usage: UsageTotals;
}

export type ChatAction =
  | { type: 'user_sent'; text: string }
  | { type: 'run_started'; runId: string; sessionId: string }
  | { type: 'run_start_failed'; message: string }
  | { type: 'event'; env: RunEventEnvelope }
  | { type: 'approval_decided'; decision: 'approve' | 'reject'; feedback?: string }
  | { type: 'local_error'; message: string }
  | { type: 'new_chat' }
  | { type: 'replace'; state: ChatState };

export const initialChatState: ChatState = {
  items: [],
  sessionId: null,
  starting: false,
  run: null,
  approval: null,
  nextId: 1,
  usage: zeroUsage,
};

export function isBusy(s: ChatState): boolean {
  return s.starting || s.run !== null;
}

export function totalUsage(s: ChatState): UsageTotals {
  const live = s.run?.usage ?? zeroUsage;
  return {
    tokensIn: s.usage.tokensIn + live.tokensIn,
    tokensOut: s.usage.tokensOut + live.tokensOut,
    costUsd: s.usage.costUsd + live.costUsd,
  };
}

export function formatUsage(u: UsageTotals): string {
  const tokens = u.tokensIn + u.tokensOut;
  const tok = tokens >= 1000 ? `${(tokens / 1000).toFixed(1)}k` : String(tokens);
  const cost = u.costUsd >= 0.01 ? `$${u.costUsd.toFixed(2)}` : u.costUsd > 0 ? `$${u.costUsd.toFixed(4)}` : '$0';
  return `${tok} tokens · ${cost}`;
}

type NewItem = ChatItem extends infer T ? (T extends ChatItem ? Omit<T, 'id'> : never) : never;

function push(s: ChatState, item: NewItem): ChatState {
  return { ...s, items: [...s.items, { ...item, id: s.nextId } as ChatItem], nextId: s.nextId + 1 };
}

function updateItem(s: ChatState, id: number, fn: (it: ChatItem) => ChatItem): ChatState {
  return { ...s, items: s.items.map((it) => (it.id === id ? fn(it) : it)) };
}

function updateTool(s: ChatState, callId: string, fn: (it: ToolItem) => ToolItem): ChatState {
  const existing = [...s.items].reverse().find((it): it is ToolItem => it.kind === 'tool' && it.callId === callId);
  return existing ? updateItem(s, existing.id, (it) => (it.kind === 'tool' ? fn(it) : it)) : s;
}

/** Close the current assistant turn: stop the streaming indicator and detach it. */
function closeTurn(s: ChatState): ChatState {
  const run = s.run;
  if (!run || run.turnItemId === null) return s;
  const id = run.turnItemId;
  const s2 = updateItem(s, id, (it) => (it.kind === 'assistant' ? { ...it, streaming: false } : it));
  return { ...s2, run: { ...run, turnItemId: null } };
}

const REJECTED_PREFIX = 'The user rejected this call.';

function applyEvent(s: ChatState, ev: RunEvent, now: number): ChatState {
  const run = s.run!;
  switch (ev.type) {
    case 'step': {
      const s2 = closeTurn(s);
      return { ...s2, run: { ...s2.run!, step: ev.node } };
    }
    case 'token': {
      if (run.turnItemId !== null) {
        return updateItem(s, run.turnItemId, (it) => (it.kind === 'assistant' ? { ...it, text: it.text + ev.text, streaming: true } : it));
      }
      const id = s.nextId;
      const s2 = push(s, { kind: 'assistant', text: ev.text, streaming: true });
      return { ...s2, run: { ...run, turnItemId: id } };
    }
    case 'message': {
      if (run.turnItemId !== null) {
        const s2 =
          ev.text.length > 0
            ? updateItem(s, run.turnItemId, (it) => (it.kind === 'assistant' ? { ...it, text: ev.text } : it))
            : s;
        return closeTurn(s2);
      }
      if (ev.text.length === 0) return s;
      return push(s, { kind: 'assistant', text: ev.text, streaming: false });
    }
    case 'tool_call': {
      // Keep the turn open: the final `message` for this turn may still arrive.
      const s2 =
        run.turnItemId !== null
          ? updateItem(s, run.turnItemId, (it) => (it.kind === 'assistant' ? { ...it, streaming: false } : it))
          : s;
      return push(s2, {
        kind: 'tool',
        callId: ev.id,
        name: ev.name,
        args: ev.args,
        result: null,
        status: 'running',
        approval: null,
        feedback: null,
        startedAt: now,
        endedAt: null,
      });
    }
    case 'tool_result': {
      const s2 = closeTurn(s);
      const result: ToolResult = { content: ev.content, isError: ev.isError, truncated: ev.truncated };
      const rejected = ev.isError && ev.content.startsWith(REJECTED_PREFIX);
      const existing = [...s2.items].reverse().find((it) => it.kind === 'tool' && it.callId === ev.id);
      const finish = (it: ToolItem): ToolItem => ({
        ...it,
        result,
        endedAt: now,
        status: rejected ? 'rejected' : ev.isError ? 'error' : 'done',
      });
      if (existing) return updateTool(s2, ev.id, finish);
      return push(s2, finish({ kind: 'tool', id: 0, callId: ev.id, name: ev.name, args: {}, result: null, status: 'running', approval: null, feedback: null, startedAt: now, endedAt: null }));
    }
    case 'approval_required': {
      const s2 = closeTurn(s);
      const s3 = updateTool(s2, ev.toolCallId, (it) => ({ ...it, status: 'awaiting_approval', approval: ev }));
      return { ...s3, approval: ev };
    }
    case 'usage':
      // Cumulative for the run, so replace rather than add.
      return { ...s, run: { ...run, usage: { tokensIn: ev.tokensIn, tokensOut: ev.tokensOut, costUsd: ev.costUsd } } };
    case 'error':
      return push(closeTurn(s), { kind: 'notice', tone: 'error', text: ev.message });
    case 'done': {
      const s2 = closeTurn(s);
      if (ev.status === 'awaiting_approval') {
        return { ...s2, run: { ...s2.run!, status: 'awaiting_approval', step: null } };
      }
      const finished = s2.run!.usage;
      let s3: ChatState = {
        ...s2,
        run: null,
        approval: null,
        usage: {
          tokensIn: s2.usage.tokensIn + finished.tokensIn,
          tokensOut: s2.usage.tokensOut + finished.tokensOut,
          costUsd: s2.usage.costUsd + finished.costUsd,
        },
      };
      // Tools still "running" when a run ends did not complete.
      s3 = {
        ...s3,
        items: s3.items.map((it) =>
          it.kind === 'tool' && (it.status === 'running' || it.status === 'awaiting_approval' || it.status === 'approved')
            ? { ...it, status: ev.status === 'cancelled' ? 'rejected' : 'error', endedAt: now, result: it.result ?? { content: ev.status === 'cancelled' ? 'Cancelled.' : 'Not completed.', isError: true, truncated: false } }
            : it,
        ),
      };
      if (ev.status === 'cancelled') s3 = push(s3, { kind: 'notice', tone: 'info', text: 'Run cancelled.' });
      if (ev.status === 'failed') {
        const last = s3.items[s3.items.length - 1];
        if (!(last && last.kind === 'notice' && last.tone === 'error')) {
          s3 = push(s3, { kind: 'notice', tone: 'error', text: 'Run failed.' });
        }
      }
      return s3;
    }
  }
}

export function chatReducer(s: ChatState, a: ChatAction, now: number = Date.now()): ChatState {
  switch (a.type) {
    case 'user_sent':
      return { ...push(s, { kind: 'user', text: a.text }), starting: true };
    case 'run_started':
      return {
        ...s,
        starting: false,
        sessionId: a.sessionId,
        approval: null,
        run: { runId: a.runId, status: 'running', step: null, lastSeq: -1, turnItemId: null, usage: zeroUsage, startedAt: now },
      };
    case 'run_start_failed':
      return push({ ...s, starting: false }, { kind: 'notice', tone: 'error', text: a.message });
    case 'event': {
      const { env } = a;
      if (!s.run || env.runId !== s.run.runId) return s;
      if (env.seq >= 0 && env.seq <= s.run.lastSeq) return s; // duplicate
      const s2 = env.seq >= 0 ? { ...s, run: { ...s.run, lastSeq: env.seq } } : s;
      return applyEvent(s2, env.event, now);
    }
    case 'approval_decided': {
      if (!s.run || !s.approval) return s;
      const feedback = a.feedback && a.feedback.trim() ? a.feedback.trim() : null;
      const s2 = updateTool(s, s.approval.toolCallId, (it) => ({ ...it, status: a.decision === 'approve' ? 'approved' : 'rejected', feedback }));
      return { ...s2, approval: null, run: { ...s2.run!, status: 'running' } };
    }
    case 'local_error':
      return push(s, { kind: 'notice', tone: 'error', text: a.message });
    case 'new_chat':
      return { ...initialChatState, nextId: s.nextId };
    case 'replace':
      return a.state;
  }
}

/**
 * Rebuild a chat from persisted history (one `user` row per run followed by its events).
 * Runs that ended leave no active run; a run that is still awaiting approval stays active so the
 * decision can be made from the reopened chat.
 */
export function replayHistory(sessionId: string, history: HistoryEvent[]): ChatState {
  let s: ChatState = { ...initialChatState, sessionId };
  let currentRun: string | null = null;
  for (const h of history) {
    if (h.type === 'user') {
      // A previous run that never reported `done` (crash) is closed as failed.
      if (s.run) s = chatReducer(s, { type: 'event', env: { runId: s.run.runId, seq: -1, event: { type: 'done', status: 'failed' } } });
      const text = typeof h.data.text === 'string' ? h.data.text : '';
      s = chatReducer(s, { type: 'user_sent', text });
      s = chatReducer(s, { type: 'run_started', runId: h.runId, sessionId });
      currentRun = h.runId;
      continue;
    }
    if (h.runId !== currentRun || !s.run) continue;
    const ev = parseRunEvent(h.type, h.data);
    if (!ev) continue;
    s = chatReducer(s, { type: 'event', env: { runId: h.runId, seq: h.seq, event: ev } });
  }
  return s;
}
