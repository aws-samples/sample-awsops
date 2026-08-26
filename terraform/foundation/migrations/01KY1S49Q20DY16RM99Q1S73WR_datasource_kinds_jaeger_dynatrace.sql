-- v1 datasource-family completion: allow 'jaeger' and 'dynatrace' as egress integration kinds
-- ('datadog' was already in the egress set from the connectors era — it now also acts as a
-- query-language datasource kind, which needs no DB change).
-- DROP IF EXISTS + unconditional ADD is idempotent; the new set is a SUPERSET so existing rows
-- still satisfy it. BOTH branches reproduced verbatim (ingress unchanged).
-- SOURCE OF TRUTH: mirror of web/lib/integration-validation.ts INTEGRATION_KINDS_EGRESS.
ALTER TABLE integrations DROP CONSTRAINT IF EXISTS integrations_kind_check;
ALTER TABLE integrations ADD CONSTRAINT integrations_kind_check CHECK (
  (direction = 'egress'  AND kind IN ('grafana','datadog','splunk','prometheus','newrelic','notion','confluence','jira','servicenow','slack','github','gitlab','custom_mcp','clickhouse','mimir','loki','tempo','jaeger','dynatrace'))
  OR
  (direction = 'ingress' AND kind IN ('cloudwatch_sns','alertmanager','grafana_alert','pagerduty','datadog_monitor','generic_webhook'))
);
