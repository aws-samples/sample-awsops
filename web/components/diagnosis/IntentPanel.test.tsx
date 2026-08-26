// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { render, screen, fireEvent, cleanup, waitFor } from '@testing-library/react';
import IntentPanel from './IntentPanel';

afterEach(cleanup);

const drafts = [
  // a critical, currently-violating candidate (heuristic risk) → must show the badge, no bulk-accept
  { id: 1, kind: 'private_only', target: 'rds', params: { heuristic_risk: true }, severity: 'critical', status: 'draft', provenance: 'ai_proposed' },
  // a warning candidate, no heuristic risk
  { id: 2, kind: 'encryption_required', target: 's3', params: {}, severity: 'warning', status: 'draft', provenance: 'ai_proposed' },
];

function mockFetch(handlers: Record<string, (init?: RequestInit) => { status: number; body: unknown }>) {
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    const key = `${init?.method ?? 'GET'} ${url.replace(/^https?:\/\/[^/]+/, '')}`;
    const h = Object.keys(handlers).find((k) => key.startsWith(k));
    const { status, body } = (h ? handlers[h](init) : { status: 404, body: {} });
    return { ok: status >= 200 && status < 300, status, json: async () => body } as Response;
  }));
}

beforeEach(() => {
  mockFetch({
    'GET /api/diagnosis/intent': () => ({ status: 200, body: { intents: drafts } }),
    'POST /api/diagnosis/intent': () => ({ status: 200, body: { ok: true, candidates: [] } }),
  });
});

describe('IntentPanel', () => {
  it('renders draft candidates with per-item Accept/Reject', async () => {
    render(<IntentPanel />);
    expect(await screen.findByText(/private_only/)).toBeTruthy();
    expect(screen.getByText(/encryption_required/)).toBeTruthy();
    expect(screen.getAllByText('Accept').length).toBe(2); // one per item — no bulk-accept control
  });

  it('shows the Heuristic Risk badge for a currently-violating candidate', async () => {
    render(<IntentPanel />);
    await screen.findByText(/private_only/);
    expect(screen.getByText(/Heuristic Risk/i)).toBeTruthy();
  });

  it('has NO bulk "accept all" control (per-item only, §8R3)', async () => {
    render(<IntentPanel />);
    await screen.findByText(/private_only/);
    expect(screen.queryByText(/accept all/i)).toBeNull();
  });

  it('Accept on a critical item POSTs a single-id promote (not a bulk ids[])', async () => {
    const calls: { url: string; body: any }[] = [];
    vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
      if (init?.method === 'POST') calls.push({ url, body: JSON.parse(String(init.body)) });
      const body = init?.method === 'POST' ? { id: 1, status: 'active' } : { intents: drafts };
      return { ok: true, status: 200, json: async () => body } as Response;
    }));
    render(<IntentPanel />);
    await screen.findByText(/private_only/);
    fireEvent.click(screen.getAllByText('Accept')[0]);
    await waitFor(() => expect(calls.some((c) => c.body.action === 'promote')).toBe(true));
    const promote = calls.find((c) => c.body.action === 'promote')!;
    expect(promote.body.id).toBe(1);
    expect(promote.body.ids).toBeUndefined(); // never a bulk array
  });

  it('Propose button POSTs action=propose', async () => {
    const calls: any[] = [];
    vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
      if (init?.method === 'POST') calls.push(JSON.parse(String(init.body)));
      const body = init?.method === 'POST' ? { candidates: [] } : { intents: drafts };
      return { ok: true, status: 200, json: async () => body } as Response;
    }));
    render(<IntentPanel />);
    await screen.findByText(/private_only/);
    fireEvent.click(screen.getByText(/제안|Propose/i));
    await waitFor(() => expect(calls.some((c) => c.action === 'propose')).toBe(true));
  });
});
