'use client';
import { useEffect, useState } from 'react';
import StatePill from '@/components/ui/StatePill';
import { useI18n } from '@/components/shell/LanguageProvider';

// EBS volume drill-down (gap-audit L97/L98, v1 parity): attached-instance enrichment cards +
// a per-volume snapshot sub-list, both from the synced Aurora rows via
// GET /api/inventory/ebs_volume/related. Mounted by DetailPanel for resourceType 'ebs_volume'
// (the RdsMetricsSection pattern). Named export — metrics siblings' established convention.

interface RelatedSnapshot { snapshotId: string; sizeGb: number | null; encrypted: boolean | null; startTime: string; state: string }
interface RelatedInstance { instanceId: string; name: string; instanceType: string; state: string }

/** Instance ids from the volume row's raw attachments (JSON-string tolerant; malformed → []). */
export function attachmentInstanceIds(attachments: unknown): string[] {
  let arr: unknown = attachments;
  if (typeof arr === 'string') {
    try { arr = JSON.parse(arr); } catch { return []; }
  }
  if (!Array.isArray(arr)) return [];
  const ids = new Set<string>();
  for (const a of arr) {
    if (a && typeof a === 'object') {
      const o = a as Record<string, unknown>;
      const id = o.instance_id ?? o.InstanceId ?? o.instanceId;
      if (typeof id === 'string' && /^i-[0-9a-f]{8,32}$/.test(id)) ids.add(id);
    }
  }
  return [...ids].slice(0, 16); // io2 multi-attach max (route MAX_INSTANCES)
}

export function EbsRelatedSection({ volumeId, accountId, region, attachments }: {
  volumeId: string; accountId?: string; region?: string; attachments?: unknown;
}) {
  const { tt } = useI18n();
  const [data, setData] = useState<{ snapshots: RelatedSnapshot[] | null; instances: RelatedInstance[] | null; snapshotLimit: number } | null>(null);
  const [err, setErr] = useState(false);
  const instanceIds = attachmentInstanceIds(attachments);

  useEffect(() => {
    let alive = true;
    setData(null); setErr(false);
    const qs = new URLSearchParams({ volumeId });
    if (instanceIds.length) qs.set('instanceIds', instanceIds.join(','));
    if (accountId) qs.set('account', accountId);
    if (region) qs.set('region', region);
    fetch(`/api/inventory/ebs_volume/related?${qs}`)
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(String(r.status)))))
      .then((d) => { if (alive) setData(d); })
      .catch(() => { if (alive) setErr(true); });
    return () => { alive = false; };
    // instanceIds is derived from `attachments` — the raw prop is the stable dependency.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [volumeId, accountId, region, attachments]);

  if (err) return <p className="text-[12px] text-rose-600">{tt('연관 리소스 조회 실패')}</p>;
  if (!data) return <p className="text-[12px] text-ink-400">{tt('연관 리소스 조회 중…')}</p>;

  const byId = new Map((data.instances ?? []).map((i) => [i.instanceId, i]));
  return (
    <div className="space-y-3">
      <div>
        <div className="mb-1.5 text-[11px] font-semibold uppercase tracking-[0.04em] text-ink-400">{tt('연결 인스턴스')}</div>
        {instanceIds.length === 0 && <p className="text-[12px] text-ink-400">{tt('연결된 인스턴스 없음')}</p>}
        {instanceIds.length > 0 && data.instances === null && (
          <p className="text-[12px] text-rose-600">{tt('인스턴스 조회 실패')}</p>
        )}
        {instanceIds.length > 0 && data.instances !== null && (
          <ul className="space-y-1.5">
            {instanceIds.map((id) => {
              const inst = byId.get(id);
              return (
                <li key={id} className="flex items-center gap-2 rounded-md border border-ink-100 bg-paper px-2.5 py-1.5 text-[12px]">
                  <span className="min-w-0 flex-1 truncate">
                    <span className="font-medium text-ink-800">{inst?.name || id}</span>
                    {inst?.name && <span className="ml-1.5 font-mono text-[11px] text-ink-400">{id}</span>}
                    {inst?.instanceType && <span className="ml-1.5 text-ink-500">{inst.instanceType}</span>}
                  </span>
                  {inst?.state ? (
                    <StatePill value={inst.state} />
                  ) : (
                    // Honest-degrade: the instance may live in an unsynced region/account.
                    <span className="shrink-0 text-[11px] text-ink-400">{tt('inventory에 없음')}</span>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </div>
      <div>
        <div className="mb-1.5 text-[11px] font-semibold uppercase tracking-[0.04em] text-ink-400">
          {tt('스냅샷')}{data.snapshots && data.snapshots.length > 0 ? ` (${data.snapshots.length})` : ''}
        </div>
        {data.snapshots === null && <p className="text-[12px] text-rose-600">{tt('스냅샷 조회 실패')}</p>}
        {data.snapshots !== null && data.snapshots.length === 0 && (
          <p className="text-[12px] text-ink-400">{tt('이 볼륨의 스냅샷 없음')}</p>
        )}
        {data.snapshots !== null && data.snapshots.length > 0 && (
          <>
            <ul className="space-y-1">
              {data.snapshots.map((s) => (
                <li key={s.snapshotId} className="flex items-center gap-2 text-[12px]">
                  <span className="min-w-0 flex-1 truncate font-mono text-ink-700">{s.snapshotId}</span>
                  {s.sizeGb != null && <span className="shrink-0 text-ink-500">{s.sizeGb} GB</span>}
                  {s.state && s.state !== 'completed' && (
                    // a pending/error snapshot must not silently read as a usable backup
                    <span className="shrink-0 rounded bg-amber-50 px-1 text-[10px] text-amber-800">{s.state}</span>
                  )}
                  <span className={`shrink-0 rounded px-1 text-[10px] ${s.encrypted === true ? 'bg-emerald-50 text-emerald-700' : s.encrypted === false ? 'bg-amber-50 text-amber-800' : 'bg-ink-100 text-ink-500'}`}>
                    {s.encrypted === true ? tt('암호화') : s.encrypted === false ? tt('미암호화') : tt('암호화 알 수 없음')}
                  </span>
                  {s.startTime && <span className="shrink-0 tabular text-[11px] text-ink-400">{s.startTime.slice(0, 10)}</span>}
                </li>
              ))}
            </ul>
            {data.snapshots.length >= data.snapshotLimit && (
              <p className="mt-1 text-[11px] text-ink-400">{tt(`최근 ${data.snapshotLimit}개만 표시`)}</p>
            )}
          </>
        )}
      </div>
    </div>
  );
}
