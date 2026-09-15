// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import Page from './page';
const { locale } = vi.hoisted(() => ({ locale: { value: 'en' } }));
vi.mock('@/components/ui/PageHeader', () => ({ default: () => <h1>Customization</h1> }));
vi.mock('@/components/shell/LanguageProvider', () => ({ useI18n: () => ({ lang: locale.value, tt: (s: string) => s }) }));
const policy = { aurora: true, accountId: 'self', agents: [], skills: [], space: {
  enabledAgentIds: [7], enabledSkillIds: [8], enabledIntegrationIds: [9], toolAllowlist: ['list_users'], version: 3,
} };
let reply: () => Promise<Response>;
const writes: Record<string, unknown>[] = [];
beforeEach(() => {
  locale.value = 'en'; writes.length = 0;
  reply = async () => Response.json(policy);
  vi.stubGlobal('fetch', vi.fn(async (url, init) => {
    if (init?.method) { writes.push(JSON.parse(init.body)); return Response.json({ ok: true, version: 4 }); }
    return String(url) === '/api/customization' ? reply() : Response.json({ integrations: [] });
  }));
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });
const save = () => screen.getByRole('button', { name: 'Save Agent Space' });
const cap = () => screen.getByPlaceholderText('e.g. simulate_principal_policy, get_account_security_summary') as HTMLInputElement;

describe('policy availability', () => {
  it.each(['503', 'network', 'invalid-json', 'invalid-state'])('blocks first-load %s without claiming global mode or writing empty policy', async failure => {
    reply = async () => {
      if (failure === 'network') throw new Error('private network error');
      return failure === '503' ? Response.json({ error: 'private policy error' }, { status: 503 })
        : failure === 'invalid-json' ? new Response('not json') : Response.json({ ...policy, space: { toolAllowlist: [] } });
    };
    render(<Page />);
    expect(save().matches(':disabled')).toBe(true);
    await screen.findByRole('alert');
    expect(screen.queryByText(/Global \(Phase-1\)/)).toBeNull();
    expect(screen.queryByText(/private.*error/)).toBeNull();
    fireEvent.click(save());
    expect(writes).toEqual([]);
  });
  it.each(['503', 'network', 'invalid-json', 'invalid-state'])('retains a loaded cap after %s refresh failure and recovers only after valid reload', async failure => {
    render(<Page />);
    await waitFor(() => expect(save().matches(':disabled')).toBe(false));
    expect(cap().value).toBe('list_users');
    reply = async () => {
      if (failure === 'network') throw new Error('private network error');
      return failure === '503' ? Response.json({ error: 'unavailable' }, { status: 503 })
        : failure === 'invalid-json' ? new Response('bad json') : Response.json({ ...policy, space: { toolAllowlist: [] } });
    };
    // A successful catalog action triggers the existing refresh path.
    fireEvent.click(screen.getByRole('button', { name: 'Create Skill' }));
    await screen.findByRole('alert');
    expect(cap().value).toBe('list_users');
    expect(cap().matches(':disabled')).toBe(true);
    writes.length = 0;
    fireEvent.click(save());
    expect(writes).toEqual([]);
    reply = async () => Response.json(policy);
    fireEvent.click(screen.getByRole('button', { name: 'Retry policy load' }));
    await waitFor(() => expect(save().matches(':disabled')).toBe(false));
    fireEvent.click(save());
    await waitFor(() => expect(writes).toEqual([{ op: 'space', enabledAgentIds: [7], enabledSkillIds: [8], enabledIntegrationIds: [9], toolAllowlist: ['list_users'] }]));
  });
  it('confirmed no-row stays editable after a successful load', async () => {
    reply = async () => Response.json({ ...policy, space: null });
    render(<Page />);
    await screen.findByText(/Global \(Phase-1\)/);
    expect(save().matches(':disabled')).toBe(false);
    fireEvent.click(save());
    await waitFor(() => expect(writes).toEqual([{ op: 'space', enabledAgentIds: [], enabledSkillIds: [], enabledIntegrationIds: [], toolAllowlist: [] }]));
  });
  it.each(['ko','en','ja','zh'])('localizes the unavailable state (%s)', async lang => {
    locale.value = lang;
    reply = async () => new Response('{}', { status: 503 });
    render(<Page />);
    const alert = await screen.findByRole('alert');
    const expected = { ko: '정책을 불러올 수 없습니다', en: 'Policy is unavailable', ja: 'ポリシーを読み込めません', zh: '无法读取策略' }[lang]!;
    expect(alert.textContent).toContain(expected);
  });
});
