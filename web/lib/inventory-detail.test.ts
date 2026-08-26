import { describe, it, expect } from 'vitest';
import { formatDetailValue, buildDetailGroups } from './inventory-detail';
import { INVENTORY_TYPES } from './inventory-types';

describe('formatDetailValue', () => {
  it('classifies booleans', () => {
    expect(formatDetailValue('encrypted', true)).toEqual({ kind: 'boolean', bool: true });
    expect(formatDetailValue('encrypted', false)).toEqual({ kind: 'boolean', bool: false });
  });
  it('classifies empty (null / undefined / empty string)', () => {
    expect(formatDetailValue('x', null).kind).toBe('empty');
    expect(formatDetailValue('x', undefined).kind).toBe('empty');
    expect(formatDetailValue('x', '').kind).toBe('empty');
  });
  it('classifies generic objects as code (pretty JSON)', () => {
    const f = formatDetailValue('vpc_config', { SubnetIds: ['s-1'] });
    expect(f.kind).toBe('code');
    expect(f.text).toContain('"SubnetIds"');
  });
  it('classifies tags as key/value entries (v1-parity readable rows, not JSON)', () => {
    const f = formatDetailValue('tags', { Name: 'web', env: 'prod' });
    expect(f.kind).toBe('tags');
    expect(f.entries).toEqual([['Name', 'web'], ['env', 'prod']]);
    // empty tag map renders as the muted em-dash, not '{}'
    expect(formatDetailValue('tags', {}).kind).toBe('empty');
  });
  it('classifies known structured arrays as idlist rows (SG / block devices / NICs)', () => {
    const sg = formatDetailValue('security_groups', [{ GroupId: 'sg-1', GroupName: 'web' }]);
    expect(sg.kind).toBe('idlist');
    expect(sg.items).toEqual([{ id: 'sg-1', name: 'web' }]);
    const bdm = formatDetailValue('block_device_mappings', [
      { DeviceName: '/dev/xvda', Ebs: { VolumeId: 'vol-1', DeleteOnTermination: true } },
    ]);
    expect(bdm.kind).toBe('idlist');
    expect(bdm.items).toEqual([{ id: '/dev/xvda', name: 'vol-1', flag: 'DeleteOnTermination' }]);
    // unexpected shape falls back to raw JSON — never a crash or silent drop
    expect(formatDetailValue('security_groups', [{ Unknown: 1 }]).kind).toBe('code');
  });
  it('classifies plain string arrays as idlist rows (subnet ids, aliases, ARNs — any key)', () => {
    const f = formatDetailValue('vpc_subnet_ids', ['subnet-1', 'subnet-2']);
    expect(f.kind).toBe('idlist');
    expect(f.items).toEqual([{ id: 'subnet-1' }, { id: 'subnet-2' }]);
  });
  it('classifies RDS vpc_security_groups and EBS attachments as idlist rows', () => {
    const vsg = formatDetailValue('vpc_security_groups', [{ VpcSecurityGroupId: 'sg-9', Status: 'active' }]);
    expect(vsg.kind).toBe('idlist');
    expect(vsg.items).toEqual([{ id: 'sg-9', name: 'active' }]);
    const att = formatDetailValue('attachments', [{ InstanceId: 'i-1', Device: '/dev/xvda', State: 'attached' }]);
    expect(att.kind).toBe('idlist');
    expect(att.items).toEqual([{ id: 'i-1', name: '/dev/xvda', extra: 'attached' }]);
  });
  it('classifies known state keys as state', () => {
    expect(formatDetailValue('instance_state', 'running')).toEqual({ kind: 'state', text: 'running' });
    expect(formatDetailValue('status', 'available').kind).toBe('state');
  });
  it('classifies other scalars as text', () => {
    expect(formatDetailValue('name', 'web-1')).toEqual({ kind: 'text', text: 'web-1' });
    expect(formatDetailValue('memory_size', 512)).toEqual({ kind: 'text', text: '512' });
  });
});

describe('buildDetailGroups', () => {
  const row = { resource_id: 'i-1', region: 'ap-northeast-2', name: 'web', instance_type: 't3.micro', instance_state: 'running', tags: { a: 1 } };

  it('returns one flat unlabelled group when no spec (legacy behavior, raw keys, insertion order)', () => {
    const g = buildDetailGroups(row);
    expect(g).toHaveLength(1);
    expect(g[0].label).toBe('');
    expect(g[0].items.map((i) => i.key)).toEqual(['resource_id', 'region', 'name', 'instance_type', 'instance_state', 'tags']);
    expect(g[0].items.map((i) => i.label)).toEqual(['resource_id', 'region', 'name', 'instance_type', 'instance_state', 'tags']);
  });

  it('groups by spec sections with friendly labels and an Other bucket', () => {
    const g = buildDetailGroups(row, INVENTORY_TYPES.ec2);
    const labels = g.map((x) => x.label);
    expect(labels).toContain('Instance'); // v1-parity ec2 categories (Instance/Compute/…/Tags/Image)
    expect(labels).toContain('Tags');     // tags now has its own v1-parity section
    // friendly label from the column spec
    const all = g.flatMap((x) => x.items);
    expect(all.find((i) => i.key === 'instance_type')?.label).toBe('Type');
    // every present key appears exactly once across groups
    const keys = all.map((i) => i.key).sort();
    expect(keys).toEqual(['instance_state', 'instance_type', 'name', 'region', 'resource_id', 'tags']);
    expect(new Set(keys).size).toBe(keys.length); // exactly once across groups
  });

  it('skips section keys absent from the row and drops empty sections', () => {
    const sparse = { resource_id: 'i-2', region: 'us-east-1' };
    const g = buildDetailGroups(sparse, INVENTORY_TYPES.ec2);
    // only sections that have at least one present key survive; no duplicates
    expect(g.every((x) => x.items.length > 0)).toBe(true);
    const keys = g.flatMap((x) => x.items.map((i) => i.key)).sort();
    expect(keys).toEqual(['region', 'resource_id']);
  });
});
