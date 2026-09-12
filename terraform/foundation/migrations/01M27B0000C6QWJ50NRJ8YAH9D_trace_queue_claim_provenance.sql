-- since: 0.9.0
-- Queue destinations in trace graphs are telemetry claims, never verified AWS inventory.
-- Preserve the existing view columns/grants and named-key projection. Cover retained
-- snapshots by deriving claims only from destination ARN qualifiers, never reporter keys
-- or stored claim fields. Non-ARN/malformed destinations have no account/region claim.
CREATE OR REPLACE VIEW sql_reader.topology_nodes
WITH (security_invoker = false) AS
SELECT account_id, id, kind, label, run_id, captured_at, class,
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
  ) ELSE '{}'::jsonb END AS meta
FROM public.topology_nodes
LEFT JOIN LATERAL regexp_match(
  CASE WHEN class = 'trace' AND kind = 'queue' AND jsonb_typeof(meta->'destination') = 'string'
    THEN btrim(meta->>'destination', E' \t\n\r\f\013') END,
  '^arn:[a-z0-9-]+:[a-z0-9-]+:([a-z0-9-]*):([0-9]{12}):[^[:space:]]+$'
) AS destination_arn(parts) ON true;

GRANT SELECT ON sql_reader.topology_nodes TO awsops_sql_reader;
