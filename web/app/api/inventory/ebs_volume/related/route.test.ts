import { describe, it, expect, vi, beforeEach } from 'vitest';

const { verifyUser, query } = vi.hoisted(() => ({ verifyUser: vi.fn(), query: vi.fn() }));
vi.mock('@/lib/auth', () => ({ verifyUser: (...a: unknown[]) => verifyUser(...a) }));
vi.mock('@/lib/db', () => ({ getPool: () => ({ query: (...a: unknown[]) => query(...a) }) }));

import { GET } from './route';

const req = (q: string) => new Request(`http://x/api/inventory/ebs_volume/related${q}`, {
  headers: { cookie: 'awsops_token=t' },
});

beforeEach(() => {
  verifyUser.mockReset(); query.mockReset();
  verifyUser.mockResolvedValue({ sub: 'u1' });
  process.env.AWS_ACCOUNT_ID = '999988887777';
});

describe('GET /api/inventory/ebs_volume/related (gap L97/L98)', () => {
  it('401 unauth; 400 on invalid volumeId / instanceIds / account (never silently unfiltered)', async () => {
    verifyUser.mockResolvedValueOnce(null);
    expect((await GET(req('?volumeId=vol-0123456789abcdef0'))).status).toBe(401);
    expect((await GET(req('?volumeId=nope'))).status).toBe(400);
    expect((await GET(req("?volumeId=vol-0123456789abcdef0&instanceIds=i-1';--"))).status).toBe(400);
    expect((await GET(req('?volumeId=vol-0123456789abcdef0&account=12'))).status).toBe(400);
    expect(query).not.toHaveBeenCalled();
  });

  it('returns newest-first snapshots (20-cap) and attached-instance enrichment, account-scoped', async () => {
    query
      .mockResolvedValueOnce({ rows: [
        { resource_id: 'snap-2', data: { volume_size: 100, encrypted: 'true', start_time: '2026-08-30T00:00:00Z', state: 'completed' } },
        { resource_id: 'snap-1', data: { volume_size: 100, encrypted: false, start_time: '2026-08-01T00:00:00Z', state: 'completed' } },
      ] })
      .mockResolvedValueOnce({ rows: [
        { resource_id: 'i-0123456789abcdef0', data: { name: 'web-1', instance_type: 't4g.small', instance_state: 'running' } },
      ] });
    const res = await GET(req('?volumeId=vol-0123456789abcdef0&instanceIds=i-0123456789abcdef0&account=123456789012'));
    const d = await res.json();
    expect(d.snapshots.map((s: { snapshotId: string }) => s.snapshotId)).toEqual(['snap-2', 'snap-1']);
    expect(d.snapshots[0]).toMatchObject({ sizeGb: 100, encrypted: true, state: 'completed' });
    expect(d.instances[0]).toMatchObject({ instanceId: 'i-0123456789abcdef0', name: 'web-1', state: 'running' });
    // both queries account-scoped + snapshot query ordered/capped in SQL
    const [snapSql, snapParams] = query.mock.calls[0] as [string, unknown[]];
    expect(snapSql).toContain("data->>'volume_id' = $2");
    expect(snapSql).toContain('ORDER BY');
    expect(snapSql).toContain('LIMIT');
    expect(snapParams).toEqual(['123456789012', 'vol-0123456789abcdef0', 20]);
    const [instSql, instParams] = query.mock.calls[1] as [string, unknown[]];
    expect(instSql).toContain('= ANY($2)');
    expect(instParams[0]).toBe('123456789012');
  });

  it('the two blocks degrade independently (snapshot query failure → snapshots null, instances still return)', async () => {
    query
      .mockRejectedValueOnce(new Error('db down'))
      .mockResolvedValueOnce({ rows: [] });
    const d = await (await GET(req('?volumeId=vol-0123456789abcdef0&instanceIds=i-0123456789abcdef0'))).json();
    expect(d.snapshots).toBeNull();
    expect(d.instances).toEqual([]);
  });

  it("HOST account id normalizes to the 'self' sentinel (host rows are stored under 'self', not the raw id)", async () => {
    query.mockResolvedValue({ rows: [] });
    await GET(req('?volumeId=vol-0123456789abcdef0&account=999988887777&instanceIds=i-0123456789abcdef0'));
    expect((query.mock.calls[0][1] as unknown[])[0]).toBe('self');
    expect((query.mock.calls[1][1] as unknown[])[0]).toBe('self');
  });

  it('region narrows both queries; invalid region 400s; unknown encryption is tri-state null', async () => {
    query
      .mockResolvedValueOnce({ rows: [{ resource_id: 'snap-1', data: { volume_size: 1, start_time: '', state: 'pending' } }] })
      .mockResolvedValueOnce({ rows: [] });
    const d = await (await GET(req('?volumeId=vol-0123456789abcdef0&instanceIds=i-0123456789abcdef0&region=ap-northeast-2'))).json();
    expect(String(query.mock.calls[0][0])).toContain('AND region =');
    expect(String(query.mock.calls[1][0])).toContain('AND region =');
    expect(d.snapshots[0].encrypted).toBeNull(); // absent value ≠ definitive 미암호화
    expect((await GET(req("?volumeId=vol-0123456789abcdef0&region=bad'--"))).status).toBe(400);
  });

  it('no instanceIds → instances [] with a single (snapshot) query', async () => {
    query.mockResolvedValueOnce({ rows: [] });
    const d = await (await GET(req('?volumeId=vol-0123456789abcdef0'))).json();
    expect(d.instances).toEqual([]);
    expect(query).toHaveBeenCalledTimes(1);
  });
});
