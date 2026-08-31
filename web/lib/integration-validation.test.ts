// web/lib/integration-validation.test.ts
import { readFileSync } from 'node:fs';
import { describe, it, expect } from 'vitest';
import {
  validateIntegration, INTEGRATION_KINDS_EGRESS, INTEGRATION_KINDS_INGRESS, INTEGRATION_TRANSPORTS,
} from './integration-validation';
import { DATASOURCE_KINDS } from './integrations-category';

const egress = { name: 'grafana-ro', kind: 'grafana', direction: 'egress', capability: 'read', endpoint: 'https://g.example/api', transport: 'api_key' };
const ingress = { name: 'pd-in', kind: 'pagerduty', direction: 'ingress', authMode: 'vendor_sig', triggerTarget: 'incident' };

describe('integration-validation', () => {
  it('exposes the kind/transport sets (source of truth shared with the migration)', () => {
    expect(INTEGRATION_KINDS_EGRESS).toContain('grafana');
    expect(INTEGRATION_KINDS_INGRESS).toContain('cloudwatch_sns');
    expect([...INTEGRATION_TRANSPORTS]).toEqual(['sigv4', 'oauth_client_credentials', 'oauth_3lo', 'api_key']);
  });

  it('accepts a well-formed egress and ingress integration', () => {
    expect(validateIntegration(egress).ok).toBe(true);
    expect(validateIntegration(ingress).ok).toBe(true);
  });

  it('rejects an egress row carrying an ingress kind (direction-conditional kind)', () => {
    expect(validateIntegration({ ...egress, kind: 'generic_webhook' }).ok).toBe(false);
    expect(validateIntegration({ ...ingress, kind: 'grafana' }).ok).toBe(false);
  });

  it('rejects bad name / unknown direction / bad capability', () => {
    expect(validateIntegration({ ...egress, name: 'Bad Name' }).ok).toBe(false);
    expect(validateIntegration({ ...egress, direction: 'sideways' }).ok).toBe(false);
    expect(validateIntegration({ ...egress, capability: 'admin' }).ok).toBe(false);
  });

  it('egress requires a valid https endpoint + known transport', () => {
    expect(validateIntegration({ ...egress, endpoint: 'http://g.example' }).ok).toBe(false); // not https
    expect(validateIntegration({ ...egress, endpoint: undefined }).ok).toBe(false);
    expect(validateIntegration({ ...egress, transport: 'telnet' }).ok).toBe(false);
  });

  it('ingress requires auth_mode and a valid triggerTarget', () => {
    expect(validateIntegration({ ...ingress, authMode: undefined }).ok).toBe(false);
    expect(validateIntegration({ ...ingress, triggerTarget: 'nope' }).ok).toBe(false);
  });

  it('credentialsRef (when present) must be a non-empty string', () => {
    expect(validateIntegration({ ...egress, credentialsRef: '' }).ok).toBe(false);
    expect(validateIntegration({ ...egress, credentialsRef: 'arn:aws:secretsmanager:ap-northeast-2:1:secret:x' }).ok).toBe(true);
    expect(validateIntegration({ ...egress, credentialsRef: undefined }).ok).toBe(true); // optional
  });
});

// LOCKSTEP: the datasource kinds must agree across THREE source-of-truth surfaces —
// integrations-category.ts DATASOURCE_KINDS, this module's INTEGRATION_KINDS_EGRESS, and the
// migration's integrations_kind_check egress branch. Drift would let the DB CHECK reject a kind the
// API accepts (or vice versa).
describe('datasource-kind lockstep (category ↔ validation ↔ migration CHECK)', () => {
  const MIGRATION = new URL(
    '../../terraform/foundation/migrations/01KY1S49Q20DY16RM99Q1S73WR_datasource_kinds_jaeger_dynatrace.sql',
    import.meta.url,
  );
  const sql = readFileSync(MIGRATION, 'utf8');

  it('every DATASOURCE_KIND is in INTEGRATION_KINDS_EGRESS', () => {
    for (const k of DATASOURCE_KINDS) {
      expect(INTEGRATION_KINDS_EGRESS as readonly string[]).toContain(k);
    }
  });

  it('the 4 added kinds are present in INTEGRATION_KINDS_EGRESS', () => {
    for (const k of ['clickhouse', 'mimir', 'loki', 'tempo']) {
      expect(INTEGRATION_KINDS_EGRESS as readonly string[]).toContain(k);
    }
  });

  it("the migration's kind CHECK lists every datasource kind in the egress branch", () => {
    const egressBranch = sql.slice(sql.indexOf("direction = 'egress'"));
    for (const k of DATASOURCE_KINDS) {
      expect(egressBranch).toContain(`'${k}'`);
    }
    // and it must keep the ingress branch (re-adding the constraint must not drop webhooks)
    expect(sql).toContain("direction = 'ingress'");
  });
});
