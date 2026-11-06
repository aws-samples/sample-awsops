// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render, screen, within } from '@testing-library/react';
import NodeCapacityCards from './NodeCapacityCards';

afterEach(cleanup);

const props = {
  cpuCapacity: 2, cpuAllocatable: 2, cpuRequest: 0.5,
  memCapacityMiB: 8192, memAllocatableMiB: 8192, memRequestMiB: 1024,
  podCount: 3, podRunning: 3, podPending: 0, podFailed: 0,
};
const rowValue = (card: HTMLElement, label: string) => within(card).getByText(label).nextElementSibling?.textContent;

describe('NodeCapacityCards', () => {
  it('EC2/node-group view: capacity only, Allocatable/Reserved unknown, labelled', () => {
    render(<NodeCapacityCards {...props} ec2View />);
    expect(screen.getByRole('note').textContent).toContain('EC2/노드그룹 기준');
    const cpu = screen.getByText('CPU').parentElement!;
    expect(rowValue(cpu, 'Capacity')).toBe('2.0 vCPU');
    expect(rowValue(cpu, 'Allocatable')).toBe('—');
    expect(rowValue(cpu, 'Reserved')).toBe('—');
    expect(rowValue(cpu, 'Available')).toBe('—');
    const mem = screen.getByText('Memory').parentElement!;
    expect(rowValue(mem, 'Allocatable')).toBe('—');
    expect(screen.queryByText(/100%/)).toBeNull();
    expect(screen.queryByTitle(/System-Reserved/)).toBeNull();
  });

  it('unresolved instance capacity renders as unknown, never 0', () => {
    render(<NodeCapacityCards {...props} cpuCapacity={0} memCapacityMiB={0} ec2View capacityUnknown />);
    expect(rowValue(screen.getByText('CPU').parentElement!, 'Capacity')).toBe('—');
    expect(rowValue(screen.getByText('Memory').parentElement!, 'Capacity')).toBe('—');
  });

  it('kubelet view keeps allocatable percentages and the reserved split', () => {
    render(<NodeCapacityCards {...props} cpuAllocatable={1.9} />);
    expect(screen.queryByRole('note')).toBeNull();
    const cpu = screen.getByText('CPU').parentElement!;
    expect(rowValue(cpu, 'Allocatable')).toBe('1.9 (95%)');
    expect(screen.getAllByTitle(/System-Reserved/).length).toBeGreaterThan(0);
  });
});
