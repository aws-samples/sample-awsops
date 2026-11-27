-- since: 0.10.1
-- Extend view-only trace evidence to runtime/model claims. No base-table grant.
-- Queue and non-claim projections retain their existing contract.
CREATE OR REPLACE VIEW sql_reader.topology_nodes
WITH (security_invoker = false) AS
SELECT account_id, id, kind, label, run_id, captured_at, class,
  CASE WHEN class = 'trace' AND kind IN ('runtime', 'model') THEN
    coalesce((
      SELECT jsonb_object_agg(k, v)
      FROM jsonb_each(CASE WHEN jsonb_typeof(meta) = 'object' THEN meta ELSE '{}'::jsonb END) AS fields(k, v)
      WHERE (
        jsonb_typeof(v) = 'string' AND (
          (k IN ('sourceId', 'environment') AND length(v #>> '{}') <= 512)
          OR (kind = 'runtime' AND k = 'arn' AND length(v #>> '{}') <= 512)
          OR (kind = 'model' AND (
            (k = 'provider' AND length(v #>> '{}') <= 64)
            OR (k = 'model' AND length(v #>> '{}') <= 256)
            OR (k = 'endpoint' AND length(v #>> '{}') <= 253)
          ))
        )
      ) OR (
        kind = 'model' AND k = 'port' AND
        CASE WHEN jsonb_typeof(v) = 'number' THEN
          (v #>> '{}')::numeric BETWEEN 1 AND 65535
          AND (v #>> '{}')::numeric = trunc((v #>> '{}')::numeric)
        ELSE false END
      )
    ), '{}'::jsonb)
    || jsonb_build_object(
      'identityProvenance', 'telemetry_claim',
      'claimedAccountId', runtime_arn.parts[2],
      'claimedRegion', runtime_arn.parts[1]
    )
  ELSE
    coalesce((
      SELECT jsonb_object_agg(k, v) FROM jsonb_each(meta) AS fields(k, v)
      WHERE (
        k = ANY(ARRAY['invType','targetType','recordType','service','bucket','domain',
          'unresolved','resolvedTarget','ecsService','task','cluster','groupLabel','members',
          'aliases','port','health'])
        OR (k = ANY(ARRAY['sourceId','accountId','region','environment','serviceNamespace',
          'namespace','deployment','system','host','dbName','infra_ref','destination','broker'])
          AND jsonb_typeof(v) = 'string')
        OR (k = ANY(ARRAY['spanCount','errorSpanCount','unknownStatusSpanCount','sampledDurationMs'])
          AND jsonb_typeof(v) = 'number')
      ) AND NOT (class = 'trace' AND kind = 'queue'
        AND k = ANY(ARRAY['accountId','region','infra_ref']))
    ), '{}'::jsonb)
    || CASE WHEN class = 'trace' AND kind = 'queue' THEN jsonb_build_object(
      'identityProvenance', 'telemetry_claim',
      'claimedAccountId', destination_arn.parts[2],
      'claimedRegion', nullif(destination_arn.parts[1], '')
    ) ELSE '{}'::jsonb END
  END AS meta
FROM public.topology_nodes
LEFT JOIN LATERAL regexp_match(
  CASE WHEN class = 'trace' AND kind = 'queue' AND jsonb_typeof(meta->'destination') = 'string'
    THEN btrim(meta->>'destination', E' \t\n\r\f\013') END,
  '^arn:[a-z0-9-]+:[a-z0-9-]+:([a-z0-9-]*):([0-9]{12}):[^[:space:]]+$'
) AS destination_arn(parts) ON true
LEFT JOIN LATERAL regexp_match(
  CASE WHEN class = 'trace' AND kind = 'runtime' AND jsonb_typeof(meta->'arn') = 'string'
    AND length(meta->>'arn') <= 512 AND meta->>'arn' !~ '[[:space:]]' THEN meta->>'arn' END,
  '^arn:aws(?:-[a-z0-9-]+)?:bedrock-agentcore:([a-z]{2,8}(?:-[a-z0-9]+)+-[0-9]+):([0-9]{12}):runtime/[A-Za-z0-9_][A-Za-z0-9_-]{0,255}$'
) AS runtime_arn(parts) ON true;

GRANT SELECT ON sql_reader.topology_nodes TO awsops_sql_reader;
