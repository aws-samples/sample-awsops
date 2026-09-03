// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent } from '@testing-library/react';
import EksFilterPanel, { NO_VPC, type EksFilterState } from './EksFilterPanel';

afterEach(cleanup);

const CLUSTERS = [
  { name: 'prod-a', vpcId: 'vpc-1' },
  { name: 'prod-b', vpcId: 'vpc-1' },
  { name: 'dev-c', vpcId: 'vpc-2' },
  { name: 'legacy-d' }, // no vpcId → (no VPC) bucket
];

function mount(value: EksFilterState = { clusters: [], vpcs: [] }, onChange = vi.fn()) {
  render(<EksFilterPanel clusters={CLUSTERS} value={value} onChange={onChange} filteredCount={4} />);
  return onChange;
}

const open = () => fireEvent.click(screen.getByText('클러스터 / VPC 필터'));

describe('EksFilterPanel (gap L130)', () => {
  it('VPC chips carry per-VPC cluster counts and a (no VPC) bucket', () => {
    mount();
    open();
    // Assert on the chip BUTTON itself — a row-level assertion would pass with counts on
    // the wrong chips.
    expect(screen.getByText('vpc-1').closest('button')?.textContent).toBe('vpc-1(2)');
    expect(screen.getByText('vpc-2').closest('button')?.textContent).toBe('vpc-2(1)');
    expect(screen.getByText(NO_VPC).closest('button')?.textContent).toBe(`${NO_VPC}(1)`);
  });

  it('chip clicks toggle multi-select (add and remove)', () => {
    const onChange = mount({ clusters: ['prod-a'], vpcs: [] });
    open();
    fireEvent.click(screen.getByText('prod-b'));
    expect(onChange).toHaveBeenLastCalledWith({ clusters: ['prod-a', 'prod-b'], vpcs: [] });
    fireEvent.click(screen.getByText('prod-a'));
    expect(onChange).toHaveBeenLastCalledWith({ clusters: [], vpcs: [] });
  });

  it('active-filter badge counts selections; Clear all resets both facets', () => {
    const onChange = mount({ clusters: ['prod-a'], vpcs: ['vpc-2'] });
    expect(screen.getByText('2')).toBeTruthy(); // badge
    fireEvent.click(screen.getByText('전체 해제'));
    expect(onChange).toHaveBeenLastCalledWith({ clusters: [], vpcs: [] });
  });

  it('shows the filtered/total counter', () => {
    mount();
    expect(screen.getByText(/4\/4/)).toBeTruthy();
  });
});
