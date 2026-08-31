'use client';
import { useCallback, useEffect, useState } from 'react';
import Card from '@/components/ui/Card';
import Input from '@/components/ui/Input';
import Button from '@/components/ui/Button';
import IntegrationIcon from '@/components/datasources/IntegrationIcon';
import { useI18n } from '@/components/shell/LanguageProvider';
import { MCP_PRESETS } from '@/lib/mcp-presets';

// Connectors tab: external SERVICE integrations — distinct from observability Datasources and from
// Skills. Read + GOVERNED write (write is propose-only / flag-OFF per ADR-040/041 — surfaced as a
// disabled note here). ADR-017 — the catalog is curated official-vendor MCP presets (Datadog/
// ClickHouse/Tempo/Jaeger/Grafana/Dynatrace/Splunk/New Relic) plus Notion (pre-existing, hosted MCP
// is OAuth-only so it stays on the direct token path). Connect = paste one token; the same PUT
// writes it to the shared credentials secret provision.py reads for the ADR-017 gateway targets.
const CONNECTORS = MCP_PRESETS;

export default function ConnectorsTab({ canManage = false }: { canManage?: boolean }) {
  const { tt } = useI18n();
  // Two distinct sets (round-2 review MAJOR, 2026-07-31): `configured` = plain-slug
  // datasource-mirror credentials; `mcpConfigured` = ADR-017 namespaced "mcp:<slug>" credentials,
  // the ONLY key provision.py reads for official-MCP presets. A preset row must check the one
  // that actually matters for its activation path — merging them made the UI lie either way.
  const [configured, setConfigured] = useState<Set<string>>(new Set());
  const [mcpConfigured, setMcpConfigured] = useState<Set<string>>(new Set());
  const [token, setToken] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState<string | null>(null);
  const [msg, setMsg] = useState('');

  const load = useCallback(async () => {
    try {
      const r = await fetch('/api/integrations/credential');
      if (r.ok) {
        const body = await r.json();
        setConfigured(new Set((body.configured ?? []) as string[]));
        setMcpConfigured(new Set((body.mcpConfigured ?? []) as string[]));
      }
    } catch { /* status is best-effort */ }
  }, []);
  useEffect(() => { load(); }, [load]);

  // A preset row's activation credential lives under the namespaced key when it's an official
  // MCP preset (provision.py reads mcp:<slug> exclusively), else the plain slug (legacy connectors).
  const isConfigured = (c: { slug: string; official: boolean }) =>
    (c.official ? mcpConfigured : configured).has(c.slug);

  const connect = async (slug: string, official: boolean) => {
    const t = (token[slug] ?? '').trim();
    if (!t) return;
    setBusy(slug); setMsg('');
    try {
      const r = await fetch('/api/integrations/credential', {
        method: 'PUT', headers: { 'content-type': 'application/json' },
        // official=true (all ADR-017 presets except Notion) stores under the namespaced "mcp:"
        // key so it can never clobber the plain-slug datasource-connector kind-mirror that 5 of
        // these slugs (clickhouse/tempo/jaeger/dynatrace/datadog) also own.
        body: JSON.stringify({ slug, secret: { token: t }, official }),
      });
      if (!r.ok) { setMsg((await r.json().catch(() => ({}))).error || tt(`오류 ${r.status}`)); return; }
      setToken((s) => ({ ...s, [slug]: '' })); // never keep the secret in state
      setMsg(tt('저장되었습니다.'));
      await load();
    } finally { setBusy(null); }
  };

  return (
    <div className="space-y-3">
      <p className="text-[13px] text-ink-500">
        {tt('외부 서비스 커넥터 (Notion 등). 자격증명은 Secrets Manager에 암호화 저장되며 다시 표시되지 않습니다.')}{' '}
        {tt('쓰기(노트/티켓 생성)는 거버넌스 하에 제안 전용 · 기본 비활성입니다.')}{' '}
        {tt('ClickHouse·Prometheus·Loki·Tempo·Mimir·Jaeger 등 관측성 데이터소스는 Datasources 탭에서 등록합니다(엔드포인트+자격증명).')}
      </p>
      <div className="grid gap-3 sm:grid-cols-2">
        {CONNECTORS.map((c) => (
          <Card key={c.slug} className="p-4 space-y-2">
            <div className="flex items-center justify-between">
              <span className="inline-flex items-center gap-2 font-medium text-ink-800"><IntegrationIcon kind={c.slug} /> {c.label}</span>
              {/* ADR-017 presets: credential presence alone does NOT mean the gateway target is
                  live — that also needs official_mcp_enabled + this preset's endpoint set in
                  terraform, and successful `make agentcore` provisioning. Only Notion's status can
                  honestly say "connected", since its credential IS the whole activation path. */}
              <span className={`text-[12px] ${isConfigured(c) ? 'text-emerald-600' : 'text-ink-400'}`}>
                {c.official
                  ? (isConfigured(c) ? tt('● 자격증명 저장됨') : tt('○ 자격증명 없음'))
                  : (isConfigured(c) ? '● connected' : '○ not connected')}
              </span>
            </div>
            <div className="flex flex-wrap gap-1">
              {c.official && <span className="inline-block text-[11px] text-sky-700 bg-sky-50 border border-sky-200 rounded px-1.5 py-0.5">{tt('공식 MCP (hosted)')}</span>}
              {c.official && <span className="inline-block text-[11px] text-amber-700 bg-amber-50 border border-amber-200 rounded px-1.5 py-0.5">{tt('게이트됨 — 토큰 사전 등록만')}</span>}
              {c.preview && <span className="inline-block text-[11px] text-amber-700 bg-amber-50 border border-amber-200 rounded px-1.5 py-0.5">{tt('벤더 preview')}</span>}
            </div>
            <p className="text-[12px] text-ink-400">
              {tt(c.help)}{' '}
              <a href={c.docsUrl} target="_blank" rel="noreferrer" className="underline">{tt('문서')}</a>
            </p>
            {c.official && (
              <p className="text-[11px] text-ink-400">
                {tt('실제 활성화는 official_mcp_enabled 플래그와 이 프리셋의 엔드포인트 설정(terraform)이 추가로 필요합니다.')}
              </p>
            )}
            {canManage ? (
              <div className="flex gap-2">
                <Input type="password" value={token[c.slug] ?? ''} onChange={(e) => setToken((s) => ({ ...s, [c.slug]: e.target.value }))} placeholder={isConfigured(c) ? tt('토큰 교체…') : tt('토큰 붙여넣기')} />
                <Button onClick={() => connect(c.slug, c.official)} disabled={busy === c.slug || !(token[c.slug] ?? '').trim()}>
                  {isConfigured(c) ? tt('교체') : tt('연결')}
                </Button>
              </div>
            ) : (
              <p className="text-[12px] text-ink-400">{tt('연결 관리는 관리자 전용입니다.')}</p>
            )}
            <span className="inline-block text-[11px] text-ink-400 border border-ink-200 rounded px-1.5 py-0.5">{tt(`읽기 전용(${c.readOnlyNote}) · 쓰기 제안전용(비활성)`)}</span>
          </Card>
        ))}
      </div>
      {msg && <p className="text-[13px] text-ink-500">{msg}</p>}
    </div>
  );
}
