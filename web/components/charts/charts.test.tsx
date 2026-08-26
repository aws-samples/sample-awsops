// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, within } from '@testing-library/react';

// recharts ResponsiveContainer measures its parent, which jsdom reports as 0×0
// so chart children never mount. Replace it with a fixed-size div so the inner
// chart renders deterministically. Keep assertions shallow (title + no throw).
vi.mock('recharts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('recharts')>();
  return {
    ...actual,
    ResponsiveContainer: ({ children }: { children: React.ReactNode }) => (
      <div style={{ width: 600, height: 240 }}>{children}</div>
    ),
  };
});

import AreaTrend from './AreaTrend';
import BarDistribution from './BarDistribution';
import DonutBreakdown from './DonutBreakdown';
import HBarList from './HBarList';

afterEach(cleanup);

const trend = [
  { date: '2026-06-01', amount: 120.5 },
  { date: '2026-06-02', amount: 98.2 },
  { date: '2026-06-03', amount: 143.7 },
];
const dist = [
  { label: 'EC2', count: 25 },
  { label: 'Lambda', count: 12 },
  { label: 'S3', count: 8 },
];
const cats = [
  { group: 'compute', count: 40 },
  { group: 'storage', count: 18 },
  { group: 'network', count: 9 },
];
// 10 categories to exercise the Top-N "기타" rollup (design handoff 개선안 ②-B, maxSlices default 8).
const manyCats = Array.from({ length: 10 }, (_, i) => ({ group: `g${i}`, count: 10 - i }));
const services = [
  { service: 'Amazon EC2', amount: 3200.4 },
  { service: 'Amazon RDS', amount: 1450.0 },
  { service: 'Amazon S3', amount: 620.75 },
];

describe('AreaTrend', () => {
  it('renders its title without throwing', () => {
    expect(() =>
      render(<AreaTrend title="일별 비용 추이" data={trend} xKey="date" yKey="amount" valuePrefix="$" />),
    ).not.toThrow();
    expect(screen.getByText('일별 비용 추이')).toBeTruthy();
  });

  it('omits the two-series legend when no lineKey is given (single-series unchanged)', () => {
    render(<AreaTrend title="일별 비용 추이" data={trend} xKey="date" yKey="amount" valuePrefix="$" />);
    expect(screen.queryByText('EC2')).toBeNull();
  });

  it('renders an area+line legend when lineKey/areaLabel/lineLabel are set (리소스 추세)', () => {
    const resourceTrend = [
      { date: '2026-06-01', total: 132, ec2: 25 },
      { date: '2026-06-02', total: 140, ec2: 27 },
    ];
    render(
      <AreaTrend
        title="리소스 추세"
        data={resourceTrend}
        xKey="date"
        yKey="total"
        lineKey="ec2"
        areaLabel="전체 리소스"
        lineLabel="EC2"
      />,
    );
    expect(screen.getByText('전체 리소스')).toBeTruthy();
    expect(screen.getByText('EC2')).toBeTruthy();
  });
});

describe('BarDistribution', () => {
  it('renders its title without throwing', () => {
    expect(() =>
      render(<BarDistribution title="리소스 분포" data={dist} xKey="label" yKey="count" />),
    ).not.toThrow();
    expect(screen.getByText('리소스 분포')).toBeTruthy();
  });

  it('sorts descending and highlights the max row (design handoff 개선안 ②-A: horizontal ranking bars)', () => {
    const unsorted = [
      { label: 'S3', count: 8 },
      { label: 'EC2', count: 25 },
      { label: 'Lambda', count: 12 },
    ];
    const { container } = render(<BarDistribution title="리소스 분포" data={unsorted} xKey="label" yKey="count" />);
    const rows = container.querySelectorAll('li');
    expect(rows[0].textContent).toContain('EC2'); // highest count sorts first
    expect(container.innerHTML).toContain('bg-brand-700'); // max row emphasized
  });
});

describe('DonutBreakdown', () => {
  it('renders its title, a legend entry, and the total without throwing', () => {
    expect(() =>
      render(<DonutBreakdown title="카테고리별 리소스" data={cats} nameKey="group" valueKey="count" />),
    ).not.toThrow();
    expect(screen.getByText('카테고리별 리소스')).toBeTruthy();
    expect(screen.getByText('compute')).toBeTruthy();
    // center total = 40 + 18 + 9 = 67
    expect(screen.getByText('67')).toBeTruthy();
  });

  it('renders a percentage next to each legend value', () => {
    render(<DonutBreakdown title="카테고리별 리소스" data={cats} nameKey="group" valueKey="count" />);
    // compute = 40/67 = 59.7%
    expect(screen.getByText('59.7%')).toBeTruthy();
  });

  it('rolls up slices past maxSlices into a single "기타" entry (design handoff 개선안 ②-B)', () => {
    render(<DonutBreakdown title="많은 카테고리" data={manyCats} nameKey="group" valueKey="count" />);
    // 10 categories, default maxSlices=8 → top 7 kept + 1 "기타" rollup of the remaining 3 (g7+g8+g9 = 3+2+1 = 6)
    const etcRow = screen.getByText('기타').closest('li')!;
    expect(within(etcRow).getByText('6')).toBeTruthy();
    expect(screen.queryByText('g8')).toBeNull(); // folded into "기타", not shown individually
  });
});

describe('HBarList', () => {
  it('renders its title and a labelled row with a $ amount without throwing', () => {
    expect(() =>
      render(
        <HBarList
          title="서비스별 비용"
          data={services}
          labelKey="service"
          valueKey="amount"
          valuePrefix="$"
        />,
      ),
    ).not.toThrow();
    expect(screen.getByText('서비스별 비용')).toBeTruthy();
    expect(screen.getByText('Amazon EC2')).toBeTruthy();
    expect(screen.getByText('$3,200.40')).toBeTruthy();
  });

  it('highlightMax emphasizes only the max-value row', () => {
    const { container } = render(
      <HBarList title="서비스별 비용" data={services} labelKey="service" valueKey="amount" highlightMax />,
    );
    expect(container.innerHTML).toContain('bg-brand-700');
  });
});
