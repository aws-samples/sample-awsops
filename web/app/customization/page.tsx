'use client';
import { useEffect, useState } from 'react';
import PageHeader from '@/components/ui/PageHeader';

interface AgentRow { id: number; name: string; description: string; gateway: string; tier: string; enabled: boolean; version: number; skills: Array<{ name: string }>; agentType?: string; gateways?: string[]; }
interface SkillRow { id: number; name: string; description: string; tier: string; enabled: boolean; version: number; agentTypes?: string[]; }
interface SpaceState { enabledAgentIds: number[]; enabledSkillIds: number[]; enabledIntegrationIds: number[]; toolAllowlist: string[]; version?: number }
interface IntegrationRow { id: number; name: string; kind: string; direction: string; capability: string; enabled: boolean; tier: string; receivePath?: string | null; }

const GATEWAYS = ['network', 'container', 'iac', 'data', 'security', 'monitoring', 'cost', 'ops'];
// ADR-039 agent-type lifecycle roles (mirrors web/lib/skill-validation.ts AGENT_TYPES).
const AGENT_TYPES = ['generic', 'on_demand', 'triage', 'rca', 'mitigation', 'evaluation'];
// ADR-039 P2 — integration kinds (mirror web/lib/integration-validation.ts).
const INTEG_KINDS_EGRESS = ['grafana', 'datadog', 'splunk', 'prometheus', 'newrelic', 'notion', 'confluence', 'jira', 'servicenow', 'slack', 'github', 'gitlab', 'custom_mcp'];
const INTEG_KINDS_INGRESS = ['cloudwatch_sns', 'alertmanager', 'grafana_alert', 'pagerduty', 'datadog_monitor', 'generic_webhook'];
const INTEG_TRANSPORTS = ['sigv4', 'oauth_client_credentials', 'oauth_3lo', 'api_key'];
// NOTE: curated read connectors (Prometheus/Loki/…/Notion credential cards) moved to the Integrations
// hub (/integrations) — Datasources tab + Connectors tab. This page keeps Agents/Skills/Agent-Space +
// the advanced custom-integration registration.

export default function CustomizationPage() {
  const [agents, setAgents] = useState<AgentRow[]>([]);
  const [skills, setSkills] = useState<SkillRow[]>([]);
  const [denied, setDenied] = useState(false);
  const [noAurora, setNoAurora] = useState(false);
  const [msg, setMsg] = useState('');
  const [agentForm, setAgentForm] = useState({ name: '', description: '', persona: '', gateway: 'ops', routingKeywords: '', agentType: 'generic', model: '', responseLanguage: '', gateways: [] as string[] });
  const [skillForm, setSkillForm] = useState({ name: '', description: '', instructions: '', agentTypes: ['generic'] as string[] });
  const [accountId, setAccountId] = useState('self');
  const [space, setSpace] = useState<SpaceState | null>(null);
  const [allowlistText, setAllowlistText] = useState('');
  const [integrations, setIntegrations] = useState<IntegrationRow[]>([]);
  const [integForm, setIntegForm] = useState({ direction: 'egress', name: '', kind: 'grafana', endpoint: '', transport: 'api_key', capability: 'read', authMode: 'hmac', sourceAllowlist: '', triggerTarget: 'incident' });

  async function load() {
    const r = await fetch('/api/customization');
    if (r.status === 401 || r.status === 403) { setDenied(true); return; }
    if (r.status === 400) { setNoAurora(true); return; }
    const d = await r.json();
    setAgents(d.agents || []); setSkills(d.skills || []);
    setAccountId(d.accountId || 'self');
    setSpace(d.space ? {
      enabledAgentIds: d.space.enabledAgentIds || [], enabledSkillIds: d.space.enabledSkillIds || [],
      enabledIntegrationIds: d.space.enabledIntegrationIds || [],
      toolAllowlist: d.space.toolAllowlist || [], version: d.space.version,
    } : null);
    setAllowlistText((d.space?.toolAllowlist || []).join(', '));
    const ir = await fetch('/api/integrations');
    if (ir.ok) setIntegrations((await ir.json()).integrations || []);
  }

  async function createIntegration() {
    const isEgress = integForm.direction === 'egress';
    const body = isEgress
      ? { name: integForm.name, kind: integForm.kind, direction: 'egress', endpoint: integForm.endpoint, transport: integForm.transport, capability: integForm.capability }
      : { name: integForm.name, kind: integForm.kind, direction: 'ingress', authMode: integForm.authMode, triggerTarget: integForm.triggerTarget, sourceAllowlist: integForm.sourceAllowlist.split(',').map((s) => s.trim()).filter(Boolean) };
    const res = await fetch('/api/integrations', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    const d = await res.json();
    setMsg(res.ok ? `Created integration #${d.id} — disabled${d.receivePath ? `; receive URL: ${d.receivePath}` : ''}` : `Error: ${JSON.stringify(d.detail || d.error)}`);
    if (res.ok) load();
  }
  async function toggleIntegration(id: number, enabled: boolean) {
    await fetch('/api/integrations', { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ op: enabled ? 'disable' : 'enable', id }) });
    load();
  }
  useEffect(() => { load(); }, []);

  async function createAgent() {
    const res = await fetch('/api/customization', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        kind: 'agent', name: agentForm.name, description: agentForm.description, persona: agentForm.persona,
        gateway: agentForm.gateway, agentType: agentForm.agentType,
        model: agentForm.model || undefined, responseLanguage: agentForm.responseLanguage || undefined,
        gateways: agentForm.gateways.length ? agentForm.gateways : undefined,
        routingKeywords: agentForm.routingKeywords.split(',').map((s) => s.trim()).filter(Boolean),
      }),
    });
    const d = await res.json();
    setMsg(res.ok ? `Created agent #${d.id} — disabled; enable below` : `Error: ${JSON.stringify(d.detail || d.error)}`);
    if (res.ok) load();
  }
  async function createSkill() {
    const res = await fetch('/api/customization', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        kind: 'skill', name: skillForm.name, description: skillForm.description, instructions: skillForm.instructions,
        toolAllowlist: [], agentTypes: skillForm.agentTypes,
      }),
    });
    const d = await res.json();
    setMsg(res.ok ? `Created skill #${d.id} — disabled; enable below` : `Error: ${JSON.stringify(d.detail || d.error)}`);
    if (res.ok) load();
  }
  function toggleInArray(arr: string[], v: string): string[] {
    return arr.includes(v) ? arr.filter((x) => x !== v) : [...arr, v];
  }
  async function toggle(kind: 'agent' | 'skill', id: number, enabled: boolean) {
    await fetch('/api/customization', {
      method: 'PUT', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ op: enabled ? 'disable' : 'enable', kind, id }),
    });
    load();
  }
  async function saveSpace() {
    const enabledAgentIds = space?.enabledAgentIds ?? [];
    const enabledSkillIds = space?.enabledSkillIds ?? [];
    const enabledIntegrationIds = space?.enabledIntegrationIds ?? [];
    const toolAllowlist = allowlistText.split(',').map((s) => s.trim()).filter(Boolean);
    const res = await fetch('/api/customization', {
      method: 'PUT', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ op: 'space', enabledAgentIds, enabledSkillIds, enabledIntegrationIds, toolAllowlist }),
    });
    const data = await res.json();
    setMsg(res.ok ? `Agent Space saved (v${data.version}) for ${accountId}` : `Error: ${JSON.stringify(data.error)}`);
    if (res.ok) load();
  }
  function toggleSpaceAgent(id: number) {
    const cur = space ?? { enabledAgentIds: [], enabledSkillIds: [], enabledIntegrationIds: [], toolAllowlist: [] };
    const set = new Set(cur.enabledAgentIds);
    if (set.has(id)) set.delete(id); else set.add(id);
    setSpace({ ...cur, enabledAgentIds: [...set] });
  }
  function toggleSpaceIntegration(id: number) {
    const cur = space ?? { enabledAgentIds: [], enabledSkillIds: [], enabledIntegrationIds: [], toolAllowlist: [] };
    const set = new Set(cur.enabledIntegrationIds);
    if (set.has(id)) set.delete(id); else set.add(id);
    setSpace({ ...cur, enabledIntegrationIds: [...set] });
  }

  if (denied) return <div className="p-6 text-[13px] text-ink-500">Admin access required (ADR-031).</div>;
  if (noAurora) return <div className="p-6 text-[13px] text-ink-500">Aurora is not configured — custom agents are unavailable.</div>;

  return (
    <div className="text-ink-800">
      <PageHeader title="Custom Agents & Skills" />
      <div className="space-y-6 p-6">
      {msg && <div className="text-[12px] text-brand-600">{msg}</div>}

      <section className="space-y-2 rounded-lg border border-ink-100 bg-paper-muted/60 p-4">
        <h2 className="text-[13px] font-semibold">New Agent</h2>
        <input className="w-full rounded border border-ink-100 bg-paper px-2 py-1 text-[12px]" placeholder="name (kebab-case)" value={agentForm.name} onChange={(e) => setAgentForm({ ...agentForm, name: e.target.value })} />
        <input className="w-full rounded border border-ink-100 bg-paper px-2 py-1 text-[12px]" placeholder="description" value={agentForm.description} onChange={(e) => setAgentForm({ ...agentForm, description: e.target.value })} />
        <textarea className="w-full rounded border border-ink-100 bg-paper px-2 py-1 text-[12px]" placeholder="persona (system prompt)" value={agentForm.persona} onChange={(e) => setAgentForm({ ...agentForm, persona: e.target.value })} />
        <select className="rounded border border-ink-100 bg-paper px-2 py-1 text-[12px]" value={agentForm.gateway} onChange={(e) => setAgentForm({ ...agentForm, gateway: e.target.value })}>
          {GATEWAYS.map((g) => <option key={g} value={g}>{g}</option>)}
        </select>
        <input className="w-full rounded border border-ink-100 bg-paper px-2 py-1 text-[12px]" placeholder="routing keywords (comma-separated)" value={agentForm.routingKeywords} onChange={(e) => setAgentForm({ ...agentForm, routingKeywords: e.target.value })} />
        <div className="flex flex-wrap items-center gap-2">
          <label className="text-[11px] text-ink-500">agent type</label>
          <select className="rounded border border-ink-100 bg-paper px-2 py-1 text-[12px]" value={agentForm.agentType} onChange={(e) => setAgentForm({ ...agentForm, agentType: e.target.value })}>
            {AGENT_TYPES.map((t) => <option key={t} value={t}>{t}</option>)}
          </select>
          <input className="rounded border border-ink-100 bg-paper px-2 py-1 text-[12px]" placeholder="model (optional)" value={agentForm.model} onChange={(e) => setAgentForm({ ...agentForm, model: e.target.value })} />
          <input className="rounded border border-ink-100 bg-paper px-2 py-1 text-[12px]" placeholder="response language (optional)" value={agentForm.responseLanguage} onChange={(e) => setAgentForm({ ...agentForm, responseLanguage: e.target.value })} />
        </div>
        <div className="text-[11px] text-ink-500">
          <span className="mr-2">gateways (multi — defaults to the primary above)</span>
          {GATEWAYS.map((g) => (
            <label key={g} className="mr-2 inline-flex items-center gap-1">
              <input type="checkbox" checked={agentForm.gateways.includes(g)} onChange={() => setAgentForm({ ...agentForm, gateways: toggleInArray(agentForm.gateways, g) })} />
              {g}
            </label>
          ))}
        </div>
        <button onClick={createAgent} className="rounded bg-brand-500 px-3 py-1 text-[12px] font-medium text-white">Create</button>
      </section>

      <section className="space-y-2 rounded-lg border border-ink-100 bg-paper-muted/60 p-4">
        <h2 className="text-[13px] font-semibold">New Skill</h2>
        <input className="w-full rounded border border-ink-100 bg-paper px-2 py-1 text-[12px]" placeholder="name (kebab-case)" value={skillForm.name} onChange={(e) => setSkillForm({ ...skillForm, name: e.target.value })} />
        <input className="w-full rounded border border-ink-100 bg-paper px-2 py-1 text-[12px]" placeholder="description (≥100 chars recommended — describes when to use)" value={skillForm.description} onChange={(e) => setSkillForm({ ...skillForm, description: e.target.value })} />
        <textarea className="w-full rounded border border-ink-100 bg-paper px-2 py-1 text-[12px]" rows={4} placeholder="instructions (Markdown)" value={skillForm.instructions} onChange={(e) => setSkillForm({ ...skillForm, instructions: e.target.value })} />
        <div className="text-[11px] text-ink-500">
          <span className="mr-2">agent types (targeting)</span>
          {AGENT_TYPES.map((t) => (
            <label key={t} className="mr-2 inline-flex items-center gap-1">
              <input type="checkbox" checked={skillForm.agentTypes.includes(t)} onChange={() => setSkillForm({ ...skillForm, agentTypes: toggleInArray(skillForm.agentTypes, t) })} />
              {t}
            </label>
          ))}
        </div>
        <button onClick={createSkill} className="rounded bg-brand-500 px-3 py-1 text-[12px] font-medium text-white">Create Skill</button>
      </section>

      <section className="space-y-2">
        <h2 className="text-[13px] font-semibold">Agents</h2>
        {agents.map((a) => (
          <div key={a.id} className="flex items-center justify-between rounded border border-ink-100 bg-paper px-3 py-2 text-[12px]">
            <div>
              <span className="font-semibold">{a.name}</span>{' '}
              <span className="text-ink-400">({a.tier}, {a.agentType || 'generic'}, gw={(a.gateways && a.gateways.length ? a.gateways.join('+') : a.gateway)}, v{a.version}, skills={a.skills.length})</span>
              <div className="text-ink-500">{a.description}</div>
            </div>
            {a.tier === 'custom'
              ? <button onClick={() => toggle('agent', a.id, a.enabled)} className={`rounded border px-2 py-1 text-[12px] ${a.enabled ? 'border-emerald-300 text-emerald-600' : 'border-ink-100 text-ink-400'}`}>{a.enabled ? 'Enabled' : 'Disabled'}</button>
              : <span className="text-ink-400">built-in</span>}
          </div>
        ))}
      </section>

      <section className="space-y-2">
        <h2 className="text-[13px] font-semibold">Skills</h2>
        {skills.map((s) => (
          <div key={s.id} className="flex items-center justify-between rounded border border-ink-100 bg-paper px-3 py-2 text-[12px]">
            <div><span className="font-semibold">{s.name}</span> <span className="text-ink-400">({s.tier}, v{s.version}{s.agentTypes && s.agentTypes.length ? `, ${s.agentTypes.join('/')}` : ''})</span><div className="text-ink-500">{s.description}</div></div>
            {s.tier === 'custom' && <button onClick={() => toggle('skill', s.id, s.enabled)} className={`rounded border px-2 py-1 text-[12px] ${s.enabled ? 'border-emerald-300 text-emerald-600' : 'border-ink-100 text-ink-400'}`}>{s.enabled ? 'Enabled' : 'Disabled'}</button>}
          </div>
        ))}
      </section>

      <section className="space-y-3 rounded-lg border border-ink-100 bg-paper-muted/60 p-4">
        <div>
          <h2 className="text-[13px] font-semibold">Integrations (advanced)</h2>
          <p className="text-[11px] text-ink-400">
            데이터소스(Prometheus·Loki·…)와 커넥터(Notion)는 이제 <a href="/integrations" className="text-brand-600 underline">연동 허브</a>에서 관리합니다.
            아래는 고급 — 임의 egress/ingress 통합 등록입니다.
          </p>
        </div>

        <details className="mt-2 border-t border-ink-100 pt-2">
          <summary className="cursor-pointer text-[12px] text-ink-500">Advanced — register a custom integration</summary>
          <div className="mt-2 space-y-2">
            <div className="flex gap-2 text-[12px]">
              {['egress', 'ingress'].map((d) => (
                <button key={d} onClick={() => setIntegForm({ ...integForm, direction: d, kind: d === 'egress' ? 'grafana' : 'pagerduty' })}
                  className={`rounded border px-2 py-1 ${integForm.direction === d ? 'border-brand-500 text-brand-600' : 'border-ink-100 text-ink-400'}`}>{d}</button>
              ))}
            </div>
            <input className="w-full rounded border border-ink-100 bg-paper px-2 py-1 text-[12px]" placeholder="name (kebab-case)" value={integForm.name} onChange={(e) => setIntegForm({ ...integForm, name: e.target.value })} />
            <select className="rounded border border-ink-100 bg-paper px-2 py-1 text-[12px]" value={integForm.kind} onChange={(e) => setIntegForm({ ...integForm, kind: e.target.value })}>
              {(integForm.direction === 'egress' ? INTEG_KINDS_EGRESS : INTEG_KINDS_INGRESS).map((k) => <option key={k} value={k}>{k}</option>)}
            </select>
            {integForm.direction === 'egress' ? (
              <div className="flex flex-wrap items-center gap-2">
                <input className="rounded border border-ink-100 bg-paper px-2 py-1 text-[12px]" placeholder="https endpoint" value={integForm.endpoint} onChange={(e) => setIntegForm({ ...integForm, endpoint: e.target.value })} />
                <select className="rounded border border-ink-100 bg-paper px-2 py-1 text-[12px]" value={integForm.transport} onChange={(e) => setIntegForm({ ...integForm, transport: e.target.value })}>
                  {INTEG_TRANSPORTS.map((t) => <option key={t} value={t}>{t}</option>)}
                </select>
                <select className="rounded border border-ink-100 bg-paper px-2 py-1 text-[12px]" value={integForm.capability} onChange={(e) => setIntegForm({ ...integForm, capability: e.target.value })}>
                  <option value="read">read</option><option value="read_write">read_write</option>
                </select>
              </div>
            ) : (
              <div className="flex flex-wrap items-center gap-2">
                <input className="rounded border border-ink-100 bg-paper px-2 py-1 text-[12px]" placeholder="auth mode (e.g. hmac, vendor_sig)" value={integForm.authMode} onChange={(e) => setIntegForm({ ...integForm, authMode: e.target.value })} />
                <input className="rounded border border-ink-100 bg-paper px-2 py-1 text-[12px]" placeholder="source allowlist (comma IPs)" value={integForm.sourceAllowlist} onChange={(e) => setIntegForm({ ...integForm, sourceAllowlist: e.target.value })} />
                <span className="text-[11px] text-ink-400">trigger: incident (receive URL generated on create)</span>
              </div>
            )}
            <button onClick={createIntegration} className="rounded border border-ink-200 px-3 py-1 text-[12px] font-medium">Register integration</button>
            {integrations.map((i) => (
              <div key={i.id} className="flex items-center justify-between rounded border border-ink-100 bg-paper px-3 py-2 text-[12px]">
                <div>
                  <span className="font-semibold">{i.name}</span>{' '}
                  <span className="text-ink-400">({i.tier}, {i.direction}, {i.kind}, {i.capability})</span>
                  {i.direction === 'ingress' && i.receivePath && <div className="text-ink-500">{i.receivePath}</div>}
                </div>
                {i.tier === 'custom'
                  ? <button onClick={() => toggleIntegration(i.id, i.enabled)} className={`rounded border px-2 py-1 text-[12px] ${i.enabled ? 'border-emerald-300 text-emerald-600' : 'border-ink-100 text-ink-400'}`}>{i.enabled ? 'Enabled' : 'Disabled'}</button>
                  : <span className="text-ink-400">built-in</span>}
              </div>
            ))}
            {integrations.length === 0 && <span className="text-[12px] text-ink-400">no custom integrations yet</span>}
          </div>
        </details>
      </section>

      <section className="space-y-2 rounded-lg border border-ink-100 bg-paper-muted/60 p-4">
        <h2 className="text-[13px] font-semibold">Agent Space — account {accountId}</h2>
        {!space && (
          <div className="text-[12px] text-ink-500">
            Global (Phase-1) mode — all globally-enabled custom agents are available for this account.
            Saving below creates an Agent Space and scopes this account.
          </div>
        )}
        <div className="text-[12px]">
          <div className="mb-1 font-medium">Enabled custom agents (account-scoped)</div>
          {agents.filter((a) => a.tier === 'custom').map((a) => (
            <label key={a.id} className="mr-3 inline-flex items-center gap-1">
              <input type="checkbox" checked={!!space?.enabledAgentIds.includes(a.id)} onChange={() => toggleSpaceAgent(a.id)} />
              {a.name}
            </label>
          ))}
          {agents.filter((a) => a.tier === 'custom').length === 0 && <span className="text-ink-400">no custom agents yet</span>}
        </div>
        <div className="text-[12px]">
          <div className="mb-1 font-medium">Enabled integrations (account-scoped)</div>
          {integrations.map((i) => (
            <label key={i.id} className="mr-3 inline-flex items-center gap-1">
              <input type="checkbox" checked={!!space?.enabledIntegrationIds.includes(i.id)} onChange={() => toggleSpaceIntegration(i.id)} />
              {i.name}
            </label>
          ))}
          {integrations.length === 0 && <span className="text-ink-400">no integrations yet</span>}
        </div>
        <div className="text-[12px]">
          <div className="mb-1 font-medium">Tool allowlist (account cap, comma-separated)</div>
          <input className="w-full rounded border border-ink-100 bg-paper px-2 py-1 text-[12px]"
                 placeholder="e.g. simulate_principal_policy, get_account_authorization_details"
                 value={allowlistText} onChange={(e) => setAllowlistText(e.target.value)} />
          <div className="mt-1 text-ink-400">Empty = no account cap (Phase-1 advisory). A non-empty list can only REMOVE tools a skill declared — it never grants new tools.</div>
        </div>
        <button onClick={saveSpace} className="rounded bg-brand-500 px-3 py-1 text-[12px] font-medium text-white">Save Agent Space</button>
      </section>
      </div>
    </div>
  );
}
