import { describe, it, expect } from 'vitest';
import { EXAMPLE_QUERIES, AI_EXAMPLES, QUERY_LANGUAGE } from './example-queries';

const KINDS = ['prometheus', 'mimir', 'loki', 'tempo', 'clickhouse', 'jaeger', 'dynatrace', 'datadog'];

describe('example-queries catalog', () => {
  it('covers all 8 connector kinds with 4 raw examples each', () => {
    for (const k of KINDS) {
      expect(EXAMPLE_QUERIES[k], k).toBeDefined();
      expect(EXAMPLE_QUERIES[k]).toHaveLength(4);
      for (const e of EXAMPLE_QUERIES[k]) {
        expect(e.label.trim()).not.toBe('');
        expect(e.expr.trim()).not.toBe('');
      }
    }
  });

  it('covers all 8 kinds with 4 NL prompts each', () => {
    for (const k of KINDS) {
      expect(AI_EXAMPLES[k], k).toBeDefined();
      expect(AI_EXAMPLES[k]).toHaveLength(4);
      for (const p of AI_EXAMPLES[k]) expect(p.trim()).not.toBe('');
    }
  });

  it('keeps the clickhouse raw chips connector-safe and schema-agnostic', () => {
    // The clickhouse connector blocks `system.` as a DANGER token for user queries, and the
    // otel table name is deployment-specific — neither may appear in a curated chip.
    expect(EXAMPLE_QUERIES.clickhouse.some((e) => /system\./i.test(e.expr))).toBe(false);
    expect(EXAMPLE_QUERIES.clickhouse.some((e) => /otel_traces/.test(e.expr))).toBe(false);
  });

  it('maps every kind to a query language name', () => {
    for (const k of KINDS) expect(QUERY_LANGUAGE[k], k).toBeTruthy();
    expect(QUERY_LANGUAGE.prometheus).toBe('PromQL');
    expect(QUERY_LANGUAGE.loki).toBe('LogQL');
    expect(QUERY_LANGUAGE.tempo).toBe('TraceQL');
    expect(QUERY_LANGUAGE.clickhouse).toBe('SQL');
  });
});
