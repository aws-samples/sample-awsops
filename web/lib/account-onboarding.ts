export interface AccountOnboardingConfig {
  hostAccountId: string;
  hostTaskRoleArn: string;
  region: string;
  registrationEnabled: boolean;
}

export interface AccountOnboardingInput {
  accountId: string;
  region: string;
  externalId: string;
  firstParty: boolean;
  profile: string;
}

const ROLE_ARN = /^arn:aws:iam::(\d{12}):role\/[A-Za-z0-9_+=,.@/-]+$/;

export function onboardingInputError(input: AccountOnboardingInput): string | null {
  if (!/^\d{12}$/.test(input.accountId)) return 'Account ID는 12자리 숫자여야 합니다.';
  if (!/^[a-z]{2}-[a-z]+-\d+$/.test(input.region)) return 'AWS 리전을 확인하세요.';
  if (!input.externalId && !input.firstParty) return 'ExternalId를 입력하거나 같은 조직 계정을 선택하세요.';
  if (input.externalId && !/^[A-Za-z0-9_+=,.@:/-]{8,1224}$/.test(input.externalId)) {
    return 'ExternalId는 영문·숫자 및 _+=,.@:/- 조합의 8~1224자여야 합니다.';
  }
  if (input.profile.length > 128 || /[\u0000-\u001f\u007f]/.test(input.profile)) return 'AWS CLI 프로필 이름을 확인하세요.';
  return null;
}

const shellQuote = (value: string) => `'${value.replace(/'/g, "'\\''")}'`;

export function buildAccountOnboarding(input: AccountOnboardingInput, config: AccountOnboardingConfig) {
  const error = onboardingInputError(input);
  if (error) throw new Error(error);
  const roleMatch = config.hostTaskRoleArn.match(ROLE_ARN);
  if (!roleMatch || roleMatch[1] !== config.hostAccountId) throw new Error('Invalid host task role');
  if (input.accountId === config.hostAccountId) throw new Error('호스트 계정은 이미 연결되어 있습니다.');

  const template = JSON.stringify({
    AWSTemplateFormatVersion: '2010-09-09',
    Description: 'AWSops cross-account read-only access. Run by the target account administrator.',
    Parameters: {
      HostTaskRoleArn: { Type: 'String', AllowedPattern: '^arn:aws:iam::\\d{12}:role/.+$' },
      WorkerTaskRoleArn: { Type: 'String', Default: '', AllowedPattern: '^$|^arn:aws:iam::\\d{12}:role/.+$' },
      ExternalId: { Type: 'String', Default: '', AllowedPattern: '^$|^[A-Za-z0-9_+=,.@:/-]{8,1224}$', NoEcho: true },
      RoleName: { Type: 'String', Default: 'AWSopsReadOnlyRole', AllowedValues: ['AWSopsReadOnlyRole'] },
    },
    Conditions: {
      HasExternalId: { 'Fn::Not': [{ 'Fn::Equals': [{ Ref: 'ExternalId' }, ''] }] },
      HasWorkerTaskRoleArn: { 'Fn::Not': [{ 'Fn::Equals': [{ Ref: 'WorkerTaskRoleArn' }, ''] }] },
    },
    Resources: {
      AWSopsReadOnlyRole: {
        Type: 'AWS::IAM::Role',
        Properties: {
          RoleName: { Ref: 'RoleName' },
          Description: 'AWSops cross-account read-only access (assumed by the host web/worker task roles).',
          MaxSessionDuration: 3600,
          AssumeRolePolicyDocument: {
            Version: '2012-10-17',
            Statement: [{
              Effect: 'Allow',
              Principal: { AWS: { 'Fn::If': ['HasWorkerTaskRoleArn',
                [{ Ref: 'HostTaskRoleArn' }, { Ref: 'WorkerTaskRoleArn' }], { Ref: 'HostTaskRoleArn' }] } },
              Action: 'sts:AssumeRole',
              Condition: { 'Fn::If': ['HasExternalId',
                { StringEquals: { 'sts:ExternalId': { Ref: 'ExternalId' } } }, { Ref: 'AWS::NoValue' }] },
            }],
          },
          ManagedPolicyArns: ['arn:aws:iam::aws:policy/ReadOnlyAccess'],
        },
      },
    },
    Outputs: { RoleArn: { Value: { 'Fn::GetAtt': ['AWSopsReadOnlyRole', 'Arn'] } } },
  }, null, 2);
  const filename = `awsops-readonly-role-${input.accountId}.sh`;
  const completion = config.registrationEnabled
    ? 'Role ready. Return to AWSops Accounts with the same ExternalId and select Verify and register.'
    : 'Role prepared only. This AWSops environment is host-only; registration remains disabled. An operator must configure multi-account collection before you return with the same ExternalId to verify and register.';
  const script = `#!/usr/bin/env bash
set -euo pipefail
export AWS_PAGER=""
target_account=${shellQuote(input.accountId)}
region=${shellQuote(input.region)}
profile=${shellQuote(input.profile)}
aws_args=(--region "$region")
if [ -n "$profile" ]; then aws_args+=(--profile "$profile"); fi
command -v aws >/dev/null 2>&1 || { printf '%s\\n' 'Install AWS CLI v2 first.' >&2; exit 1; }
caller_account=$(aws sts get-caller-identity "\${aws_args[@]}" --query Account --output text)
if [ "$caller_account" != "$target_account" ]; then
  printf 'Wrong AWS account: expected %s, got %s. Select the target account credentials/profile.\\n' "$target_account" "$caller_account" >&2
  exit 1
fi
work_dir=$(mktemp -d)
trap 'rm -rf -- "$work_dir"' EXIT
cat > "$work_dir/awsops-target-account-role.json" <<'AWSOPS_TEMPLATE'
${template}
AWSOPS_TEMPLATE
aws cloudformation deploy "\${aws_args[@]}" \\
  --template-file "$work_dir/awsops-target-account-role.json" \\
  --stack-name awsops-readonly-role \\
  --capabilities CAPABILITY_NAMED_IAM \\
  --no-fail-on-empty-changeset \\
  --parameter-overrides \\
    ${shellQuote(`HostTaskRoleArn=${config.hostTaskRoleArn}`)} \\
    ${shellQuote(`ExternalId=${input.externalId}`)} \\
    'RoleName=AWSopsReadOnlyRole'
aws cloudformation describe-stacks "\${aws_args[@]}" \\
  --stack-name awsops-readonly-role \\
  --query 'Stacks[0].Outputs[?OutputKey==\`RoleArn\`].OutputValue' --output text
printf '%s\\n' ${shellQuote(completion)}
`;
  return { filename, script, commands: `bash <<'AWSOPS_SETUP'\n${script}AWSOPS_SETUP\n`, command: `bash ${shellQuote(filename)}` };
}
