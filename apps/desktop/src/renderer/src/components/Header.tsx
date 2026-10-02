import type { BackendStatus } from '../../../shared/types';

function mcpTone(value: string): 'ok' | 'off' | 'bad' {
  if (value === 'connected') return 'ok';
  if (value === 'disabled') return 'off';
  return 'bad';
}

export function Header({
  status,
  onRestart,
  onNewChat,
  newChatDisabled,
}: {
  status: BackendStatus;
  onRestart: () => void;
  onNewChat: () => void;
  newChatDisabled: boolean;
}) {
  return (
    <header className="header">
      <div className="brand">
        <span className="logo" aria-hidden>
          ◆
        </span>
        Agent2DB
      </div>

      <div className="header-status">
        {status.state === 'starting' && (
          <span className="pill pill-starting">
            <span className="dot" /> Starting backend…
          </span>
        )}
        {status.state === 'ready' && (
          <span className="pill pill-ready" title={`Backend v${status.version}`}>
            <span className="dot" /> Ready · {status.model}
          </span>
        )}
        {status.state === 'error' && (
          <>
            <span className="pill pill-error" title={status.message}>
              <span className="dot" /> Backend error
            </span>
            <button className="btn btn-small" onClick={onRestart}>
              Restart
            </button>
          </>
        )}

        {status.state === 'ready' &&
          Object.entries(status.mcp).map(([name, value]) => (
            <span key={name} className={`chip chip-${mcpTone(value)}`} title={`${name}: ${value}`}>
              {name}
            </span>
          ))}
      </div>

      <button className="btn" onClick={onNewChat} disabled={newChatDisabled}>
        New chat
      </button>
    </header>
  );
}
