import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EC2Client, DescribeVpcPeeringConnectionsCommand, DescribeTransitGatewayAttachmentsCommand } from '@aws-sdk/client-ec2';
import { STSClient, AssumeRoleCommand } from '@aws-sdk/client-sts';

const mocks = vi.hoisted(() => ({
  account: vi.fn(), host: vi.fn(), current: vi.fn(), query: vi.fn(), connect: vi.fn(),
  release: vi.fn(), on: vi.fn(), off: vi.fn(),
}));
vi.mock('@/lib/accounts', () => ({ getAccount: mocks.account, getHostAccount: mocks.host }));
vi.mock('@/lib/account', () => ({ currentAccountId: mocks.current }));
vi.mock('@/lib/db', () => ({ getPool: () => ({ connect: mocks.connect }) }));
vi.mock('@/lib/aws-assume', async importOriginal => {
  const actual = await importOriginal<typeof import('./aws-assume')>();
  return { ...actual, assumedClient: vi.fn(actual.assumedClient) };
});

const HOST = '111111111111', MEMBER = '222222222222';
const VPC = 'vpc-11111111', OTHER = 'vpc-22222222';
const REGION = 'us-east-1', TGW = 'tgw-11111111111111111';
const input = { account: 'self', region: REGION, vpcId: VPC };
const account = (id = HOST, overrides = {}) => ({
  accountId: id, isHost: id === HOST, enabled: true, roleName: 'AWSopsReadOnlyRole',
  externalId: null, region: REGION, ...overrides,
});
const inventory = (owner = 'self', overrides = {}) => ({
  account_id: owner, region: REGION, resource_id: VPC,
  name: 'Selected VPC', cidr: '10.0.0.0/16', owner_id: owner === 'self' ? HOST : owner, ...overrides,
});
const side = (vpcId = VPC, owner = HOST, region = REGION) => ({ VpcId: vpcId, OwnerId: owner, Region: region, CidrBlock: '10.0.0.0/16' });
const peering = (id = 'pcx-11111111', requester = side(), accepter = side(OTHER, MEMBER)) => ({
  VpcPeeringConnectionId: id, RequesterVpcInfo: requester, AccepterVpcInfo: accepter, Status: { Code: 'active' },
});
const attachment = (overrides = {}) => ({
  TransitGatewayId: TGW, TransitGatewayOwnerId: HOST, TransitGatewayAttachmentId: 'tgw-attach-11111111111111111',
  ResourceId: VPC, ResourceType: 'vpc', ResourceOwnerId: HOST, State: 'available',
  Association: { TransitGatewayRouteTableId: 'tgw-rtb-11111111111111111' }, ...overrides,
});
function hasFilter(command: { input: unknown }, name: string, value?: string) {
  const filters = (command.input as { Filters?: { Name: string; Values: string[] }[] }).Filters;
  return filters?.some(f => f.Name === name && (value === undefined || f.Values.includes(value)));
}
const sdk = () => vi.mocked(EC2Client.prototype.send);
const empty = (command: unknown) => command instanceof DescribeVpcPeeringConnectionsCommand
  ? { VpcPeeringConnections: [] } : { TransitGatewayAttachments: [] };
let load: typeof import('./vpc-connectivity').getVpcConnectivity;

beforeEach(async () => {
  vi.resetModules();
  vi.clearAllMocks();
  mocks.current.mockReturnValue(HOST);
  mocks.host.mockResolvedValue(account());
  mocks.account.mockImplementation(async id => account(id));
  mocks.connect.mockResolvedValue({ query: mocks.query, release: mocks.release, on: mocks.on, removeListener: mocks.off });
  mocks.query.mockResolvedValue({ rows: [inventory()] });
  vi.spyOn(STSClient.prototype, 'send').mockImplementation(async command => command instanceof AssumeRoleCommand
    ? { Credentials: { AccessKeyId: 'test-access', SecretAccessKey: 'test-secret', SessionToken: 'test-token' },
      AssumedRoleUser: { Arn: `arn:aws:sts::${MEMBER}:assumed-role/AWSopsReadOnlyRole/session` } }
    : { Account: HOST });
  vi.spyOn(STSClient.prototype, 'destroy').mockImplementation(() => {});
  vi.spyOn(EC2Client.prototype, 'destroy').mockImplementation(() => {});
  vi.spyOn(EC2Client.prototype, 'send').mockImplementation(async command => empty(command));
  load = (await import('./vpc-connectivity')).getVpcConnectivity;
});
afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); });

describe('scoped configuration lookup', () => {
  it.each([MEMBER, undefined, 'invalid'])('discloses shared or unknown VPC ownership (%s) without changing the authorized account', async ownerId => {
    mocks.query.mockResolvedValue({ rows: [inventory('self', { owner_id: ownerId })] });
    const result = await load(input);
    expect(result.incompleteSources).toContain('source');
    expect(result.source).toMatchObject({ accountId: HOST, ownerId: ownerId === MEMBER ? MEMBER : null });
    expect(STSClient.prototype.send).not.toHaveBeenCalled();
    expect(sdk().mock.calls.every(([c]) =>
      !hasFilter(c, 'requester-vpc-info.owner-id', MEMBER) && !hasFilter(c, 'resource-owner-id', MEMBER))).toBe(true);
  });

  it('does not replay an owned-VPC cached absence after ownership metadata changes', async () => {
    expect((await load(input)).incompleteSources).toEqual([]);
    mocks.query.mockResolvedValue({ rows: [inventory('self', { owner_id: MEMBER })] });
    const result = await load(input);
    expect(result.incompleteSources).toContain('source');
    expect(sdk()).toHaveBeenCalledTimes(6);
  });

  it('retries an incomplete read immediately and caches the recovered complete result', async () => {
    let denied = true;
    sdk().mockImplementation(async command => {
      if (hasFilter(command, 'requester-vpc-info.vpc-id')) {
        if (denied) throw new Error('denied');
        return { VpcPeeringConnections: [peering()] };
      }
      return empty(command);
    });
    expect((await load(input)).incompleteSources).toEqual(['peering-requester']);
    denied = false;
    const recovered = await load(input);
    expect(recovered.incompleteSources).toEqual([]);
    expect(recovered.peerings).toHaveLength(1);
    expect(await load(input)).toEqual(recovered);
    expect(sdk()).toHaveBeenCalledTimes(6);
  });

  it('timestamps a completed lookup after the last response arrives', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-09-16T10:00:00Z'));
    sdk().mockImplementation(async command => {
      await new Promise(resolve => setTimeout(resolve, 3000));
      return empty(command);
    });
    const pending = load(input);
    await vi.advanceTimersByTimeAsync(3000);
    expect((await pending).checkedAt).toBe('2026-09-16T10:00:03.000Z');
  });

  it('reads requester and accepter independently, merging only exactly scoped connections', async () => {
    sdk().mockImplementation(async command => {
      if (hasFilter(command, 'requester-vpc-info.vpc-id')) return { VpcPeeringConnections: [
        peering(), peering('pcx-33333333', side(VPC, MEMBER)),
        peering('pcx-44444444', side(VPC, HOST, 'us-west-2')),
      ] };
      if (hasFilter(command, 'accepter-vpc-info.vpc-id')) return { VpcPeeringConnections: [
        peering('pcx-22222222', side(OTHER, MEMBER), side()),
      ] };
      return empty(command);
    });
    const result = await load(input);
    expect(result.source).toEqual({ vpcId: VPC, accountId: HOST, ownerId: HOST, region: REGION, name: 'Selected VPC', cidr: '10.0.0.0/16' });
    expect(result.peerings.map(p => p.id)).toEqual(['pcx-11111111', 'pcx-22222222']);
    expect(result.peerings[0].peer).toEqual({ vpcId: OTHER, accountId: MEMBER, region: REGION, cidr: '10.0.0.0/16' });
    expect(result.incompleteSources).toContain('peering-requester');
    const commands = sdk().mock.calls.map(([c]) => c);
    expect(commands.filter(c => hasFilter(c, 'requester-vpc-info.owner-id', HOST))).toHaveLength(1);
    expect(commands.filter(c => hasFilter(c, 'accepter-vpc-info.owner-id', HOST))).toHaveLength(1);
    expect(commands.every(c => c instanceof DescribeVpcPeeringConnectionsCommand || c instanceof DescribeTransitGatewayAttachmentsCommand)).toBe(true);
    expect(STSClient.prototype.send).not.toHaveBeenCalledWith(expect.any(AssumeRoleCommand), expect.anything());
    expect(EC2Client.prototype.destroy).toHaveBeenCalledTimes(1);
  });

  it('queries only verified TGWs and never infers routes or includes non-VPC/source attachments', async () => {
    const neighbor = attachment({ ResourceId: OTHER, ResourceOwnerId: MEMBER, TransitGatewayAttachmentId: 'tgw-attach-22222222222222222' });
    sdk().mockImplementation(async command => {
      if (hasFilter(command, 'resource-id', VPC)) return { TransitGatewayAttachments: [
        attachment(), attachment({ ResourceOwnerId: MEMBER, TransitGatewayId: 'tgw-33333333333333333', TransitGatewayAttachmentId: 'tgw-attach-33333333333333333' }),
      ] };
      if (hasFilter(command, 'transit-gateway-id')) return { TransitGatewayAttachments: [
        attachment(), neighbor, neighbor, attachment({ ResourceType: 'vpn' }),
        attachment({ ResourceId: OTHER, TransitGatewayId: 'tgw-44444444444444444' }),
      ] };
      return empty(command);
    });
    const result = await load(input);
    expect(result.transitGateways).toEqual([{
      id: TGW, attachmentId: 'tgw-attach-11111111111111111', state: 'available',
      routeTableId: 'tgw-rtb-11111111111111111',
      peers: [{ vpcId: OTHER, accountId: MEMBER, state: 'available', attachmentId: 'tgw-attach-22222222222222222', routeTableId: 'tgw-rtb-11111111111111111' }],
    }]);
    expect(result.incompleteSources).toEqual(expect.arrayContaining(['tgw-attachments', 'tgw-peers']));
    const neighborCalls = sdk().mock.calls.filter(([c]) => hasFilter(c, 'transit-gateway-id'));
    expect(neighborCalls).toHaveLength(1);
    expect(neighborCalls[0][0].input).toMatchObject({ Filters: expect.arrayContaining([
      { Name: 'transit-gateway-id', Values: [TGW] }, { Name: 'resource-type', Values: ['vpc'] },
    ]) });
  });

  it('preserves successful pages when either peering direction or TGW peers subsequently fails', async () => {
    const tokens: string[] = [];
    sdk().mockImplementation(async command => {
      const token = (command.input as { NextToken?: string }).NextToken;
      if (token) { tokens.push(token); throw new Error('private provider details'); }
      if (hasFilter(command, 'requester-vpc-info.vpc-id')) return { VpcPeeringConnections: [peering()], NextToken: 'requester-next' };
      if (hasFilter(command, 'accepter-vpc-info.vpc-id')) return { VpcPeeringConnections: [peering('pcx-22222222', side(OTHER, MEMBER), side())], NextToken: 'accepter-next' };
      if (hasFilter(command, 'resource-id')) return { TransitGatewayAttachments: [attachment()], NextToken: 'source-next' };
      return { TransitGatewayAttachments: [attachment({ ResourceId: OTHER, TransitGatewayAttachmentId: 'tgw-attach-22222222222222222' })], NextToken: 'peers-next' };
    });
    const result = await load(input);
    expect(result.peerings).toHaveLength(2);
    expect(result.transitGateways[0].peers).toHaveLength(1);
    expect(result.incompleteSources).toEqual(['peering-requester', 'peering-accepter', 'tgw-attachments', 'tgw-peers']);
    expect(JSON.stringify(result)).not.toContain('private provider');
    expect(tokens.sort()).toEqual(['accepter-next', 'peers-next', 'requester-next', 'source-next']);
  });

  it('enforces independent page limits and repeated-token termination', async () => {
    sdk().mockImplementation(async command => {
      if (hasFilter(command, 'requester-vpc-info.vpc-id')) return { VpcPeeringConnections: [peering()], NextToken: String(sdk().mock.calls.length) };
      if (hasFilter(command, 'accepter-vpc-info.vpc-id')) return { VpcPeeringConnections: [], NextToken: 'repeated' };
      return empty(command);
    });
    const result = await load(input);
    expect(result.peerings).toHaveLength(1);
    expect(result.incompleteSources).toEqual(['peering-requester', 'peering-accepter']);
    expect(sdk().mock.calls.filter(([c]) => hasFilter(c, 'requester-vpc-info.vpc-id'))).toHaveLength(5);
    expect(sdk().mock.calls.filter(([c]) => hasFilter(c, 'accepter-vpc-info.vpc-id'))).toHaveLength(2);
  });

  it('bounds oversized pages without treating omitted records as empty success', async () => {
    sdk().mockImplementation(async command => hasFilter(command, 'requester-vpc-info.vpc-id')
      ? { VpcPeeringConnections: Array.from({ length: 501 }, (_, i) => peering(`pcx-${i.toString(16).padStart(8, '0')}`)) } : empty(command));
    const result = await load(input);
    expect(result.peerings).toHaveLength(500);
    expect(result.incompleteSources).toEqual(['peering-requester']);
  });

  it('discloses missing collections and malformed records; never trusts missing resource owners', async () => {
    sdk().mockImplementation(async command => hasFilter(command, 'requester-vpc-info.vpc-id')
      ? { VpcPeeringConnections: [null, {}, peering('pcx-11111111', side(), { ...side(OTHER), OwnerId: undefined } as never)] }
      : hasFilter(command, 'resource-id') ? { TransitGatewayAttachments: [attachment({ ResourceOwnerId: undefined })] } : {});
    const result = await load(input);
    expect(result.peerings).toEqual([]);
    expect(result.transitGateways).toEqual([]);
    expect(result.incompleteSources).toEqual(['peering-requester', 'peering-accepter', 'tgw-attachments']);
  });

  it('rejects total AWS failure with a fixed code', async () => {
    sdk().mockRejectedValue(new Error('token=test-secret provider failure'));
    await expect(load(input)).rejects.toMatchObject({ code: 'lookup_failed' });
  });
});

describe('identity, caching and bounds', () => {
  it.each([
    { account: '__all__' }, { account: '' }, { account: '123' }, { region: '' },
    { region: 'us-east-999' }, { region: 'cn-north-1' }, { region: 'us-gov-west-1' },
    { region: 'us-east-1;select' }, { vpcId: 'vpc-abc' }, { vpcId: 'vpc-123456789012345678' },
  ])('rejects invalid requests before accessing dependencies: %j', async overrides => {
    await expect(load({ ...input, ...overrides })).rejects.toMatchObject({ code: 'invalid_request' });
    expect(mocks.connect).not.toHaveBeenCalled();
    expect(sdk()).not.toHaveBeenCalled();
  });

  it.each([undefined, account(MEMBER, { enabled: false }), account(MEMBER, { isHost: true })])('rejects unavailable foreign registry entries', async entry => {
    mocks.account.mockImplementation(async id => id === HOST ? account() : entry);
    await expect(load({ ...input, account: MEMBER })).rejects.toMatchObject({ code: 'account_unavailable' });
    expect(sdk()).not.toHaveBeenCalled();
  });

  it('uses exact inventory ownership, never a foreign JSON account claim or host fallback', async () => {
    mocks.query.mockResolvedValue({ rows: [] });
    await expect(load({ ...input, account: MEMBER })).rejects.toMatchObject({ code: 'not_found' });
    const [sql, values] = mocks.query.mock.calls[0];
    expect(sql).toMatch(/account_id = \$1/);
    expect(sql).toMatch(/region = \$2/);
    expect(sql).toMatch(/resource_id = \$3/);
    expect(sql).not.toMatch(/data\s*->>?\s*'account_id'/);
    expect(values).toEqual([MEMBER, REGION, VPC]);
    expect(sdk()).not.toHaveBeenCalled();
  });

  it.each([
    [inventory(MEMBER)], [inventory('self', { region: 'us-west-2' })],
    [inventory('self', { resource_id: OTHER })], [inventory(), inventory()],
  ])('rejects conflicting or ambiguous inventory identity', async (...rows) => {
    mocks.query.mockResolvedValue({ rows });
    await expect(load(input)).rejects.toMatchObject({ code: 'not_found' });
    expect(sdk()).not.toHaveBeenCalled();
  });

  it('canonicalizes a numeric host to self and can resolve host identity from the registry', async () => {
    mocks.current.mockReturnValue('self');
    mocks.query.mockResolvedValueOnce({ rows: [{ account_id: HOST }] });
    await load({ ...input, account: HOST });
    expect(mocks.query.mock.calls[1][1]).toEqual(['self', REGION, VPC]);
    expect(STSClient.prototype.send).not.toHaveBeenCalledWith(expect.any(AssumeRoleCommand), expect.anything());
  });

  it('uses bounded member credentials, explicit region and no unbounded foreign helper path', async () => {
    mocks.query.mockResolvedValue({ rows: [inventory(MEMBER)] });
    mocks.account.mockImplementation(async id => account(id, id === MEMBER ? { externalId: 'private-external' } : {}));
    await load({ ...input, account: MEMBER });
    const { assumedClient } = await import('./aws-assume');
    expect(vi.mocked(assumedClient).mock.calls.every(([id]) => id === 'self')).toBe(true);
    expect(assumedClient).toHaveBeenCalledWith('self', EC2Client, expect.objectContaining({
      region: REGION, maxAttempts: 2, credentials: expect.objectContaining({ accessKeyId: 'test-access' }),
    }));
    expect(STSClient.prototype.send).toHaveBeenCalledWith(expect.objectContaining({
      input: expect.objectContaining({ RoleArn: `arn:aws:iam::${MEMBER}:role/AWSopsReadOnlyRole`, ExternalId: 'private-external' }),
    }), expect.objectContaining({ abortSignal: expect.any(AbortSignal) }));
    expect(STSClient.prototype.destroy).toHaveBeenCalledTimes(1);
  });

  it('deduplicates in flight, retains fetch timestamp, expires at four minutes and isolates all scope dimensions', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-09-16T10:00:00Z'));
    const [first, second] = await Promise.all([load(input), load(input)]);
    expect(first).toEqual(second);
    expect(sdk()).toHaveBeenCalledTimes(3);
    vi.setSystemTime(new Date('2026-09-16T10:03:59Z'));
    expect((await load({ ...input, account: HOST })).checkedAt).toBe('2026-09-16T10:00:00.000Z');
    expect(sdk()).toHaveBeenCalledTimes(3);
    vi.setSystemTime(new Date('2026-09-16T10:04:00Z'));
    expect((await load(input)).checkedAt).toBe('2026-09-16T10:04:00.000Z');
    expect(sdk()).toHaveBeenCalledTimes(6);
    for (const overrides of [{ account: MEMBER }, { region: 'us-west-2' }, { vpcId: OTHER }]) {
      const scoped = { ...input, ...overrides };
      mocks.query.mockResolvedValue({ rows: [inventory(scoped.account, { region: scoped.region, resource_id: scoped.vpcId })] });
      await load(scoped);
    }
    expect(sdk()).toHaveBeenCalledTimes(15);
  });

  it('rechecks registry and inventory even on a cache hit', async () => {
    mocks.query.mockResolvedValue({ rows: [inventory(MEMBER)] });
    await load({ ...input, account: MEMBER });
    mocks.account.mockImplementation(async id => account(id, id === MEMBER ? { enabled: false } : {}));
    await expect(load({ ...input, account: MEMBER })).rejects.toMatchObject({ code: 'account_unavailable' });
    mocks.account.mockImplementation(async id => account(id));
    mocks.query.mockResolvedValue({ rows: [] });
    await expect(load({ ...input, account: MEMBER })).rejects.toMatchObject({ code: 'not_found' });
    expect(sdk()).toHaveBeenCalledTimes(3);
  });

  it('returns partial pages at the shared deadline, aborts requests, and destroys its client', async () => {
    vi.useFakeTimers();
    sdk().mockImplementation(async command => {
      if (hasFilter(command, 'requester-vpc-info.vpc-id') && !(command.input as { NextToken?: string }).NextToken) {
        return { VpcPeeringConnections: [peering()], NextToken: 'next' };
      }
      return new Promise(() => {});
    });
    const pending = load(input);
    await vi.advanceTimersByTimeAsync(18_000);
    const result = await pending;
    expect(result.peerings).toHaveLength(1);
    expect(result.incompleteSources).toEqual(['peering-requester', 'peering-accepter', 'tgw-attachments']);
    expect(sdk().mock.calls.every(([, options]) => (options as { abortSignal: AbortSignal }).abortSignal.aborted)).toBe(true);
    expect(EC2Client.prototype.destroy).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
    sdk().mockImplementation(async command => empty(command));
    const recovered = await load(input);
    expect(recovered.incompleteSources).toEqual([]);
    expect(recovered.peerings).toEqual([]);
    expect(EC2Client.prototype.destroy).toHaveBeenCalledTimes(2);
  });

  it('does not start abandoned SQL after a delayed pool checkout', async () => {
    vi.useFakeTimers();
    let releaseCheckout!: (value: unknown) => void;
    mocks.connect.mockReturnValue(new Promise(resolve => { releaseCheckout = resolve; }));
    const pending = load(input);
    const rejected = expect(pending).rejects.toMatchObject({ code: 'lookup_failed' });
    await vi.advanceTimersByTimeAsync(18_000);
    await rejected;
    releaseCheckout({ query: mocks.query, release: mocks.release });
    await vi.advanceTimersByTimeAsync(0);
    expect(mocks.query).not.toHaveBeenCalled();
    expect(mocks.release).toHaveBeenCalled();
    expect(sdk()).not.toHaveBeenCalled();
  });

  it('discards an inventory socket when a running query exceeds the shared deadline', async () => {
    vi.useFakeTimers();
    mocks.query.mockReturnValue(new Promise(() => {}));
    const rejected = expect(load(input)).rejects.toMatchObject({ code: 'lookup_failed' });
    await vi.advanceTimersByTimeAsync(18_000);
    await rejected;
    expect(mocks.release).toHaveBeenCalledWith(true);
    expect(sdk()).not.toHaveBeenCalled();
  });

  it('rejects ambiguous fallback host keys before authorizing any account', async () => {
    mocks.current.mockReturnValue('self');
    mocks.query.mockResolvedValueOnce({ rows: [{ account_id: HOST }, { account_id: MEMBER }] });
    await expect(load(input)).rejects.toMatchObject({ code: 'account_unavailable' });
    expect(mocks.account).not.toHaveBeenCalled();
  });

  it('cancels the fallback host lookup itself without leaking a pool slot', async () => {
    vi.useFakeTimers();
    mocks.current.mockReturnValue('self');
    mocks.query.mockReturnValue(new Promise(() => {}));
    const rejected = expect(load(input)).rejects.toMatchObject({ code: 'lookup_failed' });
    await vi.advanceTimersByTimeAsync(18_000);
    await rejected;
    expect(mocks.query.mock.calls[0][0]).toMatch(/FROM accounts WHERE is_host/);
    expect(mocks.release).toHaveBeenCalledWith(true);
    expect(mocks.account).not.toHaveBeenCalled();
  });

  it('never starts EC2 after a credential request settles beyond the deadline', async () => {
    vi.useFakeTimers();
    mocks.query.mockResolvedValue({ rows: [inventory(MEMBER)] });
    let settle!: (value: unknown) => void;
    vi.mocked(STSClient.prototype.send).mockImplementation(() => new Promise(resolve => { settle = resolve; }));
    const rejected = expect(load({ ...input, account: MEMBER })).rejects.toMatchObject({ code: 'lookup_failed' });
    await vi.advanceTimersByTimeAsync(18_000);
    await rejected;
    expect(STSClient.prototype.destroy).toHaveBeenCalledTimes(1);
    settle({ Credentials: { AccessKeyId: 'late', SecretAccessKey: 'late', SessionToken: 'late' } });
    await vi.advanceTimersByTimeAsync(0);
    expect(sdk()).not.toHaveBeenCalled();
    expect(EC2Client.prototype.destroy).not.toHaveBeenCalled();
  });
});

describe('incomplete evidence and conflicting records', () => {
  it('retains later successful pages from both peering directions', async () => {
    sdk().mockImplementation(async command => {
      if (!(command instanceof DescribeVpcPeeringConnectionsCommand)) return empty(command);
      const requester = hasFilter(command, 'requester-vpc-info.vpc-id');
      if (!command.input.NextToken) return { VpcPeeringConnections: [], NextToken: requester ? 'requester' : 'accepter' };
      expect(command.input.NextToken).toBe(requester ? 'requester' : 'accepter');
      return { VpcPeeringConnections: [requester ? peering() : peering('pcx-22222222', side(OTHER, MEMBER), side())] };
    });
    const result = await load(input);
    expect(result.peerings).toHaveLength(2);
    expect(result.incompleteSources).toEqual([]);
  });

  it('never enumerates TGW peers when the source attachment cannot be verified', async () => {
    sdk().mockImplementation(async command => hasFilter(command, 'resource-id') ? {
      TransitGatewayAttachments: [attachment({ ResourceOwnerId: undefined }), attachment({ ResourceId: OTHER })],
    } : empty(command));
    const result = await load(input);
    expect(result.transitGateways).toEqual([]);
    expect(result.incompleteSources).toEqual(['tgw-attachments']);
    expect(sdk().mock.calls.some(([c]) => hasFilter(c, 'transit-gateway-id'))).toBe(false);
  });

  it('caps the source TGW set before building the neighbor filter', async () => {
    sdk().mockImplementation(async command => hasFilter(command, 'resource-id') ? {
      TransitGatewayAttachments: Array.from({ length: 11 }, (_, i) => attachment({
        TransitGatewayId: `tgw-${i.toString(16).padStart(17, '0')}`,
        TransitGatewayAttachmentId: `tgw-attach-${i.toString(16).padStart(17, '0')}`,
      })),
    } : empty(command));
    const result = await load(input);
    expect(result.transitGateways).toHaveLength(10);
    expect(result.incompleteSources).toContain('tgw-attachments');
    const command = sdk().mock.calls.find(([c]) => hasFilter(c, 'transit-gateway-id'))![0];
    expect((command.input as { Filters: { Name: string; Values: string[] }[] }).Filters.find(f => f.Name === 'transit-gateway-id')!.Values).toHaveLength(10);
  });

  it('withholds conflicting source attachment identities', async () => {
    sdk().mockImplementation(async command => hasFilter(command, 'resource-id') ? {
      TransitGatewayAttachments: [attachment(), attachment({ TransitGatewayId: 'tgw-22222222222222222' })],
    } : empty(command));
    const result = await load(input);
    expect(result.transitGateways).toEqual([]);
    expect(result.incompleteSources).toContain('tgw-attachments');
  });

  it('withholds conflicting peer attachment owners instead of accepting the last record', async () => {
    sdk().mockImplementation(async command => {
      if (hasFilter(command, 'resource-id')) return { TransitGatewayAttachments: [attachment()] };
      if (hasFilter(command, 'transit-gateway-id')) return { TransitGatewayAttachments: [
        attachment({ ResourceId: OTHER, ResourceOwnerId: MEMBER, TransitGatewayAttachmentId: 'tgw-attach-22222222222222222' }),
        attachment({ ResourceId: OTHER, ResourceOwnerId: HOST, TransitGatewayAttachmentId: 'tgw-attach-22222222222222222' }),
      ] };
      return empty(command);
    });
    const result = await load(input);
    expect(result.transitGateways[0].peers).toEqual([]);
    expect(result.incompleteSources).toContain('tgw-peers');
  });

  it('discloses missing optional peering CIDR without inventing metadata', async () => {
    sdk().mockImplementation(async command => hasFilter(command, 'requester-vpc-info.vpc-id') ? {
      VpcPeeringConnections: [peering('pcx-11111111', side(), { ...side(OTHER, MEMBER), CidrBlock: undefined } as never)],
    } : empty(command));
    const result = await load(input);
    expect(result.peerings[0].peer.cidr).toBeNull();
    expect(result.incompleteSources).toEqual(['peering-requester']);
  });

  it('discloses participant-only TGW visibility even when the peers query succeeds empty', async () => {
    sdk().mockImplementation(async command => hasFilter(command, 'resource-id') ? {
      TransitGatewayAttachments: [attachment({ TransitGatewayOwnerId: MEMBER })],
    } : empty(command));
    const result = await load(input);
    expect(result.transitGateways[0].peers).toEqual([]);
    expect(result.incompleteSources).toEqual(['tgw-peers']);
  });

  it('does not turn a source attachment with changed ownership into a neighbor', async () => {
    sdk().mockImplementation(async command => {
      if (hasFilter(command, 'resource-id')) return { TransitGatewayAttachments: [attachment()] };
      if (hasFilter(command, 'transit-gateway-id')) return { TransitGatewayAttachments: [attachment({ ResourceId: OTHER, ResourceOwnerId: MEMBER })] };
      return empty(command);
    });
    const result = await load(input);
    expect(result.transitGateways[0].peers).toEqual([]);
    expect(result.incompleteSources).toContain('tgw-peers');
  });
});
