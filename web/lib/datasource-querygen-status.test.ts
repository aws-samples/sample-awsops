import { describe, expect, it, vi } from 'vitest';
import { generateQuery } from './datasource-querygen';

const attributes = [
  { name: 'span.http.status_code', types: ['int'], typesTruncated: false },
  { name: 'span.region', types: ['string'], typesTruncated: false },
  { name: 'span.customResponseCode', types: ['int'], typesTruncated: false },
];

describe('Tempo requested-status retention', () => {
  it.each([
    '{ span.http.status_code = 404 && span.region = "us" }',
    '{ span.region = "us" && status = error }',
    '{ span.http.status_code = 500 || span.region = "us" }',
    '{ span.customResponseCode = 500 || span.region = "us" }',
    '{ span.customResponseCode = 500 } || {}',
    '{ !(span.http.status_code = 500) }',
    '{ span.http.status_code = 404 && span.customResponseCode = 500 }',
    '{ span.http.status_code != 500 && span.customResponseCode = 500 }',
    '{ (span.http.status_code = 404 || span.region = "us") && span.customResponseCode = 500 }',
  ])('repairs a draft that does not retain the status on every result branch: %s', async draft => {
    const send = vi.fn().mockResolvedValueOnce(draft)
      .mockResolvedValueOnce('{ span.http.status_code = 500 }');
    expect(await generateQuery({
      nl: 'HTTP 500', lang: 'TraceQL', schemaBlock: 'observed',
      tempoAttributes: attributes, isSql: false, send,
    })).toEqual({ query: '{ span.http.status_code = 500 }' });
    expect(send).toHaveBeenCalledTimes(2);
  });

  it.each([
    '{ span.customResponseCode = 500 }',
    '{ span.customResponseCode = 500 && span.region = "us" }',
    '{ span.region = "us" } && { span.customResponseCode = 500 }',
    '{ span.http.status_code = 500 || span.customResponseCode = 500 }',
    '{ span.http.status_code = 404 } && { span.customResponseCode = 500 }',
    '{ span.customResponseCode = 500 && (span.http.status_code = 500 || span.region = "us") }',
    // Explicit grouping keeps the unary node separate in the pinned editor grammar.
    '{ (!(status = ok)) && span.http.status_code = 500 }',
    '{ (!(status = ok)) && span.customResponseCode = 500 }',
  ])('accepts a required matching value while leaving custom-field meaning for review: %s', async draft => {
    const send = vi.fn().mockResolvedValue(draft);
    expect(await generateQuery({
      nl: 'HTTP 500', lang: 'TraceQL', schemaBlock: 'observed',
      tempoAttributes: attributes, isSql: false, send,
    })).toEqual({ query: draft });
    expect(send).toHaveBeenCalledTimes(1);
  });

  it.each(['{ status = error }', '{}', '{ span.customResponseCode = 404 }'])(
    'gives schema guidance instead of a substitute when standard keys are unavailable: %s',
    async draft => {
      const send = vi.fn().mockResolvedValue(draft);
      await expect(generateQuery({
        nl: 'HTTP 500', lang: 'TraceQL', schemaBlock: 'observed customResponseCode',
        tempoAttributes: [attributes[2]], isSql: false, send,
      })).rejects.toThrow(/schema.*manual|manual.*schema/i);
      expect(send).toHaveBeenCalledTimes(1);
    },
  );

  it.each([
    ['HTTP 500 yesterday', '{ status = error }'],
    ['yesterday HTTP 500', '{}'],
    ['HTTP 500 어제', '{ status = error }'],
    ['어제 HTTP 500', '{}'],
  ])('keeps empty-cache historical guidance for %s', async (nl, draft) => {
    const send = vi.fn().mockResolvedValue(draft);
    await expect(generateQuery({
      nl, lang: 'TraceQL', schemaBlock: '', tempoAttributes: [],
      tempoSchemaEmpty: true, isSql: false, send,
    })).rejects.toThrow(/no usable attributes.*historical.*Grafana/i);
    expect(send).toHaveBeenCalledTimes(1);
  });

  it.each(['no HTTP 500 yesterday', 'HTTP 500 제외 어제', 'excluding HTTP 500 today'])(
    'does not reinterpret temporal exclusions as positive requests: %s', async nl => {
      const draft = '{ span.http.status_code != 500 }';
      const send = vi.fn().mockResolvedValue(draft);
      expect(await generateQuery({
        nl, lang: 'TraceQL', schemaBlock: 'observed',
        tempoAttributes: attributes, isSql: false, send,
      })).toEqual({ query: draft });
      expect(send).toHaveBeenCalledTimes(1);
    },
  );
});
