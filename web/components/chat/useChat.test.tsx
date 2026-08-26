// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useChat, parseFrame } from './useChat';

// Mock localStorage
const localStorageMock = (() => {
  let store: Record<string, string> = {};
  return {
    getItem: (key: string) => store[key] || null,
    setItem: (key: string, value: string) => { store[key] = value.toString(); },
    removeItem: (key: string) => { delete store[key]; },
    clear: () => { store = {}; },
  };
})();
Object.defineProperty(global, 'localStorage', { value: localStorageMock });

describe('useChat hook and parseFrame', () => {
  it('handles event: status and extracts phase and elapsedMs', () => {
    const frame = 'event: status\ndata: {"phase":"working","elapsedMs":3000}\n\n';
    const parsed = parseFrame(frame);
    expect(parsed).toEqual({
      kind: 'status',
      phase: 'working',
      elapsedMs: 3000,
    });
  });

  it('updates msg status on status frames and clears it on delta', async () => {
    let resolveRead1: any;
    let resolveRead2: any;
    let resolveRead3: any;

    const p1 = new Promise((resolve) => { resolveRead1 = resolve; });
    const p2 = new Promise((resolve) => { resolveRead2 = resolve; });
    const p3 = new Promise((resolve) => { resolveRead3 = resolve; });

    const mockStream = {
      getReader: () => ({
        read: vi.fn()
          .mockReturnValueOnce(p1)
          .mockReturnValueOnce(p2)
          .mockReturnValueOnce(p3)
          .mockResolvedValue({ done: true }),
      }),
    };

    const mockResponse = {
      ok: true,
      body: mockStream,
    };

    const fetchSpy = vi.spyOn(global, 'fetch').mockResolvedValue(mockResponse as any);

    const { result } = renderHook(() => useChat());

    let sendPromise!: Promise<any>;
    act(() => {
      sendPromise = result.current.send('test prompt');
    });

    // Step 1: Emit status frame
    await act(async () => {
      resolveRead1({ done: false, value: new TextEncoder().encode('event: status\ndata: {"phase":"working","elapsedMs":3000}\n\n') });
    });

    // Verify msgs state contains status
    expect(result.current.msgs).toHaveLength(2);
    expect(result.current.msgs[1]).toEqual({
      role: 'assistant',
      content: '',
      streaming: true,
      status: { phase: 'working', elapsedMs: 3000 },
    });

    // Step 2: Emit delta frame (should clear status and append content).
    // 델타는 타자기 스무딩 버퍼(24ms 간격 방출)를 거치므로 폴링으로 최종 상태를 기다린다.
    await act(async () => {
      resolveRead2({ done: false, value: new TextEncoder().encode('data: {"delta":"hello"}\n\n') });
    });
    await act(async () => {
      for (let i = 0; i < 40 && (result.current.msgs[1]?.content ?? '') !== 'hello'; i++) {
        await new Promise((r) => setTimeout(r, 25));
      }
    });

    expect(result.current.msgs[1]).toEqual({
      role: 'assistant',
      content: 'hello',
      streaming: true,
      status: undefined,
    });

    // Step 3: Finish stream
    await act(async () => {
      resolveRead3({ done: true });
    });

    await act(async () => {
      await sendPromise;
    });

    expect(result.current.msgs[1]).toEqual({
      role: 'assistant',
      content: 'hello',
      streaming: false,
      status: undefined,
    });

    fetchSpy.mockRestore();
  });
});
