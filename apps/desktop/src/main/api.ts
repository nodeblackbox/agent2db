/**
 * HTTP + SSE client for the agent backend. Lives in the main process only: it holds the
 * bearer token, which is never sent to the renderer. Free of Electron imports for testability.
 */
import { SseParser } from '../shared/sse';
import {
  parseHealth,
  parseRunEvent,
  parseStartRunResponse,
  type HealthResponse,
  type ResumeRunArgs,
  type RunDoneStatus,
  type RunEvent,
  type RunEventEnvelope,
  type StartRunArgs,
  type StartRunResult,
} from '../shared/types';

const REQUEST_TIMEOUT_MS = 30_000;

export class BackendHttpError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

export interface StreamOutcome {
  lastSeq: number | null;
  done: RunDoneStatus | null;
}

export class BackendClient {
  readonly baseUrl: string;

  constructor(
    port: number,
    private readonly token: string,
  ) {
    this.baseUrl = `http://127.0.0.1:${port}`;
  }

  private headers(extra: Record<string, string> = {}): Record<string, string> {
    return { Authorization: `Bearer ${this.token}`, ...extra };
  }

  private async requestJson(method: 'GET' | 'POST', path: string, body?: unknown): Promise<unknown> {
    const res = await fetch(this.baseUrl + path, {
      method,
      headers: this.headers(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
      body: body !== undefined ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      redirect: 'error',
    });
    const text = await res.text();
    if (!res.ok) {
      throw new BackendHttpError(`${method} ${path} failed: HTTP ${res.status} ${text.slice(0, 300)}`.trim(), res.status);
    }
    try {
      return JSON.parse(text) as unknown;
    } catch {
      throw new Error(`${method} ${path}: response was not JSON`);
    }
  }

  async health(): Promise<HealthResponse> {
    const h = parseHealth(await this.requestJson('GET', '/health'));
    if (!h) throw new Error('GET /health: unexpected response shape');
    return h;
  }

  async startRun(args: StartRunArgs): Promise<StartRunResult> {
    const body: Record<string, string> = { message: args.message };
    if (args.sessionId) body.session_id = args.sessionId;
    if (args.model) body.model = args.model;
    const r = parseStartRunResponse(await this.requestJson('POST', '/runs', body));
    if (!r) throw new Error('POST /runs: unexpected response shape');
    return r;
  }

  async resumeRun(args: ResumeRunArgs): Promise<{ ok: boolean }> {
    const body: Record<string, string> = { decision: args.decision };
    if (args.feedback) body.feedback = args.feedback;
    const r = await this.requestJson('POST', `/runs/${encodeURIComponent(args.runId)}/resume`, body);
    return { ok: typeof r === 'object' && r !== null && (r as { ok?: unknown }).ok === true };
  }

  async cancelRun(runId: string): Promise<{ ok: boolean }> {
    const r = await this.requestJson('POST', `/runs/${encodeURIComponent(runId)}/cancel`);
    return { ok: typeof r === 'object' && r !== null && (r as { ok?: unknown }).ok === true };
  }

  /**
   * Open the SSE stream for a run and deliver validated events until `done` or EOF.
   * Resolves with the last sequence number seen and the done status (null if the stream
   * ended without one).
   */
  async streamEvents(
    runId: string,
    after: number | null,
    onEvent: (seq: number | null, event: RunEvent) => void,
    signal: AbortSignal,
    onWarn: (msg: string) => void = () => undefined,
  ): Promise<StreamOutcome> {
    const query = after !== null ? `?after=${after}` : '';
    const res = await fetch(`${this.baseUrl}/runs/${encodeURIComponent(runId)}/events${query}`, {
      headers: this.headers({ Accept: 'text/event-stream' }),
      signal,
      redirect: 'error',
    });
    if (!res.ok || !res.body) {
      const text = await res.text().catch(() => '');
      throw new BackendHttpError(`GET events failed: HTTP ${res.status} ${text.slice(0, 300)}`.trim(), res.status);
    }

    const parser = new SseParser();
    const decoder = new TextDecoder();
    const reader = res.body.getReader();
    let lastSeq = after;
    let done: RunDoneStatus | null = null;

    try {
      while (done === null) {
        const { value, done: eof } = await reader.read();
        if (eof) break;
        for (const msg of parser.feed(decoder.decode(value, { stream: true }))) {
          let seq: number | null = null;
          if (msg.id !== undefined && /^\d+$/.test(msg.id)) seq = Number(msg.id);
          if (seq !== null && lastSeq !== null && seq <= lastSeq) continue; // duplicate after reconnect
          let data: unknown;
          try {
            data = JSON.parse(msg.data);
          } catch {
            onWarn(`run ${runId}: event '${msg.event}' had non-JSON data; skipped`);
            continue;
          }
          const ev = parseRunEvent(msg.event, data);
          if (seq !== null) lastSeq = seq;
          if (!ev) {
            onWarn(`run ${runId}: unknown or malformed event '${msg.event}'; skipped`);
            continue;
          }
          onEvent(seq, ev);
          if (ev.type === 'done') {
            done = ev.status;
            break;
          }
        }
      }
    } finally {
      reader.cancel().catch(() => undefined);
    }
    return { lastSeq, done };
  }
}

/**
 * Follows run event streams, remembers the last sequence per run, reconnects on dropped
 * connections, and forwards envelopes via `emit`.
 */
export class RunStreams {
  private readonly lastSeq = new Map<string, number | null>();
  private readonly active = new Map<string, AbortController>();

  constructor(
    private readonly getClient: () => BackendClient | null,
    private readonly emit: (env: RunEventEnvelope) => void,
    private readonly log: (msg: string) => void,
    private readonly maxReconnects = 3,
    private readonly reconnectDelayMs = 500,
  ) {}

  isFollowing(runId: string): boolean {
    return this.active.has(runId);
  }

  /** Start (or continue, after resume) following a run. Resolves when the stream finishes. */
  async follow(runId: string): Promise<void> {
    if (this.active.has(runId)) return;
    const controller = new AbortController();
    this.active.set(runId, controller);
    let failures = 0;
    try {
      while (!controller.signal.aborted) {
        const client = this.getClient();
        if (!client) {
          this.synthFailure(runId, 'Backend is not available.');
          return;
        }
        try {
          const before = this.lastSeq.get(runId) ?? null;
          const outcome = await client.streamEvents(
            runId,
            before,
            (seq, event) => {
              if (seq !== null) this.lastSeq.set(runId, seq);
              this.emit({ runId, seq: seq ?? -1, event });
            },
            controller.signal,
            this.log,
          );
          if (outcome.done !== null) return;
          if (outcome.lastSeq !== before) failures = 0; // made progress
          failures++;
          this.log(`run ${runId}: stream ended without 'done' (attempt ${failures})`);
        } catch (e) {
          if (controller.signal.aborted) return;
          failures++;
          this.log(`run ${runId}: stream error: ${(e as Error).message}`);
          if (e instanceof BackendHttpError && e.status >= 400 && e.status < 500) {
            this.synthFailure(runId, (e as Error).message);
            return;
          }
        }
        if (failures > this.maxReconnects) {
          this.synthFailure(runId, 'Lost connection to the run event stream.');
          return;
        }
        await new Promise((r) => setTimeout(r, this.reconnectDelayMs * failures));
      }
    } finally {
      if (this.active.get(runId) === controller) this.active.delete(runId);
    }
  }

  stopAll(): void {
    for (const c of this.active.values()) c.abort();
    this.active.clear();
  }

  /** Abort every followed run and tell the renderer each one failed (e.g. backend crashed). */
  failAll(message: string): void {
    const runIds = [...this.active.keys()];
    this.stopAll();
    for (const runId of runIds) this.synthFailure(runId, message);
  }

  private synthFailure(runId: string, message: string): void {
    this.emit({ runId, seq: -1, event: { type: 'error', message } });
    this.emit({ runId, seq: -1, event: { type: 'done', status: 'failed' } });
  }
}
