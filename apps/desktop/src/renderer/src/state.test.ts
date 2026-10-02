import { describe, expect, it } from 'vitest';
import type { RunEvent } from '../../shared/types';
import { chatReducer, initialChatState, isBusy, type ChatState } from './state';

const RUN = 'run-1';

function started(): ChatState {
  let s = chatReducer(initialChatState, { type: 'user_sent', text: 'how many users?' });
  s = chatReducer(s, { type: 'run_started', runId: RUN, sessionId: 'sess-1' });
  return s;
}

function feed(s: ChatState, events: RunEvent[], startSeq = 1, runId = RUN): ChatState {
  return events.reduce((acc, event, i) => chatReducer(acc, { type: 'event', env: { runId, seq: startSeq + i, event } }), s);
}

describe('chatReducer', () => {
  it('streams tokens into one assistant item and replaces them with the final message', () => {
    let s = feed(started(), [
      { type: 'step', node: 'agent' },
      { type: 'token', text: 'Hel' },
      { type: 'token', text: 'lo' },
    ]);
    const streaming = s.items[1];
    expect(streaming).toMatchObject({ kind: 'assistant', text: 'Hello', streaming: true });
    s = feed(s, [{ type: 'message', text: 'Hello, world.' }], 4);
    expect(s.items[1]).toMatchObject({ kind: 'assistant', text: 'Hello, world.', streaming: false });
    expect(s.items).toHaveLength(2);
  });

  it('attaches tool results to their call and starts a new assistant turn afterwards', () => {
    const s = feed(started(), [
      { type: 'token', text: 'Checking' },
      { type: 'tool_call', id: 'c1', name: 'pg__execute_sql', args: { sql: 'SELECT 1' } },
      { type: 'message', text: 'Checking the table.' },
      { type: 'tool_result', id: 'c1', name: 'pg__execute_sql', content: '[{"n":1}]', isError: false, truncated: false },
      { type: 'token', text: 'There is 1.' },
    ]);
    expect(s.items.map((i) => i.kind)).toEqual(['user', 'assistant', 'tool', 'assistant']);
    expect(s.items[1]).toMatchObject({ text: 'Checking the table.' });
    expect(s.items[2]).toMatchObject({ callId: 'c1', result: { content: '[{"n":1}]' } });
    expect(s.items[3]).toMatchObject({ text: 'There is 1.', streaming: true });
  });

  it('handles the approval flow: awaiting, decision, completion', () => {
    let s = feed(started(), [
      {
        type: 'approval_required',
        toolCallId: 'w1',
        name: 'postgres-write__execute_sql',
        args: {},
        sql: 'UPDATE t SET x = 1',
        statementTypes: ['UPDATE'],
        warnings: [],
      },
      { type: 'done', status: 'awaiting_approval' },
    ]);
    expect(s.run?.status).toBe('awaiting_approval');
    expect(s.approval?.sql).toBe('UPDATE t SET x = 1');
    expect(isBusy(s)).toBe(true);

    s = chatReducer(s, { type: 'approval_decided', decision: 'reject', feedback: 'too risky' });
    expect(s.approval).toBeNull();
    expect(s.run?.status).toBe('running');
    expect(s.items[s.items.length - 1]).toMatchObject({ kind: 'notice', text: 'Rejected: too risky' });

    s = feed(s, [{ type: 'message', text: 'Ok.' }, { type: 'done', status: 'completed' }], 3);
    expect(s.run).toBeNull();
    expect(isBusy(s)).toBe(false);
    expect(s.sessionId).toBe('sess-1');
  });

  it('ignores duplicate sequence numbers and events for other runs', () => {
    let s = feed(started(), [{ type: 'token', text: 'a' }]);
    s = chatReducer(s, { type: 'event', env: { runId: RUN, seq: 1, event: { type: 'token', text: 'a' } } });
    s = chatReducer(s, { type: 'event', env: { runId: 'other', seq: 2, event: { type: 'token', text: 'zzz' } } });
    expect(s.items[1]).toMatchObject({ text: 'a' });
  });

  it('records failures once and ends the run', () => {
    const s = feed(started(), [
      { type: 'error', message: 'boom' },
      { type: 'done', status: 'failed' },
    ]);
    expect(s.run).toBeNull();
    expect(s.items.filter((i) => i.kind === 'notice')).toHaveLength(1);
  });

  it('new chat clears messages and the session id', () => {
    let s = feed(started(), [{ type: 'done', status: 'completed' }]);
    s = chatReducer(s, { type: 'new_chat' });
    expect(s.items).toEqual([]);
    expect(s.sessionId).toBeNull();
  });
});
