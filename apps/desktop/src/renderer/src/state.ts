import type { RunEvent, RunEventEnvelope } from '../../shared/types';

export interface ToolResult {
  content: string;
  isError: boolean;
  truncated: boolean;
}

export type ChatItem =
  | { kind: 'user'; id: number; text: string }
  | { kind: 'assistant'; id: number; text: string; streaming: boolean }
  | { kind: 'tool'; id: number; callId: string; name: string; args: Record<string, unknown>; result: ToolResult | null }
  | { kind: 'notice'; id: number; tone: 'error' | 'info'; text: string };

export type ApprovalRequest = Extract<RunEvent, { type: 'approval_required' }>;

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
}

export interface ChatState {
  items: ChatItem[];
  sessionId: string | null;
  /** True between sending a message and the backend accepting the run. */
  starting: boolean;
  run: ActiveRun | null;
  approval: ApprovalRequest | null;
  nextId: number;
  /** Usage of finished runs in this chat; add `run.usage` for the live total. */
  usage: UsageTotals;
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

export type ChatAction =
  | { type: 'user_sent'; text: string }
  | { type: 'run_started'; runId: string; sessionId: string }
  | { type: 'run_start_failed'; message: string }
  | { type: 'event'; env: RunEventEnvelope }
  | { type: 'approval_decided'; decision: 'approve' | 'reject'; feedback?: string }
  | { type: 'local_error'; message: string }
  | { type: 'new_chat' };

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

type NewItem = ChatItem extends infer T ? (T extends ChatItem ? Omit<T, 'id'> : never) : never;

function push(s: ChatState, item: NewItem): ChatState {
  return { ...s, items: [...s.items, { ...item, id: s.nextId } as ChatItem], nextId: s.nextId + 1 };
}

function updateItem(s: ChatState, id: number, fn: (it: ChatItem) => ChatItem): ChatState {
  return { ...s, items: s.items.map((it) => (it.id === id ? fn(it) : it)) };
}

/** Close the current assistant turn: stop the streaming indicator and detach it. */
function closeTurn(s: ChatState): ChatState {
  const run = s.run;
  if (!run || run.turnItemId === null) return s;
  const id = run.turnItemId;
  const s2 = updateItem(s, id, (it) => (it.kind === 'assistant' ? { ...it, streaming: false } : it));
  return { ...s2, run: { ...run, turnItemId: null } };
}

function applyEvent(s: ChatState, ev: RunEvent): ChatState {
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
      return push(s2, { kind: 'tool', callId: ev.id, name: ev.name, args: ev.args, result: null });
    }
    case 'tool_result': {
      const s2 = closeTurn(s);
      const result: ToolResult = { content: ev.content, isError: ev.isError, truncated: ev.truncated };
      const existing = [...s2.items].reverse().find((it) => it.kind === 'tool' && it.callId === ev.id);
      if (existing) return updateItem(s2, existing.id, (it) => (it.kind === 'tool' ? { ...it, result } : it));
      return push(s2, { kind: 'tool', callId: ev.id, name: ev.name, args: {}, result });
    }
    case 'approval_required':
      return { ...closeTurn(s), approval: ev };
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

export function chatReducer(s: ChatState, a: ChatAction): ChatState {
  switch (a.type) {
    case 'user_sent':
      return { ...push(s, { kind: 'user', text: a.text }), starting: true };
    case 'run_started':
      return {
        ...s,
        starting: false,
        sessionId: a.sessionId,
        approval: null,
        run: { runId: a.runId, status: 'running', step: null, lastSeq: -1, turnItemId: null, usage: zeroUsage },
      };
    case 'run_start_failed':
      return push({ ...s, starting: false }, { kind: 'notice', tone: 'error', text: a.message });
    case 'event': {
      const { env } = a;
      if (!s.run || env.runId !== s.run.runId) return s;
      if (env.seq >= 0 && env.seq <= s.run.lastSeq) return s; // duplicate
      const s2 = env.seq >= 0 ? { ...s, run: { ...s.run, lastSeq: env.seq } } : s;
      return applyEvent(s2, env.event);
    }
    case 'approval_decided': {
      if (!s.run) return s;
      const text =
        a.decision === 'approve'
          ? 'Approved.'
          : `Rejected${a.feedback && a.feedback.trim() ? `: ${a.feedback.trim()}` : '.'}`;
      return push({ ...s, approval: null, run: { ...s.run, status: 'running' } }, { kind: 'notice', tone: 'info', text });
    }
    case 'local_error':
      return push(s, { kind: 'notice', tone: 'error', text: a.message });
    case 'new_chat':
      return { ...initialChatState, nextId: s.nextId };
  }
}
