/**
 * Types and validators shared by main, preload and renderer.
 * Everything crossing a trust boundary (backend -> main, renderer -> main) is validated here.
 */

// ---------- Backend status ----------

export type McpStatusMap = Record<string, string>;

export interface SchemaIndexStatus {
  tables: number;
  fingerprint: string | null;
  indexedAt: string | null;
  embeddings: boolean;
  embeddingModel: string | null;
  error: string | null;
}

export interface HealthResponse {
  status: string;
  version: string;
  backendId: string | null;
  model: string;
  fallbackModels: string[];
  mcp: McpStatusMap;
  tools: string[];
  store: string;
  checkpointer: string;
  schemaIndex: SchemaIndexStatus;
}

export type BackendStatus =
  | { state: 'starting'; detail?: string }
  | { state: 'ready'; health: HealthResponse }
  | { state: 'error'; message: string };

// ---------- Run events ----------

export type RunDoneStatus = 'completed' | 'awaiting_approval' | 'failed' | 'cancelled';

export interface ApprovalEstimate {
  kind: string;
  rows?: number | null;
  relation?: string | null;
  tables?: Record<string, number | null>;
  reason?: string;
}

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
      tables: string[];
      estimate: ApprovalEstimate | null;
    }
  | { type: 'usage'; tokensIn: number; tokensOut: number; costUsd: number; calls: number; model: string | null }
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

// ---------- Persisted data (read-only views from the backend) ----------

export interface SessionSummary {
  id: string;
  title: string;
  model: string | null;
  createdAt: string;
  updatedAt: string;
  runCount: number;
  tokensIn: number;
  tokensOut: number;
  costUsd: number;
}

/** One persisted event of a session's history; `type: 'user'` rows carry the user's message. */
export interface HistoryEvent {
  runId: string;
  seq: number;
  type: string;
  data: Record<string, unknown>;
}

export interface SchemaTableSummary {
  table: string;
  kind: string;
  rows: number | null;
  columns: number;
}

export interface SchemaSearchHit {
  table: string;
  kind: string;
  score: number;
  rows: number | null;
  comment: string | null;
  columns: string[];
}

export interface SchemaTableDetail {
  table: string;
  kind: string;
  rows: number | null;
  comment: string | null;
  columns: Array<Record<string, unknown>>;
  foreignKeys: Array<Record<string, unknown>>;
  ddl: string;
}

export interface Fact {
  id: number;
  content: string;
  subject: string | null;
  tags: string[];
  source: string;
  createdAt: string;
}

export interface SavedQuery {
  id: number;
  name: string;
  description: string;
  sql: string;
  tables: string[];
  tags: string[];
  useCount: number;
  updatedAt: string;
}

export interface ApprovalRecord {
  id: number;
  runId: string;
  toolName: string;
  sql: string | null;
  statementTypes: string[];
  warnings: string[];
  estimate: ApprovalEstimate | null;
  decision: string | null;
  feedback: string | null;
  requestedAt: string;
  decidedAt: string | null;
}

// ---------- documents (RAG) and database viewer ----------

export interface DocumentInfo {
  id: number;
  name: string;
  kind: string;
  sizeBytes: number;
  status: 'pending' | 'processing' | 'ready' | 'failed';
  error: string | null;
  chunkCount: number;
  charCount: number;
  pages: number | null;
  tags: string[];
  embeddingModel: string | null;
  createdAt: string;
}

export interface DocumentsOverview {
  documents: DocumentInfo[];
  ready: number;
  chunks: number;
  vectorIndex: string;
  embeddingModel: string | null;
  ragEnabled: boolean;
}

export interface ChunkInfo {
  id: number;
  idx: number;
  heading: string | null;
  page: number | null;
  content: string;
  charCount: number;
  embedded: boolean;
}

export interface DocumentDetail extends DocumentInfo {
  chunks: ChunkInfo[];
}

export interface DocumentHit {
  id: number;
  document: string;
  documentId: number;
  heading: string | null;
  page: number | null;
  content: string;
  score: number;
  similarity: number;
}

export interface TableRows {
  table: string;
  columns: string[];
  rows: unknown[][];
  limit: number;
  offset: number;
  total: number | null;
  estimate: number;
}

export interface QueryResult {
  columns: string[];
  rows: unknown[][];
  rowCount: number;
  truncated: boolean;
  ms: number;
  error: string | null;
  statementTypes: string[];
}

export interface ErdResult {
  mermaid: string;
  tables: number;
}

export interface RowsQuery {
  table: string;
  limit?: number;
  offset?: number;
  orderBy?: string;
  desc?: boolean;
  where?: string;
}

/** Bytes handed from the renderer (drag and drop) to main for upload. */
export interface UploadPayload {
  name: string;
  data: ArrayBuffer;
}

// ---------- small guards ----------

const isObj = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);
const isStr = (v: unknown): v is string => typeof v === 'string';
const isStrArray = (v: unknown): v is string[] => Array.isArray(v) && v.every(isStr);
const num = (v: unknown, fallback = 0): number => (typeof v === 'number' && Number.isFinite(v) ? v : typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v)) ? Number(v) : fallback);
const numOrNull = (v: unknown): number | null => (v === null || v === undefined ? null : num(v));
const strOrNull = (v: unknown): string | null => (isStr(v) ? v : null);
const strList = (v: unknown): string[] => (isStrArray(v) ? v : []);

const DONE_STATUSES: readonly RunDoneStatus[] = ['completed', 'awaiting_approval', 'failed', 'cancelled'];

function parseEstimate(v: unknown): ApprovalEstimate | null {
  if (!isObj(v) || !isStr(v.kind)) return null;
  const out: ApprovalEstimate = { kind: v.kind };
  if ('rows' in v) out.rows = numOrNull(v.rows);
  if (isStr(v.relation)) out.relation = v.relation;
  if (isStr(v.reason)) out.reason = v.reason;
  if (isObj(v.tables)) {
    out.tables = {};
    for (const [k, val] of Object.entries(v.tables)) out.tables[k] = numOrNull(val);
  }
  return out;
}

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
        statementTypes: strList(data.statement_types),
        warnings: strList(data.warnings),
        tables: strList(data.tables),
        estimate: parseEstimate(data.estimate),
      };
    case 'usage':
      return {
        type,
        tokensIn: num(data.tokens_in),
        tokensOut: num(data.tokens_out),
        costUsd: num(data.cost_usd),
        calls: num(data.calls),
        model: strOrNull(data.model),
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
  const si = isObj(v.schema_index) ? v.schema_index : {};
  return {
    status: v.status,
    version: isStr(v.version) ? v.version : 'unknown',
    backendId: strOrNull(v.backend_id),
    model: isStr(v.model) ? v.model : 'unknown',
    fallbackModels: strList(v.fallback_models),
    mcp,
    tools: strList(v.tools),
    store: isStr(v.store) ? v.store : 'unknown',
    checkpointer: isStr(v.checkpointer) ? v.checkpointer : 'unknown',
    schemaIndex: {
      tables: num(si.tables),
      fingerprint: strOrNull(si.fingerprint),
      indexedAt: strOrNull(si.indexed_at),
      embeddings: si.embeddings === true,
      embeddingModel: strOrNull(si.embedding_model),
      error: strOrNull(si.error),
    },
  };
}

export function parseStartRunResponse(v: unknown): StartRunResult | null {
  if (!isObj(v) || !isStr(v.run_id) || !isStr(v.session_id)) return null;
  if (!isSafeId(v.run_id) || !isSafeId(v.session_id)) return null;
  return { runId: v.run_id, sessionId: v.session_id };
}

export function parseSessionList(v: unknown): SessionSummary[] {
  if (!Array.isArray(v)) return [];
  const out: SessionSummary[] = [];
  for (const row of v) {
    if (!isObj(row) || !isSafeId(row.id)) continue;
    out.push({
      id: row.id,
      title: isStr(row.title) && row.title.trim() ? row.title : 'New chat',
      model: strOrNull(row.model),
      createdAt: isStr(row.created_at) ? row.created_at : '',
      updatedAt: isStr(row.updated_at) ? row.updated_at : '',
      runCount: num(row.run_count),
      tokensIn: num(row.tokens_in),
      tokensOut: num(row.tokens_out),
      costUsd: num(row.cost_usd),
    });
  }
  return out;
}

export function parseHistory(v: unknown): HistoryEvent[] {
  if (!Array.isArray(v)) return [];
  const out: HistoryEvent[] = [];
  for (const row of v) {
    if (!isObj(row) || !isStr(row.run_id) || !isStr(row.type)) continue;
    out.push({ runId: row.run_id, seq: num(row.seq, -1), type: row.type, data: isObj(row.data) ? row.data : {} });
  }
  return out;
}

export function parseSchemaTables(v: unknown): SchemaTableSummary[] {
  const list = isObj(v) && Array.isArray(v.tables_list) ? v.tables_list : Array.isArray(v) ? v : [];
  const out: SchemaTableSummary[] = [];
  for (const row of list) {
    if (!isObj(row) || !isStr(row.table)) continue;
    out.push({ table: row.table, kind: isStr(row.kind) ? row.kind : 'table', rows: numOrNull(row.rows), columns: num(row.columns) });
  }
  return out;
}

export function parseSchemaSearch(v: unknown): SchemaSearchHit[] {
  if (!Array.isArray(v)) return [];
  const out: SchemaSearchHit[] = [];
  for (const row of v) {
    if (!isObj(row) || !isStr(row.table)) continue;
    out.push({
      table: row.table,
      kind: isStr(row.kind) ? row.kind : 'table',
      score: num(row.score),
      rows: numOrNull(row.rows),
      comment: strOrNull(row.comment),
      columns: strList(row.columns),
    });
  }
  return out;
}

export function parseSchemaTable(v: unknown): SchemaTableDetail | null {
  if (!isObj(v) || !isStr(v.table) || !isStr(v.ddl)) return null;
  return {
    table: v.table,
    kind: isStr(v.kind) ? v.kind : 'table',
    rows: numOrNull(v.rows),
    comment: strOrNull(v.comment),
    columns: Array.isArray(v.columns) ? v.columns.filter(isObj) : [],
    foreignKeys: Array.isArray(v.foreign_keys) ? v.foreign_keys.filter(isObj) : [],
    ddl: v.ddl,
  };
}

export function parseFacts(v: unknown): Fact[] {
  if (!Array.isArray(v)) return [];
  const out: Fact[] = [];
  for (const row of v) {
    if (!isObj(row) || typeof row.id !== 'number' || !isStr(row.content)) continue;
    out.push({
      id: row.id,
      content: row.content,
      subject: strOrNull(row.subject),
      tags: strList(row.tags),
      source: isStr(row.source) ? row.source : 'agent',
      createdAt: isStr(row.created_at) ? row.created_at : '',
    });
  }
  return out;
}

export function parseSavedQueries(v: unknown): SavedQuery[] {
  if (!Array.isArray(v)) return [];
  const out: SavedQuery[] = [];
  for (const row of v) {
    if (!isObj(row) || typeof row.id !== 'number' || !isStr(row.name) || !isStr(row.sql)) continue;
    out.push({
      id: row.id,
      name: row.name,
      description: isStr(row.description) ? row.description : '',
      sql: row.sql,
      tables: strList(row.tables),
      tags: strList(row.tags),
      useCount: num(row.use_count),
      updatedAt: isStr(row.updated_at) ? row.updated_at : '',
    });
  }
  return out;
}

export function parseApprovals(v: unknown): ApprovalRecord[] {
  if (!Array.isArray(v)) return [];
  const out: ApprovalRecord[] = [];
  for (const row of v) {
    if (!isObj(row) || typeof row.id !== 'number' || !isStr(row.run_id) || !isStr(row.tool_name)) continue;
    out.push({
      id: row.id,
      runId: row.run_id,
      toolName: row.tool_name,
      sql: strOrNull(row.sql),
      statementTypes: strList(row.statement_types),
      warnings: strList(row.warnings),
      estimate: parseEstimate(row.estimate),
      decision: strOrNull(row.decision),
      feedback: strOrNull(row.feedback),
      requestedAt: isStr(row.requested_at) ? row.requested_at : '',
      decidedAt: strOrNull(row.decided_at),
    });
  }
  return out;
}

const DOC_STATUSES = ['pending', 'processing', 'ready', 'failed'] as const;

function parseDocument(row: unknown): DocumentInfo | null {
  if (!isObj(row) || typeof row.id !== 'number' || !isStr(row.name)) return null;
  const status = isStr(row.status) && (DOC_STATUSES as readonly string[]).includes(row.status) ? (row.status as DocumentInfo['status']) : 'pending';
  return {
    id: row.id,
    name: row.name,
    kind: isStr(row.kind) ? row.kind : 'text',
    sizeBytes: num(row.size_bytes),
    status,
    error: strOrNull(row.error),
    chunkCount: num(row.chunk_count),
    charCount: num(row.char_count),
    pages: numOrNull(row.pages),
    tags: strList(row.tags),
    embeddingModel: strOrNull(row.embedding_model),
    createdAt: isStr(row.created_at) ? row.created_at : '',
  };
}

export function parseDocumentsOverview(v: unknown): DocumentsOverview {
  const o = isObj(v) ? v : {};
  const documents = Array.isArray(o.documents) ? o.documents.map(parseDocument).filter((d): d is DocumentInfo => d !== null) : [];
  return {
    documents,
    ready: num(o.ready),
    chunks: num(o.chunks),
    vectorIndex: isStr(o.vector_index) ? o.vector_index : 'postgres',
    embeddingModel: strOrNull(o.embedding_model),
    ragEnabled: o.rag_enabled === true,
  };
}

export function parseDocumentDetail(v: unknown): DocumentDetail | null {
  const doc = parseDocument(v);
  if (!doc || !isObj(v)) return null;
  const chunks: ChunkInfo[] = [];
  for (const c of Array.isArray(v.chunks) ? v.chunks : []) {
    if (!isObj(c) || typeof c.id !== 'number' || !isStr(c.content)) continue;
    chunks.push({ id: c.id, idx: num(c.idx), heading: strOrNull(c.heading), page: numOrNull(c.page), content: c.content, charCount: num(c.char_count), embedded: c.embedded === true });
  }
  return { ...doc, chunks };
}

export function parseDocumentHits(v: unknown): DocumentHit[] {
  if (!Array.isArray(v)) return [];
  const out: DocumentHit[] = [];
  for (const h of v) {
    if (!isObj(h) || typeof h.id !== 'number' || !isStr(h.content)) continue;
    out.push({
      id: h.id,
      document: isStr(h.document) ? h.document : '',
      documentId: num(h.document_id),
      heading: strOrNull(h.heading),
      page: numOrNull(h.page),
      content: h.content,
      score: num(h.score),
      similarity: num(h.similarity),
    });
  }
  return out;
}

const cellRows = (v: unknown): unknown[][] => (Array.isArray(v) ? v.filter(Array.isArray).map((r) => [...(r as unknown[])]) : []);

export function parseTableRows(v: unknown): TableRows | null {
  if (!isObj(v) || !isStr(v.table) || !isStrArray(v.columns)) return null;
  return { table: v.table, columns: v.columns, rows: cellRows(v.rows), limit: num(v.limit, 50), offset: num(v.offset), total: numOrNull(v.total), estimate: num(v.estimate) };
}

export function parseQueryResult(v: unknown): QueryResult {
  const o = isObj(v) ? v : {};
  return {
    columns: strList(o.columns),
    rows: cellRows(o.rows),
    rowCount: num(o.row_count),
    truncated: o.truncated === true,
    ms: num(o.ms),
    error: strOrNull(o.error),
    statementTypes: strList(o.statement_types),
  };
}

export function parseErd(v: unknown): ErdResult {
  const o = isObj(v) ? v : {};
  return { mermaid: isStr(o.mermaid) ? o.mermaid : 'erDiagram\n', tables: num(o.tables) };
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
  /** Override the stored RAG setting for this run. */
  rag?: boolean;
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
  if (typeof v.rag === 'boolean') out.rag = v.rag;
  return out;
}

export function validateRowsQuery(v: unknown): RowsQuery {
  if (!isObj(v)) throw new ValidationError('rows: expected an object');
  const { table, limit, offset, orderBy, desc, where } = v;
  if (!isStr(table) || !/^[A-Za-z_][A-Za-z0-9_$]*\.[A-Za-z_][A-Za-z0-9_$]*$/.test(table)) throw new ValidationError('rows: invalid table');
  const out: RowsQuery = { table };
  if (limit !== undefined) {
    if (typeof limit !== 'number' || !Number.isInteger(limit) || limit < 1 || limit > 500) throw new ValidationError('rows: invalid limit');
    out.limit = limit;
  }
  if (offset !== undefined) {
    if (typeof offset !== 'number' || !Number.isInteger(offset) || offset < 0) throw new ValidationError('rows: invalid offset');
    out.offset = offset;
  }
  if (orderBy !== undefined && orderBy !== null) {
    if (!isStr(orderBy) || !/^[A-Za-z_][A-Za-z0-9_$]*$/.test(orderBy)) throw new ValidationError('rows: invalid orderBy');
    out.orderBy = orderBy;
  }
  if (desc !== undefined) out.desc = desc === true;
  if (where !== undefined && where !== null) {
    if (!isStr(where) || where.length > 2000) throw new ValidationError('rows: invalid where');
    if (where.trim()) out.where = where;
  }
  return out;
}

export function validateSql(v: unknown): string {
  if (!isStr(v) || v.trim().length === 0 || v.length > 50_000) throw new ValidationError('invalid sql');
  return v;
}

export const MAX_UPLOAD_BYTES = 50 * 1024 * 1024;

export function validateUpload(v: unknown): UploadPayload {
  if (!isObj(v)) throw new ValidationError('upload: expected an object');
  const { name, data } = v;
  if (!isStr(name) || name.trim().length === 0 || name.length > 255 || /[\\/]/.test(name)) throw new ValidationError('upload: invalid file name');
  if (!(data instanceof ArrayBuffer) && !ArrayBuffer.isView(data)) throw new ValidationError('upload: data must be binary');
  const buffer = data instanceof ArrayBuffer ? data : (data as ArrayBufferView).buffer.slice((data as ArrayBufferView).byteOffset, (data as ArrayBufferView).byteOffset + (data as ArrayBufferView).byteLength);
  if (buffer.byteLength === 0 || buffer.byteLength > MAX_UPLOAD_BYTES) throw new ValidationError('upload: file is empty or larger than 50 MB');
  return { name: name.trim(), data: buffer as ArrayBuffer };
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

export function validateSessionId(v: unknown): string {
  if (!isSafeId(v)) throw new ValidationError('invalid sessionId');
  return v;
}

export function validateQuery(v: unknown): string {
  if (!isStr(v) || v.trim().length === 0 || v.length > 500) throw new ValidationError('invalid query');
  return v.trim();
}

export function validateTableName(v: unknown): string {
  if (!isStr(v) || !/^[A-Za-z0-9_."$ -]{1,200}$/.test(v)) throw new ValidationError('invalid table name');
  return v;
}

export function validateNumericId(v: unknown): number {
  if (typeof v !== 'number' || !Number.isInteger(v) || v <= 0) throw new ValidationError('invalid id');
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
  listSessions: 'sessions:list',
  sessionHistory: 'sessions:history',
  deleteSession: 'sessions:delete',
  schemaTables: 'schema:tables',
  schemaSearch: 'schema:search',
  schemaTable: 'schema:table',
  schemaReindex: 'schema:reindex',
  listFacts: 'memory:facts',
  deleteFact: 'memory:delete-fact',
  listSavedQueries: 'memory:saved-queries',
  deleteSavedQuery: 'memory:delete-saved-query',
  listApprovals: 'approvals:list',
  listDocuments: 'documents:list',
  uploadDocumentsDialog: 'documents:upload-dialog',
  uploadDocument: 'documents:upload',
  documentDetail: 'documents:detail',
  deleteDocument: 'documents:delete',
  searchDocuments: 'documents:search',
  setRag: 'documents:set-rag',
  dbRows: 'db:rows',
  dbQuery: 'db:query',
  dbErd: 'db:erd',
  windowMinimize: 'window:minimize',
  windowMaximize: 'window:maximize',
  windowClose: 'window:close',
  windowState: 'window:state',
} as const;

export interface WindowState {
  maximized: boolean;
  focused: boolean;
}

/** The API the preload script exposes on `window.agent2db`. */
export interface Agent2DbApi {
  getStatus(): Promise<BackendStatus>;
  restartBackend(): Promise<void>;
  onStatus(cb: (status: BackendStatus) => void): () => void;
  startRun(args: StartRunArgs): Promise<StartRunResult>;
  resumeRun(runId: string, decision: 'approve' | 'reject', feedback?: string): Promise<{ ok: boolean }>;
  cancelRun(runId: string): Promise<{ ok: boolean }>;
  onRunEvent(cb: (env: RunEventEnvelope) => void): () => void;
  listSessions(): Promise<SessionSummary[]>;
  sessionHistory(sessionId: string): Promise<HistoryEvent[]>;
  deleteSession(sessionId: string): Promise<{ ok: boolean }>;
  schemaTables(): Promise<SchemaTableSummary[]>;
  schemaSearch(query: string): Promise<SchemaSearchHit[]>;
  schemaTable(name: string): Promise<SchemaTableDetail | null>;
  schemaReindex(): Promise<{ ok: boolean }>;
  listFacts(): Promise<Fact[]>;
  deleteFact(id: number): Promise<{ ok: boolean }>;
  listSavedQueries(): Promise<SavedQuery[]>;
  deleteSavedQuery(id: number): Promise<{ ok: boolean }>;
  listApprovals(): Promise<ApprovalRecord[]>;
  listDocuments(): Promise<DocumentsOverview>;
  /** Opens the OS file picker in main and uploads the chosen files; resolves with the new rows. */
  uploadDocumentsDialog(): Promise<DocumentInfo[]>;
  uploadDocument(payload: UploadPayload): Promise<DocumentInfo | null>;
  documentDetail(id: number): Promise<DocumentDetail | null>;
  deleteDocument(id: number): Promise<{ ok: boolean }>;
  searchDocuments(query: string): Promise<DocumentHit[]>;
  setRag(enabled: boolean): Promise<{ enabled: boolean }>;
  dbRows(query: RowsQuery): Promise<TableRows | null>;
  dbQuery(sql: string): Promise<QueryResult>;
  dbErd(): Promise<ErdResult>;
  windowMinimize(): Promise<void>;
  windowMaximize(): Promise<void>;
  windowClose(): Promise<void>;
  onWindowState(cb: (state: WindowState) => void): () => void;
}
