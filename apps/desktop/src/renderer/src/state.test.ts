import { describe, expect, it } from 'vitest';
import type { HistoryEvent, RunEvent } from '../../shared/types';
import { chatReducer, initialChatState, replayHistory, totalUsage, type ChatState, type ToolItem } from './state';

function started(): ChatState {
  let s = chatReducer(initialChatState, { type: 'user_sent', text: 'hi' }, 1000);
  s = chatReducer(s, { type: 'run_started', runId: 'r1', sessionId: 's1' }, 1000);
  return s;
}

function feed(s: ChatState, events: RunEvent[], runId = 'r1', now = 2000): ChatState {
  let seq = 1;
  for (const event of events) s = chatReducer(s, { type: 'event', env: { runId, seq: seq++, event } }, now);
  return s;
}

const tool = (s: ChatState, callId: string): ToolItem => s.items.find((it): it is ToolItem => it.kind === 'tool' && it.callId === callId)!;

describe('chatReducer', () => {
  it('streams tokens into one assistant item and closes it on message', () => {
    const s = feed(started(), [
      { type: 'token', text: 'Hel' },
      { type: 'token', text: 'lo' },
      { type: 'message', text: 'Hello' },
    ]);
    const assistant = s.items.filter((it) => it.kind === 'assistant');
    expect(assistant).toHaveLength(1);
    expect(assistant[0]).toMatchObject({ text: 'Hello', streaming: false });
  });

  it('tracks a tool call through running, result and timing', () => {
    let s = feed(started(), [{ type: 'tool_call', id: 'c1', name: 'postgres-read__execute_sql', args: { sql: 'select 1' } }]);
    expect(tool(s, 'c1')).toMatchObject({ status: 'running', startedAt: 2000, result: null });
    s = feed(s, [{ type: 'tool_result', id: 'c1', name: 'postgres-read__execute_sql', content: '[{"x":1}]', isError: false, truncated: false }], 'r1', 2600);
    // seq restarted at 1 in feed(), so simulate a later seq explicitly
    s = chatReducer(s, { type: 'event', env: { runId: 'r1', seq: 5, event: { type: 'tool_result', id: 'c1', name: 'postgres-read__execute_sql', content: '[{"x":1}]', isError: false, truncated: false } } }, 2600);
    expect(tool(s, 'c1')).toMatchObject({ status: 'done', endedAt: 2600 });
    expect(tool(s, 'c1').result?.content).toBe('[{"x":1}]');
  });

  it('attaches an approval to its tool card and records the decision', () => {
    let s = feed(started(), [
      { type: 'tool_call', id: 'w1', name: 'postgres-write__execute_sql', args: { sql: 'delete from t' } },
      { type: 'approval_required', toolCallId: 'w1', name: 'postgres-write__execute_sql', args: { sql: 'delete from t' }, sql: 'delete from t', statementTypes: ['DELETE'], warnings: ['Planner estimate: ~3 rows affected in t.'], tables: ['t'], estimate: { kind: 'rows', rows: 3, relation: 't' } },
      { type: 'done', status: 'awaiting_approval' },
    ]);
    expect(s.run?.status).toBe('awaiting_approval');
    expect(tool(s, 'w1').status).toBe('awaiting_approval');
    expect(tool(s, 'w1').approval?.estimate).toEqual({ kind: 'rows', rows: 3, relation: 't' });

    s = chatReducer(s, { type: 'approval_decided', decision: 'reject', feedback: ' keep it ' });
    expect(tool(s, 'w1')).toMatchObject({ status: 'rejected', feedback: 'keep it' });
    expect(s.approval).toBeNull();
    expect(s.run?.status).toBe('running');
  });

  it('marks a tool rejected from the backend result text and sums usage on done', () => {
    let s = feed(started(), [
      { type: 'tool_call', id: 'w1', name: 'postgres-write__execute_sql', args: { sql: 'drop table t' } },
      { type: 'usage', tokensIn: 100, tokensOut: 10, costUsd: 0.01, calls: 1, model: 'm' },
      { type: 'tool_result', id: 'w1', name: 'postgres-write__execute_sql', content: 'The user rejected this call. Feedback: no', isError: true, truncated: false },
      { type: 'usage', tokensIn: 250, tokensOut: 30, costUsd: 0.03, calls: 2, model: 'm' },
      { type: 'done', status: 'completed' },
    ]);
    expect(tool(s, 'w1').status).toBe('rejected');
    expect(s.run).toBeNull();
    expect(totalUsage(s)).toEqual({ tokensIn: 250, tokensOut: 30, costUsd: 0.03 });
    s = chatReducer(s, { type: 'run_started', runId: 'r2', sessionId: 's1' });
    s = feed(s, [{ type: 'usage', tokensIn: 50, tokensOut: 5, costUsd: 0.005, calls: 1, model: 'm' }], 'r2');
    const total = totalUsage(s);
    expect(total).toMatchObject({ tokensIn: 300, tokensOut: 35 });
    expect(total.costUsd).toBeCloseTo(0.035, 6);
  });

  it('closes unfinished tools when a run is cancelled', () => {
    const s = feed(started(), [
      { type: 'tool_call', id: 'c1', name: 'postgres-read__execute_sql', args: {} },
      { type: 'done', status: 'cancelled' },
    ]);
    expect(tool(s, 'c1')).toMatchObject({ status: 'rejected' });
    expect(s.items.at(-1)).toMatchObject({ kind: 'notice', text: 'Run cancelled.' });
  });

  it('ignores events for other runs and duplicate sequence numbers', () => {
    let s = started();
    s = chatReducer(s, { type: 'event', env: { runId: 'other', seq: 1, event: { type: 'token', text: 'x' } } });
    expect(s.items).toHaveLength(1);
    s = chatReducer(s, { type: 'event', env: { runId: 'r1', seq: 3, event: { type: 'token', text: 'a' } } });
    s = chatReducer(s, { type: 'event', env: { runId: 'r1', seq: 3, event: { type: 'token', text: 'b' } } });
    expect(s.items.at(-1)).toMatchObject({ kind: 'assistant', text: 'a' });
  });
});

describe('replayHistory', () => {
  const history: HistoryEvent[] = [
    { runId: 'a', seq: 0, type: 'user', data: { text: 'count orders' } },
    { runId: 'a', seq: 1, type: 'tool_call', data: { id: 'x', name: 'postgres-read__execute_sql', args: { sql: 'select count(*) from orders' } } },
    { runId: 'a', seq: 2, type: 'tool_result', data: { id: 'x', name: 'postgres-read__execute_sql', content: '[{"count": 5}]', is_error: false, truncated: false } },
    { runId: 'a', seq: 3, type: 'message', data: { text: 'There are 5 orders.' } },
    { runId: 'a', seq: 4, type: 'usage', data: { tokens_in: 10, tokens_out: 2, cost_usd: 0.001, calls: 1 } },
    { runId: 'a', seq: 5, type: 'done', data: { status: 'completed' } },
    { runId: 'b', seq: 0, type: 'user', data: { text: 'delete them' } },
    { runId: 'b', seq: 1, type: 'tool_call', data: { id: 'w', name: 'postgres-write__execute_sql', args: { sql: 'delete from orders' } } },
    { runId: 'b', seq: 2, type: 'approval_required', data: { tool_call_id: 'w', name: 'postgres-write__execute_sql', args: {}, sql: 'delete from orders', statement_types: ['DELETE'], warnings: [] } },
    { runId: 'b', seq: 3, type: 'done', data: { status: 'awaiting_approval' } },
  ];

  it('rebuilds items from persisted events and keeps a pending approval active', () => {
    const s = replayHistory('s9', history);
    expect(s.sessionId).toBe('s9');
    expect(s.items.map((it) => it.kind)).toEqual(['user', 'tool', 'assistant', 'user', 'tool']);
    expect(tool(s, 'x').status).toBe('done');
    expect(s.usage.tokensIn).toBe(10);
    expect(s.run).toMatchObject({ runId: 'b', status: 'awaiting_approval' });
    expect(s.approval?.toolCallId).toBe('w');
  });

  it('closes a run that never finished as failed', () => {
    const s = replayHistory('s9', [history[0], history[1], { runId: 'c', seq: 0, type: 'user', data: { text: 'next' } }, { runId: 'c', seq: 1, type: 'done', data: { status: 'completed' } }]);
    expect(tool(s, 'x').status).toBe('error');
    expect(s.items.some((it) => it.kind === 'notice' && it.text === 'Run failed.')).toBe(true);
    expect(s.run).toBeNull();
  });
});
