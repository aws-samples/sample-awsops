import { describe, it, expect } from 'vitest';
import { parseCpuCores, parseMem, aggregateNodeResources, instanceTypeDistribution, type NodeRow, type PodRow } from './eks-resources';

describe('parseCpuCores', () => {
  it('parses whole cores and millicores', () => {
    expect(parseCpuCores('8')).toBe(8);
    expect(parseCpuCores('7910m')).toBeCloseTo(7.91);
    expect(parseCpuCores('250m')).toBeCloseTo(0.25);
  });
  it('returns 0 for empty/null/garbage', () => {
    expect(parseCpuCores('')).toBe(0);
    expect(parseCpuCores(null)).toBe(0);
    expect(parseCpuCores(undefined)).toBe(0);
  });
});

describe('parseMem (→ MiB)', () => {
  it('converts Ki/Mi/Gi/Ti', () => {
    expect(parseMem('32986188Ki')).toBe(Math.round(32986188 / 1024));
    expect(parseMem('512Mi')).toBe(512);
    expect(parseMem('2Gi')).toBe(2048);
    expect(parseMem('1Ti')).toBe(1024 * 1024);
  });
  it('decimal SI suffixes are 1000-based bytes (P4: codex)', () => {
    expect(parseMem('500M')).toBe(Math.round(500e6 / (1024 * 1024))); // 477 MiB
    expect(parseMem('1G')).toBe(Math.round(1e9 / (1024 * 1024)));     // 954 MiB
    expect(parseMem('128974848k')).toBe(Math.round(128974848e3 / (1024 * 1024)));
  });
  it('bare quantity is BYTES, not MiB (P4: codex)', () => {
    expect(parseMem('134217728')).toBe(128); // 128 MiB in bytes
    expect(parseMem('100')).toBe(0);         // 100 bytes rounds to 0 MiB
    expect(parseMem('')).toBe(0);
    expect(parseMem(null)).toBe(0);
    expect(parseMem('abc')).toBe(0);
  });
});

describe('aggregateNodeResources', () => {
  const nodes: NodeRow[] = [
    { name: 'n1', status: 'Ready', roles: '', version: '', instanceType: 'm5.large', zone: '', age: '', cpuCapacity: 4, cpuAllocatable: 4, memCapacity: 8192, memAllocatable: 8000, diskCapacity: 20480, diskAllocatable: 20000 },
    { name: 'n2', status: 'Ready', roles: '', version: '', instanceType: 't3.medium', zone: '', age: '', cpuCapacity: 2, cpuAllocatable: 2, memCapacity: 4096, memAllocatable: 4000, diskCapacity: 10240, diskAllocatable: 10000 },
  ];
  const pods: PodRow[] = [
    { name: 'a', namespace: 'd', status: 'Running', node: 'n1', restarts: 0, age: '', cpuRequest: 1, memRequest: 2000, diskRequest: 5000 },
    { name: 'b', namespace: 'd', status: 'Running', node: 'n1', restarts: 0, age: '', cpuRequest: 1, memRequest: 2000, diskRequest: 5000 },
    { name: 'c', namespace: 'd', status: 'Running', node: 'n2', restarts: 0, age: '', cpuRequest: 0.5, memRequest: 1000, diskRequest: 2500 },
    { name: 'orphan', namespace: 'd', status: 'Pending', node: '', restarts: 0, age: '', cpuRequest: 9, memRequest: 9999, diskRequest: 9999 },
  ];

  it('sums per-node requests + podCount and computes clamped pct', () => {
    const agg = aggregateNodeResources(nodes, pods);
    const n1 = agg.find((a) => a.name === 'n1')!;
    expect(n1.cpuRequest).toBe(2);
    expect(n1.memRequest).toBe(4000);
    expect(n1.podCount).toBe(2);
    expect(n1.cpuPct).toBe(50); // 2/4
    expect(n1.memPct).toBe(50); // 4000/8000
    const n2 = agg.find((a) => a.name === 'n2')!;
    expect(n2.cpuRequest).toBe(0.5);
    expect(n2.podCount).toBe(1);
    expect(n2.cpuPct).toBe(25); // 0.5/2
  });
  it('sums per-node disk requests, carries instanceType + diskAllocatable, computes diskPct', () => {
    const agg = aggregateNodeResources(nodes, pods);
    const n1 = agg.find((a) => a.name === 'n1')!;
    expect(n1.instanceType).toBe('m5.large');
    expect(n1.diskAllocatable).toBe(20000);
    expect(n1.diskRequest).toBe(10000); // 5000+5000
    expect(n1.diskPct).toBe(50);        // 10000/20000
    const n2 = agg.find((a) => a.name === 'n2')!;
    expect(n2.instanceType).toBe('t3.medium');
    expect(n2.diskAllocatable).toBe(10000);
    expect(n2.diskRequest).toBe(2500);
    expect(n2.diskPct).toBe(25);        // 2500/10000
  });
  it('reports 0 disk pct when disk allocatable is 0', () => {
    const agg = aggregateNodeResources(
      [{ name: 'z', status: '', roles: '', version: '', instanceType: '', zone: '', age: '', cpuCapacity: 0, cpuAllocatable: 0, memCapacity: 0, memAllocatable: 0, diskCapacity: 0, diskAllocatable: 0 }],
      [{ name: 'p', namespace: 'd', status: 'Running', node: 'z', restarts: 0, age: '', cpuRequest: 1, memRequest: 100, diskRequest: 100 }],
    );
    expect(agg[0].diskPct).toBe(0);
  });
  it('ignores pods with no node assignment (orphans)', () => {
    const agg = aggregateNodeResources(nodes, pods);
    expect(agg.reduce((s, a) => s + a.podCount, 0)).toBe(3); // orphan excluded
  });
  it('reports 0 pct when allocatable is 0', () => {
    const agg = aggregateNodeResources(
      [{ name: 'z', status: '', roles: '', version: '', instanceType: '', zone: '', age: '', cpuCapacity: 0, cpuAllocatable: 0, memCapacity: 0, memAllocatable: 0, diskCapacity: 0, diskAllocatable: 0 }],
      [{ name: 'p', namespace: 'd', status: 'Running', node: 'z', restarts: 0, age: '', cpuRequest: 1, memRequest: 100, diskRequest: 100 }],
    );
    expect(agg[0].cpuPct).toBe(0);
    expect(agg[0].memPct).toBe(0);
  });
});

describe('instanceTypeDistribution', () => {
  const mk = (name: string, instanceType: string): NodeRow => ({
    name, status: 'Ready', roles: '', version: '', instanceType, zone: '', age: '',
    cpuCapacity: 0, cpuAllocatable: 0, memCapacity: 0, memAllocatable: 0, diskCapacity: 0, diskAllocatable: 0,
  });
  it('counts nodes per instanceType, sorted by count desc', () => {
    const dist = instanceTypeDistribution([
      mk('a', 'm5.large'), mk('b', 'm5.large'), mk('c', 't3.medium'), mk('d', 'm5.large'),
    ]);
    expect(dist).toEqual([
      { type: 'm5.large', count: 3 },
      { type: 't3.medium', count: 1 },
    ]);
  });
  it('maps blank instanceType to "unknown"', () => {
    const dist = instanceTypeDistribution([mk('a', ''), mk('b', '')]);
    expect(dist).toEqual([{ type: 'unknown', count: 2 }]);
  });
  it('returns empty array for no nodes', () => {
    expect(instanceTypeDistribution([])).toEqual([]);
  });
});
