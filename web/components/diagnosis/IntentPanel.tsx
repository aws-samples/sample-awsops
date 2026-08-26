'use client';
import { useCallback, useEffect, useState } from 'react';

// Plan-2 "propose & confirm" admin panel (§4.0). Lists DRAFT candidate invariants ordered
// drift-risk-first (critical / public-ingress kinds first), each with per-item Accept / Edit /
// Reject. NO bulk "accept all" — confirming a critical/security invariant is a deliberate,
// one-at-a-time act (§8R3). A candidate that CURRENTLY violates the live state carries a
// Heuristic-Risk badge: confirming it would codify a current misconfig as "intended".
//
// Writes are admin-gated by /api/diagnosis/intent (403 for non-admins). This panel renders for
// everyone but the API enforces the gate; non-admins simply get 403 on Accept/Reject/Propose.

interface Intent {
  id: number;
  kind: string;
  target: string | null;
  params: Record<string, unknown>;
  severity: 'info' | 'warning' | 'critical';
  status: string;
  provenance: string;
}

const SEVERITY_RANK: Record<string, number> = { critical: 0, warning: 1, info: 2 };
const INGRESS_KINDS = new Set(['no_public_ingress', 'private_only']);

// Drift-risk ordering: critical first; within a severity, public-ingress kinds first.
function byDriftRisk(a: Intent, b: Intent): number {
  const s = (SEVERITY_RANK[a.severity] ?? 9) - (SEVERITY_RANK[b.severity] ?? 9);
  if (s !== 0) return s;
  const ai = INGRESS_KINDS.has(a.kind) ? 0 : 1;
  const bi = INGRESS_KINDS.has(b.kind) ? 0 : 1;
  if (ai !== bi) return ai - bi;
  return a.id - b.id;
}

function hasHeuristicRisk(i: Intent): boolean {
  return Boolean((i.params as { heuristic_risk?: unknown })?.heuristic_risk);
}

const SEV_CLASS: Record<string, string> = {
  critical: 'bg-red-100 text-red-700 border-red-200',
  warning: 'bg-amber-100 text-amber-700 border-amber-200',
  info: 'bg-ink-100 text-ink-600 border-ink-200',
};

export default function IntentPanel() {
  const [drafts, setDrafts] = useState<Intent[]>([]);
  const [busy, setBusy] = useState<number | 'propose' | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    const r = await fetch('/api/diagnosis/intent?status=draft');
    if (r.ok) setDrafts(((await r.json()).intents ?? []).slice().sort(byDriftRisk));
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const post = async (payload: Record<string, unknown>) => {
    setError(null);
    const r = await fetch('/api/diagnosis/intent', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
    });
    if (!r.ok) {
      setError(r.status === 403 ? '관리자 권한이 필요합니다.' : `요청 실패 (${r.status})`);
      return false;
    }
    return true;
  };

  // Accept = promote a SINGLE id (never a bulk array). edits carry the (possibly edited) predicate.
  const promote = async (i: Intent, severity: Intent['severity']) => {
    setBusy(i.id);
    try {
      const ok = await post({
        action: 'promote',
        id: i.id,
        edits: { kind: i.kind, target: i.target, params: i.params, severity },
      });
      if (ok) await load();
    } finally {
      setBusy(null);
    }
  };

  const accept = (i: Intent) => promote(i, i.severity);

  // Edit = adjust the one consequential field (severity) before promoting. Full inline predicate
  // editing is a fast-follow; this keeps Edit a real action, not a no-op.
  const edit = (i: Intent) => {
    const next = typeof window !== 'undefined'
      ? window.prompt('severity (info|warning|critical):', i.severity)
      : null;
    if (next && ['info', 'warning', 'critical'].includes(next)) {
      void promote(i, next as Intent['severity']);
    }
  };

  const reject = async (i: Intent) => {
    setBusy(i.id);
    try {
      if (await post({ action: 'reject', id: i.id })) await load();
    } finally {
      setBusy(null);
    }
  };

  const propose = async () => {
    setBusy('propose');
    try {
      if (await post({ action: 'propose' })) await load();
    } finally {
      setBusy(null);
    }
  };

  return (
    <section className="rounded-lg border border-ink-200 bg-paper p-4">
      <div className="mb-3 flex items-center justify-between">
        <h2 className="text-sm font-semibold text-ink-800">의도된 불변식 후보 (Intent · admin)</h2>
        <button
          onClick={propose}
          disabled={busy === 'propose'}
          className="rounded-md border border-ink-200 px-2.5 py-1 text-[12px] hover:bg-ink-100 disabled:opacity-50"
        >
          {busy === 'propose' ? '제안 중…' : '후보 제안 (Propose)'}
        </button>
      </div>

      {error && (
        <div className="mb-3 rounded-md border border-red-200 bg-red-50 px-3 py-2 text-[12px] text-red-700">
          {error}
        </div>
      )}

      {drafts.length === 0 ? (
        <p className="text-[13px] text-ink-400">대기 중인 후보가 없습니다. “후보 제안”으로 자동 토폴로지에서 생성하세요.</p>
      ) : (
        <ul className="space-y-2">
          {drafts.map((i) => (
            <li key={i.id} className="rounded-md border border-ink-200 px-3 py-2">
              <div className="flex flex-wrap items-center gap-2">
                <span className={`rounded border px-1.5 py-0.5 text-[11px] font-medium ${SEV_CLASS[i.severity] ?? SEV_CLASS.info}`}>
                  {i.severity}
                </span>
                <span className="font-mono text-[13px] text-ink-800">{i.kind}</span>
                {i.target && <span className="text-[12px] text-ink-500">→ {i.target}</span>}
                {hasHeuristicRisk(i) && (
                  <span
                    title="현재 위반 중 — 의도된 경우에만 승인하세요"
                    className="rounded border border-amber-300 bg-amber-50 px-1.5 py-0.5 text-[11px] font-medium text-amber-800"
                  >
                    ⚠ Heuristic Risk — 현재 위반 중, 의도된 경우에만 승인
                  </span>
                )}
                <div className="ml-auto flex gap-1.5">
                  <button
                    onClick={() => accept(i)}
                    disabled={busy === i.id}
                    className="rounded-md bg-brand-500 px-2.5 py-1 text-[12px] font-medium text-white disabled:opacity-50"
                  >
                    Accept
                  </button>
                  <button
                    onClick={() => edit(i)}
                    disabled={busy === i.id}
                    className="rounded-md border border-ink-200 px-2.5 py-1 text-[12px] disabled:opacity-50"
                  >
                    Edit
                  </button>
                  <button
                    onClick={() => reject(i)}
                    disabled={busy === i.id}
                    className="rounded-md border border-ink-200 px-2.5 py-1 text-[12px] text-ink-500 disabled:opacity-50"
                  >
                    Reject
                  </button>
                </div>
              </div>
              {Object.keys(i.params ?? {}).filter((k) => k !== 'heuristic_risk').length > 0 && (
                <pre className="mt-1 overflow-x-auto text-[11px] text-ink-400">
                  {JSON.stringify(i.params, null, 0)}
                </pre>
              )}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
