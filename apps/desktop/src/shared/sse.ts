/**
 * Incremental Server-Sent Events parser (WHATWG event-stream format).
 * Pure: no Node or DOM APIs, so it can be unit tested and used anywhere.
 */

export interface SseMessage {
  /** Value of the last `id:` field seen for this event, or undefined. */
  id: string | undefined;
  /** Value of `event:` field; defaults to "message" per spec. */
  event: string;
  /** Data lines joined with "\n". */
  data: string;
}

export class SseParser {
  private buffer = '';
  private dataLines: string[] = [];
  private eventType = '';
  private eventId: string | undefined = undefined;
  private sawField = false;
  private firstChunk = true;

  /** Feed a decoded text chunk; returns all events completed by this chunk. */
  feed(chunk: string): SseMessage[] {
    if (this.firstChunk && chunk.length > 0) {
      // Strip a UTF-8 BOM at the start of the stream.
      if (chunk.charCodeAt(0) === 0xfeff) chunk = chunk.slice(1);
      this.firstChunk = false;
    }
    this.buffer += chunk;
    const out: SseMessage[] = [];

    let start = 0;
    for (let i = 0; i < this.buffer.length; i++) {
      const ch = this.buffer[i];
      if (ch !== '\n' && ch !== '\r') continue;
      // A trailing "\r" might be the first half of "\r\n"; wait for more input.
      if (ch === '\r' && i === this.buffer.length - 1) break;
      const line = this.buffer.slice(start, i);
      if (ch === '\r' && this.buffer[i + 1] === '\n') i++;
      start = i + 1;
      const ev = this.processLine(line);
      if (ev) out.push(ev);
    }
    this.buffer = this.buffer.slice(start);
    return out;
  }

  /** Flush at end of stream. Per spec, an incomplete trailing event is discarded. */
  end(): SseMessage[] {
    this.buffer = '';
    this.resetEvent();
    return [];
  }

  private resetEvent(): void {
    this.dataLines = [];
    this.eventType = '';
    this.eventId = undefined;
    this.sawField = false;
  }

  private processLine(line: string): SseMessage | null {
    if (line === '') {
      if (!this.sawField) return null;
      const msg: SseMessage = {
        id: this.eventId,
        event: this.eventType || 'message',
        data: this.dataLines.join('\n'),
      };
      const hadData = this.dataLines.length > 0;
      this.resetEvent();
      // Spec: an event with no data lines is not dispatched.
      return hadData ? msg : null;
    }
    if (line.startsWith(':')) return null; // comment / keep-alive

    const colon = line.indexOf(':');
    let field: string;
    let value: string;
    if (colon === -1) {
      field = line;
      value = '';
    } else {
      field = line.slice(0, colon);
      value = line.slice(colon + 1);
      if (value.startsWith(' ')) value = value.slice(1);
    }

    switch (field) {
      case 'data':
        this.dataLines.push(value);
        this.sawField = true;
        break;
      case 'event':
        this.eventType = value;
        this.sawField = true;
        break;
      case 'id':
        if (!value.includes('\0')) this.eventId = value;
        this.sawField = true;
        break;
      default:
        // "retry" and unknown fields are ignored.
        break;
    }
    return null;
  }
}
