import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildTraceOverlay, fetchTraceOverlay, type ServiceTopologyView } from './k8s-trace-overlay';
import type { Entity, Relation } from './service-topology/snapshot';

// Fixture shapes follow the published snapshot projection of trace-graph.ts nodes/edges
// (read-published.ts → published.ts): service label = service.name, workload label =
// `ns/deployment`, db label = `${system}:${host}/${dbName}` with cluster/namespace null.
const ent = (id: string, kind: string, label: string, cluster: string | null, namespace: string | null): Entity => ({
  id, kind, label, layers: ['trace'], evidenceRefs: [], claim: false, region: 'ap-northeast-2', cluster, namespace,
  ownerReason: null, vpc: null, sourceId: 'tempo:1', spanCount: null, knownStatus: null, errors: null, durationSumMs: null,
});
const rel = (kind: string, source: string, target: string, spanCount?: number): Relation => ({
  id: `${kind}:${source}->${target}`, source, target, kind, layer: 'trace', confidence: 'observed', evidenceRefs: [],
  ...(spanCount !== undefined ? { spanCount } : {}),
});
const SNAP = '11111111-2222-4333-8444-555555555555';
const RDS_HOST = 'orders.cluster-abc.ap-northeast-2.rds.amazonaws.com';
// A healthy publication as the reader SQL returns it: top-level status 'partial' with the two baseline
// gaps (published.ts always seeds them) and fully qualified sources.
const HEALTHY_GAPS = ['nfm:not_collected', 'kubernetes:live_ownership_unavailable'];
type Source = NonNullable<ServiceTopologyView['sources']>[number];
const HEALTHY_SOURCE: Source = { sourceId: 'trace', generation: 'g1', status: 'ok', stale: false, retained: false, capped: false };
const page = (entities: Entity[], relations: Relation[], over: Partial<ServiceTopologyView> = {}): ServiceTopologyView => ({
  status: 'partial', snapshotId: SNAP, entities, relations, nextCursor: null, omitted: { entities: 0, relations: 0 },
  gaps: [...HEALTHY_GAPS], sources: [{ ...HEALTHY_SOURCE }], ...over,
});

const fixture = () => page(
  [
    ent('s-checkout', 'service', 'checkout', 'mall-a', 'prod'),
    ent('s-payments', 'service', 'payments', 'mall-a', 'prod'),
    ent('w-checkout', 'workload', 'prod/checkout', 'mall-a', 'prod'),
    ent('w-payments', 'workload', 'prod/payments', 'mall-a', 'prod'),
    ent('d-orders', 'db', `postgresql:${RDS_HOST}/orders`, null, null),
    ent('d-redis', 'db', 'redis:redis-master/0', null, null),
    // Same service name and workload label in another cluster: must never join mall-a.
    ent('s-other', 'service', 'checkout', 'mall-b', 'prod'),
    ent('s-other2', 'service', 'payments', 'mall-b', 'prod'),
    ent('w-other', 'workload', 'prod/checkout', 'mall-b', 'prod'),
    ent('w-other2', 'workload', 'prod/payments', 'mall-b', 'prod'),
  ],
  [
    rel('runs_on', 's-checkout', 'w-checkout'),
    rel('runs_on', 's-payments', 'w-payments'),
    rel('calls', 's-checkout', 's-payments', 7),
    rel('linked', 's-checkout', 's-payments'),
    rel('queries', 's-checkout', 'd-orders', 3),
    rel('queries', 's-payments', 'd-redis', 2),
    rel('runs_on', 's-other', 'w-other'),
    rel('runs_on', 's-other2', 'w-other2'),
    rel('calls', 's-other', 's-other2', 99),
  ],
);
const HOST = { id: 'mall-a', registeredNames: ['mall-a', 'mall-b'] };

describe('buildTraceOverlay', () => {
  it('joins entities whose cluster label equals the selected cluster name and is registered once', () => {
    const o = buildTraceOverlay([fixture()], HOST);
    expect(o.available).toBe(true);
    expect(o.reason).toBeUndefined();
    expect(o.omitted).toBe(0);
    expect(o.workloadCalls).toEqual([
      { fromWorkload: { namespace: 'prod', name: 'checkout' }, to: { datastoreHost: RDS_HOST }, spanCount: 3 },
      { fromWorkload: { namespace: 'prod', name: 'checkout' }, to: { workload: { namespace: 'prod', name: 'payments' } }, spanCount: 7 },
    ]);
    // The redis query has no managed host → not drawn, disclosed.
    expect(o.skipped).toBe(1);
  });

  it('joins an ARN-identified cluster of any account (host or member) whose name is unique across the fleet', () => {
    for (const account of ['111111111111', '123456789012']) {
      const arn = `arn:aws:eks:us-west-2:${account}:cluster/mall-a`;
      const o = buildTraceOverlay([fixture()], { id: arn, registeredNames: [arn, 'mall-b'] });
      expect(o.available).toBe(true);
      expect(o.reason).toBeUndefined();
      expect(o.workloadCalls).toEqual(buildTraceOverlay([fixture()], HOST).workloadCalls);
      expect(o.workloadCalls).toHaveLength(2);
    }
  });

  it('refuses a member ARN whose bare name also exists in another account', () => {
    const member = 'arn:aws:eks:ap-northeast-2:123456789012:cluster/mall-a';
    for (const registeredNames of [[member, 'mall-a'], [member, 'arn:aws:eks:ap-northeast-2:111111111111:cluster/mall-a']]) {
      expect(buildTraceOverlay([fixture()], { id: member, registeredNames }))
        .toEqual({ available: false, reason: 'ambiguous_cluster', workloadCalls: [], omitted: 0 });
    }
  });

  it('refuses the join when the cluster label is registered twice or not at all', () => {
    for (const registeredNames of [['mall-a', 'arn:aws:eks:us-east-1:222222222222:cluster/mall-a'], ['mall-a', 'mall-a'], ['mall-b']]) {
      expect(buildTraceOverlay([fixture()], { id: 'mall-a', registeredNames }))
        .toEqual({ available: false, reason: 'ambiguous_cluster', workloadCalls: [], omitted: 0 });
    }
  });

  it('refuses the join when the cluster listing is incomplete (a same-named cluster may be unlisted)', () => {
    expect(buildTraceOverlay([fixture()], { ...HOST, listingIncomplete: true }))
      .toEqual({ available: false, reason: 'incomplete_listing', workloadCalls: [], omitted: 0 });
    // A member cluster is refused by the same listing-completeness guard as a host cluster.
    const member = 'arn:aws:eks:us-east-1:123456789012:cluster/mall-a';
    expect(buildTraceOverlay([fixture()], { id: member, registeredNames: [member], listingIncomplete: true }))
      .toEqual({ available: false, reason: 'incomplete_listing', workloadCalls: [], omitted: 0 });
    expect(buildTraceOverlay([fixture()], { ...HOST, listingIncomplete: false }).available).toBe(true);
  });

  it('maps a service call only through runs_on, never by service-name similarity', () => {
    const p = fixture();
    // payments loses its runs_on relation; a workload labelled prod/payments still exists.
    p.relations = p.relations.filter((r) => r.id !== 'runs_on:s-payments->w-payments');
    const o = buildTraceOverlay([p], HOST);
    expect(o.workloadCalls).toEqual([
      { fromWorkload: { namespace: 'prod', name: 'checkout' }, to: { datastoreHost: RDS_HOST }, spanCount: 3 },
    ]);
    // checkout→payments (no workload) and payments→redis (no workload) are both unmappable.
    expect(o.skipped).toBe(2);
  });

  it('skips calls of a trace service that runs on two workloads', () => {
    const p = fixture();
    p.entities.push(ent('w-checkout-canary', 'workload', 'prod/checkout-canary', 'mall-a', 'prod'));
    p.relations.push(rel('runs_on', 's-checkout', 'w-checkout-canary'));
    const o = buildTraceOverlay([p], HOST);
    expect(o.workloadCalls).toEqual([]);
    expect(o.skipped).toBe(3);
  });

  it('merges spans of two trace scopes on the same workload pair and keeps a managed host with a port', () => {
    const p = fixture();
    p.entities.push(
      ent('s-checkout-2', 'service', 'checkout', 'mall-a', 'prod'),
      ent('w-checkout-2', 'workload', 'prod/checkout', 'mall-a', 'prod'),
      ent('d-orders-port', 'db', `mysql:${RDS_HOST.toUpperCase()}:3306/x`, null, null),
    );
    p.relations.push(
      rel('runs_on', 's-checkout-2', 'w-checkout-2'),
      rel('calls', 's-checkout-2', 's-payments', 5),
      rel('queries', 's-checkout-2', 'd-orders-port'),
    );
    const o = buildTraceOverlay([p], HOST);
    expect(o.workloadCalls).toEqual([
      { fromWorkload: { namespace: 'prod', name: 'checkout' }, to: { datastoreHost: RDS_HOST }, spanCount: 3 },
      { fromWorkload: { namespace: 'prod', name: 'checkout' }, to: { workload: { namespace: 'prod', name: 'payments' } }, spanCount: 12 },
    ]);
  });

  it('rejects workload labels that do not match the entity namespace', () => {
    const p = fixture();
    p.entities = p.entities.map((e) => (e.id === 'w-payments' ? { ...e, label: 'staging/payments' } : e));
    expect(buildTraceOverlay([p], HOST).workloadCalls.some((c) => 'workload' in c.to)).toBe(false);
  });

  it('emits no calls when the read is incomplete, and discloses what was not inspected', () => {
    const p = fixture();
    const o = buildTraceOverlay([{ ...p, omitted: { entities: 4, relations: 6 } }], HOST);
    expect(o).toMatchObject({ available: true, workloadCalls: [], omitted: 10 });
  });

  it('dedupes entities and relations repeated across pages', () => {
    const p = fixture();
    const o = buildTraceOverlay([p, page(p.entities.slice(0, 2), p.relations.slice(0, 1))], HOST);
    expect(o.omitted).toBe(0);
    expect(o.workloadCalls).toHaveLength(2);
  });

  it('joins a production-realistic healthy publication (status partial with only the baseline gaps)', () => {
    const o = buildTraceOverlay([fixture()], HOST);
    expect(o.available).toBe(true);
    expect(o.workloadCalls).toHaveLength(2);
  });

  const PARTIAL = { available: false, reason: 'partial_snapshot', workloadCalls: [], omitted: 0 };
  it('emits no calls for a gap beyond the baseline gaps', () => {
    expect(buildTraceOverlay([{ ...fixture(), gaps: [...HEALTHY_GAPS, 'trace:capped'] }], HOST)).toEqual(PARTIAL);
  });

  it.each<[string, Partial<Source>]>([
    ['stale', { stale: true }],
    ['retained', { retained: true }],
    ['capped', { capped: true }],
    ['without a generation', { generation: null }],
    ['with a missing generation', { generation: undefined }],
    ['with status failed', { status: 'failed' }],
    ['with a missing status', { status: undefined }],
  ])('emits no calls when a source is %s', (_label, over) => {
    const p = { ...fixture(), sources: [{ ...HEALTHY_SOURCE }, { ...HEALTHY_SOURCE, sourceId: 'metrics', ...over }] };
    expect(buildTraceOverlay([p], HOST)).toEqual(PARTIAL);
  });

  it('accepts a source with status empty that has a generation', () => {
    const p = { ...fixture(), sources: [{ ...HEALTHY_SOURCE }, { ...HEALTHY_SOURCE, sourceId: 'metrics', status: 'empty' }] };
    const o = buildTraceOverlay([p], HOST);
    expect(o.available).toBe(true);
    expect(o.workloadCalls).toHaveLength(2);
  });

  it('fails closed when gaps or sources are missing', () => {
    expect(buildTraceOverlay([{ ...fixture(), gaps: undefined }], HOST)).toEqual(PARTIAL);
    expect(buildTraceOverlay([{ ...fixture(), sources: undefined }], HOST)).toEqual(PARTIAL);
  });

  it('emits no calls when only the second page of a multi-page read has an extra gap', () => {
    const p = fixture();
    const second = page(p.entities.slice(0, 2), p.relations.slice(0, 1), { gaps: [...HEALTHY_GAPS, 'manifest:unresolved_source_batches'] });
    expect(buildTraceOverlay([p, second], HOST)).toEqual(PARTIAL);
  });

  it('is unavailable for no pages, an unparseable id or a mixed snapshot', () => {
    expect(buildTraceOverlay([], HOST).reason).toBe('unavailable');
    expect(buildTraceOverlay([fixture()], { id: 'bad id', registeredNames: ['bad id'] }).reason).toBe('unavailable');
    const other = page([], [], { snapshotId: '99999999-2222-4333-8444-555555555555' });
    expect(buildTraceOverlay([fixture(), other], HOST).reason).toBe('unavailable');
  });
});

describe('fetchTraceOverlay', () => {
  afterEach(() => vi.unstubAllGlobals());
  const respond = (status: number, body: unknown) =>
    ({ ok: status >= 200 && status < 300, status, json: async () => body }) as unknown as Response;
  const stub = (impl: (url: string, init?: RequestInit) => Promise<Response>) => {
    const fn = vi.fn(impl);
    vi.stubGlobal('fetch', fn);
    return fn;
  };

  it('reads one page with a plain same-origin fetch and builds the overlay', async () => {
    const fn = stub(async () => respond(200, fixture()));
    const signal = new AbortController().signal;
    const o = await fetchTraceOverlay(HOST, signal);
    expect(o.available).toBe(true);
    expect(o.workloadCalls).toHaveLength(2);
    expect(fn).toHaveBeenCalledTimes(1);
    expect(fn.mock.calls[0][0]).toBe('/api/topology?lens=service');
    expect(fn.mock.calls[0][1]).toEqual({ signal });
  });

  it.each([
    [404, 'disabled'], [422, 'unsupported_scope'], [503, 'unavailable'], [500, 'unavailable'], [401, 'unavailable'],
  ])('maps HTTP %i to %s', async (status, reason) => {
    stub(async () => respond(status, { error: 'x' }));
    expect(await fetchTraceOverlay(HOST)).toEqual({ available: false, reason, workloadCalls: [], omitted: 0 });
  });

  it('never throws: network errors, aborts, bad JSON and unpublished snapshots are unavailable', async () => {
    stub(async () => { throw new TypeError('network'); });
    expect((await fetchTraceOverlay(HOST)).reason).toBe('unavailable');
    stub(async () => { throw new DOMException('aborted', 'AbortError'); });
    expect((await fetchTraceOverlay(HOST)).reason).toBe('unavailable');
    stub(async () => ({ ok: true, status: 200, json: async () => { throw new SyntaxError('bad'); } }) as unknown as Response);
    expect((await fetchTraceOverlay(HOST)).reason).toBe('unavailable');
    stub(async () => respond(200, { contractVersion: 1, status: 'unavailable', snapshotId: null, reason: 'no_publication' }));
    expect((await fetchTraceOverlay(HOST)).reason).toBe('unavailable');
    stub(async () => respond(200, { ...fixture(), entities: 'nope' }));
    expect((await fetchTraceOverlay(HOST)).reason).toBe('unavailable');
    stub(async () => respond(200, { ...fixture(), gaps: [1] }));
    expect((await fetchTraceOverlay(HOST)).reason).toBe('unavailable');
    stub(async () => respond(200, { ...fixture(), sources: ['x'] }));
    expect((await fetchTraceOverlay(HOST)).reason).toBe('unavailable');
    stub(async () => respond(200, { ...fixture(), sources: [{ ...HEALTHY_SOURCE, generation: 7 }] }));
    expect((await fetchTraceOverlay(HOST)).reason).toBe('unavailable');
  });

  it('returns partial_snapshot for a fetched page with a stale source', async () => {
    stub(async () => respond(200, { ...fixture(), sources: [{ ...HEALTHY_SOURCE, stale: true }] }));
    expect(await fetchTraceOverlay(HOST)).toEqual({ available: false, reason: 'partial_snapshot', workloadCalls: [], omitted: 0 });
  });

  it('returns incomplete_listing or ambiguous_cluster without fetching, also for a member cluster', async () => {
    const fn = stub(async () => respond(200, fixture()));
    const member = 'arn:aws:eks:ap-northeast-2:123456789012:cluster/mall-a';
    expect((await fetchTraceOverlay({ id: member, registeredNames: [member, 'mall-a'] })).reason).toBe('ambiguous_cluster');
    expect((await fetchTraceOverlay({ id: member, registeredNames: [member], listingIncomplete: true })).reason).toBe('incomplete_listing');
    expect((await fetchTraceOverlay({ id: 'mall-a', registeredNames: ['mall-a', 'mall-a'] })).reason).toBe('ambiguous_cluster');
    expect((await fetchTraceOverlay({ ...HOST, listingIncomplete: true })).reason).toBe('incomplete_listing');
    expect(fn).not.toHaveBeenCalled();
  });

  it('reads the snapshot and draws calls for a member cluster whose name is unique across the fleet', async () => {
    const fn = stub(async () => respond(200, fixture()));
    const member = 'arn:aws:eks:ap-northeast-2:123456789012:cluster/mall-a';
    const o = await fetchTraceOverlay({ id: member, registeredNames: [member, 'mall-b'] });
    expect(fn).toHaveBeenCalledTimes(1);
    expect(o.available).toBe(true);
    expect(o.workloadCalls).toHaveLength(2);
  });

  it('follows nextCursor on the pinned snapshot, stops after 5 pages and sets omitted from the response', async () => {
    const fn = stub(async (url) => {
      const cursor = Number(new URL(url, 'http://x').searchParams.get('cursor') ?? '0');
      return respond(200, page([ent(`e${cursor}`, 'service', `svc${cursor}`, 'mall-a', 'prod')], [], {
        status: 'partial', nextCursor: cursor + 200, omitted: { entities: 10, relations: 0 },
      }));
    });
    const o = await fetchTraceOverlay(HOST);
    expect(fn).toHaveBeenCalledTimes(5);
    expect(fn.mock.calls.map((c) => c[0])).toEqual([
      '/api/topology?lens=service',
      `/api/topology?lens=service&snapshot=${SNAP}&cursor=200`,
      `/api/topology?lens=service&snapshot=${SNAP}&cursor=400`,
      `/api/topology?lens=service&snapshot=${SNAP}&cursor=600`,
      `/api/topology?lens=service&snapshot=${SNAP}&cursor=800`,
    ]);
    // Last page: 1 visible + 10 omitted = 11 eligible entities; 5 were read.
    expect(o).toMatchObject({ available: true, workloadCalls: [], omitted: 6 });
  });

  it('is unavailable when a later page reports another snapshot or an invalid cursor', async () => {
    let n = 0;
    stub(async () => respond(200, page([], [], n++ === 0
      ? { nextCursor: 200 }
      : { snapshotId: '99999999-2222-4333-8444-555555555555' })));
    expect((await fetchTraceOverlay(HOST)).reason).toBe('unavailable');
    stub(async () => respond(200, page([], [], { nextCursor: -1 as unknown as number })));
    expect((await fetchTraceOverlay(HOST)).reason).toBe('unavailable');
  });
});
