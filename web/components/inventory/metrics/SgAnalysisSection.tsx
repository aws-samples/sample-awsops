'use client';
import { useEffect, useMemo, useState } from 'react';
import { AlertTriangle, CheckCircle2, Globe, Layers, Link2, Unplug, Activity } from 'lucide-react';
import Card from '@/components/ui/Card';
import StatTile from '@/components/ui/StatTile';
import Badge from '@/components/ui/Badge';
import MetricTable, { type MetricCol } from './MetricTable';
import DonutBreakdown from '@/components/charts/DonutBreakdown';
import { RangePicker, TH, TD, MONO, DANGER, dash } from './shared';
import { useI18n } from '@/components/shell/LanguageProvider';
import type { Row } from './shared';
import type { SgAnalysis, SgUsageRow, SgHitsResult, SgRule, SgHitNote } from '@/lib/sg-analysis';

// Security Group 분석 섹션 (owner 요청 3축) — 인벤토리 security_group 페이지 하단에 부착.
// ① 사용 유무: ENI 부착 + 상호참조 → 미사용(정리 후보) 표면화
// ② 소스/목적지 식별: 룰 peer를 sg 이름·VPC 이름·인터넷 전체·프리픽스 리스트로 해석
// ③ 히트 매칭: 행 클릭 → Flow Logs(정확) 또는 NFM(근사) 기반 룰별 매칭 + 실제 트래픽 상대
// 데이터는 /api/sg (인벤토리 행과 독립 — 라이브 EC2/ENI 조회, 4분 TTL).

const bytes = (v: number) => {
  if (v >= 1024 ** 4) return `${(v / 1024 ** 4).toFixed(2)} TB`;
  if (v >= 1024 ** 3) return `${(v / 1024 ** 3).toFixed(2)} GB`;
  if (v >= 1024 ** 2) return `${(v / 1024 ** 2).toFixed(1)} MB`;
  if (v >= 1024) return `${(v / 1024).toFixed(1)} KB`;
  return `${Math.round(v)} B`;
};

/** peer 라벨 — internet 룰은 서버가 raw CIDR을 주므로 여기서 번역 (i18n 페이로드 방지). */
function peerLabel(r: SgRule, tt: (s: string) => string): string {
  if (r.peerKind === 'internet') return r.peer === '::/0' ? tt('인터넷 전체 (IPv6)') : tt('인터넷 전체');
  return r.peerLabel;
}

/** note 코드 → 한국어 원문 (tt가 en/zh/ja로 해석). */
const NOTE_TEXT: Record<Exclude<SgHitNote, null>, string> = {
  sg_not_found: 'SG를 찾을 수 없음',
  no_eni: '부착된 ENI가 없어 트래픽 증거 자체가 없습니다 (확인 불가 — 미사용 확정 아님)',
  no_source: 'VPC Flow Logs·NFM 모두 없음 — 트래픽 데이터 소스가 없습니다',
  query_failed: 'Flow Logs 조회가 실패했습니다(소스가 없는 게 아님) — 잠시 후 다시 시도해 주세요',
  flow_no_records: 'Flow Logs에 기간 내 레코드 없음 (또는 커스텀 포맷 — 기본 포맷만 해석)',
  flow_eni_truncated: 'ENI 50개까지만 집계 — 히트 수는 부분 집계이며 매칭 0 룰이 실제 유휴가 아닐 수 있습니다',
  flow_capped: 'Insights 상위 200건 캡 — 저용량 매칭이 누락됐을 수 있어 매칭 0으로 보이는 룰 중 일부는 확인 불가로 표시됩니다',
  nfm_peers_only: 'VPC Flow Logs 미설정 — NFM은 트래픽 상대만 식별하며 특정 룰 히트로 귀속하지 못합니다 (룰 매칭은 Flow Logs 필요, 최근 1시간)',
};

/** 히트 매칭 드릴다운 (행 클릭 → 지연 fetch). regionsKey는 부모의 스코프와 반드시 일치해야
 *  한다 — sgAnalysis()가 스코프별로 별도 캐시를 두므로, 다른 스코프로 조회하면 부모 목록에서
 *  본 sgId가 이 스코프의 캐시엔 없어 sg_not_found가 될 수 있다. */
function SgHitsPanel({ sgId, range, regionsKey }: { sgId: string; range: number; regionsKey: string }) {
  const { tt } = useI18n();
  const [data, setData] = useState<SgHitsResult | null>(null);
  const [err, setErr] = useState('');
  useEffect(() => {
    let live = true;
    setData(null); setErr('');
    const regionsParam = regionsKey ? `&regions=${encodeURIComponent(regionsKey)}` : '';
    fetch(`/api/sg?view=hits&id=${encodeURIComponent(sgId)}&range=${range}${regionsParam}`)
      .then(async (r) => { const d = await r.json().catch(() => null); if (!r.ok) throw new Error(d?.message ?? `HTTP ${r.status}`); return d as SgHitsResult; })
      .then((d) => { if (live) setData(d); })
      .catch((e) => { if (live) setErr(e instanceof Error ? e.message : String(e)); });
    return () => { live = false; };
  }, [sgId, range, regionsKey]);

  if (err) return <div className="px-4 py-3 text-[13px] text-rose-600">{tt('히트 매칭 조회 실패')}: {err}</div>;
  if (!data) return <div className="px-4 py-3 text-[13px] text-ink-400">{tt('트래픽 매칭 조회 중…')}</div>;

  // 리뷰 MAJOR(라운드11): 매칭은 (dstaddr,dstport,protocol) 튜플 비교라 같은 ENI에
  // SG가 여러 개거나 인바운드 룰이 겹치면 실제로는 다른 SG/룰이 허용한 트래픽도 이
  // 룰의 히트로 잡힐 수 있다 — "룰 단위로 정확히 귀속됨"처럼 보이면 과신 위험이라
  // 툴팁으로 고지(과대추정 방향이라 거짓 idle 억제엔 유리하지만 숫자 자체는 근사).
  const srcBadge = data.source === 'flowlogs'
    ? <span title={tt('(대상IP,포트,프로토콜) 튜플 매칭 — 같은 ENI에 SG가 여러 개거나 룰이 겹치면 다른 SG/룰이 허용한 트래픽도 이 룰의 히트로 집계될 수 있습니다')}><Badge tone="brand" variant="soft">Flow Logs</Badge></span>
    : data.source === 'nfm'
      ? <Badge variant="soft">NFM ({tt('상대만')})</Badge>
      : <Badge variant="outline">{tt('데이터 없음')}</Badge>;

  return (
    <div className="flex flex-col gap-3 px-4 py-3">
      <div className="flex flex-wrap items-center gap-2 text-[12.5px]">
        <span className="font-semibold">{tt('히트 매칭')}</span>
        {srcBadge}
        {data.idleIngressRules > 0 && (
          <Badge tone="negative" variant="soft">{tt('매칭 없는 인바운드 룰')} {data.idleIngressRules}</Badge>
        )}
      </div>
      {data.note && <div className="text-[12px] text-ink-500">{tt(NOTE_TEXT[data.note])}</div>}

      {data.ruleHits.length > 0 && (
        <div className="overflow-x-auto">
          <table className="w-full">
            <thead><tr className="border-b border-ink-100">
              <th className={TH}>{tt('방향')}</th><th className={TH}>Proto</th><th className={TH}>Port</th>
              <th className={TH}>{tt('소스')}</th>
              <th className={TH} title={data.source === 'flowlogs' ? tt('튜플 매칭 근사 — SG/룰이 겹치면 다른 룰의 허용 트래픽도 포함될 수 있습니다') : undefined}>{tt('매칭')}</th>
              <th className={TH}>{tt('전송량')}</th>
            </tr></thead>
            <tbody>
              {data.ruleHits.map((r, i) => (
                <tr key={i} className={`border-b border-ink-50 last:border-0 ${r.hits === 0 ? 'opacity-60' : ''}`}>
                  <td className={TD}>ingress</td>
                  <td className={TD}>{r.protocol}</td>
                  <td className={TD}>{r.portRange}</td>
                  <td className={MONO}>{peerLabel(r, tt)}</td>
                  <td className={`${TD} ${r.hits ? DANGER : ''}`}>
                    {r.hits == null ? <span className="text-ink-300" title={tt('이 룰 유형은 히트 매칭을 산출할 수 없음')}>n/a</span> : r.hits.toLocaleString()}
                  </td>
                  <td className={TD}>{r.bytes > 0 ? bytes(r.bytes) : dash}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {data.peers.length > 0 && (
        <>
          <div className="text-[12px] font-medium text-ink-600">{tt('실제 트래픽 상대 (Top)')}</div>
          <div className="overflow-x-auto">
            <table className="w-full">
              <thead><tr className="border-b border-ink-100">
                <th className={TH}>IP</th><th className={TH}>{tt('식별')}</th><th className={TH}>Port</th>
                <th className={TH}>{tt('액션')}</th><th className={TH}>{tt('전송량')}</th>
              </tr></thead>
              <tbody>
                {data.peers.map((p, i) => (
                  <tr key={i} className="border-b border-ink-50 last:border-0">
                    <td className={MONO}>{p.ip}</td>
                    <td className={TD}>{p.label ?? dash}</td>
                    <td className={TD}>{p.port ?? dash}</td>
                    <td className={TD}>{p.action === 'REJECT'
                      ? <span className={DANGER}>REJECT</span>
                      : p.action ?? dash}</td>
                    <td className={TD}>{p.bytes > 0 ? bytes(p.bytes) : dash}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
    </div>
  );
}

/** 서버(/api/sg)가 `?regions=` 파싱 단계에서 상한/형식 불일치로 스코프를 잘랐을 때
 *  얹는 신호 — sgAnalysis()의 SgAnalysis 타입 자체엔 없다(라우트 계층에서만 계산되는
 *  값이라 sg-analysis.ts의 리턴 타입을 오염시키지 않고 응답에만 덧붙인다). */
type SgAnalysisResponse = SgAnalysis & { scopeTruncated?: boolean };

export function SgAnalysisSection({ rows }: { rows: Row[] }) {
  const { tt } = useI18n();
  const [data, setData] = useState<SgAnalysisResponse | null>(null);
  const [err, setErr] = useState('');
  const [range, setRange] = useState(86400);
  const [openId, setOpenId] = useState<string | null>(null);

  // 리뷰 MAJOR(확정): 형제 TgwSection처럼 scope-filtered rows에서 리전을 뽑아 서버에 넘긴다
  // — 안 그러면 페이지 상단의 계정/리전 선택과 무관하게 항상 호스트 계정 전 리전이 보인다.
  const regionsKey = useMemo(() => [...new Set(rows.map((r) => String(r.region ?? '')).filter(Boolean))].sort().join(','), [rows]);

  useEffect(() => {
    let live = true;
    // 리뷰 MINOR(확정, 라운드6): 스코프(regionsKey)가 바뀌었는데 이전 응답을 그대로
    // 들고 있으면, 새 fetch가 완료되기 전까지 이전 스코프의 데이터가 화면에 남아 마치
    // 새 스코프 결과인 것처럼 보인다 — 스코프 전환 즉시 비워서 그 창을 없앤다.
    setData(null); setErr(''); setOpenId(null);
    // rows가 비어 있으면(아래 rows.length===0 → return null 가드로 화면엔 아무것도
    // 안 그려지지만, 훅은 무조건 실행되므로) regionsKey=''로 무스코프 전체 호스트 계정
    // 스캔이 나갔다 — 표시할 데이터가 없는데 계정 전체를 스캔할 이유가 없다.
    if (rows.length === 0) return;
    const regionsParam = regionsKey ? `?regions=${encodeURIComponent(regionsKey)}` : '';
    fetch(`/api/sg${regionsParam}`)
      .then(async (r) => { const d = await r.json().catch(() => null); if (!r.ok) throw new Error(d?.message ?? `HTTP ${r.status}`); return d as SgAnalysisResponse; })
      .then((d) => { if (live) { setData(d); setErr(''); } })
      .catch((e) => { if (live) setErr(e instanceof Error ? e.message : String(e)); });
    return () => { live = false; };
  }, [regionsKey, rows.length]);

  // 부착 리소스 종류 분포 (전 SG 합산 — 도넛).
  const kindDist = useMemo(() => {
    if (!data) return [];
    const m = new Map<string, number>();
    for (const r of data.rows) for (const k of r.attachedKinds) m.set(k.kind, (m.get(k.kind) ?? 0) + k.count);
    return [...m.entries()].map(([name, value]) => ({ name, value })).sort((a, b) => b.value - a.value);
  }, [data]);

  const columns = useMemo<MetricCol<SgUsageRow>[]>(() => [
    {
      key: 'id', label: 'SG', mono: true,
      title: tt('부착도 참조도 없는 SG는 빨간색 — 정리 후보'),
      value: (r) => r.id,
      danger: (r) => r.unused,
    },
    { key: 'name', label: 'Name', value: (r) => r.name },
    { key: 'vpc', label: 'VPC', mono: true, facet: true, value: (r) => r.vpcLabel || null },
    {
      key: 'usage', label: tt('사용'), facet: true,
      title: tt('부착=ENI 연결됨 · 참조=다른 SG 룰이 소스로 사용 · 미사용=둘 다 없음 (default SG는 AWS가 삭제를 막아 별도 표시)'),
      value: (r) => (r.eniCount > 0 ? 'attached' : r.referencedBy.length > 0 ? 'referenced' : r.isDefault ? 'default' : 'unused'),
      render: (r) => r.eniCount > 0
        ? <span className="text-emerald-700">{tt('부착')} {r.eniCount}</span>
        : r.referencedBy.length > 0
          ? <Badge variant="soft">{tt('참조만')}</Badge>
          // default SG는 AWS가 삭제를 막는다 — "정리 후보"로 표시하면 오탐(모든 VPC에 상시 존재).
          : r.isDefault
            ? <Badge variant="outline">{tt('기본 — 삭제 불가')}</Badge>
            : <Badge tone="negative" variant="soft">{tt('미사용')}</Badge>,
      danger: (r) => r.unused,
    },
    {
      key: 'kinds', label: tt('부착 리소스'),
      value: (r) => r.attachedKinds.map((k) => k.kind).join(',') || null,
      render: (r) => r.attachedKinds.length === 0
        ? dash
        : <span className="inline-flex flex-wrap gap-1">
            {r.attachedKinds.map((k) => <Badge key={k.kind} variant="outline">{`${k.kind}${k.count > 1 ? ` ×${k.count}` : ''}`}</Badge>)}
          </span>,
    },
    {
      key: 'refs', label: tt('참조 SG'), type: 'num',
      title: tt('이 SG를 소스로 참조하는 다른 SG 수 — 있으면 삭제 불가'),
      value: (r) => r.referencedBy.length,
      render: (r) => r.referencedBy.length === 0 ? dash : <span title={r.referencedBy.join(', ')}>{r.referencedBy.length}</span>,
    },
    { key: 'ingress', label: 'Ingress', type: 'num', value: (r) => r.ingressRules },
    { key: 'egress', label: 'Egress', type: 'num', value: (r) => r.egressRules },
    {
      key: 'open', label: tt('개방 인바운드'), type: 'num',
      title: tt('0.0.0.0/0 또는 ::/0 인바운드 룰 수 — 인터넷 전체 노출'),
      value: (r) => r.openIngress,
      render: (r) => r.openIngress === 0 ? dash : <Badge tone="negative" variant="soft">{r.openIngress}</Badge>,
      danger: (r) => r.openIngress > 0,
    },
  ], [tt]);

  if (rows.length === 0) return null;
  const t = data?.totals;

  return (
    <>
      <Card
        title="보안 그룹 사용 분석"
        subtitle="ENI 부착·상호참조 기반 사용 유무 + 룰 소스/목적지 식별 — 행 클릭 시 트래픽 히트 매칭"
        padded={false}
        right={<RangePicker value={range} onChange={setRange} />}
      >
        {/* 리뷰 MAJOR(확정, 2라운드): 리전은 이제 TgwSection과 동일하게 scope-filtered rows에서
            뽑아 서버에 넘기므로(regionsKey) 위 테이블과 같은 리전만 스캔한다. 다만 계정은
            여전히 호스트 계정 고정이다(형제 섹션들도 account_id 스코핑을 하지 않는 동일 패턴
            — 계정 단위 크레덴셜 라우팅은 이 PR 범위 밖의 더 깊은 아키텍처 변경) — 멤버 계정
            뷰에서는 그 사실을 계속 고지한다. */}
        <div className="px-4 pt-4 text-[12px] text-ink-400">{tt('이 분석은 위 표와 같은 리전만 스캔하지만, 계정은 항상 호스트 계정입니다.')}</div>
        {err && <div className="px-4 py-3 text-[13px] text-rose-600">{tt('보안 그룹 분석 조회 실패')}: {err}</div>}
        {!data && !err && <div className="px-4 py-3 text-[13px] text-ink-400">{tt('로딩 중…')}</div>}
        {/* 리뷰 MAJOR(확정, 라운드5): 서버가 ?regions= 상한(20개)이나 형식 불일치로 스코프를
            조용히 잘라도 이전엔 응답에 아무 신호가 없었다 — "위 표와 같은 리전만 스캔한다"는
            위 고지와 달리 실제로는 더 적은 리전만 스캔됐는데도 "이상 없음"이 확정처럼 보였다. */}
        {data && data.scopeTruncated && (
          <div className="flex items-start gap-2 px-4 pt-4 text-[12px] text-warning-text">
            <AlertTriangle size={14} className="mt-0.5 shrink-0" />
            <span>{tt('스캔 범위가 상한을 넘어 일부 리전이 제외됐습니다')} — {tt('해당 리전의 보안 그룹·부착 집계가 실제보다 적을 수 있습니다.')}</span>
          </div>
        )}
        {data && data.degradedRegions.length > 0 && (
          <div className="flex items-start gap-2 px-4 pt-4 text-[12px] text-warning-text">
            <AlertTriangle size={14} className="mt-0.5 shrink-0" />
            <span>{tt('일부 리전 조회 실패')} ({data.degradedRegions.join(', ')}) — {tt('해당 리전의 보안 그룹·부착 집계가 실제보다 적을 수 있습니다.')}</span>
          </div>
        )}
        {data && t && (() => {
          const resourcesDegraded = data.degradedRegions.length > 0 || !!data.scopeTruncated;
          const lb = (n: number) => (resourcesDegraded ? `${n}+` : String(n));
          const degradedHint = tt('일부 리전 조회 실패 — 실제보다 적을 수 있음');
          return (
          <>
            <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-5 gap-4 px-4 pt-4">
              <StatTile label="보안 그룹" value={lb(t.total)} variant={resourcesDegraded ? 'warn' : 'default'} hint={resourcesDegraded ? degradedHint : `ENI ${t.enis}`} icon={<Layers size={16} />} />
              <StatTile label="부착됨" value={lb(t.attached)} variant={resourcesDegraded ? 'warn' : 'default'} hint={resourcesDegraded ? degradedHint : `${tt('사용 중')}`} icon={<Activity size={16} />} />
              <StatTile label="미사용" value={lb(t.unused)} variant={t.unused > 0 || resourcesDegraded ? 'warn' : 'default'} hint={resourcesDegraded ? degradedHint : tt('부착·참조 모두 없음 (default SG 제외)')} icon={<Unplug size={16} />} />
              <StatTile label="참조만" value={lb(t.referencedOnly)} variant={resourcesDegraded ? 'warn' : 'default'} hint={resourcesDegraded ? degradedHint : tt('다른 SG가 참조 — 삭제 불가')} icon={<Link2 size={16} />} />
              <StatTile label="개방 인바운드" value={lb(t.openIngress)} variant={t.openIngress > 0 ? 'danger' : resourcesDegraded ? 'warn' : 'default'} hint={resourcesDegraded ? degradedHint : "0.0.0.0/0 · ::/0"} icon={<Globe size={16} />} />
            </div>

            {t.unused === 0 && (
              resourcesDegraded ? (
                <div className="flex items-start gap-2 px-4 pt-3 text-[13px] text-warning-text">
                  <AlertTriangle size={15} className="mt-0.5 shrink-0" />
                  {tt('일부 리전 조회 실패로 미사용 보안 그룹 여부를 확정할 수 없습니다')}
                </div>
              ) : (
                <div className="flex items-center gap-2 px-4 pt-3 text-[13px] text-emerald-700">
                  <CheckCircle2 size={15} />{tt('이상 없음 — 미사용 보안 그룹 없음')}
                </div>
              )
            )}

            <div className="px-1 pt-2">
              <MetricTable
                columns={columns}
                items={data.rows}
                rowKey={(r) => `${r.region}|${r.id}`}
                emptyText="보안 그룹 없음"
                onRowClick={(r) => setOpenId((cur) => (cur === r.id ? null : r.id))}
              />
            </div>
          </>
          );
        })()}
      </Card>

      {/* 부착 리소스 종류 분포 — 페이지 레벨 (DonutBreakdown이 자체 Card 렌더, 중첩 회피) */}
      {data && kindDist.length > 0 && (
        <DonutBreakdown title="부착 리소스 종류 분포" data={kindDist} nameKey="name" valueKey="value" />
      )}

      {/* 히트 매칭 드릴다운 — 선택 SG의 룰별 매칭 + 실제 트래픽 상대 (행 클릭 토글) */}
      {openId && (
        <Card
          title={`${tt('트래픽 히트 매칭')} — ${openId}`}
          subtitle="선택 보안 그룹의 인바운드 룰별 매칭 트래픽과 실제 상대 (Flow Logs 우선, 없으면 NFM 근사)"
          padded={false}
          right={<button type="button" onClick={() => setOpenId(null)} className="px-3 py-1 text-[12px] text-brand-700 hover:underline">{tt('닫기')}</button>}
        >
          <SgHitsPanel sgId={openId} range={range} regionsKey={regionsKey} />
        </Card>
      )}
    </>
  );
}
