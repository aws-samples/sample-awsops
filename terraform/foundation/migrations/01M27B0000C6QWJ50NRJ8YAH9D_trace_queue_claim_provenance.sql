-- since: 0.9.0
-- Queue destinations in trace graphs are telemetry claims, never verified AWS inventory.
-- Preserve the existing view columns/grants and named-key projection. Cover retained
-- snapshots with legacy accountId/region keys without changing historical migrations.
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
    'claimedAccountId', CASE
      WHEN jsonb_typeof(meta->'claimedAccountId') = 'string' AND meta->>'claimedAccountId' <> ''
        THEN meta->'claimedAccountId'
      WHEN jsonb_typeof(meta->'accountId') = 'string' AND meta->>'accountId' <> ''
        THEN meta->'accountId' END,
    'claimedRegion', CASE
      WHEN jsonb_typeof(meta->'claimedRegion') = 'string' AND meta->>'claimedRegion' <> ''
        THEN meta->'claimedRegion'
      WHEN jsonb_typeof(meta->'region') = 'string' AND meta->>'region' <> ''
        THEN meta->'region' END
  ) ELSE '{}'::jsonb END AS meta
FROM public.topology_nodes;
