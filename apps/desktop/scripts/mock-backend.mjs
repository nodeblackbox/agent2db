#!/usr/bin/env node
/**
 * Mock Agent2DB backend implementing the Electron <-> backend contract with no dependencies.
 * Used for UI development and tests while the Python backend is being built.
 *
 * Env: AGENT2DB_PORT (0 = random), AGENT2DB_TOKEN (required), MOCK_DELAY_MS (default 60).
 * Prints `{"ready": true, "port": N}` on stdout once listening. Exits when stdin closes.
 *
 * Every run streams: step, tokens, message, a read tool_call/tool_result (JSON rows), then an
 * approval_required for an UPDATE and done(awaiting_approval). After POST /resume it either
 * executes the "write" (approve) or acknowledges the rejection, then done(completed).
 * A message containing "fail" produces an error + done(failed).
 */
import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';

const TOKEN = process.env.AGENT2DB_TOKEN;
const PORT = Number(process.env.AGENT2DB_PORT ?? '0');
const DELAY = Number(process.env.MOCK_DELAY_MS ?? '60');

if (!TOKEN) {
  console.error('mock-backend: AGENT2DB_TOKEN is required');
  process.exit(2);
}

/** @type {Map<string, {id: string, sessionId: string, events: {seq:number,type:string,data:object}[], listeners: Set<Function>, state: string, cancelled: boolean}>} */
const runs = new Map();
const sessions = new Map(); // session_id -> message count

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function emit(run, type, data) {
  const ev = { seq: run.events.length + 1, type, data };
  run.events.push(ev);
  for (const l of run.listeners) l(ev);
}

async function streamText(run, text) {
  const words = text.split(/(?<= )/);
  for (const w of words) {
    if (run.cancelled) return false;
    emit(run, 'token', { text: w });
    await sleep(DELAY);
  }
  emit(run, 'message', { text });
  return true;
}

function finishIfCancelled(run) {
  if (!run.cancelled) return false;
  if (run.state !== 'done') {
    run.state = 'done';
    emit(run, 'done', { status: 'cancelled' });
  }
  return true;
}

const ROWS = [
  { id: 1, email: 'ada@example.com', plan: 'pro', last_login: '2026-09-30T10:12:00Z', notes: null },
  { id: 2, email: 'grace@example.com', plan: 'free', last_login: '2026-08-02T08:00:00Z', notes: 'trial ended' },
  { id: 3, email: 'linus@example.com', plan: 'free', last_login: '2026-07-14T21:45:00Z', notes: null },
];

async function phaseOne(run, message) {
  emit(run, 'step', { node: 'plan' });
  await sleep(DELAY);
  if (/fail/i.test(message)) {
    emit(run, 'error', { message: 'Mock failure requested by the message.' });
    run.state = 'done';
    emit(run, 'done', { status: 'failed' });
    return;
  }
  const n = sessions.get(run.sessionId) ?? 0;
  if (!(await streamText(run, `Let me look at the **users** table first${n > 1 ? ' (follow-up in the same session)' : ''}.`))) return finishIfCancelled(run);

  emit(run, 'step', { node: 'tools' });
  const readSql = "SELECT id, email, plan, last_login, notes\nFROM public.users\nWHERE plan = 'free'\nORDER BY id\nLIMIT 50;";
  emit(run, 'tool_call', { id: 'call_read_1', name: 'postgres-read__execute_sql', args: { sql: readSql } });
  await sleep(DELAY * 4);
  if (finishIfCancelled(run)) return;
  emit(run, 'tool_result', {
    id: 'call_read_1',
    name: 'postgres-read__execute_sql',
    content: JSON.stringify(ROWS),
    is_error: false,
    truncated: false,
  });

  emit(run, 'step', { node: 'agent' });
  if (!(await streamText(run, 'Found 3 users. I will mark the **free** ones as `inactive` — this needs your approval.'))) return finishIfCancelled(run);

  emit(run, 'step', { node: 'approval' });
  const writeSql = "UPDATE public.users\nSET status = 'inactive'\nWHERE plan = 'free';";
  emit(run, 'approval_required', {
    tool_call_id: 'call_write_1',
    name: 'postgres-write__execute_sql',
    args: { sql: writeSql },
    sql: writeSql,
    statement_types: ['UPDATE'],
    warnings: ['Affects an estimated 2 rows', 'No transaction wrapper requested'],
  });
  run.state = 'awaiting_approval';
  emit(run, 'done', { status: 'awaiting_approval' });
}

async function phaseTwo(run, decision, feedback) {
  run.state = 'running';
  if (decision === 'approve') {
    emit(run, 'step', { node: 'tools' });
    emit(run, 'tool_call', {
      id: 'call_write_1',
      name: 'postgres-write__execute_sql',
      args: { sql: "UPDATE public.users\nSET status = 'inactive'\nWHERE plan = 'free';" },
    });
    await sleep(DELAY * 4);
    if (finishIfCancelled(run)) return;
    emit(run, 'tool_result', { id: 'call_write_1', name: 'postgres-write__execute_sql', content: 'UPDATE 2', is_error: false, truncated: false });
    emit(run, 'step', { node: 'agent' });
    if (!(await streamText(run, 'Done — **2 rows** updated.'))) return finishIfCancelled(run);
  } else {
    emit(run, 'step', { node: 'agent' });
    const why = feedback ? ` You said: "${feedback}".` : '';
    if (!(await streamText(run, `Understood, I did not run the update.${why}`))) return finishIfCancelled(run);
  }
  run.state = 'done';
  emit(run, 'done', { status: 'completed' });
}

// ---------- HTTP ----------

function send(res, status, body) {
  const text = JSON.stringify(body);
  res.writeHead(status, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(text) });
  res.end(text);
}

async function readJson(req) {
  let raw = '';
  for await (const chunk of req) {
    raw += chunk;
    if (raw.length > 1_000_000) throw new Error('body too large');
  }
  if (!raw) return {};
  return JSON.parse(raw);
}

function streamEvents(req, res, run, after) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
  });
  res.write(': connected\n\n');
  let closed = false;
  const write = (ev) => {
    if (closed || ev.seq <= after) return;
    res.write(`id: ${ev.seq}\nevent: ${ev.type}\ndata: ${JSON.stringify(ev.data)}\n\n`);
    if (ev.type === 'done') {
      closed = true;
      run.listeners.delete(write);
      res.end();
    }
  };
  for (const ev of run.events) write(ev);
  if (closed) return;
  run.listeners.add(write);
  req.on('close', () => {
    closed = true;
    run.listeners.delete(write);
  });
}

const server = createServer(async (req, res) => {
  try {
    if (req.headers.authorization !== `Bearer ${TOKEN}`) return send(res, 401, { detail: 'unauthorized' });
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    const parts = url.pathname.split('/').filter(Boolean);

    if (req.method === 'GET' && url.pathname === '/health') {
      return send(res, 200, {
        status: 'ok',
        version: '0.1.0',
        model: 'mock/agent2db-demo',
        mcp: { 'postgres-read': 'connected', 'postgres-write': 'connected', 'agent2db-mcp': 'disabled' },
      });
    }

    if (req.method === 'POST' && url.pathname === '/runs') {
      const body = await readJson(req);
      if (typeof body.message !== 'string' || !body.message.trim()) return send(res, 422, { detail: 'message required' });
      const sessionId = typeof body.session_id === 'string' ? body.session_id : randomUUID();
      sessions.set(sessionId, (sessions.get(sessionId) ?? 0) + 1);
      const run = { id: randomUUID(), sessionId, events: [], listeners: new Set(), state: 'running', cancelled: false };
      runs.set(run.id, run);
      console.log(`mock-backend: run ${run.id} started (session ${sessionId})`);
      setTimeout(() => void phaseOne(run, body.message), DELAY);
      return send(res, 200, { run_id: run.id, session_id: sessionId });
    }

    if (parts[0] === 'runs' && parts.length === 3) {
      const run = runs.get(parts[1]);
      if (!run) return send(res, 404, { detail: 'run not found' });
      const action = parts[2];

      if (req.method === 'GET' && action === 'events') {
        const after = Number(url.searchParams.get('after') ?? '0');
        return streamEvents(req, res, run, Number.isFinite(after) ? after : 0);
      }
      if (req.method === 'POST' && action === 'resume') {
        const body = await readJson(req);
        if (run.state !== 'awaiting_approval') return send(res, 409, { detail: 'run is not awaiting approval' });
        if (body.decision !== 'approve' && body.decision !== 'reject') return send(res, 422, { detail: 'bad decision' });
        setTimeout(() => void phaseTwo(run, body.decision, typeof body.feedback === 'string' ? body.feedback : ''), DELAY);
        return send(res, 200, { ok: true });
      }
      if (req.method === 'POST' && action === 'cancel') {
        run.cancelled = true;
        if (run.state === 'awaiting_approval') {
          run.state = 'done';
          emit(run, 'done', { status: 'cancelled' });
        }
        return send(res, 200, { ok: true });
      }
    }
    return send(res, 404, { detail: 'not found' });
  } catch (e) {
    console.error(`mock-backend: ${e instanceof Error ? e.message : e}`);
    if (!res.headersSent) send(res, 500, { detail: 'internal error' });
  }
});

server.listen(PORT, '127.0.0.1', () => {
  const { port } = server.address();
  console.log('mock-backend: starting up (this line is a log line, not the ready line)');
  console.log(JSON.stringify({ level: 'info', msg: 'json log line that is not the ready line' }));
  console.error('mock-backend: stderr is used for logs too');
  console.log(JSON.stringify({ ready: true, port }));
});

// Exit when the parent goes away.
process.stdin.on('end', () => process.exit(0));
process.stdin.on('error', () => process.exit(0));
process.stdin.resume();
process.on('SIGTERM', () => process.exit(0));
