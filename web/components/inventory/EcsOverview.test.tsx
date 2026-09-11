// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import EcsOverview, { clusterLeaf } from './EcsOverview';

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

const cluster = (id: string, extra: Record<string, unknown> = {}) => ({
  resource_id: id, region: 'ap-northeast-2', account_id: 'self',
  data: { status: 'ACTIVE', running_tasks_count: 3, pending_tasks_count: 0, active_services_count: 2, ...extra },
});
const service = (name: string, desired: number, running: number) => ({
  resource_id: name, region: 'ap-northeast-2', account_id: 'self',
  data: { service_name: name, status: 'ACTIVE', desired_count: desired, running_count: running, launch_type: 'FARGATE', cluster_arn: `arn:aws:ecs:ap-northeast-2:1:cluster/main` },
});

function stubApis({ clusters = [cluster('c1')], services = [service('svc-a', 2, 2)], run = { status: 'succeeded' } as unknown, taskCount = 7 as number | null } = {}) {
  vi.stubGlobal('fetch', vi.fn((url: string) => {
    const body =
      url.includes('ecs_cluster') ? { rows: clusters, run } :
      url.includes('ecs_service') ? { rows: services, run } :
      url.includes('ecs_task') ? { rows: [], run } : // run ledger only (limit=1 gate fetch)
      // a never-synced type is ABSENT from byType (GROUP BY) — null models that
      { byType: taskCount == null ? [] : [{ type: 'ecs_task', count: taskCount }] };
    return Promise.resolve({ ok: true, status: 200, json: async () => body });
  }));
}

describe('clusterLeaf', () => {
  it('extracts the cluster name from an ARN and dashes empties', () => {
    expect(clusterLeaf('arn:aws:ecs:r:1:cluster/prod-main')).toBe('prod-main');
    expect(clusterLeaf(undefined)).toBe('—');
  });
});

describe('EcsOverview (gap L216 — unified one-screen view)', () => {
  it('renders KPI counts, both tables, and the per-service deficit (surplus never cancels)', async () => {
    // svc-a is 1 below desired; svc-b runs a mid-deploy SURPLUS (3 > 1) — the deficit must
    // stay 1, not 3-4=-1 (fleet-sum arithmetic would let the surplus cancel the shortfall)
    stubApis({ services: [service('svc-a', 3, 2), service('svc-b', 1, 3)] });
    render(<EcsOverview />);
    await waitFor(() => expect(screen.getByText('svc-a')).toBeTruthy());
    expect(screen.getByText('c1')).toBeTruthy();
    expect(screen.getByText('7')).toBeTruthy(); // task count from summary
    expect(screen.getByText('5/4 running')).toBeTruthy(); // aggregate hint (real sums)
    const tile = screen.getByText('Desired 대비 미달 태스크').closest('div')!.parentElement!;
    expect(tile.textContent).toContain('1');
  });

  it('suppresses the rollup on a truncated (>=500) service page and labels the sample', async () => {
    const many = Array.from({ length: 500 }, (_, i) => service(`s${i}`, 2, 1));
    stubApis({ services: many });
    render(<EcsOverview />);
    await waitFor(() => expect(screen.getByText('s0')).toBeTruthy());
    expect(screen.queryByText(/running$/)).toBeNull(); // no fleet-total rollup from a sample
    expect(screen.getAllByText(/표본 기준/).length).toBeGreaterThan(0);
  });

  it('a non-succeeded run renders the stale caption; last-good rows stay listed', async () => {
    stubApis({ run: { status: 'failed' } });
    render(<EcsOverview />);
    await waitFor(() => expect(screen.getAllByText(/마지막 sync가 성공하지 못했습니다/).length).toBeGreaterThan(0));
    expect(screen.getByText('c1')).toBeTruthy();
  });

  it('pre-sync (no rows, no run, EMPTY summary) reads 미수집 and dashes the task tile — never a fabricated 0', async () => {
    stubApis({ clusters: [], services: [], run: null, taskCount: null });
    render(<EcsOverview />);
    await waitFor(() => expect(screen.getAllByText(/미수집 — sync 후/).length).toBe(2));
    const taskTile = screen.getByText('태스크').closest('div')!.parentElement!;
    expect(taskTile.textContent).not.toContain('0');
    expect(taskTile.textContent).toContain('—');
  });

  it('run:null WITH rows renders the unverifiable-freshness caption', async () => {
    stubApis({ run: null });
    render(<EcsOverview />);
    await waitFor(() => expect(screen.getAllByText(/sync 이력 정보가 없어/).length).toBe(2));
    expect(screen.getByText('c1')).toBeTruthy();
  });

  it("a 'running' run renders the in-progress caption, not a failure assertion", async () => {
    stubApis({ run: { status: 'running' } });
    render(<EcsOverview />);
    await waitFor(() => expect(screen.getAllByText(/sync 실행 중/).length).toBeGreaterThanOrEqual(2));
    expect(screen.queryByText(/성공하지 못했습니다/)).toBeNull();
  });

  it('a succeeded run + byType-absent task type is a TRUE 0; a failed run dashes the count', async () => {
    stubApis({ taskCount: null }); // absent from byType, run succeeded
    render(<EcsOverview />);
    await waitFor(() => expect(screen.getByText('c1')).toBeTruthy());
    const taskTile = screen.getByText('태스크').closest('div')!.parentElement!;
    expect(taskTile.textContent).toContain('0');
    cleanup();
    stubApis({ run: { status: 'failed', finished_at: '2026-09-01T00:00:00Z' }, taskCount: 9 });
    render(<EcsOverview />);
    await waitFor(() => expect(screen.getByText('c1')).toBeTruthy());
    const tile2 = screen.getByText('태스크').closest('div')!.parentElement!;
    expect(tile2.textContent).not.toContain('9');
    expect(tile2.textContent).toContain('—');
  });

  it('capturedAt is the DATA time — a failed run reads 미수집 in the header, never the attempt time', async () => {
    stubApis({ run: { status: 'failed', finished_at: '2026-09-01T00:00:00Z' } });
    render(<EcsOverview />);
    await waitFor(() => expect(screen.getByText('c1')).toBeTruthy());
    expect(screen.getByText(/미수집/)).toBeTruthy(); // RefreshButton's no-data-time label
    expect(screen.queryByText(/업데이트:/)).toBeNull();
  });
});
