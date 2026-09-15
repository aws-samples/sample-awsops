// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import AccountOnboarding from './AccountOnboarding';

const config = {
  hostAccountId: '111111111111', hostTaskRoleArn: 'arn:aws:iam::111111111111:role/awsops-dev-task',
  region: 'ap-northeast-2', registrationEnabled: true,
};
const onRegistered = vi.fn().mockResolvedValue(undefined);

beforeEach(() => {
  sessionStorage.clear();
  onRegistered.mockReset().mockResolvedValue(undefined);
  vi.stubGlobal('fetch', vi.fn(async (url: string) => new Response(JSON.stringify(
    url === '/api/accounts/onboarding' ? config : { ok: true, status: 'verified' },
  ))));
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

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
    vi.mocked(fetch).mockResolvedValueOnce(new Response(JSON.stringify({ message: 'AccessDenied' }), { status: 400 }));
    fireEvent.click(screen.getByRole('button', { name: '연결 확인 및 등록' }));
    await screen.findByText('연결 확인 실패: AccessDenied');
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
