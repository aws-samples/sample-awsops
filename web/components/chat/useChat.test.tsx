// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useChat, parseFrame, newSessionId } from './useChat';

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
  it('uses cryptographic randomness even without randomUUID', () => {
    const random = vi.spyOn(Math, 'random').mockImplementation(() => { throw new Error('insecure'); });
    const original = globalThis.crypto;
    vi.stubGlobal('crypto', { getRandomValues: original.getRandomValues.bind(original) });
    try {
      const first = newSessionId();
      expect(first).toMatch(/^[a-f0-9]{36}$/);
      expect(newSessionId()).not.toBe(first);
      expect(random).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllGlobals();
      random.mockRestore();
    }
  });
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

// `meta.gateways` is an untrusted shape both in persisted history and on the live SSE meta frame:
// only a non-empty string array is kept; anything else becomes undefined (no card, no crash).
describe('gateways provenance (asGateways)', () => {
  const VALID = ['network', 'security'];
  const INVALID: [string, unknown][] = [
    ['a non-array', 'network'],
    ['a mixed array', ['network', 7]],
    ['a missing value', undefined],
  ];

  function assistantRow(gateways: unknown) {
    const meta: Record<string, unknown> = { tools: ['t'] };
    if (gateways !== undefined) meta.gateways = gateways;
    return { role: 'assistant', content: 'a', gateway: 'network', meta };
  }

  async function loadHistory(gateways: unknown) {
    const fetchSpy = vi.spyOn(global, 'fetch').mockResolvedValue({
      ok: true,
      json: async () => ({
        thread: { id: 'th1', sessionId: 'sess1' },
        messages: [{ role: 'user', content: 'q', gateway: null, meta: null }, assistantRow(gateways)],
      }),
    } as any);
    const { result } = renderHook(() => useChat());
    await act(async () => { await result.current.selectThread('th1'); });
    fetchSpy.mockRestore();
    return result.current.msgs[1];
  }

  async function streamMeta(gateways: unknown) {
    const meta: Record<string, unknown> = { tools: ['t'] };
    if (gateways !== undefined) meta.gateways = gateways;
    const frames = `data: {"delta":"hi"}\n\nevent: meta\ndata: ${JSON.stringify(meta)}\n\n`;
    const read = vi.fn()
      .mockResolvedValueOnce({ done: false, value: new TextEncoder().encode(frames) })
      .mockResolvedValue({ done: true });
    const fetchSpy = vi.spyOn(global, 'fetch').mockResolvedValue({
      ok: true, body: { getReader: () => ({ read }) },
    } as any);
    const { result } = renderHook(() => useChat());
    await act(async () => { await result.current.send('q'); });
    fetchSpy.mockRestore();
    return result.current.msgs[1];
  }

  it('history load keeps a string array', async () => {
    expect((await loadHistory(VALID)).gateways).toEqual(VALID);
  });
  it.each(INVALID)('history load maps %s to undefined', async (_label, value) => {
    const msg = await loadHistory(value);
    expect(msg.tools).toEqual(['t']); // the row itself still loads
    expect(msg.gateways).toBeUndefined();
  });
  it('live SSE meta keeps a string array', async () => {
    expect((await streamMeta(VALID)).gateways).toEqual(VALID);
  });
  it.each(INVALID)('live SSE meta maps %s to undefined', async (_label, value) => {
    const msg = await streamMeta(value);
    expect(msg.tools).toEqual(['t']);
    expect(msg.gateways).toBeUndefined();
  });
});
