// @vitest-environment jsdom
import { describe, it, expect, beforeEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useResizablePanel, usePublishDockedWidth } from './useResizablePanel';

beforeEach(() => localStorage.clear());

describe('useResizablePanel', () => {
  it('starts at the default width when nothing is persisted', () => {
    const { result } = renderHook(() => useResizablePanel('k1', 560));
    expect(result.current.width).toBe(560);
  });

  it('restores a persisted width on mount', () => {
    localStorage.setItem('k2', '700');
    const { result } = renderHook(() => useResizablePanel('k2', 560));
    expect(result.current.width).toBe(700);
  });

  it('ignores a persisted width below the minimum', () => {
    localStorage.setItem('k3', '100');
    const { result } = renderHook(() => useResizablePanel('k3', 560, 380));
    expect(result.current.width).toBe(560);
  });

  it('clamps a persisted width to the viewport (saved on a wider screen)', () => {
    // jsdom innerWidth defaults to 1024 → cap = 1024 - 60 = 964
    localStorage.setItem('k4', '5000');
    const { result } = renderHook(() => useResizablePanel('k4', 560));
    expect(result.current.width).toBe(964);
  });

  it('drag resizes (viewport - clientX) and persists on release', () => {
    const { result } = renderHook(() => useResizablePanel('k5', 560, 380));
    act(() => {
      result.current.startResize({ preventDefault() {} } as unknown as React.MouseEvent);
      window.dispatchEvent(new MouseEvent('mousemove', { clientX: 1024 - 720 }));
    });
    expect(result.current.width).toBe(720);
    act(() => { window.dispatchEvent(new MouseEvent('mouseup')); });
    expect(localStorage.getItem('k5')).toBe('720');
    expect(document.body.style.userSelect).toBe('');
  });

  it('drag clamps at the minimum width', () => {
    const { result } = renderHook(() => useResizablePanel('k6', 560, 380));
    act(() => {
      result.current.startResize({ preventDefault() {} } as unknown as React.MouseEvent);
      window.dispatchEvent(new MouseEvent('mousemove', { clientX: 1024 - 50 })); // would be 50px
    });
    expect(result.current.width).toBe(380);
    act(() => { window.dispatchEvent(new MouseEvent('mouseup')); });
  });
});

describe('usePublishDockedWidth (chat-overlap coordinator)', () => {
  const W = () => document.documentElement.style.getPropertyValue('--detail-panel-w');

  it('publishes the width to --detail-panel-w while open, 0 when closed', () => {
    const { rerender } = renderHook(({ o, w }) => usePublishDockedWidth(o, w), {
      initialProps: { o: true, w: 480 },
    });
    expect(W()).toBe('480px');
    rerender({ o: false, w: 480 });
    expect(W()).toBe('0px');
  });

  it('tracks width changes while open and resets to 0 on unmount', () => {
    const { rerender, unmount } = renderHook(({ o, w }) => usePublishDockedWidth(o, w), {
      initialProps: { o: true, w: 420 },
    });
    expect(W()).toBe('420px');
    rerender({ o: true, w: 640 });
    expect(W()).toBe('640px');
    unmount();
    expect(W()).toBe('0px');
  });
});
