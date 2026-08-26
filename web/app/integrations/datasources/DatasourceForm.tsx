'use client';
import { useState } from 'react';
import Input from '@/components/ui/Input';
import Button from '@/components/ui/Button';
import IntegrationIcon from '@/components/datasources/IntegrationIcon';

// v1-parity Add/Edit form: multiple instances per type, a name, an explicit auth method (optional auth),
// and a Test-before-save probe. POSTs (create) / PATCHes (update) /api/datasources/manage.
const DATASOURCE_KINDS = ['prometheus', 'mimir', 'loki', 'tempo', 'clickhouse', 'jaeger', 'dynatrace', 'datadog'] as const;
const AUTH_TYPES = [
  { value: 'none', label: 'None (인증 없음)' },
  { value: 'basic', label: 'Basic (사용자/비밀번호)' },
  { value: 'bearer', label: 'Bearer token' },
  { value: 'custom_header', label: 'Custom header' },
] as const;
const ORG_ID_KINDS = new Set(['loki', 'tempo', 'mimir']); // X-Scope-OrgID multi-tenancy
// Per-kind endpoint placeholder (SaaS kinds get their real API base as the hint).
const ENDPOINT_PH: Record<string, string> = {
  prometheus: 'http://prometheus.internal:9090', mimir: 'http://mimir.internal:9009',
  loki: 'http://loki.internal:3100', tempo: 'http://tempo.internal:3200',
  clickhouse: 'http://clickhouse.internal:8123', jaeger: 'http://jaeger-query.internal:16686',
  dynatrace: 'https://{env}.live.dynatrace.com', datadog: 'https://api.datadoghq.com',
};
// Auth hints: Dynatrace uses an API token (Authorization: Api-Token — pick Bearer/token here);
// Datadog needs the DD-API-KEY + DD-APPLICATION-KEY custom-header PAIR.
const AUTH_HINT: Record<string, string> = {
  dynatrace: 'Bearer 선택 후 API 토큰 입력 — 커넥터가 Api-Token 스킴으로 전송합니다 (metrics.read/problems.read 스코프 필요).',
  datadog: 'Custom header 선택 후 DD-API-KEY / DD-APPLICATION-KEY 두 헤더를 입력하세요.',
};
const labelCls = 'block text-[11px] uppercase tracking-wide text-ink-400 mb-1';
const selectCls = 'w-full rounded-md border border-ink-200 bg-card px-2.5 py-1.5 text-[13px] text-ink-700';

export interface DatasourceFormValue {
  id?: number;
  name: string;
  kind: string;
  endpoint: string;
  authType: string;
  isDefault?: boolean;
}

export default function DatasourceForm({
  initial, onSaved, onCancel,
}: { initial?: DatasourceFormValue; onSaved: () => void; onCancel: () => void }) {
  const editing = Boolean(initial?.id);
  const [kind, setKind] = useState(initial?.kind ?? 'prometheus');
  const [name, setName] = useState(initial?.name ?? '');
  const [endpoint, setEndpoint] = useState(initial?.endpoint ?? '');
  const [authType, setAuthType] = useState(initial?.authType ?? 'none');
  const [creds, setCreds] = useState<Record<string, string>>({});
  const [test, setTest] = useState<{ ok: boolean; ms?: number; error?: string } | null>(null);
  const [testing, setTesting] = useState(false);
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState('');

  const setCred = (k: string, v: string) => setCreds((c) => ({ ...c, [k]: v }));
  const credPayload = () => {
    const c: Record<string, string> = {};
    if (authType === 'basic') { if (creds.username) c.username = creds.username; if (creds.password) c.password = creds.password; }
    if (authType === 'bearer' && creds.token) c.token = creds.token;
    if (authType === 'custom_header') { if (creds.headerName) c.headerName = creds.headerName; if (creds.headerValue) c.headerValue = creds.headerValue; if (creds.headerName2) c.headerName2 = creds.headerName2; if (creds.headerValue2) c.headerValue2 = creds.headerValue2; }
    if (ORG_ID_KINDS.has(kind) && creds.org_id) c.org_id = creds.org_id;
    return c;
  };

  const runTest = async () => {
    setTesting(true); setTest(null); setErr('');
    try {
      const r = await fetch('/api/datasources/test', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ kind, endpoint, authType, creds: credPayload() }),
      });
      const b = await r.json();
      if (!r.ok) { setErr(b.error || `오류 ${r.status}`); return; }
      setTest({ ok: Boolean(b.ok), ms: b.latencyMs, error: b.error });
    } catch (e) { setErr(e instanceof Error ? e.message : '테스트 실패'); }
    finally { setTesting(false); }
  };

  const save = async () => {
    setSaving(true); setErr('');
    try {
      const body = editing
        ? { id: initial!.id, name, endpoint, authType, creds: credPayload() }
        : { name, kind, endpoint, authType, creds: credPayload() };
      const r = await fetch('/api/datasources/manage', {
        method: editing ? 'PATCH' : 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
      const b = await r.json().catch(() => ({}));
      if (!r.ok) { setErr(b.error || `저장 실패 (${r.status})`); return; }
      onSaved();
    } catch (e) { setErr(e instanceof Error ? e.message : '저장 실패'); }
    finally { setSaving(false); }
  };

  return (
    <div className="space-y-3" role="dialog" aria-label={editing ? '데이터소스 편집' : '데이터소스 추가'}>
      <h3 className="text-sm font-semibold text-ink-800">{editing ? '데이터소스 편집' : '데이터소스 추가'}</h3>

      <div>
        <label className={labelCls}>Type</label>
        <div className="flex items-center gap-2">
          <IntegrationIcon kind={kind} size={20} />
          <select className={selectCls} value={kind} disabled={editing} onChange={(e) => setKind(e.target.value)} aria-label="Type">
            {DATASOURCE_KINDS.map((k) => <option key={k} value={k}>{k}</option>)}
          </select>
        </div>
      </div>

      <div>
        <label className={labelCls}>Name</label>
        <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="예: prod-prometheus" />
      </div>

      <div>
        <label className={labelCls}>Endpoint URL</label>
        <Input value={endpoint} onChange={(e) => setEndpoint(e.target.value)} placeholder={ENDPOINT_PH[kind] ?? 'http://prometheus.internal:9090'} />
      </div>

      <div>
        <label className={labelCls}>Auth method</label>
        <select className={selectCls} value={authType} onChange={(e) => { setAuthType(e.target.value); setTest(null); }} aria-label="Auth method">
          {AUTH_TYPES.map((a) => <option key={a.value} value={a.value}>{a.label}</option>)}
        </select>
      </div>

      {authType === 'basic' && (
        <div className="grid grid-cols-2 gap-2">
          <div><label className={labelCls}>Username</label><Input value={creds.username ?? ''} onChange={(e) => setCred('username', e.target.value)} /></div>
          <div><label className={labelCls}>Password (선택)</label><Input type="password" value={creds.password ?? ''} onChange={(e) => setCred('password', e.target.value)} /></div>
        </div>
      )}
      {authType === 'bearer' && (
        <div><label className={labelCls}>Token</label><Input type="password" value={creds.token ?? ''} onChange={(e) => setCred('token', e.target.value)} /></div>
      )}
      {authType === 'custom_header' && (
        <>
          <div className="grid grid-cols-2 gap-2">
            <div><label className={labelCls}>Header name</label><Input value={creds.headerName ?? ''} onChange={(e) => setCred('headerName', e.target.value)} placeholder={kind === 'datadog' ? 'DD-API-KEY' : 'X-API-Key'} /></div>
            <div><label className={labelCls}>Header value</label><Input type="password" value={creds.headerValue ?? ''} onChange={(e) => setCred('headerValue', e.target.value)} /></div>
          </div>
          {/* Optional SECOND header — Datadog auth is a DD-API-KEY + DD-APPLICATION-KEY pair. */}
          <div className="grid grid-cols-2 gap-2">
            <div><label className={labelCls}>Header name 2 (선택)</label><Input value={creds.headerName2 ?? ''} onChange={(e) => setCred('headerName2', e.target.value)} placeholder={kind === 'datadog' ? 'DD-APPLICATION-KEY' : ''} /></div>
            <div><label className={labelCls}>Header value 2 (선택)</label><Input type="password" value={creds.headerValue2 ?? ''} onChange={(e) => setCred('headerValue2', e.target.value)} /></div>
          </div>
        </>
      )}
      {AUTH_HINT[kind] && <p className="text-[12px] text-ink-400">{AUTH_HINT[kind]}</p>}
      {ORG_ID_KINDS.has(kind) && (
        <div><label className={labelCls}>Org ID (X-Scope-OrgID, 선택)</label><Input value={creds.org_id ?? ''} onChange={(e) => setCred('org_id', e.target.value)} /></div>
      )}

      <div className="flex items-center gap-2 pt-1">
        <Button variant="secondary" onClick={runTest} disabled={testing || !endpoint.trim()}>
          {testing ? '테스트 중…' : '🧪 Test connection'}
        </Button>
        {test && (
          <span className={`text-[13px] ${test.ok ? 'text-emerald-600' : 'text-rose-600'}`}>
            {test.ok ? `✓ 연결 성공${test.ms != null ? ` (${test.ms}ms)` : ''}` : `✗ 연결 실패: ${test.error ?? '오류'}`}
          </span>
        )}
      </div>

      {err && <p className="text-[13px] text-rose-600">{err}</p>}

      <div className="flex gap-2 pt-1">
        <Button onClick={save} disabled={saving || !name.trim() || !endpoint.trim()}>{saving ? '저장 중…' : '저장'}</Button>
        <Button variant="secondary" onClick={onCancel}>취소</Button>
      </div>
    </div>
  );
}
