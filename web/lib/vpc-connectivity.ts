import {
  EC2Client, paginateDescribeVpcPeeringConnections, paginateDescribeTransitGatewayAttachments,
  type TransitGatewayAttachment, type VpcPeeringConnectionVpcInfo,
} from '@aws-sdk/client-ec2';
import { STSClient, AssumeRoleCommand } from '@aws-sdk/client-sts';
import { isIPv4 } from 'node:net';
import type { PoolClient } from 'pg';
import { assumedClient } from './aws-assume';
import { currentAccountId } from './account';
import { getAccount, type Account } from './accounts';
import { getPool } from './db';
import type { VpcConnectivity } from './vpc-connectivity-types';

type Input = { account: string; region: string; vpcId: string };
type Code = 'invalid_request' | 'not_found' | 'account_unavailable' | 'lookup_failed';
export class VpcConnectivityError extends Error {
  constructor(public readonly code: Code) { super(code); }
}
const ACCOUNT = /^\d{12}$/;
const VPC = /^vpc-(?:[a-f0-9]{8}|[a-f0-9]{17})$/;
const PCX = /^pcx-(?:[a-f0-9]{8}|[a-f0-9]{17})$/;
const TGW = /^tgw-[a-f0-9]{17}$/;
const ATTACHMENT = /^tgw-attach-[a-f0-9]{17}$/;
const TABLE = /^tgw-rtb-[a-f0-9]{17}$/;
// Commercial regions only; unknown/aggregate scopes must never select an SDK default.
const REGIONS = new Set((
  'af-south-1 ap-east-1 ap-east-2 ap-northeast-1 ap-northeast-2 ap-northeast-3 ' +
  'ap-south-1 ap-south-2 ap-southeast-1 ap-southeast-2 ap-southeast-3 ap-southeast-4 ' +
  'ap-southeast-5 ap-southeast-6 ap-southeast-7 ca-central-1 ca-west-1 eu-central-1 ' +
  'eu-central-2 eu-north-1 eu-south-1 eu-south-2 eu-west-1 eu-west-2 eu-west-3 ' +
  'il-central-1 me-central-1 me-south-1 mx-central-1 sa-east-1 us-east-1 us-east-2 us-west-1 us-west-2'
).split(' '));
const SOURCES = ['peering-requester', 'peering-accepter', 'tgw-attachments', 'tgw-peers', 'source'] as const;
type Source = typeof SOURCES[number];
const TTL = 4 * 60_000, MAX_CACHE = 64, MAX_INFLIGHT = 8;
const cache = new Map<string, VpcConnectivity>();
const inflight = new Map<string, Promise<VpcConnectivity>>();
const valid = (pattern: RegExp, value: unknown): value is string => typeof value === 'string' && pattern.test(value);
const text = (value: unknown, max = 256): value is string =>
  typeof value === 'string' && value.length > 0 && value.length <= max && !/[\u0000-\u001f\u007f]/.test(value);
const cidr = (value: unknown): value is string => typeof value === 'string' &&
  /^.+\/(?:[0-9]|[12][0-9]|3[0-2])$/.test(value) && isIPv4(value.split('/')[0]);

export function validVpcConnectivityInput(input: Input): boolean {
  return (input.account === 'self' || valid(ACCOUNT, input.account)) && REGIONS.has(input.region) && valid(VPC, input.vpcId);
}

/** One budget covers registry, inventory, credential acquisition, retries and every page. */
class Deadline {
  readonly controller = new AbortController();
  readonly signal = this.controller.signal;
  private readonly timeout: Promise<never>;
  private readonly timer: ReturnType<typeof setTimeout>;
  private reject!: (error: Error) => void;
  constructor() {
    let timer!: ReturnType<typeof setTimeout>;
    this.timeout = new Promise((_, reject) => {
      this.reject = reject;
      timer = setTimeout(() => this.cancel(), 18_000);
    });
    this.timer = timer;
  }
  async run<T>(operation: () => Promise<T>): Promise<T> {
    if (this.signal.aborted) throw new VpcConnectivityError('lookup_failed');
    return Promise.race([operation(), this.timeout]);
  }
  cancel() { this.controller.abort(); this.reject(new VpcConnectivityError('lookup_failed')); }
  close() { clearTimeout(this.timer); }
}

async function selectedAccount(input: Input, deadline: Deadline): Promise<{ account: Account; host: boolean }> {
  const configured = currentAccountId();
  let hostId = configured;
  if (!valid(ACCOUNT, hostId)) {
    if (hostId !== 'self') throw new VpcConnectivityError('account_unavailable');
    // getHostAccount has no cancellation. Read only its key with a cancellable
    // checkout, then use the registry helper's signal-aware account validation.
    const result = await boundedQuery('SELECT account_id FROM accounts WHERE is_host LIMIT 2', [], deadline);
    if (result.rows.length !== 1 || !valid(ACCOUNT, result.rows[0].account_id)) throw new VpcConnectivityError('account_unavailable');
    hostId = result.rows[0].account_id;
  }
  const host = await deadline.run(() => getAccount(hostId, deadline.signal));
  if (!host || host.accountId !== hostId || host.isHost !== true) throw new VpcConnectivityError('account_unavailable');
  const isHost = input.account === 'self' || input.account === host.accountId;
  const account = isHost ? host : await deadline.run(() => getAccount(input.account, deadline.signal));
  if (!account || account.enabled !== true || account.accountId !== (isHost ? host.accountId : input.account) ||
      (!isHost && account.isHost !== false)) throw new VpcConnectivityError('account_unavailable');
  return { account, host: isHost };
}

async function boundedQuery(sql: string, values: string[], deadline: Deadline) {
  let client: PoolClient | undefined;
  let broken = false;
  const onError = () => { broken = true; deadline.cancel(); };
  try {
    return await deadline.run(async () => {
      const acquired = await getPool().connect();
      if (deadline.signal.aborted) { acquired.release(); throw new VpcConnectivityError('lookup_failed'); }
      client = acquired;
      client.on('error', onError);
      return client.query(sql, values);
    });
  } finally {
    if (client) {
      try { client.release(broken || deadline.signal.aborted); }
      finally { client.removeListener('error', onError); }
    }
  }
}

async function inventorySource(input: Input, accountId: string, host: boolean, deadline: Deadline) {
  // Identity is exclusively the indexed relational key, never data.account_id.
  const result = await boundedQuery(
    `SELECT account_id, region, resource_id,
       CASE WHEN length(data->>'name') <= 256 THEN data->>'name' END AS name,
       CASE WHEN length(data->>'cidr_block') <= 64 THEN data->>'cidr_block' END AS cidr
     FROM inventory_resources
     WHERE account_id = $1 AND region = $2 AND resource_id = $3 AND resource_type = 'vpc'
     LIMIT 2`, [host ? 'self' : accountId, input.region, input.vpcId], deadline,
  );
  const row = result.rows[0];
  if (result.rows.length !== 1 || row.account_id !== (host ? 'self' : accountId) ||
      row.region !== input.region || row.resource_id !== input.vpcId) throw new VpcConnectivityError('not_found');
  return {
    vpcId: input.vpcId, accountId, region: input.region,
    ...(text(row.name) ? { name: row.name } : {}),
    ...(cidr(row.cidr) ? { cidr: row.cidr } : {}),
  };
}

async function ec2Client(account: Account, host: boolean, region: string, deadline: Deadline): Promise<EC2Client> {
  const config = { maxAttempts: 2, requestHandler: { connectionTimeout: 2_000, requestTimeout: 5_000 } };
  let credentials: { accessKeyId: string; secretAccessKey: string; sessionToken: string } | undefined;
  if (!host) {
    if (!valid(/^[\w+=,.@-]{1,64}$/, account.roleName)) throw new VpcConnectivityError('account_unavailable');
    const sts = await assumedClient('self', STSClient, { ...config, region: process.env.AWS_REGION || region });
    try {
      const assumed = await deadline.run(() => sts.send(new AssumeRoleCommand({
        RoleArn: `arn:aws:iam::${account.accountId}:role/${account.roleName}`,
        RoleSessionName: 'awsops-vpc-connectivity', DurationSeconds: 900,
        ...(account.externalId ? { ExternalId: account.externalId } : {}),
      }), { abortSignal: deadline.signal }));
      const c = assumed.Credentials;
      const owner = assumed.AssumedRoleUser?.Arn?.match(/^arn:aws:sts::(\d{12}):assumed-role\/[^/]+\/[^/]+$/)?.[1];
      if (owner !== account.accountId || !c?.AccessKeyId || !c.SecretAccessKey || !c.SessionToken) {
        throw new VpcConnectivityError('lookup_failed');
      }
      credentials = { accessKeyId: c.AccessKeyId, secretAccessKey: c.SecretAccessKey, sessionToken: c.SessionToken };
    } finally { sts.destroy(); }
  }
  // The foreign path of assumedClient has no cancellation. Acquire bounded credentials
  // above and use its host constructor path; never race an orphaned foreign credential call.
  return assumedClient('self', EC2Client, { ...config, region, ...(credentials ? { credentials } : {}) });
}

async function fetchConnectivity(source: VpcConnectivity['source'], account: Account, host: boolean, deadline: Deadline): Promise<VpcConnectivity> {
  const checkedAt = new Date().toISOString();
  const incomplete = new Set<Source>();
  let successfulPages = 0;
  const client = await ec2Client(account, host, source.region, deadline);
  const options = { abortSignal: deadline.signal };
  const config = { client, pageSize: 100 };
  // Explicit page/row/token bounds also catch repeated tokens and overlarge SDK records.
  async function collect<T, P extends { NextToken?: string }>(
    label: Source, pages: AsyncGenerator<P>, rowsOf: (page: P) => T[] | undefined,
  ): Promise<T[]> {
    const rows: T[] = [];
    const seen = new Set<string>();
    try {
      for (let page = 0; page < 5; page++) {
        const next = await deadline.run(() => pages.next());
        if (next.done) break;
        const records = rowsOf(next.value);
        if (!Array.isArray(records)) { incomplete.add(label); break; }
        successfulPages++;
        const room = 500 - rows.length;
        rows.push(...records.slice(0, room));
        const token = next.value.NextToken;
        if (records.length > room) incomplete.add(label);
        if (!token) break;
        if (!text(token, 4096) || seen.has(token) || page === 4 || rows.length >= 500) {
          incomplete.add(label); break;
        }
        seen.add(token);
      }
    } catch { incomplete.add(label); }
    return rows;
  }
  const peerings = new Map<string, VpcConnectivity['peerings'][number]>();
  const blockedPeerings = new Set<string>();
  const matchesSource = (v: VpcPeeringConnectionVpcInfo | undefined) =>
    v?.VpcId === source.vpcId && v.OwnerId === source.accountId && v.Region === source.region;
  const validVpc = (v: VpcPeeringConnectionVpcInfo | undefined) =>
    v && valid(VPC, v.VpcId) && valid(ACCOUNT, v.OwnerId) && REGIONS.has(v.Region ?? '');
  async function peeringDirection(direction: 'requester' | 'accepter') {
    const label = `peering-${direction}` as Source;
    const records = await collect(
      label, paginateDescribeVpcPeeringConnections(config, { Filters: [
        { Name: `${direction}-vpc-info.vpc-id`, Values: [source.vpcId] },
        { Name: `${direction}-vpc-info.owner-id`, Values: [source.accountId] },
      ] }, options), page => page.VpcPeeringConnections,
    );
    for (const record of records) {
      const own = direction === 'requester' ? record?.RequesterVpcInfo : record?.AccepterVpcInfo;
      const peer = direction === 'requester' ? record?.AccepterVpcInfo : record?.RequesterVpcInfo;
      if (!record || !valid(PCX, record.VpcPeeringConnectionId) || !text(record.Status?.Code, 64) ||
          !matchesSource(own) || !validVpc(peer)) { incomplete.add(label); continue; }
      if (!cidr(peer!.CidrBlock)) incomplete.add(label);
      const item = {
        id: record.VpcPeeringConnectionId, state: record.Status!.Code!,
        peer: { vpcId: peer!.VpcId!, accountId: peer!.OwnerId!, region: peer!.Region!, cidr: cidr(peer!.CidrBlock) ? peer!.CidrBlock! : null },
      };
      const previous = peerings.get(item.id);
      if (previous && JSON.stringify(previous) !== JSON.stringify(item)) {
        blockedPeerings.add(item.id); peerings.delete(item.id); incomplete.add(label);
      } else if (!blockedPeerings.has(item.id)) peerings.set(item.id, item);
    }
  }
  const validAttachment = (a: TransitGatewayAttachment | undefined) =>
    a && valid(TGW, a.TransitGatewayId) && valid(ATTACHMENT, a.TransitGatewayAttachmentId) &&
    valid(VPC, a.ResourceId) && valid(ACCOUNT, a.ResourceOwnerId) &&
    valid(ACCOUNT, a.TransitGatewayOwnerId) && text(a.State, 64);
  const routeTable = (a: TransitGatewayAttachment, label: Source) => {
    const id = a.Association?.TransitGatewayRouteTableId;
    if (id === undefined && !a.Association) return null; // unassociated is legitimate
    if (valid(TABLE, id)) return id;
    incomplete.add(label); return null;
  };
  function uniqueAttachments(records: TransitGatewayAttachment[], label: Source) {
    const unique = new Map<string, TransitGatewayAttachment>();
    const blocked = new Set<string>();
    const evidence = (a: TransitGatewayAttachment) => JSON.stringify([
      a.TransitGatewayId, a.TransitGatewayOwnerId, a.ResourceId, a.ResourceOwnerId, a.ResourceType, a.State, a.Association,
    ]);
    for (const a of records) {
      if (!a || !valid(ATTACHMENT, a.TransitGatewayAttachmentId)) { incomplete.add(label); continue; }
      const id = a.TransitGatewayAttachmentId;
      const previous = unique.get(id);
      if (previous && evidence(previous) !== evidence(a)) {
        unique.delete(id); blocked.add(id); incomplete.add(label);
      } else if (!blocked.has(id)) unique.set(id, a);
    }
    return [...unique.values()];
  }
  async function transitGateways(): Promise<VpcConnectivity['transitGateways']> {
    const attachments = await collect('tgw-attachments',
      paginateDescribeTransitGatewayAttachments(config, { Filters: [
        { Name: 'resource-id', Values: [source.vpcId] },
        { Name: 'resource-owner-id', Values: [source.accountId] },
        { Name: 'resource-type', Values: ['vpc'] },
      ] }, options), page => page.TransitGatewayAttachments);
    const sources = new Map<string, TransitGatewayAttachment>();
    for (const a of uniqueAttachments(attachments, 'tgw-attachments')) {
      if (!validAttachment(a) || a.ResourceType !== 'vpc' || a.ResourceId !== source.vpcId || a.ResourceOwnerId !== source.accountId) {
        incomplete.add('tgw-attachments'); continue;
      }
      if (sources.size >= 10 && !sources.has(a.TransitGatewayAttachmentId!)) { incomplete.add('tgw-attachments'); continue; }
      sources.set(a.TransitGatewayAttachmentId!, a);
    }
    // A participant can only see its own attachments, including a successful empty
    // Describe response. That cannot certify the complete set of same-TGW neighbors.
    if ([...sources.values()].some(a => a.TransitGatewayOwnerId !== source.accountId)) incomplete.add('tgw-peers');
    const ids = [...new Set([...sources.values()].map(a => a.TransitGatewayId!))];
    if (!ids.length) return [];
    const attachmentsOnGateways = await collect('tgw-peers',
      paginateDescribeTransitGatewayAttachments(config, { Filters: [
        { Name: 'transit-gateway-id', Values: ids }, { Name: 'resource-type', Values: ['vpc'] },
      ] }, options), page => page.TransitGatewayAttachments);
    const neighbors = new Map<string, TransitGatewayAttachment>();
    for (const a of uniqueAttachments(attachmentsOnGateways, 'tgw-peers')) {
      if (a?.ResourceType && a.ResourceType !== 'vpc') continue;
      if (!validAttachment(a) || a.ResourceType !== 'vpc' || !ids.includes(a.TransitGatewayId!) ||
          ![...sources.values()].some(s => s.TransitGatewayId === a.TransitGatewayId && s.TransitGatewayOwnerId === a.TransitGatewayOwnerId)) {
        incomplete.add('tgw-peers'); continue;
      }
      const priorSource = sources.get(a.TransitGatewayAttachmentId!);
      if (priorSource && (a.ResourceId !== source.vpcId || a.ResourceOwnerId !== source.accountId ||
          a.TransitGatewayId !== priorSource.TransitGatewayId)) { incomplete.add('tgw-peers'); continue; }
      if (a.ResourceId === source.vpcId && a.ResourceOwnerId === source.accountId) continue;
      neighbors.set(a.TransitGatewayAttachmentId!, a);
    }
    return [...sources.values()].map(a => ({
      id: a.TransitGatewayId!, attachmentId: a.TransitGatewayAttachmentId!, state: a.State!,
      routeTableId: routeTable(a, 'tgw-attachments'),
      peers: [...neighbors.values()].filter(p => p.TransitGatewayId === a.TransitGatewayId).map(p => ({
        vpcId: p.ResourceId!, accountId: p.ResourceOwnerId!, state: p.State!,
        attachmentId: p.TransitGatewayAttachmentId!, routeTableId: routeTable(p, 'tgw-peers'),
      })),
    }));
  }
  try {
    const [, , gateways] = await Promise.all([peeringDirection('requester'), peeringDirection('accepter'), transitGateways()]);
    if (!successfulPages) throw new VpcConnectivityError('lookup_failed');
    return { source, checkedAt, peerings: [...peerings.values()].sort((a, b) => a.id.localeCompare(b.id)),
      transitGateways: gateways, incompleteSources: SOURCES.filter(s => incomplete.has(s)) };
  } finally { client.destroy(); }
}

export async function getVpcConnectivity(input: Input): Promise<VpcConnectivity> {
  if (!validVpcConnectivityInput(input)) throw new VpcConnectivityError('invalid_request');
  const deadline = new Deadline();
  try {
    const selected = await selectedAccount(input, deadline);
    const source = await inventorySource(input, selected.account.accountId, selected.host, deadline);
    const key = `${source.accountId}|${source.region}|${source.vpcId}`;
    const hit = cache.get(key);
    if (hit && Date.parse(hit.checkedAt) + TTL > Date.now()) return { ...hit, source };
    cache.delete(key);
    const pending = inflight.get(key);
    if (pending) return { ...await deadline.run(() => pending), source };
    if (inflight.size >= MAX_INFLIGHT) throw new VpcConnectivityError('lookup_failed');
    const work = fetchConnectivity(source, selected.account, selected.host, deadline);
    inflight.set(key, work);
    try {
      const result = await work;
      if (cache.size >= MAX_CACHE) cache.delete(cache.keys().next().value!);
      cache.set(key, result);
      return result;
    } finally { inflight.delete(key); }
  } catch (error) {
    throw error instanceof VpcConnectivityError ? error : new VpcConnectivityError('lookup_failed');
  } finally { deadline.close(); }
}
