/**
 * End-to-end test of the main-process backend plumbing (spawn, ready line, bearer auth,
 * HTTP, SSE streaming, approval resume, process-tree kill) against scripts/mock-backend.mjs.
 */
import * as path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { RunEventEnvelope } from '../shared/types';
import { BackendClient, BackendHttpError, RunStreams } from './api';
import { BackendProcess, generateToken, resolveLaunchSpec } from './backend';

const repoRoot = path.resolve(__dirname, '../../../..');
const token = generateToken();
let proc: BackendProcess;
let client: BackendClient;
const logs: string[] = [];

beforeAll(async () => {
  const spec = resolveLaunchSpec(repoRoot, token, { ...process.env, AGENT2DB_BACKEND_CMD: 'mock', MOCK_DELAY_MS: '5' });
  expect(spec.label).toBe('mock backend');
  proc = new BackendProcess(spec, (stream, line) => logs.push(`${stream}: ${line}`), 20_000);
  const port = await proc.start();
  client = new BackendClient(port, token);
});

afterAll(() => {
  proc?.stop();
});

describe('backend plumbing against the mock backend', () => {
  it('parsed the ready line and passed log lines through', () => {
    expect(logs.some((l) => l.includes('ready line parsed'))).toBe(true);
    expect(logs.some((l) => l.startsWith('stdout: mock-backend: starting up'))).toBe(true);
    expect(logs.some((l) => l.startsWith('stderr: '))).toBe(true);
    // The token must never be logged.
    expect(logs.some((l) => l.includes(token))).toBe(false);
  });

  it('reports health', async () => {
    const h = await client.health();
    expect(h.status).toBe('ok');
    expect(h.mcp['postgres-read']).toBe('connected');
  });

  it('rejects requests with the wrong token', async () => {
    const bad = new BackendClient(Number(new URL(client.baseUrl).port), 'nope');
    await expect(bad.health()).rejects.toBeInstanceOf(BackendHttpError);
  });

  it('streams a run through approval to completion', async () => {
    const received: RunEventEnvelope[] = [];
    const streams = new RunStreams(() => client, (e) => received.push(e), () => undefined);

    const { runId, sessionId } = await client.startRun({ message: 'deactivate free users' });
    expect(sessionId).toBeTruthy();
    await streams.follow(runId);

    const types1 = received.map((e) => e.event.type);
    expect(types1).toContain('tool_call');
    expect(types1).toContain('tool_result');
    expect(types1).toContain('approval_required');
    expect(received[received.length - 1].event).toEqual({ type: 'done', status: 'awaiting_approval' });
    const firstCount = received.length;
    const lastSeq = received[firstCount - 1].seq;

    expect(await client.resumeRun({ runId, decision: 'approve' })).toEqual({ ok: true });
    await streams.follow(runId);

    const second = received.slice(firstCount);
    expect(second.length).toBeGreaterThan(0);
    expect(second.every((e) => e.seq > lastSeq)).toBe(true); // resumed after last seen seq, no replays
    expect(second.find((e) => e.event.type === 'tool_result')?.event).toMatchObject({ content: 'UPDATE 2' });
    expect(second[second.length - 1].event).toEqual({ type: 'done', status: 'completed' });

    // Follow-up in the same session is accepted.
    const again = await client.startRun({ message: 'and again', sessionId });
    expect(again.sessionId).toBe(sessionId);
    expect(await client.cancelRun(again.runId)).toEqual({ ok: true });
  });

  it('synthesises a failure for an unknown run', async () => {
    const received: RunEventEnvelope[] = [];
    const streams = new RunStreams(() => client, (e) => received.push(e), () => undefined);
    await streams.follow('does-not-exist');
    expect(received.map((e) => e.event.type)).toEqual(['error', 'done']);
    expect(received[1].event).toEqual({ type: 'done', status: 'failed' });
  });

  it('stop() kills the backend process', async () => {
    const pid = proc.pid!;
    expect(pid).toBeGreaterThan(0);
    proc.stop();
    const alive = (): boolean => {
      try {
        process.kill(pid, 0);
        return true;
      } catch {
        return false;
      }
    };
    for (let i = 0; i < 50 && alive(); i++) await new Promise((r) => setTimeout(r, 100));
    expect(alive()).toBe(false);
    await expect(client.health()).rejects.toThrow();
  });
});
