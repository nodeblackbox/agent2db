/**
 * Browser preview bridge. When the renderer runs in a plain browser (no Electron preload, so no
 * `window.agent2db`), install a scripted fake so the UI can be developed and screenshotted at the
 * Vite dev URL. Never bundled into production: main.tsx only imports it under `import.meta.env.DEV`.
 */
import type { Agent2DbApi, BackendStatus, HistoryEvent, RunEventEnvelope, SessionSummary, WindowState } from '../../shared/types';

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

export function installDevBridge(): void {
  if (window.agent2db) return;
  const statusListeners = new Set<(s: BackendStatus) => void>();
  const eventListeners = new Set<(e: RunEventEnvelope) => void>();
  const winListeners = new Set<(w: WindowState) => void>();
  let status: BackendStatus = { state: 'starting' };
  let ragOn = false;
  const sessions: SessionSummary[] = [
    { id: 'demo-1', title: 'Top customers by revenue last month', model: 'anthropic/claude-sonnet-5-5', createdAt: new Date(Date.now() - 3600e3).toISOString(), updatedAt: new Date(Date.now() - 1200e3).toISOString(), runCount: 3, tokensIn: 41000, tokensOut: 1200, costUsd: 0.14 },
    { id: 'demo-2', title: 'Mark accessories inactive', model: 'anthropic/claude-sonnet-5-5', createdAt: new Date(Date.now() - 86400e3).toISOString(), updatedAt: new Date(Date.now() - 80000e3).toISOString(), runCount: 1, tokensIn: 19000, tokensOut: 300, costUsd: 0.06 },
  ];
  const health: BackendStatus = {
    state: 'ready',
    health: {
      status: 'ok',
      version: '0.2.0',
      backendId: 'deadbeefcafe',
      model: 'anthropic/claude-sonnet-5-5',
      fallbackModels: ['openai/gpt-5-mini'],
      mcp: { 'postgres-read': 'connected', 'postgres-write': 'connected', agent2db: 'disabled' },
      tools: ['postgres-read__execute_sql', 'postgres-read__list_objects', 'postgres-read__explain_query', 'postgres-write__execute_sql', 'schema__describe_table', 'schema__search_tables', 'memory__remember', 'memory__recall', 'memory__save_query', 'memory__search_saved_queries'],
      store: 'connected',
      checkpointer: 'postgres',
      schemaIndex: { tables: 17, fingerprint: 'abc', indexedAt: new Date().toISOString(), embeddings: true, embeddingModel: 'openai/text-embedding-3-small', error: null },
    },
  };
  setTimeout(() => {
    status = health;
    statusListeners.forEach((cb) => cb(status));
  }, 600);

  const emit = (runId: string, seq: number, event: RunEventEnvelope['event']): void => eventListeners.forEach((cb) => cb({ runId, seq, event }));
  let runCounter = 0;

  const rows = Array.from({ length: 12 }, (_, i) => ({
    full_name: ['Linus Torvalds', 'Anders Ritchie', 'Grace Hamilton', 'Radia Stroustrup', 'Ada Lovelace', 'Ken Thompson', 'Hedy Lamarr', 'Tim Berners-Lee', 'Guido van Rossum', 'Barbara Liskov', 'Dennis Ritchie', 'Alan Turing'][i],
    country: ['US', 'DE', 'GB', 'US', 'GB', 'US', 'AT', 'GB', 'NL', 'US', 'US', 'GB'][i],
    orders: 12 - i,
    revenue: (71694.05 - i * 2100.3).toFixed(2),
    last_order: i === 3 ? null : `2026-09-${String(28 - i).padStart(2, '0')}`,
  }));

  const scriptedRun = async (runId: string, message: string): Promise<void> => {
    let seq = 0;
    const next = (event: RunEventEnvelope['event']): void => emit(runId, ++seq, event);
    await sleep(300);
    next({ type: 'step', node: 'retrieve_context' });
    await sleep(400);
    next({ type: 'step', node: 'agent' });
    await sleep(500);
    const write = /mark|update|delete|set /i.test(message);
    const sql = write
      ? "UPDATE sandbox_data.products\nSET active = false\nWHERE category = 'accessories' AND active = true"
      : "SELECT c.full_name, c.country, count(o.id) AS orders,\n       round(sum(oi.quantity * oi.unit_price), 2) AS revenue,\n       max(o.ordered_at)::date AS last_order\nFROM sandbox_data.customers c\nJOIN sandbox_data.orders o ON o.customer_id = c.id\nJOIN sandbox_data.order_items oi ON oi.order_id = o.id\nWHERE o.status IN ('paid', 'shipped')\n  AND o.ordered_at >= date_trunc('month', now()) - interval '1 month'\nGROUP BY c.id\nORDER BY revenue DESC\nLIMIT 10;";
    for (const t of ['I’ll ', 'check the ', 'relevant tables ', 'and run the query.']) {
      next({ type: 'token', text: t });
      await sleep(80);
    }
    next({ type: 'message', text: 'I’ll check the relevant tables and run the query.' });
    next({ type: 'tool_call', id: `${runId}-c1`, name: write ? 'postgres-write__execute_sql' : 'postgres-read__execute_sql', args: { sql } });
    next({ type: 'usage', tokensIn: 9700, tokensOut: 120, costUsd: 0.021, calls: 1, model: 'anthropic/claude-sonnet-5-5' });
    if (write) {
      await sleep(400);
      next({ type: 'approval_required', toolCallId: `${runId}-c1`, name: 'postgres-write__execute_sql', args: { sql }, sql, statementTypes: ['UPDATE'], warnings: ['Planner estimate: ~13 rows affected in products.'], tables: ['sandbox_data.products'], estimate: { kind: 'rows', rows: 13, relation: 'products' } });
      next({ type: 'done', status: 'awaiting_approval' });
      return;
    }
    next({ type: 'step', node: 'tools' });
    await sleep(900);
    next({ type: 'tool_result', id: `${runId}-c1`, name: 'postgres-read__execute_sql', content: JSON.stringify(rows), isError: false, truncated: false });
    next({ type: 'step', node: 'agent' });
    await sleep(500);
    next({ type: 'tool_call', id: `${runId}-m1`, name: 'memory__save_query', args: { name: 'top_customers_last_month', sql } });
    await sleep(300);
    next({ type: 'tool_result', id: `${runId}-m1`, name: 'memory__save_query', content: '{"saved": true}', isError: false, truncated: false });
    const answer = `Here are the **top 10 customers by revenue** for last month (paid and shipped orders only):\n\n| # | Customer | Revenue |\n|---|---|---|\n| 1 | Linus Torvalds | $71,694.05 |\n| 2 | Anders Ritchie | $69,593.75 |\n| 3 | Grace Hamilton | $67,493.45 |\n\nRevenue is \`quantity × unit_price\` summed over \`order_items\`. No ties at the cutoff. I saved this as **top_customers_last_month** so you can ask for it again.`;
    for (const chunk of answer.match(/.{1,24}/gs) ?? []) {
      next({ type: 'token', text: chunk });
      await sleep(25);
    }
    next({ type: 'message', text: answer });
    next({ type: 'usage', tokensIn: 19800, tokensOut: 420, costUsd: 0.044, calls: 2, model: 'anthropic/claude-sonnet-5-5' });
    next({ type: 'done', status: 'completed' });
  };

  const api: Agent2DbApi = {
    getStatus: async () => status,
    restartBackend: async () => undefined,
    onStatus: (cb) => {
      statusListeners.add(cb);
      return () => statusListeners.delete(cb);
    },
    startRun: async (args) => {
      const runId = `run-${++runCounter}`;
      const sessionId = args.sessionId ?? `demo-${Date.now()}`;
      void scriptedRun(runId, args.message);
      return { runId, sessionId };
    },
    resumeRun: async (runId, decision) => {
      void (async () => {
        await sleep(400);
        let seq = 20;
        const next = (event: RunEventEnvelope['event']): void => emit(runId, ++seq, event);
        next({ type: 'step', node: 'tools' });
        await sleep(500);
        next({ type: 'tool_result', id: `${runId}-c1`, name: 'postgres-write__execute_sql', content: decision === 'approve' ? 'No results' : 'The user rejected this call. Feedback: keep them', isError: decision !== 'approve', truncated: false });
        next({ type: 'step', node: 'agent' });
        await sleep(400);
        const text = decision === 'approve' ? 'Done. 13 accessories are now inactive; a follow-up count confirmed no active accessories remain.' : 'Understood, I left the products unchanged.';
        next({ type: 'message', text });
        next({ type: 'done', status: 'completed' });
      })();
      return { ok: true };
    },
    cancelRun: async (runId) => {
      emit(runId, 99, { type: 'done', status: 'cancelled' });
      return { ok: true };
    },
    onRunEvent: (cb) => {
      eventListeners.add(cb);
      return () => eventListeners.delete(cb);
    },
    listSessions: async () => sessions,
    sessionHistory: async (id): Promise<HistoryEvent[]> => [
      { runId: `${id}-r1`, seq: 0, type: 'user', data: { text: sessions.find((s) => s.id === id)?.title ?? 'Hello' } },
      { runId: `${id}-r1`, seq: 1, type: 'tool_call', data: { id: 'x1', name: 'postgres-read__execute_sql', args: { sql: 'select count(*) from sandbox_data.orders' } } },
      { runId: `${id}-r1`, seq: 2, type: 'tool_result', data: { id: 'x1', name: 'postgres-read__execute_sql', content: '[{"count": 1500}]', is_error: false, truncated: false } },
      { runId: `${id}-r1`, seq: 3, type: 'message', data: { text: 'There are **1,500** orders in `sandbox_data.orders`.' } },
      { runId: `${id}-r1`, seq: 4, type: 'done', data: { status: 'completed' } },
    ],
    deleteSession: async (id) => {
      const i = sessions.findIndex((s) => s.id === id);
      if (i >= 0) sessions.splice(i, 1);
      return { ok: true };
    },
    schemaTables: async () => [
      { table: 'sandbox_data.customers', kind: 'table', rows: 120, columns: 6 },
      { table: 'sandbox_data.orders', kind: 'table', rows: 1500, columns: 5 },
      { table: 'sandbox_data.order_items', kind: 'table', rows: 3771, columns: 5 },
      { table: 'sandbox_data.products', kind: 'table', rows: 40, columns: 6 },
      { table: 'public.stripe_customers', kind: 'table', rows: 0, columns: 14 },
    ],
    schemaSearch: async (q) => [{ table: 'sandbox_data.orders', kind: 'table', score: 0.9, rows: 1500, comment: `Matches “${q}”`, columns: ['id', 'customer_id', 'status'] }],
    schemaTable: async (name) => ({ table: name, kind: 'table', rows: 1500, comment: 'One row per checkout', columns: [], foreignKeys: [], ddl: `-- ${name} (table, ~1.5k rows): One row per checkout\nCREATE TABLE ${name} (\n  id bigint NOT NULL GENERATED (serial),\n  customer_id bigint NOT NULL,\n  status text NOT NULL  -- values: pending, paid, shipped, refunded, cancelled\n  ordered_at timestamptz NOT NULL,\n  PRIMARY KEY (id),\n  FOREIGN KEY (customer_id) REFERENCES sandbox_data.customers(id)\n);\n-- indexes: orders_customer_idx btree(customer_id)` }),
    schemaReindex: async () => ({ ok: true }),
    listFacts: async () => [{ id: 1, content: 'Revenue excludes customers whose email ends with @example.com (test accounts).', subject: 'sandbox_data.customers.email', tags: ['rule'], source: 'agent', createdAt: new Date().toISOString() }],
    deleteFact: async () => ({ ok: true }),
    listSavedQueries: async () => [{ id: 1, name: 'top_customers_last_month', description: 'Top 10 customers by paid+shipped revenue, previous calendar month', sql: 'select 1', tables: ['sandbox_data.orders'], tags: [], useCount: 3, updatedAt: new Date().toISOString() }],
    deleteSavedQuery: async () => ({ ok: true }),
    listApprovals: async () => [{ id: 1, runId: 'r', toolName: 'postgres-write__execute_sql', sql: "UPDATE sandbox_data.products SET active = false WHERE category = 'accessories'", statementTypes: ['UPDATE'], warnings: [], estimate: null, decision: 'approve', feedback: null, requestedAt: new Date().toISOString(), decidedAt: new Date().toISOString() }],
    listDocuments: async () => ({
      documents: [
        { id: 1, name: 'refund-policy.md', kind: 'markdown', sizeBytes: 2048, status: 'ready', error: null, chunkCount: 4, charCount: 1900, pages: null, tags: [], embeddingModel: 'openai/text-embedding-3-small', createdAt: new Date(Date.now() - 3600e3).toISOString() },
        { id: 2, name: 'Q3 pricing deck.pdf', kind: 'pdf', sizeBytes: 1_200_000, status: 'processing', error: null, chunkCount: 0, charCount: 0, pages: 24, tags: [], embeddingModel: null, createdAt: new Date().toISOString() },
      ],
      ready: 1,
      chunks: 4,
      vectorIndex: 'postgres',
      embeddingModel: 'openai/text-embedding-3-small',
      ragEnabled: ragOn,
    }),
    uploadDocumentsDialog: async () => [],
    uploadDocument: async () => null,
    documentDetail: async (id) => ({ id, name: 'refund-policy.md', kind: 'markdown', sizeBytes: 2048, status: 'ready', error: null, chunkCount: 2, charCount: 1900, pages: null, tags: [], embeddingModel: 'openai/text-embedding-3-small', createdAt: new Date().toISOString(), chunks: [
      { id: 1, idx: 0, heading: 'Refund policy', page: null, content: 'Customers may request a refund within 30 days of purchase. Refunds are issued to the original payment method.', charCount: 110, embedded: true },
      { id: 2, idx: 1, heading: 'Refund policy > Exceptions', page: null, content: 'Final-sale accessories are not refundable. Enterprise contracts follow their own terms.', charCount: 90, embedded: true },
    ] }),
    deleteDocument: async () => ({ ok: true }),
    searchDocuments: async (q) => [{ id: 2, document: 'refund-policy.md', documentId: 1, heading: 'Refund policy > Exceptions', page: null, content: `Final-sale accessories are not refundable (matched “${q}”). Enterprise contracts follow their own terms.`, score: 0.03, similarity: 0.71 }],
    setRag: async (enabled) => {
      ragOn = enabled;
      return { enabled };
    },
    dbRows: async (q) => ({ table: q.table, columns: ['id', 'email', 'full_name', 'country', 'segment', 'created_at'], rows: Array.from({ length: q.limit ?? 50 }, (_, i) => [i + 1 + (q.offset ?? 0), `user${i + 1 + (q.offset ?? 0)}@example.com`, ['Ada Lovelace', 'Grace Hopper', 'Linus Torvalds'][i % 3], ['US', 'GB', 'DE'][i % 3], ['consumer', 'smb', 'enterprise'][i % 3], '2026-03-01T10:00:00+00:00']), limit: q.limit ?? 50, offset: q.offset ?? 0, total: 120, estimate: 120 }),
    dbQuery: async (sql) => (/^\s*select/i.test(sql) ? { columns: ['n'], rows: [[1500]], rowCount: 1, truncated: false, ms: 12, error: null, statementTypes: ['SELECT'] } : { columns: [], rows: [], rowCount: 0, truncated: false, ms: 0, error: 'Only read-only statements run here (DELETE). Ask the agent to make changes; it will request your approval.', statementTypes: ['DELETE'] }),
    dbErd: async () => ({ tables: 4, mermaid: `erDiagram\n    customers {\n        bigint id PK\n        text email UK\n        text full_name\n        text segment "values: consumer, smb, enterprise"\n    }\n    orders {\n        bigint id PK\n        bigint customer_id FK\n        text status "values: pending, paid, shipped"\n        timestamptz ordered_at\n    }\n    order_items {\n        bigint id PK\n        bigint order_id FK\n        bigint product_id FK\n        int quantity\n        numeric unit_price\n    }\n    products {\n        bigint id PK\n        text sku UK\n        text category\n        numeric unit_price\n    }\n    customers ||--o{ orders : "customer_id"\n    orders ||--o{ order_items : "order_id"\n    products ||--o{ order_items : "product_id"\n` }),
    windowMinimize: async () => undefined,
    windowMaximize: async () => undefined,
    windowClose: async () => undefined,
    onWindowState: (cb) => {
      winListeners.add(cb);
      return () => winListeners.delete(cb);
    },
  };
  window.agent2db = api;
}
