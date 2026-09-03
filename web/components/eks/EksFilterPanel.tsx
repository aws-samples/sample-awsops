'use client';
import { useMemo, useState } from 'react';
import { ChevronDown, ChevronRight, ListFilter } from 'lucide-react';
import { useI18n } from '@/components/shell/LanguageProvider';

// EKS overview cluster/VPC facet filter (gap L130, v1 parity): a collapsible panel with
// multi-select cluster chips and VPC chips (each VPC chip shows its cluster count), an
// active-filter count badge, 'Clear all', and a filtered/total counter. Selections narrow the
// cluster card grid and the fleet panels; an empty selection leaves that facet unconstrained.

export const NO_VPC = '(no VPC)'; // clusters without a vpcId still get a facet bucket

export interface EksFilterState { clusters: string[]; vpcs: string[] }

function Chip({ label, count, active, onToggle }: { label: string; count?: number; active: boolean; onToggle: () => void }) {
  return (
    <button
      type="button"
      onClick={onToggle}
      aria-pressed={active}
      className={`rounded-full border px-2.5 py-0.5 font-mono text-[11px] transition ${
        active ? 'border-brand-400 bg-brand-50 text-brand-700' : 'border-ink-200 bg-paper text-ink-600 hover:bg-ink-50'
      }`}
    >
      {label}
      {count !== undefined && <span className={active ? 'ml-1 text-brand-500' : 'ml-1 text-ink-400'}>({count})</span>}
    </button>
  );
}

export default function EksFilterPanel({ clusters, value, onChange, filteredCount }: {
  clusters: { name: string; vpcId?: string }[];
  value: EksFilterState;
  onChange: (next: EksFilterState) => void;
  filteredCount: number;
}) {
  const { tt } = useI18n();
  const [open, setOpen] = useState(false);

  const vpcCounts = useMemo(() => {
    const m = new Map<string, number>();
    for (const c of clusters) {
      const v = c.vpcId || NO_VPC;
      m.set(v, (m.get(v) ?? 0) + 1);
    }
    return [...m.entries()].sort((a, b) => a[0].localeCompare(b[0]));
  }, [clusters]);

  const activeCount = value.clusters.length + value.vpcs.length;
  const toggle = (list: string[], item: string) =>
    list.includes(item) ? list.filter((x) => x !== item) : [...list, item];

  return (
    <div className="rounded-lg border border-ink-100 bg-paper-muted/40">
      <div className="flex items-center justify-between gap-2 px-3 py-2">
        <button
          type="button"
          onClick={() => setOpen((o) => !o)}
          className="flex items-center gap-1.5 text-[12px] font-medium text-ink-700"
          aria-expanded={open}
        >
          {open ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
          <ListFilter size={13} />
          {tt('클러스터 / VPC 필터')}
          {activeCount > 0 && (
            <span className="rounded-full bg-brand-500 px-1.5 py-0 text-[10px] font-semibold text-white">{activeCount}</span>
          )}
        </button>
        <div className="flex items-center gap-2 text-[11.5px] text-ink-400">
          <span>{filteredCount}/{clusters.length} {tt('클러스터')}</span>
          {activeCount > 0 && (
            <button
              type="button"
              onClick={() => onChange({ clusters: [], vpcs: [] })}
              className="rounded-md border border-ink-200 px-2 py-0.5 text-[11px] text-ink-500 hover:bg-ink-100"
            >
              {tt('전체 해제')}
            </button>
          )}
        </div>
      </div>
      {open && (
        <div className="flex flex-col gap-2 border-t border-ink-100 px-3 py-2.5">
          <div className="flex flex-wrap items-center gap-1.5">
            <span className="mr-1 text-[10.5px] uppercase tracking-[0.04em] text-ink-400">Cluster</span>
            {clusters.map((c) => (
              <Chip
                key={c.name}
                label={c.name}
                active={value.clusters.includes(c.name)}
                onToggle={() => onChange({ ...value, clusters: toggle(value.clusters, c.name) })}
              />
            ))}
          </div>
          <div className="flex flex-wrap items-center gap-1.5">
            <span className="mr-1 text-[10.5px] uppercase tracking-[0.04em] text-ink-400">VPC</span>
            {vpcCounts.map(([vpc, count]) => (
              <Chip
                key={vpc}
                label={vpc}
                count={count}
                active={value.vpcs.includes(vpc)}
                onToggle={() => onChange({ ...value, vpcs: toggle(value.vpcs, vpc) })}
              />
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
