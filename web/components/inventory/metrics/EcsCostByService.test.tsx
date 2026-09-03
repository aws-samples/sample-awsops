// @vitest-environment jsdom
import { afterEach, describe, it, expect } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { EcsCostByService } from './EcsCostByService';
import { estimateDailyParts } from '@/lib/cost-basis';

afterEach(cleanup);

const task = (over: Record<string, unknown>) => ({
  resource_id: 'arn:t', launch_type: 'FARGATE', task_group: 'service:web', cluster_h: 'prod',
  cluster_arn: 'arn:aws:ecs:ap-northeast-2:1:cluster/prod', cpu: 512, memory: 1024, ...over,
});

describe('EcsCostByService (gap L195)', () => {
  it('groups FARGATE tasks by service and splits CPU vs Memory from the shared estimator', () => {
    render(<EcsCostByService rows={[task({}), task({ resource_id: 'arn:t2' })]} />);
    expect(screen.getByText('prod/web')).toBeTruthy();
    // two identical tasks → 2× the shared estimateDailyParts split (lockstep by import)
    const parts = estimateDailyParts(512 / 1024, 1024 / 1024);
    expect(screen.getByText(`$${(2 * parts.cpu).toFixed(2)}`)).toBeTruthy();
    expect(screen.getByText(`$${(2 * parts.ram).toFixed(2)}`)).toBeTruthy();
  });
  it('excludes EC2 launch-type and non-service groups (no estimate → no bar), renders nothing when empty', () => {
    const { container } = render(
      <EcsCostByService rows={[task({ launch_type: 'EC2' }), task({ task_group: 'family:batch' })]} />,
    );
    expect(container.innerHTML).toBe('');
  });
  it('same-named services in DIFFERENT clusters stay separate bars (names are cluster-scoped)', () => {
    render(<EcsCostByService rows={[task({}), task({ resource_id: 'arn:t2', cluster_h: 'staging', cluster_arn: 'arn:aws:ecs:ap-northeast-2:1:cluster/staging' })]} />);
    expect(screen.getByText('prod/web')).toBeTruthy();
    expect(screen.getByText('staging/web')).toBeTruthy();
  });
  it('same-NAMED clusters in different regions/accounts stay separate (keyed on the full cluster_arn)', () => {
    render(<EcsCostByService rows={[
      task({}),
      task({ resource_id: 'arn:t2', cluster_arn: 'arn:aws:ecs:us-east-1:2:cluster/prod' }),
    ]} />);
    // two bars, both labeled prod/web — distinct keys, so both render
    expect(screen.getAllByText('prod/web')).toHaveLength(2);
  });
  it('null/zero cpu or memory rows are excluded (a confident $0.00 must not render)', () => {
    const { container } = render(<EcsCostByService rows={[task({ cpu: null }), task({ resource_id: 'arn:t3', memory: 0 })]} />);
    expect(container.innerHTML).toBe('');
  });
  it('labels the title as sample-based when the 500-row fetch is truncated', () => {
    render(<EcsCostByService rows={[task({})]} isTruncated />);
    expect(screen.getByText(/표본 기준/)).toBeTruthy();
  });
  it('caps to top 10 services by total', () => {
    const rows = Array.from({ length: 12 }, (_, i) => task({ task_group: `service:s${i}`, cpu: 256 * (i + 1) }));
    render(<EcsCostByService rows={rows} />);
    expect(screen.queryByText('prod/s0')).toBeNull(); // smallest two fall off
    expect(screen.getByText('prod/s11')).toBeTruthy();
  });
});
