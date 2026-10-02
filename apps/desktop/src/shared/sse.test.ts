import { describe, expect, it } from 'vitest';
import { SseParser } from './sse';

describe('SseParser', () => {
  it('parses a complete event with id, event and data', () => {
    const p = new SseParser();
    const out = p.feed('id: 3\nevent: token\ndata: {"text":"hi"}\n\n');
    expect(out).toEqual([{ id: '3', event: 'token', data: '{"text":"hi"}' }]);
  });

  it('handles events split across arbitrary chunk boundaries', () => {
    const p = new SseParser();
    const raw = 'id: 1\nevent: step\ndata: {"node":"plan"}\n\nid: 2\nevent: done\ndata: {"status":"completed"}\n\n';
    const events = [];
    for (const ch of raw) events.push(...p.feed(ch));
    expect(events.map((e) => [e.id, e.event])).toEqual([
      ['1', 'step'],
      ['2', 'done'],
    ]);
  });

  it('supports CRLF and lone CR line endings, including CRLF split across chunks', () => {
    const p = new SseParser();
    const a = p.feed('event: message\r');
    const b = p.feed('\ndata: x\r\n\r');
    const c = p.feed('\nevent: token\rdata: y\r\r');
    // A trailing CR is held back until the next byte shows whether it is part of CRLF.
    const d = p.feed(':');
    expect([...a, ...b, ...c, ...d]).toEqual([
      { id: undefined, event: 'message', data: 'x' },
      { id: undefined, event: 'token', data: 'y' },
    ]);
  });

  it('joins multiple data lines, ignores comments and unknown fields, defaults event type', () => {
    const p = new SseParser();
    const out = p.feed(': keep-alive\n\nretry: 1000\nfoo: bar\ndata: line1\ndata:line2\n\n');
    expect(out).toEqual([{ id: undefined, event: 'message', data: 'line1\nline2' }]);
  });

  it('does not dispatch events without data and drops an incomplete trailing event', () => {
    const p = new SseParser();
    expect(p.feed('event: ping\n\n')).toEqual([]);
    expect(p.feed('id: 9\nevent: token\ndata: {"text":"partial"}\n')).toEqual([]);
    expect(p.end()).toEqual([]);
  });

  it('strips a leading BOM and keeps only one leading space of a value', () => {
    const p = new SseParser();
    const out = p.feed('﻿data:  two spaces\n\n');
    expect(out[0].data).toBe(' two spaces');
  });
});
