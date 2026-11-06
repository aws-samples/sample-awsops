import { beforeEach, describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';

// Kubernetes HTTPS responses are simulated; no network or AWS call leaves this test.
let statusCode = 403;
vi.mock('node:https', () => {
  const request = (_opts: unknown, cb: (res: EventEmitter & { statusCode: number }) => void) => {
    const req = new EventEmitter() as EventEmitter & { setTimeout: () => void; end: () => void; destroy: () => void };
    req.setTimeout = () => {};
    req.destroy = () => {};
    req.end = () => {
      const res = Object.assign(new EventEmitter(), { statusCode });
      cb(res);
      res.emit('data', Buffer.from(statusCode === 200 ? JSON.stringify({ items: [] }) : '{"message":"forbidden"}'));
      res.emit('end');
    };
    return req;
  };
  class Agent {}
  return { default: { request, Agent }, request, Agent };
});
const contextFor = (id: string) => (id.startsWith('arn:')
  ? { id, name: 'shared', accountId: '222222222222', region: 'us-east-1' }
  : { id, name: id, accountId: 'self', region: 'us-east-1' });
vi.mock('./eks-context', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./eks-context')>()),
  resolveEksCluster: async (id: string) => contextFor(id),
}));
vi.mock('./eks-access', () => ({
  describeEksCluster: async () => ({ endpoint: 'https://k8s.example', certificateAuthority: { data: Buffer.from('ca').toString('base64') } }),
}));
vi.mock('./eks-registry', () => ({ getClusterAuth: async () => ({ mode: 'sa-token', token: 'test-token' }) }));
const listAwsApiNodes = vi.fn();
vi.mock('./eks-aws-nodes', () => ({ listAwsApiNodes: (...a: unknown[]) => listAwsApiNodes(...a) }));

const MEMBER = 'arn:aws:eks:us-east-1:222222222222:cluster/shared';
const AWS_ROW = { name: 'ip-1.ec2.internal', source: 'aws-api' };

beforeEach(() => {
  vi.resetModules();
  statusCode = 403;
  listAwsApiNodes.mockReset().mockResolvedValue([AWS_ROW]);
});

describe('listInCluster nodes fallback', () => {
  it('serves the AWS-API node view when a member cluster forbids the nodes API', async () => {
    const { listInCluster } = await import('./eks-incluster');
    expect(await listInCluster(MEMBER, 'nodes')).toEqual([AWS_ROW]);
    expect(listAwsApiNodes).toHaveBeenCalledWith(contextFor(MEMBER));
  });

  it('keeps the Kubernetes failure for host clusters and for other member kinds', async () => {
    const { listInCluster } = await import('./eks-incluster');
    await expect(listInCluster('host', 'nodes')).rejects.toMatchObject({ statusCode: 403 });
    await expect(listInCluster(MEMBER, 'pods')).rejects.toMatchObject({ statusCode: 403 });
    expect(listAwsApiNodes).not.toHaveBeenCalled();
  });

  it('does not fall back on non-403 failures, and uses the Kubernetes rows when allowed', async () => {
    const { listInCluster } = await import('./eks-incluster');
    statusCode = 500;
    await expect(listInCluster(MEMBER, 'nodes')).rejects.toMatchObject({ statusCode: 500 });
    statusCode = 200;
    expect(await listInCluster(MEMBER, 'nodes')).toEqual([]);
    expect(listAwsApiNodes).not.toHaveBeenCalled();
  });
});
