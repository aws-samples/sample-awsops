// @vitest-environment jsdom
import { afterEach, describe, it, expect } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { MapLegend } from './MapCanvas';
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
    // statuses absent from the graph render no dot chip
    expect(screen.queryByText('warn')).toBeNull();
    expect(screen.queryByText('neutral')).toBeNull();
  });
});
