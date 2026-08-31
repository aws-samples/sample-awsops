// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render, screen, fireEvent } from '@testing-library/react';
import MetricTable, { type MetricCol } from './MetricTable';

afterEach(cleanup);

interface Row { id: string; actions: string[] }

const rows: Row[] = [
  { id: 'r-blocked', actions: ['blocked'] },
  { id: 'r-none', actions: [] }, // e.g. a rule group with no parsed actions
];

const columns: MetricCol<Row>[] = [
  { key: 'id', label: 'ID', value: (r) => r.id },
  {
    key: 'action', label: 'Action', facet: true,
    facetValues: (r) => (r.actions.length ? r.actions : ['—']),
    value: (r) => r.actions.join(', ') || null,
  },
];

// Regression for the review finding: an empty facetValues() array must still be
// selectable as '—', or that row can never match any facet option (permanently hidden
// from every filter, with no way to find it via the facet control).
describe('MetricTable — empty facetValues fallback', () => {
  it('offers a "—" facet option and filters to the empty-array row when selected', () => {
    render(<MetricTable columns={columns} items={rows} rowKey={(r) => r.id} />);
    const select = screen.getByLabelText('Action 필터') as HTMLSelectElement;
    fireEvent.change(select, { target: { value: '—' } });
    expect(screen.getAllByText('r-none').length).toBeGreaterThan(0);
    expect(screen.queryByText('r-blocked')).toBeNull();
  });
  it('still filters correctly on a real facet value', () => {
    render(<MetricTable columns={columns} items={rows} rowKey={(r) => r.id} />);
    const select = screen.getByLabelText('Action 필터') as HTMLSelectElement;
    fireEvent.change(select, { target: { value: 'blocked' } });
    expect(screen.getAllByText('r-blocked').length).toBeGreaterThan(0);
    expect(screen.queryByText('r-none')).toBeNull();
  });
});
