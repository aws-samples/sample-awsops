import { describe, it, expect, vi, afterEach } from 'vitest';
import { clearPageContext, createPageContextOwner, getPageContext, setPageContext, subscribePageContext } from './chat-page-context';

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

  it('clear-if-mine: producer A unmounting does not clear producer B\'s value', () => {
    const a = createPageContextOwner();
    const b = createPageContextOwner();
    setPageContext('flow A', a);
    setPageContext('flow B', b);
    clearPageContext(a); // A unmounts after B took over
    expect(getPageContext()).toBe('flow B');
    clearPageContext(b);
    expect(getPageContext()).toBeNull();
  });

  it('ownership moves even when the new producer sets the same text', () => {
    const a = createPageContextOwner();
    const b = createPageContextOwner();
    const l = vi.fn();
    const off = subscribePageContext(l);
    setPageContext('same flow', a);
    setPageContext('same flow', b);
    expect(l).toHaveBeenCalledTimes(1); // unchanged value: no extra notification
    clearPageContext(a);
    expect(getPageContext()).toBe('same flow');
    clearPageContext(b);
    expect(getPageContext()).toBeNull();
    off();
  });

  it('set returns the owner it used, minting one when none is given', () => {
    const o = setPageContext('x');
    expect(typeof o).toBe('symbol');
    expect(setPageContext('y', o)).toBe(o);
    clearPageContext(createPageContextOwner());
    expect(getPageContext()).toBe('y');
    clearPageContext(o);
    expect(getPageContext()).toBeNull();
  });
});
