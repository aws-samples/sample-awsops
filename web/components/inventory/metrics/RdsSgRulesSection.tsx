'use client';
import { useEffect, useState } from 'react';
import { useI18n } from '@/components/shell/LanguageProvider';
import type { SgInboundEntry, SgRuleSource } from '@/app/api/inventory/security_group/inbound/route';

// RDS SG inbound-rule chaining (gap L154, v1 parity): each attached security group resolves to
// its inbound rules (protocol / port range / source chips with descriptions) from the synced
// security_group inventory — no live AWS call. An SG missing from inventory renders an honest
// "not synced" state, never an empty-rules claim. Named export per the metrics-module convention.

function SourceChip({ s }: { s: SgRuleSource }) {
  // /0 and /1 both cover (half) the internet — a /1 pair is the classic "not technically
  // 0.0.0.0/0" evasion, so highlight it the same way.
  const wideOpen = /\/[01]$/.test(s.value);
  const tone = s.kind === 'sg' ? 'text-brand-700 bg-brand-50'
    : s.kind === 'cidr' && wideOpen ? 'text-rose-700 bg-rose-50'
    : 'text-ink-600 bg-ink-50';
  return (
    <span className={`inline-flex items-center gap-1 rounded px-1.5 py-0.5 font-mono text-[10.5px] ${tone}`} title={s.description}>
      {s.value}
      {s.description && <span className="font-sans text-ink-400">({s.description})</span>}
    </span>
  );
}

export function RdsSgRulesSection({ sgIds, accountId, region }: { sgIds: string[]; accountId?: string; region?: string }) {
  const { tt } = useI18n();
  const [groups, setGroups] = useState<SgInboundEntry[] | null>(null);
  const [err, setErr] = useState(false);

  useEffect(() => {
    let alive = true;
    setGroups(null); setErr(false);
    if (!sgIds.length) return;
    const scope = (accountId ? `&account=${encodeURIComponent(accountId)}` : '')
      + (region ? `&region=${encodeURIComponent(region)}` : '');
    fetch(`/api/inventory/security_group/inbound?ids=${sgIds.map(encodeURIComponent).join(',')}${scope}`)
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(String(r.status)))))
      .then((d) => {
        if (!alive) return;
        if (d && Array.isArray(d.groups)) setGroups(d.groups as SgInboundEntry[]);
        else setErr(true);
      })
      .catch(() => { if (alive) setErr(true); });
    return () => { alive = false; };
  }, [sgIds.join(','), accountId, region]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!sgIds.length) return null;
  const heading = (
    <div className="mb-1.5 text-[11px] font-semibold uppercase tracking-[0.04em] text-ink-400">{tt('보안 그룹 인바운드 규칙')}</div>
  );
  if (err) return <div>{heading}<p className="text-[12px] text-rose-600">{tt('보안 그룹 규칙 조회 실패')}</p></div>;
  if (!groups) return <div>{heading}<p className="text-[12px] text-ink-400">{tt('로딩 중…')}</p></div>;

  return (
    <div>
      {heading}
      <div className="space-y-2">
        {groups.map((g) => (
          <div key={g.sgId} className="rounded-md border border-ink-100 bg-paper p-2">
            <div className="mb-1 flex flex-wrap items-baseline gap-x-2">
              <span className="font-mono text-[11px] text-brand-700 select-text">{g.sgId}</span>
              {g.groupName && <span className="text-[12px] text-ink-600">{g.groupName}</span>}
            </div>
            {!g.found ? (
              // Honest state: absent from the synced inventory ≠ "no inbound rules".
              <p className="text-[11.5px] text-ink-300">{tt('인벤토리에 미동기화')}</p>
            ) : g.rules.length === 0 ? (
              <p className="text-[11.5px] text-ink-300">{tt('인바운드 규칙 없음')}</p>
            ) : (
              <div className="space-y-1">
                {g.rules.map((rule, i) => (
                  <div key={i} className="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[12px]">
                    <span className="w-14 shrink-0 font-medium uppercase text-ink-700">{rule.protocol}</span>
                    <span className="w-24 shrink-0 font-mono text-[11px] text-ink-600">{rule.portRange}</span>
                    <span className="flex flex-wrap gap-1">
                      {rule.sources.map((s, j) => <SourceChip key={j} s={s} />)}
                    </span>
                  </div>
                ))}
              </div>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}
