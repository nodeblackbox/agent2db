import { describe, expect, it } from 'vitest';
import {
  ValidationError,
  parseHealth,
  parseRunEvent,
  parseStartRunResponse,
  validateResumeRunArgs,
  validateRunId,
  validateStartRunArgs,
} from './types';

describe('parseRunEvent', () => {
  it('maps backend snake_case payloads to typed events', () => {
    expect(
      parseRunEvent('tool_result', { id: 'c1', name: 'pg__execute_sql', content: '[]', is_error: true, truncated: false }),
    ).toEqual({ type: 'tool_result', id: 'c1', name: 'pg__execute_sql', content: '[]', isError: true, truncated: false });

    expect(
      parseRunEvent('approval_required', {
        tool_call_id: 't1',
        name: 'postgres-write__execute_sql',
        args: { sql: 'DELETE FROM x' },
        sql: 'DELETE FROM x',
        statement_types: ['DELETE'],
        warnings: ['no WHERE clause'],
      }),
    ).toEqual({
      type: 'approval_required',
      toolCallId: 't1',
      name: 'postgres-write__execute_sql',
      args: { sql: 'DELETE FROM x' },
      sql: 'DELETE FROM x',
      statementTypes: ['DELETE'],
      warnings: ['no WHERE clause'],
      tables: [],
      estimate: null,
    });
    expect(
      parseRunEvent('approval_required', { tool_call_id: 't', name: 'n', tables: ['x'], estimate: { kind: 'rows', rows: 3, relation: 'x' } }),
    ).toMatchObject({ tables: ['x'], estimate: { kind: 'rows', rows: 3, relation: 'x' } });
    expect(parseRunEvent('usage', { tokens_in: 10, tokens_out: '5', cost_usd: 0.01, calls: 1, model: 'm' })).toEqual({
      type: 'usage',
      tokensIn: 10,
      tokensOut: 5,
      costUsd: 0.01,
      calls: 1,
      model: 'm',
    });
  });

  it('tolerates optional fields but rejects malformed or unknown events', () => {
    expect(parseRunEvent('approval_required', { tool_call_id: 't', name: 'n', sql: null })).toMatchObject({
      sql: null,
      statementTypes: [],
      warnings: [],
      args: {},
    });
    expect(parseRunEvent('token', { text: 5 })).toBeNull();
    expect(parseRunEvent('done', { status: 'exploded' })).toBeNull();
    expect(parseRunEvent('surprise', { text: 'x' })).toBeNull();
    expect(parseRunEvent('step', 'not an object')).toBeNull();
    expect(parseRunEvent('done', { status: 'awaiting_approval' })).toEqual({ type: 'done', status: 'awaiting_approval' });
  });
});

describe('response parsers', () => {
  it('parses health and drops non-string MCP statuses', () => {
    const h = parseHealth({ status: 'ok', version: '0.1.0', model: 'm', mcp: { a: 'connected', b: 3 }, tools: ['x__y', 1], schema_index: { tables: '17', embeddings: true } });
    expect(h).toMatchObject({ status: 'ok', version: '0.1.0', model: 'm', mcp: { a: 'connected' }, tools: [], store: 'unknown', backendId: null });
    expect(h?.schemaIndex).toMatchObject({ tables: 17, embeddings: true, embeddingModel: null });
    expect(parseHealth(null)).toBeNull();
  });

  it('parses start-run responses and rejects unsafe ids', () => {
    expect(parseStartRunResponse({ run_id: 'r-1', session_id: 's_1' })).toEqual({ runId: 'r-1', sessionId: 's_1' });
    expect(parseStartRunResponse({ run_id: '../../etc', session_id: 's' })).toBeNull();
  });
});

describe('IPC validators', () => {
  it('accepts valid startRun args and strips unknown keys', () => {
    expect(validateStartRunArgs({ message: 'hi', sessionId: 'abc-123', extra: 'x' })).toEqual({ message: 'hi', sessionId: 'abc-123' });
    expect(validateStartRunArgs({ message: 'hi', sessionId: undefined })).toEqual({ message: 'hi' });
  });

  it('rejects bad startRun args', () => {
    expect(() => validateStartRunArgs(null)).toThrow(ValidationError);
    expect(() => validateStartRunArgs({ message: '   ' })).toThrow(ValidationError);
    expect(() => validateStartRunArgs({ message: 'x'.repeat(100_001) })).toThrow(ValidationError);
    expect(() => validateStartRunArgs({ message: 'hi', sessionId: 'a/b' })).toThrow(ValidationError);
    expect(() => validateStartRunArgs({ message: 'hi', model: 'bad model; rm' })).toThrow(ValidationError);
  });

  it('validates resume and run ids', () => {
    expect(validateResumeRunArgs({ runId: 'r1', decision: 'reject', feedback: 'no' })).toEqual({
      runId: 'r1',
      decision: 'reject',
      feedback: 'no',
    });
    expect(validateResumeRunArgs({ runId: 'r1', decision: 'approve', feedback: '  ' })).toEqual({ runId: 'r1', decision: 'approve' });
    expect(() => validateResumeRunArgs({ runId: 'r1', decision: 'maybe' })).toThrow(ValidationError);
    expect(() => validateResumeRunArgs({ runId: 'r 1', decision: 'approve' })).toThrow(ValidationError);
    expect(() => validateRunId(42)).toThrow(ValidationError);
    expect(validateRunId('2f6c-11')).toBe('2f6c-11');
  });
});

describe('documents and viewer parsers', () => {
  it('parses the documents overview and tolerates bad rows', async () => {
    const { parseDocumentsOverview, parseTableRows, parseQueryResult, validateRowsQuery, validateUpload } = await import('./types');
    const o = parseDocumentsOverview({ documents: [{ id: 1, name: 'a.md', kind: 'markdown', size_bytes: 10, status: 'ready', chunk_count: 2 }, { bogus: true }], ready: 1, chunks: 2, vector_index: 'postgres', rag_enabled: true });
    expect(o.documents).toHaveLength(1);
    expect(o.documents[0]).toMatchObject({ id: 1, status: 'ready', chunkCount: 2, tags: [] });
    expect(o.ragEnabled).toBe(true);

    expect(parseTableRows({ table: 'public.t', columns: ['a'], rows: [[1], 'x', [null]], total: '12', estimate: 12 })).toEqual({ table: 'public.t', columns: ['a'], rows: [[1], [null]], limit: 50, offset: 0, total: 12, estimate: 12 });
    expect(parseQueryResult({ columns: ['n'], rows: [[1]], row_count: 1, ms: 3, statement_types: ['SELECT'] })).toMatchObject({ rowCount: 1, error: null, statementTypes: ['SELECT'] });

    expect(validateRowsQuery({ table: 'public.orders', limit: 25, orderBy: 'id', desc: true, where: "status = 'paid'" })).toEqual({ table: 'public.orders', limit: 25, orderBy: 'id', desc: true, where: "status = 'paid'" });
    expect(() => validateRowsQuery({ table: 'orders' })).toThrow();
    expect(() => validateRowsQuery({ table: 'public.orders', orderBy: 'id; drop' })).toThrow();
    expect(() => validateRowsQuery({ table: 'public.orders', limit: 5000 })).toThrow();

    expect(validateUpload({ name: 'notes.md', data: new Uint8Array([1, 2, 3]) }).data.byteLength).toBe(3);
    expect(() => validateUpload({ name: '../x.md', data: new ArrayBuffer(3) })).toThrow();
    expect(() => validateUpload({ name: 'x.md', data: new ArrayBuffer(0) })).toThrow();
  });
});
