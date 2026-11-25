import { describe, it, expect, vi, afterEach } from 'vitest';
import { getPageContext, setPageContext, subscribePageContext } from './chat-page-context';

afterEach(() => setPageContext(null));

describe('chat page context store', () => {
  it('starts empty, holds the last value and clears with null or an empty string', () => {
    expect(getPageContext()).toBeNull();
    setPageContext('Site flow for shop.example.test');
    expect(getPageContext()).toBe('Site flow for shop.example.test');
    setPageContext(null);
    expect(getPageContext()).toBeNull();
    setPageContext('x');
    setPageContext('');
    expect(getPageContext()).toBeNull();
  });

  it('notifies subscribers on a change only, and stops after unsubscribe', () => {
    const l = vi.fn();
    const off = subscribePageContext(l);
    setPageContext('a');
    setPageContext('a'); // same value: no notification
    setPageContext('b');
    setPageContext(null);
    setPageContext(null);
    expect(l).toHaveBeenCalledTimes(3);
    off();
    setPageContext('c');
    expect(l).toHaveBeenCalledTimes(3);
  });
});
