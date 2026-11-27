// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
vi.mock('next/dynamic', () => ({ default: () => () => <div /> }));
vi.mock('@xyflow/react', () => ({ Handle: () => null, Position: {} }));
vi.mock('@/components/shell/LanguageProvider', () => ({ useI18n: () => ({ tt: (s: string) => s }) }));
import MapCanvas, { MapLegend } from './MapCanvas';
import type { MapGraph, MapNode } from '@/lib/infra-map';
afterEach(cleanup);
const node = (id: string, kind: MapNode['kind'], status?: MapNode['status']): MapNode => ({
  id, kind, column: 0, label: id, meta: {}, ...(status ? { status } : {}),
});
describe('MapLegend', () => {
  it('renders kind chips and status dots present in the graph (gap L248)', () => {
    const graph: MapGraph = {
      nodes: [node('vpc:1', 'vpc'), node('ec2:1', 'ec2', 'ok'), node('ec2:2', 'ec2', 'bad')],
      edges: [],
    };
    render(<MapLegend graph={graph} theme="light" />);
    expect(screen.getByText('VPC')).toBeTruthy();
    expect(screen.getByText('EC2')).toBeTruthy();
    expect(screen.getByText('ok')).toBeTruthy();
    expect(screen.getByText('bad')).toBeTruthy();
    expect(screen.queryByText('warn')).toBeNull();
    expect(screen.queryByText('neutral')).toBeNull();
  });
});
it('does not offer VPC controls for a Kubernetes graph', () => {
 render(<MapCanvas graph={{ nodes: [node('shop/pod', 'pod')], edges: [] }} columns={[{title:'Pods'}]} query="" theme="light" />);
 expect(screen.queryByRole('combobox', { name: 'VPC 선택' })).toBeNull();
 expect(screen.queryByRole('button', { name: '전체 그래프' })).toBeNull();
});
it('does not promise a full graph while the parent search is active', () => {
 render(<MapCanvas graph={{ nodes: [node('shop', 'vpc')], edges: [] }} columns={[{title:'VPC'}]} query="shop" theme="light" />);
 expect((screen.getByRole('button', { name:'전체 그래프' }) as HTMLButtonElement).disabled).toBe(true);
});
