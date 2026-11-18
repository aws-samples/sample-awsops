-- since: 0.10.1
-- Additive host pilot. Explicit clocks/IDs come from the private publisher.
CREATE TABLE public.topology_source_batches (
  batch_id text PRIMARY KEY, scope_key text NOT NULL, source_id text NOT NULL,
  generation_key text, status text NOT NULL, captured_at timestamptz, attempted_at timestamptz,
  window_start timestamptz, window_end timestamptz, stale boolean NOT NULL,
  retained boolean NOT NULL, capped boolean NOT NULL, reasons text[] NOT NULL, CHECK (scope_key='self:all-regions:include-global')
);
CREATE TABLE public.service_topology_snapshots (
  snapshot_id uuid PRIMARY KEY, scope_key text NOT NULL, version smallint NOT NULL CHECK(version=1),
  built_at timestamptz NOT NULL, batch_ids text[] NOT NULL, gaps text[] NOT NULL, content_digest text NOT NULL,
  body_snapshot_id uuid REFERENCES public.service_topology_snapshots(snapshot_id),
  CHECK(scope_key='self:all-regions:include-global'), UNIQUE(scope_key,snapshot_id)
);
CREATE TABLE public.service_topology_entities (
  snapshot_id uuid NOT NULL REFERENCES public.service_topology_snapshots ON DELETE CASCADE,
  id text NOT NULL, kind text NOT NULL, label text NOT NULL, layers text[] NOT NULL,
  claim boolean NOT NULL, region text, source_id text, span_count bigint, known_status bigint,
  errors bigint, duration_sum_ms double precision, evidence_refs text[] NOT NULL, cluster text, namespace text, vpc text, owner_reason text, PRIMARY KEY(snapshot_id,id)
);
CREATE TABLE public.service_topology_relations (
  snapshot_id uuid NOT NULL REFERENCES public.service_topology_snapshots ON DELETE CASCADE,
  id text NOT NULL, source text NOT NULL, target text NOT NULL, kind text NOT NULL, layer text NOT NULL,
  confidence text NOT NULL, span_count bigint, metric_count double precision, evidence_refs text[] NOT NULL,
  PRIMARY KEY(snapshot_id,id),
  FOREIGN KEY(snapshot_id,source) REFERENCES public.service_topology_entities(snapshot_id,id),
  FOREIGN KEY(snapshot_id,target) REFERENCES public.service_topology_entities(snapshot_id,id)
);
CREATE INDEX service_topology_source_idx ON public.service_topology_relations(snapshot_id,source);
CREATE INDEX service_topology_target_idx ON public.service_topology_relations(snapshot_id,target);
CREATE TABLE public.service_topology_heads (
  scope_key text PRIMARY KEY, snapshot_id uuid NOT NULL, published_at timestamptz NOT NULL,
  FOREIGN KEY(scope_key,snapshot_id) REFERENCES public.service_topology_snapshots(scope_key,snapshot_id)
);

-- The inventory-read tool needs this narrowly scoped projection. Its Data API credential
-- is separate from the generic execute_sql principal. The role cannot log in until the
-- operator provisions its dedicated credential during pilot activation.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='awsops_topology_reader') THEN
    CREATE ROLE awsops_topology_reader NOLOGIN NOINHERIT;
  ELSIF EXISTS (SELECT 1 FROM pg_roles r WHERE r.rolname='awsops_topology_reader'
    AND (r.rolcanlogin OR r.rolsuper OR r.rolcreaterole OR r.rolcreatedb OR r.rolreplication OR r.rolbypassrls OR
         EXISTS (SELECT 1 FROM pg_auth_members m WHERE m.member=r.oid))) THEN
    RAISE EXCEPTION 'Unexpected privileged topology reader';
  END IF;
  IF pg_has_role('awsops_sql_reader','awsops_topology_reader','MEMBER') THEN
    RAISE EXCEPTION 'Generic SQL role must not inherit topology-reader privileges';
  END IF;
END $$;
ALTER ROLE awsops_topology_reader SET default_transaction_read_only=on;
ALTER ROLE awsops_topology_reader SET search_path=sql_reader,pg_catalog;

-- Legacy default grants give wide access to new public tables. Narrow all five here.
REVOKE ALL ON public.topology_source_batches, public.service_topology_snapshots,
 public.service_topology_entities, public.service_topology_relations, public.service_topology_heads
 FROM PUBLIC, awsops_sql_reader, awsops_web, awsops_worker;
GRANT SELECT, INSERT ON public.topology_source_batches, public.service_topology_snapshots,
 public.service_topology_entities, public.service_topology_relations TO awsops_worker;
GRANT SELECT, INSERT, UPDATE ON public.service_topology_heads TO awsops_worker;

CREATE VIEW sql_reader.service_topology_heads WITH (security_invoker=false) AS
 SELECT scope_key,snapshot_id,published_at FROM public.service_topology_heads;
CREATE VIEW sql_reader.service_topology_snapshots WITH (security_invoker=false) AS
 SELECT snapshot_id,scope_key,version,built_at,batch_ids,gaps,coalesce(body_snapshot_id,snapshot_id) AS body_id
 FROM public.service_topology_snapshots;
CREATE VIEW sql_reader.service_topology_sources WITH (security_invoker=false) AS
 SELECT batch_id,scope_key,source_id,generation_key,status,captured_at,attempted_at,
 window_start,window_end,stale,retained,capped,reasons FROM public.topology_source_batches;
CREATE VIEW sql_reader.service_topology_entities WITH (security_invoker=false) AS
 SELECT snapshot_id,id,kind,label,layers,claim,region,source_id,span_count,known_status,errors,duration_sum_ms,evidence_refs,cluster,namespace,vpc,owner_reason
 FROM public.service_topology_entities;
CREATE VIEW sql_reader.service_topology_relations WITH (security_invoker=false) AS
 SELECT snapshot_id,id,source,target,kind,layer,confidence,span_count,metric_count,evidence_refs
 FROM public.service_topology_relations;
REVOKE ALL ON sql_reader.service_topology_heads, sql_reader.service_topology_snapshots,
 sql_reader.service_topology_sources, sql_reader.service_topology_entities,
 sql_reader.service_topology_relations FROM PUBLIC, awsops_sql_reader;
GRANT USAGE ON SCHEMA sql_reader TO awsops_web, awsops_topology_reader;
GRANT SELECT ON sql_reader.service_topology_heads, sql_reader.service_topology_snapshots,
 sql_reader.service_topology_sources, sql_reader.service_topology_entities,
 sql_reader.service_topology_relations TO awsops_web, awsops_topology_reader;

-- Both the BFF and the Data API tool use this single-statement MVCC read.
CREATE OR REPLACE FUNCTION sql_reader.service_topology_read(p_snapshot uuid, p_lens text, p_search text,
 p_focus text, p_offset integer, p_max_age_minutes integer) RETURNS jsonb
LANGUAGE sql STABLE SECURITY INVOKER SET search_path=pg_catalog AS $$
WITH snap AS (
 SELECT s.* FROM sql_reader.service_topology_snapshots s
 WHERE scope_key='self:all-regions:include-global' AND snapshot_id=coalesce(p_snapshot,(
 SELECT h.snapshot_id FROM sql_reader.service_topology_heads h WHERE h.scope_key='self:all-regions:include-global'))
), links AS MATERIALIZED (
 SELECT r.* FROM sql_reader.service_topology_relations r JOIN snap s ON r.snapshot_id=s.body_id
 WHERE CASE p_lens WHEN 'service' THEN r.layer='trace' OR r.kind='member-of' WHEN 'entry' THEN r.layer='flow'
  WHEN 'placement' THEN r.layer IN ('infra','inventory') WHEN 'evidence' THEN true ELSE false END
), nodes AS MATERIALIZED (
 SELECT e.* FROM sql_reader.service_topology_entities e JOIN snap s ON e.snapshot_id=s.body_id
 WHERE CASE p_lens WHEN 'service' THEN 'trace'=ANY(e.layers) OR e.kind IN ('ecs_service','lambda')
  OR (p_focus<>'' AND EXISTS (SELECT 1 FROM links m WHERE m.kind='member-of' AND m.source=e.id AND m.target=p_focus))
  OR e.id IN (SELECT source FROM links WHERE kind IN ('instance-database','database-record')
              UNION ALL SELECT target FROM links WHERE kind IN ('instance-database','database-record'))
  WHEN 'entry' THEN 'flow'=ANY(e.layers) WHEN 'placement' THEN 'infra'=ANY(e.layers) OR 'inventory'=ANY(e.layers)
  WHEN 'evidence' THEN true ELSE false END
), eligible AS MATERIALIZED (
 SELECT n.* FROM nodes n WHERE (n.id=p_focus OR p_search='' OR strpos(lower(n.label),lower(p_search))>0 OR n.id=p_search)
 AND (p_focus='' OR n.id=p_focus OR EXISTS (SELECT 1 FROM links r
 WHERE (r.source=p_focus AND r.target=n.id) OR (r.target=p_focus AND r.source=n.id)))
), focus_row AS MATERIALIZED (
 SELECT * FROM eligible WHERE p_focus<>'' AND id=p_focus
), page_bounds AS (
 SELECT (200-count(*))::integer AS slots FROM focus_row
), neighbors AS MATERIALIZED (
 SELECT * FROM eligible WHERE p_focus='' OR id<>p_focus
 ORDER BY (kind='service') DESC,errors DESC NULLS LAST,label,id
 LIMIT (SELECT slots FROM page_bounds) OFFSET greatest(0,least(p_offset,20000))
), visible AS MATERIALIZED (
 SELECT * FROM focus_row UNION ALL SELECT * FROM neighbors
), all_edges AS MATERIALIZED (
 SELECT r.* FROM links r JOIN eligible a ON r.source=a.id JOIN eligible b ON r.target=b.id
), visible_edges AS (
 SELECT r.* FROM all_edges r JOIN visible a ON r.source=a.id JOIN visible b ON r.target=b.id ORDER BY r.id LIMIT 400
), src AS (
 SELECT b.*, (b.stale OR b.captured_at IS NULL OR b.captured_at>statement_timestamp()
  OR b.captured_at<statement_timestamp()-make_interval(mins=>greatest(1,least(p_max_age_minutes,2880)))) AS stale_now
 FROM sql_reader.service_topology_sources b JOIN snap s ON b.scope_key=s.scope_key AND b.batch_id=ANY(s.batch_ids)
), evidence AS (
 SELECT s.*, CASE
   WHEN cardinality(s.batch_ids)=0 THEN array_append(s.gaps,'manifest:empty_source_batches')
   WHEN cardinality(s.batch_ids)<>(SELECT count(*) FROM src) THEN array_append(s.gaps,'manifest:unresolved_source_batches')
   ELSE s.gaps END AS read_gaps
 FROM snap s
)
SELECT jsonb_build_object('contractVersion',1,'status',CASE WHEN cardinality(s.read_gaps)>0 OR EXISTS
 (SELECT 1 FROM src WHERE stale_now OR retained OR capped OR status NOT IN ('ok','empty')) THEN 'partial' ELSE 'ok' END,
 'selection',jsonb_build_object('status',CASE WHEN p_focus='' THEN 'unscoped'
   WHEN EXISTS(SELECT 1 FROM focus_row) THEN 'resolved' ELSE 'not_found' END,'requestedId',nullif(p_focus,'')),
 'snapshotId',s.snapshot_id,'builtAt',s.built_at,'lens',p_lens,'scope',jsonb_build_object('account','self','regions','__all__','includeGlobal',true),
 'sources',coalesce((SELECT jsonb_agg(jsonb_build_object('sourceId',source_id,'generation',generation_key,'status',status,
 'stale',stale_now,'retained',retained,'capped',capped,'capturedAt',captured_at,'attemptedAt',attempted_at,
 'windowStart',window_start,'windowEnd',window_end,'reasons',reasons) ORDER BY source_id) FROM src),'[]'::jsonb),
 'entities',coalesce((SELECT jsonb_agg(jsonb_build_object('id',id,'kind',kind,'label',label,'layers',layers,
 'claim',claim,'region',region,'sourceId',source_id,'spanCount',span_count,'errors',errors,'knownStatus',known_status,
 'cluster',cluster,'namespace',namespace,'vpc',vpc,'ownerReason',owner_reason,'durationSumMs',duration_sum_ms,'evidenceRefs',evidence_refs[1:20],'omittedEvidence',greatest(0,cardinality(evidence_refs)-20)) ORDER BY (id=p_focus) DESC,(kind='service') DESC,errors DESC NULLS LAST,label,id)
 FROM visible),'[]'::jsonb),
 'relations',coalesce((SELECT jsonb_agg(jsonb_build_object('id',id,'source',source,'target',target,'kind',kind,'layer',layer,
 'confidence',confidence,'spanCount',span_count,'metricCount',metric_count,'evidenceRefs',evidence_refs[1:20],'omittedEvidence',greatest(0,cardinality(evidence_refs)-20)) ORDER BY id) FROM visible_edges),'[]'::jsonb),
 'omitted',jsonb_build_object('entities',(SELECT count(*) FROM eligible)-(SELECT count(*) FROM visible),
 'relations',(SELECT count(*) FROM all_edges)-(SELECT count(*) FROM visible_edges)),
 'nextCursor',CASE WHEN (SELECT count(*) FROM eligible)>(p_offset+200) THEN p_offset+(SELECT slots FROM page_bounds) END,'gaps',s.read_gaps)
FROM evidence s;
$$;
REVOKE ALL ON FUNCTION sql_reader.service_topology_read(uuid,text,text,text,integer,integer) FROM PUBLIC, awsops_sql_reader;
GRANT EXECUTE ON FUNCTION sql_reader.service_topology_read(uuid,text,text,text,integer,integer) TO awsops_web,awsops_topology_reader;
