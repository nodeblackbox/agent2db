import { useEffect, useRef, useState } from 'react';
import { extractSql, splitToolName } from '../../../shared/resultTable';
import type { ApprovalRequest } from '../state';

export function ApprovalDialog({
  request,
  busy,
  onDecide,
}: {
  request: ApprovalRequest | null;
  busy: boolean;
  onDecide: (decision: 'approve' | 'reject', feedback?: string) => void;
}) {
  const [rejecting, setRejecting] = useState(false);
  const [feedback, setFeedback] = useState('');
  const dialogRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    dialogRef.current?.focus();
  }, []);

  const sql = request?.sql ?? (request ? extractSql(request.args).sql : null);
  const tool = request ? splitToolName(request.name) : null;

  return (
    <div className="overlay">
      <div className="dialog" role="dialog" aria-modal="true" aria-labelledby="approval-title" tabIndex={-1} ref={dialogRef}>
        <h2 id="approval-title">Approval required</h2>
        <p className="muted">
          The agent wants to run{' '}
          {tool ? (
            <code>
              {tool.server ? `${tool.server} / ` : ''}
              {tool.tool}
            </code>
          ) : (
            'a tool call'
          )}
          . Review it before it executes.
        </p>

        {request && request.statementTypes.length > 0 && (
          <div className="tags">
            {request.statementTypes.map((t) => (
              <span key={t} className="tag">
                {t}
              </span>
            ))}
          </div>
        )}

        {request && request.warnings.length > 0 && (
          <ul className="warnings">
            {request.warnings.map((w, i) => (
              <li key={i}>⚠ {w}</li>
            ))}
          </ul>
        )}

        {sql ? (
          <textarea className="sql-view" readOnly value={sql} spellCheck={false} aria-label="SQL to approve" />
        ) : request ? (
          <pre className="code">{JSON.stringify(request.args, null, 2)}</pre>
        ) : (
          <p className="muted">No details were provided by the backend.</p>
        )}

        {rejecting && (
          <textarea
            className="feedback"
            placeholder="Optional: tell the agent why, or what to do instead"
            value={feedback}
            onChange={(e) => setFeedback(e.target.value)}
            maxLength={10_000}
            autoFocus
          />
        )}

        <div className="dialog-actions">
          {!rejecting ? (
            <>
              <button className="btn" disabled={busy} onClick={() => setRejecting(true)}>
                Reject…
              </button>
              <button className="btn btn-primary" disabled={busy} onClick={() => onDecide('approve')}>
                Approve
              </button>
            </>
          ) : (
            <>
              <button className="btn" disabled={busy} onClick={() => setRejecting(false)}>
                Back
              </button>
              <button className="btn btn-danger" disabled={busy} onClick={() => onDecide('reject', feedback)}>
                Reject
              </button>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
