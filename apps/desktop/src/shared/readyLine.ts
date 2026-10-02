/**
 * Parsing of the backend's stdout. The backend prints exactly one JSON line
 * `{"ready": true, "port": N}` when it is listening; any other line is a log line.
 */

export interface ReadyInfo {
  port: number;
}

/** Returns the port if `line` is the ready line, otherwise null. Never throws. */
export function parseReadyLine(line: string): ReadyInfo | null {
  const trimmed = line.trim();
  if (!trimmed.startsWith('{') || !trimmed.endsWith('}')) return null;
  let value: unknown;
  try {
    value = JSON.parse(trimmed);
  } catch {
    return null;
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  const obj = value as Record<string, unknown>;
  if (obj.ready !== true) return null;
  const port = obj.port;
  if (typeof port !== 'number' || !Number.isInteger(port) || port < 1 || port > 65535) return null;
  return { port };
}

/**
 * Splits a byte/text stream into lines. Feed chunks; complete lines are returned.
 * Handles "\n" and "\r\n". Lines longer than `maxLineLength` are truncated so a
 * misbehaving child cannot grow memory without bound.
 */
export class LineSplitter {
  private buffer = '';

  constructor(private readonly maxLineLength = 64 * 1024) {}

  feed(chunk: string): string[] {
    this.buffer += chunk;
    const parts = this.buffer.split('\n');
    this.buffer = parts.pop() ?? '';
    if (this.buffer.length > this.maxLineLength) {
      parts.push(this.buffer.slice(0, this.maxLineLength));
      this.buffer = '';
    }
    return parts.map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l)).map((l) => l.slice(0, this.maxLineLength));
  }

  end(): string[] {
    const rest = this.buffer;
    this.buffer = '';
    return rest.length > 0 ? [rest.endsWith('\r') ? rest.slice(0, -1) : rest] : [];
  }
}
