-- since: 0.9.0
-- Add bounded inventory provenance to the EXISTING reader view. No base/public grants.
-- Old writers/readers remain valid; an old projection lacks publishedSources and is stale.
CREATE OR REPLACE VIEW sql_reader.topology_graph_state
WITH (security_invoker = false) AS
SELECT account_id, class, status, attempted_at, captured_at,
  (
    SELECT coalesce(jsonb_object_agg(k, v), '{}'::jsonb)
    FROM jsonb_each(CASE WHEN jsonb_typeof(details) = 'object' THEN details ELSE '{}'::jsonb END) AS fields(k, v)
    WHERE (k = ANY(ARRAY['windowStartMs','windowEndMs','nodeDrops','edgeDrops',
                        'orphanSpans','invalidSpans','unresolvedMessaging'])
           AND jsonb_typeof(v) = 'number')
       OR (k = ANY(ARRAY['retainedPrevious','infraUnavailable','inputTruncated','graphTruncated'])
           AND jsonb_typeof(v) = 'boolean')
       OR (k = 'failureReason' AND v #>> '{}' = ANY(ARRAY['publication_failed','source_read_failed']))
  ) || (
    SELECT jsonb_object_agg(name, sanitized)
    FROM (VALUES ('sources'), ('publishedSources')) AS arrays(name)
    CROSS JOIN LATERAL (
      SELECT coalesce(jsonb_agg(
        (SELECT coalesce(jsonb_object_agg(k, v), '{}'::jsonb)
         FROM jsonb_each(CASE WHEN jsonb_typeof(source) = 'object' THEN source ELSE '{}'::jsonb END) AS fields(k, v)
         WHERE (k = 'sourceId' AND jsonb_typeof(v) = 'string'
                AND v #>> '{}' ~ '^[A-Za-z0-9:_./-]{1,128}$')
            OR (k = 'status' AND v #>> '{}' = ANY(ARRAY['ok','empty','partial','error','unavailable','unknown']))
            OR (k = 'producerStatus' AND v #>> '{}' = ANY(ARRAY['succeeded','failed','partial','running','unknown']))
            OR (k = 'scope' AND v #>> '{}' = ANY(ARRAY['aggregate','account']))
            OR (k = ANY(ARRAY['itemCount','windowStartMs','windowEndMs',
                             'capturedAtMs','lastSuccessAtMs','attemptedAtMs','finishedAtMs'])
                AND CASE WHEN jsonb_typeof(v) = 'number'
                     THEN (v #>> '{}')::numeric BETWEEN 0 AND 8640000000000000 ELSE false END))
        || jsonb_build_object('reasons', (
          SELECT coalesce(jsonb_agg(reason), '[]'::jsonb)
          FROM (
            SELECT DISTINCT reason
            FROM jsonb_array_elements_text(
              CASE WHEN jsonb_typeof(source->'reasons') = 'array' THEN source->'reasons' ELSE '[]'::jsonb END
            ) AS reasons(reason)
            WHERE reason = ANY(ARRAY['missing_configuration','configuration_failed','query_failed',
              'malformed_payload','malformed_rows','payload_truncated','trace_fetch_failed',
              'cap_reached','invalid_request','source_failed','registry_read_failed',
              'missing_ledger','incomplete_collection','unknown_attributes','unknown_capture',
              'unknown_account_coverage','empty_not_confirmed'])
            ORDER BY reason LIMIT 16
          ) AS allowed_reasons
        )) ORDER BY ordinal
      ), '[]'::jsonb) AS sanitized
      FROM jsonb_array_elements(
        CASE WHEN jsonb_typeof(details->name) = 'array' THEN details->name ELSE '[]'::jsonb END
      ) WITH ORDINALITY AS sources(source, ordinal)
      WHERE ordinal <= 128 AND jsonb_typeof(source) = 'object'
    ) AS projection
    WHERE name = 'sources' OR jsonb_typeof(details->name) = 'array'
  ) AS details
FROM public.topology_graph_state;
