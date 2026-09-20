// @vitest-environment jsdom
import { afterEach, describe, it, expect, vi } from 'vitest';
import { cleanup, render, screen, fireEvent } from '@testing-library/react';
import { S3BucketMap, bucketStatus } from './S3BucketMap';

afterEach(cleanup);

describe('bucketStatus (gap L241 — v1 palette precedence + unknown-first honesty)', () => {
  it('Public beats Versioned; Versioned beats Standard (all signals known)', () => {
    expect(bucketStatus({ bucket_policy_is_public: true, versioning_enabled: true })).toBe('public');
    expect(bucketStatus({ bucket_policy_is_public: false, versioning_enabled: true })).toBe('versioned');
    expect(bucketStatus({ bucket_policy_is_public: false, versioning_enabled: false })).toBe('standard');
  });
  it('an UNKNOWN public flag → unknown even when versioning is known (a denied policy lookup must not paint a reassuring green)', () => {
    expect(bucketStatus({ versioning_enabled: true })).toBe('unknown');
    expect(bucketStatus({ versioning_enabled: false })).toBe('unknown');
    expect(bucketStatus({})).toBe('unknown');
  });
  it('public known-false but versioning unknown → unknown (Standard also claims not-versioned)', () => {
    expect(bucketStatus({ bucket_policy_is_public: false })).toBe('unknown');
  });
});

describe('S3BucketMap', () => {
  const rows = [
    { resource_id: 'a-bucket', region: 'ap-northeast-2', bucket_policy_is_public: true },
    { resource_id: 'b-bucket', region: 'ap-northeast-2', versioning_enabled: true, bucket_policy_is_public: false },
    { resource_id: 'c-bucket', region: 'us-east-1', versioning_enabled: false, bucket_policy_is_public: false },
  ];
  it('groups by region (bucket-count desc) and opens the detail panel on click', () => {
    const onSelect = vi.fn();
    render(<S3BucketMap rows={rows} onSelect={onSelect} />);
    expect(screen.getByText('ap-northeast-2')).toBeTruthy();
    expect(screen.getByText('us-east-1')).toBeTruthy();
    fireEvent.click(screen.getByText('a-bucket'));
    expect(onSelect).toHaveBeenCalledWith(rows[0]);
  });
  it('renders the four-status legend and the truncation label', () => {
    render(<S3BucketMap rows={rows} isTruncated />);
    for (const l of ['Policy Public', 'Versioned', 'Standard', 'Unknown']) expect(screen.getByText(l)).toBeTruthy();
    expect(screen.getByText(/표본 기준|sampled/)).toBeTruthy();
  });
});
