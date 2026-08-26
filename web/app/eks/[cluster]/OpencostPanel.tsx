'use client';
import { useCallback, useEffect, useRef, useState } from 'react';
import { ChevronDown } from 'lucide-react';
import Badge from '@/components/ui/Badge';
import Card from '@/components/ui/Card';

// Per-cluster OpenCost surface — relocated from the standalone /opencost page into a collapse
// banner on the cluster detail view. READ-ONLY: detects install status and generates a download
// bundle (values.yaml / install.sh) the user runs out-of-band on their own kubeconfig. AWSops
// never writes to the cluster (ADR-029 reversed). Backend routes/libs are reused unchanged.

interface InstallStatus {
  installed: boolean;
  ready: boolean;
  reason?: string;
}
interface SavedConfig {
  chartVersion: string | null;
  config: { values?: Record<string, unknown>; override?: Record<string, unknown> } | null;
}

const btn = 'rounded-md px-3 py-1.5 text-[12px] font-medium transition-colors';

export default function OpencostPanel({ cluster }: { cluster: string }) {
  const [status, setStatus] = useState<InstallStatus | null>(null);
  const [notOnboarded, setNotOnboarded] = useState(false);
  const [isAdmin, setIsAdmin] = useState(false);
  const [open, setOpen] = useState(false);
  const [chartVersion, setChartVersion] = useState('');
  const [overrideText, setOverrideText] = useState('');
  const [msg, setMsg] = useState('');

  // Auto-open is decided ONCE per cluster (so a user toggle isn't clobbered by a refresh).
  const initedRef = useRef(false);
  // Monotonic sequence — a late response from a superseded cluster must not overwrite the newer view.
  const seqRef = useRef(0);
  const configLoadedRef = useRef('');

  // Identity (admin signal) — fetched once; independent of the selected cluster.
  useEffect(() => {
    let live = true;
    fetch('/api/me')
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => { if (live && d) setIsAdmin(!!d.isAdmin); })
      .catch(() => {});
    return () => { live = false; };
  }, []);

  // Install status — refetched per cluster, degrade-safe (never throws to the user).
  useEffect(() => {
    const seq = ++seqRef.current;
    const fresh = () => seq === seqRef.current;
    setStatus(null);
    setNotOnboarded(false);
    setMsg('');
    initedRef.current = false;
    (async () => {
      try {
        const r = await fetch(`/api/opencost/${encodeURIComponent(cluster)}/status`);
        if (!fresh()) return;
        if (r.status === 404) { setNotOnboarded(true); return; }
        const s = (await r.json()) as InstallStatus;
        if (!fresh()) return;
        setStatus(s);
        if (!initedRef.current) { setOpen(!s.installed); initedRef.current = true; }
      } catch {
        if (!fresh()) return;
        // unreachable/transport → degrade to "not installed" with a reason; never throw.
        setStatus({ installed: false, ready: false, reason: 'unreachable' });
        if (!initedRef.current) { setOpen(true); initedRef.current = true; }
      }
    })();
  }, [cluster]);

  // Admin advanced config — lazily fetched the first time the (open) panel is shown to an admin.
  useEffect(() => {
    if (!open || !isAdmin || notOnboarded) return;
    if (configLoadedRef.current === cluster) return;
    configLoadedRef.current = cluster;
    fetch(`/api/opencost/${encodeURIComponent(cluster)}`)
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => {
        const saved = d?.config as SavedConfig | null;
        setChartVersion(saved?.chartVersion ?? '');
        setOverrideText(saved?.config?.override ? JSON.stringify(saved.config.override, null, 2) : '');
      })
      .catch(() => {});
  }, [open, isAdmin, notOnboarded, cluster]);

  const download = useCallback(async (which: 'values.yaml' | 'install.sh') => {
    setMsg('');
    const res = await fetch(`/api/opencost/${encodeURIComponent(cluster)}/bundle`);
    if (!res.ok) { setMsg(`번들 생성 실패 (${res.status})`); return; }
    const b = (await res.json()) as { valuesYaml: string; installSh: string };
    const body = which === 'values.yaml' ? b.valuesYaml : b.installSh;
    const url = URL.createObjectURL(new Blob([body], { type: 'text/plain' }));
    const a = document.createElement('a');
    a.href = url; a.download = which; a.click();
    URL.revokeObjectURL(url);
  }, [cluster]);

  async function save() {
    setMsg('');
    let override: Record<string, unknown> | undefined;
    if (overrideText.trim()) {
      try { override = JSON.parse(overrideText); } catch { setMsg('override JSON 파싱 실패'); return; }
    }
    const res = await fetch(`/api/opencost/${encodeURIComponent(cluster)}`, {
      method: 'PUT', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ chartVersion: chartVersion || null, config: { values: {}, override } }),
    });
    if (res.status === 403) setMsg('관리자 전용');
    else if (res.status === 503) setMsg('저장소 미설정');
    else if (res.ok) setMsg('저장됨');
    else setMsg(`저장 실패 (${res.status})`);
  }

  const badge = notOnboarded ? (
    <Badge tone="neutral" variant="soft">미온보딩</Badge>
  ) : !status ? (
    <span className="text-[12px] text-ink-400">조회 중…</span>
  ) : status.installed ? (
    <Badge tone={status.ready ? 'positive' : 'brand'} variant="soft" dot>
      {status.ready ? '설치됨 · Ready' : '설치됨 · Not Ready'}
    </Badge>
  ) : (
    <Badge tone="neutral" variant="soft">미설치</Badge>
  );

  const Label = <span className="text-[13px] font-semibold text-ink-800">OpenCost</span>;

  return (
    <Card padded={false}>
      {notOnboarded ? (
        <div className="flex flex-col gap-1 px-4 py-3">
          <div className="flex items-center gap-2.5">{Label}{badge}</div>
          <p className="text-[12px] text-ink-400">인-앱 조회 미온보딩 (Access Entry 또는 인증 등록 필요)</p>
        </div>
      ) : !status ? (
        <div className="flex items-center gap-2.5 px-4 py-3">{Label}{badge}</div>
      ) : (
        <button
          type="button"
          aria-expanded={open}
          onClick={() => setOpen((o) => !o)}
          className="flex w-full items-center gap-2.5 px-4 py-3 text-left hover:bg-ink-50"
        >
          {Label}
          {badge}
          <ChevronDown size={15} className={`ml-auto text-ink-400 transition-transform ${open ? 'rotate-180' : ''}`} />
        </button>
      )}

      {open && !notOnboarded && status && (
        <div className="flex flex-col gap-3 border-t border-ink-100 px-4 py-3">
          {status.installed ? (
            <p className="text-[12px] text-ink-500">설치됨 — 재설치/업그레이드용 번들을 다시 받을 수 있습니다.</p>
          ) : (
            <div className="text-[12px] leading-relaxed text-ink-600">
              <p className="mb-1">OpenCost는 직접 설치합니다 (AWSops는 클러스터에 쓰지 않음):</p>
              <pre className="overflow-auto rounded bg-ink-50 p-2 text-[11px] text-ink-700">{`helm repo add opencost https://opencost.github.io/opencost-helm-chart\n# 아래 번들을 받아 본인 kubeconfig로 실행\nbash install.sh   # values.yaml 사용`}</pre>
            </div>
          )}
          {status.reason && <p className="text-[12px] text-amber-700">조회 제한: {status.reason}</p>}

          <div className="flex flex-wrap items-center gap-2">
            <button type="button" onClick={() => download('values.yaml')} className={`${btn} border border-ink-200 text-ink-700 hover:bg-ink-50`}>values.yaml</button>
            <button type="button" onClick={() => download('install.sh')} className={`${btn} border border-ink-200 text-ink-700 hover:bg-ink-50`}>install.sh</button>
            {msg && <span className="text-[12px] text-ink-500">{msg}</span>}
          </div>

          {isAdmin && (
            <div className="mt-1 flex flex-col gap-2 rounded-md border border-ink-100 bg-ink-50/60 p-3">
              <span className="text-[11px] font-medium uppercase tracking-wide text-ink-400">고급 설정 (admin)</span>
              <label className="text-[12px] text-ink-500">Chart version (비우면 latest)
                <input value={chartVersion} onChange={(e) => setChartVersion(e.target.value)} placeholder="latest"
                  className="mt-1 w-full rounded-md border border-ink-200 px-2 py-1 text-[12px] font-mono" />
              </label>
              <label className="text-[12px] text-ink-500">values override (JSON, 선택)
                <textarea value={overrideText} onChange={(e) => setOverrideText(e.target.value)} rows={4}
                  placeholder='{ "opencost": { "ui": { "enabled": true } } }'
                  className="mt-1 w-full rounded-md border border-ink-200 px-2 py-1 text-[11px] font-mono" />
              </label>
              <div>
                <button type="button" onClick={save} className={`${btn} bg-brand-500 text-white hover:bg-brand-600`}>저장</button>
              </div>
            </div>
          )}
        </div>
      )}
    </Card>
  );
}
