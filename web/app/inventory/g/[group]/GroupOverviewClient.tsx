'use client';
import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import PageHeader from '@/components/ui/PageHeader';
import RefreshButton from '@/components/ui/RefreshButton';
import SectionLabel from '@/components/ui/SectionLabel';
import StatTile from '@/components/ui/StatTile';
import Card from '@/components/ui/Card';
import { useI18n } from '@/components/shell/LanguageProvider';
import { groupBySlug, ATTENTION_SPLITS, type NavLeaf } from '@/lib/inventory-types';
import { TYPE_ICON, GROUP_ICON, variantIcon, highlightIcon } from '@/lib/type-icons';

interface ByType { type: string; label: string; count: number; [k: string]: unknown }
interface Splits { ec2Running: number; ec2Stopped: number; ebsUnencrypted: number; iamUserNoMfa: number; sgOpenIngress: number }
interface Summary { byType: ByType[]; total: number; splits?: Splits }

const DASH = '—';

/**
 * Group overview — Phase 1 status summary for one inventory category. Reuses the
 * existing /api/inventory/summary (counts + derived splits); no new AWS calls.
 * Right-sizing (Compute) and the recent-events AI summary are Phase-2 placeholder
 * slots here (inert, no fetch — API contracts TBD).
 */
export default function GroupOverviewClient({ slug }: { slug: string }) {
  const { t } = useI18n();
  const node = groupBySlug(slug);
  const [sum, setSum] = useState<Summary | null>(null);
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const [capturedAt, setCapturedAt] = useState<string | null>(null);

  const load = useCallback(async () => {
    setBusy(true);
    try {
      const r = await fetch('/api/inventory/summary');
      if (!r.ok) throw new Error(String(r.status));
      setSum(await r.json());
      setErr('');
      setCapturedAt(new Date().toISOString()); // only stamp on success (not on 401/500)
    } catch (e) {
      setErr(String(e));
    }
    setBusy(false);
  }, []);
  useEffect(() => { load(); }, [load]);

  if (!node) return null; // server already guarded; defensive

  const leaves: NavLeaf[] = [...node.items, ...node.subgroups.flatMap((s) => s.items)];
  const countFor = (type?: string): number | string => {
    if (!type || !sum) return DASH;
    return sum.byType.find((x) => x.type === type)?.count ?? 0;
  };
  const totalCount = sum
    ? leaves.reduce((s, l) => s + (l.type ? sum.byType.find((x) => x.type === l.type)?.count ?? 0 : 0), 0)
    : null;
  const splits = sum?.splits;
  const attention = splits
    ? node.splitKeys.filter((k) => ATTENTION_SPLITS.includes(k)).reduce((s, k) => s + (splits[k] ?? 0), 0)
    : 0;

  return (
    <>
      <PageHeader
        title={t(node.labelKey)}
        subtitle={totalCount == null ? undefined : t('overview.total', { n: totalCount })}
        right={<RefreshButton busy={busy} onClick={load} capturedAt={capturedAt} />}
      />
      <div className="px-4 lg:px-8 py-8 flex flex-col gap-6">
        {err && <div className="text-[13px] text-rose-600">{t('overview.loadFailed', { err })}</div>}

        {/* Status summary band */}
        <section className="flex flex-col gap-3">
          <SectionLabel>{t('overview.summary')}</SectionLabel>
          <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
            <StatTile
              label={t('overview.status')}
              value={!sum ? DASH : attention === 0 ? t('overview.healthy') : t('overview.attention', { n: attention })}
              variant={!sum ? 'default' : attention === 0 ? 'accent' : 'danger'}
              icon={(() => { const I = variantIcon(!sum ? 'default' : attention === 0 ? 'accent' : 'danger'); return <I size={16} />; })()}
            />
            {node.splitKeys.map((k) => (
              <StatTile
                key={k}
                label={t(`split.${k}`)}
                value={splits ? splits[k] : DASH}
                variant={ATTENTION_SPLITS.includes(k) && splits && splits[k] > 0 ? 'danger' : 'default'}
                icon={(() => { const I = highlightIcon(t(`split.${k}`), ATTENTION_SPLITS.includes(k) && splits && splits[k] > 0 ? 'danger' : 'default'); return <I size={16} />; })()}
              />
            ))}
          </div>
        </section>

        {/* Per-type tiles → drill into each resource type */}
        <section className="flex flex-col gap-3">
          <SectionLabel>{t('overview.resourceTypes')}</SectionLabel>
          <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
            {leaves.map((leaf) => (
              <Link key={leaf.key} href={leaf.href} className="no-underline transition-transform duration-150 hover:-translate-y-0.5">
                <StatTile label={leaf.labelKey ? t(leaf.labelKey) : leaf.label ?? leaf.type ?? ''} value={countFor(leaf.type)} icon={(() => { const I = (leaf.type && TYPE_ICON[leaf.type]) || GROUP_ICON[node.group] || null; return I ? <I size={16} /> : undefined; })()} />
              </Link>
            ))}
          </div>
        </section>

        {/* Phase-2 placeholders — inert (no fetch). Contracts defined in Phase 2. */}
        <section className="flex flex-col gap-3">
          <SectionLabel>{t('overview.insights')}</SectionLabel>
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
            {/* Phase 2: recent-events AI summary — API TBD, response shape TBD */}
            <Card title={t('overview.aiSummary')}>
              <p className="text-[13px] text-ink-400">{t('overview.comingSoon')}</p>
            </Card>
            {slug === 'compute' && (
              /* Phase 2: right-sizing analysis (Compute Optimizer) — API TBD */
              <Card title={t('overview.rightsizing')}>
                <p className="text-[13px] text-ink-400">{t('overview.comingSoon')}</p>
              </Card>
            )}
          </div>
        </section>
      </div>
    </>
  );
}
