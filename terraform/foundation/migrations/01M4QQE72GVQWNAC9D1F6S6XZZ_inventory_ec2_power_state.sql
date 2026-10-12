-- since: 2.0.0
-- query_inventory could not tell the model whether an EC2 instance is running or stopped: the
-- reader view's named-key projection of inventory_resources.data did not include the instance
-- power-state keys, so a "which instances are stopped?" question could only be answered with
-- "unknown". Add exactly the non-sensitive identity/state keys the connector now projects for
-- ec2 (instance_id, instance_type, instance_state, state_transition_time). Everything else in the
-- raw payload (user data, tags, IPs, profiles, ...) stays absent; the list is still an allowlist.
-- The `origins` element projection and the previously named keys are unchanged.
DROP VIEW IF EXISTS sql_reader.inventory_resources;

CREATE VIEW sql_reader.inventory_resources
WITH (security_invoker = false) AS
SELECT resource_type, account_id, region, resource_id, captured_at,
  (SELECT jsonb_object_agg(
     k,
     CASE WHEN k = 'origins' THEN (
       SELECT jsonb_agg(jsonb_build_object('DomainName', o -> 'DomainName'))
       FROM jsonb_array_elements(v) o
     ) ELSE v END
   ) FROM jsonb_each(data) AS e(k, v)
    WHERE k = ANY(ARRAY['target_group_arn','target_group_name','load_balancer_arns','target_health_descriptions','name','dns_name','arn','id','domain_name','enabled','origins','aliases','volume_id','state','size','volume_type','instance_id','instance_type','instance_state','state_transition_time'])) AS data
FROM public.inventory_resources;

GRANT SELECT ON sql_reader.inventory_resources TO awsops_sql_reader;
