import { describe, it, expect } from 'vitest';
import { compareValues } from './DataTable';

describe('DataTable compareValues — numeric-aware', () => {
  it('sorts numbers numerically, not lexically (123 > 23)', () => {
    expect(compareValues(123, 23, 'asc')).toBeGreaterThan(0); // 123 after 23 asc
    expect(compareValues('123', '23', 'asc')).toBeGreaterThan(0); // numeric strings too
    expect(compareValues(23, 123, 'asc')).toBeLessThan(0);
  });
  it('desc reverses numeric order', () => {
    expect(compareValues('123', '23', 'desc')).toBeLessThan(0); // 123 before 23 desc
  });
  it('sorts plain strings sensibly', () => {
    expect(compareValues('running', 'stopped', 'asc')).toBeLessThan(0);
  });
  it('natural-sorts mixed text+number (instance types / ids)', () => {
    expect(compareValues('t3.medium', 't3.micro', 'asc')).toBeLessThan(0);
  });
  it('puts empty/null values last regardless of direction', () => {
    expect(compareValues('', 'x', 'asc')).toBeGreaterThan(0);
    expect(compareValues(null, 5, 'desc')).toBeGreaterThan(0);
    expect(compareValues('x', '', 'asc')).toBeLessThan(0);
  });
});
