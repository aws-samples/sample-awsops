'use client';
import { useCallback, useEffect, useState } from 'react';
import Card from '@/components/ui/Card';
import Input from '@/components/ui/Input';
import Button from '@/components/ui/Button';
import IntegrationIcon from '@/components/datasources/IntegrationIcon';

// Connectors tab: external SERVICE integrations (Notion now; Slack/Jira later) — distinct from
// observability Datasources and from Skills. Read + GOVERNED write (write is propose-only / flag-OFF
// per ADR-040/041 — surfaced as a disabled note here). Notion connect = paste one token.
interface ConnectorDef { slug: string; label: string; help: string; }
const CONNECTORS: ConnectorDef[] = [
  { slug: 'notion', label: 'Notion', help: 'notion.so/my-integrations 에서 내부 통합을 만들고 토큰을 붙여넣으세요.' },
];

export default function ConnectorsTab({ canManage = false }: { canManage?: boolean }) {
  const [configured, setConfigured] = useState<Set<string>>(new Set());
  const [token, setToken] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState<string | null>(null);
  const [msg, setMsg] = useState('');

  const load = useCallback(async () => {
    try {
      const r = await fetch('/api/integrations/credential');
      if (r.ok) setConfigured(new Set(((await r.json()).configured ?? []) as string[]));
    } catch { /* status is best-effort */ }
  }, []);
  useEffect(() => { load(); }, [load]);

  const connect = async (slug: string) => {
    const t = (token[slug] ?? '').trim();
    if (!t) return;
    setBusy(slug); setMsg('');
    try {
      const r = await fetch('/api/integrations/credential', {
        method: 'PUT', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ slug, secret: { token: t } }),
      });
      if (!r.ok) { setMsg((await r.json().catch(() => ({}))).error || `오류 ${r.status}`); return; }
      setToken((s) => ({ ...s, [slug]: '' })); // never keep the secret in state
      setMsg('저장되었습니다.');
      await load();
    } finally { setBusy(null); }
  };

  return (
    <div className="space-y-3">
      <p className="text-[13px] text-ink-500">
        외부 서비스 커넥터 (Notion 등). 자격증명은 Secrets Manager에 암호화 저장되며 다시 표시되지 않습니다.
        쓰기(노트/티켓 생성)는 거버넌스 하에 <b>제안 전용 · 기본 비활성</b>입니다.
      </p>
      <div className="grid gap-3 sm:grid-cols-2">
        {CONNECTORS.map((c) => (
          <Card key={c.slug} className="p-4 space-y-2">
            <div className="flex items-center justify-between">
              <span className="inline-flex items-center gap-2 font-medium text-ink-800"><IntegrationIcon kind={c.slug} /> {c.label}</span>
              <span className={`text-[12px] ${configured.has(c.slug) ? 'text-emerald-600' : 'text-ink-400'}`}>
                {configured.has(c.slug) ? '● connected' : '○ not connected'}
              </span>
            </div>
            <p className="text-[12px] text-ink-400">{c.help}</p>
            {canManage ? (
              <div className="flex gap-2">
                <Input type="password" value={token[c.slug] ?? ''} onChange={(e) => setToken((s) => ({ ...s, [c.slug]: e.target.value }))} placeholder={configured.has(c.slug) ? '토큰 교체…' : '토큰 붙여넣기'} />
                <Button onClick={() => connect(c.slug)} disabled={busy === c.slug || !(token[c.slug] ?? '').trim()}>
                  {configured.has(c.slug) ? '교체' : '연결'}
                </Button>
              </div>
            ) : (
              <p className="text-[12px] text-ink-400">연결 관리는 관리자 전용입니다.</p>
            )}
            <span className="inline-block text-[11px] text-ink-400 border border-ink-200 rounded px-1.5 py-0.5">읽기 전용 · 쓰기 제안전용(비활성)</span>
          </Card>
        ))}
      </div>
      {msg && <p className="text-[13px] text-ink-500">{msg}</p>}
    </div>
  );
}
