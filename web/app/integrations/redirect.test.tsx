import { describe, it, expect, vi } from 'vitest';

// Next's redirect() throws a control-flow signal; the mock throws a recognizable message so the test
// can assert the target without Next's runtime.
vi.mock('next/navigation', () => ({ redirect: (u: string) => { throw new Error(`REDIRECT:${u}`); } }));

import DatasourcesRedirect from '../datasources/page';

describe('/datasources → Integrations hub redirect (Task 29)', () => {
  it('redirects to the Datasources tab by default', () => {
    expect(() => DatasourcesRedirect({ searchParams: {} })).toThrow('REDIRECT:/integrations?tab=datasources');
  });
  it('maps a legacy ?instance= deep link to the per-instance Explore route', () => {
    expect(() => DatasourcesRedirect({ searchParams: { instance: '7' } })).toThrow('REDIRECT:/integrations/datasources/7');
  });
});
