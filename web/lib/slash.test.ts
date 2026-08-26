import { describe, it, expect } from 'vitest';
import { parseSlash, matchCommands } from './slash';

describe('parseSlash', () => {
  it('routes a leading /section command, body verbatim', () => {
    expect(parseSlash('/cost foo')).toEqual({ section: 'cost', prompt: 'foo' });
  });
  it('consumes exactly one separator and keeps the rest verbatim', () => {
    expect(parseSlash('/cost   foo')).toEqual({ section: 'cost', prompt: '  foo' });
    expect(parseSlash('/cost\nfoo')).toEqual({ section: 'cost', prompt: 'foo' });
  });
  it('command with no body → empty prompt (chip-then-wait)', () => {
    expect(parseSlash('/network')).toEqual({ section: 'network', prompt: '' });
  });
  it('/auto maps to null section (explicit auto)', () => {
    expect(parseSlash('/auto x')).toEqual({ section: null, prompt: 'x' });
  });
  it('unknown command → literal passthrough', () => {
    expect(parseSlash('/bogus x')).toEqual({ section: null, prompt: '/bogus x' });
  });
  it('no separator (/costfoo) → literal', () => {
    expect(parseSlash('/costfoo')).toEqual({ section: null, prompt: '/costfoo' });
  });
  it('leading whitespace before slash → literal (not a command)', () => {
    expect(parseSlash('  /cost x')).toEqual({ section: null, prompt: '  /cost x' });
  });
  it('mid-text slash → literal', () => {
    expect(parseSlash('a /cost')).toEqual({ section: null, prompt: 'a /cost' });
  });
  it('plain text → auto', () => {
    expect(parseSlash('hello')).toEqual({ section: null, prompt: 'hello' });
  });
});

describe('matchCommands', () => {
  it('prefix-filters by key', () => {
    const keys = matchCommands('co').map((c) => c.key);
    expect(keys).toContain('container');
    expect(keys).toContain('cost');
  });
  it('empty fragment returns all incl. auto', () => {
    const keys = matchCommands('').map((c) => c.key);
    expect(keys).toContain('auto');
    expect(keys).toContain('network');
  });
  it('commands carry label/icon/active', () => {
    const cost = matchCommands('cost')[0];
    expect(cost).toMatchObject({ key: 'cost', active: true });
    expect(typeof cost.label).toBe('string');
    expect(typeof cost.icon).toBe('string');
  });
});
