// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
vi.mock('@/components/shell/LanguageProvider', () => ({ useI18n: () => ({ lang: 'en' }) }));
import GraphCollectionStatus from './GraphCollectionStatus';

afterEach(cleanup);

describe('graph collection status', () => {
  it('identifies failed collection and retained data without claiming no traffic', () => {
    render(<GraphCollectionStatus collection={{
      status: 'error', stale: true, retainedPrevious: true,
      sources: [{ sourceId: 'tempo:1', status: 'error' }],
    }} />);
    expect(screen.getByRole('alert').textContent).toContain('Collection failed');
    expect(screen.getByRole('alert').textContent).toContain('previous graph');
    expect(screen.queryByText('No observations in this window')).toBeNull();
  });

  it('labels a successful empty read separately from unavailable telemetry', () => {
    render(<GraphCollectionStatus collection={{ status: 'empty', stale: false }} />);
    expect(screen.getByRole('status').textContent).toContain('No observations in this window');
  });

  it('does not describe a stale successful snapshot as current', () => {
    render(<GraphCollectionStatus collection={{ status: 'ok', stale: true }} />);
    expect(screen.getByRole('alert').textContent).toContain('Stale');
  });
});
