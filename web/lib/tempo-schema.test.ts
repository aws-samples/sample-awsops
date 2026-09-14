import { describe, expect, it } from 'vitest';
import { normalizeTempoSchema, tempoAttributeKey } from './tempo-schema';

describe('normalized Tempo observations', () => {
  it('distinguishes absent, malformed, and confirmed-empty metadata', () => {
    expect(normalizeTempoSchema({})).toMatchObject({ hasShape: false, incomplete: true });
    expect(normalizeTempoSchema({ attributes: [null, { name: 5 }] })).toMatchObject({ incomplete: true });
    expect(normalizeTempoSchema({ attributes: [], tags: [] })).toMatchObject({ hasShape: true, incomplete: false });
  });
  it('does not fall back to legacy tags when the structured custom list is explicitly empty', () => {
    expect(normalizeTempoSchema({ attributes: [], tags: ['duration'] }).attributes).toEqual([]);
  });
  it('preserves raw legacy names that happen to match intrinsic names', () => {
    expect(normalizeTempoSchema({ tags: ['duration', 'status'] }).attributes.map(a => a.name))
      .toEqual(['.duration', '.status']);
  });
  it('drops old cached intrinsic entries but preserves scoped custom keys', () => {
    expect(normalizeTempoSchema({ attributes: [
      { name: 'duration' }, { name: 'link:traceID' }, { name: 'span.duration', types: ['int'] },
    ] }).attributes).toEqual([{ name: 'span.duration', types: ['int'], typesTruncated: false }]);
  });
  it('canonicalizes quoted identifiers without losing Unicode or changing scope', () => {
    expect(tempoAttributeKey('span."http.status_code"')).toBe(tempoAttributeKey('span.http.status_code'));
    expect(tempoAttributeKey('span."서비스 이름"')).toBe('["span","서비스 이름"]');
    expect(tempoAttributeKey('.http.status_code')).not.toBe(tempoAttributeKey('span.http.status_code'));
  });
  it('marks unknown type evidence incomplete instead of printing untrusted type strings', () => {
    expect(normalizeTempoSchema({ attributes: [{ name: 'span.code', types: ['int', 'not-a-type'] }] }).attributes)
      .toEqual([{ name: 'span.code', types: ['int'], typesTruncated: true }]);
  });
});
