"""D1 inventory sync: query the warm Steampipe FDW, UPSERT per-resource rows into Aurora.
Invoked by EventBridge (scheduled) and by the BFF /refresh (lambda:InvokeFunction). One sync
implementation. Advisory-locked per (resource_type) so concurrent triggers don't stampede Steampipe.
Env: STEAMPIPE_HOST, STEAMPIPE_SECRET_ARN (db password), AURORA_ENDPOINT, AURORA_DATABASE,
AURORA_SECRET_ARN, AWS_REGION."""
import json
from datetime import datetime, timezone
import os
import re
import ssl
import boto3
import pg8000.native
from botocore.exceptions import ClientError

# resource_type -> (steampipe SQL, resource_id column, region column). Waves add rows here.
QUERIES = {
    "ec2": (
        # v1-parity (src/lib/queries/ec2.ts `detail` + `list`): full instance detail + instance-type
        # specs JOIN, stored in `data` so the detail panel matches v1. No feature reduced vs v1.
        "SELECT i.instance_id, (i.tags ->> 'Name') AS name, i.instance_type, i.instance_state, "
        "i.region, i.account_id, i.image_id, i.key_name, i.architecture, i.platform_details, "
        "i.virtualization_type, i.hypervisor, i.ebs_optimized, i.ena_support, i.monitoring_state, "
        "i.placement_availability_zone, i.placement_tenancy, i.private_ip_address, i.private_dns_name, "
        "i.public_ip_address, i.public_dns_name, i.vpc_id, i.subnet_id, i.cpu_options_core_count, "
        "i.cpu_options_threads_per_core, i.root_device_type, i.root_device_name, "
        "i.iam_instance_profile_arn, i.launch_time, i.state_transition_time, "
        # Steampipe returns '' (not SQL NULL) for on-demand instances — NULLIF normalizes both to NULL first.
        "COALESCE(NULLIF(i.instance_lifecycle, ''), 'on-demand') AS pricing_model, "
        "i.security_groups, i.block_device_mappings, i.network_interfaces, i.tags, "
        "(t.memory_info ->> 'SizeInMiB') AS memory_mib, (t.v_cpu_info ->> 'DefaultVCpus') AS vcpus, "
        "(t.network_info ->> 'NetworkPerformance') AS network_performance, "
        "(t.network_info ->> 'MaximumNetworkInterfaces') AS max_enis, t.instance_storage_supported "
        "FROM aws_ec2_instance i LEFT JOIN aws_ec2_instance_type t ON i.instance_type = t.instance_type "
        "ORDER BY i.launch_time DESC",
        "instance_id",
        "region",
    ),
    "lambda": (
        "SELECT name, region, account_id, arn, runtime, handler, code_size, memory_size, timeout, "
        "last_modified, version, state, last_update_status, package_type, architectures, layers, "
        "vpc_id, vpc_subnet_ids, vpc_security_group_ids, description, code_sha_256 "
        "FROM aws_lambda_function ORDER BY name",
        "name",
        "region",
    ),
    "rds": (
        # NON-metric detail fields only; v1's rdsMetrics CloudWatch JOIN is live/heavy → F5, not stored here.
        "SELECT db_instance_identifier, region, account_id, arn, engine, engine_version, class, status, "
        "multi_az, publicly_accessible, allocated_storage, storage_type, storage_encrypted, kms_key_id, "
        "vpc_id, db_subnet_group_name, availability_zone, endpoint_address, endpoint_port, "
        "backup_retention_period, preferred_backup_window, latest_restorable_time, vpc_security_groups, "
        "auto_minor_version_upgrade, copy_tags_to_snapshot, deletion_protection, "
        "iam_database_authentication_enabled, performance_insights_enabled, create_time, tags "
        "FROM aws_rds_db_instance ORDER BY db_instance_identifier",
        "db_instance_identifier",
        "region",
    ),
    "ebs_volume": (
        "SELECT volume_id, region, account_id, arn, volume_type, size, state, encrypted, iops, "
        "availability_zone, create_time, snapshot_id, kms_key_id, multi_attach_enabled, attachments, tags, "
        "(tags ->> 'Name') AS name "
        "FROM aws_ebs_volume ORDER BY volume_id",
        "volume_id",
        "region",
    ),
    "vpc": (
        "SELECT vpc_id, region, account_id, arn, cidr_block, state, is_default, instance_tenancy, "
        "dhcp_options_id, owner_id, tags, (tags ->> 'Name') AS name "
        "FROM aws_vpc ORDER BY vpc_id",
        "vpc_id",
        "region",
    ),
    "subnet": (
        "SELECT subnet_id, region, account_id, subnet_arn, vpc_id, cidr_block, state, owner_id, "
        "availability_zone, availability_zone_id, available_ip_address_count, map_public_ip_on_launch, "
        "default_for_az, assign_ipv6_address_on_creation, tags, (tags ->> 'Name') AS name "
        "FROM aws_vpc_subnet ORDER BY subnet_id",
        "subnet_id",
        "region",
    ),
    "security_group": (
        "SELECT group_id, region, account_id, arn, group_name, vpc_id, description, owner_id, "
        "ip_permissions, ip_permissions_egress, tags, (tags ->> 'Name') AS name "
        "FROM aws_vpc_security_group ORDER BY group_id",
        "group_id",
        "region",
    ),
    "iam_role": (
        "SELECT name, region, account_id, arn, role_id, create_date, path, description, "
        "max_session_duration, role_last_used_date, role_last_used_region, instance_profile_arns, "
        "permissions_boundary_arn, assume_role_policy, tags "
        "FROM aws_iam_role ORDER BY create_date DESC",
        "name",
        "region",
    ),
    "iam_user": (
        "SELECT name, region, account_id, arn, user_id, create_date, path, password_last_used, "
        "mfa_enabled, tags "
        "FROM aws_iam_user ORDER BY create_date DESC",
        "name",
        "region",
    ),
    "dynamodb": (
        "SELECT name, region, account_id, arn, table_status, billing_mode, item_count, table_size_bytes, "
        "read_capacity, write_capacity, key_schema, point_in_time_recovery_description, sse_description, "
        "creation_date_time, tags "
        "FROM aws_dynamodb_table ORDER BY name",
        "name",
        "region",
    ),
    "ecs_cluster": (
        "SELECT cluster_name, region, account_id, cluster_arn, status, running_tasks_count, "
        "pending_tasks_count, active_services_count, registered_container_instances_count, settings, tags "
        "FROM aws_ecs_cluster ORDER BY cluster_name",
        "cluster_name",
        "region",
    ),
    "ecs_service": (
        # v1 parity: ECS service inventory (desired/running/pending + launch type). Read-only
        # aws_ecs_service describe/list data, materialized into Aurora like other inventory types.
        # Key by cluster+service instead of a service ARN column: aws_ecs_service exposes v1-parity
        # fields directly, and legacy short ARNs can collide for same-named services in different clusters.
        "SELECT (cluster_arn || '/' || service_name) AS service_key, "
        "service_name, cluster_arn, region, account_id, status, "
        "desired_count, running_count, pending_count, launch_type, scheduling_strategy, "
        "task_definition, created_at, tags "
        "FROM aws_ecs_service ORDER BY cluster_arn, service_name",
        "service_key",
        "region",
    ),
    "ecr": (
        "SELECT repository_name, region, account_id, arn, registry_id, repository_uri, "
        "image_tag_mutability, image_scanning_configuration, encryption_configuration, lifecycle_policy, "
        "created_at, tags "
        "FROM aws_ecr_repository ORDER BY created_at DESC",
        "repository_name",
        "region",
    ),
    # ---- D3 wave (verified columns; all Describe/List-based) ----
    "cloudfront": (
        "SELECT id, region, account_id, arn, domain_name, status, enabled, e_tag, http_version, "
        "is_ipv6_enabled, price_class, web_acl_id, default_cache_behavior, origins, aliases, "
        "cache_behaviors, tags, (tags ->> 'Name') AS name "
        "FROM aws_cloudfront_distribution ORDER BY id",
        "id",
        "region",
    ),
    "alb": (
        "SELECT name, region, account_id, arn, type, scheme, state_code, vpc_id, dns_name, "
        "ip_address_type, canonical_hosted_zone_id, availability_zones, security_groups, created_time, tags "
        "FROM aws_ec2_application_load_balancer ORDER BY name",
        "name",
        "region",
    ),
    "nlb": (
        "SELECT name, region, account_id, arn, type, scheme, state_code, vpc_id, dns_name, "
        "ip_address_type, canonical_hosted_zone_id, availability_zones, security_groups, created_time, tags "
        "FROM aws_ec2_network_load_balancer ORDER BY name",
        "name",
        "region",
    ),
    "target_group": (
        # Request-flow topology: load_balancer_arns links TG->ALB/NLB; target_health_descriptions
        # (jsonb, hydrated via DescribeTargetHealth) carries each target's id/IP + health state.
        # Nested jsonb keys are PascalCase (AWS SDK shape): target_health_descriptions[].Target.Id,
        # .TargetHealth.State — kept as jsonb (not ::text) so the BFF reads them as nested objects.
        "SELECT target_group_arn, region, account_id, target_group_name, target_type, vpc_id, "
        "protocol, port, load_balancer_arns, health_check_enabled, health_check_protocol, "
        "health_check_path, target_health_descriptions "
        "FROM aws_ec2_target_group ORDER BY target_group_name",
        "target_group_arn",
        "region",
    ),
    "route53": (
        # Front-door entry: alias/A/CNAME records whose alias_target (PascalCase .DNSName) points
        # at a CloudFront distribution domain or an LB dns_name.
        # record_id is ZONE- and ROUTING-POLICY-SCOPED (zone_id + name + type + set_identifier): a
        # name+type can exist in BOTH a public and a private hosted zone (split-horizon) AND across
        # multiple weighted/latency/failover/geo/multivalue records (distinguished only by
        # set_identifier). Keying on less would collide → records overwrite each other on upsert,
        # leaving a single row → the topology builder's public/private + ambiguity guards operate on
        # incomplete data → resolution becomes input-order-dependent. The full key keeps every record
        # a distinct row. private_zone (LEFT JOIN aws_route53_zone) marks public vs private so the
        # builder resolves ONLY public-zone records to a real CF→LB edge (standard custom origins use
        # public DNS).
        "SELECT (r.zone_id || ' ' || r.name || ' ' || r.type || ' ' || COALESCE(r.set_identifier, '')) AS record_id, "
        "r.name, r.type, 'global' AS region, r.account_id, r.zone_id, r.set_identifier, "
        "r.alias_target, r.records, r.ttl, z.private_zone "
        # join-key normalized: aws_route53_zone.id and aws_route53_record.zone_id may differ by a
        # '/hostedzone/' prefix depending on FDW shape; strip it on both sides so the join can't
        # silently miss (which would NULL every private_zone → builder skips all → zero edges).
        "FROM aws_route53_record r LEFT JOIN aws_route53_zone z "
        "ON replace(z.id, '/hostedzone/', '') = replace(r.zone_id, '/hostedzone/', '') "
        "WHERE r.type IN ('A', 'AAAA', 'CNAME') ORDER BY r.name, r.set_identifier",
        "record_id",
        "region",
    ),
    "ecs_task": (
        # Backend resolution for ALB/NLB ip targets: an awsvpc task's ENI private IP lives in
        # attachments[].Details[Name='privateIPv4Address'].Value (PascalCase jsonb); `group` (a SQL
        # reserved word → quoted) = "service:<name>". Matches a TG ip target → ECS service/task.
        "SELECT task_arn, region, account_id, cluster_arn, \"group\" AS task_group, last_status, "
        "launch_type, task_definition_arn, cpu, memory, availability_zone, started_at, attachments, containers "
        "FROM aws_ecs_task ORDER BY task_arn",
        "task_arn",
        "region",
    ),
    "elasticache": (
        # NON-metric detail fields only; v1's ecMetrics CloudWatch JOIN is live/heavy → F5, not stored here.
        "SELECT cache_cluster_id, region, account_id, arn, engine, engine_version, cache_node_type, "
        "cache_cluster_status, num_cache_nodes, cache_nodes, replication_group_id, preferred_availability_zone, "
        "cache_subnet_group_name, at_rest_encryption_enabled, transit_encryption_enabled, "
        "auth_token_enabled, auto_minor_version_upgrade, snapshot_retention_limit, snapshot_window, "
        "preferred_maintenance_window, cache_cluster_create_time, security_groups, tags "
        "FROM aws_elasticache_cluster ORDER BY cache_cluster_id",
        "cache_cluster_id",
        "region",
    ),
    "opensearch": (
        "SELECT domain_name, region, account_id, arn, domain_id, engine_type, engine_version, processing, "
        "created, deleted, endpoint, node_to_node_encryption_options_enabled, encryption_at_rest_options, "
        "cluster_config, vpc_options, ebs_options, endpoints, cognito_options, advanced_security_options, tags "
        "FROM aws_opensearch_domain ORDER BY domain_name",
        "domain_name",
        "region",
    ),
    "route_table": (
        "SELECT route_table_id, region, account_id, vpc_id, owner_id, routes, associations, "
        "propagating_vgws, tags "
        "FROM aws_vpc_route_table ORDER BY route_table_id",
        "route_table_id",
        "region",
    ),
    "nat_gateway": (
        "SELECT nat_gateway_id, region, account_id, arn, vpc_id, subnet_id, state, "
        "create_time, nat_gateway_addresses, tags "
        "FROM aws_vpc_nat_gateway ORDER BY nat_gateway_id",
        "nat_gateway_id",
        "region",
    ),
    "internet_gateway": (
        "SELECT internet_gateway_id, region, account_id, owner_id, attachments, tags "
        "FROM aws_vpc_internet_gateway ORDER BY internet_gateway_id",
        "internet_gateway_id",
        "region",
    ),
    "transit_gateway": (
        "SELECT transit_gateway_id, region, account_id, transit_gateway_arn, state, owner_id, "
        "description, creation_time, amazon_side_asn, tags "
        "FROM aws_ec2_transit_gateway ORDER BY transit_gateway_id",
        "transit_gateway_id",
        "region",
    ),
    "elasticache_replication_group": (
        "SELECT replication_group_id, region, account_id, arn, description, status, "
        "automatic_failover, multi_az, cluster_enabled, cache_node_type, "
        "auth_token_enabled, transit_encryption_enabled, at_rest_encryption_enabled, "
        "snapshot_retention_limit, member_clusters, node_groups "
        "FROM aws_elasticache_replication_group ORDER BY replication_group_id",
        "replication_group_id",
        "region",
    ),
    "iam_policy": (
        # customer-managed only (is_aws_managed=false) — v1 IAM policy KPI parity
        "SELECT name, region, account_id, arn, policy_id, path, is_attachable, "
        "create_date, update_date, attachment_count, default_version_id, tags "
        "FROM aws_iam_policy WHERE NOT is_aws_managed ORDER BY name",
        "name",
        "region",
    ),
    "neptune_cluster": (
        "SELECT db_cluster_identifier, region, account_id, arn, status, engine, engine_version, "
        "endpoint, reader_endpoint, port, multi_az, storage_encrypted, kms_key_id, "
        "availability_zones, vpc_security_groups, db_subnet_group, cluster_create_time, "
        "backup_retention_period, preferred_backup_window, preferred_maintenance_window, "
        "iam_database_authentication_enabled, deletion_protection, tags "
        "FROM aws_neptune_db_cluster ORDER BY db_cluster_identifier",
        "db_cluster_identifier",
        "region",
    ),
    "msk": (
        "SELECT cluster_name, region, account_id, arn, state, cluster_type, current_version, creation_time, "
        "provisioned, tags "
        "FROM aws_msk_cluster ORDER BY cluster_name",
        "cluster_name",
        "region",
    ),
    "waf": (
        "SELECT name, region, account_id, id, arn, scope, capacity, description, default_action, rules, "
        "visibility_config, managed_by_firewall_manager, tags "
        "FROM aws_wafv2_web_acl ORDER BY name",
        "name",
        "region",
    ),
    "cloudwatch_alarm": (
        "SELECT name, region, account_id, arn, state_value, state_reason, state_updated_timestamp, "
        "namespace, metric_name, comparison_operator, threshold, period, evaluation_periods, statistic, "
        "actions_enabled, alarm_actions, ok_actions, insufficient_data_actions "
        "FROM aws_cloudwatch_alarm ORDER BY name",
        "name",
        "region",
    ),
    "cloudtrail": (
        "SELECT name, region, account_id, arn, home_region, is_multi_region_trail, is_logging, "
        "log_file_validation_enabled, s3_bucket_name, s3_key_prefix, sns_topic_arn, kms_key_id, "
        "log_group_arn, is_organization_trail, include_global_service_events, has_custom_event_selectors, "
        "has_insight_selectors, latest_delivery_time, latest_delivery_error, start_logging_time, tags "
        "FROM aws_cloudtrail_trail ORDER BY name",
        "name",
        "region",
    ),
    # L7 origin resolution: a CloudFront execute-api origin (<api_id>.execute-api...) resolves to an
    # apigw node; its integrations chain to Lambda / (VPC_LINK) ALB-NLB → TG → ECS.
    "apigatewayv2_api": (
        "SELECT api_id, name, api_endpoint, protocol_type, region, account_id, tags "
        "FROM aws_api_gatewayv2_api ORDER BY api_id",
        "api_id",
        "region",
    ),
    # per-API table (composite key integration_id+api_id); Steampipe materializes the cross-API list.
    "apigatewayv2_integration": (
        "SELECT integration_id, api_id, integration_type, integration_uri, connection_type, "
        "connection_id, region, account_id "
        "FROM aws_api_gatewayv2_integration ORDER BY api_id, integration_id",
        "integration_id",
        "region",
    ),
    # API GW routes: route_key (e.g. 'POST /qa') + target ('integrations/<id>') → label apigw edges.
    # Composite id (api_id/route_id): route_id is per-API → a bare route_id risks a cross-API
    # (region,resource_id) collision that the stale-delete would wrongly prune.
    "apigatewayv2_route": (
        "SELECT (api_id || '/' || route_id) AS route_uid, api_id, route_id, route_key, target, "
        "authorization_type, region, account_id "
        "FROM aws_api_gatewayv2_route ORDER BY api_id, route_id",
        "route_uid",
        "region",
    ),
    # ---- v1-parity inventory addition (g-02; read-only). ecs_service (g-01) is defined above,
    # owned by the concurrent merge (keyed by cluster+service). ----
    "ebs_snapshot": (
        # g-02: account-owned EBS snapshots. The `owner_id = (caller account)` predicate is
        # MANDATORY — it pushes OwnerIds=self down to DescribeSnapshots. Without it Steampipe
        # returns every public AWS snapshot (hundreds of thousands → API throttle / OOM).
        "SELECT snapshot_id, region, account_id, arn, (tags ->> 'Name') AS name, volume_id, volume_size, state, progress, "
        "encrypted, start_time, description, owner_id, tags "
        # owner_id MUST be LITERAL constants so Steampipe pushes OwnerIds down to DescribeSnapshots.
        # Under the multi-account aggregator a single host literal would miss every TARGET account's
        # snapshots, so sync() renders {owner_ids} to the validated IN-list of ALL enabled accounts
        # (host caller id + target 12-digit ids). A bound-param/subquery qual is NOT pushed down.
        "FROM aws_ebs_snapshot WHERE owner_id IN ({owner_ids}) "
        "ORDER BY start_time DESC",
        "snapshot_id",
        "region",
    ),
}


# ---- SDK-sourced inventory (NOT Steampipe) ---------------------------------------------------
# Some data Steampipe cannot supply. CloudFront VPC origins: aws_cloudfront_vpc_origin has no
# Steampipe table AND aws_cloudfront_distribution.origins omits VpcOriginConfig (absent from the
# pinned cloudfront SDK Origin struct), so neither vo→LB nor distribution→vo is obtainable via SQL.
# These fetchers return (list[dict] rows, id_col, region_col) — fed through the SAME upsert path.
def _fetch_cloudfront_vpc_origins():
    cf = boto3.client("cloudfront", region_name="us-east-1")  # CloudFront is global → us-east-1
    if not hasattr(cf, "list_vpc_origins"):
        # botocore too old for the (late-2024) VPC-origins API → degrade gracefully, never crash
        print("cloudfront_vpc_origin: botocore lacks list_vpc_origins; returning 0 rows")
        return [], "resource_id", "region"
    # (b2) vo_id → backing LB ARN + status
    vos, marker = {}, None
    while True:
        resp = cf.list_vpc_origins(**({"Marker": marker} if marker else {}))
        lst = resp.get("VpcOriginList", {}) or {}
        for it in lst.get("Items", []) or []:
            vid = it.get("Id")
            try:
                d = cf.get_vpc_origin(Id=vid)["VpcOrigin"]
                cfg = d.get("VpcOriginEndpointConfig") or {}
                vos[vid] = {"name": cfg.get("Name"), "arn": cfg.get("Arn"), "status": d.get("Status")}
            except ClientError as e:
                print(f"get_vpc_origin {vid} failed: {e}")
        marker = lst.get("NextMarker")
        if not marker:
            break
    # (b1) vo_id → which distribution ORIGINS use it — get_distribution_config exposes VpcOriginConfig
    # live. Capture (distribution_id, origin domain) per vo so the topology builder links only the
    # SPECIFIC origin (not every origin on the distribution → no false edge for a co-resident origin).
    dists, refs, marker = {}, {}, None
    while True:
        resp = cf.list_distributions(**({"Marker": marker} if marker else {}))
        dl = resp.get("DistributionList", {}) or {}
        for it in dl.get("Items", []) or []:
            did = it.get("Id")
            try:
                cfg = cf.get_distribution_config(Id=did)["DistributionConfig"]
                for o in (cfg.get("Origins", {}) or {}).get("Items", []) or []:
                    vid = (o.get("VpcOriginConfig") or {}).get("VpcOriginId")
                    if vid:
                        dists.setdefault(vid, set()).add(did)
                        refs.setdefault(vid, []).append({"distribution_id": did, "domain": o.get("DomainName")})
            except ClientError as e:
                print(f"get_distribution_config {did} skipped: {e}")  # one bad dist must not blank the type
        marker = dl.get("NextMarker")
        if not marker:
            break
    rows = [{"resource_id": vid, "region": "global", "vpc_origin_id": vid, "name": v["name"],
             "arn": v["arn"], "status": v["status"], "distribution_ids": sorted(dists.get(vid, [])),
             "origin_refs": refs.get(vid, [])}
            for vid, v in vos.items()]
    return rows, "resource_id", "region"


def _fetch_alb_listener_rules():
    # ALB listener rules carry the L7 path/host → TG routing. The Steampipe table
    # aws_ec2_load_balancer_listener_rule requires a listener_arn qualifier (unusable for a bulk
    # SELECT), so source via boto3 elbv2 (regional client) like the cloudfront fetcher. One row per
    # RULE: conditions (path-pattern/host-header) + actions (forward TG) + the listener port.
    region = os.environ.get("AWS_REGION", "ap-northeast-2")
    elb = boto3.client("elbv2", region_name=region)
    rows = []
    lb_marker = None
    while True:
        kw = {"Marker": lb_marker} if lb_marker else {}
        lbs = elb.describe_load_balancers(**kw)
        for lb in lbs.get("LoadBalancers", []) or []:
            if lb.get("Type") != "application":
                continue  # only ALBs carry L7 listener rules; NLBs forward by port only
            lb_arn = lb.get("LoadBalancerArn")
            try:
                for ln in elb.describe_listeners(LoadBalancerArn=lb_arn).get("Listeners", []) or []:
                    ln_arn, port, proto = ln.get("ListenerArn"), ln.get("Port"), ln.get("Protocol")
                    for rule in elb.describe_rules(ListenerArn=ln_arn).get("Rules", []) or []:
                        rows.append({
                            "resource_id": rule.get("RuleArn"), "region": region, "arn": rule.get("RuleArn"),
                            "listener_arn": ln_arn, "load_balancer_arn": lb_arn, "port": port, "protocol": proto,
                            "priority": rule.get("Priority"), "is_default": rule.get("IsDefault", False),
                            "conditions": rule.get("Conditions", []), "actions": rule.get("Actions", []),
                        })
            except ClientError as e:
                print(f"alb_listener_rule {lb_arn} skipped: {e}")  # one bad LB must not blank the type
        lb_marker = lbs.get("NextMarker")
        if not lb_marker:
            break
    return rows, "resource_id", "region"


def _fetch_s3_public_access(s3=None):
    """Per-bucket S3 public-access flags (denial-safe), for the /security Public-S3 finding.
    Steampipe's aws_s3_bucket public-access columns trigger per-bucket GetBucketPolicyStatus/
    GetPublicAccessBlock, and ONE denied bucket fails the WHOLE table query — so source via boto3
    and tolerate per-bucket AccessDenied. STRICTLY READ-ONLY (List/Get only).
    NoSuchPublicAccessBlock => no PAB configured => blocks are effectively False (a real signal);
    AccessDenied => genuinely unknown => leave None (FINDING_SQL treats None as non-public)."""
    s3 = s3 or boto3.client("s3", region_name=os.environ.get("AWS_REGION", "ap-northeast-2"))
    rows = []
    for b in s3.list_buckets().get("Buckets", []) or []:
        name = b["Name"]
        try:
            loc = s3.get_bucket_location(Bucket=name).get("LocationConstraint")
            region = loc or "us-east-1"  # null LocationConstraint => us-east-1
        except ClientError:
            region = ""
        rec = {"name": name, "region": region, "bucket_policy_is_public": None,
               "block_public_acls": None, "block_public_policy": None,
               "restrict_public_buckets": None, "ignore_public_acls": None}
        try:
            cfg = s3.get_public_access_block(Bucket=name).get("PublicAccessBlockConfiguration", {})
            rec["block_public_acls"] = cfg.get("BlockPublicAcls")
            rec["block_public_policy"] = cfg.get("BlockPublicPolicy")
            rec["restrict_public_buckets"] = cfg.get("RestrictPublicBuckets")
            rec["ignore_public_acls"] = cfg.get("IgnorePublicAcls")
        except ClientError as e:
            if e.response.get("Error", {}).get("Code") == "NoSuchPublicAccessBlock":
                rec["block_public_acls"] = False
                rec["block_public_policy"] = False
                rec["restrict_public_buckets"] = False
                rec["ignore_public_acls"] = False
            # else AccessDenied / other → leave None (unknown)
        try:
            rec["bucket_policy_is_public"] = (
                s3.get_bucket_policy_status(Bucket=name).get("PolicyStatus", {}).get("IsPublic"))
        except ClientError:
            pass  # AccessDenied / NoSuchBucketPolicy → leave None
        rows.append(rec)
    return rows, "name", "region"


def _fetch_s3_security(s3=None):
    """S3 buckets WITH per-bucket security flags (versioning/encryption/logging) — denial-safe
    boto3 (one denied bucket degrades to None flags, never fails the sweep). Replaces the
    Steampipe ListBuckets-lite `s3` sync so the menu can show v1's security columns/KPIs.
    STRICTLY READ-ONLY (List/Get only)."""
    s3 = s3 or boto3.client("s3", region_name=os.environ.get("AWS_REGION", "ap-northeast-2"))
    rows = []
    for b in s3.list_buckets().get("Buckets", []) or []:
        name = b["Name"]
        try:
            loc = s3.get_bucket_location(Bucket=name).get("LocationConstraint")
            region = loc or "us-east-1"
        except ClientError:
            region = ""
        rec = {
            "name": name, "region": region,
            "arn": f"arn:aws:s3:::{name}",
            "creation_date": b.get("CreationDate").isoformat() if b.get("CreationDate") else None,
            "versioning_enabled": None, "encryption": None, "logging_enabled": None,
        }
        try:
            v = s3.get_bucket_versioning(Bucket=name)
            rec["versioning_enabled"] = v.get("Status") == "Enabled"
        except ClientError:
            pass  # denied → unknown (None)
        try:
            enc = s3.get_bucket_encryption(Bucket=name)
            rules = enc.get("ServerSideEncryptionConfiguration", {}).get("Rules", [])
            algo = (rules[0].get("ApplyServerSideEncryptionByDefault", {}).get("SSEAlgorithm")
                    if rules else None)
            rec["encryption"] = algo or "enabled"
        except ClientError as e:
            if e.response.get("Error", {}).get("Code") == "ServerSideEncryptionConfigurationNotFoundError":
                rec["encryption"] = "none"
            # else denied → unknown (None)
        try:
            log = s3.get_bucket_logging(Bucket=name)
            rec["logging_enabled"] = bool(log.get("LoggingEnabled"))
        except ClientError:
            pass
        rows.append(rec)
    return rows, "name", "region"


def _fetch_opensearch_serverless(aoss=None):
    """OpenSearch Serverless (AOSS) collections via boto3 — the pinned Steampipe plugin has no
    aws_opensearchserverless_collection table. STRICTLY READ-ONLY (List/BatchGet only).
    Regional API: covers the deployment region (env AWS_REGION)."""
    region = os.environ.get("AWS_REGION", "ap-northeast-2")
    aoss = aoss or boto3.client("opensearchserverless", region_name=region)
    ids, token = [], None
    while True:
        kw = {"maxResults": 100}
        if token:
            kw["nextToken"] = token
        page = aoss.list_collections(**kw)
        ids.extend(c["id"] for c in page.get("collectionSummaries", []) or [])
        token = page.get("nextToken")
        if not token:
            break
    rows = []
    for i in range(0, len(ids), 100):
        detail = aoss.batch_get_collection(ids=ids[i : i + 100]).get("collectionDetails", []) or []
        for c in detail:
            arn = c.get("arn", "")
            acct = arn.split(":")[4] if arn.count(":") >= 5 else ""
            def _ts(v):
                return (datetime.fromtimestamp(v / 1000, tz=timezone.utc).isoformat()
                        if isinstance(v, (int, float)) else None)
            rows.append({
                "name": c.get("name"), "region": region, "account_id": acct, "arn": arn,
                "id": c.get("id"), "type": c.get("type"), "status": c.get("status"),
                "description": c.get("description"),
                "collection_endpoint": c.get("collectionEndpoint"),
                "dashboard_endpoint": c.get("dashboardEndpoint"),
                "kms_key_arn": c.get("kmsKeyArn"),
                "created_date": _ts(c.get("createdDate")),
                "last_modified_date": _ts(c.get("lastModifiedDate")),
            })
    return rows, "name", "region"


SDK_SYNCS = {
    "s3": _fetch_s3_security,
    "opensearch_serverless": _fetch_opensearch_serverless,
    "cloudfront_vpc_origin": _fetch_cloudfront_vpc_origins,
    "alb_listener_rule": _fetch_alb_listener_rules,
    "s3_public_access": _fetch_s3_public_access,
}
_ALLOWED = set(QUERIES) | set(SDK_SYNCS)
_sm = boto3.client("secretsmanager", region_name=os.environ.get("AWS_REGION", "ap-northeast-2"))
_lambda = boto3.client("lambda", region_name=os.environ.get("AWS_REGION", "ap-northeast-2"))


def _ssl_ctx():
    c = ssl.create_default_context()
    c.check_hostname = False
    c.verify_mode = ssl.CERT_NONE
    return c


def _secret(arn):
    return _sm.get_secret_value(SecretId=arn)["SecretString"]


def _aurora():
    creds = json.loads(_secret(os.environ["AURORA_SECRET_ARN"]))
    return pg8000.native.Connection(user=creds["username"], password=creds["password"],
                                    host=os.environ["AURORA_ENDPOINT"], database=os.environ["AURORA_DATABASE"],
                                    port=5432, ssl_context=_ssl_ctx())


def _steampipe():
    return pg8000.native.Connection(user="steampipe", password=_secret(os.environ["STEAMPIPE_SECRET_ARN"]).strip(),
                                    host=os.environ["STEAMPIPE_HOST"], database="steampipe",
                                    port=9193, ssl_context=_ssl_ctx())


_ACCT_RE = re.compile(r"^\d{12}$")
_ACCOUNT_CACHE = {}

# Phase-1 stale-prune (see sync()): a module-level constant, not inlined at the call site, so
# tests can assert on the ACTUAL production SQL string rather than a hand-copied duplicate that
# could silently drift out of sync with a future edit (round-6 fix for the F3 test-tautology
# finding). "In scope" mirrors render_spc's skip condition / listScanScope(): enabled AND
# (all_regions OR >=1 enabled account_regions row) — NOT a bare `enabled = true`, which would
# leave an enabled-but-zero-region account's rows as undeletable phantoms forever (F1).
PHASE1_PRUNE_SQL = (
    "DELETE FROM inventory_resources "
    "WHERE resource_type = :t "
    "AND account_id != 'self' "
    "AND account_id NOT IN ("
    "  SELECT a.account_id FROM accounts a"
    "  WHERE a.enabled = true"
    "  AND (a.all_regions = true OR EXISTS ("
    "    SELECT 1 FROM account_regions r"
    "    WHERE r.account_id = a.account_id AND r.enabled = true"
    "  ))"
    ")"
)


def _caller_account():
    """Caller's 12-digit AWS account id (cached). Used to inject a literal owner_id qual so
    Steampipe can push OwnerIds=self down to APIs like DescribeSnapshots."""
    if "id" not in _ACCOUNT_CACHE:
        _ACCOUNT_CACHE["id"] = boto3.client(
            "sts", region_name=os.environ.get("AWS_REGION", "ap-northeast-2")
        ).get_caller_identity()["Account"]
    return _ACCOUNT_CACHE["id"]


def _rec_account(rec):
    """The account a synced row belongs to. Under the multi-account aggregator each row carries its
    own `account_id` (the aws plugin column). The HOST's real 12-digit id maps back to the 'self'
    sentinel the rest of the app uses (accounts host row, SDK syncs, readers), so host inventory is
    not fractured. SDK syncs / rows without the column are host-scoped → 'self'."""
    aid = rec.get("account_id")
    if not aid:
        return "self"
    return "self" if str(aid) == _caller_account() else str(aid)


def _self_count(recs):
    """Count of synced rows that resolve to the host ('self') — used for the daily
    inventory_snapshots row so the dashboard trend chart matches the account_id='self'
    scope every other host-facing read (inventory summary, StatTile counts) already uses."""
    return sum(1 for r in recs if _rec_account(r) == "self")


def _owner_ids_in(adb):
    """Comma-joined quoted IN-list of every enabled account's real owner id (host caller id + target
    12-digit ids) for the {owner_ids} pushdown. Excludes the 'self' sentinel and any non-account-id."""
    ids = {_caller_account()}  # host's real 12-digit id (the 'self' row maps to this)
    for row in adb.run("SELECT account_id FROM accounts WHERE enabled = true AND account_id <> 'self'"):
        aid = str(row[0])
        if _ACCT_RE.match(aid):
            ids.add(aid)
    return ",".join("'%s'" % i for i in sorted(ids))


def _enabled_target_accounts(adb):
    """Target account ids actually IN SCAN SCOPE (not merely `enabled`), for the M2 reachability
    probe. Host is excluded (see _rec_account: it always maps to 'self', handled separately by
    the M-2 host probe). Mirrors PHASE1_PRUNE_SQL's exact in-scope condition — an account that is
    enabled but out of scope (all_regions=false, zero enabled account_regions rows) already has
    NO rendered aws.spc connection (spc_render.py skips it) and was already fully swept by
    phase-1; probing it here would always fail/no-op, wasting a round-trip every sync (M-7 fix,
    round 8)."""
    rows = adb.run(
        "SELECT a.account_id FROM accounts a "
        "WHERE a.enabled = true AND a.account_id <> 'self' AND a.account_id <> :host "
        "AND (a.all_regions = true OR EXISTS ("
        "  SELECT 1 FROM account_regions r WHERE r.account_id = a.account_id AND r.enabled = true"
        "))",
        host=_caller_account(),
    )
    return [str(r[0]) for r in rows]


def _account_reachable(account_id):
    """Direct DATA-PATH probe (M1 fix, round 5): query the account's OWN Steampipe connection
    (aws_<account_id>, the exact schema the aggregator itself fans out to — see spc_render.py)
    for a single row from aws_caller_identity.

    An earlier version of this probe used an INDEPENDENT sts:AssumeRole call from this Lambda's
    own task role. That only proved the IAM TRUST POLICY was intact — NOT that Steampipe's
    aggregator actually queried this account successfully THIS run. If a single aggregator
    connection silently returns 0 rows this run (e.g. a transient plugin-level throttle or
    per-region error that doesn't propagate as a connection-level exception), the old probe would
    still report "reachable" (trust policy fine) and the account would be wrongly promoted into
    `present` → its last-good inventory gets pruned — reintroducing exactly the data-loss scenario
    M5 exists to prevent. Querying the SAME per-account schema the aggregator uses is the only
    signal that proves this account was actually live and queryable right now.

    Used ONLY to decide whether a target account that contributed 0 rows this run is genuinely
    empty (safe to prune) vs unreachable (protect its last-good inventory, per M5) — never used
    to fetch or touch any real account data beyond the caller-identity check."""
    if not _ACCT_RE.match(str(account_id)):
        return False
    conn = _steampipe()
    try:
        rows = conn.run(f"SELECT account_id FROM aws_{account_id}.aws_caller_identity LIMIT 1")
        return len(rows) > 0
    except Exception:
        return False
    finally:
        conn.close()


def _inject_account(sql, account_id):
    """Render a {account_id} placeholder to a LITERAL account id (validated 12-digit). A literal
    is required for Steampipe qual pushdown — a subquery or bound param is evaluated post-fetch
    by the FDW and is NOT pushed down to the AWS API."""
    if "{account_id}" not in sql:
        return sql
    if not _ACCT_RE.match(str(account_id)):
        raise ValueError(f"refusing to inject non-account-id literal: {account_id!r}")
    return sql.format(account_id=account_id)


def sync(resource_type):
    if resource_type not in _ALLOWED:
        return {"error": f"unknown type {resource_type}"}
    adb = _aurora()
    try:
        # advisory lock per type (no Steampipe stampede); skip if busy
        got = adb.run("SELECT pg_try_advisory_lock(hashtext(:t))", t=f"inv:{resource_type}")
        if not got[0][0]:
            return {"status": "busy", "type": resource_type}
        try:
            # NOTE (M4): inventory_sync_runs is a JOB-LEVEL ledger — one row per resource_type keyed
            # under the host 'self' sentinel, tracking the aggregator run's status/row_count. It is
            # intentionally NOT per-account: a single aggregator run covers every connected account at
            # once. Per-account freshness is the captured_at on each inventory_resources row (which IS
            # keyed by real account_id), so no per-account state is lost.
            # mark running INSIDE the try so a throw here records 'failed' and the finally still unlocks
            adb.run("INSERT INTO inventory_sync_runs (resource_type, status, started_at, finished_at, row_count, error) "
                    "VALUES (:t,'running',now(),NULL,NULL,NULL) "
                    "ON CONFLICT (resource_type, account_id) DO UPDATE SET status='running', started_at=now(), "
                    "finished_at=NULL, error=NULL", t=resource_type)
            # SDK-sourced types bypass Steampipe; both paths yield list[dict] rows (recs).
            if resource_type in SDK_SYNCS:
                recs, id_col, region_col = SDK_SYNCS[resource_type]()
            else:
                sql, id_col, region_col = QUERIES[resource_type]
                if "{owner_ids}" in sql:  # multi-account OwnerIds pushdown (all enabled accounts)
                    sql = sql.replace("{owner_ids}", _owner_ids_in(adb))
                if "{account_id}" in sql:  # legacy single-account literal pushdown
                    sql = _inject_account(sql, _caller_account())
                sdb = _steampipe()
                try:
                    rows = sdb.run(sql)
                    cols = [c["name"] for c in sdb.columns]
                finally:
                    sdb.close()  # close even if the Steampipe query throws
                recs = [dict(zip(cols, r)) for r in rows]
            # EBS snapshots: the OwnerIds IN-list can surface snapshots SHARED into a connection but
            # owned by another enabled account; keep only those the connection actually OWNS
            # (owner_id == account_id) so each snapshot is attributed once, to its true owner.
            if resource_type == "ebs_snapshot":
                recs = [r for r in recs if str(r.get("owner_id")) == str(r.get("account_id"))]
            seen = set()
            for rec in recs:
                rid = str(rec.get(id_col))
                region = str(rec.get(region_col) or "")
                acct = _rec_account(rec)  # the row's real account (aggregator fan-out), not a literal 'self'
                seen.add((acct, region, rid))
                adb.run("INSERT INTO inventory_resources (resource_type, account_id, region, resource_id, data, captured_at) "
                        "VALUES (:t,:acct,:rg,:id,:d::jsonb,now()) "
                        "ON CONFLICT (resource_type, account_id, region, resource_id) "
                        "DO UPDATE SET data=:d::jsonb, captured_at=now()",
                        t=resource_type, acct=acct, rg=region, id=rid, d=json.dumps(rec, default=str))
            # ---- Stale-prune: two phases ----
            #
            # Phase 1 — out-of-scope-account orphans: delete ALL rows for accounts no longer in
            # SCAN SCOPE. "In scope" mirrors render_spc's own skip condition (spc_render.py) /
            # listScanScope() (web/lib/account-regions.ts): enabled AND (all_regions OR at least
            # one enabled account_regions row). A naive `enabled = true` check is NOT sufficient —
            # an account can be enabled with all_regions=false and zero enabled regions (e.g. the
            # operator disabled every region without disabling the account). render_spc SKIPS that
            # account entirely (no aws_<id> connection is ever rendered), so it can never appear in
            # `seen`, AND phase-2's reachability probe can never succeed for it either (there is no
            # per-account schema to query) — without this exact-scope check, such an account's
            # stale rows would persist as UNDELETABLE phantoms forever (round-6 fix; this is the
            # same phantom-inventory class rounds 3-5 fixed, reached through a different door).
            # 'self' is excluded here — the host always scans all regions regardless of the flag
            # (C1 host-parity guard) and is handled by phase 2 below.
            adb.run(PHASE1_PRUNE_SQL, t=resource_type)
            # Phase 2 — row-level stale within enabled/in-scope accounts: delete individual rows
            # that were NOT returned in this run, but ONLY for accounts that DID contribute rows
            # (`present`). An account with 0 rows from the aggregator may have suffered a transient
            # connection failure — pruning it would silently discard its last-good inventory (M5).
            present = {a for (a, _, _) in seen}
            # M-2 (round 8): host ('self') protection must be SYMMETRIC with target accounts, not
            # an unconditional `| {'self'}`. An earlier version force-included 'self' on the
            # reasoning "host uses IAM task-role creds (not AssumeRole), always succeeds" — but
            # that only rules out an AUTH failure, not a transient failure of the Steampipe
            # connection's QUERY itself (e.g. an AWS API throttle/blip on this specific run). The
            # aggregator returns PARTIAL results on a single-connection failure without raising, so
            # a host-connection hiccup this run would otherwise force-prune the host's last-good
            # inventory to zero — the exact M5 data-loss class, applied asymmetrically to 'self'.
            # SDK_SYNCS types don't go through Steampipe at all: reaching this point already means
            # the direct SDK call succeeded (a failure would have raised above, short-circuiting
            # before this section), so 0 rows there is the SDK's own definitive "genuinely empty"
            # signal — no probe needed. Aggregator-backed (QUERIES) types: probe the host's OWN
            # connection (aws_<host_real_id>, via _caller_account()) exactly like a target account.
            if 'self' not in present:
                if resource_type in SDK_SYNCS or _account_reachable(_caller_account()):
                    present.add('self')
            # M2 (round 6): an enabled TARGET account that contributed 0 rows this run is
            # ambiguous under the M5 guard above — it might be genuinely empty (e.g. all its EC2
            # instances were terminated) or its aggregator connection might be transiently
            # failing. Aggregator-backed (QUERIES) types only — SDK_SYNCS are host-only and never
            # populate target rows. Positively probe each such account via its OWN Steampipe
            # connection (data path, not an independent IAM trust check — see _account_reachable):
            # reachable + 0 rows = genuinely empty (include in present so its stale rows get
            # pruned); unreachable = protect its last-good inventory (leave excluded).
            if resource_type not in SDK_SYNCS:
                for acct_id in _enabled_target_accounts(adb):
                    if acct_id not in present and _account_reachable(acct_id):
                        present.add(acct_id)
            existing = adb.run("SELECT account_id, region, resource_id FROM inventory_resources WHERE resource_type=:t", t=resource_type)
            for acct, rg, rid in existing:
                if str(acct) in present and (str(acct), str(rg), str(rid)) not in seen:
                    adb.run("DELETE FROM inventory_resources WHERE resource_type=:t AND account_id=:acct AND region=:rg AND resource_id=:id",
                            t=resource_type, acct=acct, rg=rg, id=rid)
            adb.run("UPDATE inventory_sync_runs SET status='succeeded', finished_at=now(), row_count=:n, error=NULL "
                    "WHERE resource_type=:t AND account_id='self'", t=resource_type, n=len(recs))
            # Daily inventory_snapshots row (dashboard "리소스 추세" chart, self-scoped only —
            # see _self_count). One row per (account, day, type): delete same-day then insert,
            # matching backfill-v1.mjs's convention — a resource type can sync more than once a day.
            adb.run("DELETE FROM inventory_snapshots WHERE account_id='self' AND resource_type=:t "
                    "AND captured_at::date = CURRENT_DATE", t=resource_type)
            adb.run("INSERT INTO inventory_snapshots (account_id, captured_at, resource_type, resource_count) "
                    "VALUES ('self', now(), :t, :n)", t=resource_type, n=_self_count(recs))
            return {"status": "succeeded", "type": resource_type, "row_count": len(recs)}
        except Exception as e:
            adb.run("UPDATE inventory_sync_runs SET status='failed', finished_at=now(), error=:e "
                    "WHERE resource_type=:t AND account_id='self'", t=resource_type, e=str(e)[:2000])
            return {"status": "failed", "type": resource_type, "error": str(e)[:300]}
        finally:
            adb.run("SELECT pg_advisory_unlock(hashtext(:t))", t=f"inv:{resource_type}")
    finally:
        adb.close()


def lambda_handler(event, ctx):
    rtype = (event or {}).get("type", "all")
    if rtype == "all":
        for rt in list(QUERIES) + list(SDK_SYNCS):
            _lambda.invoke(FunctionName=ctx.invoked_function_arn, InvocationType="Event",
                           Payload=json.dumps({"type": rt}).encode())
        return {"status": "dispatched", "types": list(QUERIES) + list(SDK_SYNCS)}
    return sync(rtype)
