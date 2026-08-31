import { describe, it, expect, vi, beforeEach } from 'vitest';

const query = vi.fn();
vi.mock('@/lib/db', () => ({ getPool: () => ({ query: (...a: unknown[]) => query(...a) }) }));

const lambdaSend = vi.fn();
vi.mock('@aws-sdk/client-lambda', () => ({
  LambdaClient: class { send = lambdaSend; },
  InvokeCommand: class { constructor(public input: unknown) {} },
}));

beforeEach(() => {
  query.mockReset();
  lambdaSend.mockReset();
  delete process.env.SG_RULE_ATHENA_BROKER_ARN;
});

describe('validateFlowSourceInput', () => {
  it('accepts a well-formed input', async () => {
    const { validateFlowSourceInput } = await import('./sg-rules');
    const errors = validateFlowSourceInput({
      accountId: '123456789012', region: 'ap-northeast-2', workgroup: 'primary',
      databaseName: 'vpc_flow_logs_db', tableName: 'flow_logs',
    });
    expect(errors).toEqual([]);
  });

  it('rejects a non-allowlisted identifier (defense against injection into Glue/Athena calls)', async () => {
    const { validateFlowSourceInput } = await import('./sg-rules');
    const errors = validateFlowSourceInput({
      accountId: '123', region: 'not-a-region', workgroup: 'ok',
      databaseName: 'db; DROP TABLE x', tableName: 'tbl`; rm -rf',
    });
    expect(errors.length).toBeGreaterThan(0);
    expect(errors.some((e) => e.includes('accountId'))).toBe(true);
    expect(errors.some((e) => e.includes('region'))).toBe(true);
    expect(errors.some((e) => e.includes('databaseName'))).toBe(true);
    expect(errors.some((e) => e.includes('tableName'))).toBe(true);
  });
});

describe('upsertFlowSource', () => {
  it('rejects invalid input before ever touching the DB (admin-only mutation must still validate shape)', async () => {
    const { upsertFlowSource } = await import('./sg-rules');
    await expect(upsertFlowSource(
      { accountId: 'bad', region: 'bad', workgroup: 'ok', databaseName: 'ok', tableName: 'ok' },
      'sub-1',
    )).rejects.toThrow(/invalid flow source/);
    expect(query).not.toHaveBeenCalled();
  });

  it('upserts via bound parameters, never string-concatenated identifiers', async () => {
    query.mockResolvedValue({ rows: [{ id: 1, account_id: '123456789012', region: 'ap-northeast-2' }] });
    const { upsertFlowSource } = await import('./sg-rules');
    await upsertFlowSource({
      accountId: '123456789012', region: 'ap-northeast-2', workgroup: 'primary',
      databaseName: 'db1', tableName: 'tbl1', enabled: true,
    }, 'sub-1');
    expect(query).toHaveBeenCalledTimes(1);
    const [sql, params] = query.mock.calls[0];
    expect(sql).toContain('$1');
    expect(params).toContain('123456789012');
    expect(params).toContain('db1');
  });
});

describe('validateFlowSourceViaBroker', () => {
  it('returns unconfigured when the broker is not deployed (feature flag off) — never claims valid', async () => {
    const { validateFlowSourceViaBroker } = await import('./sg-rules');
    const result = await validateFlowSourceViaBroker({
      accountId: '123456789012', region: 'ap-northeast-2', workgroup: 'primary',
      databaseName: 'db1', tableName: 'tbl1',
    });
    expect(result.ok).toBe(false);
    expect(result.status).toBe('unconfigured');
    expect(lambdaSend).not.toHaveBeenCalled();
  });

  it('returns invalid for a malformed input without invoking the broker', async () => {
    process.env.SG_RULE_ATHENA_BROKER_ARN = 'arn:aws:lambda:ap-northeast-2:123456789012:function:broker';
    const { validateFlowSourceViaBroker } = await import('./sg-rules');
    const result = await validateFlowSourceViaBroker({
      accountId: 'bad', region: 'ap-northeast-2', workgroup: 'primary', databaseName: 'db1', tableName: 'tbl1',
    });
    expect(result.status).toBe('invalid');
    expect(lambdaSend).not.toHaveBeenCalled();
  });

  it('invokes the broker and returns ok on a successful validation', async () => {
    process.env.SG_RULE_ATHENA_BROKER_ARN = 'arn:aws:lambda:ap-northeast-2:123456789012:function:broker';
    lambdaSend.mockResolvedValue({
      Payload: Buffer.from(JSON.stringify({ ok: true, schemaFields: ['srcaddr', 'dstaddr'], partitionStrategy: 'projection' })),
    });
    const { validateFlowSourceViaBroker } = await import('./sg-rules');
    const result = await validateFlowSourceViaBroker({
      accountId: '123456789012', region: 'ap-northeast-2', workgroup: 'primary', databaseName: 'db1', tableName: 'tbl1',
    });
    expect(result.ok).toBe(true);
    expect(result.status).toBe('valid');
    expect(result.schemaFields).toEqual(['srcaddr', 'dstaddr']);
  });

  it('returns error on a broker invoke failure, never silently claims valid', async () => {
    process.env.SG_RULE_ATHENA_BROKER_ARN = 'arn:aws:lambda:ap-northeast-2:123456789012:function:broker';
    lambdaSend.mockRejectedValue(new Error('AccessDenied'));
    const { validateFlowSourceViaBroker } = await import('./sg-rules');
    const result = await validateFlowSourceViaBroker({
      accountId: '123456789012', region: 'ap-northeast-2', workgroup: 'primary', databaseName: 'db1', tableName: 'tbl1',
    });
    expect(result.ok).toBe(false);
    expect(result.status).toBe('error');
  });
});

describe('listRules', () => {
  it('classifies a rule with no enabled flow source as not_configured', async () => {
    query
      .mockResolvedValueOnce({ rows: [{
        account_id: '123456789012', region: 'ap-northeast-2', rule_id: 'sgr-1', group_id: 'sg-1',
        is_egress: false, protocol: 'tcp', from_port: 443, to_port: 443, peer_kind: 'cidr',
        peer_value: '10.0.0.0/8', description: null,
        compatible_match_count: 0, overlap_match_count: 0, last_observed_at: null,
        has_source: false, any_unassessable: false,
      }] })
      .mockResolvedValueOnce({ rows: [{ n: 1 }] });
    const { listRules } = await import('./sg-rules');
    const { rows, total } = await listRules({});
    expect(total).toBe(1);
    expect(rows[0].status).toBe('not_configured');
  });

  it('classifies observed_compatible when a source exists and there is compatible evidence', async () => {
    query
      .mockResolvedValueOnce({ rows: [{
        account_id: '123456789012', region: 'ap-northeast-2', rule_id: 'sgr-2', group_id: 'sg-1',
        is_egress: false, protocol: 'tcp', from_port: 443, to_port: 443, peer_kind: 'cidr',
        peer_value: '10.0.0.0/8', description: null,
        compatible_match_count: 5, overlap_match_count: 0, last_observed_at: '2026-08-01T00:00:00Z',
        has_source: true, any_unassessable: false,
      }] })
      .mockResolvedValueOnce({ rows: [{ n: 1 }] });
    const { listRules } = await import('./sg-rules');
    const { rows } = await listRules({});
    expect(rows[0].status).toBe('observed_compatible');
  });

  it('rejects an invalid days value by falling back to the 90-day default', async () => {
    query.mockResolvedValueOnce({ rows: [] }).mockResolvedValueOnce({ rows: [{ n: 0 }] });
    const { listRules } = await import('./sg-rules');
    // @ts-expect-error intentionally invalid
    await listRules({ days: 999 });
    const [sql, params] = query.mock.calls[0];
    expect(sql).toContain('act');
    expect(params).toContain(90);
  });

  it('gap 5: round-trips vpc_id from sg_rule_inventory into RuleRow', async () => {
    query
      .mockResolvedValueOnce({ rows: [{
        account_id: '123456789012', region: 'ap-northeast-2', rule_id: 'sgr-1', group_id: 'sg-1',
        vpc_id: 'vpc-aaa111', is_egress: false, protocol: 'tcp', from_port: 443, to_port: 443,
        peer_kind: 'cidr', peer_value: '10.0.0.0/8', description: null,
        compatible_match_count: 0, overlap_match_count: 0, last_observed_at: null,
        has_source: false, any_unassessable: false,
      }] })
      .mockResolvedValueOnce({ rows: [{ n: 1 }] });
    const { listRules } = await import('./sg-rules');
    const { rows } = await listRules({});
    expect(rows[0].vpc_id).toBe('vpc-aaa111');
  });

  it('gap 5: a row with no known VPC round-trips as null, never fabricated', async () => {
    query
      .mockResolvedValueOnce({ rows: [{
        account_id: '123456789012', region: 'ap-northeast-2', rule_id: 'sgr-2', group_id: 'sg-2',
        vpc_id: null, is_egress: false, protocol: 'tcp', from_port: 443, to_port: 443,
        peer_kind: 'cidr', peer_value: '10.0.0.0/8', description: null,
        compatible_match_count: 0, overlap_match_count: 0, last_observed_at: null,
        has_source: false, any_unassessable: false,
      }] })
      .mockResolvedValueOnce({ rows: [{ n: 1 }] });
    const { listRules } = await import('./sg-rules');
    const { rows } = await listRules({});
    expect(rows[0].vpc_id).toBeNull();
  });

  it('gap 5: filters on vpcId via a bound parameter', async () => {
    query.mockResolvedValueOnce({ rows: [] }).mockResolvedValueOnce({ rows: [{ n: 0 }] });
    const { listRules } = await import('./sg-rules');
    await listRules({ vpcId: 'vpc-aaa111' });
    const [sql, params] = query.mock.calls[0];
    expect(sql).toContain('ri.vpc_id =');
    expect(params).toContain('vpc-aaa111');
  });
});

describe('rulesToCsv', () => {
  it('escapes commas/quotes and includes the header row', async () => {
    const { rulesToCsv } = await import('./sg-rules');
    const csv = rulesToCsv([{
      account_id: '123456789012', region: 'ap-northeast-2', rule_id: 'sgr-1', group_id: 'sg-1',
      is_egress: false, protocol: 'tcp', from_port: 443, to_port: 443, peer_kind: 'cidr',
      peer_value: '10.0.0.0/8', description: 'has, a comma',
      compatible_match_count: 1, overlap_match_count: 0, last_observed_at: null, status: 'observed_compatible',
    }]);
    expect(csv.split('\n')[0]).toContain('account_id');
    expect(csv).toContain('sgr-1');
  });
});
