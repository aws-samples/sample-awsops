// @vitest-environment jsdom
import { afterEach, describe, it, expect, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { s3AccessRoles, S3IamAccessSection } from './S3IamAccessSection';

afterEach(() => { cleanup(); vi.restoreAllMocks(); });

describe('s3AccessRoles (gap L242 — managed-policy matching)', () => {
  it('matches AmazonS3* and AdministratorAccess policies; others do not count', () => {
    const { hits, anySynced } = s3AccessRoles([
      { resource_id: 'r1', attached_policy_arns: ['arn:aws:iam::aws:policy/AmazonS3ReadOnlyAccess'] },
      { resource_id: 'r2', attached_policy_arns: ['arn:aws:iam::aws:policy/AdministratorAccess'] },
      { resource_id: 'r3', attached_policy_arns: ['arn:aws:iam::aws:policy/AmazonEC2FullAccess'] },
    ]);
    expect(anySynced).toBe(true);
    expect(hits.map((h) => h.name)).toEqual(['r1', 'r2']);
    expect(hits[0].policies).toEqual(['AmazonS3ReadOnlyAccess']);
    // admin-equivalent + job-function path also grant S3; deny-shaped customer policies never match
    const extra = s3AccessRoles([
      { resource_id: 'p1', attached_policy_arns: ['arn:aws:iam::aws:policy/PowerUserAccess'] },
      { resource_id: 'p2', attached_policy_arns: ['arn:aws:iam::aws:policy/job-function/PowerUserAccess'] },
      { resource_id: 'p3', attached_policy_arns: ['arn:aws:iam::123456789012:policy/AmazonS3Deny'] },
    ]);
    expect(extra.hits.map((h) => h.name)).toEqual(['p1', 'p2']);
  });
  it('rows without the synced column set anySynced=false (pre-apply state ≠ genuinely empty)', () => {
    const { hits, anySynced } = s3AccessRoles([{ resource_id: 'r1' }, { resource_id: 'r2' }]);
    expect(anySynced).toBe(false);
    expect(hits).toEqual([]);
  });
  it('caps at 30 roles (the v1 cap)', () => {
    const rows = Array.from({ length: 35 }, (_, i) => ({
      resource_id: `r${i}`, attached_policy_arns: ['arn:aws:iam::aws:policy/AmazonS3FullAccess'],
    }));
    expect(s3AccessRoles(rows).hits).toHaveLength(30);
  });
});


describe('S3IamAccessSection conclusive gating (round-3)', () => {
  const stub = (body: unknown, status = 200) =>
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: status === 200, status, json: async () => body }));

  it('run:null (no ledger row) + zero matches is NON-conclusive — never an all-clear', async () => {
    stub({ rows: [{ resource_id: 'r1', data: { attached_policy_arns: ['arn:aws:iam::aws:policy/AmazonEC2FullAccess'] } }], run: null });
    render(<S3IamAccessSection />);
    await waitFor(() => expect(screen.getByText(/확정 아님/)).toBeTruthy());
  });
  it('a STALE succeeded run (>24h) with zero matches is NON-conclusive (freshness bound)', async () => {
    stub({ rows: [{ resource_id: 'r1', data: { attached_policy_arns: ['arn:aws:iam::aws:policy/AmazonEC2FullAccess'] } }], run: { status: 'succeeded', finished_at: new Date(Date.now() - 48 * 3600_000).toISOString() } });
    render(<S3IamAccessSection />);
    await waitFor(() => expect(screen.getByText(/확정 아님/)).toBeTruthy());
  });
  it('a FRESH succeeded untruncated run with zero matches renders the matched-set-framed conclusive line', async () => {
    stub({ rows: [{ resource_id: 'r1', data: { attached_policy_arns: ['arn:aws:iam::aws:policy/AmazonEC2FullAccess'] } }], run: { status: 'succeeded', finished_at: new Date().toISOString() } });
    render(<S3IamAccessSection />);
    await waitFor(() => expect(screen.getByText(/검사 대상 관리형 정책/)).toBeTruthy());
  });
  it('a failed run renders the stale-data banner', async () => {
    stub({ rows: [{ resource_id: 'r1', data: { attached_policy_arns: ['arn:aws:iam::aws:policy/AdministratorAccess'] } }], run: { status: 'failed', finished_at: '2026-09-01T00:00:00Z' } });
    render(<S3IamAccessSection />);
    await waitFor(() => expect(screen.getByText(/마지막 iam_role sync가 성공하지 못했습니다/)).toBeTruthy());
    expect(screen.getByText('r1')).toBeTruthy(); // last-good data still listed
  });
  it('run:null WITH matches renders the unverifiable-freshness note alongside the list (round-8)', async () => {
    stub({ rows: [{ resource_id: 'r1', data: { attached_policy_arns: ['arn:aws:iam::aws:policy/AdministratorAccess'] } }], run: null });
    render(<S3IamAccessSection />);
    await waitFor(() => expect(screen.getByText(/sync 이력 정보가 없어/)).toBeTruthy());
    expect(screen.getByText('r1')).toBeTruthy(); // the list still renders — caveated, not hidden
  });
  it('403 renders the admin-only note, not a generic failure', async () => {
    stub({}, 403);
    render(<S3IamAccessSection />);
    await waitFor(() => expect(screen.getByText(/관리자 전용 데이터/)).toBeTruthy());
  });
});
