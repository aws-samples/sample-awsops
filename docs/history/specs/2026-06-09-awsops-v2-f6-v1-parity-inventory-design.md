# AWSops v2 — F6 v1-Parity Inventory Fields Design

**Status:** Accepted. 2026-06-09. Directive: "v1과 비교해 최소한 기능이 축소된 것은 없도록" — v2's stored per-resource `data` (detail panel) + table columns must cover **at least** v1's `detail`/`list` query fields. Source: a full v1→v2 field-parity gap map over `src/lib/queries/*.ts` vs `scripts/v2/steampipe/sync_lambda.py` + `web/lib/inventory-types.ts`. **ec2 already done** (this spec covers the other 21 types).

## Principles
- **Expand each type's sync SELECT to the v1 `detail` field set** (so the F4 detail panel ⊇ v1's panel) **+ `arn` + `tags`** (missing almost everywhere; highest-leverage). Expand each type's **table columns to the v1 `list` key fields** (+ a `name` from `tags ->> 'Name'` where v1 did).
- **JSONB columns stored as objects** (NOT `::text`) — the v2 DetailPanel pretty-prints objects/arrays. (security_group ip_permissions, msk provisioned, opensearch *_options, ebs attachments, cloudfront origins/aliases, elasticache cache_nodes/security_groups, waf rules/default_action, dynamodb key_schema, rds vpc_security_groups, etc.)
- **Exclusions (safety, NOT feature-reduction):**
  - **s3**: do NOT add `versioning_enabled`/`bucket_policy_is_public`/`server_side_encryption_configuration`/`logging`/`lifecycle_rules`/`tags` — each triggers a per-bucket Get* API that an explicit-deny bucket policy fails the WHOLE query on (the documented D2 s3 incident). Add ONLY `arn` (computed, safe). Note the parity caveat for s3.
  - **rds, elasticache metrics**: the v1 `rdsMetrics`/`ecMetrics` CloudWatch-`aws_cloudwatch_metric_statistic_data_point` JOINs are live/time-windowed/heavy → NOT stored in the snapshot. Add all the NON-metric detail fields; the live metrics belong to the F5 metric-cards feature (a later RDS/ElastiCache extension). NOT a reduction (v1's metrics were a separate live query too).
- A wrong/heavy column surfaces at re-sync as that type's `inventory_sync_runs.status='failed'` → fix that type's SELECT + re-sync (per-type isolation).

## Per-type target (data SELECT columns = stored `data`; table cols = `inventory-types.ts`)
Steampipe `aws_*` columns (same plugin v1 used → names valid). Always also select region/account_id (identity). `name` = `(tags ->> 'Name')`.

| type | table | id_col | target data SELECT (beyond identity) | table columns |
|------|-------|--------|----------------------------------------|---------------|
| s3 | aws_s3_bucket | name | arn, creation_date | creation_date |
| lambda | aws_lambda_function | name | arn, runtime, handler, code_size, memory_size, timeout, last_modified, version, state, last_update_status, package_type, architectures, layers, vpc_id, vpc_subnet_ids, vpc_security_group_ids, description, code_sha_256 | runtime, memory_size, timeout, state, handler, last_modified |
| ecs_cluster | aws_ecs_cluster | cluster_name | cluster_arn, status, running_tasks_count, pending_tasks_count, active_services_count, registered_container_instances_count, settings, tags | status, running_tasks_count, pending_tasks_count, active_services_count, registered_container_instances_count |
| ecr | aws_ecr_repository | repository_name | arn, registry_id, repository_uri, image_tag_mutability, image_scanning_configuration, encryption_configuration, lifecycle_policy, created_at, tags | repository_uri, image_tag_mutability, created_at |
| ebs_volume | aws_ebs_volume | volume_id | arn, volume_type, size, state, encrypted, iops, throughput, availability_zone, create_time, snapshot_id, kms_key_id, multi_attach_enabled, attachments, tags, name | name, volume_type, size, state, encrypted, iops, availability_zone, create_time |
| rds | aws_rds_db_instance | db_instance_identifier | arn, engine, engine_version, class, status, multi_az, publicly_accessible, allocated_storage, storage_type, storage_encrypted, kms_key_id, vpc_id, db_subnet_group_name, availability_zone, endpoint_address, endpoint_port, backup_retention_period, preferred_backup_window, latest_restorable_time, vpc_security_groups, auto_minor_version_upgrade, copy_tags_to_snapshot, deletion_protection, iam_database_authentication_enabled, performance_insights_enabled, create_time, tags | engine, engine_version, class, status, multi_az, publicly_accessible, allocated_storage, vpc_id |
| dynamodb | aws_dynamodb_table | name | arn, table_status, billing_mode, item_count, table_size_bytes, read_capacity, write_capacity, key_schema, point_in_time_recovery_description, sse_description, creation_date_time, tags | table_status, billing_mode, item_count, table_size_bytes |
| vpc | aws_vpc | vpc_id | arn, cidr_block, state, is_default, instance_tenancy, dhcp_options_id, owner_id, tags, name | name, cidr_block, state, is_default, instance_tenancy, owner_id |
| subnet | aws_vpc_subnet | subnet_id | subnet_arn, vpc_id, cidr_block, state, owner_id, availability_zone, availability_zone_id, available_ip_address_count, map_public_ip_on_launch, default_for_az, assign_ipv6_address_on_creation, tags, name | name, vpc_id, cidr_block, state, availability_zone, available_ip_address_count, map_public_ip_on_launch |
| security_group | aws_vpc_security_group | group_id | arn, group_name, vpc_id, description, owner_id, ip_permissions, ip_permissions_egress, tags, name | name, group_name, vpc_id, description |
| iam_role | aws_iam_role | name | arn, role_id, create_date, path, description, max_session_duration, role_last_used_date, role_last_used_region, instance_profile_arns, permissions_boundary_arn, assume_role_policy, tags | create_date, path, role_id, max_session_duration |
| iam_user | aws_iam_user | name | arn, user_id, create_date, path, password_last_used, mfa_enabled, tags | create_date, path, mfa_enabled, password_last_used |
| cloudfront | aws_cloudfront_distribution | id | arn, domain_name, status, enabled, e_tag, http_version, is_ipv6_enabled, price_class, web_acl_id, default_cache_behavior, origins, aliases, cache_behaviors, tags, name | domain_name, status, enabled, price_class |
| alb | aws_ec2_application_load_balancer | name | arn, type, scheme, state_code, vpc_id, dns_name, ip_address_type, canonical_hosted_zone_id, availability_zones, security_groups, created_time, tags | scheme, vpc_id, state_code, dns_name, ip_address_type, created_time |
| nlb | aws_ec2_network_load_balancer | name | arn, type, scheme, state_code, vpc_id, dns_name, ip_address_type, canonical_hosted_zone_id, availability_zones, security_groups, created_time, tags | scheme, vpc_id, state_code, dns_name, ip_address_type, created_time |
| elasticache | aws_elasticache_cluster | cache_cluster_id | arn, engine, engine_version, cache_node_type, cache_cluster_status, num_cache_nodes, replication_group_id, preferred_availability_zone, cache_subnet_group_name, at_rest_encryption_enabled, transit_encryption_enabled, auth_token_enabled, auto_minor_version_upgrade, snapshot_retention_limit, snapshot_window, preferred_maintenance_window, cache_cluster_create_time, security_groups, tags | engine, engine_version, cache_node_type, cache_cluster_status, num_cache_nodes |
| opensearch | aws_opensearch_domain | domain_name | arn, domain_id, engine_type, engine_version, processing, created, deleted, endpoint, node_to_node_encryption_options_enabled, encryption_at_rest_options, cluster_config, vpc_options, ebs_options, endpoints, cognito_options, advanced_security_options, tags | engine_version, processing, created, endpoint |
| msk | aws_msk_cluster | cluster_name | arn, state, cluster_type, current_version, creation_time, provisioned, tags | state, cluster_type, current_version |
| waf | aws_wafv2_web_acl | name | id, arn, scope, capacity, description, default_action, rules, visibility_config, managed_by_firewall_manager, tags | scope, capacity, description, managed_by_firewall_manager |
| cloudwatch_alarm | aws_cloudwatch_alarm | name | arn, state_value, state_reason, state_updated_timestamp, namespace, metric_name, comparison_operator, threshold, period, evaluation_periods, statistic, actions_enabled, alarm_actions, ok_actions, insufficient_data_actions | state_value, metric_name, namespace, threshold, actions_enabled |
| cloudtrail | aws_cloudtrail_trail | name | arn, home_region, is_multi_region_trail, is_logging, log_file_validation_enabled, s3_bucket_name, s3_key_prefix, sns_topic_arn, kms_key_id, log_group_arn, is_organization_trail, include_global_service_events, has_custom_event_selectors, has_insight_selectors, latest_delivery_time, latest_delivery_error, start_logging_time, tags | is_logging, is_multi_region_trail, home_region, s3_bucket_name, log_file_validation_enabled |

(id_col/region_col unchanged from current; `name` only where the table has `tags`. Boolean/JSONB columns selected as-is.)

## Testing / verify
- Unit: `inventory-types.test.ts` stays green (22 types, columns non-empty); the registry change only adds columns.
- Build clean.
- Live (controller): re-apply Lambda (sync_lambda.py change) → invoke `{type:"all"}` → assert **all 22 `inventory_sync_runs` succeeded** (a too-heavy/denied column → that type fails → fix its SELECT). Spot-check a few types' `data` field counts ⊇ v1. Then `make deploy` (table columns). Detail panels now match v1.

## Out of scope
RDS/ElastiCache live CloudWatch metric cards (F5 extension); s3 versioning/policy/tags (deny-risk — needs an error-tolerant per-bucket enrichment path, separate); per-resource relationship lookups (ebs→instance) and event sub-resources (cloudtrail events, ecs services/tasks).
