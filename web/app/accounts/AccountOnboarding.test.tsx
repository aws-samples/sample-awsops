// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import AccountOnboarding from './AccountOnboarding';
import type { AccountConnectionDiagnostic } from '@/lib/account-connection-diagnostics';
import { LanguageProvider } from '@/components/shell/LanguageProvider';

const config = {
  hostAccountId: '111111111111', hostTaskRoleArn: 'arn:aws:iam::111111111111:role/awsops-dev-task',
  region: 'ap-northeast-2', registrationEnabled: true,
};
const onRegistered = vi.fn().mockResolvedValue(undefined);
const diagnostic: AccountConnectionDiagnostic = {
  checkId: 'b59c378e-5818-4ba9-9509-ec651a635a19',
  checkedAt: '2026-09-15T00:00:00.000Z',
  accountId: '222222222222', region: 'ap-northeast-2',
  roleArn: 'arn:aws:iam::222222222222:role/AWSopsReadOnlyRole',
  hostTaskRoleArn: config.hostTaskRoleArn, externalIdProvided: true,
  stage: 'get_caller_identity', code: 'verified',
  awsRequestId: '2e98a5c2-3379-40fa-8a87-da92218b5b21',
  durationMs: 120, verified: true, registrationEnabled: false,
};

beforeEach(() => {
  sessionStorage.clear();
  onRegistered.mockReset().mockResolvedValue(undefined);
  vi.stubGlobal('fetch', vi.fn(async (url: string) => new Response(JSON.stringify(
    url === '/api/accounts/onboarding' ? config : { ok: true, status: 'verified' },
  ))));
});
afterEach(() => { cleanup(); localStorage.clear(); vi.useRealTimers(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

async function fillAccount() {
  await screen.findByText('12자리 Account ID를 입력하면 계정에 맞는 AWS CLI 명령어가 표시됩니다.');
  await waitFor(() => expect(screen.getByLabelText('Account ID').matches(':disabled')).toBe(false));
  fireEvent.change(screen.getByLabelText('Account ID'), { target: { value: '222222222222' } });
  fireEvent.change(screen.getByLabelText('계정 별칭'), { target: { value: 'Production' } });
}

describe('account onboarding flow', () => {
  it('shows personalized commands after account entry and registers with the same ExternalId', async () => {
    render(<AccountOnboarding onRegistered={onRegistered} />);
    await fillAccount();
    const externalId = (screen.getByLabelText('ExternalId') as HTMLInputElement).value;
    expect(screen.getByText(config.hostTaskRoleArn)).toBeTruthy();
    expect(screen.getByText(/set -euo pipefail/).textContent).toContain(`"ParameterValue": "${externalId}"`);
    fireEvent.click(screen.getByRole('button', { name: '연결 확인 및 등록' }));
    await screen.findByText('등록·검증 완료');
    expect(fetch).toHaveBeenCalledWith('/api/accounts', expect.objectContaining({
      method: 'POST',
      body: JSON.stringify({ accountId: '222222222222', alias: 'Production', region: 'ap-northeast-2', externalId, firstParty: false }),
    }));
    expect(onRegistered).toHaveBeenCalledOnce();
    expect((screen.getByLabelText('ExternalId') as HTMLInputElement).value).toBe(externalId);
  });
  it('regenerates commands on edits and removes them for invalid or host account IDs', async () => {
    render(<AccountOnboarding onRegistered={onRegistered} />);
    await fillAccount();
    fireEvent.change(screen.getByLabelText('Account ID'), { target: { value: '333333333333' } });
    expect(screen.getByText(/set -euo pipefail/).textContent).toContain("target_account='333333333333'");
    fireEvent.change(screen.getByLabelText('Account ID'), { target: { value: '123' } });
    expect(screen.queryByRole('button', { name: '스크립트 다운로드 (.sh)' })).toBeNull();
    expect((screen.getByRole('button', { name: '연결 확인 및 등록' }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(screen.getByLabelText('Account ID'), { target: { value: config.hostAccountId } });
    expect(screen.getByText('호스트 계정은 이미 연결되어 있습니다.')).toBeTruthy();
  });
  it('makes host-only registration restrictions visible before any attempt', async () => {
    vi.mocked(fetch).mockResolvedValue(new Response(JSON.stringify({ ...config, registrationEnabled: false })));
    render(<AccountOnboarding onRegistered={onRegistered} />);
    await fillAccount();
    expect(screen.getByText('현재 환경은 호스트 계정만 수집합니다.')).toBeTruthy();
    expect(screen.getByRole('button', { name: '스크립트 다운로드 (.sh)' })).toBeTruthy();
    const register = screen.getByRole('button', { name: '연결 확인 및 등록' });
    expect((register as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(register);
    expect(fetch).toHaveBeenCalledTimes(1);
  });
  it('preserves inputs after failed verification and permits retry', async () => {
    render(<AccountOnboarding onRegistered={onRegistered} />);
    await fillAccount();
    vi.mocked(fetch).mockResolvedValueOnce(new Response(JSON.stringify({ message: 'PRIVATE_REGISTER_FAILURE' }), { status: 400 }));
    fireEvent.click(screen.getByRole('button', { name: '연결 확인 및 등록' }));
    await screen.findByText('등록하지 못했습니다. 연결 확인으로 진단 결과를 확인하세요.');
    expect(document.body.textContent).not.toContain('PRIVATE_REGISTER_FAILURE');
    expect(screen.getByRole('button', { name: '연결 원인 확인' })).toBeTruthy();
    expect(onRegistered).not.toHaveBeenCalled();
    expect((screen.getByLabelText('Account ID') as HTMLInputElement).value).toBe('222222222222');
    fireEvent.click(screen.getByRole('button', { name: '연결 확인 및 등록' }));
    await screen.findByText('등록·검증 완료');
  });
  it('shows configuration errors and retries without leaving a usable stale script', async () => {
    vi.mocked(fetch).mockRejectedValueOnce(new Error('offline'));
    render(<AccountOnboarding onRegistered={onRegistered} />);
    fireEvent.click(await screen.findByRole('button', { name: '다시 시도' }));
    await fillAccount();
    expect(screen.getByRole('button', { name: '스크립트 다운로드 (.sh)' })).toBeTruthy();
  });
  it('keeps registration success when only the account-list refresh fails', async () => {
    onRegistered.mockRejectedValueOnce(new Error('refresh offline'));
    render(<AccountOnboarding onRegistered={onRegistered} />);
    await fillAccount();
    fireEvent.click(screen.getByRole('button', { name: '연결 확인 및 등록' }));
    await screen.findByText('계정 등록·검증은 완료됐지만 목록을 새로 불러오지 못했습니다. 페이지를 새로고침하세요.');
    expect((screen.getByRole('button', { name: '연결 확인 및 등록' }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.queryByRole('button', { name: '스크립트 다운로드 (.sh)' })).toBeNull();
    expect(screen.queryByRole('alert')).toBeNull();
    expect(screen.queryByText('역할 생성 완료 여부, 신뢰할 호스트 역할 ARN, ExternalId 일치를 확인하세요. IAM 반영에 시간이 걸리면 잠시 후 다시 확인하세요.')).toBeNull();
  });
  it('preserves a registered ExternalId and prevents role recreation', async () => {
    render(<AccountOnboarding onRegistered={onRegistered} accounts={[{ accountId: '222222222222', externalId: 'stored-external-id' }]} />);
    await fillAccount();
    expect((screen.getByLabelText('ExternalId') as HTMLInputElement).value).toBe('stored-external-id');
    expect((screen.getByLabelText('ExternalId') as HTMLInputElement).readOnly).toBe(true);
    expect(screen.queryByRole('button', { name: '스크립트 다운로드 (.sh)' })).toBeNull();
    expect((screen.getByRole('button', { name: '연결 확인 및 등록' }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByText('이미 등록된 계정입니다. 저장된 ExternalId를 유지합니다. 아래 등록된 계정 목록에서 테스트를 실행하세요.')).toBeTruthy();
  });
  it('gives a different new account its own ExternalId', async () => {
    render(<AccountOnboarding onRegistered={onRegistered} />);
    await fillAccount();
    const original = (screen.getByLabelText('ExternalId') as HTMLInputElement).value;
    fireEvent.change(screen.getByLabelText('Account ID'), { target: { value: '333333333333' } });
    expect((screen.getByLabelText('ExternalId') as HTMLInputElement).value).not.toBe(original);
  });
  it('restores the same ExternalId after correcting an ID or switching accounts', async () => {
    render(<AccountOnboarding onRegistered={onRegistered} />);
    await fillAccount();
    const original = (screen.getByLabelText('ExternalId') as HTMLInputElement).value;
    fireEvent.change(screen.getByLabelText('Account ID'), { target: { value: '22222222222' } });
    fireEvent.change(screen.getByLabelText('Account ID'), { target: { value: '222222222222' } });
    expect((screen.getByLabelText('ExternalId') as HTMLInputElement).value).toBe(original);
    fireEvent.change(screen.getByLabelText('Account ID'), { target: { value: '333333333333' } });
    fireEvent.change(screen.getByLabelText('Account ID'), { target: { value: '222222222222' } });
    expect((screen.getByLabelText('ExternalId') as HTMLInputElement).value).toBe(original);
    expect(screen.getByText(/set -euo pipefail/).textContent).toContain(`"ParameterValue": "${original}"`);
  });
  it('requires fresh first-party consent after switching accounts, retaining the ExternalId', async () => {
    render(<AccountOnboarding onRegistered={onRegistered} />);
    await fillAccount();
    const original = (screen.getByLabelText('ExternalId') as HTMLInputElement).value;
    fireEvent.click(screen.getByRole('checkbox'));
    fireEvent.change(screen.getByLabelText('Account ID'), { target: { value: '22222222222' } });
    fireEvent.change(screen.getByLabelText('Account ID'), { target: { value: '222222222222' } });
    expect((screen.getByRole('checkbox') as HTMLInputElement).checked).toBe(false);
    fireEvent.change(screen.getByLabelText('Account ID'), { target: { value: '333333333333' } });
    expect((screen.getByRole('checkbox') as HTMLInputElement).checked).toBe(false);
    fireEvent.change(screen.getByLabelText('Account ID'), { target: { value: '222222222222' } });
    expect((screen.getByRole('checkbox') as HTMLInputElement).checked).toBe(false);
    expect((screen.getByLabelText('ExternalId') as HTMLInputElement).value).toBe(original);
    expect(screen.getByText(/set -euo pipefail/).textContent).toContain(`"ParameterValue": "${original}"`);
  });
  it.each([false, true])('restores only the ExternalId after remount (previous firstParty=%s)', async (firstParty) => {
    const first = render(<AccountOnboarding onRegistered={onRegistered} />);
    await fillAccount();
    fireEvent.change(screen.getByLabelText('ExternalId'), { target: { value: 'saved-external-id' } });
    if (firstParty) fireEvent.click(screen.getByRole('checkbox'));
    first.unmount();
    render(<AccountOnboarding onRegistered={onRegistered} />);
    await fillAccount();
    expect((screen.getByLabelText('ExternalId') as HTMLInputElement).value).toBe('saved-external-id');
    expect((screen.getByRole('checkbox') as HTMLInputElement).checked).toBe(false);
  });
  it('restores the downloaded ExternalId after checking and unchecking omission', async () => {
    render(<AccountOnboarding onRegistered={onRegistered} />);
    await fillAccount();
    const original = (screen.getByLabelText('ExternalId') as HTMLInputElement).value;
    fireEvent.click(screen.getByRole('checkbox'));
    expect(screen.getByText(/set -euo pipefail/).textContent).not.toContain('"ParameterKey": "ExternalId"');
    fireEvent.click(screen.getByRole('checkbox'));
    expect((screen.getByLabelText('ExternalId') as HTMLInputElement).value).toBe(original);
    expect(screen.getByText(/set -euo pipefail/).textContent).toContain(`"ParameterValue": "${original}"`);
  });
  it('submits omission only from the visible current-account consent', async () => {
    render(<AccountOnboarding onRegistered={onRegistered} />);
    await fillAccount();
    expect(screen.getByRole('checkbox').closest('details')).toBeNull();
    fireEvent.click(screen.getByRole('checkbox'));
    fireEvent.click(screen.getByRole('button', { name: '연결 확인 및 등록' }));
    await screen.findByText('등록·검증 완료');
    const request = vi.mocked(fetch).mock.calls.find(([url]) => url === '/api/accounts');
    expect(JSON.parse(request![1]!.body as string)).toEqual(expect.objectContaining({
      externalId: '', firstParty: true,
    }));
  });
  it('does not inherit omission consent from a deleted registered account', async () => {
    const view = render(<AccountOnboarding onRegistered={onRegistered}
      accounts={[{ accountId: '222222222222', externalId: null }]} />);
    await fillAccount();
    view.rerender(<AccountOnboarding onRegistered={onRegistered} accounts={[]} />);
    expect((screen.getByRole('checkbox') as HTMLInputElement).checked).toBe(false);
    expect((screen.getByLabelText('ExternalId') as HTMLInputElement).value).not.toBe('');
    fireEvent.click(screen.getByRole('button', { name: '연결 확인 및 등록' }));
    await screen.findByText('등록·검증 완료');
    const request = vi.mocked(fetch).mock.calls.find(([url]) => url === '/api/accounts');
    expect(JSON.parse(request![1]!.body as string)).toEqual(expect.objectContaining({ firstParty: false }));
  });
  it('ignores a legacy persisted first-party consent', async () => {
    sessionStorage.setItem(`awsops.account-onboarding.v1:${config.hostTaskRoleArn}`,
      JSON.stringify({ '222222222222': { externalId: '', firstParty: true } }));
    render(<AccountOnboarding onRegistered={onRegistered} />);
    await fillAccount();
    expect((screen.getByRole('checkbox') as HTMLInputElement).checked).toBe(false);
    expect((screen.getByRole('button', { name: '연결 확인 및 등록' }) as HTMLButtonElement).disabled).toBe(true);
  });
  it('waits for registered-account lookup before allowing setup', async () => {
    const page = render(<AccountOnboarding onRegistered={onRegistered} accounts={null} />);
    await screen.findByText('등록된 계정 정보를 확인하는 중…');
    expect(screen.getByLabelText('Account ID').matches(':disabled')).toBe(true);
    expect(screen.queryByRole('button', { name: '스크립트 다운로드 (.sh)' })).toBeNull();
    expect((screen.getByRole('button', { name: '연결 확인 및 등록' }) as HTMLButtonElement).disabled).toBe(true);
    page.rerender(<AccountOnboarding onRegistered={onRegistered} accounts={[]} />);
    await fillAccount();
    expect(screen.getByRole('button', { name: '스크립트 다운로드 (.sh)' })).toBeTruthy();
  });
});

describe('read-only account connection diagnostics', () => {
  function mockCheck(result = diagnostic, status = 200) {
    vi.mocked(fetch).mockImplementation(async (_url, options) => new Response(JSON.stringify(
      options?.method === 'POST' ? { ok: result.verified, diagnostic: result }
        : { ...config, registrationEnabled: false },
    ), { status: options?.method === 'POST' ? status : 200 }));
  }

  it('checks without an alias in host-only mode and keeps registration explicitly blocked', async () => {
    mockCheck();
    render(<AccountOnboarding onRegistered={onRegistered} />);
    await fillAccount();
    fireEvent.change(screen.getByLabelText('계정 별칭'), { target: { value: '' } });
    const externalId = (screen.getByLabelText('ExternalId') as HTMLInputElement).value;
    const check = screen.getByRole('button', { name: '연결 확인' });
    expect((check as HTMLButtonElement).disabled).toBe(false);
    fireEvent.click(check);
    await screen.findByText('연결은 확인됐지만 호스트 전용 설정으로 계정 등록은 차단되어 있습니다.');
    expect(fetch).toHaveBeenCalledWith('/api/accounts/onboarding', expect.objectContaining({
      method: 'POST', body: JSON.stringify({
        accountId: diagnostic.accountId, region: diagnostic.region, externalId, firstParty: false,
      }),
    }));
    expect(vi.mocked(fetch).mock.calls.some(([url]) => url === '/api/accounts')).toBe(false);
    expect(onRegistered).not.toHaveBeenCalled();
    const register = screen.getByRole('button', { name: '연결 확인 및 등록' });
    expect((register as HTMLButtonElement).disabled).toBe(true);
    expect(document.getElementById(register.getAttribute('aria-describedby')!)?.textContent)
      .toBe('호스트 전용 설정으로 등록이 제한됩니다. 연결 확인은 사용할 수 있습니다.');
    expect(screen.getByText(diagnostic.checkId)).toBeTruthy();
    expect(screen.getByText(diagnostic.checkedAt)).toBeTruthy();
    expect(screen.getByText(diagnostic.awsRequestId!)).toBeTruthy();
    expect(screen.getByText('get_caller_identity')).toBeTruthy();
  });

  it('shows a structured failed check and creates only a bounded section-pinned AI prefill', async () => {
    mockCheck({ ...diagnostic, code: 'access_denied', stage: 'assume_role', verified: false }, 400);
    render(<AccountOnboarding onRegistered={onRegistered} />);
    await fillAccount();
    const externalId = (screen.getByLabelText('ExternalId') as HTMLInputElement).value;
    fireEvent.click(screen.getByRole('button', { name: '연결 확인' }));
    await screen.findByText('access_denied');
    const href = screen.getByRole('link', { name: 'AI 원인 분석 가이드' }).getAttribute('href')!;
    const url = new URL(href, 'https://example.test');
    const query = url.searchParams.get('q')!;
    expect(url.pathname).toBe('/assistant');
    expect(query.startsWith('/security ')).toBe(true);
    expect(query.length).toBeLessThanOrEqual(500);
    expect(query).not.toMatch(/[\r\n]/);
    expect(query).toContain('read-only');
    expect(query).toContain('access_denied');
    expect(query).not.toContain(externalId);
    expect(vi.mocked(fetch).mock.calls).toHaveLength(2);
    expect(vi.mocked(fetch).mock.calls.some(([url]) => String(url).includes('/api/chat'))).toBe(false);
  });

  it('never displays unstructured server errors or treats them as diagnostic metadata', async () => {
    render(<AccountOnboarding onRegistered={onRegistered} />);
    await fillAccount();
    vi.mocked(fetch).mockResolvedValueOnce(new Response(JSON.stringify({
      message: 'PRIVATE_ERROR ExternalId=PRIVATE_EXT password=PRIVATE_PASSWORD',
    }), { status: 503 }));
    fireEvent.click(screen.getByRole('button', { name: '연결 확인' }));
    await screen.findByText('연결 확인 결과를 받지 못했습니다. 로그인 상태와 네트워크를 확인한 뒤 다시 시도하세요.');
    expect(document.body.textContent).not.toContain('PRIVATE_ERROR');
    expect(document.body.textContent).not.toContain('PRIVATE_PASSWORD');
    expect(screen.queryByRole('link', { name: 'AI 원인 분석 가이드' })).toBeNull();
  });

  it('requires ExternalId or fresh first-party consent for a check and clears results on scope edits', async () => {
    mockCheck({ ...diagnostic, externalIdProvided: false });
    render(<AccountOnboarding onRegistered={onRegistered} />);
    await fillAccount();
    fireEvent.change(screen.getByLabelText('ExternalId'), { target: { value: '' } });
    expect((screen.getByRole('button', { name: '연결 확인' }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByRole('checkbox'));
    fireEvent.click(screen.getByRole('button', { name: '연결 확인' }));
    await screen.findByText(diagnostic.checkId);
    const post = vi.mocked(fetch).mock.calls.find(([, options]) => options?.method === 'POST');
    expect(JSON.parse(post![1]!.body as string)).toEqual({
      accountId: diagnostic.accountId, region: diagnostic.region, externalId: '', firstParty: true,
    });
    fireEvent.change(screen.getByLabelText('초기 수집 리전'), { target: { value: 'us-east-1' } });
    expect(screen.queryByText(diagnostic.checkId)).toBeNull();
  });

  it('does not permit checks for host or registered accounts', async () => {
    render(<AccountOnboarding onRegistered={onRegistered} accounts={[{
      accountId: diagnostic.accountId, externalId: 'saved-external-id',
    }]} />);
    await fillAccount();
    expect((screen.getByRole('button', { name: '연결 확인' }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(screen.getByLabelText('Account ID'), { target: { value: config.hostAccountId } });
    expect((screen.getByRole('button', { name: '연결 확인' }) as HTMLButtonElement).disabled).toBe(true);
  });

  it('explains target allowlist restrictions at registration without blocking read-only checks', async () => {
    vi.mocked(fetch).mockResolvedValue(new Response(JSON.stringify({
      ...config, registrationTargetAccountIds: ['333333333333'],
    })));
    render(<AccountOnboarding onRegistered={onRegistered} />);
    await fillAccount();
    const register = screen.getByRole('button', { name: '연결 확인 및 등록' });
    expect((register as HTMLButtonElement).disabled).toBe(true);
    expect(document.getElementById(register.getAttribute('aria-describedby')!)?.textContent)
      .toBe('이 계정은 현재 배포의 등록 허용 목록에 없습니다. 연결 확인은 사용할 수 있습니다.');
    expect((screen.getByRole('button', { name: '연결 확인' }) as HTMLButtonElement).disabled).toBe(false);
    fireEvent.change(screen.getByLabelText('Account ID'), { target: { value: '333333333333' } });
    expect((register as HTMLButtonElement).disabled).toBe(false);
  });

  it('offers an explicit diagnostic after combined failure without automatically repeating STS checks', async () => {
    vi.mocked(fetch).mockImplementation(async (url, options) => new Response(JSON.stringify(
      url === '/api/accounts' ? { message: 'PRIVATE_REGISTER_ERROR' }
        : options?.method === 'POST' ? { ok: false, diagnostic: {
          ...diagnostic, code: 'access_denied', stage: 'assume_role', verified: false, registrationEnabled: true,
        } } : config,
    ), { status: options?.method === 'POST' ? 400 : 200 }));
    render(<AccountOnboarding onRegistered={onRegistered} />);
    await fillAccount();
    fireEvent.click(screen.getByRole('button', { name: '연결 확인 및 등록' }));
    fireEvent.click(await screen.findByRole('button', { name: '연결 원인 확인' }));
    await screen.findByText('access_denied');
    expect(vi.mocked(fetch).mock.calls.filter(([url]) => url === '/api/accounts')).toHaveLength(1);
    expect(vi.mocked(fetch).mock.calls.filter(([url, options]) => url === '/api/accounts/onboarding' && options?.method === 'POST')).toHaveLength(1);
    expect(document.body.textContent).not.toContain('PRIVATE_REGISTER_ERROR');
    expect((screen.getByLabelText('계정 별칭') as HTMLInputElement).value).toBe('Production');
  });

  it('still registers through the server after a successful read-only check', async () => {
    vi.mocked(fetch).mockImplementation(async (url, options) => new Response(JSON.stringify(
      url === '/api/accounts' ? { ok: true }
        : options?.method === 'POST' ? { ok: true, diagnostic: { ...diagnostic, registrationEnabled: true } }
          : { ...config, registrationTargetAccountIds: [diagnostic.accountId] },
    )));
    render(<AccountOnboarding onRegistered={onRegistered} />);
    await fillAccount();
    fireEvent.click(screen.getByRole('button', { name: '연결 확인' }));
    await screen.findByText('웹 역할의 대상 계정 연결이 확인되었습니다.');
    expect(onRegistered).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: '연결 확인 및 등록' }));
    await screen.findByText('등록·검증 완료');
    expect(vi.mocked(fetch).mock.calls.filter(([url]) => url === '/api/accounts')).toHaveLength(1);
    expect(onRegistered).toHaveBeenCalledOnce();
  });

  it('keeps host-identity failures distinct and retryable without claiming a verified target', async () => {
    mockCheck({ ...diagnostic, stage: 'host_identity', code: 'host_identity_unavailable',
      verified: false, hostTaskRoleArn: null, awsRequestId: null }, 503);
    render(<AccountOnboarding onRegistered={onRegistered} />);
    await fillAccount();
    fireEvent.click(screen.getByRole('button', { name: '연결 확인' }));
    await screen.findByText('host_identity_unavailable');
    expect(screen.getByText('host_identity')).toBeTruthy();
    expect(screen.queryByText('웹 역할의 대상 계정 연결이 확인되었습니다.')).toBeNull();
    expect((screen.getByRole('button', { name: '연결 확인' }) as HTMLButtonElement).disabled).toBe(false);
  });

  it('discards a response for an edited scope and prevents duplicate in-flight checks', async () => {
    mockCheck();
    render(<AccountOnboarding onRegistered={onRegistered} />);
    await fillAccount();
    let finish!: (response: Response) => void;
    const pending = new Promise<Response>(resolve => { finish = resolve; });
    vi.mocked(fetch).mockReturnValueOnce(pending);
    fireEvent.click(screen.getByRole('button', { name: '연결 확인' }));
    fireEvent.click(screen.getByRole('button', { name: '연결 확인 중…' }));
    expect(fetch).toHaveBeenCalledTimes(2);
    fireEvent.change(screen.getByLabelText('Account ID'), { target: { value: '333333333333' } });
    await act(async () => { finish(new Response(JSON.stringify({ ok: true, diagnostic }))); await pending; });
    expect(screen.queryByText(diagnostic.checkId)).toBeNull();
    expect((screen.getByLabelText('Account ID') as HTMLInputElement).value).toBe('333333333333');
  });

  it('does not accept a successful-looking response after the browser request timeout', async () => {
    mockCheck();
    render(<AccountOnboarding onRegistered={onRegistered} />);
    await fillAccount();
    vi.useFakeTimers();
    let finish!: (response: Response) => void;
    const pending = new Promise<Response>(resolve => { finish = resolve; });
    vi.mocked(fetch).mockReturnValueOnce(pending);
    fireEvent.click(screen.getByRole('button', { name: '연결 확인' }));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(20_000);
      finish(new Response(JSON.stringify({ ok: true, diagnostic })));
      await pending;
    });
    expect(screen.queryByText(diagnostic.checkId)).toBeNull();
    expect(screen.getByText('연결 확인 결과를 받지 못했습니다. 로그인 상태와 네트워크를 확인한 뒤 다시 시도하세요.')).toBeTruthy();
  });

  it('renders translated check controls and optional collector trust context', async () => {
    const inventoryRole = 'arn:aws:iam::111111111111:role/fixture/inventory-task';
    localStorage.setItem('awsops-lang', 'en');
    vi.mocked(fetch).mockResolvedValue(new Response(JSON.stringify({ ...config, inventoryTaskRoleArn: inventoryRole })));
    render(<LanguageProvider><AccountOnboarding onRegistered={onRegistered} /></LanguageProvider>);
    await screen.findByRole('button', { name: 'Check connection' });
    await waitFor(() => expect(screen.getByLabelText('Account ID').matches(':disabled')).toBe(false));
    fireEvent.change(screen.getByLabelText('Account ID'), { target: { value: diagnostic.accountId } });
    expect(screen.getByText(inventoryRole)).toBeTruthy();
    expect(screen.getByText('The inventory collector role needs separate trust in the target role, beyond web connectivity.')).toBeTruthy();
  });
});
