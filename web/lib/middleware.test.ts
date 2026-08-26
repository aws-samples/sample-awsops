import { describe, it, expect } from 'vitest';
import type { NextRequest } from 'next/server';
import { middleware } from '../middleware';

// The middleware only reads request.method + request.headers.get('content-length'),
// both present on a plain Request — avoids NextRequest construction quirks in vitest.
function reqOf(method: string, contentLength?: number) {
  const headers: Record<string, string> = {};
  if (contentLength !== undefined) headers['content-length'] = String(contentLength);
  return new Request('http://x/api/jobs', { method, headers }) as unknown as NextRequest;
}

describe('middleware — global request-body ceiling', () => {
  it('413 when Content-Length exceeds the 2MB ceiling on a body method', () => {
    expect(middleware(reqOf('POST', 3 * 1024 * 1024)).status).toBe(413);
    expect(middleware(reqOf('PUT', 5_000_000)).status).toBe(413);
  });
  it('passes a POST under the ceiling through', () => {
    expect(middleware(reqOf('POST', 1000)).status).not.toBe(413);
  });
  it('never blocks body-less methods even with a spurious large Content-Length', () => {
    expect(middleware(reqOf('GET', 9_000_000)).status).not.toBe(413);
    expect(middleware(reqOf('HEAD')).status).not.toBe(413);
  });
});
