// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import AssistantClient from './AssistantClient';

// Replace network-backed chat state; exercise the actual assistant layout and ThreadList.
vi.mock('./useChat', () => ({
  useChat: () => ({
    threads: [], threadId: null, msgs: [], busy: false,
    toggleThreads: () => {}, selectThread: async () => {},
    newChat: () => {}, removeThread: () => {}, removeAllThreads: () => {},
    refreshThreads: async () => {}, send: () => {}, resendWith: () => {},
    followUp: () => {}, sessionStats: () => ({ count: 0 }),
  }),
}));
vi.mock('next/navigation', () => ({ useSearchParams: () => new URLSearchParams() }));
vi.mock('@/components/shell/LanguageProvider', () => ({
  useI18n: () => ({ tt: (text: string) => text, t: (text: string) => text, lang: 'ko' }),
}));

const widthKey = 'awsops_assistant_threads_width';
const collapsedKey = 'awsops_assistant_threads_collapsed';

beforeEach(() => localStorage.clear());
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

describe('assistant conversation list', () => {
  it('collapses and restores the list without losing the composer draft', () => {
    render(<AssistantClient />);
    const composer = screen.getByRole('combobox');
    fireEvent.change(composer, { target: { value: 'keep this draft' } });
    fireEvent.click(screen.getByRole('button', { name: '대화 목록 닫기' }));
    expect(screen.queryByRole('separator')).toBeNull();
    expect(localStorage.getItem(collapsedKey)).toBe('1');
    expect((composer as HTMLTextAreaElement).value).toBe('keep this draft');
    fireEvent.click(screen.getAllByRole('button', { name: '대화 목록 열기' })[0]);
    expect(screen.getByRole('separator')).toBeTruthy();
    expect(localStorage.getItem(collapsedKey)).toBe('0');
    expect((composer as HTMLTextAreaElement).value).toBe('keep this draft');
  });

  it('restores a collapsed list and its last width after remounting', () => {
    localStorage.setItem(widthKey, '224');
    localStorage.setItem(collapsedKey, '1');
    render(<AssistantClient />);
    expect(screen.queryByRole('separator')).toBeNull();
    fireEvent.click(screen.getAllByRole('button', { name: '대화 목록 열기' })[0]);
    expect(screen.getByRole('separator').getAttribute('aria-valuenow')).toBe('224');
  });

  it('supports keyboard sizing, clamps both bounds and persists the selection', () => {
    render(<AssistantClient />);
    const handle = screen.getByRole('separator', { name: '대화 목록 너비 조절' });
    fireEvent.keyDown(handle, { key: 'ArrowLeft' });
    expect(handle.getAttribute('aria-valuenow')).toBe('240');
    expect(localStorage.getItem(widthKey)).toBe('240');
    fireEvent.keyDown(handle, { key: 'Home' });
    fireEvent.keyDown(handle, { key: 'ArrowLeft' });
    expect(handle.getAttribute('aria-valuenow')).toBe('192');
    fireEvent.keyDown(handle, { key: 'End' });
    fireEvent.keyDown(handle, { key: 'ArrowRight' });
    expect(handle.getAttribute('aria-valuenow')).toBe('384');
    fireEvent.doubleClick(handle);
    expect(handle.getAttribute('aria-valuenow')).toBe('256');
  });

  it('keeps resizing usable when layout preference storage is unavailable', () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => { throw new Error('blocked'); });
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('blocked'); });
    render(<AssistantClient />);
    const handle = screen.getByRole('separator');
    fireEvent.keyDown(handle, { key: 'ArrowLeft' });
    expect(handle.getAttribute('aria-valuenow')).toBe('240');
    fireEvent.click(screen.getByRole('button', { name: '대화 목록 닫기' }));
    expect(screen.queryByRole('separator')).toBeNull();
  });

  it.each(['NaN', 'Infinity', '', '-100'])('ignores invalid saved width %j', value => {
    localStorage.setItem(widthKey, value);
    render(<AssistantClient />);
    expect(screen.getByRole('separator').getAttribute('aria-valuenow')).toBe('256');
  });
});
