import { describe, it, expect, vi } from 'vitest';

// notFound() throws a sentinel so we can assert the guard fires.
vi.mock('next/navigation', () => ({ notFound: () => { throw new Error('NEXT_NOT_FOUND'); } }));
vi.mock('./GroupOverviewClient', () => ({ default: () => null }));

import GroupOverviewPage from './page';

describe('group overview route guard (/inventory/g/[group])', () => {
  it('renders for a valid overview group (network)', () => {
    expect(() => GroupOverviewPage({ params: { group: 'network' } })).not.toThrow();
  });
  it('404s an unknown slug', () => {
    expect(() => GroupOverviewPage({ params: { group: 'nope' } })).toThrow('NEXT_NOT_FOUND');
  });
  it('404s a singleton group (monitoring has no overview page)', () => {
    expect(() => GroupOverviewPage({ params: { group: 'monitoring' } })).toThrow('NEXT_NOT_FOUND');
  });
});
