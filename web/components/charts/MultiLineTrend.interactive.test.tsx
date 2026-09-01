// @vitest-environment jsdom
import { describe, it, expect, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent } from '@testing-library/react';
import MultiLineTrend from './MultiLineTrend';

afterEach(cleanup);

const DATA = [
  { date: '2026-08-30', ec2: 1, s3: 2, lambda: 3 },
  { date: '2026-08-31', ec2: 2, s3: 3, lambda: 4 },
];
const SERIES = [{ key: 'ec2', label: 'EC2' }, { key: 's3', label: 'S3' }, { key: 'lambda', label: 'Lambda' }];

describe('MultiLineTrend interactive legend (gap L126)', () => {
  it('renders grouped toggle chips; defaultHidden series start off and toggle back on', () => {
    render(
      <MultiLineTrend
        title="t" data={DATA} xKey="date" series={SERIES}
        interactiveLegend
        legendGroups={[{ label: 'Core Resources', keys: ['ec2', 's3'] }, { label: 'Other Resources', keys: ['lambda'] }]}
        defaultHidden={['lambda']}
      />,
    );
    expect(screen.getByText('Core Resources')).toBeTruthy();
    expect(screen.getByText('Other Resources')).toBeTruthy();
    const lambdaChip = screen.getByRole('button', { name: /Lambda/ });
    expect(lambdaChip.getAttribute('aria-pressed')).toBe('false'); // default-hidden
    fireEvent.click(lambdaChip);
    expect(lambdaChip.getAttribute('aria-pressed')).toBe('true');
    const ec2Chip = screen.getByRole('button', { name: /EC2/ });
    fireEvent.click(ec2Chip);
    expect(ec2Chip.getAttribute('aria-pressed')).toBe('false');
  });
  it('non-interactive charts keep the static legend (no buttons)', () => {
    render(<MultiLineTrend title="t" data={DATA} xKey="date" series={SERIES} />);
    expect(screen.queryByRole('button')).toBeNull();
    expect(screen.getAllByText('EC2').length).toBeGreaterThanOrEqual(1);
  });
});
