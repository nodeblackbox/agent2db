/**
 * Types and validators shared by main, preload and renderer.
 * Everything crossing a trust boundary (backend -> main, renderer -> main) is validated here.
 */

// ---------- Backend status ----------

export type McpStatusMap = Record<string, string>;

export type BackendStatus =
  | { state: 'starting'; detail?: string }
  | { state: 'ready'; version: string; model: string; mcp: McpStatusMap }
  | { state: 'error'; message: string };

export interface HealthResponse {
  status: string;
  version: string;
  model: string;
  mcp: McpStatusMap;
}

// ---------- Run events ----------

export type RunDoneStatus = 'completed' | 'awaiting_approval' | 'failed' | 'cancelled';

export type RunEvent =
  | { type: 'step'; node: string }
  | { type: 'token'; text: string }
  | { type: 'message'; text: string }
  | { type: 'tool_call'; id: string; name: string; args: Record<string, unknown> }
  | { type: 'tool_result'; id: string; name: string; content: string; isError: boolean; truncated: boolean }
  | {
      type: 'approval_required';
      toolCallId: string;
      name: string;
      args: Record<string, unknown>;
      sql: string | null;
      statementTypes: string[];
      warnings: string[];
    }
  | { type: 'error'; message: string }
  | { type: 'done'; status: RunDoneStatus };

/** What main forwards to the renderer. `seq` is -1 for events synthesised by main. */
export interface RunEventEnvelope {
  runId: string;
  seq: number;
  event: RunEvent;
}

export interface StartRunResult {
  runId: string;
  sessionId: string;
}

// ---------- small guards ----------

const isObj = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);
const isStr = (v: unknown): v is string => typeof v === 'string';
const isStrArray = (v: unknown): v is string[] => Array.isArray(v) && v.every(isStr);

const DONE_STATUSES: readonly RunDoneStatus[] = ['completed', 'awaiting_approval', 'failed', 'cancelled'];

/**
 * Validate an SSE event from the backend. Returns null for unknown types or bad payloads.
 * `data` is the already JSON-parsed payload.
 */
export function parseRunEvent(type: string, data: unknown): RunEvent | null {
  if (!isObj(data)) return null;
  switch (type) {
    case 'step':
      return isStr(data.node) ? { type, node: data.node } : null;
    case 'token':
    case 'message':
      return isStr(data.text) ? { type, text: data.text } : null;
    case 'tool_call':
      if (!isStr(data.id) || !isStr(data.name)) return null;
      return { type, id: data.id, name: data.name, args: isObj(data.args) ? data.args : {} };
    case 'tool_result':
      if (!isStr(data.id) || !isStr(data.name) || !isStr(data.content)) return null;
      return {
        type,
        id: data.id,
        name: data.name,
        content: data.content,
        isError: data.is_error === true,
        truncated: data.truncated === true,
      };
    case 'approval_required':
      if (!isStr(data.tool_call_id) || !isStr(data.name)) return null;
      return {
        type,
        toolCallId: data.tool_call_id,
        name: data.name,
        args: isObj(data.args) ? data.args : {},
        sql: isStr(data.sql) ? data.sql : null,
        statementTypes: isStrArray(data.statement_types) ? data.statement_types : [],
        warnings: isStrArray(data.warnings) ? data.warnings : [],
      };
    case 'error':
      return isStr(data.message) ? { type, message: data.message } : null;
    case 'done':
      return isStr(data.status) && (DONE_STATUSES as readonly string[]).includes(data.status)
        ? { type, status: data.status as RunDoneStatus }
        : null;
    default:
      return null;
  }
}

export function parseHealth(v: unknown): HealthResponse | null {
  if (!isObj(v) || !isStr(v.status)) return null;
  const mcp: McpStatusMap = {};
  if (isObj(v.mcp)) {
    for (const [k, val] of Object.entries(v.mcp)) if (isStr(val)) mcp[k] = val;
  }
  return {
    status: v.status,
    version: isStr(v.version) ? v.version : 'unknown',
    model: isStr(v.model) ? v.model : 'unknown',
    mcp,
  };
}

export function parseStartRunResponse(v: unknown): StartRunResult | null {
  if (!isObj(v) || !isStr(v.run_id) || !isStr(v.session_id)) return null;
  if (!isSafeId(v.run_id) || !isSafeId(v.session_id)) return null;
  return { runId: v.run_id, sessionId: v.session_id };
}

// ---------- IPC argument validation (renderer is untrusted) ----------

export const MAX_MESSAGE_LENGTH = 100_000;
export const MAX_FEEDBACK_LENGTH = 10_000;
const ID_RE = /^[A-Za-z0-9_.:-]{1,200}$/;

export function isSafeId(v: unknown): v is string {
  return isStr(v) && ID_RE.test(v);
}

export interface StartRunArgs {
  message: string;
  sessionId?: string;
  model?: string;
}

export interface ResumeRunArgs {
  runId: string;
  decision: 'approve' | 'reject';
  feedback?: string;
}

export class ValidationError extends Error {}

export function validateStartRunArgs(v: unknown): StartRunArgs {
  if (!isObj(v)) throw new ValidationError('startRun: expected an object');
  const { message, sessionId, model } = v;
  if (!isStr(message) || message.trim().length === 0) throw new ValidationError('startRun: message must be a non-empty string');
  if (message.length > MAX_MESSAGE_LENGTH) throw new ValidationError('startRun: message too long');
  if (sessionId !== undefined && sessionId !== null && !isSafeId(sessionId)) throw new ValidationError('startRun: invalid sessionId');
  if (model !== undefined && model !== null && !(isStr(model) && /^[\w./:@-]{1,200}$/.test(model)))
    throw new ValidationError('startRun: invalid model');
  const out: StartRunArgs = { message };
  if (isStr(sessionId)) out.sessionId = sessionId;
  if (isStr(model)) out.model = model;
  return out;
}

export function validateResumeRunArgs(v: unknown): ResumeRunArgs {
  if (!isObj(v)) throw new ValidationError('resumeRun: expected an object');
  const { runId, decision, feedback } = v;
  if (!isSafeId(runId)) throw new ValidationError('resumeRun: invalid runId');
  if (decision !== 'approve' && decision !== 'reject') throw new ValidationError('resumeRun: invalid decision');
  if (feedback !== undefined && feedback !== null) {
    if (!isStr(feedback) || feedback.length > MAX_FEEDBACK_LENGTH) throw new ValidationError('resumeRun: invalid feedback');
  }
  const out: ResumeRunArgs = { runId, decision };
  if (isStr(feedback) && feedback.trim().length > 0) out.feedback = feedback;
  return out;
}

export function validateRunId(v: unknown): string {
  if (!isSafeId(v)) throw new ValidationError('invalid runId');
  return v;
}

// ---------- IPC channel names ----------

export const IPC = {
  getStatus: 'backend:get-status',
  restartBackend: 'backend:restart',
  statusChanged: 'backend:status',
  startRun: 'run:start',
  resumeRun: 'run:resume',
  cancelRun: 'run:cancel',
  runEvent: 'run:event',
} as const;

/** The API the preload script exposes on `window.agent2db`. */
export interface Agent2DbApi {
  getStatus(): Promise<BackendStatus>;
  restartBackend(): Promise<void>;
  onStatus(cb: (status: BackendStatus) => void): () => void;
  startRun(args: StartRunArgs): Promise<StartRunResult>;
  resumeRun(runId: string, decision: 'approve' | 'reject', feedback?: string): Promise<{ ok: boolean }>;
  cancelRun(runId: string): Promise<{ ok: boolean }>;
  onRunEvent(cb: (env: RunEventEnvelope) => void): () => void;
}
