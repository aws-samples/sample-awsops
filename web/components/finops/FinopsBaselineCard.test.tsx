// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, waitFor, cleanup } from '@testing-library/react';
import FinopsBaselineCard from './FinopsBaselineCard';
import { setActiveAccount, ALL_ACCOUNTS } from '@/lib/account-context';

function mockFetch(body: unknown) {
  return vi.fn(async (_url: string) => ({ ok: true, status: 200, json: async () => body }));
}

afterEach(() => { cleanup(); vi.unstubAllGlobals(); window.localStorage.clear(); });

describe('FinopsBaselineCard', () => {
  it('renders nothing when the feature is disabled (enabled:false)', async () => {
    vi.stubGlobal('fetch', mockFetch({ enabled: false, findings: [], lastRun: null }));
    const { container } = render(<FinopsBaselineCard />);
    await waitFor(() => expect(container.querySelector('[data-testid="finops-baseline-card"]')).toBeNull());
  });

  it('shows the never-ran empty state when enabled with no runs yet', async () => {
    vi.stubGlobal('fetch', mockFetch({ enabled: true, findings: [], lastRun: null }));
    render(<FinopsBaselineCard />);
    await waitFor(() => screen.getByTestId('finops-baseline-empty'));
    expect(screen.getByText('아직 배치가 실행되지 않았습니다 — 다음 일일 배치를 기다려주세요.')).toBeTruthy();
  });

  it('shows the "no waste found" empty state when a run happened but found nothing', async () => {
    vi.stubGlobal('fetch', mockFetch({
      enabled: true, findings: [],
      lastRun: { id: 1, startedAt: 'a', finishedAt: 'b', status: 'succeeded', rulesEvaluated: 2, findingsCount: 0, ceApiCalls: 1, error: null },
    }));
    render(<FinopsBaselineCard />);
    await waitFor(() => screen.getByTestId('finops-baseline-empty'));
    expect(screen.getByText('현재 발견된 상시 낭비 항목이 없습니다.')).toBeTruthy();
  });

  it('shows an in-progress state instead of "no waste found" while the batch is running', async () => {
    // A review round caught that finops_runs.status='running' (the row engine.run() inserts
    // BEFORE evaluating anything) with no prior findings fell through to the clean-empty branch —
    // a batch that is still executing (or one stuck forever because the worker died mid-run) must
    // never look like a confirmed-clean result.
    vi.stubGlobal('fetch', mockFetch({
      enabled: true, findings: [],
      lastRun: { id: 1, startedAt: 'a', finishedAt: null, status: 'running', rulesEvaluated: null, findingsCount: null, ceApiCalls: 0, error: null },
    }));
    render(<FinopsBaselineCard />);
    await waitFor(() => screen.getByTestId('finops-baseline-running'));
    expect(screen.queryByTestId('finops-baseline-empty')).toBeNull();
  });

  it('shows a failed-batch error instead of an empty state', async () => {
    vi.stubGlobal('fetch', mockFetch({
      enabled: true, findings: [],
      lastRun: { id: 1, startedAt: 'a', finishedAt: 'b', status: 'failed', rulesEvaluated: 1, findingsCount: 0, ceApiCalls: 0, error: 'AccessDenied' },
    }));
    render(<FinopsBaselineCard />);
    await waitFor(() => screen.getByTestId('finops-baseline-error'));
    expect(screen.getByText(/AccessDenied/)).toBeTruthy();
  });

  it('renders findings and shows a needs_review item\'s null savings as "산출 불가" (never $0)', async () => {
    vi.stubGlobal('fetch', mockFetch({
      enabled: true,
      lastRun: { id: 1, startedAt: 'a', finishedAt: new Date().toISOString(), status: 'succeeded', rulesEvaluated: 2, findingsCount: 2, ceApiCalls: 1, error: null },
      findings: [
        { id: 1, ruleId: 'ebs_unattached', resourceId: 'vol-1', title: 'Unattached EBS vol-1', category: 'storage',
          status: 'active', monthlySavingsUsd: 9.12, evidence: {}, guardHits: [], explanationKo: '연결 안 된 볼륨입니다', firstSeenAt: 'a', lastSeenAt: 'b' },
        { id: 2, ruleId: 'ec2_rightsizing', resourceId: 'arn:x', title: 'EC2 rightsizing arn:x', category: 'compute',
          status: 'needs_review', monthlySavingsUsd: null, evidence: {}, guardHits: ['protected_tag:dr'], explanationKo: null, firstSeenAt: 'a', lastSeenAt: 'b' },
      ],
    }));
    render(<FinopsBaselineCard />);
    await waitFor(() => screen.getByText('Unattached EBS vol-1'));
    expect(screen.getByText('$9.12/mo')).toBeTruthy();
    expect(screen.getByText('연결 안 된 볼륨입니다')).toBeTruthy();
    expect(screen.getByText('EC2 rightsizing arn:x')).toBeTruthy();
    expect(screen.getByText('금액 산출 불가')).toBeTruthy(); // NOT $0.00 for the null item
    expect(screen.getByText(/protected_tag:dr/)).toBeTruthy();
    // header total counts only the 'active' item; the needs_review item (even though it's shown
    // in the list) is excluded from both the total AND the "N건 금액 산출 불가" callout — that
    // callout is specifically about active-but-unpriced items, not guard-flagged ones.
    expect(screen.getByTestId('finops-baseline-total').textContent).toContain('9.12');
    expect(screen.queryByText(/건 금액 산출 불가/)).toBeNull();
  });

  it('does not let a needs_review finding inflate the headline total (stale/guarded amounts excluded)', async () => {
    vi.stubGlobal('fetch', mockFetch({
      enabled: true,
      lastRun: { id: 1, startedAt: 'a', finishedAt: new Date().toISOString(), status: 'succeeded', rulesEvaluated: 1, findingsCount: 2, ceApiCalls: 0, error: null },
      findings: [
        { id: 1, ruleId: 'ebs_unattached', resourceId: 'vol-1', title: 'Unattached EBS vol-1', category: 'storage',
          status: 'active', monthlySavingsUsd: 9.12, evidence: {}, guardHits: [], explanationKo: null, firstSeenAt: 'a', lastSeenAt: 'b' },
        // Stale evidence (guard-flagged) but still carries a real dollar figure from before the
        // sync went stale — this must NOT be added into the $9.12 confident total.
        { id: 2, ruleId: 'ebs_unattached', resourceId: 'vol-2', title: 'Unattached EBS vol-2', category: 'storage',
          status: 'needs_review', monthlySavingsUsd: 500.00, evidence: {}, guardHits: ['stale_inventory_data'],
          explanationKo: null, firstSeenAt: 'a', lastSeenAt: 'b' },
      ],
    }));
    render(<FinopsBaselineCard />);
    await waitFor(() => screen.getByText('Unattached EBS vol-2'));
    expect(screen.getByTestId('finops-baseline-total').textContent).toContain('9.12');
    expect(screen.getByTestId('finops-baseline-total').textContent).not.toContain('509');
    expect(screen.getByText(/stale_inventory_data/)).toBeTruthy();
  });

  it('hides the headline total entirely when every finding is needs_review (nothing confident)', async () => {
    vi.stubGlobal('fetch', mockFetch({
      enabled: true,
      lastRun: { id: 1, startedAt: 'a', finishedAt: new Date().toISOString(), status: 'succeeded', rulesEvaluated: 1, findingsCount: 1, ceApiCalls: 0, error: null },
      findings: [
        { id: 1, ruleId: 'ebs_unattached', resourceId: 'vol-1', title: 'Unattached EBS vol-1', category: 'storage',
          status: 'needs_review', monthlySavingsUsd: 42.0, evidence: {}, guardHits: ['stale_inventory_data'],
          explanationKo: null, firstSeenAt: 'a', lastSeenAt: 'b' },
      ],
    }));
    render(<FinopsBaselineCard />);
    await waitFor(() => screen.getByText('Unattached EBS vol-1'));
    expect(screen.queryByTestId('finops-baseline-total')).toBeNull();
  });

  it('shows "산출 불가" instead of a fabricated $0.00 when every active finding has unknown savings', async () => {
    vi.stubGlobal('fetch', mockFetch({
      enabled: true,
      lastRun: { id: 1, startedAt: 'a', finishedAt: new Date().toISOString(), status: 'succeeded', rulesEvaluated: 1, findingsCount: 1, ceApiCalls: 0, error: null },
      findings: [
        // 'active' (confident) but with no known amount — reduce()'s `?? 0` would otherwise sum
        // this to a misleading $0.00 "confirmed zero savings" headline.
        { id: 1, ruleId: 'ec2_rightsizing', resourceId: 'arn:x', title: 'EC2 rightsizing arn:x', category: 'compute',
          status: 'active', monthlySavingsUsd: null, evidence: {}, guardHits: [], explanationKo: null,
          firstSeenAt: 'a', lastSeenAt: 'b' },
      ],
    }));
    render(<FinopsBaselineCard />);
    await waitFor(() => screen.getByText('EC2 rightsizing arn:x'));
    const total = screen.getByTestId('finops-baseline-total');
    expect(total.textContent).not.toContain('$0.00');
    expect(total.textContent).toContain('금액 산출 불가');
  });

  it('labels each finding with account/region in the fleet-wide (unscoped) view', async () => {
    // A review round caught the card summing cross-account findings into one total with no way
    // to tell they came from different accounts/regions when no account filter is applied.
    vi.stubGlobal('fetch', mockFetch({
      enabled: true, accountFilter: null,
      lastRun: { id: 1, startedAt: 'a', finishedAt: new Date().toISOString(), status: 'succeeded', rulesEvaluated: 1, findingsCount: 1, ceApiCalls: 0, error: null },
      findings: [
        { id: 1, ruleId: 'ebs_unattached', accountId: '222222222222', region: 'us-east-1', resourceId: 'vol-1',
          title: 'Unattached EBS vol-1', category: 'storage', status: 'active', monthlySavingsUsd: 9.12,
          evidence: {}, guardHits: [], explanationKo: null, firstSeenAt: 'a', lastSeenAt: 'b' },
      ],
    }));
    render(<FinopsBaselineCard />);
    await waitFor(() => screen.getByText('Unattached EBS vol-1'));
    expect(screen.getByText('222222222222 · us-east-1')).toBeTruthy();
  });

  it('omits the per-finding account/region label when the view is already account-scoped', async () => {
    vi.stubGlobal('fetch', mockFetch({
      enabled: true, accountFilter: 'self',
      lastRun: { id: 1, startedAt: 'a', finishedAt: new Date().toISOString(), status: 'succeeded', rulesEvaluated: 1, findingsCount: 1, ceApiCalls: 0, error: null },
      findings: [
        { id: 1, ruleId: 'ebs_unattached', accountId: 'self', region: 'ap-northeast-2', resourceId: 'vol-1',
          title: 'Unattached EBS vol-1', category: 'storage', status: 'active', monthlySavingsUsd: 9.12,
          evidence: {}, guardHits: [], explanationKo: null, firstSeenAt: 'a', lastSeenAt: 'b' },
      ],
    }));
    render(<FinopsBaselineCard />);
    await waitFor(() => screen.getByText('Unattached EBS vol-1'));
    expect(screen.queryByText(/호스트 계정/)).toBeNull();
  });

  it('sends an explicit account=self on the default view instead of silently going fleet-wide', async () => {
    // A stop-time review caught that the never-touched-the-selector default (active === 'self')
    // omitted the account param entirely, which the route treats as "no filter" — the host's own
    // dashboard was showing every synced account's findings by default. accountParam('self')
    // itself returns '' (the convention other routes use to mean "server defaults to host
    // creds"), so this route must NOT reuse that helper — it needs 'self' sent literally.
    const fetchSpy = mockFetch({ enabled: true, accountFilter: 'self', findings: [], lastRun: null });
    vi.stubGlobal('fetch', fetchSpy);
    render(<FinopsBaselineCard />);
    await waitFor(() => expect(fetchSpy).toHaveBeenCalledWith('/api/finops/findings?account=self'));
  });

  it('passes the active account as a query param when a specific account is selected', async () => {
    setActiveAccount('222222222222');
    const fetchSpy = mockFetch({ enabled: true, accountFilter: '222222222222', findings: [], lastRun: null });
    vi.stubGlobal('fetch', fetchSpy);
    render(<FinopsBaselineCard />);
    // useActiveAccount's own mount effect corrects the initial 'self' state to the value already
    // in localStorage, re-running load() a second time — assert the FINAL call, not the first.
    await waitFor(() => expect(fetchSpy.mock.calls.at(-1)?.[0]).toBe('/api/finops/findings?account=222222222222'));
    setActiveAccount('self');
  });

  it('omits the account query param entirely when "전체 계정" is selected', async () => {
    setActiveAccount(ALL_ACCOUNTS);
    const fetchSpy = mockFetch({ enabled: true, accountFilter: null, findings: [], lastRun: null });
    vi.stubGlobal('fetch', fetchSpy);
    render(<FinopsBaselineCard />);
    // Same mount-effect correction as above: the initial render fetches with the default 'self'
    // state before useActiveAccount's effect corrects it to ALL_ACCOUNTS — assert the final call.
    await waitFor(() => expect(fetchSpy.mock.calls.at(-1)?.[0]).toBe('/api/finops/findings'));
    setActiveAccount('self');
  });

  it('drops a stale response that resolves after the account has already changed', async () => {
    // A stop-time review caught a race: nothing stopped an older, slower request from resolving
    // after a newer one and overwriting the just-selected account's data with a previous
    // account's findings. Simulate the 'self' fetch hanging while the user switches to another
    // account, whose (faster) response lands first — then resolve the stale 'self' response and
    // confirm it never displaces the current view.
    let resolveSelf!: (v: { ok: boolean; status: number; json: () => Promise<unknown> }) => void;
    const selfPromise = new Promise<{ ok: boolean; status: number; json: () => Promise<unknown> }>((res) => {
      resolveSelf = res;
    });
    const fetchSpy = vi.fn(async (url: string) => {
      if (url.includes('account=self')) return selfPromise;
      return {
        ok: true, status: 200,
        json: async () => ({
          enabled: true, accountFilter: '222222222222', lastRun: null,
          findings: [{ id: 2, ruleId: 'ebs_unattached', accountId: '222222222222', region: 'us-east-1',
            resourceId: 'vol-2', title: 'Second account finding', category: 'storage', status: 'active',
            monthlySavingsUsd: 5, evidence: {}, guardHits: [], explanationKo: null, firstSeenAt: 'a', lastSeenAt: 'b' }],
        }),
      };
    });
    vi.stubGlobal('fetch', fetchSpy);
    render(<FinopsBaselineCard />);
    await waitFor(() => expect(fetchSpy).toHaveBeenCalled()); // the initial (hanging) 'self' fetch fired
    setActiveAccount('222222222222');
    await waitFor(() => screen.getByText('Second account finding'));

    // Now let the stale 'self' response land, well after the current view has moved on.
    resolveSelf({
      ok: true, status: 200,
      json: async () => ({
        enabled: true, accountFilter: 'self', lastRun: null,
        findings: [{ id: 99, ruleId: 'ebs_unattached', accountId: 'self', region: 'ap-northeast-2',
          resourceId: 'vol-stale', title: 'Stale self finding', category: 'storage', status: 'active',
          monthlySavingsUsd: 1, evidence: {}, guardHits: [], explanationKo: null, firstSeenAt: 'a', lastSeenAt: 'b' }],
      }),
    });
    await new Promise((r) => setTimeout(r, 10)); // flush microtasks the stale promise resolution queues
    expect(screen.queryByText('Stale self finding')).toBeNull();
    expect(screen.getByText('Second account finding')).toBeTruthy();
    setActiveAccount('self');
  });

  it('shows a loading state instead of the previous account\'s data during a switch', async () => {
    // A SEPARATE bug from the stale-response race above: dropping a late response stops it from
    // being wrongly applied, but does nothing about the PREVIOUS account's already-rendered data
    // staying on screen — unlabeled as stale — for the entire window between the switch and the
    // new fetch resolving. A user selecting account B must never keep seeing account A's findings
    // displayed as if they belonged to B.
    const selfBody = {
      enabled: true, accountFilter: 'self', lastRun: null,
      findings: [{ id: 1, ruleId: 'ebs_unattached', accountId: 'self', region: 'ap-northeast-2',
        resourceId: 'vol-1', title: 'First account finding', category: 'storage', status: 'active',
        monthlySavingsUsd: 9.12, evidence: {}, guardHits: [], explanationKo: null, firstSeenAt: 'a', lastSeenAt: 'b' }],
    };
    let resolveOther!: (v: { ok: boolean; status: number; json: () => Promise<unknown> }) => void;
    const otherPromise = new Promise<{ ok: boolean; status: number; json: () => Promise<unknown> }>((res) => {
      resolveOther = res;
    });
    const fetchSpy = vi.fn(async (url: string) => {
      if (url.includes('account=self')) return { ok: true, status: 200, json: async () => selfBody };
      return otherPromise; // the new account's fetch hangs
    });
    vi.stubGlobal('fetch', fetchSpy);
    render(<FinopsBaselineCard />);
    await waitFor(() => screen.getByText('First account finding'));

    setActiveAccount('222222222222');
    // Immediately after the switch — before the new account's (hanging) fetch resolves — the
    // previous account's finding must be gone, not still displayed as account 222222222222's data.
    await waitFor(() => expect(screen.queryByText('First account finding')).toBeNull());
    expect(screen.getByText('로딩 중…')).toBeTruthy();

    resolveOther({
      ok: true, status: 200,
      json: async () => ({
        enabled: true, accountFilter: '222222222222', lastRun: null,
        findings: [{ id: 2, ruleId: 'ebs_unattached', accountId: '222222222222', region: 'us-east-1',
          resourceId: 'vol-2', title: 'Second account finding', category: 'storage', status: 'active',
          monthlySavingsUsd: 5, evidence: {}, guardHits: [], explanationKo: null, firstSeenAt: 'a', lastSeenAt: 'b' }],
      }),
    });
    await waitFor(() => screen.getByText('Second account finding'));
    setActiveAccount('self');
  });

  it('warns that EC2/RDS rightsizing was never evaluated for a non-host account view', async () => {
    // ec2_rightsizing/rds_rightsizing only ever query the host account's own Compute Optimizer
    // region — a review round caught that filtering to a different account silently showed "no
    // waste found" as if rightsizing had been checked there too. accountFilter !== 'self' (the
    // evaluated scope from coRightsizingScope) must surface the gap explicitly.
    setActiveAccount('222222222222');
    vi.stubGlobal('fetch', mockFetch({
      enabled: true, accountFilter: '222222222222', findings: [],
      lastRun: { id: 1, startedAt: 'a', finishedAt: 'b', status: 'succeeded', rulesEvaluated: 1, findingsCount: 0, ceApiCalls: 0, error: null },
      coRightsizingScope: { accountId: 'self', region: 'ap-northeast-2' },
    }));
    render(<FinopsBaselineCard />);
    await waitFor(() => screen.getByTestId('finops-baseline-rightsizing-unevaluated'));
    setActiveAccount('self');
  });

  it('discloses the single-region rightsizing coverage even on the host-account view', async () => {
    // A stop-time review caught the remaining half of the same false-clean path: the cross-account
    // warning covered a different ACCOUNT, but the host-account view still never disclosed that
    // only ONE region was queried — a host account with resources elsewhere read as fully clean.
    setActiveAccount('self');
    vi.stubGlobal('fetch', mockFetch({
      enabled: true, accountFilter: 'self', findings: [],
      lastRun: { id: 1, startedAt: 'a', finishedAt: 'b', status: 'succeeded', rulesEvaluated: 1, findingsCount: 0, ceApiCalls: 0, error: null },
      coRightsizingScope: { accountId: 'self', region: 'ap-northeast-2' },
    }));
    render(<FinopsBaselineCard />);
    await waitFor(() => screen.getByTestId('finops-baseline-rightsizing-scope'));
    expect(screen.getByText(/ap-northeast-2/)).toBeTruthy();
    // The stronger cross-account variant must NOT also fire for the evaluated account.
    expect(screen.queryByTestId('finops-baseline-rightsizing-unevaluated')).toBeNull();
  });

  it('omits the rightsizing-unevaluated warning in the fleet-wide (unscoped) view', async () => {
    setActiveAccount(ALL_ACCOUNTS);
    vi.stubGlobal('fetch', mockFetch({
      enabled: true, accountFilter: null, findings: [],
      lastRun: { id: 1, startedAt: 'a', finishedAt: 'b', status: 'succeeded', rulesEvaluated: 1, findingsCount: 0, ceApiCalls: 0, error: null },
      coRightsizingScope: { accountId: 'self', region: 'ap-northeast-2' },
    }));
    render(<FinopsBaselineCard />);
    await waitFor(() => screen.getByTestId('finops-baseline-empty'));
    expect(screen.queryByTestId('finops-baseline-rightsizing-unevaluated')).toBeNull();
    setActiveAccount('self');
  });
});
