import { useState, type KeyboardEvent } from 'react';

export function Composer({
  disabled,
  running,
  onSend,
  onStop,
}: {
  disabled: boolean;
  running: boolean;
  onSend: (text: string) => void;
  onStop: () => void;
}) {
  const [text, setText] = useState('');

  const send = (): void => {
    const t = text.trim();
    if (!t || disabled || running) return;
    onSend(t);
    setText('');
  };

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>): void => {
    if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      send();
    }
  };

  return (
    <div className="composer">
      <textarea
        value={text}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={onKeyDown}
        placeholder={disabled ? 'Waiting for the backend…' : 'Ask about your database…  (Enter to send, Shift+Enter for a new line)'}
        rows={3}
        maxLength={100_000}
        disabled={disabled}
      />
      {running ? (
        <button className="btn btn-danger" onClick={onStop}>
          Stop
        </button>
      ) : (
        <button className="btn btn-primary" onClick={send} disabled={disabled || text.trim().length === 0}>
          Send
        </button>
      )}
    </div>
  );
}
