'use client';
import { useMemo } from 'react';
import Card from '@/components/ui/Card';
import { useI18n } from '@/components/shell/LanguageProvider';

// S3 Bucket Map by Region (gap L241, v1 TreeMap parity): buckets as blocks grouped by
// region, colored by security status with v1's palette and PRECEDENCE — Public (red) >
// Versioned (green) > Standard (cyan) — plus an Unknown (gray) state v1 didn't need: a
// bucket whose policy flag AND versioning are both unknown must not silently render as
// Standard. Block click opens the SAME detail panel the table uses.

type Row = Record<string, unknown>;

type Status = 'public' | 'versioned' | 'standard' | 'unknown';

const STATUS_META: Record<Status, { label: string; cls: string }> = {
  public: { label: 'Policy Public', cls: 'bg-rose-100 border-rose-400 text-rose-800' },
  versioned: { label: 'Versioned', cls: 'bg-emerald-100 border-emerald-400 text-emerald-800' },
  standard: { label: 'Standard', cls: 'bg-cyan-50 border-cyan-400 text-cyan-800' },
  unknown: { label: 'Unknown', cls: 'bg-ink-100 border-ink-300 text-ink-500' },
};

const truthy = (v: unknown) => v === true || v === 'true';
const known = (v: unknown) => v === true || v === false || v === 'true' || v === 'false';

export function bucketStatus(r: Row): Status {
  if (truthy(r.bucket_policy_is_public)) return 'public';
  // an UNKNOWN public flag must not color the tile a reassuring green/cyan (a denied
  // policy-status lookup could be masking real exposure) — unknown wins over versioned.
  if (!known(r.bucket_policy_is_public)) return 'unknown';
  if (truthy(r.versioning_enabled)) return 'versioned';
  // public known-false but versioning unknown: 'Standard' claims not-versioned too → unknown.
  if (!known(r.versioning_enabled)) return 'unknown';
  return 'standard';
}

export function S3BucketMap({ rows, isTruncated = false, onSelect }: {
  rows: Row[];
  isTruncated?: boolean;
  onSelect?: (row: Row) => void;
}) {
  const { tt } = useI18n();
  const byRegion = useMemo(() => {
    const m = new Map<string, Row[]>();
    for (const r of rows) {
      const region = String(r.region ?? '') || '(unknown region)';
      const list = m.get(region) ?? [];
      list.push(r);
      m.set(region, list);
    }
    return [...m.entries()].sort(([, a], [, b]) => b.length - a.length);
  }, [rows]);

  if (rows.length === 0) return null;
  const title = tt('리전별 버킷 맵');
  return (
    <Card
      title={isTruncated ? `${title} (${tt('표본 기준')})` : title}
      right={
        <span className="flex items-center gap-2.5">
          {(Object.keys(STATUS_META) as Status[]).map((k) => (
            <span key={k} className="inline-flex items-center gap-1 text-[11px] text-ink-500">
              <span className={`inline-block h-2.5 w-2.5 rounded-sm border ${STATUS_META[k].cls}`} />
              {STATUS_META[k].label}
            </span>
          ))}
        </span>
      }
    >
      <div className="flex flex-col gap-3">
        {byRegion.map(([region, buckets]) => (
          <div key={region}>
            <div className="mb-1.5 text-[11px] font-semibold uppercase tracking-[0.04em] text-ink-400">
              {region} <span className="font-normal normal-case">({buckets.length})</span>
            </div>
            <div className="flex flex-wrap gap-1.5">
              {buckets.map((b) => {
                const st = bucketStatus(b);
                return (
                  <button
                    key={String(b.resource_id)}
                    type="button"
                    onClick={() => onSelect?.(b)}
                    title={`${String(b.resource_id)} · ${STATUS_META[st].label}`}
                    className={`max-w-[220px] truncate rounded border px-2 py-1 text-left font-mono text-[10.5px] transition hover:brightness-95 ${STATUS_META[st].cls}`}
                  >
                    {String(b.resource_id)}
                  </button>
                );
              })}
            </div>
          </div>
        ))}
      </div>
    </Card>
  );
}

export default S3BucketMap;
