// @vitest-environment jsdom
import { describe, it, expect, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import NodeCapacityList, { type NodeCapacityRow } from './NodeCapacityList';

afterEach(cleanup);

const node = (over: Partial<NodeCapacityRow> = {}): NodeCapacityRow => ({
  cluster: 'prod-a', name: 'ip-10-0-1-1',
  cpuCapacity: 4, cpuAllocatable: 3.5, cpuRequest: 1.5,
  memCapacityMiB: 8192, memAllocatableMiB: 7168, memRequestMiB: 2048,
  ...over,
});

describe('NodeCapacityList (gap L132)', () => {
  it("renders v1's 'avail X | rsv Y' captions from capacity/allocatable/requested", () => {
    render(<NodeCapacityList rows={[node()]} />);
    // CPU: avail = 3.5 - 1.5 = 2.0; rsv = 4 - 3.5 = 0.5
    expect(screen.getByText('avail 2.0 vCPU | rsv 0.5 vCPU')).toBeTruthy();
    // Mem: avail = 7168 - 2048 = 5120MiB = 5.0G; rsv = 8192 - 7168 = 1024MiB = 1.0G
    expect(screen.getByText('avail 5.0G | rsv 1.0G')).toBeTruthy();
  });

  it("a null requested (pods fetch failed) reads '요청량 미상' — never a zero-requested claim", () => {
    render(<NodeCapacityList rows={[node({ cpuRequest: null, memRequestMiB: null })]} />);
    expect(screen.getAllByText(/요청량 미상/).length).toBe(2);
    expect(screen.queryByText(/avail .* vCPU \|/)).toBeNull();
  });

  it('caps rendering at 40 nodes with an explicit truncation note', () => {
    const rows = Array.from({ length: 45 }, (_, i) => node({ name: `n-${i}` }));
    render(<NodeCapacityList rows={rows} />);
    expect(screen.getByText(/40 \/ 45/)).toBeTruthy();
  });

  it('unknown-request (degraded) rows are NEVER truncated away by the pressure cap', () => {
    const rows = [
      ...Array.from({ length: 44 }, (_, i) => node({ name: `known-${i}`, cpuRequest: 3, memRequestMiB: 6144 })),
      node({ name: 'degraded-node', cpuRequest: null, memRequestMiB: null }), // would sort last by raw pressure
    ];
    render(<NodeCapacityList rows={rows} />);
    expect(screen.getByText('degraded-node')).toBeTruthy();
    expect(screen.getAllByText(/요청량 미상/).length).toBe(2);
  });

  it('among known rows the cap keeps the most PRESSURED ones', () => {
    const rows = [
      ...Array.from({ length: 44 }, (_, i) => node({ name: `idle-${i}`, cpuRequest: 0.1 })),
      node({ name: 'hot-node', cpuRequest: 3.4 }),
    ];
    render(<NodeCapacityList rows={rows} />);
    expect(screen.getByText('hot-node')).toBeTruthy();
  });

  it('renders nothing for an empty row set', () => {
    const { container } = render(<NodeCapacityList rows={[]} />);
    expect(container.innerHTML).toBe('');
  });
});
