import { describe, it, expect } from 'vitest';
import { readJsonBounded, readTextBounded, BodyTooLargeError } from './http-body';

function jsonReq(body: string) {
  return new Request('http://x/', { method: 'POST', headers: { 'content-type': 'application/json' }, body });
}

describe('readTextBounded', () => {
  it('returns the raw text verbatim under the cap (no parse)', async () => {
    const raw = '{not strictly json but raw}';
    expect(await readTextBounded(jsonReq(raw))).toBe(raw);
  });
  it('rejects via Content-Length before reading', async () => {
    await expect(readTextBounded(jsonReq('x'.repeat(2000)), 100)).rejects.toBeInstanceOf(BodyTooLargeError);
  });
  it('rejects via the streamed byte cap when Content-Length is absent', async () => {
    const stream = new ReadableStream({
      start(c) { c.enqueue(new TextEncoder().encode('x'.repeat(120))); c.close(); },
    });
    const req = new Request('http://x/', { method: 'POST', body: stream, duplex: 'half' } as RequestInit & { duplex: 'half' });
    await expect(readTextBounded(req, 10)).rejects.toBeInstanceOf(BodyTooLargeError);
  });
});

describe('readJsonBounded', () => {
  it('parses a small valid JSON body', async () => {
    expect(await readJsonBounded(jsonReq(JSON.stringify({ a: 1, q: 'up' })))).toEqual({ a: 1, q: 'up' });
  });

  it('rejects via Content-Length before parsing (string body sets content-length)', async () => {
    const big = JSON.stringify({ q: 'x'.repeat(2000) });
    await expect(readJsonBounded(jsonReq(big), 100)).rejects.toBeInstanceOf(BodyTooLargeError);
  });

  it('rejects via the streamed byte cap even when Content-Length is absent', async () => {
    const stream = new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('x'.repeat(50)));
        controller.enqueue(new TextEncoder().encode('y'.repeat(50)));
        controller.close();
      },
    });
    const req = new Request('http://x/', { method: 'POST', body: stream, duplex: 'half' } as RequestInit & { duplex: 'half' });
    await expect(readJsonBounded(req, 10)).rejects.toBeInstanceOf(BodyTooLargeError);
  });

  it('throws a non-BodyTooLargeError on invalid JSON (→ caller maps to 400)', async () => {
    await expect(readJsonBounded(jsonReq('{not json'))).rejects.not.toBeInstanceOf(BodyTooLargeError);
  });
});
