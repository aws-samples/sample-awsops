// web/lib/integration-validation.ts
// ADR-039 P2 — pure validation for admin-registered integrations (egress connectors + ingress sources).
// SOURCE OF TRUTH: INTEGRATION_KINDS_EGRESS / INTEGRATION_KINDS_INGRESS / INTEGRATION_TRANSPORTS are
// shared with the migration's integrations_kind_check / transport CHECK
// (01KV0JKFF7Q28CMKQ2JGM2D1NK_integrations_p2.sql, 01KTY39P4S…_p1.sql) — keep in sync.
// The trailing 4 (clickhouse/mimir/loki/tempo) are the datasource (egress READ query) kinds, added by
// 01KVB3MDTRVQW4MMC4GBVS6PPR_datasource_instances_additive.sql; kept in lockstep with
// integrations-category.ts DATASOURCE_KINDS (see integration-validation.test.ts).
export const INTEGRATION_KINDS_EGRESS = ['grafana', 'datadog', 'splunk', 'prometheus', 'newrelic', 'notion', 'confluence', 'jira', 'servicenow', 'slack', 'github', 'gitlab', 'custom_mcp', 'clickhouse', 'mimir', 'loki', 'tempo', 'jaeger', 'dynatrace'] as const;
export const INTEGRATION_KINDS_INGRESS = ['cloudwatch_sns', 'alertmanager', 'grafana_alert', 'pagerduty', 'datadog_monitor', 'generic_webhook'] as const;
export const INTEGRATION_TRANSPORTS = ['sigv4', 'oauth_client_credentials', 'oauth_3lo', 'api_key'] as const;
export const INTEGRATION_DIRECTIONS = ['egress', 'ingress'] as const;
export const INTEGRATION_CAPABILITIES = ['read', 'read_write'] as const;
export const INGRESS_TRIGGER_TARGETS = ['incident'] as const;

const NAME_RE = /^[a-z0-9][a-z0-9-]{1,63}$/;

export interface ValidationResult { ok: boolean; errors: string[]; }

function isHttpsUrl(s: string): boolean {
  try { return new URL(s).protocol === 'https:'; } catch { return false; }
}

export function validateIntegration(i: {
  name?: string; kind?: string; direction?: string; capability?: string; endpoint?: string;
  transport?: string; authMode?: string; credentialsRef?: string; triggerTarget?: string;
}): ValidationResult {
  const errors: string[] = [];
  if (!i.name || !NAME_RE.test(i.name)) errors.push('name must be kebab-case, 2-64 chars');
  if (!(INTEGRATION_DIRECTIONS as readonly string[]).includes(i.direction ?? '')) {
    errors.push(`direction must be one of ${INTEGRATION_DIRECTIONS.join(', ')}`);
  }
  // kind must match the direction's set (mirrors the migration's conditional kind CHECK)
  if (i.direction === 'egress') {
    if (!(INTEGRATION_KINDS_EGRESS as readonly string[]).includes(i.kind ?? '')) errors.push(`egress kind must be one of ${INTEGRATION_KINDS_EGRESS.join(', ')}`);
  } else if (i.direction === 'ingress') {
    if (!(INTEGRATION_KINDS_INGRESS as readonly string[]).includes(i.kind ?? '')) errors.push(`ingress kind must be one of ${INTEGRATION_KINDS_INGRESS.join(', ')}`);
  }
  if (i.capability !== undefined && !(INTEGRATION_CAPABILITIES as readonly string[]).includes(i.capability)) {
    errors.push(`capability must be one of ${INTEGRATION_CAPABILITIES.join(', ')}`);
  }
  if (i.direction === 'egress') {
    if (!i.endpoint || !isHttpsUrl(i.endpoint)) errors.push('egress requires a valid https endpoint URL');
    if (!(INTEGRATION_TRANSPORTS as readonly string[]).includes(i.transport ?? '')) errors.push(`egress transport must be one of ${INTEGRATION_TRANSPORTS.join(', ')}`);
  }
  if (i.direction === 'ingress') {
    if (!i.authMode || !i.authMode.trim()) errors.push('ingress requires an auth_mode');
    if (i.triggerTarget !== undefined && !(INGRESS_TRIGGER_TARGETS as readonly string[]).includes(i.triggerTarget)) errors.push(`triggerTarget must be one of ${INGRESS_TRIGGER_TARGETS.join(', ')}`);
  }
  // credentialsRef is optional at P2 registration (the Secrets Manager write is P2-infra); if present it
  // must be a Secrets-Manager ARN or a non-empty string.
  if (i.credentialsRef !== undefined) {
    const ok = typeof i.credentialsRef === 'string' && i.credentialsRef.trim().length > 0 &&
      (/^arn:aws:secretsmanager:/.test(i.credentialsRef) || i.credentialsRef.trim().length > 0);
    if (!ok) errors.push('credentialsRef must be a non-empty string (Secrets Manager ARN recommended)');
  }
  return { ok: errors.length === 0, errors };
}
