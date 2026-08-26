'use client';
import { useEffect, useState, type CSSProperties, type ReactNode } from 'react';
import { useResizablePanel, usePublishDockedWidth, RESIZE_GRIP_CLASS, RESIZE_GRIP_BAR_CLASS } from '@/lib/useResizablePanel';
import {
  X, Info, Cpu, Network, Shield, HardDrive, Tag, KeyRound, DollarSign, Database,
  Server, Globe, Boxes, Activity, Layers, FileSearch, Bell, Copy, Check, type LucideIcon,
} from 'lucide-react';
import Badge from './Badge';
import StatePill from './StatePill';
import { buildDetailGroups, type DetailValue } from '@/lib/inventory-detail';
import type { InvType } from '@/lib/inventory-types';
import type { RdsInstanceMetrics } from '@/lib/metrics';

// v1-parity: each detail section is a titled card with a leading icon. Section labels are a small
// shared vocabulary across inventory types (Identity/Compute/Network/Security/Storage/Tags/…), so
// a keyword match on the label picks the icon; anything unmatched falls back to Info.
const SECTION_ICONS: [RegExp, LucideIcon][] = [
  [/image|ami/i, Layers],
  [/^instance/i, Server],
  [/log|trail|audit/i, FileSearch],
  [/action|notif/i, Bell],
  [/network|vpc|subnet|dns|ip|endpoint|route|listener|record/i, Network],
  [/security|iam|auth|access|policy|encrypt|rule|ingress|egress|permission/i, Shield],
  [/storage|volume|disk|ebs|snapshot|backup|attach/i, HardDrive],
  [/compute|cpu|memory|capacity|runtime|handler|desired/i, Cpu],
  [/tag/i, Tag],
  [/key|credential/i, KeyRound],
  [/cost|billing|pricing/i, DollarSign],
  [/engine|class|database|table|cluster|cache|domain/i, Database],
  [/identity|general|overview|info|config|meta|maintenance|setting/i, Info],
  [/cdn|cloudfront|distribution|global|edge/i, Globe],
  [/cluster|node|container|task|service/i, Boxes],
  [/health|metric|monitor|alarm|status|state/i, Activity],
];
function sectionIcon(label: string): LucideIcon {
  for (const [re, icon] of SECTION_ICONS) if (re.test(label)) return icon;
  return Server;
}

/**
 * DetailPanel — right slide-in panel showing EVERY field of a resource row.
 * The inventory/EKS pages already hold the full Steampipe/K8s row in each
 * table row ({resource_id, region, ...data}), so this renders all of it with
 * no extra fetch. Renders nothing when `data` is null. Closes on the × button,
 * an overlay click, or Escape. paper+ink tokens only (reuses Badge from F1).
 *
 * With a `spec` (InvType) carrying `sections`, fields render grouped under
 * section headers with friendly labels; without a spec it stays a flat list
 * of raw keys (backward-compatible).
 */
function renderValue(fmt: DetailValue) {
  switch (fmt.kind) {
    case 'boolean':
      return (
        <Badge tone={fmt.bool ? 'positive' : 'neutral'} variant="soft">
          {fmt.bool ? 'true' : 'false'}
        </Badge>
      );
    case 'empty':
      return <span className="text-ink-300">—</span>;
    case 'code':
      return (
        <pre className="mt-0.5 max-w-full overflow-x-auto whitespace-pre-wrap break-words rounded bg-ink-50 p-2 text-[11px] leading-snug text-ink-700">
          {fmt.text}
        </pre>
      );
    case 'state':
      return <StatePill value={fmt.text!} />;
    // v1-parity readable renderings (was raw JSON):
    case 'tags':
      // v1 Tags section: accent mono key column + plain value per line.
      return (
        <div className="space-y-1">
          {fmt.entries!.map(([k, v]) => (
            <div key={k} className="flex gap-2 text-[12.5px]">
              <span className="min-w-[110px] shrink-0 break-all font-mono text-[11px] text-brand-700">{k}</span>
              <span className="break-all text-ink-700 select-text">{v}</span>
            </div>
          ))}
        </div>
      );
    case 'idlist':
      // v1 security-group / block-device / NIC lists: mono id + name (+ public ip / flag).
      return (
        <div className="space-y-1">
          {fmt.items!.map((it, i) => (
            <div key={`${it.id}-${i}`} className="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[12.5px]">
              <span className="font-mono text-[11px] text-brand-700 select-text">{it.id}</span>
              {it.name && <span className="text-ink-600 select-text">{it.name}</span>}
              {it.extra && <span className="text-ink-400">({it.extra})</span>}
              {it.flag && <span className="text-[10.5px] font-medium text-warning-text">{it.flag}</span>}
            </div>
          ))}
        </div>
      );
    default:
      return <span className="block break-words text-[13px] text-ink-800 select-text">{fmt.text}</span>;
  }
}

// The plain string a field's copy button puts on the clipboard (null = nothing to copy).
// Structured kinds flatten to one line per entry so pasting stays readable.
function copyText(fmt: DetailValue): string | null {
  switch (fmt.kind) {
    case 'empty':
      return null;
    case 'boolean':
      return fmt.bool ? 'true' : 'false';
    case 'tags':
      return fmt.entries!.map(([k, v]) => `${k}=${v}`).join('\n') || null;
    case 'idlist':
      return fmt.items!.map((it) => [it.id, it.name, it.extra].filter(Boolean).join(' ')).join('\n') || null;
    default:
      return fmt.text?.trim() ? fmt.text : null;
  }
}

// Per-value copy affordance — subtle until hovered, flips to a ✓ for a moment after copying.
// Always rendered (not hover-gated) so it stays tappable on the mobile fullscreen sheet.
function CopyButton({ text, label = '값 복사' }: { text: string; label?: string }) {
  const [ok, setOk] = useState(false);
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      onClick={() => {
        void navigator.clipboard.writeText(text).then(() => {
          setOk(true);
          setTimeout(() => setOk(false), 1200);
        }).catch(() => {});
      }}
      className={`shrink-0 rounded p-1 transition-colors ${ok ? 'text-emerald-600' : 'text-ink-300 hover:bg-ink-50 hover:text-ink-600'}`}
    >
      {ok ? <Check size={12} /> : <Copy size={12} />}
    </button>
  );
}

// RDS detail panels show a live per-instance CloudWatch metrics table (v1 parity). Metrics are NOT in the
// synced inventory row, so this fetches them on open (read-only) and degrades to a "메트릭 불가" note.
const RDS_METRIC_ROWS: { key: keyof RdsInstanceMetrics; label: string; fmt: (v: number) => string }[] = [
  { key: 'cpu', label: 'CPU', fmt: (v) => `${v}%` },
  { key: 'connections', label: 'DB 커넥션', fmt: (v) => `${v}` },
  { key: 'freeableMemory', label: '여유 메모리', fmt: (v) => `${(v / 1e6).toFixed(0)} MB` },
  { key: 'freeStorage', label: '여유 스토리지', fmt: (v) => `${(v / 1e9).toFixed(1)} GB` },
  { key: 'readIops', label: 'Read IOPS', fmt: (v) => `${v}` },
  { key: 'writeIops', label: 'Write IOPS', fmt: (v) => `${v}` },
  { key: 'netIn', label: 'Network In', fmt: (v) => `${(v / 1024).toFixed(1)} KB/s` },
  { key: 'netOut', label: 'Network Out', fmt: (v) => `${(v / 1024).toFixed(1)} KB/s` },
];

function RdsMetricsSection({ instanceId }: { instanceId: string }) {
  const [s, setS] = useState<{ loading: boolean; metrics: RdsInstanceMetrics | null; error: boolean }>({
    loading: true, metrics: null, error: false,
  });
  useEffect(() => {
    let alive = true;
    setS({ loading: true, metrics: null, error: false });
    fetch(`/api/inventory/rds/metrics?id=${encodeURIComponent(instanceId)}`)
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(String(r.status)))))
      .then((d) => { if (alive) setS({ loading: false, metrics: (d.instance ?? null) as RdsInstanceMetrics | null, error: false }); })
      .catch(() => { if (alive) setS({ loading: false, metrics: null, error: true }); });
    return () => { alive = false; };
  }, [instanceId]);

  return (
    <div>
      <h3 className="mb-2 flex items-center gap-1.5 text-[11px] font-semibold text-ink-700">
        <span className="flex h-5 w-5 items-center justify-center rounded-md bg-brand-50 text-brand-600"><Activity size={12} /></span>
        인스턴스 메트릭 (CloudWatch)
      </h3>
      {s.loading ? (
        <p className="text-[12px] text-ink-400">메트릭 로딩 중…</p>
      ) : s.error || !s.metrics ? (
        <p className="text-[12px] text-ink-300">메트릭 불가</p>
      ) : (
        <dl className="grid grid-cols-2 gap-x-4 gap-y-2.5">
          {RDS_METRIC_ROWS.map((row) => {
            const v = s.metrics![row.key];
            return (
              <div key={row.key} className="flex flex-col gap-0.5">
                <dt className="font-mono text-[11px] text-ink-500">{row.label}</dt>
                <dd className="text-[13px] text-ink-800">
                  {typeof v === 'number' ? row.fmt(v) : <span className="text-ink-300">—</span>}
                </dd>
              </div>
            );
          })}
        </dl>
      )}
    </div>
  );
}

// Generic live CloudWatch metrics (ElastiCache/OpenSearch/MSK) — the BFF returns pre-formatted
// {label, value} rows from /api/inventory/<type>/metrics?id=. Same degrade behavior as RDS.
const LIVE_METRIC_TYPES = new Set(['elasticache', 'opensearch', 'msk']);

function LiveMetricsSection({ type, id }: { type: string; id: string }) {
  const [s, setS] = useState<{ loading: boolean; rows: { label: string; value: string }[]; error: boolean }>({
    loading: true, rows: [], error: false,
  });
  useEffect(() => {
    let alive = true;
    setS({ loading: true, rows: [], error: false });
    fetch(`/api/inventory/${type}/metrics?id=${encodeURIComponent(id)}`)
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(String(r.status)))))
      .then((d) => { if (alive) setS({ loading: false, rows: (d.metrics ?? []) as { label: string; value: string }[], error: false }); })
      .catch(() => { if (alive) setS({ loading: false, rows: [], error: true }); });
    return () => { alive = false; };
  }, [type, id]);

  return (
    <div>
      <h3 className="mb-2 flex items-center gap-1.5 text-[11px] font-semibold text-ink-700">
        <span className="flex h-5 w-5 items-center justify-center rounded-md bg-brand-50 text-brand-600"><Activity size={12} /></span>
        라이브 메트릭 (CloudWatch)
      </h3>
      {s.loading ? (
        <p className="text-[12px] text-ink-400">메트릭 로딩 중…</p>
      ) : s.error || s.rows.length === 0 ? (
        <p className="text-[12px] text-ink-300">메트릭 불가</p>
      ) : (
        <dl className="grid grid-cols-2 gap-x-4 gap-y-2.5">
          {s.rows.map((row) => (
            <div key={row.label} className="flex flex-col gap-0.5">
              <dt className="font-mono text-[11px] text-ink-500">{row.label}</dt>
              <dd className="text-[13px] text-ink-800">{row.value}</dd>
            </div>
          ))}
        </dl>
      )}
    </div>
  );
}

export default function DetailPanel({
  title,
  data,
  spec,
  resourceType,
  onClose,
  actions,
  children,
  modal = true,
}: {
  title?: string;
  data: Record<string, unknown> | null;
  spec?: InvType;
  resourceType?: string; // inventory resource type (e.g. 'rds') — enables type-specific live metric sections
  onClose: () => void;
  // optional action slot pinned under the header (e.g. topology "ask AI about this resource").
  actions?: ReactNode;
  // optional extra detail sections rendered after the field list.
  children?: ReactNode;
  // modal=false: on lg the backdrop is transparent + pointer-events-none so the content behind
  // (e.g. the topology canvas) stays pannable/zoomable while the panel is docked. Mobile (below
  // lg) is always a fullscreen sheet, so it stays modal there regardless.
  modal?: boolean;
}) {
  useEffect(() => {
    if (!data) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [data, onClose]);

  // Right-docked panels are user-resizable by default (drag the left edge; persisted).
  const { width, startResize } = useResizablePanel('awsops_detail_width', 480);

  // Coordinate with the global chat so the two right-docked surfaces never overlap.
  usePublishDockedWidth(!!data, width);

  if (!data) return null;

  const groups = buildDetailGroups(data, spec);
  const rdsInstanceId = resourceType === 'rds' && typeof data.resource_id === 'string' ? data.resource_id : null;
  const liveMetricId =
    resourceType && LIVE_METRIC_TYPES.has(resourceType) && typeof data.resource_id === 'string' ? data.resource_id : null;

  // v1-parity header: a friendly Name (tag/name column) as the prominent title, the resource_id
  // as the mono subtitle, and a state pill when the type declares a state column.
  const rawName = data.name ?? data.Name ?? (data.tags as Record<string, unknown> | undefined)?.Name;
  const name = typeof rawName === 'string' && rawName.trim() ? rawName.trim() : null;
  const resourceId = typeof data.resource_id === 'string' ? data.resource_id : (title ?? '');
  // Prominent title = friendly Name when we have one; else the caller's title / resource id.
  const bigTitle = name ?? title ?? resourceId ?? '리소스 상세';
  // Mono subtitle = the resource id, shown only when it adds info beyond the title.
  const subId = resourceId && resourceId !== bigTitle ? resourceId : null;
  const stateVal = spec?.stateKey ? data[spec.stateKey] : undefined;
  const stateText = stateVal == null || stateVal === '' ? null : String(stateVal);

  return (
    <>
      <div
        aria-hidden
        onClick={onClose}
        className={
          modal
            ? 'fixed inset-0 z-40 bg-ink-900/40 lg:bg-ink-900/20'
            : 'fixed inset-0 z-40 bg-ink-900/40 lg:bg-transparent lg:pointer-events-none'
        }
      />
      {/* Below lg: fullscreen sheet (inset-0, full width, no left border).
          lg+: unchanged right-docked panel (420px, border-l). CSS-only switch. */}
      <aside
        role="dialog"
        aria-modal={modal}
        aria-label={title ?? '리소스 상세'}
        className="fixed inset-0 z-50 flex h-full w-full max-w-full flex-col bg-card shadow-pop lg:inset-y-0 lg:left-auto lg:right-0 lg:w-[var(--panel-w)] lg:border-l lg:border-ink-100"
        style={{ ['--panel-w' as string]: `${width}px` } as CSSProperties}
      >
        <div onMouseDown={startResize} title="드래그하여 폭 조절" aria-label="패널 폭 조절" role="separator" className={`${RESIZE_GRIP_CLASS} hidden lg:block`}>
          <div className={RESIZE_GRIP_BAR_CLASS} />
        </div>
        <header className="flex items-start justify-between gap-2 border-b border-ink-100 px-4 py-3">
          <div className="min-w-0">
            <h2 className="min-w-0 break-words text-[14px] font-semibold text-ink-800">{bigTitle}</h2>
            <div className="mt-0.5 flex flex-wrap items-center gap-2">
              {subId && (
                <span className="flex items-center gap-0.5">
                  <span className="break-all font-mono text-[11px] text-ink-400 select-text">{subId}</span>
                  <CopyButton text={subId} label="ID 복사" />
                </span>
              )}
              {stateText && <StatePill value={stateText} />}
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="닫기"
            className="-mr-1 shrink-0 rounded p-1 text-ink-400 hover:bg-ink-50 hover:text-ink-700"
          >
            <X size={16} />
          </button>
        </header>
        {actions && <div className="border-b border-ink-100 px-4 py-3">{actions}</div>}
        <div className="flex-1 overflow-y-auto px-4 py-3 space-y-3">
          {groups.map((group, gi) => {
            // v1-parity: each section is a rounded card with a leading icon + title. An unlabelled
            // group (no spec/sections) renders as a plain card without the header row.
            const Icon = group.label ? sectionIcon(group.label) : null;
            return (
              <section key={group.label || gi} className="rounded-lg border border-ink-100 bg-paper-muted/40 p-3">
                {group.label && (
                  <h3 className="mb-2 flex items-center gap-1.5 text-[11px] font-semibold text-ink-700">
                    {Icon && (
                      <span className="flex h-5 w-5 items-center justify-center rounded-md bg-brand-50 text-brand-600">
                        <Icon size={12} />
                      </span>
                    )}
                    {group.label}
                  </h3>
                )}
                <dl className="space-y-2.5">
                  {group.items.map((it) => {
                    // A section whose ONLY field is a structured list (Tags / Security Groups)
                    // would repeat its own title as the dt — v1 showed just the rows; do the same.
                    const soloList = group.items.length === 1
                      && (it.fmt.kind === 'tags' || it.fmt.kind === 'idlist')
                      && it.label === group.label;
                    const copy = copyText(it.fmt);
                    return (
                      <div key={it.key} className="grid grid-cols-1 gap-0.5">
                        {!soloList && <dt className="font-mono text-[11px] text-ink-500">{it.label}</dt>}
                        <dd className="flex items-start gap-1 text-[13px] text-ink-800">
                          <div className="min-w-0 flex-1">{renderValue(it.fmt)}</div>
                          {copy && <CopyButton text={copy} label={`${it.label} 복사`} />}
                        </dd>
                      </div>
                    );
                  })}
                </dl>
              </section>
            );
          })}
          {rdsInstanceId && (
            <section className="rounded-lg border border-ink-100 bg-paper-muted/40 p-3">
              <RdsMetricsSection instanceId={rdsInstanceId} />
            </section>
          )}
          {liveMetricId && resourceType && (
            <section className="rounded-lg border border-ink-100 bg-paper-muted/40 p-3">
              <LiveMetricsSection type={resourceType} id={liveMetricId} />
            </section>
          )}
          {children}
        </div>
      </aside>
    </>
  );
}
