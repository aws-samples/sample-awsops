// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup, waitFor } from '@testing-library/react';
import CloudTrailEvents from './CloudTrailEvents';

afterEach(() => { cleanup(); vi.restoreAllMocks(); });

const EVENT = {
  time: '2026-09-01T00:00:00.000Z', name: 'RunInstances', source: 'ec2.amazonaws.com',
  user: 'alice', resourceType: 'EC2::Instance', resourceName: 'i-1', readOnly: false,
  eventId: 'ev-1', awsRegion: 'ap-northeast-2', sourceIPAddress: '10.0.0.1',
  userAgent: 'aws-cli/2', errorCode: '',
  resources: [{ type: 'EC2::Instance', name: 'i-1' }],
  raw: { eventVersion: '1.09', requestParameters: { instanceType: 't4g.small' } },
};

function setFetch(events: unknown[]) {
  vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ events }) })));
}

describe('CloudTrailEvents drill-down (gap L62)', () => {
  it('clicking a row opens the detail panel with the drill-down fields + raw payload', async () => {
    setFetch([EVENT]);
    render(<CloudTrailEvents />);
    const cell = await screen.findByText('RunInstances');
    fireEvent.click(cell.closest('tr')!);
    await waitFor(() => expect(screen.getByText('ev-1')).toBeTruthy());
    expect(screen.getByText('10.0.0.1')).toBeTruthy();
    // the raw payload reaches the panel (nested object rendered by the flat renderer)
    expect(screen.getByText(/instanceType/)).toBeTruthy();
  });
  it('renders rows without drill-down fields (legacy/degraded payloads) without crashing', async () => {
    setFetch([{ time: 't', name: 'X', source: 's', user: 'u', resourceType: '', resourceName: '', readOnly: true }]);
    render(<CloudTrailEvents />);
    fireEvent.click((await screen.findByText('X')).closest('tr')!);
    // panel opens with whatever fields exist — no throw is the assertion
    await waitFor(() => expect(screen.getAllByText('X').length).toBeGreaterThanOrEqual(1));
  });
});
