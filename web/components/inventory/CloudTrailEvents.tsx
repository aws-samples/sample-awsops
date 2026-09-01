'use client';
import { useEffect, useState } from 'react';
import Card from '@/components/ui/Card';
import DetailPanel from '@/components/ui/DetailPanel';
import SegmentedControl from '@/components/ui/SegmentedControl';
import { useI18n } from '@/components/shell/LanguageProvider';

interface TrailEvent {
  time: string; name: string; source: string; user: string;
  resourceType: string; resourceName: string; readOnly: boolean;
  // Drill-down fields (gap L62) — see the route's TrailEvent for provenance.
  eventId?: string; awsRegion?: string; sourceIPAddress?: string; userAgent?: string;
  errorCode?: string; accessKeyId?: string; resources?: { type: string; name: string }[];
  raw?: Record<string, unknown> | null;
}

/** Flat detail row for the slide-over (gap L62, v1 parity: Event/Resource sections + raw
 *  JSON). Empty values are dropped so the panel stays readable; the raw payload is a nested
 *  object — DetailPanel's flat renderer JSON-formats it like inventory JSONB nests. */
function detailRow(e: TrailEvent): Record<string, unknown> {
  const row: Record<string, unknown> = {
    event_id: e.eventId, event_name: e.name, event_source: e.source, event_time: e.time,
    user: e.user, region: e.awsRegion, source_ip: e.sourceIPAddress, user_agent: e.userAgent,
    access_key_id: e.accessKeyId, error_code: e.errorCode, read_only: e.readOnly,
    resources: (e.resources ?? []).map((r) => `${r.type} ${r.name}`.trim()).filter(Boolean),
    raw_event: e.raw ?? undefined,
  };
  for (const k of Object.keys(row)) {
    const v = row[k];
    if (v === undefined || v === '' || (Array.isArray(v) && v.length === 0)) delete row[k];
  }
  return row;
}

/** 최근 CloudTrail 이벤트 (v1 parity: 최근 20건 라이브 조회, 전체/Write 탭). */
export default function CloudTrailEvents() {
  const { tt } = useI18n();
  const [mode, setMode] = useState<'all' | 'write'>('all');
  const [events, setEvents] = useState<TrailEvent[] | null>(null);
  const [selected, setSelected] = useState<TrailEvent | null>(null); // drill-down slide-over (L62)
  const [err, setErr] = useState('');

  useEffect(() => {
    let alive = true;
    setEvents(null); setErr(''); setSelected(null); // a stale slide-over must not outlive its tab
    fetch(`/api/inventory/cloudtrail/events${mode === 'write' ? '?write=1' : ''}`)
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(String(r.status)))))
      .then((d) => { if (alive) setEvents(d.events ?? []); })
      .catch((e) => { if (alive) { setErr(String(e)); setEvents([]); } });
    return () => { alive = false; };
  }, [mode]);

  const th = 'px-3 py-2 text-left text-[11px] font-semibold uppercase tracking-[0.04em] text-ink-400';
  const td = 'px-3 py-1.5 text-[12px]';

  return (
    <Card
      title={`최근 이벤트${events ? ` (${events.length})` : ''}`}
      right={
        <SegmentedControl
          options={[{ value: 'all', label: '전체' }, { value: 'write', label: 'Write' }]}
          value={mode}
          onChange={(v) => setMode(v as 'all' | 'write')}
        />
      }
      padded={false}
    >
      {err && <p className="px-4 py-3 text-[12px] text-rose-600">{tt('이벤트 조회 실패:')} {err}</p>}
      {!events && !err && <p className="px-4 py-3 text-[12px] text-ink-400">{tt('이벤트 조회 중… (LookupEvents)')}</p>}
      {events && events.length === 0 && !err && <p className="px-4 py-3 text-[12px] text-ink-400">{tt('이벤트 없음')}</p>}
      {events && events.length > 0 && (
        <div className="overflow-x-auto">
          <table className="w-full">
            <thead><tr className="border-b border-ink-100">
              <th className={th}>Time</th><th className={th}>Event</th><th className={th}>Source</th>
              <th className={th}>User</th><th className={th}>Resource</th><th className={th}>R/W</th>
            </tr></thead>
            <tbody>
              {events.map((e, i) => (
                <tr
                  key={i}
                  onClick={() => setSelected(e)}
                  className="cursor-pointer border-b border-ink-50 last:border-0 hover:bg-ink-50/60"
                >
                  <td className={`${td} whitespace-nowrap tabular text-ink-500`}>{e.time.slice(5, 19).replace('T', ' ')}</td>
                  <td className={`${td} font-medium text-ink-800`}>{e.name}</td>
                  <td className={`${td} text-ink-500`}>{e.source.replace('.amazonaws.com', '')}</td>
                  <td className={`${td} text-ink-600`}>{e.user}</td>
                  <td className={td}>
                    <span className="block max-w-[260px] truncate text-ink-600" title={`${e.resourceType} ${e.resourceName}`}>
                      {e.resourceType && <span className="text-ink-400">{e.resourceType} </span>}{e.resourceName}
                    </span>
                  </td>
                  <td className={td}>
                    <span className={e.readOnly ? 'text-ink-400' : 'rounded bg-brand-50 px-1.5 py-0.5 text-[10px] font-semibold text-brand-700'}>
                      {e.readOnly ? 'Read' : 'Write'}
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {selected && (
        <DetailPanel
          title={selected.name || tt('이벤트 상세')}
          data={detailRow(selected)}
          onClose={() => setSelected(null)}
        />
      )}
    </Card>
  );
}
