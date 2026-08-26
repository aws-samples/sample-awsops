// @vitest-environment jsdom
import { describe, it, expect, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import IntegrationIcon from './IntegrationIcon';

afterEach(cleanup);

describe('IntegrationIcon', () => {
  it('renders a distinct, labeled icon per known kind', () => {
    for (const [kind, title] of [
      ['prometheus', 'Prometheus'], ['clickhouse', 'ClickHouse'], ['loki', 'Loki'],
      ['tempo', 'Tempo'], ['mimir', 'Mimir'], ['notion', 'Notion'],
    ] as const) {
      cleanup();
      render(<IntegrationIcon kind={kind} />);
      const el = screen.getByRole('img');
      expect(el.getAttribute('aria-label')).toBe(title);
    }
  });

  it('falls back to the kind name for an unknown kind (never crashes)', () => {
    render(<IntegrationIcon kind="wavefront" />);
    expect(screen.getByRole('img').getAttribute('aria-label')).toBe('wavefront');
  });
});
