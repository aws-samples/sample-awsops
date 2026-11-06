import { describe, expect, it, vi } from 'vitest';
vi.mock('@/lib/datasources', () => ({}));
vi.mock('@/lib/mcp-lambda-invoke', () => ({}));
import { buildInfraGraph } from './infra-topology';
import { buildTraceGraph, type InfraNodeLike } from './trace-graph';
import { mapTempoTrace, type TraceSpan } from './trace-source';

const account = '123456789012';
const region = 'ap-northeast-2';
const instanceA = 'i-0123456789abcdef0';
const instanceB = 'i-0fedcba9876543210';
const instanceRefA = 'ec2:@123456789012:ap-northeast-2:i-0123456789abcdef0';
const instanceRefB = 'ec2:@123456789012:ap-northeast-2:i-0fedcba9876543210';
const databaseRefA = 'rds:@123456789012:ap-northeast-2:orders';
const databaseRefB = 'rds:@123456789012:ap-northeast-2:billing';
const dbHostA = 'orders.cluster-abcdef.ap-northeast-2.rds.amazonaws.com';
const dbHostB = 'billing.cluster-fedcba.ap-northeast-2.rds.amazonaws.com';

function inventory(inventoryAccount = account, inventoryRegion = region): InfraNodeLike[] {
  return buildInfraGraph({
    resources: [
      { resource_type: 'ec2', resource_id: instanceA, account_id: inventoryAccount,
        region: inventoryRegion, data: { vpc_id: 'vpc-a' } },
      { resource_type: 'ec2', resource_id: instanceB, account_id: inventoryAccount,
        region: inventoryRegion, data: { vpc_id: 'vpc-a' } },
      { resource_type: 'rds', resource_id: 'orders', account_id: inventoryAccount,
        region: inventoryRegion, data: { vpc_id: 'vpc-a', endpoint_address: dbHostA } },
      { resource_type: 'rds', resource_id: 'billing', account_id: inventoryAccount,
        region: inventoryRegion, data: { vpc_id: 'vpc-a', endpoint_address: dbHostB } },
    ],
    vpcs: [], subnets: [], securityGroups: [],
  }).nodes;
}

function dbSpan(over: Partial<TraceSpan> = {}): TraceSpan {
  return {
    traceId: 'private-trace', spanId: 'query-a', service: 'checkout', kind: 'CLIENT',
    sourceId: 'tempo:7', accountId: account, region, hostId: instanceA,
    dbSystem: 'postgresql', dbHost: dbHostA,
    startMs: 1_794_000_000_000, durationMs: 5, ...over,
  };
}

describe('same-span EC2 and DB observations', () => {
  it('keeps A→DB1 and B→DB2 for one service without inventing cross-instance pairs', () => {
    const spans = [dbSpan(), dbSpan({ spanId: 'query-b', hostId: instanceB, dbHost: dbHostB })];
    const graph = buildTraceGraph(spans, [], inventory());
    expect(graph.nodes.filter(node => node.kind === 'service')).toHaveLength(1);
    const queries = graph.edges.filter(edge => edge.rel === 'queries');
    expect(queries).toHaveLength(2);
    const observations = queries.flatMap(edge => edge.meta.instance_observations ?? []);
    expect(observations.map(pair => [pair.instance_ref, pair.database_ref])).toEqual([
      [instanceRefA, databaseRefA],
      [instanceRefB, databaseRefB],
    ]);
    expect(observations[0]).toMatchObject({
      instance_id: instanceA, instance_ref: instanceRefA, database_ref: databaseRefA,
      account, region, db_host: dbHostA, observed_at_ms: 1_794_000_000_000,
      source_id: 'tempo:7', provenance: 'trace_span',
    });
    expect(observations[0].correlation_id).toMatch(/^[0-9a-f]{64}$/);
    expect(observations[0].correlation_id).not.toBe(observations[1].correlation_id);
    expect(JSON.stringify(observations)).not.toContain('private-trace');
    expect(buildTraceGraph([...spans].reverse(), [], inventory()).edges
      .flatMap(edge => edge.meta.instance_observations ?? [])
      .map(pair => pair.correlation_id).sort())
      .toEqual(observations.map(pair => pair.correlation_id).sort());
  });

  it.each([
    { cloudResourceId: `arn:aws:ec2:${region}:${account}:instance/${instanceA}` },
    { hostId: instanceA },
    { serviceInstanceId: instanceA },
  ])('joins each valid allowlisted identity claim only within its scope: %j', claims => {
    const graph = buildTraceGraph([dbSpan({ hostId: undefined, ...claims })], [], inventory());
    expect(graph.edges[0].meta.instance_observations).toHaveLength(1);
    expect(graph.edges[0].meta.instance_observations?.[0]).toMatchObject({
      instance_id: instanceA, instance_ref: instanceRefA, database_ref: databaseRefA,
    });
  });

  it('resolves host self inventory only against the configured actual host account', () => {
    const graph = buildTraceGraph([dbSpan()], [], inventory('self'), account);
    expect(graph.edges[0].meta.instance_observations?.[0]).toMatchObject({
      instance_id: instanceA, instance_ref: `ec2:@self:${region}:${instanceA}`,
      database_ref: 'rds:@self:ap-northeast-2:orders', account,
    });
    expect(buildTraceGraph([dbSpan()], [], inventory('self')).edges[0].meta)
      .not.toHaveProperty('instance_observations');
    expect(buildTraceGraph([dbSpan()], [], inventory('self'), '999999999999').edges[0].meta)
      .not.toHaveProperty('instance_observations');
  });

  it.each([
    ['missing identity', { hostId: undefined }],
    ['missing account', { accountId: undefined }],
    ['self claim without actual account', { accountId: 'self' }],
    ['missing region', { region: undefined }],
    ['unknown instance', { hostId: 'i-11111111111111111' }],
    ['invalid instance ID', { hostId: 'checkout-prod' }],
    ['ARN account conflicts with resource account', {
      cloudResourceId: `arn:aws:ec2:${region}:999999999999:instance/${instanceA}`,
    }],
    ['ARN region conflicts with resource region', {
      cloudResourceId: `arn:aws:ec2:us-east-1:${account}:instance/${instanceA}`,
    }],
    ['identity claims disagree', { serviceInstanceId: instanceB }],
    ['DB name prefix is not an exact endpoint', { dbHost: 'orders' }],
    ['wrong account', { accountId: '999999999999' }],
    ['wrong region', { region: 'us-east-1' }],
    ['invalid observation time', { startMs: Number.NaN }],
  ] as const)('keeps service→DB and instance unknown for %s', (_name, over) => {
    const graph = buildTraceGraph([dbSpan(over)], [], inventory(), account);
    expect(graph.edges.filter(edge => edge.rel === 'queries')).toHaveLength(1);
    expect(graph.edges[0].meta).not.toHaveProperty('instance_observations');
    // A claimed instance that cannot be bound is disclosed; an absent/non-EC2 claim is not evidence.
    expect(graph.edges[0].meta.instance_observations_unbound)
      .toBe(/missing identity|invalid instance ID/.test(_name) ? undefined : 1);
    expect(graph).not.toHaveProperty('instanceObservationDrops');
  });

  it('binds Tempo nanosecond spans at whole-millisecond observation time', () => {
    const attr = (key: string, value: string) => ({ key, value: { stringValue: value } });
    const [span] = mapTempoTrace('00112233445566778899aabbccddeeff', { batches: [{
      resource: { attributes: [attr('service.name', 'checkout'), attr('cloud.account.id', account),
        attr('cloud.region', region), attr('host.id', instanceA)] },
      scopeSpans: [{ spans: [{ spanId: '1122334455667788', kind: 3,
        startTimeUnixNano: '1762000000123456789', endTimeUnixNano: '1762000000128456789',
        attributes: [attr('db.system', 'postgresql'), attr('server.address', dbHostA)] }] }],
    }] });
    const graph = buildTraceGraph([span], [], inventory(), account);
    expect(graph.edges[0].meta.instance_observations?.[0]).toMatchObject({
      instance_ref: instanceRefA, observed_at_ms: 1_762_000_000_123, first_observed_at_ms: 1_762_000_000_123,
    });
    expect(graph.edges[0].meta).not.toHaveProperty('instance_observations_unbound');
  });

  it('rejects duplicate matching instance or endpoint inventory identities', () => {
    for (const kind of ['ec2', 'rds']) {
      const nodes = inventory();
      const duplicate = nodes.find(node => node.kind === kind)!;
      const graph = buildTraceGraph([dbSpan()], [], [...nodes, { ...duplicate, id: duplicate.id + '-duplicate' }]);
      expect(graph.edges[0].meta).not.toHaveProperty('instance_observations');
    }
  });

  it('does not let same-name endpoints in another scope invalidate or supply a pair', () => {
    const nodes = [...inventory(), ...inventory('999999999999'), ...inventory(account, 'us-east-1')];
    const graph = buildTraceGraph([dbSpan()], [], nodes);
    expect(graph.edges[0].meta.instance_observations?.[0]).toMatchObject({
      instance_ref: instanceRefA, database_ref: databaseRefA,
    });
    const local = inventory().filter(node => node.kind !== 'rds');
    expect(buildTraceGraph([dbSpan()], [], [...local, ...inventory('999999999999')])
      .edges[0].meta).not.toHaveProperty('instance_observations');
  });

  it('preserves graph identities, Kubernetes placement and sampled counts', () => {
    const withIdentity = dbSpan({ k8sNamespace: 'shop', k8sDeployment: 'checkout' });
    const graph = buildTraceGraph([withIdentity, withIdentity], [], inventory());
    const noIdentity = buildTraceGraph([{ ...withIdentity, hostId: undefined }], [], inventory());
    expect(graph.nodes.map(node => node.id)).toEqual(noIdentity.nodes.map(node => node.id));
    expect(graph.edges.map(edge => [edge.source, edge.target, edge.rel]))
      .toEqual(noIdentity.edges.map(edge => [edge.source, edge.target, edge.rel]));
    expect(graph.edges.find(edge => edge.rel === 'queries')?.meta).toMatchObject({
      spanCount: 1, metricCount: 0,
    });
    expect(graph.edges.find(edge => edge.rel === 'queries')?.meta.instance_observations).toHaveLength(1);
    expect(graph.edges.find(edge => edge.rel === 'runs_on')?.meta)
      .not.toHaveProperty('instance_observations');
  });

  const fleetId = (index: number) => `i-${index.toString(16).padStart(17, '0')}`;
  const fleet = (count: number): InfraNodeLike[] => buildInfraGraph({
    resources: [
      ...Array.from({ length: count }, (_, index) => ({ resource_type: 'ec2', resource_id: fleetId(index),
        account_id: account, region, data: { vpc_id: 'vpc-a' } })),
      { resource_type: 'rds', resource_id: 'orders', account_id: account,
        region, data: { vpc_id: 'vpc-a', endpoint_address: dbHostA } },
    ],
    vpcs: [], subnets: [], securityGroups: [],
  }).nodes;

  it('discloses omitted distinct pairs when a service→DB pair list reaches its cap', () => {
    const spans = Array.from({ length: 201 }, (_, index) =>
      dbSpan({ spanId: `query-${index}`, hostId: fleetId(index) }));
    const graph = buildTraceGraph([...spans, spans[200], { ...spans[200], spanId: 'again' }], [], fleet(201));
    expect(graph.edges[0].meta.spanCount).toBe(202);
    expect(graph.edges[0].meta.instance_observations).toHaveLength(200);
    expect(graph.edges[0].meta.instance_observations_omitted).toBe(1);
  });

  it('dedupes repeated spans per instance/database pair so a chatty instance cannot hide another', () => {
    const chatty = Array.from({ length: 500 }, (_, index) =>
      dbSpan({ spanId: `a-${index}`, startMs: 1_794_000_000_000 + index }));
    const quiet = dbSpan({ spanId: 'b-only', hostId: instanceB, startMs: 1_794_000_000_100 });
    const graph = buildTraceGraph([...chatty, quiet], [], inventory());
    const queries = graph.edges.filter(edge => edge.rel === 'queries');
    expect(queries).toHaveLength(1);
    expect(queries[0].meta.spanCount).toBe(501);
    expect(queries[0].meta).not.toHaveProperty('instance_observations_omitted');
    const observations = queries[0].meta.instance_observations!;
    expect(observations.map(pair => [pair.instance_ref, pair.database_ref])).toEqual([
      [instanceRefA, databaseRefA], [instanceRefB, databaseRefA],
    ]);
    expect(observations[0]).toMatchObject({
      first_observed_at_ms: 1_794_000_000_000, observed_at_ms: 1_794_000_000_499, observation_count: 500,
    });
    expect(observations[1]).toMatchObject({
      instance_id: instanceB, first_observed_at_ms: 1_794_000_000_100,
      observed_at_ms: 1_794_000_000_100, observation_count: 1,
    });
    // The representative correlation names the latest span, independent of input order.
    const reversed = buildTraceGraph([quiet, ...[...chatty].reverse()], [], inventory())
      .edges[0].meta.instance_observations!;
    expect(reversed.find(pair => pair.instance_ref === instanceRefA)).toEqual(observations[0]);
  });

  it.each(['SERVER', 'PRODUCER', 'CONSUMER', 'INTERNAL', 'UNSPECIFIED'])(
    'keeps service→DB but emits no instance observation for a %s db span', kind => {
      const graph = buildTraceGraph([dbSpan({ kind })], [], inventory());
      const queries = graph.edges.filter(edge => edge.rel === 'queries');
      expect(queries).toHaveLength(1);
      expect(queries[0].meta).toMatchObject({ spanCount: 1, metricCount: 0 });
      expect(queries[0].meta).not.toHaveProperty('instance_observations');
      expect(queries[0].meta).not.toHaveProperty('instance_observations_unbound');
    });
});
