import { afterEach, describe, expect, it } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildAccountOnboarding, onboardingInputError } from './account-onboarding';

const config = {
  hostAccountId: '111111111111', hostTaskRoleArn: 'arn:aws:iam::111111111111:role/awsops-dev-task',
  region: 'ap-northeast-2', registrationEnabled: true,
};
const input = { accountId: '222222222222', region: 'ap-northeast-2', externalId: 'example-external-id', firstParty: false, profile: '' };
const directories: string[] = [];

afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function runScript(options: { account?: string; profile?: string; fail?: string } = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'awsops-onboarding-test-'));
  directories.push(directory);
  const log = join(directory, 'calls');
  const injected = join(directory, 'injected');
  const profile = options.profile ?? `target' $(touch ${injected})`;
  writeFileSync(join(directory, 'aws'), `#!/usr/bin/env bash
printf '%s\\n' "$@" >> "$CALL_LOG"
if [ "$1 $2" = "$FAIL_COMMAND" ]; then exit 1; fi
if [ "$1 $2" = "sts get-caller-identity" ]; then
  printf '%s\\n' "$CALLER_ACCOUNT"
elif [ "$1 $2" = "cloudformation create-stack" ]; then
  while [ "$#" -gt 0 ]; do
    if [ "$1" = "--template-body" ]; then cp "\${2#file://}" "$SAVED_TEMPLATE"; fi
    if [ "$1" = "--parameters" ]; then cp "\${2#file://}" "$SAVED_PARAMETERS"; fi
    shift
  done
fi
`, { mode: 0o700 });
  const guide = buildAccountOnboarding({ ...input, profile }, config);
  const result = spawnSync('bash', ['-s'], {
    input: guide.script, encoding: 'utf8',
    env: {
      ...process.env, PATH: `${directory}:${process.env.PATH}`, CALL_LOG: log,
      CALLER_ACCOUNT: options.account ?? input.accountId, FAIL_COMMAND: options.fail ?? '',
      SAVED_TEMPLATE: join(directory, 'template.json'),
      SAVED_PARAMETERS: join(directory, 'parameters.json'),
    },
  });
  return { ...result, calls: readFileSync(log, 'utf8'), directory, injected, profile };
}

describe('account onboarding script', () => {
  it('executes with the target guard, exact host trust, safe arguments and read-only permissions', () => {
    const result = runScript();
    expect(result.status).toBe(0);
    expect(result.calls).toContain(result.profile);
    expect(result.calls).toContain('CAPABILITY_NAMED_IAM');
    expect(result.calls).toContain('stack-create-complete');
    expect(existsSync(result.injected)).toBe(false);
    const parameters = JSON.parse(readFileSync(join(result.directory, 'parameters.json'), 'utf8'));
    expect(parameters).toEqual([
      { ParameterKey: 'HostTaskRoleArn', ParameterValue: config.hostTaskRoleArn },
      { ParameterKey: 'RoleName', ParameterValue: 'AWSopsReadOnlyRole' },
      { ParameterKey: 'ExternalId', ParameterValue: input.externalId },
    ]);
    const template = JSON.parse(readFileSync(join(result.directory, 'template.json'), 'utf8'));
    expect(Object.keys(template.Resources)).toEqual(['AWSopsReadOnlyRole']);
    expect(template.Resources.AWSopsReadOnlyRole.Properties.ManagedPolicyArns).toEqual(['arn:aws:iam::aws:policy/ReadOnlyAccess']);
    expect(template.Resources.AWSopsReadOnlyRole.Properties.AssumeRolePolicyDocument.Statement[0].Action).toBe('sts:AssumeRole');
    expect(template.Parameters.WorkerTaskRoleArn.Default).toBe('');
    expect(result.calls).not.toContain('WorkerTaskRoleArn=');
    expect(result.stdout).toContain('Role ready');
  });

  it('does not deploy when the CLI points at another account', () => {
    const result = runScript({ account: config.hostAccountId });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('Wrong AWS account');
    expect(result.calls).not.toContain('cloudformation');
  });

  it('does not deploy after failed identity lookup or claim success after failed deployment', () => {
    const identityFailure = runScript({ fail: 'sts get-caller-identity' });
    expect(identityFailure.status).not.toBe(0);
    expect(identityFailure.calls).not.toContain('cloudformation');
    const deployFailure = runScript({ fail: 'cloudformation create-stack' });
    expect(deployFailure.status).not.toBe(0);
    expect(deployFailure.calls).not.toContain('describe-stacks');
    expect(deployFailure.calls).not.toContain('wait');
    expect(deployFailure.stdout).not.toContain('Role ready');
    expect(buildAccountOnboarding(input, config).script).not.toContain('cloudformation deploy');
    expect(buildAccountOnboarding(input, config).script).not.toContain('update-stack');
  });

  it('uses current credentials without a profile and permits explicit first-party omission only', () => {
    expect(runScript({ profile: '' }).calls).not.toContain('--profile');
    expect(onboardingInputError({ ...input, externalId: '' })).toBeTruthy();
    const guide = buildAccountOnboarding({ ...input, externalId: '', firstParty: true }, config);
    const parameters = JSON.parse(guide.script.split("<<'AWSOPS_PARAMETERS'\n")[1].split('\nAWSOPS_PARAMETERS')[0]);
    expect(parameters.some((parameter: { ParameterKey: string }) => parameter.ParameterKey === 'ExternalId')).toBe(false);
    expect(execFileSync('bash', ['-n'], { input: guide.script }).toString()).toBe('');
  });

  it.each([
    { accountId: '123' }, { accountId: '123456789012;touch /tmp/x' },
    { region: 'ap-northeast-2;exit' }, { externalId: 'short' }, { externalId: 'bad$(id)' },
    { externalId: 'a'.repeat(1225) }, { profile: 'dev\nexit' },
  ])('rejects invalid input before generating a script: %j', (patch) => {
    expect(() => buildAccountOnboarding({ ...input, ...patch }, config)).toThrow();
  });

  it('rejects the host itself and unknown or mismatched host principals', () => {
    expect(() => buildAccountOnboarding({ ...input, accountId: config.hostAccountId }, config)).toThrow();
    for (const hostTaskRoleArn of ['*', 'arn:aws:iam::111111111111:root', 'arn:aws:iam::333333333333:role/web']) {
      expect(() => buildAccountOnboarding(input, { ...config, hostTaskRoleArn })).toThrow();
    }
  });

  it('retains preparation-only guidance in a download from a host-only deployment', () => {
    const guide = buildAccountOnboarding(input, { ...config, registrationEnabled: false });
    expect(guide.script).toContain('registration remains disabled');
    expect(guide.script).not.toContain('Role ready.');
    expect(execFileSync('bash', ['-n'], { input: guide.commands }).toString()).toBe('');
  });
});
