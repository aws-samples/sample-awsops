'use client';
import { useEffect, useRef, useState } from 'react';
import Card from '@/components/ui/Card';
import { useI18n } from '@/components/shell/LanguageProvider';
import { buildAccountOnboarding, newAccountExternalId, onboardingInputError, type AccountOnboardingConfig } from '@/lib/account-onboarding';

const inputClass = 'w-full rounded border border-ink-200 bg-card px-3 py-2 text-[12px] text-ink-800';
const buttonClass = 'rounded border border-ink-200 px-3 py-1.5 text-[12px] text-ink-700 hover:bg-ink-50 disabled:opacity-50';

interface RegisteredAccount { accountId: string; externalId: string | null }
interface AccountDraft { externalId: string; firstParty: boolean }
const draftKey = (config: AccountOnboardingConfig) => `awsops.account-onboarding.v1:${config.hostTaskRoleArn}`;

export default function AccountOnboarding({ onRegistered, accounts = [] }: {
  onRegistered: () => Promise<void>;
  accounts?: RegisteredAccount[] | null;
}) {
  const { tt } = useI18n();
  const [config, setConfig] = useState<AccountOnboardingConfig | null>(null);
  const [configError, setConfigError] = useState('');
  const [attempt, setAttempt] = useState(0);
  const [form, setForm] = useState({ accountId: '', alias: '', region: '', externalId: '', firstParty: false, profile: '' });
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const [success, setSuccess] = useState(false);
  const [copied, setCopied] = useState(false);
  const [copyError, setCopyError] = useState('');
  const drafts = useRef(new Map<string, AccountDraft>());
  const registeredAccount = accounts?.find((account) => account.accountId === form.accountId);
  const externalId = registeredAccount ? registeredAccount.externalId || '' : form.externalId;

  useEffect(() => {
    const controller = new AbortController();
    setConfigError('');
    fetch('/api/accounts/onboarding', { signal: controller.signal })
      .then(async (response) => {
        if (!response.ok) throw new Error(response.status === 401 || response.status === 403
          ? '계정 등록은 관리자만 사용할 수 있습니다.' : '온보딩 설정을 불러오지 못했습니다. 다시 시도하세요.');
        return response.json() as Promise<AccountOnboardingConfig>;
      })
      .then((data) => {
        if (controller.signal.aborted) return;
        try {
          const saved = JSON.parse(sessionStorage.getItem(draftKey(data)) || '{}');
          for (const [accountId, value] of Object.entries(saved)) {
            const draft = value as AccountDraft | null;
            if (!drafts.current.has(accountId) && /^\d{12}$/.test(accountId) && draft && typeof draft.externalId === 'string'
              && draft.externalId.length <= 1224 && typeof draft.firstParty === 'boolean') {
              drafts.current.set(accountId, { externalId: draft.externalId, firstParty: draft.firstParty });
            }
          }
        } catch {}
        setConfig(data);
        setForm((previous) => ({
          ...previous, region: previous.region || data.region,
        }));
      })
      .catch((error) => {
        if (!controller.signal.aborted) setConfigError(error.message === '계정 등록은 관리자만 사용할 수 있습니다.'
          ? error.message : '온보딩 설정을 불러오지 못했습니다. 다시 시도하세요.');
      });
    return () => controller.abort();
  }, [attempt]);

  const updateForm = (patch: Partial<typeof form>) => {
    let next = { ...form, ...patch };
    if (patch.accountId !== undefined && patch.accountId !== form.accountId && /^\d{12}$/.test(patch.accountId)) {
      const registered = accounts?.find((account) => account.accountId === patch.accountId);
      const draft = registered
        ? { externalId: registered.externalId || '', firstParty: !registered.externalId }
        : drafts.current.get(patch.accountId) || { externalId: newAccountExternalId(), firstParty: false };
      next = { ...next, ...draft };
    }
    if (/^\d{12}$/.test(next.accountId)) {
      drafts.current.set(next.accountId, { externalId: next.externalId, firstParty: next.firstParty });
      if (config) {
        try {
          sessionStorage.setItem(draftKey(config), JSON.stringify(Object.fromEntries(drafts.current)));
        } catch {}
      }
    }
    setForm(next);
    setMessage('');
    setSuccess(false);
    setCopied(false);
    setCopyError('');
  };
  const inputError = onboardingInputError(form);
  const isHost = config?.hostAccountId === form.accountId;
  const guide = config && accounts !== null && !inputError && !isHost && !registeredAccount ? buildAccountOnboarding(form, config) : null;
  const canRegister = Boolean(guide && form.alias.trim() && config?.registrationEnabled && !busy);

  const copy = async (text: string) => {
    setCopyError('');
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
    } catch {
      setCopyError(tt('복사하지 못했습니다. 명령어를 직접 선택하거나 스크립트를 다운로드하세요.'));
    }
  };

  const download = () => {
    if (!guide) return;
    const url = URL.createObjectURL(new Blob([guide.script], { type: 'text/x-shellscript;charset=utf-8' }));
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = guide.filename;
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  };

  const register = async () => {
    if (!canRegister) return;
    setBusy(true);
    setMessage('');
    setSuccess(false);
    try {
      const response = await fetch('/api/accounts', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          accountId: form.accountId, alias: form.alias.trim(), region: form.region,
          externalId: form.externalId, firstParty: form.firstParty,
        }),
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) {
        setMessage(`${tt('연결 확인 실패')}: ${data.message || response.status}`);
        return;
      }
      setSuccess(true);
      setMessage(tt('등록·검증 완료'));
      try {
        await onRegistered();
      } catch {
        setMessage(tt('계정 등록·검증은 완료됐지만 목록을 새로 불러오지 못했습니다. 페이지를 새로고침하세요.'));
      }
    } catch {
      setSuccess(false);
      setMessage(tt('요청을 완료하지 못했습니다. 계정 목록과 네트워크를 확인한 뒤 다시 시도하세요.'));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card padded={false} className="p-4 min-w-0">
      <div className="flex min-w-0 flex-col gap-4">
      <div>
        <h2 className="text-[14px] font-semibold text-ink-800">{tt('AWS 계정 연결')}</h2>
        <p className="mt-1 text-[12px] text-ink-500">{tt('계정 정보 입력 → 대상 계정에서 역할 생성 → 연결 확인 및 등록')}</p>
      </div>
      {configError ? (
        <div role="alert" className="text-[12px] text-negative-600">
          {tt(configError)}
          <button onClick={() => setAttempt((previous) => previous + 1)} className={`${buttonClass} ml-2`}>{tt('다시 시도')}</button>
        </div>
      ) : !config ? <p className="text-[12px] text-ink-500">{tt('온보딩 설정을 불러오는 중…')}</p> : null}
      {config && !config.registrationEnabled && (
        <div role="status" className="rounded-md border border-amber-200 bg-amber-50 p-3 text-[12px] text-amber-900">
          <strong>{tt('현재 환경은 호스트 계정만 수집합니다.')}</strong>
          <p className="mt-1">{tt('역할 생성만으로 등록 제한이 해제되지는 않습니다. 운영자가 다중 계정 수집을 구성한 뒤 등록할 수 있습니다. 아래 명령어는 사전 준비용입니다.')}</p>
        </div>
      )}
      {accounts === null && <p role="status" className="text-[12px] text-ink-500">{tt('등록된 계정 정보를 확인하는 중…')}</p>}
      <fieldset disabled={busy || !config || accounts === null} className="min-w-0">
        <legend className="mb-2 text-[13px] font-semibold text-ink-800">{tt('1. 연결할 계정 정보')}</legend>
        <div className="grid grid-cols-1 gap-3 md:grid-cols-3">
          <label className="text-[12px] text-ink-600">Account ID
            <input className={`${inputClass} mt-1 font-mono`} placeholder="123456789012" inputMode="numeric" maxLength={12} autoComplete="off"
              value={form.accountId} onChange={(event) => updateForm({ accountId: event.target.value.trim() })} />
          </label>
          <label className="text-[12px] text-ink-600">{tt('계정 별칭')}
            <input className={`${inputClass} mt-1`} placeholder={tt('예: Production')} value={form.alias} onChange={(event) => updateForm({ alias: event.target.value })} />
          </label>
          <label className="text-[12px] text-ink-600">{tt('초기 수집 리전')}
            <input className={`${inputClass} mt-1 font-mono`} placeholder="ap-northeast-2" value={form.region} onChange={(event) => updateForm({ region: event.target.value.trim() })} />
          </label>
        </div>
        {form.accountId && inputError && <p role="status" className="mt-2 text-[12px] text-negative-600">{tt(inputError)}</p>}
        {isHost && <p role="status" className="mt-2 text-[12px] text-ink-600">{tt('호스트 계정은 이미 연결되어 있습니다.')}</p>}
        {registeredAccount && !isHost && <p role="status" className="mt-2 text-[12px] text-ink-600">{tt('이미 등록된 계정입니다. 저장된 ExternalId를 유지합니다. 아래 등록된 계정 목록에서 테스트를 실행하세요.')}</p>}
        <details className="mt-3 text-[12px] text-ink-600">
          <summary className="cursor-pointer">{tt('고급 설정: ExternalId · AWS CLI 프로필')}</summary>
          <p className="my-2">{tt('ExternalId는 자동 생성되며 역할 생성과 등록에 같은 값이 사용됩니다. 기존 역할을 연결하려면 해당 역할의 ExternalId로 바꾸세요.')}</p>
          <p className="my-2">{tt('계정별 설정은 이 브라우저 세션에 보존됩니다. 새 세션에서는 기존 스크립트 또는 역할의 신뢰 정책에서 ExternalId를 확인하세요.')}</p>
          <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
            <label>ExternalId
              <input className={`${inputClass} mt-1 font-mono`} readOnly={Boolean(registeredAccount)} disabled={!/^\d{12}$/.test(form.accountId)} value={externalId} onChange={(event) => updateForm({ externalId: event.target.value.trim() })} />
            </label>
            <label>{tt('AWS CLI 프로필 (선택)')}
              <input className={`${inputClass} mt-1`} placeholder={tt('비워두면 현재 로그인 사용')} value={form.profile} onChange={(event) => updateForm({ profile: event.target.value })} />
            </label>
          </div>
          <label className="mt-2 flex items-start gap-2">
            <input type="checkbox" disabled={Boolean(registeredAccount) || !/^\d{12}$/.test(form.accountId)} checked={registeredAccount ? !registeredAccount.externalId : form.firstParty} onChange={(event) => updateForm({
              firstParty: event.target.checked,
              externalId: event.target.checked ? '' : form.externalId || newAccountExternalId(),
            })} />
            {tt('같은 조직 계정: 호스트 역할 ARN을 정확히 신뢰하며 ExternalId 생략에 동의합니다.')}
          </label>
        </details>
      </fieldset>
      <section className="min-w-0 border-t border-ink-100 pt-3">
        <h3 className="mb-2 text-[13px] font-semibold text-ink-800">{tt('2. 대상 계정에서 읽기 전용 역할 생성')}</h3>
        {guide ? (
          <>
            <p className="text-[12px] text-ink-600">
              <strong className="font-mono">{form.accountId}</strong> — {tt('이 계정의 AWS CloudShell 또는 AWS CLI v2가 설치된 Bash 터미널에서 실행하세요. IAM 역할·정책 연결과 CloudFormation 배포 권한이 필요합니다.')}
            </p>
            <p className="mt-2 text-[12px] text-ink-500">{tt('AWSopsReadOnlyRole을 생성하고 ReadOnlyAccess를 연결합니다. 신뢰할 호스트 역할:')}</p>
            <p className="mt-2 text-[12px] text-ink-500">{tt('새 역할만 생성하며 기존 스택·역할은 변경하지 않습니다. 기존 역할이 있으면 ExternalId를 맞춘 뒤 연결을 확인하세요.')}</p>
            <code className="mt-1 block break-all text-[11px] text-ink-700">{config?.hostTaskRoleArn}</code>
            <div className="my-3 flex flex-wrap gap-2">
              <button type="button" onClick={() => copy(guide.commands)} className={buttonClass}>{tt(copied ? '복사됨' : 'AWS CLI 명령어 복사')}</button>
              <button type="button" onClick={download} className={buttonClass}>{tt('스크립트 다운로드 (.sh)')}</button>
            </div>
            {copyError && <p role="alert" className="mb-2 text-[12px] text-negative-600">{copyError}</p>}
            <p className="mb-2 text-[12px] text-ink-600">{tt('복사한 명령어를 붙여넣거나, 다운로드한 파일을 CloudShell의 Actions → Upload file로 업로드한 뒤 실행하세요.')}</p>
            <pre className="overflow-x-auto rounded bg-ink-800 p-3 text-[12px] text-paper"><code>{guide.command}</code></pre>
            <details className="mt-3 text-[12px] text-ink-600">
              <summary className="cursor-pointer">{tt('AWS CLI 명령어 전체 보기')}</summary>
              <pre className="mt-2 max-h-80 overflow-auto rounded bg-ink-800 p-3 text-[12px] text-paper"><code>{guide.commands}</code></pre>
            </details>
            <p className="mt-2 text-[12px] text-ink-500">{tt('템플릿이 스크립트에 포함되어 있어 저장소 다운로드는 필요하지 않습니다. 로그인 계정이 다르면 역할 생성 전에 중단합니다.')}</p>
          </>
        ) : <p className="text-[12px] text-ink-500">{tt(registeredAccount
          ? '등록된 계정에는 역할 생성 스크립트를 제공하지 않습니다.'
          : '12자리 Account ID를 입력하면 계정에 맞는 AWS CLI 명령어가 표시됩니다.')}</p>}
      </section>
      <section className="border-t border-ink-100 pt-3">
        <h3 className="mb-2 text-[13px] font-semibold text-ink-800">{tt('3. 연결 확인 및 등록')}</h3>
        <p className="mb-3 text-[12px] text-ink-600">{tt('역할 생성이 완료되면 연결을 확인하세요. AWSops가 AssumeRole과 계정 ID를 검증한 뒤 저장합니다. 이미 역할이 있다면 바로 확인할 수 있습니다.')}</p>
        <p className="mb-3 text-[12px] text-ink-500">{tt('연결 확인은 웹 역할의 접근만 검증합니다. 인벤토리 수집·AgentCore·워커의 연결과 수집 완료를 보장하지 않습니다.')}</p>
        <button type="button" onClick={register} disabled={!canRegister}
          className="rounded-md bg-brand-800 px-3 py-2 text-[12px] font-semibold text-white hover:bg-brand-900 disabled:opacity-50">
          {tt(busy ? '검증 중…' : '연결 확인 및 등록')}
        </button>
        {guide && !form.alias.trim() && <p className="mt-2 text-[12px] text-ink-500">{tt('등록하려면 계정 별칭을 입력하세요.')}</p>}
        {message && <p role={success ? 'status' : 'alert'} className={`mt-2 break-words text-[12px] ${success ? 'text-positive-600' : 'text-negative-600'}`}>{message}</p>}
        {!success && message && <p className="mt-2 text-[12px] text-ink-500">{tt('역할 생성 완료 여부, 신뢰할 호스트 역할 ARN, ExternalId 일치를 확인하세요. IAM 반영에 시간이 걸리면 잠시 후 다시 확인하세요.')}</p>}
        <details className="mt-3 text-[12px] text-ink-500">
          <summary className="cursor-pointer">{tt('역할 생성 또는 연결이 실패할 때')}</summary>
          <p className="mt-2">{tt('AlreadyExists는 스택 이름 충돌일 수도 있습니다. CloudFormation에서 awsops-readonly-role의 상태·이벤트·리소스를 먼저 확인하세요.')}</p>
          <p className="mt-1">{tt('ROLLBACK_COMPLETE: 역할이 생성되지 않았을 수 있습니다. 실패 원인을 해결하고 필요한 리소스가 없는 실패 스택인지 확인한 뒤 해당 스택만 삭제하세요. 삭제 완료 후 같은 스크립트로 재시도하세요.')}</p>
          <p className="mt-1">{tt('CREATE_COMPLETE / UPDATE_COMPLETE: 스택이나 정상 역할을 삭제하지 마세요. 기존 역할의 신뢰 정책과 ExternalId를 맞춰 연결을 확인하세요. CREATE_IN_PROGRESS이면 완료될 때까지 기다리세요.')}</p>
          <p className="mt-1">{tt('AccessDenied: 대상 계정의 IAM·CloudFormation 권한과 호스트 역할의 AssumeRole 권한을 확인하세요.')}</p>
          <p className="mt-1">{tt('이 가이드는 웹 연결용입니다. 워커 기반 조회에는 별도의 WorkerTaskRoleArn 신뢰 설정이 필요합니다.')}</p>
          <p className="mt-1">{tt('AgentCore 조회는 현재 공통 AWSOPS_EXTERNAL_ID 설정을 사용합니다. 계정별 자동 생성값과 별개로 운영자 설정이 필요합니다.')}</p>
        </details>
      </section>
      </div>
    </Card>
  );
}
