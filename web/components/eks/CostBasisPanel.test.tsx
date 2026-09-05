// @vitest-environment jsdom
import { describe, it, expect, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent } from '@testing-library/react';
import CostBasisPanel from './CostBasisPanel';
import { ESTIMATE_UNIT_PRICES } from '@/lib/cost-basis';

afterEach(cleanup);

describe('CostBasisPanel (gap L217)', () => {
  it('renders collapsed; expanding shows the method table, LIVE formula constants, example, caveats', () => {
    render(<CostBasisPanel />);
    expect(screen.queryByText('주의사항')).toBeNull(); // collapsed by default
    fireEvent.click(screen.getByText('비용 계산 근거'));
    // 5-item method table
    expect(screen.getByText('Network')).toBeTruthy();
    expect(screen.getByText('GPU')).toBeTruthy();
    // the formula carries the LIVE constants (single source — can never drift from the estimator)
    expect(screen.getByText(new RegExp(String(ESTIMATE_UNIT_PRICES.vcpuHour).replace('.', '\\.')))).toBeTruthy();
    expect(screen.getByText(/\$0\.68\/day/)).toBeTruthy(); // worked example
    expect(screen.getByText('주의사항')).toBeTruthy();
    expect(screen.getByText('Spot / RI / Savings Plans 할인은 반영되지 않습니다.')).toBeTruthy();
  });
});
