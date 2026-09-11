-- since: 0.9.0
-- Collection evidence for trace graphs, including empty and retained snapshots.
-- Application data only: no AWS resource mutation and no historical migration changes.
CREATE TABLE IF NOT EXISTS topology_graph_state (
  account_id text NOT NULL,
  class text NOT NULL CHECK (class IN ('flow', 'infra', 'trace')),
  status text NOT NULL CHECK (status IN ('ok', 'empty', 'partial', 'unavailable', 'error')),
  attempted_at timestamptz NOT NULL,
  captured_at timestamptz,
  details jsonb NOT NULL DEFAULT '{}'::jsonb,
  PRIMARY KEY (account_id, class)
);

ALTER TABLE topology_edges ADD COLUMN IF NOT EXISTS meta jsonb NOT NULL DEFAULT '{}'::jsonb;

GRANT SELECT, INSERT, UPDATE, DELETE ON topology_graph_state TO awsops_web, awsops_worker;

-- Model-invocable SQL remains view-only. Expose collection quality so retained/partial
-- topology cannot be mistaken for current, complete observations. Never expose raw details.
REVOKE ALL ON public.topology_graph_state FROM awsops_sql_reader;

CREATE OR REPLACE VIEW sql_reader.topology_graph_state
WITH (security_invoker = false) AS
SELECT account_id, class, status, attempted_at, captured_at,
  (
    SELECT coalesce(jsonb_object_agg(k, v), '{}'::jsonb)
    FROM jsonb_each(details) AS fields(k, v)
    WHERE (k = ANY(ARRAY['windowStartMs','windowEndMs','nodeDrops','edgeDrops',
                        'orphanSpans','invalidSpans','unresolvedMessaging'])
           AND jsonb_typeof(v) = 'number')
       OR (k = ANY(ARRAY['retainedPrevious','infraUnavailable']) AND jsonb_typeof(v) = 'boolean')
  ) || jsonb_build_object('sources', (
    SELECT coalesce(jsonb_agg(
      (SELECT coalesce(jsonb_object_agg(k, v), '{}'::jsonb)
       FROM jsonb_each(source) AS fields(k, v)
       WHERE (k = ANY(ARRAY['sourceId','status']) AND jsonb_typeof(v) = 'string')
          OR (k = ANY(ARRAY['itemCount','windowStartMs','windowEndMs']) AND jsonb_typeof(v) = 'number'))
      || jsonb_build_object('reasons', (
        SELECT coalesce(jsonb_agg(reason), '[]'::jsonb)
        FROM jsonb_array_elements_text(
          CASE WHEN jsonb_typeof(source->'reasons') = 'array' THEN source->'reasons' ELSE '[]'::jsonb END
        ) AS reasons(reason)
        WHERE reason = ANY(ARRAY['missing_configuration','configuration_failed','query_failed',
          'malformed_payload','malformed_rows','payload_truncated','trace_fetch_failed',
          'cap_reached','invalid_request','source_failed','registry_read_failed'])
      ))
    ), '[]'::jsonb)
    FROM jsonb_array_elements(
      CASE WHEN jsonb_typeof(details->'sources') = 'array' THEN details->'sources' ELSE '[]'::jsonb END
    ) AS sources(source)
    WHERE jsonb_typeof(source) = 'object'
  )) AS details
FROM public.topology_graph_state;

CREATE OR REPLACE VIEW sql_reader.topology_edges
WITH (security_invoker = false) AS
SELECT id, account_id, source, target, rel, confidence, run_id, captured_at, class,
  jsonb_build_object(
    'spanCount', CASE WHEN jsonb_typeof(meta->'spanCount') = 'number' THEN meta->'spanCount' END,
    'metricCount', CASE WHEN jsonb_typeof(meta->'metricCount') = 'number' THEN meta->'metricCount' END
  ) AS meta
FROM public.topology_edges;

-- Preserve the existing projection and add the scalar identity/evidence fields actually
-- consumed by get_topology. Provider row copies and arbitrary nested payloads remain hidden.
CREATE OR REPLACE VIEW sql_reader.topology_nodes
WITH (security_invoker = false) AS
SELECT account_id, id, kind, label, run_id, captured_at, class,
  (SELECT jsonb_object_agg(k, v) FROM jsonb_each(meta) AS fields(k, v)
   WHERE k = ANY(ARRAY['invType','targetType','recordType','service','bucket','domain',
     'unresolved','resolvedTarget','ecsService','task','cluster','groupLabel','members',
     'aliases','port','health'])
     OR (k = ANY(ARRAY['sourceId','accountId','region','environment','serviceNamespace',
       'namespace','deployment','system','host','dbName','infra_ref','destination','broker'])
       AND jsonb_typeof(v) = 'string')
     OR (k = ANY(ARRAY['spanCount','errorSpanCount','unknownStatusSpanCount','sampledDurationMs'])
       AND jsonb_typeof(v) = 'number')) AS meta
FROM public.topology_nodes;

GRANT SELECT ON sql_reader.topology_graph_state, sql_reader.topology_edges,
  sql_reader.topology_nodes TO awsops_sql_reader;
