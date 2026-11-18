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
  const page = (rows: unknown[]) => ({ ok: true, json: async () => ({ rows }) });

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
    });
    expect(String(f.mock.calls[0][0])).toContain('/api/inventory/route53?');
    expect(String(f.mock.calls[0][0])).toContain('accounts=self');
  });
  it('never throws: failures are flagged, an abort is not', async () => {
    const failed = { records: [], truncated: false, failed: true };
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, json: async () => ({}) }));
    expect(await fetchDnsRecords('self')).toEqual(failed);
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, json: async () => { throw new Error('bad'); } }));
    expect(await fetchDnsRecords('self')).toEqual(failed);
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, json: async () => ({ rows: 'nope' }) }));
    expect(await fetchDnsRecords('self')).toEqual(failed);
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('net')));
    expect(await fetchDnsRecords('self')).toEqual(failed);
    const ac = new AbortController(); ac.abort();
    expect(await fetchDnsRecords('self', ac.signal)).toEqual({ records: [], truncated: false, failed: false });
  });
  it('does not flag a fetch rejected by an abort of the passed signal', async () => {
    const ac = new AbortController();
    vi.stubGlobal('fetch', vi.fn().mockImplementation(async () => {
      ac.abort();
      throw new DOMException('aborted', 'AbortError');
    }));
    expect(await fetchDnsRecords('self', ac.signal)).toEqual({ records: [], truncated: false, failed: false });
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
});
