import { expect, it } from 'vitest';
import { projectPublished, type GraphRow } from './published';
import type { Layer, Manifest } from './snapshot';
const source = (layer: Layer): Manifest => ({
  source: layer,
  generation: 'run',
  status: 'ok',
  capturedAt: '2026-01-01T12:00:00Z',
  attemptedAt: null,
  window: null,
  stale: false,
  retained: false,
  capped: false,
});
const row = (layer: Layer, id: string): GraphRow => ({
  layer,
  id,
  kind: 'rds',
  label: 'orders',
  nativeKind: 'rds',
  nativeId: 'orders',
  region: 'us-west-2',
});
it('merges qualified configuration identities, preserves claim separation and rewrites only actual pairs', () => {
  const rows = [
    row('inventory', 'one'),
    row('infra', 'two'),
    row('trace', 'db'),
    { ...row('trace', 'runtime'), kind: 'runtime' },
  ];
  const sources = ['inventory', 'infra', 'trace'].map((l) => source(l as Layer));
  const snap = projectPublished(
    rows,
    [
      {
        layer: 'trace',
        source: 'runtime',
        target: 'db',
        rel: 'calls',
        confidence: 'observed',
        meta: { spanCount: 17 },
      },
    ],
    sources,
  );
  expect(snap.entities).toHaveLength(3);
  expect(snap.entities.find((e) => e.layers.length === 2)?.layers).toEqual(['infra', 'inventory']);
  expect(snap.entities.find((e) => e.kind === 'runtime')?.claim).toBe(true);
  expect(snap.relations[0].spanCount).toBe(17);
  expect(
    projectPublished(
      rows,
      [],
      sources.map((s) => ({ ...s, stale: true })),
    ).entities,
  ).toHaveLength(4);
});

it('connects each trace pair only to its exact host infra endpoints and never fans out same-service dependencies', () => {
  const account = '111111111111',
    region = 'us-west-2';
  const rows: GraphRow[] = [{ layer: 'trace', kind: 'service', id: 's', label: 'checkout' }];
  const links: import('./published').GraphLink[] = [];
  for (const suffix of ['a', 'b']) {
    const instance = 'i-' + suffix.repeat(8),
      db = 'orders-' + suffix,
      host = db + '.internal';
    rows.push(
      {
        layer: 'infra',
        kind: 'ec2',
        id: 'instance-' + suffix,
        label: instance,
        nativeKind: 'ec2',
        nativeId: instance,
        region,
      },
      {
        layer: 'infra',
        kind: 'rds',
        id: 'rds-' + suffix,
        label: db,
        nativeKind: 'rds',
        nativeId: db,
        region,
        hosts: [host],
      },
      { layer: 'trace', kind: 'db', id: 'reported-' + suffix, label: host, hosts: [host] },
    );
    links.push({
      layer: 'trace',
      source: 's',
      target: 'reported-' + suffix,
      rel: 'queries',
      confidence: 'observed',
      pairs: [
        {
          account,
          region,
          instance_ref: 'instance-' + suffix,
          database_ref: 'rds-' + suffix,
          instance_id: instance,
          db_host: host,
          source_id: 'tempo:1',
          provenance: 'trace_span',
          observed_at_ms: 1500,
        },
      ],
    });
  }
  const sources = [source('infra'), { ...source('trace'), window: { start: 1000, end: 2000 } }];
  const view = projectPublished(rows, links, sources, account);
  const names = new Map(view.entities.map((e) => [e.id, e.label]));
  const pairs = view.relations
    .filter((r) => r.kind === 'instance-database')
    .map((r) => [names.get(r.source), names.get(r.target)])
    .sort();
  expect(pairs).toEqual([
    ['i-aaaaaaaa', 'orders-a'],
    ['i-bbbbbbbb', 'orders-b'],
  ]);
  expect(view.relations.filter((r) => r.kind === 'database-record')).toHaveLength(2);
  expect(projectPublished(rows, links, sources, '222222222222').relations).toHaveLength(2);
  expect(
    projectPublished(
      rows,
      links,
      sources.map((s) => ({ ...s, retained: true })),
      account,
    ).relations,
  ).toHaveLength(2);
});
