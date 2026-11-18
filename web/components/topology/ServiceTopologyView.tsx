'use client';
import { useEffect, useMemo, useState } from 'react';
import dynamic from 'next/dynamic';
import Link from 'next/link';
import { Background, Controls, MarkerType, Position } from '@xyflow/react';
import { useI18n } from '@/components/shell/LanguageProvider';
import PageHeader from '@/components/ui/PageHeader';
import { layoutFlow } from '@/lib/flow-layout';
import { useTheme } from '@/lib/use-theme';
import type { Entity, Relation } from '@/lib/service-topology/snapshot';
const Canvas = dynamic(() => import('@xyflow/react').then((m) => m.ReactFlow), { ssr: false });
const lenses = { service: '서비스 맵', entry: '요청 흐름', placement: '인프라 배치', evidence: '관측 근거' };
type Lens = keyof typeof lenses;
interface View {
  snapshotId: string;
  builtAt: string;
  entities: Entity[];
  relations: Relation[];
  gaps: string[];
  omitted: { entities: number; relations: number };
  nextCursor: number | null;
  sources: {
    sourceId: string;
    status: string;
    reasons?: string[];
    capturedAt: string | null;
    stale: boolean;
    retained: boolean;
    capped: boolean;
  }[];
}
export default function ServiceTopologyView({ supported }: { supported: boolean }) {
  const { tt } = useI18n(),
    dark = useTheme() === 'dark';
  const [lens, setLens] = useState<Lens>('service'),
    [focus, setFocus] = useState(''),
    [q, setQ] = useState('');
  const [search, setSearch] = useState(''),
    [offset, setOffset] = useState(0),
    [pin, setPin] = useState('');
  const [revision, refresh] = useState(0),
    [view, setView] = useState<View | null>(null),
    [message, setMessage] = useState('');
  const url = useMemo(() => {
    const params = new URLSearchParams({ lens, q, focus, cursor: String(offset) });
    if (pin) params.set('snapshot', pin);
    return '/api/topology?' + params;
  }, [lens, q, focus, offset, pin]);
  useEffect(() => {
    if (!supported) return;
    const ac = new AbortController();
    setView(null);
    setMessage('불러오는 중…');
    fetch(url, { signal: ac.signal })
      .then(async (r) => {
        if (ac.signal.aborted) return;
        if (!r.ok) {
          setMessage(
            r.status === 401
              ? '로그인이 필요합니다.'
              : r.status === 410
                ? '스냅샷이 만료되었습니다. 새로고침하세요.'
                : '서비스 그래프를 읽을 수 없습니다.',
          );
          return;
        }
        const body = await r.json();
        if (ac.signal.aborted) return;
        if (!body.snapshotId) {
          setMessage('발행된 서비스 그래프가 없습니다.');
          return;
        }
        setMessage('');
        setView(body);
      })
      .catch(() => {
        if (!ac.signal.aborted) setMessage('서비스 그래프를 읽을 수 없습니다.');
      });
    return () => ac.abort();
  }, [url, revision, supported]);
  const graph = useMemo(() => {
    const positions = new Map(
      layoutFlow({ nodes: view?.entities ?? [], edges: view?.relations ?? [] }).map((p) => [p.id, p]),
    );
    return {
      nodes: (view?.entities ?? []).map((e) => ({
        id: e.id,
        position: positions.get(e.id)!,
        sourcePosition: Position.Right,
        targetPosition: Position.Left,
        data: {
          label: (
            <div className="truncate text-left" title={e.label}>
              <strong>{e.label}</strong>
              <br />
              {e.kind} · {e.claim ? tt('텔레메트리 주장') : e.layers.join(' + ')}
            </div>
          ),
        },
        style: {
          width: 220,
          height: 44,
          fontSize: 11,
          padding: 5,
          borderColor: e.errors && e.errors > 0 ? '#C8902F' : undefined,
        },
      })),
      edges: (view?.relations ?? []).map((r) => ({
        id: r.id,
        source: r.source,
        target: r.target,
        label: r.kind,
        markerEnd: { type: MarkerType.ArrowClosed },
        style: { strokeDasharray: r.confidence === 'inferred' ? '5 4' : undefined },
      })),
    };
  }, [view, tt]);
  const selected = view?.entities.find((n) => n.id === focus);
  const groups = useMemo(() => {
    const regions = new Map<string, Map<string, Entity[]>>();
    for (const n of view?.entities ?? []) {
      const region = n.region || tt('범위 미확인');
      const place = [n.vpc, n.cluster, n.namespace].filter(Boolean).join(' / ') || tt('배치 미확인');
      const sub = regions.get(region) ?? new Map<string, Entity[]>();
      if (!regions.has(region)) regions.set(region, sub);
      const rows = sub.get(place) ?? [];
      if (!sub.has(place)) sub.set(place, rows);
      rows.push(n);
    }
    return regions;
  }, [view, tt]);
  const inspect = (id: string) => {
    setPin(view?.snapshotId ?? '');
    setFocus(id);
    setQ('');
    setSearch('');
    setOffset(0);
  };
  return (
    <div className="space-y-3">
      <PageHeader title={tt('통합 서비스 그래프')} right={<Link href="/topology">{tt('요청 흐름')}</Link>} />
      {!supported ? (
        <p role="status" className="p-4">
          {tt('현재 범위에서는 서비스 맵을 표시할 수 없습니다. 호스트 계정, 전체 리전 및 전역 리소스를 선택하세요.')}
        </p>
      ) : (
        <div className="space-y-3 px-4 text-sm">
          <div className="flex flex-wrap gap-3">
            {(Object.keys(lenses) as Lens[]).map((k) => (
              <button
                key={k}
                aria-pressed={lens === k}
                className="rounded border px-2 py-1 aria-pressed:bg-brand-50"
                onClick={() => {
                  setPin(view?.snapshotId ?? pin);
                  setLens(k);
                  setFocus('');
                  setOffset(0);
                  setQ('');
                  setSearch('');
                }}
              >
                {tt(lenses[k])}
              </button>
            ))}
            <Link href="/topology/network?accounts=self">{tt('네트워크 토폴로지')}</Link>
            <button
              onClick={() => {
                setPin('');
                setOffset(0);
                setFocus('');
                refresh((i) => i + 1);
              }}
            >
              {tt('새로고침')}
            </button>
          </div>
          <form
            onSubmit={(e) => {
              e.preventDefault();
              setQ(search.trim());
              setFocus('');
              setOffset(0);
              setPin(view?.snapshotId ?? pin);
            }}
          >
            <input
              aria-label={tt('서비스 검색')}
              maxLength={240}
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              className="rounded border bg-card px-2 py-1"
            />
            <button className="px-2">{tt('검색')}</button>
          </form>
          {message && (
            <p role="status">
              {tt(message)} {message === '로그인이 필요합니다.' && <Link href="/login">{tt('로그인')}</Link>}
            </p>
          )}
          {view && (
            <>
              <p>
                {tt('그래프 시점:')} {new Date(view.builtAt).toLocaleString()} · {view.entities.length} {tt('노드')} ·{' '}
                {view.relations.length} {tt('관계')}
              </p>
              {view.gaps.length > 0 && (
                <p className="text-ink-600">
                  {tt('관측 범위가 제한됩니다. 수집 범위를 열어 누락된 소스를 확인하세요.')}
                </p>
              )}
              <label className="flex items-center gap-2">
                {tt('서비스 선택')}
                <select
                  aria-label={tt('서비스 선택')}
                  value={focus}
                  className="rounded border bg-card p-1"
                  onChange={(e) => inspect(e.target.value)}
                >
                  <option value="">{tt('전체 보기')}</option>
                  {view.entities
                    .filter((n) => ['service', 'ecs_service', 'lambda'].includes(n.kind) || n.id === focus)
                    .slice(0, 50)
                    .map((n) => (
                      <option key={n.id} value={n.id}>
                        {n.label} · {n.sourceId ?? n.kind}
                      </option>
                    ))}
                </select>
              </label>
              <details>
                <summary>
                  {tt('수집 범위')} · {view.gaps.length}
                </summary>
                {view.sources.map((s) => (
                  <p key={s.sourceId}>
                    {s.sourceId} · {s.status} · {s.capturedAt ?? '—'} {s.stale ? tt('오래됨') : ''}{' '}
                    {s.retained ? tt('이전 결과') : ''} {s.capped ? tt('상한 도달') : ''}{' '}
                    {(s.reasons ?? []).join(' · ')}
                  </p>
                ))}
                <ul>
                  {view.gaps.map((g) => (
                    <li key={g}>{g}</li>
                  ))}
                </ul>
              </details>
              <div className="flex flex-wrap gap-2">
                {view.entities
                  .filter((n) => n.kind === 'service' && n.errors != null && n.errors > 0)
                  .slice(0, 5)
                  .map((n) => (
                    <button className="rounded border px-2" key={n.id} onClick={() => inspect(n.id)}>
                      {n.label} · {tt('오류 스팬')} {n.errors}
                    </button>
                  ))}
              </div>
              <details>
                <summary>
                  {tt('배치별 리소스')} · {view.entities.length}
                </summary>
                {[...groups].map(([region, places]) => (
                  <details key={region} className="ml-3">
                    <summary>{region}</summary>
                    {[...places].map(([place, items]) => (
                      <details key={place} className="ml-3">
                        <summary>
                          {place} · {items.length}
                        </summary>
                        <ul>
                          {items.slice(0, 20).map((n) => (
                            <li key={n.id}>
                              <button onClick={() => inspect(n.id)}>
                                {n.label} · {n.kind}
                              </button>
                            </li>
                          ))}
                        </ul>
                        {items.length > 20 && (
                          <p>
                            +{items.length - 20} · {tt('검색으로 범위를 좁히세요.')}
                          </p>
                        )}
                      </details>
                    ))}
                  </details>
                ))}
              </details>
              <div className="h-[60vh] min-h-80 rounded border bg-card">
                <Canvas
                  key={url}
                  nodes={graph.nodes}
                  edges={graph.edges}
                  fitView
                  colorMode={dark ? 'dark' : 'light'}
                  onNodeClick={(_, n) => inspect(n.id)}
                  nodesDraggable={false}
                  nodesConnectable={false}
                >
                  <Background />
                  <Controls />
                </Canvas>
              </div>
              {!!(view.omitted.entities || view.omitted.relations) && (
                <p>
                  {tt('화면 한도:')} {view.omitted.entities} {tt('노드')} · {view.omitted.relations} {tt('관계')}
                </p>
              )}
              {view.nextCursor !== null && (
                <button
                  onClick={() => {
                    setPin(view.snapshotId);
                    setOffset(view.nextCursor!);
                  }}
                >
                  {tt('다음')}
                </button>
              )}
              {focus && (
                <button
                  onClick={() => {
                    setFocus('');
                    setOffset(0);
                  }}
                >
                  {tt('전체 보기')}
                </button>
              )}
              {selected && (
                <section className="rounded border bg-card p-3">
                  <strong>{selected.label}</strong> · {selected.layers.join(' + ')}
                  <p>
                    {selected.region} {selected.sourceId}{' '}
                    {selected.claim ? tt('Telemetry claim · AWS identity unverified') : ''}
                  </p>
                  {selected.knownStatus != null &&
                    selected.errors != null &&
                    selected.knownStatus >= selected.errors &&
                    selected.knownStatus > 0 && (
                      <p>
                        {tt('상태가 확인된 스팬 중 오류')} · {selected.errors} / {selected.knownStatus}
                      </p>
                    )}
                  {selected.ownerReason && (
                    <p>
                      {tt('관측 근거')} · {selected.ownerReason}
                    </p>
                  )}
                  {selected.durationSumMs != null && (
                    <p>
                      {tt('관측 스팬 소요 시간 합계')} · {selected.durationSumMs} ms
                    </p>
                  )}
                  <details>
                    <summary>{tt('관측 근거')}</summary>
                    <ul>
                      {selected.evidenceRefs?.map((ref) => (
                        <li key={ref}>{ref}</li>
                      ))}
                    </ul>
                  </details>
                  <button
                    className="mt-2 text-brand-700"
                    onClick={() =>
                      window.dispatchEvent(
                        new CustomEvent('awsops:open-chat', {
                          detail: {
                            prompt: JSON.stringify({
                              entity: selected.id,
                              label: selected.label,
                              scope: 'self',
                              snapshot: view.snapshotId,
                              sources: view.sources.map((s) => ({ id: s.sourceId, capturedAt: s.capturedAt })),
                              gaps: view.gaps,
                            }),
                          },
                        }),
                      )
                    }
                  >
                    {tt('AI에 질문')}
                  </button>
                  <ul>
                    {view.relations
                      .filter((r) => r.source === focus || r.target === focus)
                      .slice(0, 20)
                      .map((r) => (
                        <li key={r.id}>
                          {view.entities.find((n) => n.id === r.source)?.label} →{' '}
                          {view.entities.find((n) => n.id === r.target)?.label} · {r.kind}
                          {r.spanCount != null && r.spanCount > 0 && (
                            <>
                              {' '}
                              · {tt('관측 스팬 수')} {r.spanCount}
                            </>
                          )}
                          {r.metricCount != null && r.metricCount > 0 && (
                            <>
                              {' '}
                              · {tt('호출 메트릭 증가량')} {r.metricCount}
                            </>
                          )}
                        </li>
                      ))}
                  </ul>
                </section>
              )}
            </>
          )}
        </div>
      )}
    </div>
  );
}
