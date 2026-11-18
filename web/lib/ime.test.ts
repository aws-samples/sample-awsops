import { describe, it, expect } from 'vitest';
import { isComposingKey } from './ime';

describe('isComposingKey', () => {
  it('is true when the native event is composing', () => {
    expect(isComposingKey({ nativeEvent: { isComposing: true }, keyCode: 13 })).toBe(true);
  });
  it('is true for keyCode 229', () => {
    expect(isComposingKey({ nativeEvent: { isComposing: false }, keyCode: 229 })).toBe(true);
  });
  it('is false for a plain Enter', () => {
    expect(isComposingKey({ nativeEvent: { isComposing: false }, keyCode: 13 })).toBe(false);
    expect(isComposingKey({})).toBe(false);
  });
});
