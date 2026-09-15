// @vitest-environment jsdom
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import type { FlowNode } from '@/lib/flow-topology';

vi.mock('@/components/shell/LanguageProvider', () => ({
  useI18n: () => ({ lang: 'en', tt: (s: string) => s, t: (s: string) => s }),
}));
vi.mock('@/lib/use-theme', () => ({ useTheme: () => 'light' }));
vi.mock('next/dynamic', () => ({
  default: () => ({ nodes }: { nodes: { id: string; data: { fnode: FlowNode } }[] }) =>
    <div>{nodes.map(n => <span key={n.id} data-testid={n.data.fnode.kind}>{n.data.fnode.label}</span>)}</div>,
}));
vi.mock('next/navigation', () => ({ useRouter: () => ({ push: vi.fn(), replace: vi.fn() }), useSearchParams: () => new URLSearchParams(window.location.search) }));
import TopologyPage from './page';

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });
it('passes independently collected subnet rows to the real ECS target resolver', async () => {
  vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => window.setTimeout(() => cb(0), 0));
  vi.stubGlobal('cancelAnimationFrame', (id: number) => window.clearTimeout(id));
  vi.stubGlobal('fetch', vi.fn(async (input: string) => {
    const url = new URL(input, 'http://localhost');
    if (url.pathname === '/api/eks') return Response.json({ clusters: [], region: 'us-east-1', truncated: false });
    const type = url.pathname.split('/').at(-1);
    const rows = type === 'target_group' ? [{
      resource_id: 'tg-orders', region: 'us-east-1', data: {
        vpc_id: 'vpc-a', target_type: 'ip',
        target_health_descriptions: [{ Target: { Id: '10.0.1.10', Port: 80 } }],
      },
    }] : type === 'subnet' ? [{
      resource_id: 'subnet-a', region: 'us-east-1', data: { vpc_id: 'vpc-a' },
    }] : type === 'ecs_task' ? [{
      resource_id: 'task-orders', region: 'us-east-1', data: {
        last_status: 'RUNNING', task_group: 'service:ecs-orders', cluster_arn: 'cluster/production',
        attachments: [{ Details: [
          { Name: 'subnetId', Value: 'subnet-a' }, { Name: 'privateIPv4Address', Value: '10.0.1.10' },
        ] }],
      },
    }] : [];
    return Response.json({ rows: rows.map(row => ({ ...row, account_id: 'self' })), consistency: 'statement-snapshot',
      run: { status: 'succeeded', finished_at: '2026-09-13T00:00:00Z', last_success_at: '2026-09-13T00:00:00Z', row_count: 1 } });
  }));
  render(<TopologyPage />);
  await waitFor(() => expect(screen.getByTestId('target').textContent).toBe('ecs-orders'));
});
