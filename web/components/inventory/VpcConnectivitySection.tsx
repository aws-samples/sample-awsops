'use client';
import { useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { ArrowDown, Network } from 'lucide-react';
import Card from '@/components/ui/Card';
import { useI18n } from '@/components/shell/LanguageProvider';
import { useActiveScope, scopeParams } from '@/lib/account-context';
import type { VpcConnectivity } from '@/lib/vpc-connectivity-types';

interface VpcChoice { key: string; id: string; account: string; region: string; name: string }
const button = 'rounded-md border border-ink-200 bg-card px-3 py-2 text-[13px] hover:bg-ink-50 disabled:opacity-50';
const SOURCE_LABELS: Record<string, string> = {
  'peering-requester': 'VPC 피어링 (요청자)', 'peering-accepter': 'VPC 피어링 (수락자)',
  'tgw-attachments': 'TGW 어태치먼트', 'tgw-peers': 'TGW 연결 VPC', source: 'VPC 소유 계정',
};
const str = (value: unknown) => typeof value === 'string' ? value : '';

function choices(rows: unknown[]): VpcChoice[] {
  return rows.flatMap(raw => {
    if (!raw || typeof raw !== 'object') return [];
    const row = raw as Record<string, unknown>;
    const id = str(row.resource_id), account = str(row.account_id), region = str(row.region);
    if (!/^vpc-(?:[0-9a-f]{8}|[0-9a-f]{17})$/.test(id) || !/^(self|\d{12})$/.test(account) || !/^[a-z]{2}(?:-[a-z]+)+-\d+$/.test(region)) return [];
    const data = row.data && typeof row.data === 'object' ? row.data as Record<string, unknown> : {};
    return [{ key: `${account}/${region}/${id}`, id, account, region, name: str(data.name) || id }];
  });
}

function matchesResult(data: VpcConnectivity, choice: VpcChoice): boolean {
  const nullableText = (value: unknown) => value === null || typeof value === 'string';
  return data?.source?.vpcId === choice.id && data.source.region === choice.region
    && (choice.account === 'self' ? /^\d{12}$/.test(data.source.accountId) : data.source.accountId === choice.account)
    && (data.source.ownerId === null || typeof data.source.ownerId === 'string' && /^\d{12}$/.test(data.source.ownerId))
    && (data.source.name === undefined || typeof data.source.name === 'string')
    && Number.isFinite(Date.parse(data.checkedAt))
    && Array.isArray(data.peerings) && data.peerings.every(p => p && typeof p.id === 'string' && typeof p.state === 'string' && typeof p.peer?.vpcId === 'string'
      && nullableText(p.peer.accountId) && nullableText(p.peer.region) && nullableText(p.peer.cidr))
    && Array.isArray(data.transitGateways) && data.transitGateways.every(t => t && typeof t.id === 'string' && typeof t.state === 'string'
      && typeof t.attachmentId === 'string' && nullableText(t.routeTableId)
      && Array.isArray(t.peers) && t.peers.every(p => p && typeof p.vpcId === 'string' && typeof p.state === 'string'
        && typeof p.attachmentId === 'string' && nullableText(p.accountId) && nullableText(p.routeTableId)))
    && Array.isArray(data.incompleteSources) && data.incompleteSources.every(s => typeof s === 'string')
    && (data.source.ownerId === data.source.accountId || data.incompleteSources.includes('source'));
}

function ConnectivityPanel({ scopeQuery, ready }: { scopeQuery: string; ready: boolean }) {
  const { tt } = useI18n();
  const [opened, setOpened] = useState(false);
  const [vpcs, setVpcs] = useState<VpcChoice[]>([]);
  const [selected, setSelected] = useState('');
  const [listRead, setListRead] = useState(false);
  const [listCapped, setListCapped] = useState(false);
  const [invalidRows, setInvalidRows] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [data, setData] = useState<VpcConnectivity | null>(null);
  const request = useRef<{ controller: AbortController; generation: number } | null>(null);
  const generation = useRef(0);
  useEffect(() => () => { generation.current++; request.current?.controller.abort(); }, []);

  const start = () => {
    request.current?.controller.abort();
    const current = { controller: new AbortController(), generation: ++generation.current };
    request.current = current;
    setBusy(true); setError(''); setData(null);
    return current;
  };
  const current = (id: number) => generation.current === id;
  const loadList = async () => {
    setOpened(true);
    const next = start();
    try {
      const response = await fetch(`/api/inventory/vpc?limit=500&${scopeQuery}`, { signal: next.controller.signal });
      if (!response.ok) throw new Error();
      const body = await response.json();
      if (!Array.isArray(body.rows)) throw new Error();
      if (!current(next.generation)) return;
      const options = choices(body.rows);
      setVpcs(options); setSelected(options[0]?.key ?? ''); setListRead(true);
      setListCapped(body.rows.length >= 500); setInvalidRows(options.length !== body.rows.length);
    } catch {
      if (current(next.generation)) setError('VPC 목록을 불러오지 못했습니다. 다시 시도하세요.');
    } finally { if (current(next.generation)) setBusy(false); }
  };
  const loadConnections = async () => {
    const choice = vpcs.find(v => v.key === selected);
    if (!choice) return;
    const next = start();
    try {
      const params = new URLSearchParams({ account: choice.account, region: choice.region, vpcId: choice.id });
      const response = await fetch(`/api/vpc-connectivity?${params}`, { signal: next.controller.signal });
      if (!response.ok) throw new Error();
      const result = await response.json();
      if (!matchesResult(result, choice)) throw new Error();
      if (current(next.generation)) setData(result);
    } catch {
      if (current(next.generation)) setError('연결 정보를 불러오지 못했습니다. 계정·리전과 조회 권한을 확인한 뒤 다시 시도하세요.');
    } finally { if (current(next.generation)) setBusy(false); }
  };
  const unknown = tt('미확인');
  const identity = (account: string | null, region?: string | null) => `${account || unknown}${region !== undefined ? ` · ${region || unknown}` : ''}`;
  const tag = (state: string) => <span className="rounded bg-ink-100 px-2 py-0.5 text-[12px] text-ink-700">{state}</span>;

  return (
    <section id="vpc-connectivity" className="scroll-mt-6" aria-label={tt('VPC 간 연결')}>
      <Card title={<h2 className="whitespace-normal break-words">{tt('VPC 간 연결')}</h2>} subtitle={tt('VPC Peering · Transit Gateway')}
        right={<Link href="/topology/infra" className={`${button} inline-flex items-center gap-1`}><Network size={14} />{tt('리소스 그래프 열기')}</Link>}>
        <p className="mb-3 text-[13px] text-ink-600">{tt('선택한 VPC의 피어링과 TGW 연결 구성을 조회합니다. 실제 통신 가능 여부는 라우트·보안 정책을 별도로 확인해야 합니다.')}</p>
        {!opened ? <button type="button" className={button} disabled={!ready} onClick={loadList}>{tt('VPC 간 연결 보기')}</button> : (
          <div className="space-y-3">
            <div className="flex flex-wrap items-end gap-2">
              {vpcs.length > 0 && <label className="flex min-w-0 flex-1 basis-full flex-col gap-1 text-[12px] text-ink-600 sm:basis-0">
                {tt('기준 VPC')}
                <select aria-label={tt('기준 VPC')} className="w-full min-w-0 rounded-md border border-ink-200 bg-card px-2 py-2 text-[13px]"
                  value={selected} onChange={e => { generation.current++; request.current?.controller.abort(); setSelected(e.target.value); setData(null); setError(''); setBusy(false); }}>
                  {vpcs.map(v => <option key={v.key} value={v.key}>{v.name} · {v.id} · {v.account} · {v.region}</option>)}
                </select>
              </label>}
              <button type="button" className={button} disabled={busy || !selected} onClick={loadConnections}>{tt('연결 조회')}</button>
              <button type="button" className={button} disabled={busy} onClick={loadList}>{tt('VPC 목록 새로고침')}</button>
            </div>
            {busy && <p role="status" className="text-[13px] text-ink-500">{tt('불러오는 중…')}</p>}
            {error && <p role="alert" className="text-[13px] text-rose-600">{tt(error)}</p>}
            {listCapped && <p className="text-[12px] text-amber-700 [[data-theme=dark]_&]:text-amber-300">{tt('VPC 목록 상한에 도달했습니다. 계정·리전 범위를 좁혀 조회하세요.')}</p>}
            {invalidRows && <p className="text-[12px] text-amber-700 [[data-theme=dark]_&]:text-amber-300">{tt('계정·리전을 확인할 수 없는 VPC는 선택 목록에서 제외했습니다.')}</p>}
            {listRead && !busy && !vpcs.length && <p className="text-[13px] text-ink-500">{tt('선택 범위에 표시할 VPC가 없습니다. 인벤토리 수집 상태를 확인하세요.')}</p>}
            {data && (
              <div className="space-y-4">
                {data.incompleteSources.length > 0 && <p role="alert" className="rounded-md bg-amber-500/10 p-3 text-[13px] text-amber-700 [[data-theme=dark]_&]:text-amber-300">
                  {tt('일부 연결 정보를 확인하지 못했습니다. 표시되지 않은 연결이 있을 수 있습니다.')}
                  {' '}{data.incompleteSources.map(s => tt(SOURCE_LABELS[s] ?? '미확인')).join(' · ')}
                </p>}
                <div className="rounded-md border border-brand-200 bg-brand-500/5 p-3 text-[13px]">
                  <strong>{data.source.name || data.source.vpcId}</strong>
                  <div className="break-all font-mono text-[12px]">{data.source.vpcId} · {identity(data.source.accountId, data.source.region)}</div>
                  <div className="mt-1 break-all text-[12px]">{tt('VPC 소유 계정')}: {data.source.ownerId || unknown}</div>
                  {data.source.ownerId !== data.source.accountId && <p className="mt-1 text-[12px] text-ink-600">{tt(data.source.ownerId
                    ? '공유 VPC의 전체 연결은 소유 계정에서 확인하세요.'
                    : '소유 계정이 미확인이므로 연결 목록의 완전성을 판단할 수 없습니다.')}</p>}
                  <div className="mt-1 text-[12px] text-ink-500">{tt('조회 시점:')} {new Date(data.checkedAt).toLocaleString()}</div>
                </div>
                <div className="grid gap-4 lg:grid-cols-2">
                  <div className="space-y-2">
                    <h3 className="text-[14px] font-semibold">VPC Peering</h3>
                    {data.peerings.map(p => <article key={p.id} className="rounded-lg border border-ink-200 p-3 text-[13px]">
                      <div className="flex flex-wrap items-center gap-2"><strong className="break-all font-mono">{p.id}</strong>{tag(p.state)}</div>
                      <ArrowDown size={16} className="my-2 text-ink-400" aria-hidden="true" />
                      <div className="break-all font-mono">{p.peer.vpcId}</div>
                      <div className="break-all text-[12px] text-ink-500">{identity(p.peer.accountId, p.peer.region)}</div>
                      {p.peer.cidr && <div className="font-mono text-[12px]">{p.peer.cidr}</div>}
                    </article>)}
                  </div>
                  <div className="space-y-2">
                    <h3 className="text-[14px] font-semibold">Transit Gateway</h3>
                    {data.transitGateways.map(t => <article key={t.attachmentId} className="rounded-lg border border-ink-200 p-3 text-[13px]">
                      <div className="flex flex-wrap items-center gap-2"><strong className="break-all font-mono">{t.id}</strong>{tag(t.state)}</div>
                      <div className="mt-1 break-all font-mono text-[12px] text-ink-500">{t.attachmentId}</div>
                      <div className="break-all text-[12px] text-ink-500">{tt('연결된 TGW 라우트 테이블')}: {t.routeTableId || unknown}</div>
                      <div className="mt-3 text-[12px] font-medium">{tt('동일 TGW에 연결된 VPC')}</div>
                      <ul className="mt-2 max-h-80 space-y-2 overflow-auto">
                        {t.peers.map(p => <li key={p.attachmentId} className="rounded-md bg-ink-50 p-2">
                          <div className="flex flex-wrap items-center gap-2"><span className="break-all font-mono">{p.vpcId}</span>{tag(p.state)}</div>
                          <div className="break-all text-[12px] text-ink-500">{identity(p.accountId)} · {p.attachmentId}</div>
                          <div className="break-all text-[12px] text-ink-500">{tt('연결된 TGW 라우트 테이블')}: {p.routeTableId || unknown}</div>
                        </li>)}
                      </ul>
                      {!t.peers.length && <p className="mt-2 text-[12px] text-ink-500">{tt('표시할 상대 VPC가 없습니다. TGW 소유 계정에서 전체 어태치먼트를 확인하세요.')}</p>}
                    </article>)}
                  </div>
                </div>
                {!data.incompleteSources.length && !data.peerings.length && !data.transitGateways.length &&
                  <p className="text-[13px] text-ink-500">{tt('조회 범위에서 VPC 연결이 발견되지 않았습니다.')}</p>}
                <Link href="/network-paths" className="inline-block text-[13px] text-brand-700 underline">{tt('네트워크 경로 점검 열기')}</Link>
              </div>
            )}
          </div>
        )}
      </Card>
    </section>
  );
}

export default function VpcConnectivitySection() {
  const [scope, , ready] = useActiveScope();
  const query = scopeParams(scope);
  // Remount before paint on a scope change: stale choices/results never cross accounts.
  return <ConnectivityPanel key={query} scopeQuery={query} ready={ready} />;
}
