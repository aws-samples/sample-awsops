import { describe, expect, it } from 'vitest';
import { loadNetworkObservations, type NetworkFilters } from './topology-observations';

const monitor = { name: 'nfm-eks-demo', status: 'ACTIVE', cluster: 'demo' };
const filters: NetworkFilters = {
  monitor: monitor.name, metric: 'DATA_TRANSFERRED', category: 'ALL', rangeSec: 900,
};
function reply(url: string, overrides: Record<string, unknown> = {}) {
  const q = new URL(url, 'http://localhost').searchParams;
  return {
    monitor: q.get('monitor'), metric: q.get('metric'), category: q.get('category'), range: Number(q.get('range')),
    rows: [{
      local: { ip: '10.0.1.1', vpcId: 'vpc-a', region: 'us-east-1' },
      remote: { ip: '10.0.2.1', vpcId: 'vpc-a', region: 'us-east-1' },
      value: 1024, unit: 'Bytes', category: q.get('category'), traversed: [], traversedIds: [],
    }],
    unit: 'Bytes', tookMs: 1, capped: false,
    startTime: '2026-09-11T11:45:00.000Z', endTime: '2026-09-11T12:00:00.000Z',
    queriedAt: '2026-09-11T12:00:02.000Z', ...overrides,
  };
}

describe('loadNetworkObservations', () => {
  it('bounds concurrent category queries and preserves partial failures without fabricating zero traffic', async () => {
    let active = 0;
    let maximum = 0;
    const request = async (url: RequestInfo | URL) => {
      active += 1;
      maximum = Math.max(maximum, active);
      await new Promise((r) => setTimeout(r, 4));
      active -= 1;
      const category = new URL(String(url), 'http://localhost').searchParams.get('category');
      if (category === 'INTER_VPC') return Response.json({ message: 'query failed' }, { status: 502 });
      return Response.json(reply(String(url)));
    };
    const batch = await loadNetworkObservations(filters, monitor, { fetch: request as typeof fetch });
    expect(maximum).toBeLessThanOrEqual(3);
    expect(batch.failedCategories).toEqual(['INTER_VPC']);
    expect(batch.errors.INTER_VPC).toBe('query failed');
    expect(batch.observations).toHaveLength(6);
    expect(batch.observations.every((o) => o.category !== 'INTER_VPC')).toBe(true);
    expect(batch.observations[0]).toMatchObject({
      monitor: monitor.name, cluster: 'demo', rangeSec: 900,
      startTime: '2026-09-11T11:45:00.000Z', endTime: '2026-09-11T12:00:00.000Z',
    });
    expect(batch.filters).toEqual(filters);
  });

  it.each([
    { monitor: 'another-monitor' }, { metric: 'ROUND_TRIP_TIME' }, { category: 'INTER_AZ' }, { range: 3600 },
  ])('rejects mismatched response scope instead of relabeling it: %j', async (mismatch) => {
    const request = async (url: RequestInfo | URL) =>
      Response.json(reply(String(url), mismatch));
    const batch = await loadNetworkObservations({ ...filters, category: 'INTRA_AZ' }, monitor, { fetch: request as typeof fetch });
    expect(batch.observations).toEqual([]);
    expect(batch.failedCategories).toEqual(['INTRA_AZ']);
  });

  it('marks malformed flow values unavailable rather than drawing a zero-valued connection', async () => {
    const batch = await loadNetworkObservations({ ...filters, category: 'INTRA_AZ' }, monitor, {
      fetch: (async (url) => {
        const body = reply(String(url));
        return Response.json({ ...body, rows: [{ ...body.rows[0], value: -1 }] });
      }) as typeof fetch,
    });
    expect(batch.observations).toEqual([]);
    expect(batch.failedCategories).toEqual(['INTRA_AZ']);
  });

  it('distinguishes a valid empty result from authentication and malformed payload errors', async () => {
    const empty = await loadNetworkObservations({ ...filters, category: 'INTRA_AZ' }, monitor, {
      fetch: (async (url) => Response.json(reply(String(url), { rows: [] }))) as typeof fetch,
    });
    expect(empty.failedCategories).toEqual([]);
    expect(empty.observations[0].rows).toEqual([]);
    for (const response of [
      () => Response.json({ message: 'unauthenticated' }, { status: 401 }),
      () => Response.json({ rows: null }),
    ]) {
      const bad = await loadNetworkObservations({ ...filters, category: 'INTRA_AZ' }, monitor, {
        fetch: (async () => response()) as typeof fetch,
      });
      expect(bad.observations).toEqual([]);
      expect(bad.failedCategories).toEqual(['INTRA_AZ']);
    }
  });

  it('stops scheduling new categories after cancellation', async () => {
    const controller = new AbortController();
    const requested: string[] = [];
    const request = async (url: RequestInfo | URL) => {
      requested.push(String(url));
      controller.abort();
      return Response.json(reply(String(url)));
    };
    await expect(loadNetworkObservations(filters, monitor, {
      fetch: request as typeof fetch, signal: controller.signal,
    })).rejects.toMatchObject({ name: 'AbortError' });
    expect(requested.length).toBeLessThanOrEqual(3);
  });

  it('does not invent an observation timestamp when a legacy response omits it', async () => {
    const batch = await loadNetworkObservations({ ...filters, category: 'INTRA_AZ' }, monitor, {
      fetch: (async (url) => Response.json(reply(String(url), {
        startTime: undefined, endTime: undefined, queriedAt: undefined, capped: true,
      }))) as typeof fetch,
    });
    expect(batch.observations[0].endTime).toBeUndefined();
    expect(batch.cappedCategories).toEqual(['INTRA_AZ']);
  });

  it('does not query unsupported windows or a monitor different from the selected one', async () => {
    const request = async () => { throw new Error('must not fetch'); };
    await expect(loadNetworkObservations({ ...filters, rangeSec: 7200 }, monitor, { fetch: request as typeof fetch })).rejects.toThrow(/range/i);
    await expect(loadNetworkObservations({ ...filters, monitor: 'other' }, monitor, { fetch: request as typeof fetch })).rejects.toThrow(/monitor/i);
  });
});
