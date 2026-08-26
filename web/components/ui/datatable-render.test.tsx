// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import DataTable from './DataTable';

afterEach(cleanup);

const cols = [{ key: 'name', label: 'Name' }, { key: 'runtime', label: 'Runtime' }];

// DataTable renders BOTH the desktop table (hidden lg:block) and the mobile
// card list (lg:hidden) in the DOM — CSS hides one per viewport, but jsdom has
// no viewport, so every cell value appears twice. Assert with getAllByText.
describe('DataTable — Lambda EOL runtime badge', () => {
  it('shows an EOL badge for a deprecated runtime', () => {
    render(<DataTable columns={cols} rows={[{ name: 'fn-old', runtime: 'nodejs14.x' }]} />);
    expect(screen.getAllByText('EOL').length).toBeGreaterThan(0);
    expect(screen.getAllByText('nodejs14.x').length).toBeGreaterThan(0);
  });
  it('does NOT show EOL for a current runtime', () => {
    render(<DataTable columns={cols} rows={[{ name: 'fn-new', runtime: 'nodejs20.x' }]} />);
    expect(screen.queryByText('EOL')).toBeNull();
    expect(screen.getAllByText('nodejs20.x').length).toBeGreaterThan(0);
  });
  it('only treats the runtime column as a runtime (not other columns)', () => {
    render(<DataTable columns={[{ key: 'name', label: 'Name' }]} rows={[{ name: 'nodejs14.x' }]} />);
    expect(screen.queryByText('EOL')).toBeNull();
  });
});

describe('DataTable — mobile card mode', () => {
  it('renders a card list (lg:hidden) alongside the table, with title + field value', () => {
    const { container } = render(
      <DataTable
        columns={[
          { key: 'name', label: 'Name' },
          { key: 'state', label: 'State' },
          { key: 'type', label: 'Type' },
        ]}
        rows={[{ name: 'inst-1', state: 'running', type: 't3.micro' }]}
      />,
    );
    // Card grid present and mobile-only (hidden at lg via lg:hidden).
    const cardGrid = container.querySelector('.lg\\:hidden');
    expect(cardGrid).toBeTruthy();
    // Title (first column) renders inside the card grid.
    expect(cardGrid!.textContent).toContain('inst-1');
    // A non-title/non-status field shows as label:value (header label + value).
    expect(cardGrid!.textContent).toContain('Type');
    expect(cardGrid!.textContent).toContain('t3.micro');
    // Status column value surfaced prominently in the card.
    expect(cardGrid!.textContent).toContain('running');
  });

  it('respects cardTitleKey + mobileColumns overrides', () => {
    const { container } = render(
      <DataTable
        columns={[
          { key: 'id', label: 'ID' },
          { key: 'name', label: 'Name' },
          { key: 'region', label: 'Region' },
        ]}
        rows={[{ id: 'i-123', name: 'web', region: 'us-east-1' }]}
        cardTitleKey="name"
        mobileColumns={['region']}
      />,
    );
    const cardGrid = container.querySelector('.lg\\:hidden')!;
    expect(cardGrid.textContent).toContain('web'); // title = name
    expect(cardGrid.textContent).toContain('Region');
    expect(cardGrid.textContent).toContain('us-east-1');
  });
});
