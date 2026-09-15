'use client';
import Link from 'next/link';
import { useI18n } from '@/components/shell/LanguageProvider';
import {
  ACCOUNT_CONNECTION_MESSAGES, accountConnectionAiHref, type AccountConnectionDiagnostic,
} from '@/lib/account-connection-diagnostics';

export default function AccountConnectionDiagnostics({ diagnostic, registrationReason, hostOnly }: {
  diagnostic: AccountConnectionDiagnostic;
  registrationReason: string | null;
  hostOnly: boolean;
}) {
  const { tt } = useI18n();
  const unknown = tt('확인되지 않음');
  const rows = [
    ['확인 시각', diagnostic.checkedAt], ['확인 ID', diagnostic.checkId],
    ['확인 단계', diagnostic.stage], ['결과 코드', diagnostic.code],
    ['AWS 요청 ID', diagnostic.awsRequestId ?? unknown], ['소요 시간', `${diagnostic.durationMs} ms`],
    ['대상 계정', diagnostic.accountId], ['등록 대상 리전', diagnostic.region],
    ['STS 확인 리전', diagnostic.stsRegion ?? unknown],
    ['대상 역할', diagnostic.roleArn], ['호스트 웹 역할', diagnostic.hostTaskRoleArn ?? unknown],
    ['ExternalId 제공 여부', tt(diagnostic.externalIdProvided ? '제공됨' : '생략됨')],
  ];
  return (
    <section aria-label={tt('연결 확인 결과')} className="mt-3 min-w-0 rounded border border-ink-200 bg-ink-50 p-3">
      <h4 className="text-[13px] font-semibold text-ink-800">{tt('연결 확인 결과')}</h4>
      <p role={diagnostic.verified ? 'status' : 'alert'} className="mt-2 text-[12px] text-ink-700">
        {tt(diagnostic.verified && registrationReason
          ? hostOnly ? '연결은 확인됐지만 호스트 전용 설정으로 계정 등록은 차단되어 있습니다.'
            : '연결은 확인됐지만 현재 등록 정책으로 계정 등록은 차단되어 있습니다.'
          : ACCOUNT_CONNECTION_MESSAGES[diagnostic.code])}
      </p>
      {diagnostic.verified && registrationReason && <p className="mt-1 text-[12px] text-ink-600">{tt(registrationReason)}</p>}
      <dl className="mt-3 grid min-w-0 gap-x-4 gap-y-2 text-[12px] sm:grid-cols-[auto_minmax(0,1fr)]">
        {rows.map(([label, value]) => (
          <div key={label} className="contents">
            <dt className="text-ink-500">{tt(label)}</dt>
            <dd className="min-w-0 break-all font-mono text-ink-800">{value}</dd>
          </div>
        ))}
      </dl>
      <p className="mt-3 text-[12px] text-ink-600">{tt('이 결과는 웹 역할의 연결 확인이며 인벤토리 수집 준비 완료를 의미하지 않습니다.')}</p>
      <p className="mt-1 text-[12px] text-ink-600">{tt('등록 대상 리전의 활성화 여부는 별도로 확인하세요.')}</p>
      <Link href={accountConnectionAiHref(diagnostic, !registrationReason && diagnostic.registrationEnabled)}
        className="mt-3 inline-block rounded border border-ink-200 bg-card px-3 py-1.5 text-[12px] font-semibold text-brand-800 hover:bg-ink-100">
        {tt('AI 원인 분석 가이드')}
      </Link>
      <p className="mt-1 text-[11px] text-ink-500">{tt('안전한 확인 메타데이터만 AI 입력창에 준비합니다. 전송은 직접 선택하세요.')}</p>
    </section>
  );
}
