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
import time
import uuid
import boto3
import pg8000.native
from botocore.exceptions import ClientError


def _log(event: str, **fields) -> None:
    print(json.dumps({"event": event, **fields}, default=str, sort_keys=True))


_THROTTLING_CODES = {
    "ec2throttledexception",
    "limitexceededexception",
    "priorrequestnotcomplete",
    "provisionedthroughputexceededexception",
    "requestlimitexceeded",
    "slowdown",
    "throttling",
    "throttlingexception",
    "toomanyrequestsexception",
}


def _is_throttling_error(exc: Exception) -> bool:
    """Classify throttling from structured metadata only; never inspect/log raw message text."""
    response = getattr(exc, "response", None)
    error = response.get("Error", {}) if isinstance(response, dict) else {}
    code = str(error.get("Code") or "").lower()
    return (
        code in _THROTTLING_CODES
        or "throttl" in code
        or "throttl" in type(exc).__name__.lower()
    )


def _failure_label_is_throttling(label):
    """Match a safe failure label's structured code suffix (e.g. 'ClientError:SlowDown')
    against _THROTTLING_CODES — same contract as _is_throttling_error, no raw text."""
    code = str(label).rsplit(":", 1)[-1].lower()
    return code in _THROTTLING_CODES or "throttl" in code or "slowdown" in code


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
        "cluster_config, vpc_options, ebs_options, endpoints, cognito_options, advanced_security_options, "
        # L153 detail-panel fields (all verified present in the pinned plugin aws@0.142.0;
        # v1's off_peak_window_options does NOT exist in 0.142.0 and is deliberately excluded)
        "service_software_options, log_publishing_options, domain_endpoint_options, auto_tune_options, "
        "snapshot_options, advanced_options, access_policies, upgrade_processing, tags "
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
    "waf_rule_group": (
        # gap L253 — columns verified against the pinned plugin source
        # (v0.142.0 table_aws_wafv2_rule_group.go); List needs no key quals.
        "SELECT name, region, account_id, id, arn, scope, capacity, description, rules, "
        "visibility_config, tags "
        "FROM aws_wafv2_rule_group ORDER BY name",
        "name",
        "region",
    ),
    "waf_ip_set": (
        # gap L253 — columns verified against v0.142.0 table_aws_wafv2_ip_set.go.
        "SELECT name, region, account_id, id, arn, scope, description, ip_address_version, "
        "addresses, tags "
        "FROM aws_wafv2_ip_set ORDER BY name",
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
        "has_insight_selectors, latest_delivery_time, latest_delivery_error, start_logging_time, "
        # L189 detail fields (all verified present in the pinned plugin aws@0.142.0)
        "cloudwatch_logs_role_arn, latest_cloudwatch_logs_delivery_time, latest_cloudwatch_logs_delivery_error, "
        "latest_digest_delivery_time, latest_digest_delivery_error, stop_logging_time, tags "
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
# These fetchers return (list[dict] rows, id_col, region_col, failure_metadata) — successful rows
# still flow through the same upsert path, while safe per-subcall failure codes make the run partial.
_SAFE_FAILURE_LABEL_RE = re.compile(r"^[A-Za-z0-9_.:-]{1,128}$")


def _safe_sdk_failure_type(error):
    error_type = type(error).__name__
    code = ""
    if isinstance(error, ClientError):
        code = str(error.response.get("Error", {}).get("Code") or "")
    label = f"{error_type}:{code}" if code else error_type
    return label if _SAFE_FAILURE_LABEL_RE.fullmatch(label) else error_type


# Steady-state authorization denials on per-bucket ATTRIBUTE calls (PAB/policy-status/
# versioning/encryption/logging) are already modeled as "unknown -> None" on the row —
# counting them toward sdk_partial would make one SCP-denied bucket disable stale-pruning
# and freeze last_success_at on every run forever. Location failures are NOT in this
# carve-out: a bucket we cannot place is skipped for the run (see the fetchers), which
# must keep the run partial so its last-good row survives the skipped prunes.
_S3_STEADY_DENIAL_CODES = frozenset(
    {"AccessDenied", "AccessDeniedException", "UnauthorizedOperation", "AllAccessDisabled"}
)


def _safe_sdk_response_failure_type(error):
    code = str(error.get("errorCode") or "") if isinstance(error, dict) else ""
    label = f"CollectionError:{code}" if code else "CollectionError"
    return label if _SAFE_FAILURE_LABEL_RE.fullmatch(label) else "CollectionError"


def _sdk_failure_metadata(failure_types=(), unknown_attribute_count=0):
    labels = tuple(failure_types)
    safe_types = sorted({
        label for label in labels
        if isinstance(label, str) and _SAFE_FAILURE_LABEL_RE.fullmatch(label)
    })
    return {
        "failure_count": len(labels),
        "failure_types": safe_types,
        # Attribute reads blinded by a steady-state denial: disclosed as a count so readers can
        # degrade freshness, never counted as a failure (which would block pruning forever).
        "unknown_attribute_count": max(0, int(unknown_attribute_count)),
    }


def _sdk_collection(rows, id_col, region_col, failures=(), unknown_attribute_count=0):
    return rows, id_col, region_col, _sdk_failure_metadata(
        tuple(failures), unknown_attribute_count
    )


def _normalize_sdk_collection(result):
    """Accept the current 4-field contract and legacy internal test doubles with 3 fields."""
    if len(result) == 3:
        rows, id_col, region_col = result
        return rows, id_col, region_col, _sdk_failure_metadata()
    if len(result) != 4:
        raise ValueError("invalid SDK inventory collector result")
    rows, id_col, region_col, metadata = result
    failure_count = int(metadata.get("failure_count", 0))
    failure_types = sorted({
        label for label in metadata.get("failure_types", [])
        if isinstance(label, str) and _SAFE_FAILURE_LABEL_RE.fullmatch(label)
    })
    unknown_attribute_count = max(0, int(metadata.get("unknown_attribute_count", 0)))
    return rows, id_col, region_col, {
        "failure_count": max(0, failure_count),
        "failure_types": failure_types,
        "unknown_attribute_count": unknown_attribute_count,
    }


def _fetch_cloudfront_vpc_origins():
    cf = boto3.client("cloudfront", region_name="us-east-1")  # CloudFront is global → us-east-1
    if not hasattr(cf, "list_vpc_origins"):
        # botocore too old for the (late-2024) VPC-origins API → degrade gracefully, never crash
        return _sdk_collection(
            [], "resource_id", "region", ["UnsupportedApi"]
        )
    failures = []
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
                failures.append(_safe_sdk_failure_type(e))
        marker = lst.get("NextMarker")
        if not marker:
            break
    # (b1) vo_id → which distribution ORIGINS use it — get_distribution_config exposes VpcOriginConfig
    # live. Capture (distribution_id, origin domain) per vo so the topology builder links only the
    # SPECIFIC origin (not every origin on the distribution → no false edge for a co-resident origin).
    dists, refs, marker = {}, {}, None
    distribution_config_failed = False
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
                failures.append(_safe_sdk_failure_type(e))
                distribution_config_failed = True
        marker = dl.get("NextMarker")
        if not marker:
            break
    if distribution_config_failed:
        # A failed get_distribution_config leaves dists/refs incomplete for EVERY row (any
        # distribution can reference any vpc-origin), so every rec's origin-ref attribution is
        # now partial. Upserting them would overwrite complete last-known-good rows with a
        # truncated distribution_ids/origin_refs set. Drop the rows instead: the counted
        # failure keeps the run partial and the skipped prunes preserve last-good content.
        return _sdk_collection([], "resource_id", "region", failures)
    rows = [{"resource_id": vid, "region": "global", "vpc_origin_id": vid, "name": v["name"],
             "arn": v["arn"], "status": v["status"], "distribution_ids": sorted(dists.get(vid, [])),
             "origin_refs": refs.get(vid, [])}
            for vid, v in vos.items()]
    return _sdk_collection(rows, "resource_id", "region", failures)


def _fetch_alb_listener_rules():
    # ALB listener rules carry the L7 path/host → TG routing. The Steampipe table
    # aws_ec2_load_balancer_listener_rule requires a listener_arn qualifier (unusable for a bulk
    # SELECT), so source via boto3 elbv2 (regional client) like the cloudfront fetcher. One row per
    # RULE: conditions (path-pattern/host-header) + actions (forward TG) + the listener port.
    region = os.environ.get("AWS_REGION", "ap-northeast-2")
    elb = boto3.client("elbv2", region_name=region)
    rows = []
    failures = []
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
                failures.append(_safe_sdk_failure_type(e))
        lb_marker = lbs.get("NextMarker")
        if not lb_marker:
            break
    return _sdk_collection(rows, "resource_id", "region", failures)


def _fetch_s3_public_access(s3=None):
    """Per-bucket S3 public-access flags (denial-safe), for the /security Public-S3 finding.
    Steampipe's aws_s3_bucket public-access columns trigger per-bucket GetBucketPolicyStatus/
    GetPublicAccessBlock, and ONE denied bucket fails the WHOLE table query — so source via boto3
    and tolerate per-bucket AccessDenied. STRICTLY READ-ONLY (List/Get only).
    NoSuchPublicAccessBlock => no PAB configured => blocks are effectively False (a real signal);
    NoSuchBucketPolicy => no bucket policy at all => policy is definitively NOT public => False
    (kept in lockstep with _fetch_s3_security's identical call — the two types must never carry
    different semantics for the same column on the same bucket);
    AccessDenied => genuinely unknown => leave None (FINDING_SQL treats None as non-public)."""
    s3 = s3 or boto3.client("s3", region_name=os.environ.get("AWS_REGION", "ap-northeast-2"))
    rows = []
    failures = []
    unknown_attrs = 0
    for b in s3.list_buckets().get("Buckets", []) or []:
        name = b["Name"]
        transient_failed = False
        denied_attrs = []
        try:
            loc = s3.get_bucket_location(Bucket=name).get("LocationConstraint")
            region = loc or "us-east-1"  # null LocationConstraint => us-east-1
        except ClientError as e:
            # Never upsert under region "" — that lands a NEW row under a different
            # conflict key while the partial run skips both prune phases, leaving the
            # old-region row AND the ""-region row for the same bucket. Skip the bucket
            # for this run instead: counting the failure keeps the run partial, so the
            # bucket's last-good row is preserved by the skipped prunes.
            failures.append(_safe_sdk_failure_type(e))
            continue
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
            code = e.response.get("Error", {}).get("Code")
            # The live API returns "NoSuchPublicAccessBlockConfiguration"; the short
            # "NoSuchPublicAccessBlock" is kept for compatibility. Matching only the short
            # form made every PAB-less bucket (the common case) count as a transient
            # failure — rec skipped, run permanently partial, last_success_at frozen.
            if code in ("NoSuchPublicAccessBlockConfiguration", "NoSuchPublicAccessBlock"):
                rec["block_public_acls"] = False
                rec["block_public_policy"] = False
                rec["restrict_public_buckets"] = False
                rec["ignore_public_acls"] = False
            elif code in _S3_STEADY_DENIAL_CODES:
                # steady-state denial -> leave None (unknown) WITHOUT counting toward
                # sdk_partial (see _S3_STEADY_DENIAL_CODES); disclosed on the ledger as an
                # unknown attribute so freshness can degrade without blocking pruning.
                unknown_attrs += 1
                denied_attrs.extend([
                    "block_public_acls", "block_public_policy",
                    "restrict_public_buckets", "ignore_public_acls",
                ])
            else:
                failures.append(_safe_sdk_failure_type(e))
                transient_failed = True
        try:
            rec["bucket_policy_is_public"] = (
                s3.get_bucket_policy_status(Bucket=name).get("PolicyStatus", {}).get("IsPublic"))
        except ClientError as e:
            code = e.response.get("Error", {}).get("Code")
            if code == "NoSuchBucketPolicy":
                # NoSuchBucketPolicy → definitively not public via policy (False, in
                # lockstep with _fetch_s3_security's gap-L240 handler).
                rec["bucket_policy_is_public"] = False
            elif code in _S3_STEADY_DENIAL_CODES:
                # steady-state denial → unknown (None), uncounted as a failure but disclosed
                unknown_attrs += 1
                denied_attrs.append("bucket_policy_is_public")
            else:
                failures.append(_safe_sdk_failure_type(e))
                transient_failed = True
        if transient_failed:
            # A transiently-degraded rec must never overwrite the bucket's last-known-good
            # row content: the upsert runs BEFORE sdk_partial gates the prunes, so writing
            # this rec would null out previously-known fields while freshness reads
            # healthy-recent (fresh captured_at). Skip the rec — the counted failure keeps
            # the run partial, and the skipped prunes preserve the existing row intact.
            continue
        if denied_attrs:
            # Per-row disclosure of the blind spot: without this, upserting None over
            # previously-known values makes a known-public bucket read as clean on the
            # security page (its WHERE matches only explicit true/false), indistinguishable
            # from verified-private. The row-level marker lets readers render
            # "unassessable" instead of silence; the per-type unknown_attribute_count
            # aggregate alone names neither the bucket nor the fields.
            rec["attributes_unknown"] = denied_attrs
        rows.append(rec)
    return _sdk_collection(rows, "name", "region", failures, unknown_attrs)


def _fetch_s3_security(s3=None):
    """S3 buckets WITH per-bucket security flags (versioning/encryption/logging) — denial-safe
    boto3 (one denied bucket degrades to None flags, never fails the sweep). Replaces the
    Steampipe ListBuckets-lite `s3` sync so the menu can show v1's security columns/KPIs.
    STRICTLY READ-ONLY (List/Get only)."""
    s3 = s3 or boto3.client("s3", region_name=os.environ.get("AWS_REGION", "ap-northeast-2"))
    rows = []
    failures = []
    unknown_attrs = 0
    for b in s3.list_buckets().get("Buckets", []) or []:
        name = b["Name"]
        transient_failed = False
        denied_attrs = []
        try:
            loc = s3.get_bucket_location(Bucket=name).get("LocationConstraint")
            region = loc or "us-east-1"
        except ClientError as e:
            # Never upsert under region "" — that lands a NEW row under a different
            # conflict key while the partial run skips both prune phases, leaving the
            # old-region row AND the ""-region row for the same bucket. Skip the bucket
            # for this run instead: counting the failure keeps the run partial, so the
            # bucket's last-good row is preserved by the skipped prunes.
            failures.append(_safe_sdk_failure_type(e))
            continue
        rec = {
            "name": name, "region": region,
            "arn": f"arn:aws:s3:::{name}",
            "creation_date": b.get("CreationDate").isoformat() if b.get("CreationDate") else None,
            "versioning_enabled": None, "encryption": None, "logging_enabled": None,
            "bucket_policy_is_public": None,
        }
        try:
            v = s3.get_bucket_versioning(Bucket=name)
            rec["versioning_enabled"] = v.get("Status") == "Enabled"
        except ClientError as e:
            code = e.response.get("Error", {}).get("Code")
            if code in _S3_STEADY_DENIAL_CODES:
                # steady-state denial → unknown (None) WITHOUT counting toward sdk_partial
                # (see _S3_STEADY_DENIAL_CODES); disclosed on the ledger as an unknown
                # attribute so freshness can degrade without blocking pruning.
                unknown_attrs += 1
                denied_attrs.append("versioning_enabled")
            else:
                failures.append(_safe_sdk_failure_type(e))
                transient_failed = True
        try:
            enc = s3.get_bucket_encryption(Bucket=name)
            rules = enc.get("ServerSideEncryptionConfiguration", {}).get("Rules", [])
            algo = (rules[0].get("ApplyServerSideEncryptionByDefault", {}).get("SSEAlgorithm")
                    if rules else None)
            rec["encryption"] = algo or "enabled"
        except ClientError as e:
            code = e.response.get("Error", {}).get("Code")
            if code == "ServerSideEncryptionConfigurationNotFoundError":
                rec["encryption"] = "none"
            elif code in _S3_STEADY_DENIAL_CODES:
                # steady-state denial → unknown (None), uncounted as a failure but disclosed
                unknown_attrs += 1
                denied_attrs.append("encryption")
            else:
                failures.append(_safe_sdk_failure_type(e))
                transient_failed = True
        try:
            log = s3.get_bucket_logging(Bucket=name)
            rec["logging_enabled"] = bool(log.get("LoggingEnabled"))
        except ClientError as e:
            code = e.response.get("Error", {}).get("Code")
            if code in _S3_STEADY_DENIAL_CODES:
                # steady-state denial → unknown (None), uncounted as a failure but disclosed
                unknown_attrs += 1
                denied_attrs.append("logging_enabled")
            else:
                failures.append(_safe_sdk_failure_type(e))
                transient_failed = True
        try:
            # gap L243: per-bucket tags for the detail Tags section. NoSuchTagSet is a
            # DEFINITIVE "no tags" -> {} (v1 renders 'No tags'); a steady denial leaves the
            # key absent (unknown — the panel shows nothing, never a fabricated empty list)
            # and is disclosed via attributes_unknown; transient failures skip the rec so a
            # degraded row never overwrites last-known-good tags.
            tagset = s3.get_bucket_tagging(Bucket=name).get("TagSet", []) or []
            rec["tags"] = {t.get("Key", ""): t.get("Value", "") for t in tagset if t.get("Key")}
        except ClientError as e:
            code = e.response.get("Error", {}).get("Code")
            if code == "NoSuchTagSet":
                rec["tags"] = {}
            elif code in _S3_STEADY_DENIAL_CODES:
                unknown_attrs += 1
                denied_attrs.append("tags")
            else:
                failures.append(_safe_sdk_failure_type(e))
                transient_failed = True
        try:
            # gap L240: the Policy Private/Public flag bars chart this off the bucket row
            # itself (the separate s3_public_access fetch keeps the public-access-block
            # detail). NoSuchBucketPolicy (no bucket policy at all — the common case) is a
            # DEFINITIVE "not public via policy" → False (the _fetch_s3_public_access
            # NoSuchPublicAccessBlock→False precedent; its policy-status handler is kept in
            # lockstep); a steady denial → None (unknown), disclosed via attributes_unknown.
            rec["bucket_policy_is_public"] = (
                s3.get_bucket_policy_status(Bucket=name).get("PolicyStatus", {}).get("IsPublic"))
        except ClientError as e:
            code = e.response.get("Error", {}).get("Code")
            if code == "NoSuchBucketPolicy":
                rec["bucket_policy_is_public"] = False
            elif code in _S3_STEADY_DENIAL_CODES:
                unknown_attrs += 1
                denied_attrs.append("bucket_policy_is_public")
            else:
                failures.append(_safe_sdk_failure_type(e))
                transient_failed = True
        if transient_failed:
            # A transiently-degraded rec must never overwrite the bucket's last-known-good
            # row content: the upsert runs BEFORE sdk_partial gates the prunes, so writing
            # this rec would null out previously-known fields while freshness reads
            # healthy-recent (fresh captured_at). Skip the rec — the counted failure keeps
            # the run partial, and the skipped prunes preserve the existing row intact.
            continue
        if denied_attrs:
            # Per-row disclosure of the blind spot (see _fetch_s3_public_access for why the
            # aggregate count alone is not enough).
            rec["attributes_unknown"] = denied_attrs
        rows.append(rec)
    return _sdk_collection(rows, "name", "region", failures, unknown_attrs)


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
    failures = []
    for i in range(0, len(ids), 100):
        response = aoss.batch_get_collection(ids=ids[i : i + 100])
        detail = response.get("collectionDetails", []) or []
        failures.extend(
            _safe_sdk_response_failure_type(error)
            for error in response.get("collectionErrorDetails", []) or []
        )
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
    return _sdk_collection(rows, "name", "region", failures)


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


def _new_run_token():
    return uuid.uuid4().hex


def _finalize_sync_ledger(
    resource_type, run_token, status, row_count=None, error=None,
    unknown_attribute_count=0,
):
    """Write one terminal ledger state on a fresh connection after main cleanup.

    The running row and durable last-success fields must remain truthful if the work connection
    cannot unlock/close, this final write fails, or a newer run has replaced this run's ownership
    token. Closing the finalizer is best-effort once its update has completed.
    """
    finalizer = None
    try:
        finalizer = _aurora()
        if status == "succeeded":
            updated = finalizer.run(
                "UPDATE inventory_sync_runs SET status='succeeded', finished_at=now(), "
                "row_count=:n, error=NULL, unknown_attribute_count=:u, last_success_at=now(), "
                "last_success_row_count=:n "
                "WHERE resource_type=:t AND account_id='self' "
                "AND run_token=:run_token RETURNING 1",
                t=resource_type,
                n=row_count,
                u=unknown_attribute_count,
                run_token=run_token,
            )
        elif status == "partial":
            updated = finalizer.run(
                "UPDATE inventory_sync_runs SET status='partial', finished_at=now(), "
                "row_count=:n, error=NULL, unknown_attribute_count=:u "
                "WHERE resource_type=:t AND account_id='self' "
                "AND run_token=:run_token RETURNING 1",
                t=resource_type,
                n=row_count,
                u=unknown_attribute_count,
                run_token=run_token,
            )
        elif status == "failed":
            updated = finalizer.run(
                "UPDATE inventory_sync_runs SET status='failed', finished_at=now(), "
                "row_count=:n, error=:e "
                "WHERE resource_type=:t AND account_id='self' "
                "AND run_token=:run_token RETURNING 1",
                t=resource_type,
                n=row_count,
                e=error,
                run_token=run_token,
            )
        else:
            raise ValueError(f"unknown inventory sync terminal status: {status}")
        if len(updated) > 1:
            raise RuntimeError("inventory sync finalizer updated multiple rows")
        return len(updated) == 1
    finally:
        if finalizer is not None:
            try:
                finalizer.close()
            except Exception:
                pass


def sync(resource_type):
    started = time.monotonic()
    if resource_type not in _ALLOWED:
        return {"error": f"unknown type {resource_type}"}
    adb = None
    locked = False
    result = None
    terminal_event = None
    terminal_fields = None
    pending_ledger_status = None
    pending_ledger_row_count = None
    pending_ledger_error = None
    run_token = None
    sdk_failure_count = 0
    sdk_unknown_attrs = 0
    sdk_failure_types = []
    sdk_partial = False
    try:
        run_token = _new_run_token()
        adb = _aurora()
        # advisory lock per type (no Steampipe stampede); skip if busy
        got = adb.run("SELECT pg_try_advisory_lock(hashtext(:t))", t=f"inv:{resource_type}")
        if not got[0][0]:
            result = {"status": "busy", "type": resource_type}
            terminal_event = "inventory_sync_busy"
            terminal_fields = {
                "resource_type": resource_type,
                "degraded": True,
                "throttled": False,
            }
        else:
            locked = True
            # NOTE (M4): inventory_sync_runs is a JOB-LEVEL ledger — one row per resource_type keyed
            # under the host 'self' sentinel, tracking the aggregator run's status/row_count. It is
            # intentionally NOT per-account: a single aggregator run covers every connected account at
            # once. Per-account freshness is the captured_at on each inventory_resources row (which IS
            # keyed by real account_id), so no per-account state is lost.
            # mark running INSIDE the try so a throw here records 'failed' and the finally still unlocks
            adb.run(
                "INSERT INTO inventory_sync_runs "
                "(resource_type, status, started_at, finished_at, row_count, error, "
                "unknown_attribute_count, run_token) "
                "VALUES (:t,'running',now(),NULL,NULL,NULL,NULL,:run_token) "
                "ON CONFLICT (resource_type, account_id) DO UPDATE SET "
                "status='running', started_at=now(), finished_at=NULL, row_count=NULL, error=NULL, "
                "unknown_attribute_count=NULL, run_token=:run_token",
                t=resource_type,
                run_token=run_token,
            )
            expected_target_accounts = (
                [] if resource_type in SDK_SYNCS else _enabled_target_accounts(adb)
            )
            # SDK-sourced types bypass Steampipe; both paths yield list[dict] rows (recs).
            if resource_type in SDK_SYNCS:
                recs, id_col, region_col, sdk_metadata = _normalize_sdk_collection(
                    SDK_SYNCS[resource_type]()
                )
                sdk_failure_count = sdk_metadata["failure_count"]
                sdk_unknown_attrs = sdk_metadata["unknown_attribute_count"]
                sdk_failure_types = sdk_metadata["failure_types"]
                sdk_partial = sdk_failure_count > 0
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
            # Assumption (documented, not newly introduced): Steampipe partiality is
            # connection-level — an intra-connection region/page error fails the whole
            # table scan (run records 'failed', no prune) rather than silently omitting
            # rows, so an account that returned SOME rows can be treated as fully
            # present. Connection-level omission is handled by the reachability probe
            # below; SDK collectors handle sub-call failures via sdk_partial.
            present = {a for (a, _, _) in seen}
            unreachable_accounts = set()
            if not sdk_partial:
                adb.run(PHASE1_PRUNE_SQL, t=resource_type)
                # Phase 2 — row-level stale within enabled/in-scope accounts: delete individual
                # rows not returned in this run, but only for accounts proven present/reachable.
                # An SDK sub-call failure makes the entire type incomplete, so both prune phases
                # are skipped above and below; successful rows are upserted while last-good rows
                # remain intact.
                # M-2 (round 8): host ('self') protection must be symmetric with target accounts.
                if 'self' not in present:
                    if resource_type in SDK_SYNCS or _account_reachable(_caller_account()):
                        present.add('self')
                    else:
                        unreachable_accounts.add('self')
                if resource_type not in SDK_SYNCS:
                    for acct_id in expected_target_accounts:
                        if acct_id not in present:
                            if _account_reachable(acct_id):
                                present.add(acct_id)
                            else:
                                unreachable_accounts.add(acct_id)
                existing = adb.run(
                    "SELECT account_id, region, resource_id FROM inventory_resources "
                    "WHERE resource_type=:t",
                    t=resource_type,
                )
                for acct, rg, rid in existing:
                    if str(acct) in present and (str(acct), str(rg), str(rid)) not in seen:
                        adb.run(
                            "DELETE FROM inventory_resources WHERE resource_type=:t "
                            "AND account_id=:acct AND region=:rg AND resource_id=:id",
                            t=resource_type,
                            acct=acct,
                            rg=rg,
                            id=rid,
                        )
            if sdk_partial:
                pending_ledger_status = "partial"
                pending_ledger_row_count = len(recs)
                result = {
                    "status": "partial",
                    "type": resource_type,
                    "row_count": len(recs),
                    "failure_count": sdk_failure_count,
                    "failure_types": sdk_failure_types,
                    "unknown_attribute_count": sdk_unknown_attrs,
                }
                terminal_event = "inventory_sync_complete"
                terminal_fields = {
                    "resource_type": resource_type,
                    "row_count": len(recs),
                    "failure_count": sdk_failure_count,
                    "failure_types": sdk_failure_types,
                    "unknown_attribute_count": sdk_unknown_attrs,
                    "degraded": True,
                    "throttled": any(
                        _failure_label_is_throttling(failure_type)
                        for failure_type in sdk_failure_types
                    ),
                    "freshness": "degraded",
                    "age_minutes": None,
                }
            elif unreachable_accounts:
                pending_ledger_status = "partial"
                pending_ledger_row_count = len(recs)
                result = {
                    "status": "partial",
                    "type": resource_type,
                    "row_count": len(recs),
                    "unreachable_account_count": len(unreachable_accounts),
                }
                terminal_event = "inventory_sync_complete"
                terminal_fields = {
                    "resource_type": resource_type,
                    "row_count": len(recs),
                    "unreachable_account_count": len(unreachable_accounts),
                    "degraded": True,
                    "throttled": False,
                    "freshness": "degraded",
                    "age_minutes": None,
                }
            else:
                pending_ledger_status = "succeeded"
                pending_ledger_row_count = len(recs)
                result = {
                    "status": "succeeded",
                    "type": resource_type,
                    "row_count": len(recs),
                    "unknown_attribute_count": sdk_unknown_attrs,
                }
                terminal_event = "inventory_sync_complete"
                terminal_fields = {
                    "resource_type": resource_type,
                    "row_count": len(recs),
                    "unknown_attribute_count": sdk_unknown_attrs,
                    "degraded": bool(sdk_unknown_attrs),
                    "throttled": False,
                    # Attribute blind spots degrade the DISCLOSED freshness while the status stays
                    # succeeded — pruning and last_success_at must not be blocked by a steady
                    # denial, but readers must not be told the sweep saw everything either.
                    # Both 'degraded' and 'freshness' derive from the same signal, so a dashboard
                    # keying on either field reads the same story.
                    "freshness": "degraded" if sdk_unknown_attrs else "healthy",
                    "age_minutes": 0,
                }
            # Daily inventory_snapshots row (dashboard "리소스 추세" chart, self-scoped only —
            # see _self_count). One row per (account, day, type): delete same-day then insert,
            # matching backfill-v1.mjs's convention — a resource type can sync more than once a day.
            if not sdk_partial and 'self' in present:
                adb.run("DELETE FROM inventory_snapshots WHERE account_id='self' AND resource_type=:t "
                        "AND captured_at::date = CURRENT_DATE", t=resource_type)
                adb.run("INSERT INTO inventory_snapshots (account_id, captured_at, resource_type, resource_count) "
                        "VALUES ('self', now(), :t, :n)", t=resource_type, n=_self_count(recs))
    except Exception as e:
        if locked:
            # The sanitization threat model applies to EVERY sink, not just logs: raw
            # exception text (which can contain SQL, secrets, or resource payloads) must
            # not reach the Lambda result (the BFF forwards it to authenticated callers)
            # or the ledger error column either. Return/persist the same bounded
            # category+type vocabulary the structured logs use; detail stays server-side.
            error_category = "sync"
            error = f"{error_category} failed: {type(e).__name__}"
            result = {"status": "failed", "type": resource_type, "error": error}
            pending_ledger_status = "failed"
            pending_ledger_error = error
        else:
            result = {"status": "failed", "type": resource_type, "error": "inventory sync failed"}
            error_category = "lifecycle"
        terminal_event = "inventory_sync_failed"
        terminal_fields = {
            "resource_type": resource_type,
            "error_category": error_category,
            "error": "inventory sync failed",
            "error_type": type(e).__name__,
            "degraded": True,
            "throttled": _is_throttling_error(e),
        }
    finally:
        cleanup_error = None
        if adb is not None:
            if locked:
                # Unlock BEFORE ledger finalization is deliberate: pg advisory locks are
                # session-scoped, so the fresh finalizer connection could never hold this
                # one anyway, and the run_token CAS makes the window fail-safe — a run
                # superseded here loses its last_success_at advance and reports
                # "superseded" (freshness may under-report, never corrupt).
                try:
                    adb.run("SELECT pg_advisory_unlock(hashtext(:t))", t=f"inv:{resource_type}")
                except Exception as e:
                    cleanup_error = e
            try:
                adb.close()
            except Exception as e:
                if cleanup_error is None:
                    cleanup_error = e
        if cleanup_error is not None and terminal_fields is not None:
            result = {
                "status": "failed",
                "type": resource_type,
                "error": "inventory sync cleanup failed",
            }
            pending_ledger_status = "failed"
            pending_ledger_error = "inventory sync cleanup failed"
            terminal_event = "inventory_sync_failed"
            terminal_fields = {
                "resource_type": resource_type,
                "error_category": "cleanup",
                "error": "inventory sync cleanup failed",
                "error_type": type(cleanup_error).__name__,
                "degraded": True,
                "throttled": _is_throttling_error(cleanup_error),
            }
        if locked and terminal_fields is not None and pending_ledger_status is not None:
            try:
                finalized = _finalize_sync_ledger(
                    resource_type,
                    run_token,
                    pending_ledger_status,
                    row_count=pending_ledger_row_count,
                    error=pending_ledger_error,
                    # Only the succeeded/partial statements write this column; 'failed' leaves
                    # the previous disclosure untouched.
                    unknown_attribute_count=sdk_unknown_attrs,
                )
                if not finalized:
                    result = {
                        "status": "failed",
                        "type": resource_type,
                        "error": "inventory sync superseded",
                    }
                    terminal_event = "inventory_sync_failed"
                    terminal_fields = {
                        "resource_type": resource_type,
                        "error_category": "superseded",
                        "error": "inventory sync superseded",
                        "error_type": "SupersededRun",
                        "degraded": True,
                        "throttled": False,
                    }
            except Exception as e:
                # Preserve a real work/cleanup failure as the one terminal outcome. If the work
                # itself was otherwise successful/partial, the failed finalizer becomes the
                # lifecycle failure. In every case the durable row remains running with its
                # previous last-success values because no terminal update ran on the main
                # connection.
                if terminal_event != "inventory_sync_failed":
                    result = {
                        "status": "failed",
                        "type": resource_type,
                        "error": "inventory sync failed",
                    }
                    terminal_event = "inventory_sync_failed"
                    terminal_fields = {
                        "resource_type": resource_type,
                        "error_category": "lifecycle",
                        "error": "inventory sync failed",
                        "error_type": type(e).__name__,
                        "degraded": True,
                        "throttled": _is_throttling_error(e),
                    }
        if terminal_fields is not None:
            terminal_fields["elapsed_ms"] = int((time.monotonic() - started) * 1000)
            _log(terminal_event, **terminal_fields)
    return result


def lambda_handler(event, ctx):
    rtype = (event or {}).get("type", "all")
    if rtype == "all":
        types = list(QUERIES) + list(SDK_SYNCS)
        queued_types = []
        failed_types = []
        for rt in types:
            try:
                response = _lambda.invoke(
                    FunctionName=ctx.invoked_function_arn,
                    InvocationType="Event",
                    Payload=json.dumps({"type": rt}).encode(),
                )
                if response.get("StatusCode") == 202:
                    queued_types.append(rt)
                else:
                    failed_types.append(rt)
            except Exception:
                failed_types.append(rt)
        status = (
            "failed" if not queued_types
            else "partial" if failed_types
            else "dispatched"
        )
        result = {
            "status": status,
            "queued_count": len(queued_types),
            "failed_count": len(failed_types),
            "queued_types": queued_types,
            "failed_types": failed_types,
        }
        _log("inventory_sync_dispatch", type_count=len(types), **result)
        return result
    return sync(rtype)
