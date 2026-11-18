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
    expect(out).toEqual([
      { name: 'app.example.com', target: ELB },
      { name: 'www.example.com', target: ELB },
    ]);
    expect(String(f.mock.calls[0][0])).toContain('/api/inventory/route53?');
    expect(String(f.mock.calls[0][0])).toContain('accounts=self');
  });
  it('returns [] on non-OK, bad JSON, throw and abort', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, json: async () => ({}) }));
    expect(await fetchDnsRecords('self')).toEqual([]);
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, json: async () => { throw new Error('bad'); } }));
    expect(await fetchDnsRecords('self')).toEqual([]);
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, json: async () => ({ rows: 'nope' }) }));
    expect(await fetchDnsRecords('self')).toEqual([]);
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('net')));
    expect(await fetchDnsRecords('self')).toEqual([]);
    const ac = new AbortController(); ac.abort();
    expect(await fetchDnsRecords('self', ac.signal)).toEqual([]);
  });
  it('caps pages and records', async () => {
    const many = Array.from({ length: 500 }, (_, i) => row({ name: `h${i}.example.com`, type: 'CNAME', records: [ELB] }));
    const f = vi.fn().mockResolvedValue(page(many));
    vi.stubGlobal('fetch', f);
    const out = await fetchDnsRecords('self');
    expect(f.mock.calls.length).toBeLessThanOrEqual(5);
    expect(out.length).toBeLessThanOrEqual(2000);
  });
});
