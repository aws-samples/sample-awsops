import { describe, it, expect, vi, afterEach } from 'vitest';
import { matchDnsToGateways, fetchDnsRecords } from './k8s-dns';

const ELB = 'abc.elb.ap-northeast-2.amazonaws.com';

describe('matchDnsToGateways', () => {
  it('matches case- and trailing-dot-insensitively by exact host', () => {
    const m = matchDnsToGateways([{ name: 'app.example.com', target: 'ABC.elb.ap-northeast-2.amazonaws.com.' }], [ELB]);
    expect(m).toEqual([{ record: { name: 'app.example.com', target: 'ABC.elb.ap-northeast-2.amazonaws.com.' }, gatewayHost: ELB }]);
  });
  it('never matches by suffix, prefix or substring', () => {
    const recs = [
      { name: 'a.example.com', target: `x.${ELB}` },
      { name: 'b.example.com', target: 'abc.elb.ap-northeast-2.amazonaws.com.evil.io' },
      { name: 'c.example.com', target: 'elb.ap-northeast-2.amazonaws.com' },
    ];
    expect(matchDnsToGateways(recs, [ELB])).toEqual([]);
  });
  it('ignores empty hosts and targets', () => {
    expect(matchDnsToGateways([{ name: 'a.com', target: '' }, { name: 'b.com', target: '.' }], ['', '.'])).toEqual([]);
  });
  it('returns one match per gateway sharing the host', () => {
    const m = matchDnsToGateways([{ name: 'a.com', target: ELB }], [ELB, ELB.toUpperCase() + '.']);
    expect(m).toHaveLength(2);
  });
});

describe('fetchDnsRecords', () => {
  afterEach(() => vi.unstubAllGlobals());
  const row = (data: Record<string, unknown>) => ({ account_id: '1', region: 'global', resource_id: 'x', data });
  // Same ledger shape as db-ref-resolve.test.ts: a succeeded statement-snapshot sweep.
  const RUN = { status: 'succeeded', finished_at: '2026-11-18T00:00:00.000Z', last_success_at: '2026-11-18T00:00:00.000Z', row_count: 3 };
  const page = (rows: unknown[], run: unknown = RUN, consistency: unknown = 'statement-snapshot') =>
    ({ ok: true, json: async () => ({ rows, run, consistency }) });
  const INCOMPLETE = { records: [], truncated: false, failed: false, incomplete: true };
  const cname = (n: string) => row({ name: n, type: 'CNAME', records: [ELB] });

  it('normalizes alias and CNAME records; skips TXT/other values', async () => {
    const f = vi.fn().mockResolvedValue(page([
      row({ name: 'App.Example.com.', type: 'A', alias_target: { DNSName: `dualstack.${ELB}.` } }),
      row({ name: 'www.example.com.', type: 'CNAME', records: [ELB] }),
      row({ name: 'x.example.com.', type: 'TXT', records: ['"v=spf1 include:foo"'] }),
      row({ name: 'bad name!.com', type: 'CNAME', records: [ELB] }),
      row({ name: 'ip.example.com', type: 'A', records: ['1.2.3.4'] }),
    ]));
    vi.stubGlobal('fetch', f);
    const out = await fetchDnsRecords('self');
    expect(out).toEqual({
      records: [
        { name: 'app.example.com', target: ELB },
        { name: 'www.example.com', target: ELB },
      ],
      truncated: false,
      failed: false,
      incomplete: false,
    });
    expect(String(f.mock.calls[0][0])).toContain('/api/inventory/route53?');
    expect(String(f.mock.calls[0][0])).toContain('accounts=self');
  });
  it('never throws: failures are flagged, an abort is not', async () => {
    const failed = { records: [], truncated: false, failed: true, incomplete: false };
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, json: async () => ({}) }));
    expect(await fetchDnsRecords('self')).toEqual(failed);
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, json: async () => { throw new Error('bad'); } }));
    expect(await fetchDnsRecords('self')).toEqual(failed);
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, json: async () => ({ rows: 'nope' }) }));
    expect(await fetchDnsRecords('self')).toEqual(failed);
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('net')));
    expect(await fetchDnsRecords('self')).toEqual(failed);
    const ac = new AbortController(); ac.abort();
    expect(await fetchDnsRecords('self', ac.signal)).toEqual({ records: [], truncated: false, failed: false, incomplete: false });
  });
  it('does not flag a fetch rejected by an abort of the passed signal', async () => {
    const ac = new AbortController();
    vi.stubGlobal('fetch', vi.fn().mockImplementation(async () => {
      ac.abort();
      throw new DOMException('aborted', 'AbortError');
    }));
    expect(await fetchDnsRecords('self', ac.signal)).toEqual({ records: [], truncated: false, failed: false, incomplete: false });
  });
  it('caps pages and records', async () => {
    const many = Array.from({ length: 500 }, (_, i) => row({ name: `h${i}.example.com`, type: 'CNAME', records: [ELB] }));
    const f = vi.fn().mockResolvedValue(page(many));
    vi.stubGlobal('fetch', f);
    const out = await fetchDnsRecords('self');
    expect(f.mock.calls.length).toBeLessThanOrEqual(5);
    expect(out.records.length).toBe(2000);
    expect(out.truncated).toBe(true);
  });
  it('reports a complete multi-page read as not truncated', async () => {
    const rows = (n: number, p: string) => Array.from({ length: n }, (_, i) => row({ name: `${p}${i}.example.com`, type: 'CNAME', records: [ELB] }));
    const f = vi.fn()
      .mockResolvedValueOnce(page(rows(500, 'a')))
      .mockResolvedValueOnce(page(rows(10, 'b')));
    vi.stubGlobal('fetch', f);
    const out = await fetchDnsRecords('self');
    expect(out.records).toHaveLength(510);
    expect(out.truncated).toBe(false);
    expect(out.failed).toBe(false);
    expect(f).toHaveBeenCalledTimes(2);
    expect(String(f.mock.calls[0][0])).toContain('offset=0');
    expect(String(f.mock.calls[1][0])).toContain('offset=500');
  });
  it('flags the page cap when the fifth page is still full', async () => {
    const mixed = [
      row({ name: 'only.example.com', type: 'CNAME', records: [ELB] }),
      ...Array.from({ length: 499 }, () => row({ name: 'ip.example.com', type: 'A', records: ['1.2.3.4'] })),
    ];
    const f = vi.fn().mockResolvedValue(page(mixed));
    vi.stubGlobal('fetch', f);
    const out = await fetchDnsRecords('self');
    expect(f).toHaveBeenCalledTimes(5);
    expect(out.records).toHaveLength(5);
    expect(out.truncated).toBe(true);
  });
  it('does not flag truncation when exactly the record cap was read and nothing follows', async () => {
    const rows = (p: string) => Array.from({ length: 500 }, (_, i) => row({ name: `${p}${i}.example.com`, type: 'CNAME', records: [ELB] }));
    const f = vi.fn()
      .mockResolvedValueOnce(page(rows('a')))
      .mockResolvedValueOnce(page(rows('b')))
      .mockResolvedValueOnce(page(rows('c')))
      .mockResolvedValueOnce(page(rows('d')))
      .mockResolvedValueOnce(page([]));
    vi.stubGlobal('fetch', f);
    const out = await fetchDnsRecords('self');
    expect(out.records).toHaveLength(2000);
    expect(out.truncated).toBe(false);
  });
  it('keeps a Route 53 wildcard record name', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(page([
      row({ name: '\\052.apps.example.com.', type: 'A', alias_target: { DNSName: `dualstack.${ELB}.` } }),
      row({ name: '*.web.example.com.', type: 'CNAME', records: [ELB] }),
    ])));
    const out = await fetchDnsRecords('self');
    expect(out.records).toEqual([
      { name: '*.apps.example.com', target: ELB },
      { name: '*.web.example.com', target: ELB },
    ]);
  });
  it('drops names with any other escape or a non-leading asterisk', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(page([
      row({ name: 'a\\052b.example.com', type: 'CNAME', records: [ELB] }),
      row({ name: '\\100.example.com', type: 'CNAME', records: [ELB] }),
      row({ name: 'x.\\052.example.com', type: 'CNAME', records: [ELB] }),
    ])));
    const out = await fetchDnsRecords('self');
    expect(out.records).toEqual([]);
  });

  it('strips a dualstack. alias prefix only when the remainder is an ELB host', async () => {
    const ALB = 'web-123.ap-northeast-2.elb.amazonaws.com';
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(page([
      row({ name: 'alb.example.com.', type: 'A', alias_target: { DNSName: `dualstack.${ALB}.` } }),
      row({ name: 'nlb.example.com.', type: 'A', alias_target: { DNSName: `dualstack.${ELB}.` } }),
      row({ name: 'other.example.com.', type: 'A', alias_target: { DNSName: 'dualstack.origin.example.net.' } }),
      row({ name: 'cf.example.com.', type: 'A', alias_target: { DNSName: 'dualstack.d111.cloudfront.net.' } }),
    ])));
    const out = await fetchDnsRecords('self');
    expect(out.records).toEqual([
      { name: 'alb.example.com', target: ALB },
      { name: 'nlb.example.com', target: ELB },
      { name: 'other.example.com', target: 'dualstack.origin.example.net' },
      { name: 'cf.example.com', target: 'dualstack.d111.cloudfront.net' },
    ]);
  });

  describe('inventory evidence gate', () => {
    it('withholds records when the page lacks the statement-snapshot marker', async () => {
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, json: async () => ({ rows: [cname('a.example.com')], run: RUN }) }));
      expect(await fetchDnsRecords('self')).toEqual(INCOMPLETE);
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue(page([cname('a.example.com')], RUN, 'unknown')));
      expect(await fetchDnsRecords('self')).toEqual(INCOMPLETE);
    });
    it.each([
      ['no ledger', null],
      ['a running sweep', { ...RUN, status: 'running', finished_at: null }],
      ['a failed sweep', { ...RUN, status: 'failed' }],
      ['a partial sweep', { ...RUN, status: 'partial' }],
      ['a malformed finished_at', { ...RUN, finished_at: 'not-a-time' }],
      ['a missing last_success_at', { ...RUN, last_success_at: null }],
      ['a negative row count', { ...RUN, row_count: -1 }],
    ])('withholds records for %s', async (_label, run) => {
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue(page([cname('a.example.com')], run)));
      expect(await fetchDnsRecords('self')).toEqual(INCOMPLETE);
    });
    it('withholds records already read when the ledger version changes between pages', async () => {
      const later = { ...RUN, finished_at: '2026-11-18T00:05:00.000Z', last_success_at: '2026-11-18T00:05:00.000Z' };
      const f = vi.fn()
        .mockResolvedValueOnce(page(Array.from({ length: 500 }, (_, i) => cname(`a${i}.example.com`))))
        .mockResolvedValueOnce(page([cname('b.example.com')], later));
      vi.stubGlobal('fetch', f);
      expect(await fetchDnsRecords('self')).toEqual(INCOMPLETE);
      expect(f).toHaveBeenCalledTimes(2);
    });
    it('returns records across pages that share one succeeded ledger version', async () => {
      const f = vi.fn()
        .mockResolvedValueOnce(page(Array.from({ length: 500 }, (_, i) => cname(`a${i}.example.com`))))
        .mockResolvedValueOnce(page([cname('b.example.com')], { ...RUN }));
      vi.stubGlobal('fetch', f);
      const out = await fetchDnsRecords('self');
      expect(out.records).toHaveLength(501);
      expect(out).toMatchObject({ truncated: false, failed: false, incomplete: false });
    });
    it('still reports a non-OK or malformed response as failed, not incomplete', async () => {
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, json: async () => ({ rows: 'nope', run: null }) }));
      expect(await fetchDnsRecords('self')).toEqual({ records: [], truncated: false, failed: true, incomplete: false });
    });
  });
});
