import { describe, it, expect } from 'vitest';
import { cn } from './cn';

describe('cn', () => {
  it('joins multiple classes', () => {
    expect(cn('a', 'b', 'c')).toBe('a b c');
  });

  it('drops falsy values', () => {
    expect(cn('a', false, null, undefined, '', 'b')).toBe('a b');
  });

  it('supports conditional object syntax', () => {
    expect(cn('base', { active: true, hidden: false })).toBe('base active');
  });

  it('merges tailwind conflicts — later class wins', () => {
    expect(cn('px-2', 'px-4')).toBe('px-4');
    expect(cn('text-ink-500', 'text-claude-700')).toBe('text-claude-700');
  });

  it('keeps non-conflicting tailwind classes', () => {
    expect(cn('bg-white', 'text-ink-800', 'rounded-lg')).toBe('bg-white text-ink-800 rounded-lg');
  });
});
