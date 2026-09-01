// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup, waitFor } from '@testing-library/react';
import { EbsRelatedSection, attachmentInstanceIds } from './EbsRelatedSection';

afterEach(() => { cleanup(); vi.restoreAllMocks(); });

describe('attachmentInstanceIds', () => {
  it('parses object and JSON-string attachments (snake/Pascal), dedupes, validates ids', () => {
    expect(attachmentInstanceIds([{ instance_id: 'i-0123456789abcdef0' }, { InstanceId: 'i-0123456789abcdef0' }]))
      .toEqual(['i-0123456789abcdef0']);
    expect(attachmentInstanceIds('[{"InstanceId":"i-0a0a0a0a0a0a0a0a0"}]')).toEqual(['i-0a0a0a0a0a0a0a0a0']);
    expect(attachmentInstanceIds('not json')).toEqual([]);
    expect(attachmentInstanceIds([{ instance_id: 'nope' }])).toEqual([]);
  });
});

function setFetch(body: unknown, ok = true) {
  vi.stubGlobal('fetch', vi.fn(async () => ({ ok, status: ok ? 200 : 500, json: async () => body })));
}

describe('EbsRelatedSection (gap L97/L98)', () => {
  it('renders instance cards with a state pill and the snapshot sub-list', async () => {
    setFetch({
      snapshots: [{ snapshotId: 'snap-1', sizeGb: 100, encrypted: true, startTime: '2026-08-30T00:00:00Z', state: 'completed' }],
      instances: [{ instanceId: 'i-0123456789abcdef0', name: 'web-1', instanceType: 't4g.small', state: 'running' }],
      snapshotLimit: 20,
    });
    render(<EbsRelatedSection volumeId="vol-1" attachments={[{ instance_id: 'i-0123456789abcdef0' }]} />);
    await waitFor(() => expect(screen.getByText('web-1')).toBeTruthy());
    expect(screen.getByText('running')).toBeTruthy();
    expect(screen.getByText('snap-1')).toBeTruthy();
    expect(screen.getByText('100 GB')).toBeTruthy();
    expect(screen.getByText('암호화')).toBeTruthy();
  });
  it('an attachment absent from the synced ec2 rows degrades honestly (id + inventory에 없음)', async () => {
    setFetch({ snapshots: [], instances: [], snapshotLimit: 20 });
    render(<EbsRelatedSection volumeId="vol-1" attachments={[{ instance_id: 'i-0feedfeedfeedfee0' }]} />);
    await waitFor(() => expect(screen.getByText('i-0feedfeedfeedfee0')).toBeTruthy());
    expect(screen.getByText('inventory에 없음')).toBeTruthy();
    expect(screen.getByText('이 볼륨의 스냅샷 없음')).toBeTruthy();
  });
  it('shows the cap note at the 20-snapshot limit and the empty-attachments state', async () => {
    setFetch({
      snapshots: Array.from({ length: 20 }, (_, i) => ({ snapshotId: `snap-${i}`, sizeGb: 1, encrypted: false, startTime: '', state: 'completed' })),
      instances: [],
      snapshotLimit: 20,
    });
    render(<EbsRelatedSection volumeId="vol-1" attachments={[]} />);
    await waitFor(() => expect(screen.getByText('snap-0')).toBeTruthy());
    expect(screen.getByText('최근 20개만 표시')).toBeTruthy();
    expect(screen.getByText('연결된 인스턴스 없음')).toBeTruthy();
  });
  it('fetch failure surfaces an inline error, never a dead panel', async () => {
    setFetch({}, false);
    render(<EbsRelatedSection volumeId="vol-1" />);
    await waitFor(() => expect(screen.getByText('연관 리소스 조회 실패')).toBeTruthy());
  });
});
