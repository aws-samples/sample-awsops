// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { render, screen, fireEvent, cleanup, waitFor } from '@testing-library/react';
import NetworkPathsPage from './page';

class ResizeObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
}

afterEach(cleanup);
beforeEach(() => {
  vi.unstubAllGlobals();
  vi.stubGlobal('ResizeObserver', ResizeObserverStub);
});

function mockFetches(opts: {
  gateOff?: boolean;
  checks?: unknown[];
  runs?: unknown[];
  runDetail?: unknown;
  onCreatePost?: (body: unknown) => void;
  onPatch?: (id: string, body: unknown) => void;
  isAdmin?: boolean;
} = {}) {
  const calls: { url: string; init?: RequestInit }[] = [];
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    const u = String(url);
    calls.push({ url: u, init });
    if (u.includes('/api/me')) return { ok: true, status: 200, json: async () => ({ sub: 'u-1', groups: [], isAdmin: !!opts.isAdmin }) } as Response;
    if (u === '/api/network-paths' || u.endsWith('/api/network-paths')) {
      if (opts.gateOff) return { ok: false, status: 503, json: async () => ({ status: 'unconfigured' }) } as Response;
      if (init?.method === 'POST') {
        const body = init.body ? JSON.parse(String(init.body)) : null;
        opts.onCreatePost?.(body);
        return { ok: true, status: 201, json: async () => ({ check: { id: 'chk-new', name: body?.name ?? 'new', source_account_id: body?.source_account_id, definition: body?.definition, created_by_sub: 'u-1' } }) } as Response;
      }
      return { ok: true, status: 200, json: async () => ({ checks: opts.checks ?? [] }) } as Response;
    }
    const patchMatch = u.match(/\/api\/network-paths\/([^/]+)$/);
    if (patchMatch && init?.method === 'PATCH') {
      const id = patchMatch[1];
      const body = init.body ? JSON.parse(String(init.body)) : null;
      opts.onPatch?.(id, body);
      return { ok: true, status: 200, json: async () => ({ check: { id, name: body?.name, source_account_id: '123456789012', definition: body?.definition, created_by_sub: 'u-1' } }) } as Response;
    }
    if (/\/api\/network-paths\/[^/]+\/runs$/.test(u)) {
      if (init?.method === 'POST') return { ok: true, status: 202, json: async () => ({ run: { id: 'run-1', status: 'queued' } }) } as Response;
      return { ok: true, status: 200, json: async () => ({ runs: opts.runs ?? [] }) } as Response;
    }
    if (/\/api\/network-path-runs\//.test(u)) {
      return { ok: true, status: 200, json: async () => ({ run: opts.runDetail ?? null }) } as Response;
    }
    return { ok: true, status: 200, json: async () => ({}) } as Response;
  }));
  return calls;
}

describe('/network-paths', () => {
  it('shows an honest empty state when the feature flag is off', async () => {
    mockFetches({ gateOff: true });
    render(<NetworkPathsPage />);
    await waitFor(() => expect(screen.getByText(/비활성화/)).toBeTruthy());
  });

  it('shows an empty state when enabled but no checks exist', async () => {
    mockFetches({ checks: [] });
    render(<NetworkPathsPage />);
    await waitFor(() => expect(screen.getByText(/저장된 경로 점검이 없습니다/)).toBeTruthy());
  });

  it('renders a saved check list and, on selection, its run history', async () => {
    mockFetches({
      checks: [{ id: 'chk-1', name: 'web -> db', source_account_id: '123456789012', created_by_sub: 'u-1', definition: {}, created_at: '', updated_at: '', deleted_at: null }],
      runs: [{ id: 'run-1', check_id: 'chk-1', requested_by_sub: 'u-1', status: 'succeeded', overall_status: 'allowed', created_at: '2026-08-19', finished_at: '2026-08-19' }],
    });
    render(<NetworkPathsPage />);
    await waitFor(() => expect(screen.getByText('web -> db')).toBeTruthy());
    fireEvent.click(screen.getByText('web -> db'));
    await waitFor(() => expect(screen.getByText(/succeeded/)).toBeTruthy());
  });

  it('renders the checklist with not_run shown distinctly from unknown, and never wires a run button to the validation bundle', async () => {
    const runDetail = {
      id: 'run-1', check_id: 'chk-1', requested_by_sub: 'u-1', definition_snapshot: {},
      status: 'succeeded', phase: 'conclude', overall_status: 'blocked',
      validation_bundle: { commands: ['aws ec2 describe-security-groups --group-ids sg-1'] },
      worker_job_id: 'job-1', created_at: '2026-08-19', finished_at: '2026-08-19',
      candidates: [{ candidate_id: 'c1', candidate_kind: 'primary', status: 'blocked', first_blocker: 'security_group' }],
      steps: [
        { candidate_id: 'c1', account_id: 'a', region: 'r', ordinal: 0, layer: 'security_group', status: 'blocked', resource: 'sg-1', summary: 'denied', evidence: null, observed_at: null },
        { candidate_id: 'c1', account_id: 'a', region: 'r', ordinal: 1, layer: 'nacl', status: 'not_run', resource: null, summary: '', evidence: null, observed_at: null },
      ],
    };
    mockFetches({
      checks: [{ id: 'chk-1', name: 'web -> db', source_account_id: '123456789012', created_by_sub: 'u-1', definition: {}, created_at: '', updated_at: '', deleted_at: null }],
      runs: [{ id: 'run-1', check_id: 'chk-1', requested_by_sub: 'u-1', status: 'succeeded', overall_status: 'blocked', created_at: '2026-08-19', finished_at: '2026-08-19' }],
      runDetail,
    });
    render(<NetworkPathsPage />);
    await waitFor(() => expect(screen.getByText('web -> db')).toBeTruthy());
    fireEvent.click(screen.getByText('web -> db'));
    await waitFor(() => expect(screen.getByText(/succeeded/)).toBeTruthy());
    fireEvent.click(screen.getByText(/succeeded/));

    await waitFor(() => expect(screen.getByText('실행 안 됨')).toBeTruthy());
    expect(screen.queryByText('알 수 없음')).toBeNull();

    // Validation bundle renders as read-only text, never behind a run/execute control.
    await waitFor(() => expect(screen.getByText(/aws ec2 describe-security-groups/)).toBeTruthy());
    expect(screen.queryByRole('button', { name: /실행 안 됨|명령|run this/i })).toBeNull();
    const allButtons = screen.getAllByRole('button').map((b) => b.textContent ?? '');
    expect(allButtons.some((t) => /명령을 실행/.test(t))).toBe(false);
  });

  it('structured create form: EKS Pod fields render, and switching to EKS Node swaps the pod fields for a node-name field', async () => {
    mockFetches({ checks: [] });
    render(<NetworkPathsPage />);
    fireEvent.click(screen.getByText('새 점검'));
    await waitFor(() => expect(screen.getByPlaceholderText('네임스페이스')).toBeTruthy());
    expect(screen.getByPlaceholderText('Pod 이름')).toBeTruthy();
    expect(screen.queryByPlaceholderText('노드 이름')).toBeNull();

    // CI-review MAJOR fix (round 17, item 1): source.kind is the worker's OWN vocabulary
    // ('pod'/'node'), not the old UI-invented 'eks_pod'/'eks_node'.
    fireEvent.change(screen.getByLabelText('소스 종류'), { target: { value: 'node' } });
    expect(screen.queryByPlaceholderText('네임스페이스')).toBeNull();
    expect(screen.queryByPlaceholderText('Pod 이름')).toBeNull();
    expect(screen.getByPlaceholderText('노드 이름')).toBeTruthy();
  });

  it('structured create form: destination type toggles its fields (AWS resource / internet / on-prem)', async () => {
    mockFetches({ checks: [] });
    render(<NetworkPathsPage />);
    fireEvent.click(screen.getByText('새 점검'));
    await waitFor(() => expect(screen.getByPlaceholderText('목적지 ENI ID (선택, CIDR/IP 중 하나 필요)')).toBeTruthy());

    fireEvent.change(screen.getByLabelText('목적지 종류'), { target: { value: 'internet' } });
    expect(screen.queryByPlaceholderText('목적지 ENI ID (선택, CIDR/IP 중 하나 필요)')).toBeNull();
    expect(screen.getByPlaceholderText('호스트 또는 IP/URL')).toBeTruthy();
    // request path field only appears for internet + TCP.
    expect(screen.getByPlaceholderText('경로 (선택, 예: /health)')).toBeTruthy();

    fireEvent.change(screen.getByLabelText('프로토콜'), { target: { value: 'icmp' } });
    expect(screen.queryByPlaceholderText('경로 (선택, 예: /health)')).toBeNull();
    expect(screen.queryByPlaceholderText('포트')).toBeNull();

    // CI-review MAJOR fix (round 17, item 1): destination.kind is the worker's OWN vocabulary
    // ('onprem'), not the old UI-invented 'on_prem'.
    fireEvent.change(screen.getByLabelText('목적지 종류'), { target: { value: 'onprem' } });
    expect(screen.queryByPlaceholderText('호스트 또는 IP/URL')).toBeNull();
    expect(screen.getByPlaceholderText('온프레미스 IP 또는 URL')).toBeTruthy();
  });

  it('submitting the structured create form POSTs a definition resolve_identities() can actually consume', async () => {
    let posted: any = null;
    mockFetches({ checks: [], onCreatePost: (b) => { posted = b; } });
    render(<NetworkPathsPage />);
    fireEvent.click(screen.getByText('새 점검'));
    await waitFor(() => expect(screen.getByPlaceholderText('이름')).toBeTruthy());

    fireEvent.change(screen.getByPlaceholderText('이름'), { target: { value: 'web to db' } });
    fireEvent.change(screen.getByPlaceholderText('소스 계정 ID (12자리)'), { target: { value: '123456789012' } });
    fireEvent.change(screen.getByPlaceholderText('소스 리전 (예: ap-northeast-2)'), { target: { value: 'ap-northeast-2' } });
    fireEvent.change(screen.getByPlaceholderText('클러스터'), { target: { value: 'prod-cluster' } });
    fireEvent.change(screen.getByPlaceholderText('네임스페이스'), { target: { value: 'web' } });
    fireEvent.change(screen.getByPlaceholderText('Pod 이름'), { target: { value: 'web-abc123' } });
    fireEvent.change(screen.getByPlaceholderText('소스 ENI ID (eni_id — 선택, subnet_id 중 하나 필요)'), { target: { value: 'eni-source-1' } });
    fireEvent.change(screen.getByLabelText('목적지 종류'), { target: { value: 'aws_resource' } });
    fireEvent.change(screen.getByPlaceholderText('목적지 ENI ID (선택, CIDR/IP 중 하나 필요)'), { target: { value: 'eni-dest-1' } });
    fireEvent.change(screen.getByLabelText('프로토콜'), { target: { value: 'tcp' } });
    fireEvent.change(screen.getByPlaceholderText('포트'), { target: { value: '5432' } });

    fireEvent.click(screen.getByText('생성'));
    await waitFor(() => expect(posted).not.toBeNull());

    // Exact key/value shape network_path.py's resolve_identities() requires: source.kind in
    // ('pod','node'); source.account_id/region present; source has eni_id or subnet_id;
    // destination.kind in ('aws_resource','internet','onprem'); an aws_resource destination has
    // eni_id/cidr/ip.
    expect(posted).toEqual({
      name: 'web to db',
      source_account_id: '123456789012',
      definition: {
        source: {
          kind: 'pod', account_id: '123456789012', region: 'ap-northeast-2',
          cluster: 'prod-cluster', namespace: 'web', pod_name: 'web-abc123', eni_id: 'eni-source-1',
        },
        destination: { kind: 'aws_resource', eni_id: 'eni-dest-1' },
        request: { protocol: 'tcp', port: 5432 },
      },
    });
  });

  it('edit action (creator-or-admin only) pre-fills the structured form and PATCHes /api/network-paths/[id], preserving fields the form does not directly expose', async () => {
    const existingCheck = {
      id: 'chk-1',
      name: 'web -> db',
      source_account_id: '123456789012',
      created_by_sub: 'u-1',
      created_at: '', updated_at: '', deleted_at: null,
      definition: {
        source: {
          kind: 'pod', account_id: '123456789012', region: 'ap-northeast-2',
          cluster: 'prod-cluster', namespace: 'web', pod_name: 'web-abc123', eni_id: 'eni-source-1',
        },
        destination: { kind: 'internet', host: 'example.com', path: '/health' },
        request: { protocol: 'tcp', port: 443, path: '/health' },
      },
    };
    let patchedId = '';
    let patchedBody: any = null;
    mockFetches({
      checks: [existingCheck],
      onPatch: (id, body) => { patchedId = id; patchedBody = body; },
    });
    render(<NetworkPathsPage />);
    await waitFor(() => expect(screen.getByText('web -> db')).toBeTruthy());

    fireEvent.click(screen.getByTitle('수정'));
    await waitFor(() => expect(screen.getByDisplayValue('web -> db')).toBeTruthy());
    // pre-filled from the saved definition, INCLUDING account_id/region/eni_id -- CI-review MAJOR
    // fix (round 17, item 1, second half): these used to be silently dropped by
    // formStateFromCheck(), so re-saving after an edit corrupted a currently-valid check.
    expect(screen.getByDisplayValue('prod-cluster')).toBeTruthy();
    expect(screen.getByDisplayValue('web')).toBeTruthy();
    expect(screen.getByDisplayValue('web-abc123')).toBeTruthy();
    expect(screen.getByDisplayValue('ap-northeast-2')).toBeTruthy();
    expect(screen.getByDisplayValue('eni-source-1')).toBeTruthy();
    expect(screen.getByDisplayValue('example.com')).toBeTruthy();
    expect(screen.getByDisplayValue('443')).toBeTruthy();

    fireEvent.change(screen.getByPlaceholderText('이름'), { target: { value: 'web -> db (renamed)' } });
    fireEvent.click(screen.getByText('저장'));

    await waitFor(() => expect(patchedId).toBe('chk-1'));
    expect(patchedBody.name).toBe('web -> db (renamed)');
    // The full round trip, including account_id/region/eni_id, survives an edit+save untouched.
    expect(patchedBody.definition).toEqual({
      source: {
        kind: 'pod', account_id: '123456789012', region: 'ap-northeast-2',
        cluster: 'prod-cluster', namespace: 'web', pod_name: 'web-abc123', eni_id: 'eni-source-1',
      },
      destination: { kind: 'internet', host: 'example.com', path: '/health' },
      request: { protocol: 'tcp', port: 443, path: '/health' },
    });
  });

  it('does not show an edit button for a check the current user neither created nor administers', async () => {
    mockFetches({
      checks: [{ id: 'chk-1', name: 'someone else\'s check', source_account_id: '123456789012', created_by_sub: 'u-2', definition: {}, created_at: '', updated_at: '', deleted_at: null }],
      isAdmin: false,
    });
    render(<NetworkPathsPage />);
    await waitFor(() => expect(screen.getByText("someone else's check")).toBeTruthy());
    expect(screen.queryByTitle('수정')).toBeNull();
  });
});
