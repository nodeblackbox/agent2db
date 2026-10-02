import { useMemo, type ReactNode } from 'react';
import { ArrowLeft, Database, Plug, RefreshCw, Server, Settings as SettingsIcon } from 'lucide-react';
import type { BackendStatus, HealthResponse } from '../../../shared/types';
import { splitToolName } from '../../../shared/resultTable';
import { ApprovalsList, MemoryList, SchemaBrowser } from './Drawer';
import { Btn, Card, CardHead, StatusDot, Tag } from './primitives';

export function PanelShell({ title, children, onBack, action, wide }: { title: string; children: ReactNode; onBack: () => void; action?: ReactNode; wide?: boolean }) {
  return (
    <div className={`${wide ? 'max-w-5xl' : 'max-w-3xl'} mx-auto px-6 py-6 flex flex-col gap-3 w-full`}>
      <div className="flex items-center justify-between mb-1">
        <div className="flex items-center gap-2">
          <button onClick={onBack} className="text-zinc-600 hover:text-zinc-200 p-1 -ml-1" title="Back to chat">
            <ArrowLeft size={15} />
          </button>
          <h2 className="text-[15px] font-medium text-zinc-100">{title}</h2>
        </div>
        {action}
      </div>
      {children}
    </div>
  );
}

export function SchemaPanel({ onBack, refreshKey }: { onBack: () => void; refreshKey: unknown }) {
  return (
    <PanelShell title="Schema" onBack={onBack}>
      <div className="text-[12px] text-zinc-500 -mt-2 mb-1">Every table the agent can see, from its own index. Search ranks tables the same way the agent does before each request.</div>
      <Card className="h-[70vh] flex flex-col">
        <SchemaBrowser refreshKey={refreshKey} />
      </Card>
    </PanelShell>
  );
}

export function MemoryPanel({ onBack, refreshKey }: { onBack: () => void; refreshKey: unknown }) {
  return (
    <PanelShell title="Memory" onBack={onBack}>
      <div className="text-[12px] text-zinc-500 -mt-2 mb-1">What the agent remembers across chats: confirmed facts about this database and queries worth reusing. Relevant items are shown to the model before each request.</div>
      <Card className="min-h-[50vh] flex flex-col">
        <MemoryList refreshKey={refreshKey} />
      </Card>
    </PanelShell>
  );
}

export function ApprovalsPanel({ onBack, refreshKey }: { onBack: () => void; refreshKey: unknown }) {
  return (
    <PanelShell title="Approvals" onBack={onBack}>
      <div className="text-[12px] text-zinc-500 -mt-2 mb-1">Audit log of every write the agent asked to run, with the decision.</div>
      <Card className="min-h-[50vh] flex flex-col">
        <ApprovalsList refreshKey={refreshKey} />
      </Card>
    </PanelShell>
  );
}

function mcpTone(value: string): 'ok' | 'off' | 'error' {
  if (value === 'connected') return 'ok';
  if (value === 'disabled') return 'off';
  return 'error';
}

const SERVER_HINT: Record<string, string> = {
  'postgres-read': 'Read-only queries through the agent2db_ro role. Runs without approval.',
  'postgres-write': 'Writes through the agent2db_rw role. Every statement needs your approval.',
  agent2db: 'Agent2DB’s own MCP server for external clients (disabled by default).',
  schema: 'Built-in: table search and definitions served from the schema index.',
  memory: 'Built-in: facts and saved queries that persist across chats.',
};

export function McpPanel({ onBack, health }: { onBack: () => void; health: HealthResponse | null }) {
  const groups = useMemo(() => {
    const out = new Map<string, string[]>();
    for (const name of health?.tools ?? []) {
      const { server, tool } = splitToolName(name);
      const key = server ?? 'other';
      out.set(key, [...(out.get(key) ?? []), tool]);
    }
    return out;
  }, [health]);
  const servers = useMemo(() => {
    const names = new Set<string>([...Object.keys(health?.mcp ?? {}), ...groups.keys()]);
    return [...names].sort();
  }, [health, groups]);
  return (
    <PanelShell title="Tools & MCP servers" onBack={onBack}>
      <div className="text-[12px] text-zinc-500 -mt-2 mb-1">
        MCP servers come from <span className="mono">config/mcp.json</span> (or the example config); built-in tools ship with the backend. Tools the model can call right now are listed under each.
      </div>
      {!health && <Card className="px-4 py-3 text-[12.5px] text-zinc-500">The backend is not ready yet.</Card>}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
        {servers.map((name) => {
          const status = health?.mcp[name];
          const tools = groups.get(name) ?? [];
          const builtin = status === undefined;
          return (
            <Card key={name}>
              <CardHead
                icon={builtin ? <Plug size={14} className="text-zinc-400" /> : <Server size={14} className="text-zinc-400" />}
                title={name}
                right={
                  <span className="flex items-center gap-2">
                    {builtin ? <Tag>built-in</Tag> : <Tag tone={mcpTone(status) === 'ok' ? 'ok' : mcpTone(status) === 'off' ? 'default' : 'danger'}>{status}</Tag>}
                  </span>
                }
              />
              <div className="px-4 pb-3 flex flex-col gap-2">
                <div className="text-[12px] text-zinc-500 leading-relaxed">{SERVER_HINT[name] ?? 'External MCP server.'}</div>
                {tools.length > 0 ? (
                  <div className="flex flex-wrap gap-1.5">
                    {tools.map((t) => (
                      <Tag key={t}>{t}</Tag>
                    ))}
                  </div>
                ) : (
                  <div className="text-[11.5px] text-zinc-600">No tools exposed.</div>
                )}
              </div>
            </Card>
          );
        })}
      </div>
    </PanelShell>
  );
}

export function SettingsPanel({ onBack, status, onRestart }: { onBack: () => void; status: BackendStatus; onRestart: () => void }) {
  const health = status.state === 'ready' ? status.health : null;
  const row = (k: string, v: ReactNode): ReactNode => (
    <div className="flex items-start justify-between gap-4 py-1.5 text-[12.5px]">
      <span className="text-zinc-500">{k}</span>
      <span className="text-zinc-200 mono text-right truncate">{v}</span>
    </div>
  );
  return (
    <PanelShell
      title="Settings"
      onBack={onBack}
      action={
        <Btn variant="outline" onClick={onRestart}>
          <RefreshCw size={13} /> Restart backend
        </Btn>
      }
    >
      <Card>
        <CardHead icon={<SettingsIcon size={14} className="text-zinc-400" />} title="Backend" right={<StatusDot status={status.state === 'ready' ? 'ok' : status.state === 'error' ? 'error' : 'running'} />} />
        <div className="px-4 pb-3 divide-y divide-zinc-800/60">
          {status.state === 'error' && <div className="py-2 text-[12.5px] text-rose-300">{status.message}</div>}
          {row('State', status.state)}
          {health && row('Version', health.version)}
          {health && row('Instance', (health.backendId ?? '').slice(0, 8))}
          {health && row('Model', health.model)}
          {health && health.fallbackModels.length > 0 && row('Fallbacks', health.fallbackModels.join(', '))}
          {health && row('App database', health.store)}
          {health && row('Checkpointer', health.checkpointer)}
        </div>
      </Card>
      <Card>
        <CardHead icon={<Database size={14} className="text-zinc-400" />} title="Schema index" />
        <div className="px-4 pb-3 divide-y divide-zinc-800/60">
          {health && row('Tables', String(health.schemaIndex.tables))}
          {health && row('Embeddings', health.schemaIndex.embeddings ? (health.schemaIndex.embeddingModel ?? 'on') : 'off (lexical ranking only)')}
          {health && row('Indexed', health.schemaIndex.indexedAt ? new Date(health.schemaIndex.indexedAt).toLocaleString() : 'not yet')}
          {health?.schemaIndex.error && <div className="py-2 text-[12.5px] text-amber-300">{health.schemaIndex.error}</div>}
        </div>
      </Card>
      <div className="text-[12px] text-zinc-600">
        Models, database connections and API keys are configured in the repository’s <span className="mono">.env</span>; restart the backend after changing it.
      </div>
    </PanelShell>
  );
}
