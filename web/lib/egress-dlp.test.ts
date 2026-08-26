// web/lib/egress-dlp.test.ts — ADR-040 §2 exfiltration defense (RW-slice T2).
import { describe, it, expect } from 'vitest';
import { redactEgress, assertChannelAllowed } from './egress-dlp';

describe('redactEgress', () => {
  it('masks AWS access keys', () => {
    const r = redactEgress({ text: 'key is AKIAIOSFODNN7EXAMPLE here' });
    expect(JSON.stringify(r.payload)).not.toContain('AKIAIOSFODNN7EXAMPLE');
    expect(r.redactions.length).toBeGreaterThan(0);
  });

  it('masks ARNs', () => {
    const r = redactEgress({ text: 'see arn:aws:iam::123456789012:role/AdminRole now' });
    expect(JSON.stringify(r.payload)).not.toContain('123456789012:role/AdminRole');
  });

  it('masks private/metadata IPs', () => {
    const r = redactEgress({ text: 'host 10.0.0.5 and 169.254.169.254 and 172.16.3.9' });
    const s = JSON.stringify(r.payload);
    expect(s).not.toContain('10.0.0.5');
    expect(s).not.toContain('169.254.169.254');
    expect(s).not.toContain('172.16.3.9');
  });

  it('masks JWT/bearer tokens', () => {
    const r = redactEgress({ text: 'Authorization: Bearer eyJhbGciOiJIUzI1Ni1.eyJzdWIiOiIxMjM0NTY.SflKxwRJSMeKKF2QT4' });
    expect(JSON.stringify(r.payload)).not.toContain('SflKxwRJSMeKKF2QT4');
  });

  it('catches a LONG base64 blob (raw dump / long encoded payload)', () => {
    const encoded = Buffer.from('AKIAIOSFODNN7EXAMPLE-and-a-secret-payload-here').toString('base64'); // 64 chars > 40 floor
    const r = redactEgress({ text: `data: ${encoded}` });
    expect(JSON.stringify(r.payload)).not.toContain(encoded);
    expect(r.redactions).toContain('blob');
  });

  it('HONEST LIMIT (P4 gate): a SHORT encoded secret (bare AWS key b64 ≈28 chars) is NOT caught — human 4-eyes is the backstop, not this regex', () => {
    const short = Buffer.from('AKIAIOSFODNN7EXAMPLE').toString('base64'); // 28 chars < 40 floor
    const r = redactEgress({ text: `data: ${short}` });
    expect(JSON.stringify(r.payload)).toContain(short); // documents the real best-effort behavior
    expect(r.redactions).toEqual([]);
  });

  it('recurses into ALL string fields (nested blocks/attachments), not just the top text', () => {
    const r = redactEgress({ text: 'ok', blocks: [{ type: 'section', text: 'leak AKIAIOSFODNN7EXAMPLE' }], channel: '#ops' });
    expect(JSON.stringify(r.payload)).not.toContain('AKIAIOSFODNN7EXAMPLE');
  });

  it('enforces a size cap (truncates very long text)', () => {
    const r = redactEgress({ text: 'x'.repeat(5000) });
    expect((r.payload as { text: string }).text.length).toBeLessThanOrEqual(3010);
    expect((r.payload as { text: string }).text).toMatch(/…\[truncated\]$/);
  });

  it('is idempotent on already-clean text (no redactions)', () => {
    const r = redactEgress({ text: 'a normal incident note, nothing secret' });
    expect((r.payload as { text: string }).text).toBe('a normal incident note, nothing secret');
    expect(r.redactions).toEqual([]);
  });
});

describe('assertChannelAllowed', () => {
  it('passes an allowlisted channel', () => {
    expect(() => assertChannelAllowed('#incidents', ['#incidents', '#ops'])).not.toThrow();
  });
  it('throws on a channel not in the allowlist', () => {
    expect(() => assertChannelAllowed('#random', ['#incidents'])).toThrow();
  });
  it('empty allowlist = deny-all (fail-closed)', () => {
    expect(() => assertChannelAllowed('#incidents', [])).toThrow();
    expect(() => assertChannelAllowed('#incidents', undefined as unknown as string[])).toThrow();
  });
});
