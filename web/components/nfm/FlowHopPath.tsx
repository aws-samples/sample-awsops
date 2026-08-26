'use client';
import { useMemo } from 'react';
import {
  Box, Boxes, Circle, Cloud, Database, GitFork, Globe, Globe2, Grid2x2, Layers, Link2,
  MapPin, Network, PlugZap, Router, Scale, Server, type LucideIcon,
} from 'lucide-react';
import { useI18n } from '@/components/shell/LanguageProvider';
import type { NfmEndpoint, NfmFlowRow } from '@/lib/nfm';

// End-to-End 경로 스텝퍼 — nfm-dashboard HopPath/ResourceIcon 이식 (AWS NFM 콘솔 스타일):
// 원형 kind 아이콘 + 얇은 연결선, 각 홉 아래 라벨/mono id/컨텍스트, SNAT·DNAT·포트 배지.
// 홉 체인 = 로컬 엔드포인트 → traversedConstructs(순서 유지) → 원격 엔드포인트.
// 색은 보조 인코딩일 뿐 kind마다 고유 글리프를 가진다 (color-only 식별 금지).

export type ResourceKind =
  | 'pod' | 'namespace' | 'service' | 'cluster' | 'instance' | 'eni' | 'subnet' | 'az'
  | 'vpc' | 'vpce' | 'tgw' | 'nat' | 'lb' | 'awsservice' | 'region' | 'internet' | 'other';

/** kind별 글리프 + 색 (v2 팔레트 hex — 두 테마 공통, wash 배경은 color-mix). */
export const KIND_META: Record<ResourceKind, { icon: LucideIcon; color: string }> = {
  pod: { icon: Box, color: '#3b82f6' },
  namespace: { icon: Boxes, color: '#8b5cf6' },
  service: { icon: Network, color: '#0ea5e9' },
  cluster: { icon: Layers, color: '#14b8a6' },
  instance: { icon: Server, color: '#f59e0b' },
  eni: { icon: PlugZap, color: '#f43f5e' },
  subnet: { icon: Grid2x2, color: '#10b981' },
  az: { icon: MapPin, color: '#a78bfa' },
  vpc: { icon: Cloud, color: '#6366f1' },
  vpce: { icon: Link2, color: '#0ea5e9' },
  tgw: { icon: GitFork, color: '#14b8a6' },
  nat: { icon: Router, color: '#f97316' },
  lb: { icon: Scale, color: '#06b6d4' },
  awsservice: { icon: Database, color: '#2563eb' },
  region: { icon: Globe, color: '#0284c7' },
  internet: { icon: Globe2, color: '#6b7280' },
  other: { icon: Circle, color: '#9ca3af' },
};

/** 원형 kind 배지 — 테두리는 kind 색, 배경은 같은 색의 반투명 wash, 글리프는 currentColor. */
export function ResourceIcon({ kind, size = 28 }: { kind: ResourceKind; size?: number }) {
  const { icon: Icon, color } = KIND_META[kind];
  return (
    <span
      className="inline-flex shrink-0 items-center justify-center rounded-full border text-ink-700"
      style={{ width: size, height: size, borderColor: color, backgroundColor: `color-mix(in srgb, ${color} 20%, transparent)` }}
    >
      <Icon size={Math.round(size * 0.55)} strokeWidth={1.75} aria-hidden />
    </span>
  );
}

// traversedIds 항목("Type:id" | "ServiceName") → kind (case-insensitive contains, nfm-dashboard KIND_RULES).
const KIND_RULES: [string, ResourceKind][] = [
  ['transitgateway', 'tgw'], ['tgw', 'tgw'],
  ['networkinterface', 'eni'], ['eni', 'eni'],
  ['vpcendpoint', 'vpce'], ['endpoint', 'vpce'], ['vpce', 'vpce'],
  ['natgateway', 'nat'], ['nat', 'nat'],
  ['loadbalancer', 'lb'], ['elb', 'lb'],
  ['subnet', 'subnet'],
  ['instance', 'instance'],
  ['s3', 'awsservice'], ['dynamodb', 'awsservice'], ['cloudwatch', 'awsservice'], ['logs', 'awsservice'],
  ['internet', 'internet'], ['igw', 'internet'],
  ['region', 'region'],
  ['vpc', 'vpc'], // vpce/endpoint보다 뒤 — 'VpcEndpoint'가 여기로 떨어지지 않게
];
function kindOf(type: string): ResourceKind {
  const t = type.toLowerCase();
  for (const [needle, kind] of KIND_RULES) if (t.includes(needle)) return kind;
  return 'other';
}

/** 플로우 엔드포인트 분류: pod > instance > subnet > (AWS 서비스 카테고리) > ip. */
export function endpointKind(e: NfmEndpoint, category?: string): ResourceKind {
  if (e.podName) return 'pod';
  if (e.instanceId) return 'instance';
  if (!e.ip && category?.startsWith('AMAZON_')) return 'awsservice';
  if (e.subnetId) return 'subnet';
  return 'other';
}

interface Hop { kind: ResourceKind; label: string; id?: string; context?: string }

function endpointHop(e: NfmEndpoint, category?: string): Hop {
  const kind = endpointKind(e, category);
  const label = kind === 'pod'
    ? (e.podNamespace ? `${e.podNamespace}/${e.podName}` : e.podName ?? '')
    : kind === 'instance' ? e.instanceId ?? ''
    : kind === 'awsservice' ? (category ?? '').replace('AMAZON_', '')
    : e.ip ?? e.subnetId ?? '?';
  const context = [e.az, e.region, e.vpcId].filter(Boolean).join(' · ') || undefined;
  return { kind, label, id: kind === 'pod' ? e.ip : undefined, context };
}

/** 홉 체인: 로컬 → traversedIds(중간 경유, 엔드포인트와 중복되는 id는 제거) → 원격. */
export function buildHops(row: NfmFlowRow): Hop[] {
  const src = endpointHop(row.local, row.category);
  const dst = endpointHop(row.remote, row.category);
  const endpointIds = new Set([row.local.instanceId, row.remote.instanceId].filter(Boolean));
  const mid: Hop[] = row.traversedIds
    .map((entry) => {
      const i = entry.indexOf(':');
      const type = i < 0 ? entry : entry.slice(0, i);
      const id = i < 0 ? undefined : entry.slice(i + 1);
      return { kind: kindOf(type), label: type, id };
    })
    .filter((h) => !(h.id && endpointIds.has(h.id)));
  return [src, ...mid, dst];
}

export default function FlowHopPath({ row }: { row: NfmFlowRow }) {
  const { tt } = useI18n();
  const hops = useMemo(() => buildHops(row), [row]);
  const badges = [
    row.snatIp ? `SNAT ${row.snatIp}` : null,
    row.dnatIp ? `DNAT ${row.dnatIp}` : null,
    row.targetPort != null && row.targetPort !== 0 ? `Port ${row.targetPort}` : null,
    row.category,
  ].filter((b): b is string => b != null);

  return (
    <section className="flex flex-col gap-2.5">
      <div className="flex flex-wrap items-center gap-2">
        <h3 className="text-[12px] font-semibold text-ink-700">{tt('End to End 경로')}</h3>
        {badges.map((b) => (
          <span key={b} className="rounded-full bg-ink-50 px-2 py-0.5 font-mono text-[10.5px] font-medium text-ink-500">{b}</span>
        ))}
      </div>
      {/* 좁은 화면에서는 스텝퍼 박스 안에서만 가로 스크롤. */}
      <div className="overflow-x-auto pb-1">
        <ol className="flex min-w-max items-start">
          {hops.map((hop, i) => (
            <li key={`${hop.kind}-${hop.id ?? hop.label}-${i}`} className="flex w-40 shrink-0 flex-col gap-1">
              <div className="flex items-center">
                <ResourceIcon kind={hop.kind} size={34} />
                {i < hops.length - 1 && <span aria-hidden className="h-px flex-1 bg-ink-200" />}
              </div>
              <div className="min-w-0 pr-3">
                <p className="truncate text-[11.5px] font-semibold text-ink-800" title={hop.label}>{hop.label}</p>
                {hop.id && hop.id !== hop.label && (
                  <p className="truncate font-mono text-[10.5px] text-ink-500" title={hop.id}>{hop.id}</p>
                )}
                {hop.context && (
                  <p className="truncate text-[10.5px] text-ink-400" title={hop.context}>{hop.context}</p>
                )}
              </div>
            </li>
          ))}
        </ol>
      </div>
    </section>
  );
}
