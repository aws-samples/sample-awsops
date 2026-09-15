export type AccountConnectionCode =
  | 'verified' | 'access_denied' | 'expired_credentials' | 'invalid_credentials'
  | 'timeout' | 'throttled' | 'identity_mismatch' | 'invalid_response'
  | 'aws_error' | 'host_identity_unavailable';

export interface AccountConnectionDiagnostic {
  checkId: string;
  checkedAt: string;
  accountId: string;
  region: string;
  /** Deployment STS endpoint region; absent on legacy diagnostic responses. */
  stsRegion?: string;
  roleArn: string;
  hostTaskRoleArn: string | null;
  externalIdProvided: boolean;
  stage: 'host_identity' | 'assume_role' | 'get_caller_identity';
  code: AccountConnectionCode;
  awsRequestId: string | null;
  durationMs: number;
  verified: boolean;
  registrationEnabled: boolean;
}

export const ACCOUNT_CONNECTION_MESSAGES: Record<AccountConnectionCode, string> = {
  verified: '웹 역할의 대상 계정 연결이 확인되었습니다.',
  access_denied: '기록된 단계의 IAM 권한과 역할 신뢰 조건을 확인하세요. ExternalId 값은 공개하지 마세요.',
  expired_credentials: '임시 자격 증명이 만료되었습니다. 운영자에게 호스트 자격 증명 상태 확인을 요청하세요.',
  invalid_credentials: '자격 증명을 검증하지 못했습니다. 자격 증명을 공유하지 말고 운영자에게 확인을 요청하세요.',
  timeout: '제한 시간 안에 확인하지 못했습니다. 네트워크와 AWS 응답 상태를 확인한 뒤 다시 시도하세요.',
  throttled: 'AWS 요청 제한으로 확인하지 못했습니다. 잠시 후 다시 확인하세요.',
  identity_mismatch: '예상한 계정 또는 역할과 응답 신원이 다릅니다. 계정 ID와 역할 ARN을 확인하세요.',
  invalid_response: '검증 가능한 AWS 응답을 받지 못했습니다. 확인 ID와 AWS 요청 ID로 운영자에게 문의하세요.',
  aws_error: 'AWS 요청이 실패했습니다. 원인은 단정하지 말고 확인 단계와 AWS 요청 ID를 확인하세요.',
  host_identity_unavailable: '호스트 실행 역할의 신원을 확인하지 못했습니다. 대상 계정 연결을 확인한 상태가 아닙니다.',
};

const ACCOUNT = /^\d{12}$/;
const REGION = /^[a-z]{2}-[a-z]+-\d+$/;
const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9-]{0,127}$/;
const HOST_ROLE = /^arn:aws:iam::\d{12}:role\/[A-Za-z0-9_+=,.@/-]+$/;
const validRegion = (value: string) => value.length <= 32 && REGION.test(value);

export function accountRegistrationFailure(status: number, canCheck = false): string {
  if (status === 401) return '로그인 후 계정 등록을 다시 시도하세요.';
  if (status === 403) return '계정 등록은 관리자만 사용할 수 있습니다.';
  if (status === 409) return '현재 등록 정책 또는 계정 상태로 등록할 수 없습니다. 등록 범위와 계정 목록을 확인하세요.';
  if (status === 429) return '등록 요청이 잠시 제한되었습니다. 잠시 후 다시 시도하세요.';
  if (status === 503) return '등록 설정을 확인할 수 없습니다. 운영자에게 배포 설정을 확인하세요.';
  if (status >= 500) return '서버에서 등록을 완료하지 못했습니다. 계정 목록을 확인하고 운영자에게 문의하세요.';
  return canCheck ? '등록하지 못했습니다. 연결 확인으로 진단 결과를 확인하세요.'
    : '등록하지 못했습니다. 읽기 전용 확인 명령으로 역할과 신뢰 설정을 확인하거나 운영자에게 연결 확인 범위를 요청하세요.';
}

export function accountConnectionBoundaryFailure(status: number, code: unknown): string {
  if (status === 401) return '로그인 후 연결 확인을 다시 시도하세요.';
  if (status === 403) return '연결 확인은 관리자만 사용할 수 있습니다.';
  if (status === 409) return '이 계정은 현재 연결 확인 범위에 없습니다. 운영자에게 배포 설정을 확인하세요.';
  if (status === 429) return '연결 확인 요청이 진행 중이거나 잠시 제한되었습니다. 잠시 후 다시 시도하세요.';
  if (status === 503 && code === 'scope_unavailable') return '연결 확인 범위 설정을 확인할 수 없습니다. 운영자에게 문의하세요.';
  return '연결 확인 결과를 받지 못했습니다. 로그인 상태와 네트워크를 확인한 뒤 다시 시도하세요.';
}

export function accountConnectionRetryAfter(bodySeconds: unknown, header: string | null): number | null {
  const values = [bodySeconds, header && /^\d{1,4}$/.test(header) ? Number(header) : null];
  const seconds = values.filter((value): value is number =>
    typeof value === 'number' && Number.isInteger(value) && value > 0 && value <= 3600);
  return seconds.length ? Math.max(...seconds) : null;
}

/** Treat the response as untrusted data; never forward extra fields or remote messages. */
export function readAccountConnectionDiagnostic(value: unknown, expected: {
  accountId: string; region: string; externalIdProvided: boolean;
}): AccountConnectionDiagnostic | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const d = value as AccountConnectionDiagnostic;
  if (typeof d.checkId !== 'string' || !IDENTIFIER.test(d.checkId)
    || typeof d.checkedAt !== 'string' || !Number.isFinite(Date.parse(d.checkedAt))
    || new Date(d.checkedAt).toISOString() !== d.checkedAt
    || typeof d.accountId !== 'string' || !ACCOUNT.test(d.accountId) || d.accountId !== expected.accountId
    || typeof d.region !== 'string' || !validRegion(d.region) || d.region !== expected.region
    || (d.stsRegion !== undefined && (typeof d.stsRegion !== 'string' || !validRegion(d.stsRegion)))
    || d.roleArn !== `arn:aws:iam::${d.accountId}:role/AWSopsReadOnlyRole`
    || !(d.hostTaskRoleArn === null || (typeof d.hostTaskRoleArn === 'string'
      && d.hostTaskRoleArn.length <= 2048 && HOST_ROLE.test(d.hostTaskRoleArn)))
    || typeof d.externalIdProvided !== 'boolean' || d.externalIdProvided !== expected.externalIdProvided
    || !['host_identity', 'assume_role', 'get_caller_identity'].includes(d.stage)
    || !Object.hasOwn(ACCOUNT_CONNECTION_MESSAGES, d.code)
    || !(d.awsRequestId === null || (typeof d.awsRequestId === 'string' && IDENTIFIER.test(d.awsRequestId)))
    || !Number.isFinite(d.durationMs) || d.durationMs < 0 || d.durationMs > Number.MAX_SAFE_INTEGER
    || typeof d.verified !== 'boolean' || typeof d.registrationEnabled !== 'boolean'
    || d.verified !== (d.code === 'verified')
    || (d.verified && (d.stage !== 'get_caller_identity' || d.hostTaskRoleArn === null))) return null;
  return {
    checkId: d.checkId, checkedAt: d.checkedAt, accountId: d.accountId, region: d.region,
    ...(d.stsRegion === undefined ? {} : { stsRegion: d.stsRegion }),
    roleArn: d.roleArn, hostTaskRoleArn: d.hostTaskRoleArn, externalIdProvided: d.externalIdProvided,
    stage: d.stage, code: d.code, awsRequestId: d.awsRequestId, durationMs: d.durationMs,
    verified: d.verified, registrationEnabled: d.registrationEnabled,
  };
}

/** Existing assistant deep links seed a draft only; they never send a message. */
export function accountConnectionAiHref(diagnostic: AccountConnectionDiagnostic, registrationEnabled = diagnostic.registrationEnabled): string {
  const d = readAccountConnectionDiagnostic(diagnostic, diagnostic);
  if (!d) throw new Error('invalid_connection_diagnostic');
  let prompt = '/security Analyze this account connection check and suggest read-only checks. Do not change resources or claim registration/collection readiness.';
  const fields = [
    `checkId=${d.checkId}`, `account=${d.accountId}`, `requestedRegion=${d.region}`,
    `stsRegion=${d.stsRegion ?? 'unavailable'}`, `stage=${d.stage}`, `code=${d.code}`,
    `registrationEnabled=${registrationEnabled}`, `externalIdProvided=${d.externalIdProvided}`,
    `awsRequestId=${d.awsRequestId ?? 'unavailable'}`, `checkedAt=${d.checkedAt}`,
    `role=AWSopsReadOnlyRole`, `durationMs=${d.durationMs}`,
  ];
  for (const field of fields) {
    if (prompt.length + field.length + 1 > 500) break;
    prompt += ` ${field}`;
  }
  return `/assistant?q=${encodeURIComponent(prompt)}`;
}

/** Output projections retain condition names, never condition values or raw failure reasons. */
export function accountConnectionCommands(accountId: string, region: string): string | null {
  if (!ACCOUNT.test(accountId) || !validRegion(region)) return null;
  return `bash <<'AWSOPS_CHECKS'
set -u
target_account='${accountId}'
region='${region}'
caller_account=$(aws sts get-caller-identity --region "$region" --query Account --output text --no-cli-pager)
[ "$caller_account" = "$target_account" ] || { printf '%s\\n' 'Select the target account credentials before running these checks.' >&2; exit 1; }
aws iam get-role --role-name AWSopsReadOnlyRole --region "$region" --query 'Role.{Arn:Arn,TrustStatements:AssumeRolePolicyDocument.Statement[].{Principal:Principal.AWS,ConditionOperators:keys(Condition || \`{}\`),ConditionKeys:map(&keys(@),values(Condition || \`{}\`))}}' --output json --no-cli-pager
aws iam list-attached-role-policies --role-name AWSopsReadOnlyRole --region "$region" --query 'AttachedPolicies[].PolicyArn' --output json --no-cli-pager
aws cloudformation describe-events --stack-name awsops-readonly-role --filters FailedEvents=true --region "$region" --max-items 50 --query 'OperationEvents[].{Time:Timestamp,Event:EventType,Resource:LogicalResourceId,Status:ResourceStatus,OperationStatus:OperationStatus,Validation:ValidationStatus}' --output json --no-cli-pager
AWSOPS_CHECKS`;
}
