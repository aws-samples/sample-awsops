import { describe, it, expect } from 'vitest';
import {
  INVENTORY_TYPES, inventoryGroups, isDeprecatedRuntime, DEPRECATED_RUNTIMES,
  navTree, overviewGroups, groupBySlug, groupForPath, RESERVED_NAV_SLUGS,
  computeHighlights, HIGHLIGHTS, layoutOf, worstFirst,
} from './inventory-types';

describe('INVENTORY_TYPES registry', () => {
  it('has the 43 registered types (41 + waf_rule_group + waf_ip_set)', () => {
    const keys = Object.keys(INVENTORY_TYPES);
    expect(keys).toContain('ec2'); expect(keys).toContain('s3'); expect(keys).toContain('iam_role');
    expect(keys).toContain('cloudfront'); expect(keys).toContain('cloudwatch_alarm'); expect(keys).toContain('msk');
    expect(keys).toContain('target_group'); expect(keys).toContain('route53'); expect(keys).toContain('ecs_task');
    expect(keys).toContain('ecs_service'); expect(keys).toContain('ebs_snapshot');
    // L7 resolution + routing types
    expect(keys).toContain('apigatewayv2_api'); expect(keys).toContain('apigatewayv2_integration'); expect(keys).toContain('cloudfront_vpc_origin');
    expect(keys).toContain('apigatewayv2_route'); expect(keys).toContain('alb_listener_rule');
    // security findings source (denial-safe S3 public-access sync)
    expect(keys).toContain('s3_public_access');
    expect(keys.length).toBe(43);
  });
  it('every type has a label, group, and >=1 column', () => {
    for (const [k, v] of Object.entries(INVENTORY_TYPES)) {
      expect(v.label, k).toBeTruthy(); expect(v.group, k).toBeTruthy();
      expect(v.columns.length, k).toBeGreaterThan(0);
      for (const c of v.columns) { expect(c.key).toBeTruthy(); expect(c.label).toBeTruthy(); }
    }
  });
  it('groups the types', () => {
    const g = inventoryGroups();
    expect(g.find((x) => x.group === 'Compute')?.types).toContain('ec2');
    expect(g.find((x) => x.group === 'Network')?.types).toContain('vpc');
    expect(g.find((x) => x.group === 'Monitoring')?.types).toContain('cloudwatch_alarm');
    expect(g.find((x) => x.group === 'Storage & DB')?.types).toContain('ebs_snapshot');
  });
  it('stateKey/distKey (when present) reference a column key, resource_id, region, or a non-empty data field', () => {
    const VIRTUAL = new Set(['resource_id', 'region']);
    for (const [k, v] of Object.entries(INVENTORY_TYPES)) {
      const colKeys = new Set(v.columns.map((c) => c.key));
      const valid = (field: string) =>
        typeof field === 'string' && field.length > 0 && (colKeys.has(field) || VIRTUAL.has(field));
      if (v.stateKey !== undefined) expect(valid(v.stateKey), `${k}.stateKey=${v.stateKey}`).toBe(true);
      if (v.distKey !== undefined) expect(valid(v.distKey), `${k}.distKey=${v.distKey}`).toBe(true);
    }
  });
  it('ec2 has stateKey=instance_state and distKey=instance_type', () => {
    expect(INVENTORY_TYPES.ec2.stateKey).toBe('instance_state');
    expect(INVENTORY_TYPES.ec2.distKey).toBe('instance_type');
  });
});

describe('isDeprecatedRuntime (Lambda EOL signal)', () => {
  it('lists the 12 known-EOL runtimes', () => {
    expect(DEPRECATED_RUNTIMES).toContain('python3.7');
    expect(DEPRECATED_RUNTIMES).toContain('nodejs14.x');
    expect(DEPRECATED_RUNTIMES).toContain('go1.x');
    expect(DEPRECATED_RUNTIMES.length).toBe(12);
  });
  it('flags deprecated runtimes', () => {
    for (const r of ['python2.7', 'python3.7', 'nodejs10.x', 'nodejs14.x', 'dotnetcore3.1', 'ruby2.7', 'java8', 'go1.x']) {
      expect(isDeprecatedRuntime(r), r).toBe(true);
    }
  });
  it('does not flag current runtimes', () => {
    for (const r of ['python3.12', 'nodejs20.x', 'java21', 'ruby3.3', 'dotnet8', 'provided.al2023']) {
      expect(isDeprecatedRuntime(r), r).toBe(false);
    }
  });
  it('normalizes case and whitespace', () => {
    expect(isDeprecatedRuntime(' Python3.7 ')).toBe(true);
    expect(isDeprecatedRuntime('NODEJS14.X')).toBe(true);
  });
  it('returns false for empty/null/non-string', () => {
    expect(isDeprecatedRuntime('')).toBe(false);
    expect(isDeprecatedRuntime(null)).toBe(false);
    expect(isDeprecatedRuntime(undefined)).toBe(false);
    expect(isDeprecatedRuntime(42)).toBe(false);
    expect(isDeprecatedRuntime('custom')).toBe(false);
  });
});

describe('navTree (sidebar IA hierarchy)', () => {
  const tree = navTree();
  const find = (slug: string) => tree.find((g) => g.slug === slug)!;
  const invTypesOf = (slug: string) => {
    const g = find(slug);
    return [
      ...g.items.filter((l) => l.kind === 'inventory').map((l) => l.type!),
      ...g.subgroups.flatMap((s) => s.items.filter((l) => l.kind === 'inventory').map((l) => l.type!)),
    ];
  };

  it('returns the 5 groups in GROUP_ORDER', () => {
    expect(tree.map((g) => g.slug)).toEqual(['compute', 'storage', 'network', 'security', 'monitoring']);
  });

  it('places every inventory type exactly once (no drop, no dup) — 43 total', () => {
    const placed = tree.flatMap((g) => invTypesOf(g.slug));
    expect(new Set(placed).size).toBe(placed.length); // no duplicates
    expect(new Set(placed)).toEqual(new Set(Object.keys(INVENTORY_TYPES)));
    expect(placed.length).toBe(43);
  });

  it('Compute nests the EKS family as a feature-link subgroup + the ECS subgroup', () => {
    const c = find('compute');
    expect(c.items.filter((l) => l.kind === 'inventory').map((l) => l.type)).toEqual(['ec2', 'lambda', 'ecr']);
    const eks = c.subgroups.find((s) => s.key === 'eks')!;
    expect(eks.items.every((l) => l.kind === 'feature')).toBe(true);
    expect(eks.items.map((l) => l.href)).toEqual([
      '/eks', '/eks/nodes', '/eks/pods', '/eks/deployments', '/eks/services', '/eks/explorer', '/eks/cost',
    ]);
    const ecs = c.subgroups.find((s) => s.key === 'ecs')!;
    expect(ecs.items.map((l) => l.type)).toEqual(['ecs_cluster', 'ecs_service', 'ecs_task']);
  });

  it('Network nests Load Balancing + API Gateway and excludes them from direct items', () => {
    const n = find('network');
    expect(n.subgroups.find((s) => s.key === 'loadBalancing')!.items.map((l) => l.type))
      .toEqual(['alb', 'nlb', 'target_group', 'alb_listener_rule']);
    expect(n.subgroups.find((s) => s.key === 'apiGateway')!.items.map((l) => l.type))
      .toEqual(['apigatewayv2_api', 'apigatewayv2_integration', 'apigatewayv2_route']);
    const direct = n.items.filter((l) => l.kind === 'inventory').map((l) => l.type);
    // security_group moved into the securityGroup subgroup (see below) — no longer a direct item.
    expect(direct).toEqual(['vpc', 'subnet', 'route_table', 'nat_gateway', 'internet_gateway', 'transit_gateway', 'route53', 'cloudfront', 'cloudfront_vpc_origin']);
  });

  it('Network nests a Security Group subgroup (existing inventory route + the new Rules/Usage links, in that order)', () => {
    const n = find('network');
    const sg = n.subgroups.find((s) => s.key === 'securityGroup')!;
    expect(sg.items.map((l) => l.href)).toEqual([
      '/inventory/security_group', '/network/security-groups/rules', '/network/security-groups/usage',
    ]);
    expect(sg.items[0].kind).toBe('inventory');
    expect(sg.items[0].type).toBe('security_group');
    expect(sg.items.slice(1).every((l) => l.kind === 'feature')).toBe(true);
  });

  it('Network injects a top-level Path Check entry (not nested under Security Group)', () => {
    const n = find('network');
    expect(n.items.some((l) => l.kind === 'feature' && l.href === '/network-paths')).toBe(true);
  });

  it('Monitoring is a singleton (flat, no overview href)', () => {
    const m = find('monitoring');
    expect(m.singleton).toBe(true);
    expect(m.href).toBeUndefined();
  });

  it('non-singleton groups expose /inventory/g/<slug> overview hrefs', () => {
    for (const g of tree.filter((x) => !x.singleton)) expect(g.href).toBe(`/inventory/g/${g.slug}`);
  });

  it('splitKeys pin split→group: sgOpenIngress→Network, iamUserNoMfa→Security, EBS→Storage', () => {
    expect(find('network').splitKeys).toContain('sgOpenIngress');
    expect(find('security').splitKeys).toContain('iamUserNoMfa');
    expect(find('storage').splitKeys).toContain('ebsUnencrypted');
    expect(find('compute').splitKeys).toEqual(['ec2Running', 'ec2Stopped']);
  });
});

describe('overview helpers + path resolver', () => {
  it('overviewGroups excludes singletons (4 groups)', () => {
    expect(overviewGroups().map((g) => g.slug)).toEqual(['compute', 'storage', 'network', 'security']);
  });
  it('groupBySlug resolves overview groups, null for singleton/unknown', () => {
    expect(groupBySlug('network')?.slug).toBe('network');
    expect(groupBySlug('monitoring')).toBeNull(); // singleton has no overview
    expect(groupBySlug('nope')).toBeNull();
  });
  it('groupForPath maps inventory/feature/overview/subgroup paths to their group', () => {
    expect(groupForPath('/inventory/ec2')).toEqual({ slug: 'compute' });
    expect(groupForPath('/eks')).toEqual({ slug: 'compute', subgroupKey: 'eks' });
    expect(groupForPath('/eks/my-cluster')).toEqual({ slug: 'compute', subgroupKey: 'eks' });
    expect(groupForPath('/eks/explorer')).toEqual({ slug: 'compute', subgroupKey: 'eks' });
    expect(groupForPath('/inventory/g/network')).toEqual({ slug: 'network' });
    expect(groupForPath('/inventory/alb')).toEqual({ slug: 'network', subgroupKey: 'loadBalancing' });
    expect(groupForPath('/inventory/apigatewayv2_route')).toEqual({ slug: 'network', subgroupKey: 'apiGateway' });
    expect(groupForPath('/inventory/cloudwatch_alarm')).toEqual({ slug: 'monitoring' });
    expect(groupForPath('/nonexistent')).toBeNull();
  });
  it('no inventory type slug collides with a reserved nav slug (incl. the g segment)', () => {
    for (const key of Object.keys(INVENTORY_TYPES)) expect(RESERVED_NAV_SLUGS).not.toContain(key);
  });
});

describe('computeHighlights (per-type highlight cards)', () => {
  it('countWhere is case-insensitive; danger tone only when count > 0', () => {
    const rows = [{ s: 'Running' }, { s: 'running' }, { s: 'stopped' }];
    const [run, stop] = computeHighlights(rows, [
      { kind: 'countWhere', label: 'run', col: 's', eq: 'running', tone: 'accent' },
      { kind: 'countWhere', label: 'stop', col: 's', eq: 'stopped', tone: 'danger' },
    ]);
    expect(run).toEqual({ label: 'run', value: 2, variant: 'accent' });
    expect(stop).toEqual({ label: 'stop', value: 1, variant: 'danger' });
    const [none] = computeHighlights(rows, [{ kind: 'countWhere', label: 'x', col: 's', eq: 'zzz', tone: 'danger' }]);
    expect(none).toEqual({ label: 'x', value: 0, variant: 'default' }); // danger + 0 → not red
  });
  it('countTruthy counts non-empty / non-false values', () => {
    const rows = [{ ip: '1.2.3.4' }, { ip: '' }, { ip: null }, { ip: '5.6.7.8' }, { ip: 'false' }];
    expect(computeHighlights(rows, [{ kind: 'countTruthy', label: 'pub', col: 'ip' }])[0].value).toBe(2);
  });
  it('distinct counts unique non-empty values', () => {
    const rows = [{ e: 'mysql' }, { e: 'mysql' }, { e: 'postgres' }, { e: '' }];
    expect(computeHighlights(rows, [{ kind: 'distinct', label: 'engines', col: 'e' }])[0].value).toBe(2);
  });
  it('sum totals a numeric column with suffix', () => {
    const rows = [{ size: 100 }, { size: 50 }, { size: '20' }];
    expect(computeHighlights(rows, [{ kind: 'sum', label: 't', col: 'size', suffix: ' GB' }])[0].value).toBe('170 GB');
  });
  it('countGt counts strictly-greater numeric cells; non-numeric never matches (L134)', () => {
    const rows = [{ t: 300 }, { t: 301 }, { t: '900' }, { t: 'x' }, { t: null }];
    const [c] = computeHighlights(rows, [{ kind: 'countGt', label: 'long', col: 't', gt: 300, tone: 'danger' }]);
    expect(c).toEqual({ label: 'long', value: 2, variant: 'danger' }); // 300 itself excluded
  });
  it('avg averages finite numeric cells only; empty → — (L230)', () => {
    const rows = [{ m: 128 }, { m: '256' }, { m: 'n/a' }];
    expect(computeHighlights(rows, [{ kind: 'avg', label: 'mem', col: 'm', suffix: ' MB' }])[0].value).toBe('192 MB');
    expect(computeHighlights([], [{ kind: 'avg', label: 'mem', col: 'm' }])[0].value).toBe('—');
  });
  it('percent renders NN% (n/total) with 100/80 thresholds (L100)', () => {
    const enc = (n: number, total: number) =>
      computeHighlights(
        Array.from({ length: total }, (_, i) => ({ e: i < n ? 'true' : 'false' })),
        [{ kind: 'percent', label: '암호화율', col: 'e', eq: 'true' }],
      )[0];
    expect(enc(4, 4)).toEqual({ label: '암호화율', value: '100% (4/4)', variant: 'accent' });
    expect(enc(4, 5)).toEqual({ label: '암호화율', value: '80% (4/5)', variant: 'default' });
    expect(enc(3, 5)).toEqual({ label: '암호화율', value: '60% (3/5)', variant: 'danger' });
    expect(computeHighlights([], [{ kind: 'percent', label: 'x', col: 'e', eq: 'true' }])[0].value).toBe('—');
  });
  it('percent judges the raw ratio: a near-100 fleet is neither accent nor "100%"', () => {
    const pct = (rows: Record<string, unknown>[]) =>
      computeHighlights(rows, [{ kind: 'percent', label: 'enc', col: 'e', eq: 'true' }])[0];
    // 499/500 = 99.8% — rounds to 100 but is NOT complete → one decimal + 'default'
    const near = [...Array(499).fill({ e: 'true' }), { e: 'false' }];
    expect(pct(near)).toEqual({ label: 'enc', value: '99.8% (499/500)', variant: 'default' });
    // 399/500 = 79.8% — rounds to 80 but is below the 0.8 raw-ratio bar → one decimal + danger
    const low = [...Array(399).fill({ e: 'true' }), ...Array(101).fill({ e: 'false' })];
    expect(pct(low)).toEqual({ label: 'enc', value: '79.8% (399/500)', variant: 'danger' });
    // complete match stays accent at a real 100% (uncapped)
    expect(pct(Array(500).fill({ e: 'true' }))).toEqual({ label: 'enc', value: '100% (500/500)', variant: 'accent' });
    // low end: rounds to 0 but is nonzero → one decimal + danger
    const tiny = [{ e: 'true' }, ...Array(999).fill({ e: 'false' })];
    expect(pct(tiny)).toEqual({ label: 'enc', value: '0.1% (1/1000)', variant: 'danger' });
  });
  it('percent on a capped sample never claims the accented all-clear', () => {
    const rows = Array(500).fill({ e: 'true' });
    const card = computeHighlights(rows, [{ kind: 'percent', label: 'enc', col: 'e', eq: 'true' }], { capped: true })[0];
    expect(card).toEqual({ label: 'enc', value: '100% (500/500 표본)', variant: 'default' });
  });
  it('avg excludes null/empty cells (Number(null) === 0 would skew the mean)', () => {
    const rows = [{ m: 100 }, { m: null }, { m: '' }];
    expect(computeHighlights(rows, [{ kind: 'avg', label: 'mem', col: 'm' }])[0].value).toBe('100');
  });
  it('sumProductWhere sums colA×colB over matching rows; non-numeric factor → 0 (L103)', () => {
    const rows = [
      { s: 'running', a: 2, b: 2 },   // 4
      { s: 'running', a: '4', b: 1 }, // 4
      { s: 'stopped', a: 8, b: 8 },   // filtered
      { s: 'running', a: 'x', b: 2 }, // 0
    ];
    expect(computeHighlights(rows, [{ kind: 'sumProductWhere', label: 'vCPU', cols: ['a', 'b'], where: 's', eq: 'running' }])[0].value).toBe('8');
  });
  it('HIGHLIGHTS gained the batch-7 entries (ec2 vCPU · ebs % · lambda gt/avg · rds sum · ecs_cluster band)', () => {
    expect(HIGHLIGHTS.ec2.some((h) => h.kind === 'sumProductWhere')).toBe(true);
    expect(HIGHLIGHTS.ebs_volume.some((h) => h.kind === 'percent')).toBe(true);
    expect(HIGHLIGHTS.lambda.some((h) => h.kind === 'countGt')).toBe(true);
    expect(HIGHLIGHTS.lambda.some((h) => h.kind === 'avg')).toBe(true);
    expect(HIGHLIGHTS.rds.some((h) => h.kind === 'sum')).toBe(true);
    expect((HIGHLIGHTS.ecs_cluster ?? []).filter((h) => h.kind === 'sum')).toHaveLength(3);
  });
  it('deprecatedRuntime counts EOL Lambda runtimes (danger when > 0)', () => {
    const rows = [{ r: 'python3.7' }, { r: 'nodejs20.x' }, { r: 'go1.x' }];
    expect(computeHighlights(rows, [{ kind: 'deprecatedRuntime', label: 'eol', col: 'r' }])[0]).toEqual({ label: 'eol', value: 2, variant: 'danger' });
  });
  it('every HIGHLIGHTS entry references a real synced field for its type', () => {
    const VIRTUAL = new Set(['region', 'resource_id']);
    for (const [type, hls] of Object.entries(HIGHLIGHTS)) {
      const spec = INVENTORY_TYPES[type];
      expect(spec, `HIGHLIGHTS[${type}] has a registered type`).toBeTruthy();
      // Known fields = table columns ∪ detail-section keys (validated against sync_lambda.py
      // where they're raw synced columns; *_h keys are client-derived) ∪ hideKeys (raw blobs
      // or superseded derived columns hidden from the panel — still real row data) ∪
      // state/dist keys. Dotted JSONB paths validate their ROOT field.
      const cols = new Set<string>([
        ...spec.columns.map((c) => c.key),
        ...(spec.sections ?? []).flatMap((sec) => sec.keys),
        ...(spec.hideKeys ?? []),
        ...[spec.stateKey, spec.distKey, spec.distKey2, spec.barKey?.col, spec.countBarKey?.col].filter((k): k is string => Boolean(k)),
        ...(spec.flagBarKey?.flags ?? []).map((f) => f.col),
      ]);
      for (const h of hls) {
        const refs = [
          ...('col' in h && h.col ? [h.col] : []),
          ...('cols' in h && Array.isArray(h.cols) ? h.cols : []),
          ...('where' in h && h.where ? [h.where] : []),
        ];
        for (const ref of refs) {
          const root = ref.split('.')[0];
          expect(cols.has(root) || VIRTUAL.has(root), `${type}.${ref}`).toBe(true);
        }
      }
    }
  });
});

describe('layout archetypes', () => {
  it('maps key types to the right archetype', () => {
    expect(layoutOf('iam_user')).toBe('risk');
    expect(layoutOf('s3_public_access')).toBe('risk');
    expect(layoutOf('cloudtrail')).toBe('risk');
    expect(layoutOf('ec2')).toBe('chart');
    expect(layoutOf('ecs_service')).toBe('chart');
    expect(layoutOf('rds')).toBe('capacity');
    expect(layoutOf('vpc')).toBe('directory');
  });
  it('every inventory type resolves to a valid archetype', () => {
    const valid = new Set(['risk', 'chart', 'capacity', 'directory']);
    for (const t of Object.keys(INVENTORY_TYPES)) expect(valid.has(layoutOf(t)), t).toBe(true);
  });
  it('unmapped types default to directory', () => {
    expect(layoutOf('nonexistent_type')).toBe('directory');
  });
  it('every risk-archetype type has a danger highlight (so the hero shows a real verdict)', () => {
    for (const t of Object.keys(INVENTORY_TYPES)) {
      if (layoutOf(t) !== 'risk') continue;
      const hl = HIGHLIGHTS[t] ?? [];
      expect(hl.some((h) => h.tone === 'danger'), `${t} risk hero needs a danger highlight`).toBe(true);
    }
  });
});

describe('worstFirst (gap L68)', () => {
  const wf = { col: 'state_value', rank: { ALARM: 0, INSUFFICIENT_DATA: 1, OK: 2 }, tieBreak: 'ts' };
  it('ranks ALARM first, unknown values last (surfaced, never hidden)', () => {
    const rows = [
      { state_value: 'OK', ts: '3' }, { state_value: 'WEIRD', ts: '9' },
      { state_value: 'ALARM', ts: '1' }, { state_value: 'INSUFFICIENT_DATA', ts: '2' },
    ];
    expect(worstFirst(rows, wf).map((r) => r.state_value))
      .toEqual(['ALARM', 'INSUFFICIENT_DATA', 'OK', 'WEIRD']);
  });
  it('ties break by tieBreak DESC (newest state change first)', () => {
    const rows = [
      { state_value: 'ALARM', ts: '2026-01-01' }, { state_value: 'ALARM', ts: '2026-03-01' },
    ];
    expect(worstFirst(rows, wf).map((r) => r.ts)).toEqual(['2026-03-01', '2026-01-01']);
  });
  it('does not mutate the input array', () => {
    const rows = [{ state_value: 'OK', ts: '1' }, { state_value: 'ALARM', ts: '2' }];
    worstFirst(rows, wf);
    expect(rows[0].state_value).toBe('OK');
  });
  it('cloudwatch_alarm spec carries the worst-first config', () => {
    expect(INVENTORY_TYPES.cloudwatch_alarm.worstFirst?.rank.ALARM).toBe(0);
  });
});
