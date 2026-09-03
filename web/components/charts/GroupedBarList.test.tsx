// @vitest-environment jsdom
import { afterEach, describe, it, expect } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import GroupedBarList from './GroupedBarList';

afterEach(cleanup);

const SERIES = [
  { key: 'a', label: 'Alpha', color: '#111111', fmt: (v: number) => `$${v.toFixed(2)}` },
  { key: 'b', label: 'Beta', color: '#222222' },
];

function widths(container: HTMLElement): number[] {
  return [...container.querySelectorAll<HTMLElement>('span > span[style]')]
    .filter((el) => el.style.width)
    .map((el) => parseFloat(el.style.width));
}

describe('GroupedBarList', () => {
  it('per-series scaling (default): each series fills to ITS OWN max (mixed-unit callers)', () => {
    const { container } = render(
      <GroupedBarList title="t" data={[{ n: 'x', a: 100, b: 4 }]} labelKey="n" series={SERIES} />,
    );
    // both series' single row is its series max → both tracks 100%
    expect(widths(container)).toEqual([100, 100]);
  });
  it('sharedScale: SAME-unit series share one global max (a small series must not render full-width)', () => {
    const { container } = render(
      <GroupedBarList title="t" data={[{ n: 'x', a: 100, b: 25 }]} labelKey="n" series={SERIES} sharedScale />,
    );
    expect(widths(container)).toEqual([100, 25]);
  });
  it("a null value renders '—' with an empty track (unknown must never read as 0)", () => {
    const { container } = render(
      <GroupedBarList title="t" data={[{ n: 'x', a: 10, b: null }]} labelKey="n" series={SERIES} />,
    );
    expect(screen.getByText('—')).toBeTruthy();
    expect(widths(container)).toEqual([100, 0]);
  });
  it('renders legend chips and per-series formatted values', () => {
    render(<GroupedBarList title="t" data={[{ n: 'x', a: 12.5, b: 3 }]} labelKey="n" series={SERIES} />);
    expect(screen.getByText('Alpha')).toBeTruthy();
    expect(screen.getByText('Beta')).toBeTruthy();
    expect(screen.getByText('$12.50')).toBeTruthy(); // series fmt applied
    expect(screen.getByText('3')).toBeTruthy(); // default toLocaleString
  });
});
