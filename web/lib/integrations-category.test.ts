import { describe, it, expect } from 'vitest';
import {
  integrationCategory,
  isDatasourceKind,
  DATASOURCE_KINDS,
} from './integrations-category';

describe('DATASOURCE_KINDS', () => {
  it('is exactly the 8 query-language observability kinds', () => {
    expect([...DATASOURCE_KINDS].sort()).toEqual(
      ['clickhouse', 'datadog', 'dynatrace', 'jaeger', 'loki', 'mimir', 'prometheus', 'tempo'].sort(),
    );
  });
});

describe('isDatasourceKind', () => {
  it('is true for each datasource kind', () => {
    for (const k of DATASOURCE_KINDS) expect(isDatasourceKind(k)).toBe(true);
  });
  it('is false for connector / non-datasource kinds', () => {
    for (const k of ['notion', 'slack', 'jira', 'grafana', 'github', 'pagerduty', '']) {
      expect(isDatasourceKind(k)).toBe(false);
    }
  });
});

describe('integrationCategory', () => {
  it("classifies egress+read observability kinds as 'datasource'", () => {
    for (const kind of DATASOURCE_KINDS) {
      expect(integrationCategory({ kind, direction: 'egress', capability: 'read' })).toBe('datasource');
    }
  });

  it("classifies Notion (egress+read, non-query kind) as 'connector'", () => {
    expect(integrationCategory({ kind: 'notion', direction: 'egress', capability: 'read' })).toBe('connector');
  });

  it("classifies a datasource kind as 'connector' when it is NOT egress+read", () => {
    // read_write or ingress disqualifies it from the datasource (read-only query) category
    expect(integrationCategory({ kind: 'prometheus', direction: 'egress', capability: 'read_write' })).toBe('connector');
    expect(integrationCategory({ kind: 'prometheus', direction: 'ingress', capability: 'read' })).toBe('connector');
  });

  it("classifies ingress webhook sources as 'connector'", () => {
    expect(integrationCategory({ kind: 'pagerduty', direction: 'ingress', capability: 'read' })).toBe('connector');
  });
});
