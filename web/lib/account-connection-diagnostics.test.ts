import { describe, expect, it } from 'vitest';
import {
  accountConnectionAiHref, accountConnectionCommands, accountConnectionRetryAfter, readAccountConnectionDiagnostic,
  type AccountConnectionDiagnostic,
} from './account-connection-diagnostics';
import { SECTIONS } from './sections';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

const fixture: AccountConnectionDiagnostic = {
  checkId: '72b022ca-4dcd-4a08-9d8c-4da6414c490d', checkedAt: '2026-09-15T00:00:00.000Z',
  accountId: '222222222222', region: 'ap-northeast-2',
  roleArn: 'arn:aws:iam::222222222222:role/AWSopsReadOnlyRole',
  hostTaskRoleArn: 'arn:aws:iam::111111111111:role/fixture/web-task',
  externalIdProvided: true, stage: 'assume_role', code: 'access_denied',
  awsRequestId: '64d682bc-23a4-4653-ae21-3db97a97f23b', durationMs: 150,
  verified: false, registrationEnabled: false,
};
const expected = { accountId: fixture.accountId, region: fixture.region, externalIdProvided: true };

describe('client-safe connection diagnostic contract', () => {
  it('keeps deployment STS region separate from requested region without inventing legacy metadata', () => {
    expect(readAccountConnectionDiagnostic({ ...fixture, stsRegion: 'us-west-2' }, expected))
      .toMatchObject({ region: fixture.region, stsRegion: 'us-west-2' });
    expect(readAccountConnectionDiagnostic(fixture, expected)?.stsRegion).toBeUndefined();
    const query = new URL(accountConnectionAiHref({ ...fixture, stsRegion: 'us-west-2' }), 'https://example.test').searchParams.get('q')!;
    expect(query).toContain(`checkId=${fixture.checkId}`);
    expect(query).toContain(`requestedRegion=${fixture.region}`);
    expect(query).toContain('stsRegion=us-west-2');
  });
  it('projects only the declared metadata and accepts an unknown host identity', () => {
    expect(readAccountConnectionDiagnostic({ ...fixture, message: 'PRIVATE_ERROR', externalId: 'PRIVATE_EXT' }, expected))
      .toEqual(fixture);
    const failedHost = { ...fixture, stage: 'host_identity', code: 'host_identity_unavailable', hostTaskRoleArn: null, awsRequestId: null };
    expect(readAccountConnectionDiagnostic(failedHost, expected)).toEqual(failedHost);
  });
  it.each([
    { code: 'raw: PRIVATE_ERROR' }, { stage: 'anything' }, { checkId: 'id\n/ops secret' },
    { checkedAt: 'not-a-date' }, { accountId: '333333333333' }, { region: 'us-east-1' },
    { stsRegion: 'PRIVATE_INVALID_REGION' }, { stsRegion: 1 },
    { roleArn: 'arn:aws:iam::222222222222:role/Administrator' }, { hostTaskRoleArn: 'PRIVATE_EXT' },
    { awsRequestId: 'Authorization: PRIVATE_TOKEN' }, { durationMs: -1 }, { durationMs: Infinity },
    { externalIdProvided: false }, { registrationEnabled: 'true' }, { verified: true },
    { code: 'verified', verified: false },
  ])('rejects invalid or mismatched metadata: %j', (change) => {
    expect(readAccountConnectionDiagnostic({ ...fixture, ...change }, expected)).toBeNull();
  });
  it('uses an existing section and a single bounded draft with no free-form server fields', () => {
    expect(SECTIONS.some(section => section.key === 'security' && section.active)).toBe(true);
    const input = { ...fixture, checkId: 'a'.repeat(128), awsRequestId: 'b'.repeat(128),
      message: 'PRIVATE_ERROR', externalId: 'PRIVATE_EXT', password: 'PRIVATE_PASSWORD' };
    const url = new URL(accountConnectionAiHref(input), 'https://example.test');
    const query = url.searchParams.get('q')!;
    expect(url.pathname).toBe('/assistant');
    expect(query.startsWith('/security ')).toBe(true);
    expect(query.length).toBeLessThanOrEqual(500);
    expect(query).not.toMatch(/[\r\n]|PRIVATE_/);
    expect(query).toContain('read-only');
    expect(query).toContain('access_denied');
    expect(query).toContain('registrationEnabled=false');
  });
  it('offers only target-account guarded read commands with safe output projections', () => {
    const commands = accountConnectionCommands(fixture.accountId, fixture.region)!;
    expect(commands).toContain('sts get-caller-identity');
    expect(commands).toContain('iam get-role --role-name AWSopsReadOnlyRole');
    expect(commands).toContain('cloudformation describe-events --stack-name awsops-readonly-role');
    expect(commands).toContain('--filters FailedEvents=true');
    expect(commands).toContain('OperationEvents');
    expect(commands).not.toMatch(/assume-role|create-|update-|delete-|put-|ExternalId|ResourceProperties|StatusReason|Credentials/);
    expect(accountConnectionCommands("222222222222'; touch /tmp/injected", fixture.region)).toBeNull();
    expect(accountConnectionCommands(fixture.accountId, 'x; echo secret')).toBeNull();
  });
  it('isolates the wrong-account exit from the parent CloudShell session', () => {
    const directory = mkdtempSync(join(tmpdir(), 'connection-command-'));
    try {
      writeFileSync(join(directory, 'aws'), '#!/bin/sh\nprintf "%s\\n" 111111111111\n', { mode: 0o700 });
      const result = spawnSync('bash', ['-c', `${accountConnectionCommands(fixture.accountId, fixture.region)}\nprintf 'PARENT_ALIVE\\n'\n`], {
        env: { ...process.env, PATH: `${directory}:${process.env.PATH}` }, encoding: 'utf8',
      });
      expect(result.status).toBe(0);
      expect(result.stdout).toContain('PARENT_ALIVE');
      expect(result.stderr).toContain('Select the target account');
    } finally { rmSync(directory, { recursive: true, force: true }); }
  });
  it('projects condition operator and key names without selecting condition values', () => {
    const command = accountConnectionCommands(fixture.accountId, fixture.region)!;
    expect(command).toContain('ConditionOperators:keys(Condition');
    expect(command).toContain('ConditionKeys:map(&keys(@),values(Condition');
    expect(command).not.toMatch(/Condition:Condition|StringEquals\\./);
  });
  it.each([
    [10, null, 10], [3, '10', 10], ['PRIVATE_VALUE', 'PRIVATE_HEADER', null],
    [Infinity, '9999', null], [null, '0', null], [{ value: 10 }, '-1', null],
  ])('uses only bounded numeric Retry-After metadata', (body, header, expectedSeconds) => {
    expect(accountConnectionRetryAfter(body, header as string | null)).toBe(expectedSeconds);
  });
});
