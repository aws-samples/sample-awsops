import { describe, it, expect, vi, afterEach } from 'vitest';

const { queryMock } = vi.hoisted(() => ({ queryMock: vi.fn() }));

vi.mock('pg', () => ({
  Pool: class {
    query = (...a: unknown[]) => queryMock(...a);
    end = vi.fn().mockResolvedValue(undefined);
  },
}));
vi.mock('@aws-sdk/client-secrets-manager', () => ({
  SecretsManagerClient: class { send = vi.fn().mockResolvedValue({ SecretString: 'pw' }); },
  GetSecretValueCommand: class {},
}));
vi.mock('@aws-sdk/client-bedrock-runtime', () => ({
  BedrockRuntimeClient: class { send = vi.fn(() => { throw new Error('no network in tests'); }); },
  InvokeModelCommand: class {},
  ConverseStreamCommand: class {},
}));

import {
  isSelectOnly, extractSql, generateSql, selfCorrectSql, runSteampipeQuery,
  steampipeAvailable, _resetForTests,
} from './aws-data';

afterEach(() => {
  queryMock.mockReset();
  _resetForTests();
});

describe('isSelectOnly guard', () => {
  it('accepts plain SELECT / WITH queries (optional trailing semicolon)', () => {
    expect(isSelectOnly('SELECT instance_id FROM aws_ec2_instance LIMIT 10')).toBe(true);
    expect(isSelectOnly('  select name, region from aws_s3_bucket order by name limit 200;')).toBe(true);
    expect(isSelectOnly('WITH t AS (SELECT 1 AS n) SELECT n FROM t')).toBe(true);
  });
  it('accepts column names that merely CONTAIN forbidden words (word-boundary match)', () => {
    expect(isSelectOnly('SELECT create_date, deletion_protection FROM aws_iam_user LIMIT 5')).toBe(true);
    expect(isSelectOnly('SELECT name FROM aws_rds_db_instance OFFSET 10 LIMIT 10')).toBe(true); // offset ≠ set
  });
  it('rejects DML/DDL/COPY/EXECUTE', () => {
    expect(isSelectOnly('DELETE FROM aws_s3_bucket')).toBe(false);
    expect(isSelectOnly('INSERT INTO x VALUES (1)')).toBe(false);
    expect(isSelectOnly('UPDATE x SET a = 1')).toBe(false);
    expect(isSelectOnly('DROP TABLE aws_ec2_instance')).toBe(false);
    expect(isSelectOnly('CREATE TABLE x (a int)')).toBe(false);
    expect(isSelectOnly('COPY x TO stdout')).toBe(false);
    expect(isSelectOnly('EXECUTE stmt')).toBe(false);
    expect(isSelectOnly('EXPLAIN SELECT 1')).toBe(false); // must START with SELECT/WITH
  });
  it('rejects forbidden keywords hidden INSIDE a select', () => {
    expect(isSelectOnly('SELECT * INTO backup FROM aws_iam_user')).toBe(false); // SELECT INTO = DDL
    expect(isSelectOnly('WITH d AS (DELETE FROM x RETURNING id) SELECT * FROM d')).toBe(false); // data-modifying CTE
  });
  it('rejects multi-statement SQL (stacked queries)', () => {
    expect(isSelectOnly('SELECT 1; SELECT 2')).toBe(false);
    expect(isSelectOnly('SELECT 1; DROP TABLE x')).toBe(false);
    expect(isSelectOnly('SELECT 1;;')).toBe(false);
  });
  it('rejects comment-based evasion', () => {
    expect(isSelectOnly('SELECT 1 -- ; DROP TABLE x')).toBe(false);
    expect(isSelectOnly('/* hi */ SELECT 1')).toBe(false);
    expect(isSelectOnly('SELECT /* DROP */ 1')).toBe(false);
  });
  it('rejects empty / non-SQL input', () => {
    expect(isSelectOnly('')).toBe(false);
    expect(isSelectOnly('   ')).toBe(false);
    expect(isSelectOnly('안녕하세요')).toBe(false);
  });
});

describe('extractSql / generateSql — ```sql block extraction', () => {
  it('extracts SQL from a fenced ```sql block with surrounding prose', async () => {
    const send = vi.fn().mockResolvedValue(
      'Here is the query:\n```sql\nSELECT name, region FROM aws_s3_bucket ORDER BY name LIMIT 200\n```\nDone.',
    );
    const sql = await generateSql('S3 버킷 전체 목록', [], 'ko', { send });
    expect(sql).toBe('SELECT name, region FROM aws_s3_bucket ORDER BY name LIMIT 200');
  });
  it('accepts a bare (unfenced) SELECT answer', () => {
    expect(extractSql('SELECT 1')).toBe('SELECT 1');
    expect(extractSql('WITH t AS (SELECT 1) SELECT * FROM t')).toMatch(/^WITH/);
  });
  it('returns null when the model returned no SQL', async () => {
    const send = vi.fn().mockResolvedValue('I cannot answer that question.');
    expect(await generateSql('x', [], 'ko', { send })).toBeNull();
    expect(extractSql('```sql\nDROP TABLE x\n```')).toBeNull(); // not SELECT/WITH-shaped
  });
  it('passes bounded history + the question through to the model', async () => {
    const send = vi.fn().mockResolvedValue('```sql\nSELECT 1\n```');
    const history = Array.from({ length: 10 }, (_, i) => ({ role: (i % 2 ? 'assistant' : 'user') as 'user' | 'assistant', content: `m${i}` }));
    await generateSql('EC2 몇 개야?', history, 'ko', { send });
    const messages = send.mock.calls[0][1] as { role: string; content: string }[];
    expect(messages).toHaveLength(7); // last 6 history + question
    expect(messages[messages.length - 1]).toEqual({ role: 'user', content: 'EC2 몇 개야?' });
  });
  it('returns null instead of throwing when the model call fails', async () => {
    const send = vi.fn().mockRejectedValue(new Error('bedrock down'));
    expect(await generateSql('x', [], 'ko', { send })).toBeNull();
  });
});

describe('selfCorrectSql — one-shot correction with the DB error', () => {
  it('feeds the failed SQL + error back and extracts the corrected block', async () => {
    const send = vi.fn().mockResolvedValue('```sql\nSELECT instance_id FROM aws_ec2_instance LIMIT 10\n```');
    const fixed = await selfCorrectSql('EC2 목록', 'SELECT bogus_col FROM aws_ec2_instance', 'column "bogus_col" does not exist', { send });
    expect(fixed).toBe('SELECT instance_id FROM aws_ec2_instance LIMIT 10');
    const messages = send.mock.calls[0][1] as { role: string; content: string }[];
    expect(messages.some((m) => m.content.includes('SELECT bogus_col FROM aws_ec2_instance'))).toBe(true);
    expect(messages.some((m) => m.content.includes('column "bogus_col" does not exist'))).toBe(true);
  });
});

describe('runSteampipeQuery — guard + row cap (pg mocked)', () => {
  it('caps rows at 200 and flags truncation', async () => {
    queryMock.mockResolvedValue({ rows: Array.from({ length: 250 }, (_, i) => ({ i })) });
    const r = await runSteampipeQuery('SELECT i FROM aws_ec2_instance');
    expect(r.rows).toHaveLength(200);
    expect(r.rowCount).toBe(200);
    expect(r.truncated).toBe(true);
  });
  it('returns small result sets untruncated', async () => {
    queryMock.mockResolvedValue({ rows: [{ a: 1 }, { a: 2 }] });
    const r = await runSteampipeQuery('SELECT a FROM aws_vpc');
    expect(r).toEqual({ rows: [{ a: 1 }, { a: 2 }], rowCount: 2, truncated: false });
  });
  it('rejects guarded SQL WITHOUT touching the database', async () => {
    await expect(runSteampipeQuery('DROP TABLE aws_ec2_instance')).rejects.toThrow(/only a single SELECT/i);
    await expect(runSteampipeQuery('SELECT 1; DELETE FROM x')).rejects.toThrow();
    expect(queryMock).not.toHaveBeenCalled();
  });
  it('propagates the DB error message (self-correction input)', async () => {
    queryMock.mockRejectedValue(new Error('column "nope" does not exist'));
    await expect(runSteampipeQuery('SELECT nope FROM aws_vpc')).rejects.toThrow('column "nope" does not exist');
  });
});

describe('steampipeAvailable — probe + cache', () => {
  it('true when SELECT 1 succeeds, cached (no second probe)', async () => {
    queryMock.mockResolvedValue({ rows: [{ '?column?': 1 }] });
    expect(await steampipeAvailable()).toBe(true);
    expect(await steampipeAvailable()).toBe(true);
    expect(queryMock).toHaveBeenCalledTimes(1);
  });
  it('false (not a throw) when the probe fails', async () => {
    queryMock.mockRejectedValue(new Error('ENOTFOUND steampipe.awsops-v2-stg.internal'));
    expect(await steampipeAvailable()).toBe(false);
  });
});
