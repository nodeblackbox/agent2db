import { describe, expect, it } from 'vitest';
import { LineSplitter, parseReadyLine } from './readyLine';

describe('parseReadyLine', () => {
  it('accepts the ready line, with surrounding whitespace and key order variations', () => {
    expect(parseReadyLine('{"ready": true, "port": 51234}')).toEqual({ port: 51234 });
    expect(parseReadyLine('  {"port":8000,"ready":true}\r')).toEqual({ port: 8000 });
  });

  it('rejects log lines and other JSON', () => {
    expect(parseReadyLine('INFO: Uvicorn running on http://127.0.0.1:8000')).toBeNull();
    expect(parseReadyLine('{"level":"info","msg":"starting"}')).toBeNull();
    expect(parseReadyLine('{"ready": false, "port": 8000}')).toBeNull();
    expect(parseReadyLine('{"ready": "true", "port": 8000}')).toBeNull();
    expect(parseReadyLine('[1,2]')).toBeNull();
    expect(parseReadyLine('{not json}')).toBeNull();
    expect(parseReadyLine('')).toBeNull();
  });

  it('rejects invalid ports', () => {
    expect(parseReadyLine('{"ready": true, "port": 0}')).toBeNull();
    expect(parseReadyLine('{"ready": true, "port": 70000}')).toBeNull();
    expect(parseReadyLine('{"ready": true, "port": 80.5}')).toBeNull();
    expect(parseReadyLine('{"ready": true, "port": "8000"}')).toBeNull();
    expect(parseReadyLine('{"ready": true}')).toBeNull();
  });
});

describe('LineSplitter', () => {
  it('splits chunks into lines and handles CRLF', () => {
    const s = new LineSplitter();
    expect(s.feed('first\r\nsec')).toEqual(['first']);
    expect(s.feed('ond\n{"ready": tr')).toEqual(['second']);
    expect(s.feed('ue, "port": 1}\n')).toEqual(['{"ready": true, "port": 1}']);
    expect(s.feed('tail')).toEqual([]);
    expect(s.end()).toEqual(['tail']);
  });

  it('caps overly long lines', () => {
    const s = new LineSplitter(10);
    const out = s.feed('x'.repeat(25));
    expect(out).toEqual(['x'.repeat(10)]);
    expect(s.end()).toEqual([]);
  });
});
