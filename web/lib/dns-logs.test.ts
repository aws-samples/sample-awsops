import { describe, it, expect, vi, beforeEach } from 'vitest';

const logsSend = vi.fn();
const r53Send = vi.fn();
vi.mock('@aws-sdk/client-cloudwatch-logs', () => ({
  CloudWatchLogsClient: class { send = logsSend; },
  StartQueryCommand: class { constructor(public input: unknown) {} },
  GetQueryResultsCommand: class { constructor(public input: unknown) {} },
  StopQueryCommand: class { constructor(public input: unknown) {} },
  DescribeLogGroupsCommand: class { constructor(public input: unknown) {} },
}));
vi.mock('@aws-sdk/client-route53resolver', () => ({
  Route53ResolverClient: class { send = r53Send; },
  ListResolverQueryLogConfigsCommand: class { constructor(public input: unknown) {} },
}));

beforeEach(async () => {
  logsSend.mockReset();
  r53Send.mockReset();
  const { _resetDnsCacheForTests } = await import('./dns-logs');
  _resetDnsCacheForTests();
});

type Cmd = { constructor: { name: string }; input: Record<string, unknown> };

describe('dnsLogStatus', () => {
  it('parses destinationArn (log-group → name, :* stripped, S3 → null) and builds groups', async () => {
    r53Send.mockResolvedValue({
      ResolverQueryLogConfigs: [
        {
          Id: 'rqlc-1', Name: 'to-cw', Status: 'CREATED', AssociationCount: 2,
          DestinationArn: 'arn:aws:logs:ap-northeast-2:111111111111:log-group:/aws/route53/queries',
        },
        {
          Id: 'rqlc-2', Name: 'to-cw-star', Status: 'CREATED', AssociationCount: 1,
          DestinationArn: 'arn:aws:logs:ap-northeast-2:111111111111:log-group:/aws/route53/other:*',
        },
        {
          Id: 'rqlc-3', Name: 'to-s3', Status: 'CREATED', AssociationCount: 0,
          DestinationArn: 'arn:aws:s3:::my-dns-log-bucket',
        },
      ],
    });
    const { dnsLogStatus } = await import('./dns-logs');
    const s = await dnsLogStatus();
    expect(s.configs).toEqual([
      {
        id: 'rqlc-1', name: 'to-cw', status: 'CREATED', associationCount: 2,
        destinationArn: 'arn:aws:logs:ap-northeast-2:111111111111:log-group:/aws/route53/queries',
        logGroup: '/aws/route53/queries',
      },
      {
        id: 'rqlc-2', name: 'to-cw-star', status: 'CREATED', associationCount: 1,
        destinationArn: 'arn:aws:logs:ap-northeast-2:111111111111:log-group:/aws/route53/other:*',
        logGroup: '/aws/route53/other', // ':*' suffix stripped
      },
      {
        id: 'rqlc-3', name: 'to-s3', status: 'CREATED', associationCount: 0,
        destinationArn: 'arn:aws:s3:::my-dns-log-bucket',
        logGroup: null, // S3 destination → not analyzable
      },
    ]);
    // S3-destination config (logGroup null) excluded from groups
    expect(s.groups).toEqual(['/aws/route53/queries', '/aws/route53/other']);
  });

  it('returns empty configs/groups when no query-log configs exist', async () => {
    r53Send.mockResolvedValue({});
    const { dnsLogStatus } = await import('./dns-logs');
    expect(await dnsLogStatus()).toEqual({ configs: [], groups: [] });
  });

  it('caches: second call sends no additional commands', async () => {
    r53Send.mockResolvedValue({ ResolverQueryLogConfigs: [] });
    const { dnsLogStatus } = await import('./dns-logs');
    await dnsLogStatus();
    await dnsLogStatus();
    expect(r53Send).toHaveBeenCalledTimes(1);
  });
});

// ── dnsAnalytics fixtures ─────────────────────────────────────────────────────
// Dispatch helper: the 8 Insights queries run in parallel, so responses are
// routed by query string (StartQuery encodes the analysis key into the queryId,
// GetQueryResults routes on it). First GetQueryResults is terminal (Complete /
// Failed) so runInsights never sleeps.
const f = (field: string, value: string) => ({ field, value });

function queryKey(q: string): string {
  if (q.includes('count_distinct')) return 'totals';
  if (q.includes('NXDOMAIN')) return 'topNxdomain';
  if (q.includes('firewall')) return 'firewall';
  if (q.includes('by rcode')) return 'rcode';
  if (q.includes('by query_type')) return 'qtype';
  if (q.includes('srcaddr')) return 'topSources';
  if (q.includes('bin(')) return 'timeline';
  if (q.includes('by query_name')) return 'topDomains';
  throw new Error(`unrecognized query: ${q}`);
}

const resultsByKey: Record<string, { field: string; value: string }[][]> = {
  totals: [[f('total', '1234'), f('uniq', '87')]],
  rcode: [
    [f('rcode', 'NOERROR'), f('cnt', '1000')],
    [f('rcode', 'NXDOMAIN'), f('cnt', '150')],
    [f('rcode', 'SERVFAIL'), f('cnt', '84')],
  ],
  qtype: [
    [f('query_type', 'A'), f('cnt', '900')],
    [f('query_type', 'AAAA'), f('cnt', '334')],
  ],
  topDomains: [[f('query_name', 'example.com.'), f('cnt', '500')]],
  topNxdomain: [[f('query_name', 'missing.internal.'), f('cnt', '120')]],
  topSources: [
    [f('srcaddr', '10.0.1.10'), f('instance', 'i-abc'), f('cnt', '40'), f('@ptr', 'CgAB')],
    [f('srcaddr', '10.0.2.20'), f('instance', ''), f('cnt', '30')], // no instance → null
    [f('cnt', '5')], // no srcaddr → dropped
  ],
  timeline: [
    [f('t', '2026-08-01 10:00:00.000'), f('cnt', '10')],
    [f('t', '2026-08-01 10:02:00.000'), f('cnt', '20')],
  ],
  firewall: [[f('firewall_rule_action', 'BLOCK'), f('query_name', 'bad.example.'), f('cnt', '7')]],
};

/** Mock all Insights chains: StartQuery → queryId `q-<key>`, GetQueryResults routed by key. */
function mockInsights(failKeys: string[] = []) {
  logsSend.mockImplementation(async (cmd: Cmd) => {
    switch (cmd.constructor.name) {
      case 'StartQueryCommand':
        return { queryId: `q-${queryKey(String(cmd.input.queryString))}` };
      case 'GetQueryResultsCommand': {
        const key = String(cmd.input.queryId).slice(2);
        if (failKeys.includes(key)) return { status: 'Failed' };
        return { status: 'Complete', results: resultsByKey[key] ?? [] };
      }
      case 'StopQueryCommand':
        return {};
      default:
        throw new Error(`unexpected command ${cmd.constructor.name}`);
    }
  });
}

describe('dnsAnalytics', () => {
  it('runs all queries and normalizes: totals numbers, rcode extraction, instance null, timeline, firewall', async () => {
    mockInsights();
    const { dnsAnalytics } = await import('./dns-logs');
    const a = await dnsAnalytics('/aws/route53/queries', 3600);

    // totals: string → number conversion, nxdomain/servfail pulled from rcode rows
    expect(a.totals).toEqual({ total: 1234, nxdomain: 150, servfail: 84, uniqueDomains: 87 });
    expect(a.rcode).toEqual([
      { name: 'NOERROR', value: 1000 },
      { name: 'NXDOMAIN', value: 150 },
      { name: 'SERVFAIL', value: 84 },
    ]);
    expect(a.qtype).toEqual([
      { name: 'A', value: 900 },
      { name: 'AAAA', value: 334 },
    ]);
    expect(a.topDomains).toEqual([{ name: 'example.com.', value: 500 }]);
    expect(a.topNxdomain).toEqual([{ name: 'missing.internal.', value: 120 }]);
    // empty instance → null, srcaddr-less row dropped, @ptr field ignored
    expect(a.topSources).toEqual([
      { srcaddr: '10.0.1.10', instance: 'i-abc', value: 40 },
      { srcaddr: '10.0.2.20', instance: null, value: 30 },
    ]);
    expect(a.timeline).toEqual([
      { t: '2026-08-01 10:00:00.000', value: 10 },
      { t: '2026-08-01 10:02:00.000', value: 20 },
    ]);
    expect(a.firewall).toEqual([{ action: 'BLOCK', domain: 'bad.example.', value: 7 }]);
    expect(a.failed).toEqual([]);
  });

  it('degrades a Failed query to empty + failed key, others stay intact', async () => {
    mockInsights(['firewall']);
    const { dnsAnalytics } = await import('./dns-logs');
    const a = await dnsAnalytics('/aws/route53/queries', 3600);
    expect(a.failed).toEqual(['firewall']);
    expect(a.firewall).toEqual([]);
    // Remaining analyses unaffected
    expect(a.totals).toEqual({ total: 1234, nxdomain: 150, servfail: 84, uniqueDomains: 87 });
    expect(a.topDomains).toEqual([{ name: 'example.com.', value: 500 }]);
    expect(a.timeline).toHaveLength(2);
  });

  it('caches by group+range: second identical call sends nothing new', async () => {
    mockInsights();
    const { dnsAnalytics } = await import('./dns-logs');
    await dnsAnalytics('/aws/route53/queries', 3600);
    const calls = logsSend.mock.calls.length;
    await dnsAnalytics('/aws/route53/queries', 3600);
    expect(logsSend).toHaveBeenCalledTimes(calls);
  });

  it('maps rangeSec 3600 to bin(120s) in the timeline query', async () => {
    mockInsights();
    const { dnsAnalytics } = await import('./dns-logs');
    await dnsAnalytics('/aws/route53/queries', 3600);
    const timelineQueries = logsSend.mock.calls
      .map(([c]) => c as Cmd)
      .filter((c) => c.constructor.name === 'StartQueryCommand')
      .map((c) => String(c.input.queryString))
      .filter((q) => q.includes('bin('));
    expect(timelineQueries).toHaveLength(1);
    expect(timelineQueries[0]).toContain('bin(120s)');
  });
});

// ── coreDnsGroups ─────────────────────────────────────────────────────────────

describe('coreDnsGroups', () => {
  it("keeps only '/aws/containerinsights/<cluster>/application' groups and parses cluster", async () => {
    logsSend.mockResolvedValue({
      logGroups: [
        { logGroupName: '/aws/containerinsights/prod-eks/application' },
        { logGroupName: '/aws/containerinsights/prod-eks/performance' },
        { logGroupName: '/aws/containerinsights/prod-eks/dataplane' },
        { logGroupName: '/aws/containerinsights/dev-eks/application' },
        { logGroupName: '/aws/containerinsights/dev-eks/host' },
      ],
    });
    const { coreDnsGroups } = await import('./dns-logs');
    expect(await coreDnsGroups()).toEqual([
      { cluster: 'prod-eks', group: '/aws/containerinsights/prod-eks/application' },
      { cluster: 'dev-eks', group: '/aws/containerinsights/dev-eks/application' },
    ]);
    const cmd = logsSend.mock.calls[0][0] as Cmd;
    expect(cmd.constructor.name).toBe('DescribeLogGroupsCommand');
    expect(cmd.input.logGroupNamePrefix).toBe('/aws/containerinsights/');
  });

  it('caches: second call sends no additional commands', async () => {
    logsSend.mockResolvedValue({ logGroups: [] });
    const { coreDnsGroups } = await import('./dns-logs');
    await coreDnsGroups();
    await coreDnsGroups();
    expect(logsSend).toHaveBeenCalledTimes(1);
  });
});

// ── coreDnsAnalytics fixtures ─────────────────────────────────────────────────
// Same dispatch idea as dnsAnalytics: 4 parallel Insights queries, routed by
// query-string keyword. All CoreDNS queries share the CORE_PARSE prefix, so the
// keywords must come from each query's stats/by clause, not the parse pattern.
function coreQueryKey(q: string): string {
  if (q.includes('percentile')) return 'totals';
  if (q.includes('by rcode')) return 'rcode';
  if (q.includes('by qname')) return 'topDomains';
  if (q.includes('bin(')) return 'timeline';
  throw new Error(`unrecognized CoreDNS query: ${q}`);
}

const coreResultsByKey: Record<string, { field: string; value: string }[][]> = {
  // percentile(dur, N) comes back as a fractional-seconds string
  totals: [[f('total', '5000'), f('p50', '0.000107'), f('p95', '0.004215')]],
  rcode: [
    [f('rcode', 'NOERROR'), f('cnt', '4000')],
    [f('rcode', 'NXDOMAIN'), f('cnt', '800')],
    [f('rcode', 'SERVFAIL'), f('cnt', '200')],
  ],
  topDomains: [[f('qname', 'kubernetes.default.svc.cluster.local'), f('cnt', '1200')]],
  timeline: [
    [f('t', '2026-08-01 10:00:00.000'), f('cnt', '50')],
    [f('t', '2026-08-01 10:02:00.000'), f('cnt', '60')],
  ],
};

function mockCoreInsights(failKeys: string[] = [], results = coreResultsByKey) {
  logsSend.mockImplementation(async (cmd: Cmd) => {
    switch (cmd.constructor.name) {
      case 'StartQueryCommand':
        return { queryId: `q-${coreQueryKey(String(cmd.input.queryString))}` };
      case 'GetQueryResultsCommand': {
        const key = String(cmd.input.queryId).slice(2);
        if (failKeys.includes(key)) return { status: 'Failed' };
        return { status: 'Complete', results: results[key] ?? [] };
      }
      case 'StopQueryCommand':
        return {};
      default:
        throw new Error(`unexpected command ${cmd.constructor.name}`);
    }
  });
}

describe('coreDnsAnalytics', () => {
  const GROUP = '/aws/containerinsights/prod-eks/application';

  it('normalizes totals with percentile sec→ms conversion, rcode extraction, topDomains, timeline', async () => {
    mockCoreInsights();
    const { coreDnsAnalytics } = await import('./dns-logs');
    const a = await coreDnsAnalytics(GROUP, 3600);

    // '0.000107' s → 0.107 ms, '0.004215' s → 4.215 ms
    expect(a.totals).toEqual({ total: 5000, nxdomain: 800, servfail: 200, p50Ms: 0.107, p95Ms: 4.215 });
    expect(a.rcode).toEqual([
      { name: 'NOERROR', value: 4000 },
      { name: 'NXDOMAIN', value: 800 },
      { name: 'SERVFAIL', value: 200 },
    ]);
    expect(a.topDomains).toEqual([{ name: 'kubernetes.default.svc.cluster.local', value: 1200 }]);
    expect(a.timeline).toEqual([
      { t: '2026-08-01 10:00:00.000', value: 50 },
      { t: '2026-08-01 10:02:00.000', value: 60 },
    ]);
    expect(a.failed).toEqual([]);
  });

  it('maps empty/absent percentiles to null (no traffic → no latency claim)', async () => {
    // p50 present but empty string, p95 field absent entirely — both → null
    mockCoreInsights([], { ...coreResultsByKey, totals: [[f('total', '10'), f('p50', '')]] });
    const { coreDnsAnalytics } = await import('./dns-logs');
    const a = await coreDnsAnalytics(GROUP, 3600);
    expect(a.totals).toEqual({ total: 10, nxdomain: 800, servfail: 200, p50Ms: null, p95Ms: null });
  });

  it('degrades a Failed query to empty + failed key, others stay intact', async () => {
    mockCoreInsights(['timeline']);
    const { coreDnsAnalytics } = await import('./dns-logs');
    const a = await coreDnsAnalytics(GROUP, 3600);
    expect(a.failed).toEqual(['timeline']);
    expect(a.timeline).toEqual([]);
    expect(a.totals).toEqual({ total: 5000, nxdomain: 800, servfail: 200, p50Ms: 0.107, p95Ms: 4.215 });
    expect(a.topDomains).toHaveLength(1);
  });
});
