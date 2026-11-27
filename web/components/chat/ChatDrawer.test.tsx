// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import ChatDrawer from './ChatDrawer';
import { setPageContext } from '@/lib/chat-page-context';

vi.mock('./useChat', () => ({
  useChat: () => ({
    threads: [], threadId: null, msgs: [], busy: false, showThreads: false,
    toggleThreads: () => {}, selectThread: async () => {}, abort: () => {},
    newChat: () => {}, removeThread: () => {}, removeAllThreads: () => {},
    refreshThreads: async () => {}, send: () => {}, resendWith: () => {}, followUp: () => {},
  }),
}));
vi.mock('next/navigation', () => ({ useRouter: () => ({ push: () => {} }), usePathname: () => '/topology' }));
vi.mock('@/components/shell/LanguageProvider', () => ({
  useI18n: () => ({ tt: (text: string) => text, t: (text: string) => text, lang: 'ko' }),
}));

const HINT = '현재 보고 있는 사이트 흐름을 함께 보냅니다.';

beforeEach(() => {
  localStorage.clear();
  vi.stubGlobal('matchMedia', () => ({ matches: true, addEventListener: () => {}, removeEventListener: () => {} }));
});
afterEach(() => { cleanup(); setPageContext(null); vi.unstubAllGlobals(); });

describe('chat drawer page-context disclosure', () => {
  it('shows the hint only while a page context is attached', () => {
    render(<ChatDrawer />);
    fireEvent.click(screen.getByRole('button', { name: 'AI 어시스턴트 열기' }));
    expect(screen.queryByText(HINT)).toBeNull();
    act(() => setPageContext('Site flow for shop.example.test'));
    expect(screen.getByRole('note').textContent).toBe(HINT);
    act(() => setPageContext(null));
    expect(screen.queryByText(HINT)).toBeNull();
  });
});
