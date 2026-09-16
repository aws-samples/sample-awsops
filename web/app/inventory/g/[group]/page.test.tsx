import { describe, it, expect, vi } from 'vitest';

// notFound() throws a sentinel so we can assert the guard fires.
vi.mock('next/navigation', () => ({ notFound: () => { throw new Error('NEXT_NOT_FOUND'); } }));
vi.mock('./GroupOverviewClient', () => ({ default: () => null }));

import GroupOverviewPage from './page';

describe('group overview route guard (/inventory/g/[group])', () => {
  it('renders for a valid overview group (network)', async () => {
    await expect(GroupOverviewPage({ params: Promise.resolve({ group: 'network' }) })).resolves.toBeTruthy();
  });
  it('404s an unknown slug', async () => {
    await expect(GroupOverviewPage({ params: Promise.resolve({ group: 'nope' }) })).rejects.toThrow('NEXT_NOT_FOUND');
  });
  it('404s a singleton group (monitoring has no overview page)', async () => {
    await expect(GroupOverviewPage({ params: Promise.resolve({ group: 'monitoring' }) })).rejects.toThrow('NEXT_NOT_FOUND');
  });
});
