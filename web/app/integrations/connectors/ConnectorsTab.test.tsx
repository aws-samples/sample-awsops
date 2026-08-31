// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { render, screen, fireEvent, cleanup, waitFor, within } from '@testing-library/react';
import ConnectorsTab from './ConnectorsTab';

let calls: { url: string; method?: string; body?: string }[] = [];
beforeEach(() => {
  calls = [];
  global.fetch = vi.fn(async (url: string, init?: RequestInit) => {
    calls.push({ url, method: init?.method, body: init?.body as string });
    return { ok: true, status: 200, json: async () => (url === '/api/integrations/credential' && (!init || init.method === undefined) ? { configured: [] } : { ok: true }) };
  }) as unknown as typeof fetch;
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

describe('ConnectorsTab', () => {
  it('lists Notion as a connector and shows the propose-only write note', async () => {
    render(<ConnectorsTab canManage />);
    await waitFor(() => expect(screen.getByText('Notion')).toBeTruthy());
    expect(screen.getAllByText(/제안전용/).length).toBeGreaterThan(0);
    // no datasource kinds here
    expect(screen.queryByText('prometheus')).toBeNull();
    expect(screen.queryByText('clickhouse')).toBeNull();
  });

  // ADR-017 (amended 2026-08-05) — 4 cards: Notion + the 3 vendor-HOSTED official-MCP vendors.
  // Self-hosted/in-binary kinds (ClickHouse/Tempo/Jaeger/Grafana/Splunk) must have NO card —
  // ClickHouse is stdio-embedded in the agent runtime, tempo/jaeger register via Datasources.
  it('lists ONLY the vendor-hosted official-MCP presets alongside Notion, each badged', async () => {
    render(<ConnectorsTab canManage />);
    await waitFor(() => expect(screen.getByText('Datadog')).toBeTruthy());
    for (const label of ['Datadog', 'Dynatrace', 'New Relic']) {
      expect(screen.getByText(label)).toBeTruthy();
    }
    for (const gone of ['ClickHouse', 'Tempo', 'Jaeger', 'Grafana', 'Splunk']) {
      expect(screen.queryByText(gone)).toBeNull();
    }
    expect(screen.getAllByText('공식 MCP (hosted)').length).toBe(3); // every preset but Notion
    expect(screen.getAllByText(/게이트됨/).length).toBe(3); // honest gated badge on each
    expect(screen.getByText('벤더 preview')).toBeTruthy(); // New Relic only
  });

  it('admin can paste a token and connect (PUT credential)', async () => {
    render(<ConnectorsTab canManage />);
    await waitFor(() => expect(screen.getByText('Notion')).toBeTruthy());
    const notionCard = screen.getByText('Notion').closest('[class*="p-4"]') as HTMLElement;
    fireEvent.change(within(notionCard).getByPlaceholderText(/토큰 붙여넣기/), { target: { value: 'secret_x' } });
    fireEvent.click(within(notionCard).getByRole('button', { name: '연결' }));
    await waitFor(() => {
      const put = calls.find((c) => c.method === 'PUT');
      expect(put).toBeTruthy();
      // official=false for Notion (its hosted MCP is OAuth-only — see mcp-presets.ts) — stays on
      // the legacy plain-slug credential path, unlike the ADR-017 official presets.
      expect(JSON.parse(put!.body!)).toEqual({ slug: 'notion', secret: { token: 'secret_x' }, official: false });
    });
  });

  it('an ADR-017 preset (official=true) sends official:true so it lands under the namespaced mcp: key', async () => {
    render(<ConnectorsTab canManage />);
    await waitFor(() => expect(screen.getByText('Datadog')).toBeTruthy());
    const datadogCard = screen.getByText('Datadog').closest('[class*="p-4"]') as HTMLElement;
    fireEvent.change(within(datadogCard).getByPlaceholderText(/토큰 붙여넣기/), { target: { value: 'dd_tok' } });
    fireEvent.click(within(datadogCard).getByRole('button', { name: '연결' }));
    await waitFor(() => {
      const put = calls.find((c) => c.method === 'PUT');
      expect(put).toBeTruthy();
      expect(JSON.parse(put!.body!)).toEqual({ slug: 'datadog', secret: { token: 'dd_tok' }, official: true });
    });
  });

  it('non-admin sees a read-only note, no token field, on every card', async () => {
    render(<ConnectorsTab canManage={false} />);
    await waitFor(() => expect(screen.getByText('Notion')).toBeTruthy());
    expect(screen.queryByPlaceholderText(/토큰/)).toBeNull();
    expect(screen.getAllByText(/관리자 전용/).length).toBe(4); // one per preset card
  });

  // Regression for the 2026-07-31 kiro review: an ADR-017 preset with a stored credential must
  // NOT claim "connected" — credential presence alone doesn't mean official_mcp_enabled + this
  // preset's endpoint are set server-side, or that provisioning succeeded. Notion is exempt: its
  // credential IS the whole activation path, so "connected" stays honest for it.
  it('an official-MCP preset with a stored credential says "credential stored", not "connected"', async () => {
    // datadog's credential lives under the namespaced "mcp:" key (mcpConfigured) — Notion's under
    // the plain slug (configured). Round-2 review MAJOR: these must be checked separately per row.
    global.fetch = vi.fn(async (url: string) => ({
      ok: true, status: 200,
      json: async () => (url === '/api/integrations/credential' ? { configured: ['notion'], mcpConfigured: ['datadog'] } : { ok: true }),
    })) as unknown as typeof fetch;
    render(<ConnectorsTab canManage />);
    await waitFor(() => expect(screen.getByText(/자격증명 저장됨/)).toBeTruthy());
    expect(screen.queryByText(/^connected$/)).toBeNull();
    const notionCard = screen.getByText('Notion').closest('[class*="p-4"]') as HTMLElement;
    expect(within(notionCard).getByText(/connected/)).toBeTruthy(); // Notion alone keeps "connected"
    expect(screen.getAllByText(/official_mcp_enabled 플래그와/).length).toBe(3); // one per official preset
  });

  // Round-2 review MAJOR: a plain-slug (datasource-mirror) credential for a slug that is ALSO an
  // official-MCP preset must NOT make the preset row claim "credential stored" — provision.py only
  // ever reads the namespaced "mcp:" key, so this datadog row must stay "no credential".
  it('a plain-slug credential alone does NOT mark an official-MCP preset as configured', async () => {
    global.fetch = vi.fn(async (url: string) => ({
      ok: true, status: 200,
      json: async () => (url === '/api/integrations/credential' ? { configured: ['datadog'], mcpConfigured: [] } : { ok: true }),
    })) as unknown as typeof fetch;
    render(<ConnectorsTab canManage />);
    await waitFor(() => expect(screen.getByText('Datadog')).toBeTruthy());
    const datadogCard = screen.getByText('Datadog').closest('[class*="p-4"]') as HTMLElement;
    expect(within(datadogCard).getByText(/자격증명 없음/)).toBeTruthy();
  });
});
