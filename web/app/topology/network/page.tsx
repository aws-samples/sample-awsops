'use client';

import { Suspense, useEffect, useMemo, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import PageHeader from '@/components/ui/PageHeader';
import NetworkDiagram from '@/components/topology/NetworkDiagram';
import { useI18n } from '@/components/shell/LanguageProvider';
import { useTheme } from '@/lib/use-theme';
import { MAX_DETAIL_VPCS, type NetworkTopology } from '@/lib/network-topology-types';
import { networkDisplay } from '@/lib/network-display';

interface AccountRow { accountId: string; alias: string; isHost: boolean; enabled: boolean }

const list = (v: string | null) => (v ? v.split(',').filter((x) => x && x !== '__all__') : []);

/** 다중 계정 네트워크 토폴로지 — 전체 맵(계정·VPC·TGW·피어링)과 선택 VPC 상세(AWS 다이어그램). */
function NetworkTopologyPageInner() {
  const { tt } = useI18n();
  const router = useRouter();
  const params = useSearchParams();
  const theme = useTheme() === 'dark' ? 'dark' as const : 'light' as const;
  const accountsParam = params.get('accounts');
  const selectedAccounts = list(accountsParam);
  const vpcs = list(params.get('vpcs'));
  const detail = vpcs.length > 0;
  const [accounts, setAccounts] = useState<AccountRow[]>([]);
  const [picked, setPicked] = useState<string[]>([]);
  const [topology, setTopology] = useState<NetworkTopology | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [search, setSearch] = useState('');
  const [connectedOnly, setConnectedOnly] = useState(false);
  const shown = useMemo(() => topology && !detail ? networkDisplay(topology, search, connectedOnly) : topology,
    [topology, detail, search, connectedOnly]);

  useEffect(() => {
    fetch('/api/accounts').then((r) => (r.ok ? r.json() : null))
      .then((b) => setAccounts(Array.isArray(b?.accounts) ? b.accounts.filter((a: AccountRow) => a.enabled !== false) : []))
      .catch(() => setAccounts([]));
  }, []);

  const query = new URLSearchParams({ accounts: selectedAccounts.length ? selectedAccounts.join(',') : '__all__' });
  if (detail) query.set('vpcs', vpcs.join(','));
  const queryKey = query.toString();
  useEffect(() => {
    const controller = new AbortController();
    setBusy(true); setError(null);
    fetch(`/api/network-topology?${queryKey}`, { signal: controller.signal })
      .then(async (r) => { if (!r.ok) throw new Error(r.status === 400 ? 'invalid' : 'unavailable'); return r.json(); })
      .then((t: NetworkTopology) => setTopology(t))
      .catch((e) => { if (!controller.signal.aborted) { setTopology(null); setError(e instanceof Error ? e.message : 'unavailable'); } })
      .finally(() => { if (!controller.signal.aborted) setBusy(false); });
    return () => controller.abort();
  }, [queryKey]);

  const navigate = (next: { accounts?: string[]; vpcs?: string[] }) => {
    const q = new URLSearchParams();
    const a = next.accounts ?? selectedAccounts, v = next.vpcs ?? vpcs;
    if (a.length) q.set('accounts', a.join(','));
    if (v.length) q.set('vpcs', v.join(','));
    router.replace(`/topology/network${q.size ? `?${q}` : ''}`);
  };
  const toggleAccount = (id: string) => {
    const base = selectedAccounts.length ? selectedAccounts : [];
    navigate({ accounts: base.includes(id) ? base.filter((x) => x !== id) : [...base, id] });
  };
  const onSelectVpc = (key: string) => {
    if (detail) {
      if (!vpcs.includes(key) && vpcs.length < MAX_DETAIL_VPCS) navigate({ vpcs: [...vpcs, key] });
      return;
    }
    setPicked((p) => (p.includes(key) ? p.filter((x) => x !== key) : p.length < MAX_DETAIL_VPCS ? [...p, key] : p));
  };
  const label = (key: string) => topology?.nodes.find((n) => n.vpcKey === key && (n.kind === 'vpc' || n.kind === 'external'))?.label ?? key.split('/')[2];
  const o = topology?.omitted;

  return (
    <div className="flex h-full flex-col">
      <PageHeader
        title={tt('네트워크 토폴로지')}
        subtitle={tt(detail ? '선택한 VPC를 AZ·서브넷·리소스 단위로 표시합니다. 연결된 외부 VPC를 클릭하면 상세에 추가됩니다.'
          : '계정·리전별 VPC와 TGW·피어링 연결을 표시합니다. VPC를 클릭해 선택한 뒤 상세 보기로 이동하세요.')}
        right={
          <div className="flex max-w-full flex-wrap items-center gap-2 text-[12px] text-ink-600">
            {detail ? (
              <button onClick={() => { setPicked([]); navigate({ vpcs: [] }); }}
                className="rounded-md border border-ink-200 bg-card px-2 py-1 hover:bg-ink-50">{tt('← 전체 맵')}</button>
            ) : (
              <button disabled={!picked.length} onClick={() => navigate({ vpcs: picked })}
                className="rounded-md bg-brand-600 px-2 py-1 text-white disabled:opacity-40">
                {tt('상세 보기')} ({picked.length}/{MAX_DETAIL_VPCS})
              </button>
            )}
          </div>
        }
      />
      <div className="flex flex-wrap items-center gap-1.5 border-b border-ink-100 px-4 py-2 text-[12px]">
        <span className="text-ink-500">{tt('계정')}</span>
        <button onClick={() => navigate({ accounts: [] })} aria-pressed={!selectedAccounts.length}
          className={`rounded-full border px-2 py-0.5 ${!selectedAccounts.length ? 'border-brand-600 bg-brand-600 text-white' : 'border-ink-200 bg-card'}`}>
          {tt('전체')}
        </button>
        {accounts.map((a) => {
          const on = selectedAccounts.includes(a.accountId) || (a.isHost && selectedAccounts.includes('self'));
          return (
            <button key={a.accountId} onClick={() => toggleAccount(a.accountId)} aria-pressed={on}
              className={`rounded-full border px-2 py-0.5 ${on ? 'border-brand-600 bg-brand-50 text-brand-700' : 'border-ink-200 bg-card'}`}>
              {a.alias || a.accountId}{a.isHost ? ' (host)' : ''}
            </button>
          );
        })}
        {(detail ? vpcs : picked).length > 0 && <span className="ml-2 text-ink-500">{tt('선택한 VPC')}:</span>}
        {(detail ? vpcs : picked).map((k) => (
          <button key={k} onClick={() => (detail ? navigate({ vpcs: vpcs.filter((x) => x !== k) }) : onSelectVpc(k))}
            className="rounded-full border border-[#8C4FFF] px-2 py-0.5 text-[#8C4FFF]" title={k}>{label(k)} ×</button>
        ))}
      </div>
      <div className="flex flex-wrap gap-3 px-4 py-1.5 text-[11px] text-ink-500">
        <span>{tt('설정 기반 구성도이며 트래픽 도달성을 의미하지 않습니다.')}</span>
        {topology?.capturedAt && <span>{tt('수집 시각')}: {new Date(topology.capturedAt).toLocaleString()}</span>}
        {o && o.inactive > 0 && <span>{tt('비활성 연결 제외')}: {o.inactive}</span>}
        {o && o.conflicting > 0 && <span className="text-amber-600">{tt('충돌하는 연결 기록 보류')}: {o.conflicting}</span>}
        {o && o.resourcesCapped > 0 && <span>{tt('표시 한도로 묶인 리소스')}: {o.resourcesCapped}</span>}
        {topology?.truncated && <span className="text-amber-600">{tt('인벤토리 읽기 한도에 도달해 일부만 표시합니다.')}</span>}
      </div>
      {!detail && <div className="flex flex-wrap items-center gap-3 border-b border-ink-100 px-4 py-2 text-xs">
        <input aria-label={tt('네트워크 리소스 검색')} placeholder={tt('VPC·계정·리전 검색')} value={search}
          onChange={e => setSearch(e.target.value)} className="min-w-0 flex-1 rounded-md border border-ink-200 bg-card px-3 py-2 sm:max-w-xs" />
        <label className="flex items-center gap-1.5"><input type="checkbox" checked={connectedOnly}
          onChange={e => setConnectedOnly(e.target.checked)} />{tt('연결된 리소스만')}</label>
        {shown && topology && <span className="text-ink-500">{tt('표시')}: {shown.nodes.filter(n => ['vpc', 'external', 'tgw'].includes(n.kind)).length}/{topology.nodes.filter(n => ['vpc', 'external', 'tgw'].includes(n.kind)).length}
          {' · '}{tt('연결')}: {shown.edges.length}/{topology.edges.length}</span>}
      </div>}
      <div className="relative min-h-0 flex-1">
        {busy && <div className="absolute left-4 top-2 z-10 text-[12px] text-ink-400">{tt('로딩 중…')}</div>}
        {error && <div className="p-6 text-[13px] text-ink-500">{tt(error === 'invalid' ? '선택 범위가 올바르지 않습니다.' : '네트워크 토폴로지를 불러오지 못했습니다.')}</div>}
        {shown && !error && (detail && !shown.nodes.some((n) => n.kind === 'vpc')
          ? <div className="p-6 text-[13px] text-ink-500">{tt(shown.truncated ? '인벤토리 읽기 한도에 도달해 선택한 VPC를 불러오지 못했을 수 있습니다.' : '선택한 VPC가 인벤토리에 없습니다. 전체 맵에서 다시 선택하세요.')}</div>
          : shown.nodes.length
            ? <NetworkDiagram topology={shown} theme={theme} onSelectVpc={onSelectVpc} />
            : <div className="p-6 text-[13px] text-ink-500">{tt(search.trim() || connectedOnly ? '선택한 표시 조건에 맞는 리소스가 없습니다.' : '표시할 VPC가 없습니다. 인벤토리 동기화 상태를 확인하세요.')}</div>)}
      </div>
    </div>
  );
}

// useSearchParams requires a Suspense boundary at build time (repo convention).
export default function NetworkTopologyPage() {
  return (
    <Suspense fallback={<div className="p-6 text-[13px] text-ink-400">로딩 중…</div>}>
      <NetworkTopologyPageInner />
    </Suspense>
  );
}
