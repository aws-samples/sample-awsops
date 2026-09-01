// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup, waitFor } from '@testing-library/react';
import { RdsSgRulesSection } from './RdsSgRulesSection';

afterEach(() => { cleanup(); vi.restoreAllMocks(); });

function setFetch(body: unknown, ok = true) {
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    expect(String(url)).toContain('/api/inventory/security_group/inbound?ids=');
    return { ok, status: ok ? 200 : 500, json: async () => body };
  }));
}

describe('RdsSgRulesSection (gap L154)', () => {
  it('renders per-SG cards with protocol / port / source chips and descriptions', async () => {
    setFetch({ groups: [{
      sgId: 'sg-11112222', found: true, groupName: 'db-sg',
      rules: [{ protocol: 'tcp', portRange: '5432', sources: [
        { kind: 'cidr', value: '10.0.0.0/16', description: 'vpc internal' },
        { kind: 'sg', value: 'sg-33334444' },
      ] }],
    }] });
    render(<RdsSgRulesSection sgIds={['sg-11112222']} />);
    await waitFor(() => expect(screen.getByText('db-sg')).toBeTruthy());
    expect(screen.getByText('tcp')).toBeTruthy();
    expect(screen.getByText('5432')).toBeTruthy();
    expect(screen.getByText(/10\.0\.0\.0\/16/)).toBeTruthy();
    expect(screen.getByText('(vpc internal)')).toBeTruthy();
    expect(screen.getByText('sg-33334444')).toBeTruthy();
  });

  it("empty rules → v1's 'No inbound rules'; unfound SG → the honest not-synced state", async () => {
    setFetch({ groups: [
      { sgId: 'sg-11112222', found: true, rules: [] },
      { sgId: 'sg-99998888', found: false, rules: [] },
    ] });
    render(<RdsSgRulesSection sgIds={['sg-11112222', 'sg-99998888']} />);
    await waitFor(() => expect(screen.getByText('인바운드 규칙 없음')).toBeTruthy());
    expect(screen.getByText('인벤토리에 미동기화')).toBeTruthy();
  });

  it('fetch failure renders an inline error under the heading, never a dead block', async () => {
    setFetch({}, false);
    render(<RdsSgRulesSection sgIds={['sg-11112222']} />);
    await waitFor(() => expect(screen.getByText('보안 그룹 규칙 조회 실패')).toBeTruthy());
    expect(screen.getByText('보안 그룹 인바운드 규칙')).toBeTruthy();
  });

  it('renders nothing when the row has no SG ids', () => {
    const f = vi.fn();
    vi.stubGlobal('fetch', f);
    const { container } = render(<RdsSgRulesSection sgIds={[]} />);
    expect(container.innerHTML).toBe('');
    expect(f).not.toHaveBeenCalled();
  });
});
