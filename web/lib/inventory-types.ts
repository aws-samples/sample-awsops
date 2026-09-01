export interface InvColumn { key: string; label: string }
// stateKey: column holding a lifecycle state — drives state KPI tiles + the state filter.
// distKey: column to chart a distribution donut by. Both optional; both reference a columns[].key.
// sections (optional): group the DetailPanel fields into ordered, labelled sections.
// Each `keys` entry references resource_id/region or a columns[].key; absent keys are skipped,
// leftover keys fall into an "Other" group. Types without `sections` render a flat list.
export interface InvType {
  label: string; group: string; columns: InvColumn[]; stateKey?: string; distKey?: string;
  /** Optional second distribution dimension — rendered as a second donut beside the first. */
  distKey2?: string;
  /** Default worst-first row ordering (gap L68): rank rows by `rank[cell(col)]` ascending
   *  (unknown values rank AFTER known ones — surfaced, never hidden), tie-broken by `tieBreak`
   *  DESC (e.g. newest state change first). Applied by the page BEFORE DataTable, so a user's
   *  own column-header sort still overrides it. */
  worstFirst?: { col: string; rank: Record<string, number>; tieBreak?: string };
  /** Semantic slice colors for the distKey2 donut, keyed by the RAW cell value (case-sensitive —
   *  the donut buckets raw values, unlike countWhere's case-insensitive compare). Unmapped
   *  values fall back to the positional palette. */
  distKey2Colors?: Record<string, string>;
  /** Optional Top-N metric bar chart: numeric column ranked desc over the row set. */
  barKey?: { col: string; label: string };
  /** Optional value-distribution histogram (gap L135): row COUNTS per distinct numeric value
   *  of `col` (top 10 by count, then numerically sorted; e.g. lambda functions per
   *  memory_size). Rendered beside the Top-N bar as a second BarDistribution. */
  histKey?: { col: string; label: string; suffix?: string };
  sections?: { label: string; keys: string[] }[];
  /** Raw row keys replaced by derived/structured fields (gap L150) — buildDetailGroups marks
   *  them used-but-hidden so they neither render in a section nor leak into "Other". */
  hideKeys?: string[];
  // filterKeys (optional, v1-parity facet filters): row keys rendered as dropdown facets above
  // the table (each option shows a live count). The stateKey already has its own SegmentedControl,
  // so list OTHER discriminating keys here (e.g. ec2 type/vpc, lambda runtime). Keys need not be
  // table columns — non-column keys (e.g. region) get their label from the page's FACET_LABELS.
  filterKeys?: string[];
}

// Worst-first default ordering (gap L68): rank by spec.worstFirst.rank ascending (unknown
// values rank AFTER known ones — surfaced, never hidden), tie-broken by tieBreak DESC
// (newest state change first). The page applies it before DataTable, so a user's own
// column-header sort still overrides it. Pure — unit-tested alongside computeHighlights.
export function worstFirst<T extends Record<string, unknown>>(
  rows: T[],
  wf: { col: string; rank: Record<string, number>; tieBreak?: string },
): T[] {
  // Case-insensitive rank lookup — the rest of the pipeline compares state values
  // case-insensitively (summary SQL lower(), countWhere), so a casing drift must not
  // silently disable the default ordering.
  const norm: Record<string, number> = {};
  for (const [k, v] of Object.entries(wf.rank)) norm[k.toLowerCase()] = v;
  const rank = (r: T) => norm[String(r[wf.col] ?? '').toLowerCase()] ?? Number.MAX_SAFE_INTEGER;
  return [...rows].sort((a, b) => {
    const d = rank(a) - rank(b);
    if (d !== 0) return d;
    if (!wf.tieBreak) return 0;
    // numeric:true matches DataTable.compareValues' semantics for mixed numeric strings.
    return String(b[wf.tieBreak] ?? '').localeCompare(String(a[wf.tieBreak] ?? ''), undefined, { numeric: true });
  });
}

// resource_id + region are prepended by the page; columns here are the type-specific extras.
export const INVENTORY_TYPES: Record<string, InvType> = {
  ec2: { label: 'EC2 Instances', group: 'Compute', stateKey: 'instance_state', distKey: 'instance_type', distKey2: 'instance_state', barKey: { col: 'memory_mib', label: 'Memory (MiB)' }, columns: [
    { key: 'name', label: 'Name' }, { key: 'instance_type', label: 'Type' }, { key: 'instance_state', label: 'State' },
    { key: 'pricing_model', label: 'Pricing' },
    { key: 'private_ip_address', label: 'Private IP' }, { key: 'public_ip_address', label: 'Public IP' },
    { key: 'subnet_id', label: 'Subnet' }, { key: 'vpc_id', label: 'VPC' }, { key: 'launch_time', label: 'Launch' } ],
    // v1-parity detail categories (v1 src/app/ec2/page.tsx side panel): Instance / Compute /
    // Network / Security Groups / Storage / Tags / Image. Keys match sync_lambda.py's ec2 SELECT.
    sections: [
      { label: 'Instance', keys: ['resource_id', 'name', 'account_id', 'region', 'placement_availability_zone', 'placement_tenancy', 'key_name', 'iam_instance_profile_arn', 'monitoring_state', 'launch_time', 'state_transition_time'] },
      { label: 'Compute', keys: ['instance_type', 'instance_state', 'pricing_model', 'vcpus', 'cpu_options_core_count', 'cpu_options_threads_per_core', 'memory_mib', 'network_performance', 'instance_storage_supported'] },
      { label: 'Network', keys: ['private_ip_address', 'private_dns_name', 'public_ip_address', 'public_dns_name', 'vpc_id', 'subnet_id', 'max_enis', 'ena_support', 'network_interfaces'] },
      { label: 'Security Groups', keys: ['security_groups'] },
      { label: 'Storage', keys: ['root_device_name', 'root_device_type', 'ebs_optimized', 'block_device_mappings'] },
      { label: 'Tags', keys: ['tags'] },
      { label: 'Image', keys: ['image_id', 'architecture', 'platform_details', 'virtualization_type', 'hypervisor'] },
    ],
    filterKeys: ['region', 'name', 'instance_type', 'pricing_model', 'subnet_id', 'vpc_id'] },
  lambda: { label: 'Lambda Functions', group: 'Compute', stateKey: 'state', distKey: 'runtime', distKey2: 'package_type', barKey: { col: 'memory_size', label: 'Memory (MB)' },
    histKey: { col: 'memory_size', label: 'Memory Allocation', suffix: ' MB' }, columns: [
    { key: 'runtime', label: 'Runtime' }, { key: 'memory_size', label: 'Mem(MB)' },
    { key: 'timeout', label: 'Timeout(s)' }, { key: 'state', label: 'State' },
    { key: 'handler', label: 'Handler' }, { key: 'last_modified', label: 'Modified' } ],
    sections: [
      { label: 'Identity', keys: ['resource_id', 'name', 'account_id', 'region', 'arn', 'description', 'version', 'last_modified'] },
      { label: 'Runtime', keys: ['runtime', 'handler', 'package_type', 'architectures', 'state', 'last_update_status'] },
      { label: 'Capacity', keys: ['memory_size', 'timeout', 'code_size', 'code_sha_256', 'layers'] },
      { label: 'Network', keys: ['vpc_id', 'vpc_subnet_ids', 'vpc_security_group_ids'] },
    ],
    filterKeys: ['region', 'runtime', 'memory_size', 'timeout', 'vpc_id'] },
  ecs_cluster: { label: 'ECS Clusters', group: 'Compute', stateKey: 'status', distKey: 'status', distKey2: 'region', barKey: { col: 'running_tasks_count', label: 'Running Tasks' }, columns: [
    { key: 'status', label: 'Status' }, { key: 'running_tasks_count', label: 'Running' },
    { key: 'pending_tasks_count', label: 'Pending' }, { key: 'active_services_count', label: 'Services' },
    { key: 'registered_container_instances_count', label: 'Instances' },
    { key: 'mtd_cost_usd', label: 'MTD Cost ($)' } ],
    sections: [
      { label: 'Identity', keys: ['resource_id', 'cluster_name', 'account_id', 'region', 'cluster_arn'] },
      { label: 'Tasks & Services', keys: ['status', 'running_tasks_count', 'pending_tasks_count', 'active_services_count', 'registered_container_instances_count'] },
      { label: 'Config', keys: ['settings'] },
      { label: 'Tags', keys: ['tags'] },
    ],
    filterKeys: ['region'] },
  ecs_service: { label: 'ECS Services', group: 'Compute', stateKey: 'status', distKey: 'launch_type', distKey2: 'status', barKey: { col: 'running_count', label: 'Running' }, columns: [
    { key: 'service_name', label: 'Service' }, { key: 'status', label: 'Status' },
    { key: 'desired_count', label: 'Desired' }, { key: 'running_count', label: 'Running' },
    { key: 'pending_count', label: 'Pending' }, { key: 'launch_type', label: 'Launch' },
    { key: 'scheduling_strategy', label: 'Strategy' }, { key: 'cluster_arn', label: 'Cluster' },
    { key: 'task_definition', label: 'Task def' }, { key: 'created_at', label: 'Created' } ],
    sections: [
      { label: 'Identity', keys: ['resource_id', 'service_name', 'service_key', 'account_id', 'region', 'cluster_arn', 'created_at'] },
      { label: 'Service', keys: ['status', 'desired_count', 'running_count', 'pending_count', 'launch_type', 'scheduling_strategy', 'task_definition'] },
      { label: 'Tags', keys: ['tags'] },
    ],
    filterKeys: ['region', 'service_name', 'desired_count', 'launch_type', 'cluster_arn'] },
  ecs_task: { label: 'ECS Tasks', group: 'Compute', stateKey: 'last_status', distKey: 'launch_type', distKey2: 'cluster_h', barKey: { col: 'cost_day_num', label: 'Daily $ (Fargate est.)' }, filterKeys: ['region', 'cluster_h', 'launch_type', 'cpu_h', 'memory_h', 'availability_zone'], columns: [
    { key: 'task_short', label: 'Task' }, { key: 'cluster_h', label: 'Cluster' }, { key: 'task_group', label: 'Group' }, { key: 'last_status', label: 'Status' },
    { key: 'launch_type', label: 'Launch' }, { key: 'cpu_h', label: 'CPU' }, { key: 'memory_h', label: 'Memory' },
    { key: 'cost_day_h', label: 'Cost/Day' }, { key: 'cost_month_h', label: 'Cost/Mo' },
    { key: 'availability_zone', label: 'AZ' }, { key: 'started_h', label: 'Started' } ],
    sections: [
      { label: 'Identity', keys: ['resource_id', 'account_id', 'region', 'cluster_arn', 'task_group', 'task_definition_arn'] },
      { label: 'Task', keys: ['last_status', 'launch_type'] },
      { label: 'Containers', keys: ['containers', 'attachments'] },
    ] },
  ecr: { label: 'ECR Repositories', group: 'Compute', distKey: 'image_tag_mutability', columns: [
    { key: 'repository_uri', label: 'URI' }, { key: 'image_tag_mutability', label: 'Tag mutability' },
    // Repository-level basic scanning setting — registry-level Inspector enhanced scanning is not represented here.
    { key: 'scan_on_push', label: 'Scan on Push (Basic)' }, { key: 'created_at', label: 'Created' } ],
    sections: [
      { label: 'Identity', keys: ['resource_id', 'repository_name', 'account_id', 'region', 'arn', 'registry_id', 'repository_uri', 'created_at'] },
      { label: 'Config', keys: ['image_tag_mutability', 'scan_on_push', 'image_scanning_configuration', 'lifecycle_policy'] },
      { label: 'Security', keys: ['encryption_configuration'] },
      { label: 'Tags', keys: ['tags'] },
    ],
    filterKeys: ['region', 'image_tag_mutability'] },
  s3: { label: 'S3 Buckets', group: 'Storage & DB', distKey: 'region', distKey2: 'encryption', filterKeys: ['region', 'versioning_enabled', 'encryption', 'logging_enabled'], columns: [
    { key: 'versioning_enabled', label: 'Versioning' }, { key: 'encryption', label: 'Encryption' },
    { key: 'logging_enabled', label: 'Logging' }, { key: 'creation_date', label: 'Created' } ],
    sections: [
      { label: 'Identity', keys: ['resource_id', 'name', 'account_id', 'region', 'arn', 'creation_date'] },
      { label: 'Security', keys: ['versioning_enabled', 'encryption', 'logging_enabled'] },
    ] },
  ebs_volume: { label: 'EBS Volumes', group: 'Storage & DB', stateKey: 'state', distKey: 'volume_type', distKey2: 'encrypted', columns: [
    { key: 'name', label: 'Name' }, { key: 'volume_type', label: 'Type' }, { key: 'size', label: 'Size(GB)' },
    { key: 'state', label: 'State' }, { key: 'attached_to', label: 'Attached To' }, { key: 'encrypted', label: 'Encrypted' }, { key: 'iops', label: 'IOPS' },
    { key: 'availability_zone', label: 'AZ' }, { key: 'create_time', label: 'Created' } ],
    sections: [
      { label: 'Identity', keys: ['resource_id', 'name', 'account_id', 'region', 'arn', 'availability_zone', 'create_time'] },
      { label: 'Storage', keys: ['volume_type', 'size', 'state', 'iops', 'multi_attach_enabled', 'snapshot_id'] },
      { label: 'Security', keys: ['encrypted', 'kms_key_id'] },
      { label: 'Attachments', keys: ['attachments'] },
      { label: 'Tags', keys: ['tags'] },
    ],
    filterKeys: ['region', 'name', 'volume_type', 'encrypted', 'availability_zone'] },
  ebs_snapshot: { label: 'EBS Snapshots', group: 'Storage & DB', stateKey: 'state', distKey: 'state', distKey2: 'encrypted', barKey: { col: 'volume_size', label: 'Volume Size (GB)' }, columns: [
    { key: 'volume_id', label: 'Volume' }, { key: 'volume_size', label: 'Size(GB)' },
    { key: 'state', label: 'State' }, { key: 'progress', label: 'Progress' },
    { key: 'encrypted', label: 'Encrypted' }, { key: 'start_time', label: 'Started' },
    { key: 'description', label: 'Description' } ],
    sections: [
      { label: 'Identity', keys: ['resource_id', 'account_id', 'region', 'arn', 'owner_id', 'description', 'start_time'] },
      { label: 'Snapshot', keys: ['volume_id', 'volume_size', 'state', 'progress'] },
      { label: 'Security', keys: ['encrypted'] },
      { label: 'Tags', keys: ['tags'] },
    ],
    filterKeys: ['region', 'encrypted'] },
  rds: { label: 'RDS Instances', group: 'Storage & DB', stateKey: 'status', distKey: 'engine', distKey2: 'class', barKey: { col: 'allocated_storage', label: 'Storage (GB)' }, columns: [
    { key: 'engine', label: 'Engine' }, { key: 'engine_version', label: 'Version' },
    { key: 'class', label: 'Class' }, { key: 'status', label: 'Status' }, { key: 'multi_az', label: 'Multi-AZ' },
    { key: 'publicly_accessible', label: 'Public' }, { key: 'allocated_storage', label: 'Storage(GB)' }, { key: 'vpc_id', label: 'VPC' } ],
    sections: [
      { label: 'Identity', keys: ['resource_id', 'account_id', 'region', 'arn', 'availability_zone', 'create_time'] },
      { label: 'Engine', keys: ['engine', 'engine_version', 'class', 'status', 'multi_az', 'auto_minor_version_upgrade'] },
      { label: 'Endpoint', keys: ['endpoint_address', 'endpoint_port', 'publicly_accessible'] },
      { label: 'Network', keys: ['vpc_id', 'db_subnet_group_name', 'vpc_security_groups'] },
      { label: 'Storage', keys: ['allocated_storage', 'storage_type', 'storage_encrypted', 'kms_key_id'] },
      { label: 'Backup', keys: ['backup_retention_period', 'preferred_backup_window', 'latest_restorable_time', 'copy_tags_to_snapshot', 'deletion_protection'] },
      { label: 'Security', keys: ['iam_database_authentication_enabled', 'performance_insights_enabled'] },
      { label: 'Tags', keys: ['tags'] },
    ],
    filterKeys: ['region', 'engine', 'engine_version', 'class', 'vpc_id', 'storage_type'] },
  dynamodb: { label: 'DynamoDB Tables', group: 'Storage & DB', stateKey: 'table_status', distKey: 'billing_h', distKey2: 'table_status', barKey: { col: 'item_count', label: 'Items' }, columns: [
    { key: 'table_status', label: 'Status' }, { key: 'billing_h', label: 'Billing' },
    { key: 'item_count_h', label: 'Items' }, { key: 'table_size_h', label: 'Size' }, { key: 'created_h', label: 'Created' } ],
    sections: [
      { label: 'Identity', keys: ['resource_id', 'name', 'account_id', 'region', 'arn', 'creation_date_time'] },
      { label: 'Table', keys: ['table_status', 'billing_mode', 'item_count', 'table_size_bytes', 'read_capacity', 'write_capacity', 'key_schema'] },
      { label: 'Security', keys: ['sse_h', 'pitr_h', 'key_schema', 'sse_description', 'point_in_time_recovery_description'] },
      { label: 'Tags', keys: ['tags'] },
    ],
    filterKeys: ['region', 'name'] },
  vpc: { label: 'VPCs', group: 'Network', stateKey: 'state', distKey: 'region', distKey2: 'is_default', columns: [
    { key: 'name', label: 'Name' }, { key: 'cidr_block', label: 'CIDR' }, { key: 'state', label: 'State' },
    { key: 'is_default', label: 'Default' }, { key: 'instance_tenancy', label: 'Tenancy' }, { key: 'owner_id', label: 'Owner' } ],
    sections: [
      { label: 'Identity', keys: ['resource_id', 'name', 'account_id', 'region', 'arn', 'owner_id'] },
      { label: 'Network', keys: ['cidr_block', 'state', 'is_default', 'instance_tenancy', 'dhcp_options_id'] },
      { label: 'Tags', keys: ['tags'] },
    ],
    filterKeys: ['region', 'name', 'cidr_block', 'is_default'] },
  subnet: { label: 'Subnets', group: 'Network', distKey: 'availability_zone', distKey2: 'map_public_ip_on_launch', barKey: { col: 'available_ip_address_count', label: 'Available IPs' }, columns: [
    { key: 'name', label: 'Name' }, { key: 'vpc_id', label: 'VPC' }, { key: 'cidr_block', label: 'CIDR' },
    { key: 'state', label: 'State' }, { key: 'availability_zone', label: 'AZ' },
    { key: 'available_ip_address_count', label: 'Free IPs' }, { key: 'map_public_ip_on_launch', label: 'Auto-public-IP' } ],
    sections: [
      { label: 'Identity', keys: ['resource_id', 'name', 'account_id', 'region', 'subnet_arn', 'owner_id'] },
      { label: 'Network', keys: ['vpc_id', 'cidr_block', 'state', 'availability_zone', 'availability_zone_id', 'available_ip_address_count', 'map_public_ip_on_launch', 'default_for_az', 'assign_ipv6_address_on_creation'] },
      { label: 'Tags', keys: ['tags'] },
    ],
    filterKeys: ['region', 'vpc_id', 'availability_zone', 'map_public_ip_on_launch', 'default_for_az'] },
  security_group: { label: 'Security Groups', group: 'Network', distKey: 'vpc_id', distKey2: 'region', columns: [
    { key: 'name', label: 'Name' }, { key: 'group_name', label: 'Group name' },
    { key: 'vpc_id', label: 'VPC' }, { key: 'description', label: 'Description' } ],
    sections: [
      { label: 'Identity', keys: ['resource_id', 'name', 'group_name', 'account_id', 'region', 'arn', 'owner_id', 'description'] },
      { label: 'Network', keys: ['vpc_id'] },
      { label: 'Ingress Rules', keys: ['ip_permissions'] },
      { label: 'Egress Rules', keys: ['ip_permissions_egress'] },
      { label: 'Tags', keys: ['tags'] },
    ],
    filterKeys: ['region', 'vpc_id'] },
  route_table: { label: 'Route Tables', group: 'Network', distKey: 'vpc_id', columns: [
    { key: 'vpc_id', label: 'VPC' }, { key: 'owner_id', label: 'Owner' } ],
    sections: [
      { label: 'Identity', keys: ['resource_id', 'account_id', 'region', 'vpc_id', 'owner_id'] },
      { label: 'Routes', keys: ['routes'] },
      { label: 'Associations', keys: ['associations', 'propagating_vgws'] },
      { label: 'Tags', keys: ['tags'] },
    ],
    filterKeys: ['region', 'vpc_id'] },
  nat_gateway: { label: 'NAT Gateways', group: 'Network', stateKey: 'state', distKey: 'vpc_id', columns: [
    { key: 'state', label: 'State' }, { key: 'vpc_id', label: 'VPC' },
    { key: 'subnet_id', label: 'Subnet' }, { key: 'create_time', label: 'Created' } ],
    sections: [
      { label: 'Identity', keys: ['resource_id', 'account_id', 'region', 'arn', 'create_time'] },
      { label: 'Network', keys: ['vpc_id', 'subnet_id', 'state', 'nat_gateway_addresses'] },
      { label: 'Tags', keys: ['tags'] },
    ],
    filterKeys: ['region', 'vpc_id'] },
  internet_gateway: { label: 'Internet Gateways', group: 'Network', columns: [
    { key: 'owner_id', label: 'Owner' } ],
    sections: [
      { label: 'Identity', keys: ['resource_id', 'account_id', 'region', 'owner_id'] },
      { label: 'Attachments', keys: ['attachments'] },
      { label: 'Tags', keys: ['tags'] },
    ],
    filterKeys: ['region'] },
  transit_gateway: { label: 'Transit Gateways', group: 'Network', stateKey: 'state', distKey: 'state', columns: [
    { key: 'state', label: 'State' }, { key: 'owner_id', label: 'Owner' },
    { key: 'description', label: 'Description' }, { key: 'creation_time', label: 'Created' } ],
    sections: [
      { label: 'Identity', keys: ['resource_id', 'account_id', 'region', 'transit_gateway_arn', 'creation_time', 'description'] },
      { label: 'Config', keys: ['state', 'owner_id', 'amazon_side_asn'] },
      { label: 'Tags', keys: ['tags'] },
    ],
    filterKeys: ['region', 'amazon_side_asn'] },

  iam_role: { label: 'IAM Roles', group: 'Security', distKey: 'path', columns: [
    { key: 'create_date', label: 'Created' }, { key: 'path', label: 'Path' },
    { key: 'role_id', label: 'Role ID' }, { key: 'max_session_duration', label: 'Max session(s)' } ],
    sections: [
      { label: 'Identity', keys: ['resource_id', 'name', 'account_id', 'arn', 'role_id', 'path', 'create_date', 'description'] },
      { label: 'Access', keys: ['assume_role_policy', 'permissions_boundary_arn', 'max_session_duration', 'instance_profile_arns'] },
      { label: 'Activity', keys: ['role_last_used_date', 'role_last_used_region'] },
      { label: 'Tags', keys: ['tags'] },
    ],
    filterKeys: ['region', 'path', 'max_session_duration', 'role_last_used_region'] },
  iam_user: { label: 'IAM Users', group: 'Security', distKey: 'mfa_enabled', columns: [
    { key: 'create_date', label: 'Created' }, { key: 'path', label: 'Path' },
    { key: 'mfa_enabled', label: 'MFA' }, { key: 'password_last_used', label: 'Last PW use' } ],
    sections: [
      { label: 'Identity', keys: ['resource_id', 'name', 'account_id', 'arn', 'user_id', 'path', 'create_date'] },
      { label: 'Security', keys: ['mfa_enabled', 'password_last_used'] },
      { label: 'Tags', keys: ['tags'] },
    ],
    filterKeys: ['region', 'path', 'mfa_enabled'] },
  // ---- D3 wave ----
  cloudfront: { label: 'CloudFront', group: 'Network', stateKey: 'status', distKey: 'price_class', distKey2: 'status', columns: [
    { key: 'domain_name', label: 'Domain' }, { key: 'status', label: 'Status' },
    { key: 'enabled', label: 'Enabled' }, { key: 'price_class', label: 'Price class' } , { key: 'protocol_h', label: 'Protocol' } ],
    sections: [
      { label: 'Identity', keys: ['resource_id', 'name', 'account_id', 'arn', 'domain_name', 'e_tag'] },
      { label: 'Distribution', keys: ['status', 'enabled', 'http_version', 'is_ipv6_enabled', 'price_class', 'aliases', 'origins', 'default_cache_behavior', 'cache_behaviors'] },
      { label: 'Security', keys: ['web_acl_id'] },
      { label: 'Tags', keys: ['tags'] },
    ],
    filterKeys: ['region', 'price_class', 'http_version', 'is_ipv6_enabled'] },
  route53: { label: 'Route53 Records', group: 'Network', distKey: 'type', columns: [
    { key: 'name', label: 'Name' }, { key: 'type', label: 'Type' },
    { key: 'zone_id', label: 'Zone' }, { key: 'ttl', label: 'TTL' } ],
    sections: [
      { label: 'Identity', keys: ['resource_id', 'name', 'account_id', 'region', 'zone_id', 'set_identifier', 'private_zone'] },
      { label: 'Record', keys: ['type', 'ttl', 'records', 'alias_target'] },
    ],
    filterKeys: ['region', 'type', 'zone_id', 'ttl', 'private_zone'] },
  alb: { label: 'App Load Balancers', group: 'Network', stateKey: 'state_code', distKey: 'scheme', distKey2: 'vpc_id', columns: [
    { key: 'scheme', label: 'Scheme' }, { key: 'vpc_id', label: 'VPC' },
    { key: 'state_code', label: 'State' }, { key: 'dns_name', label: 'DNS' },
    { key: 'ip_address_type', label: 'IP type' }, { key: 'created_time', label: 'Created' } ],
    sections: [
      { label: 'Identity', keys: ['resource_id', 'name', 'account_id', 'region', 'arn', 'created_time'] },
      { label: 'Network', keys: ['type', 'scheme', 'state_code', 'dns_name', 'ip_address_type', 'canonical_hosted_zone_id', 'availability_zones', 'vpc_id'] },
      { label: 'Security', keys: ['security_groups'] },
      { label: 'Tags', keys: ['tags'] },
    ],
    filterKeys: ['region', 'name', 'scheme', 'vpc_id'] },
  nlb: { label: 'Net Load Balancers', group: 'Network', stateKey: 'state_code', distKey: 'scheme', distKey2: 'vpc_id', columns: [
    { key: 'scheme', label: 'Scheme' }, { key: 'vpc_id', label: 'VPC' },
    { key: 'state_code', label: 'State' }, { key: 'dns_name', label: 'DNS' },
    { key: 'ip_address_type', label: 'IP type' }, { key: 'created_time', label: 'Created' } ],
    sections: [
      { label: 'Identity', keys: ['resource_id', 'name', 'account_id', 'region', 'arn', 'created_time'] },
      { label: 'Network', keys: ['type', 'scheme', 'state_code', 'dns_name', 'ip_address_type', 'canonical_hosted_zone_id', 'availability_zones', 'vpc_id'] },
      { label: 'Security', keys: ['security_groups'] },
      { label: 'Tags', keys: ['tags'] },
    ],
    filterKeys: ['region', 'scheme', 'vpc_id'] },
  target_group: { label: 'Target Groups', group: 'Network', distKey: 'target_type', distKey2: 'protocol', columns: [
    { key: 'target_group_name', label: 'Name' }, { key: 'target_type', label: 'Target type' },
    { key: 'protocol', label: 'Protocol' }, { key: 'port', label: 'Port' },
    { key: 'vpc_id', label: 'VPC' }, { key: 'health_check_path', label: 'Health path' } ],
    sections: [
      { label: 'Identity', keys: ['resource_id', 'target_group_name', 'account_id', 'region', 'target_group_arn'] },
      { label: 'Network', keys: ['vpc_id', 'protocol', 'port', 'target_type', 'load_balancer_arns'] },
      { label: 'Health Check', keys: ['health_check_enabled', 'health_check_protocol', 'health_check_path', 'target_health_descriptions'] },
    ],
    filterKeys: ['region', 'target_type', 'protocol', 'port', 'vpc_id', 'health_check_path'] },
  apigatewayv2_api: { label: 'API Gateway (HTTP)', group: 'Network', distKey: 'protocol_type', columns: [
    { key: 'name', label: 'Name' }, { key: 'api_endpoint', label: 'Endpoint' },
    { key: 'protocol_type', label: 'Protocol' } ],
    sections: [
      { label: 'Identity', keys: ['resource_id', 'name', 'account_id', 'region', 'api_id'] },
      { label: 'Endpoint', keys: ['api_endpoint', 'protocol_type'] },
      { label: 'Tags', keys: ['tags'] },
    ],
    filterKeys: ['region', 'protocol_type'] },
  apigatewayv2_integration: { label: 'API GW Integrations', group: 'Network', distKey: 'integration_type', columns: [
    { key: 'api_id', label: 'API' }, { key: 'integration_type', label: 'Type' },
    { key: 'connection_type', label: 'Conn' }, { key: 'integration_uri', label: 'Target' } ],
    sections: [
      { label: 'Identity', keys: ['resource_id', 'account_id', 'region', 'api_id', 'integration_id'] },
      { label: 'Endpoint', keys: ['integration_type', 'integration_uri', 'connection_type', 'connection_id'] },
    ],
    filterKeys: ['region', 'api_id', 'integration_type', 'connection_type'] },
  cloudfront_vpc_origin: { label: 'CloudFront VPC Origins', group: 'Network', stateKey: 'status', distKey: 'status', columns: [
    { key: 'name', label: 'Name' }, { key: 'status', label: 'Status' }, { key: 'arn', label: 'Target LB' } ],
    filterKeys: ['region', 'account_id'] },
  apigatewayv2_route: { label: 'API GW Routes', group: 'Network', distKey: 'authorization_type', columns: [
    { key: 'route_key', label: 'Route' }, { key: 'target', label: 'Integration' },
    { key: 'authorization_type', label: 'Auth' } ],
    sections: [
      { label: 'Identity', keys: ['resource_id', 'account_id', 'region', 'api_id', 'route_id', 'route_uid'] },
      { label: 'Record', keys: ['route_key', 'target', 'authorization_type'] },
    ],
    filterKeys: ['region', 'api_id', 'target', 'authorization_type'] },
  alb_listener_rule: { label: 'ALB Listener Rules', group: 'Network', distKey: 'protocol', columns: [
    { key: 'priority', label: 'Priority' }, { key: 'port', label: 'Port' },
    { key: 'protocol', label: 'Protocol' }, { key: 'is_default', label: 'Default' } ],
    filterKeys: ['region', 'port', 'protocol', 'is_default'] },
  waf: { label: 'WAF Web ACLs', group: 'Security', distKey: 'scope', barKey: { col: 'capacity', label: 'WCU Capacity' }, columns: [
    { key: 'scope', label: 'Scope' }, { key: 'capacity', label: 'Capacity' },
    { key: 'description', label: 'Description' }, { key: 'managed_by_firewall_manager', label: 'FMS-managed' } ],
    sections: [
      { label: 'Identity', keys: ['resource_id', 'name', 'account_id', 'region', 'id', 'arn', 'description'] },
      { label: 'Security', keys: ['scope', 'capacity', 'default_action', 'managed_by_firewall_manager', 'visibility_config'] },
      { label: 'Rules', keys: ['rules'] },
      { label: 'Tags', keys: ['tags'] },
    ],
    filterKeys: ['region', 'scope'] },
  cloudtrail: { label: 'CloudTrail Trails', group: 'Security', distKey: 'home_region', columns: [
    { key: 'is_logging', label: 'Logging' }, { key: 'is_multi_region_trail', label: 'Multi-region' },
    { key: 'home_region', label: 'Home region' }, { key: 's3_bucket_name', label: 'S3 bucket' }, { key: 'log_file_validation_enabled', label: 'Log validation' } ],
    sections: [
      { label: 'Identity', keys: ['resource_id', 'name', 'account_id', 'region', 'arn', 'home_region'] },
      { label: 'Logging', keys: ['is_logging', 'is_multi_region_trail', 'is_organization_trail', 'include_global_service_events', 'log_file_validation_enabled', 'start_logging_time', 'latest_delivery_time', 'latest_delivery_error'] },
      { label: 'Storage', keys: ['s3_bucket_name', 's3_key_prefix', 'log_group_arn'] },
      { label: 'Security', keys: ['kms_key_id', 'sns_topic_arn', 'has_custom_event_selectors', 'has_insight_selectors'] },
      { label: 'Tags', keys: ['tags'] },
    ],
    filterKeys: ['region', 'is_multi_region_trail', 'home_region', 's3_bucket_name', 'include_global_service_events'] },
  s3_public_access: { label: 'S3 Public Access', group: 'Security', distKey: 'bucket_policy_is_public', columns: [
    { key: 'bucket_policy_is_public', label: 'Policy public' }, { key: 'block_public_acls', label: 'Block ACLs' },
    { key: 'block_public_policy', label: 'Block policy' }, { key: 'restrict_public_buckets', label: 'Restrict public' }, { key: 'ignore_public_acls', label: 'Ignore ACLs' } ],
    filterKeys: ['region', 'name'] },
  elasticache: { label: 'ElastiCache', group: 'Storage & DB', stateKey: 'cache_cluster_status', distKey: 'engine', distKey2: 'cache_node_type', columns: [
    { key: 'engine', label: 'Engine' }, { key: 'engine_version', label: 'Version' },
    { key: 'cache_node_type', label: 'Node type' }, { key: 'cache_cluster_status', label: 'Status' }, { key: 'num_cache_nodes', label: 'Nodes' },
    { key: 'replication_group_id', label: 'Repl Group' }, { key: 'at_rest_encryption_enabled', label: 'At-Rest Enc' } ],
    sections: [
      { label: 'Identity', keys: ['resource_id', 'account_id', 'region', 'arn', 'replication_group_id', 'cache_cluster_create_time'] },
      { label: 'Engine', keys: ['engine', 'engine_version', 'cache_node_type', 'cache_cluster_status', 'num_cache_nodes'] },
      { label: 'Network', keys: ['preferred_availability_zone', 'cache_subnet_group_name', 'security_groups'] },
      { label: 'Security', keys: ['at_rest_encryption_enabled', 'transit_encryption_enabled', 'auth_token_enabled'] },
      { label: 'Maintenance', keys: ['auto_minor_version_upgrade', 'snapshot_retention_limit', 'snapshot_window', 'preferred_maintenance_window'] },
      { label: 'Tags', keys: ['tags'] },
    ],
    filterKeys: ['region', 'engine_version', 'cache_node_type', 'replication_group_id', 'at_rest_encryption_enabled', 'transit_encryption_enabled'] },
  opensearch: { label: 'OpenSearch', group: 'Storage & DB', distKey: 'engine_version', distKey2: 'engine_type', columns: [
    { key: 'engine_version', label: 'Version' }, { key: 'instance_type_h', label: 'Instance' },
    { key: 'instance_count_h', label: 'Count' }, { key: 'storage_gb_h', label: 'Storage(GB)' },
    { key: 'n2n_enc_h', label: 'N2N Enc' }, { key: 'rest_enc_h', label: 'Rest Enc' },
    { key: 'created', label: 'Created' } ],
    sections: [
      { label: 'Identity', keys: ['resource_id', 'domain_name', 'account_id', 'region', 'arn', 'domain_id', 'created', 'deleted', 'processing'] },
      { label: 'Engine', keys: ['engine_type', 'engine_version', 'software_update_h', 'upgrade_processing'] },
      // L150 structured rendering — derived *_h fields (inventory-derived.ts) replace the raw
      // cluster_config/ebs_options/vpc_options/encryption/advanced-security JSONB blobs.
      { label: 'Cluster Config', keys: ['instance_type_h', 'instance_count_h', 'dedicated_master_h', 'zone_awareness_h', 'warm_storage_h', 'cold_storage_h', 'multi_az_standby_h'] },
      { label: 'Endpoint & Network', keys: ['endpoint', 'endpoints', 'enforce_https_h', 'tls_policy_h', 'custom_endpoint_h', 'custom_endpoint_cert_h', 'vpc_id_h', 'subnets_h', 'security_groups_h', 'azs_h'] },
      // Raw advanced_security_options/cognito_options stay visible after the derived flags —
      // they carry fields (SAML, user-pool ids) the flags don't derive; hiding them would
      // regress information availability.
      { label: 'Security', keys: ['rest_enc_h', 'kms_key_h', 'n2n_enc_h', 'adv_security_h', 'internal_user_db_h', 'anonymous_auth_h', 'cognito_h', 'advanced_security_options', 'cognito_options', 'access_policies'] },
      { label: 'Storage', keys: ['ebs_volume_h'] },
      // L153: partially-derived/reference blobs stay visible (log_publishing_options,
      // advanced_options, auto_tune_options carry fields the *_h derivations don't cover).
      { label: 'Operations', keys: ['auto_tune_h', 'snapshot_hour_h', 'service_software_options', 'log_publishing_options', 'advanced_options', 'auto_tune_options'] },
      { label: 'Tags', keys: ['tags'] },
    ],
    hideKeys: ['cluster_config', 'ebs_options', 'vpc_options', 'encryption_at_rest_options', 'node_to_node_encryption_options_enabled', 'storage_gb_h', 'domain_endpoint_options', 'snapshot_options'],
    filterKeys: ['region', 'engine_version', 'engine_type'] },
  msk: { label: 'MSK Clusters', group: 'Storage & DB', stateKey: 'state', distKey: 'cluster_type', distKey2: 'state', columns: [
    { key: 'state', label: 'State' }, { key: 'cluster_type', label: 'Type' },
    { key: 'kafka_version', label: 'Kafka' }, { key: 'broker_nodes', label: 'Brokers' },
    { key: 'broker_instance_type', label: 'Instance' }, { key: 'broker_ebs_gb', label: 'EBS(GB)' },
    { key: 'created_h', label: 'Created' } ],
    sections: [
      { label: 'Broker Config', keys: ['kafka_version', 'broker_nodes', 'broker_instance_type', 'broker_ebs_gb'] },
      { label: 'Identity', keys: ['resource_id', 'cluster_name', 'account_id', 'region', 'arn', 'creation_time'] },
      { label: 'Engine', keys: ['state', 'cluster_type', 'current_version', 'provisioned'] },
      { label: 'Tags', keys: ['tags'] },
    ],
    filterKeys: ['region', 'cluster_type', 'kafka_version'] },
  elasticache_replication_group: { label: 'ElastiCache Repl Groups', group: 'Storage & DB', stateKey: 'status', distKey: 'automatic_failover', columns: [
    { key: 'status', label: 'Status' }, { key: 'cache_node_type', label: 'Node type' },
    { key: 'automatic_failover', label: 'Failover' }, { key: 'multi_az', label: 'Multi-AZ' },
    { key: 'at_rest_encryption_enabled', label: 'At-Rest Enc' } ],
    sections: [
      { label: 'Identity', keys: ['resource_id', 'account_id', 'region', 'arn', 'description'] },
      { label: 'Config', keys: ['status', 'cache_node_type', 'automatic_failover', 'multi_az', 'cluster_enabled', 'snapshot_retention_limit'] },
      { label: 'Security', keys: ['auth_token_enabled', 'transit_encryption_enabled', 'at_rest_encryption_enabled'] },
      { label: 'Cluster', keys: ['member_clusters', 'node_groups'] },
    ],
    filterKeys: ['region', 'at_rest_encryption_enabled', 'transit_encryption_enabled'] },
  iam_policy: { label: 'IAM Policies', group: 'Security', distKey: 'is_attachable', barKey: { col: 'attachment_count', label: 'Attachments' }, columns: [
    { key: 'is_attachable', label: 'Attachable' }, { key: 'attachment_count', label: 'Attached' }, { key: 'path', label: 'Path' },
    { key: 'create_date', label: 'Created' }, { key: 'update_date', label: 'Updated' } ],
    sections: [
      { label: 'Identity', keys: ['resource_id', 'name', 'account_id', 'arn', 'policy_id', 'path', 'create_date', 'update_date'] },
      { label: 'Config', keys: ['is_attachable', 'attachment_count', 'default_version_id'] },
      { label: 'Tags', keys: ['tags'] },
    ],
    filterKeys: ['region', 'path'] },

  neptune_cluster: { label: 'Neptune', group: 'Storage & DB', stateKey: 'status', distKey: 'engine_version', distKey2: 'status', columns: [
    { key: 'status', label: 'Status' }, { key: 'engine', label: 'Engine' },
    { key: 'engine_version', label: 'Version' }, { key: 'multi_az', label: 'Multi-AZ' },
    { key: 'storage_encrypted', label: 'Encrypted' } ],
    sections: [
      { label: 'Identity', keys: ['resource_id', 'account_id', 'region', 'arn', 'cluster_create_time'] },
      { label: 'Engine', keys: ['engine', 'engine_version', 'status', 'multi_az', 'deletion_protection'] },
      { label: 'Endpoint', keys: ['endpoint', 'reader_endpoint', 'port'] },
      { label: 'Security', keys: ['storage_encrypted', 'kms_key_id', 'iam_database_authentication_enabled', 'vpc_security_groups'] },
      { label: 'Network', keys: ['availability_zones', 'db_subnet_group'] },
      { label: 'Backup', keys: ['backup_retention_period', 'preferred_backup_window', 'preferred_maintenance_window'] },
      { label: 'Tags', keys: ['tags'] },
    ],
    filterKeys: ['region', 'engine_version', 'storage_encrypted'] },
  opensearch_serverless: { label: 'OpenSearch Serverless', group: 'Storage & DB', stateKey: 'status', distKey: 'type', columns: [
    { key: 'type', label: 'Type' }, { key: 'status', label: 'Status' },
    { key: 'collection_endpoint', label: 'Endpoint' }, { key: 'created_date', label: 'Created' } ],
    sections: [
      { label: 'Identity', keys: ['resource_id', 'name', 'account_id', 'region', 'arn', 'id', 'description', 'created_date', 'last_modified_date'] },
      { label: 'Config', keys: ['type', 'status'] },
      { label: 'Endpoint', keys: ['collection_endpoint', 'dashboard_endpoint'] },
      { label: 'Security', keys: ['kms_key_arn'] },
    ],
    filterKeys: ['region', 'type'] },

  cloudwatch_alarm: { label: 'CloudWatch Alarms', group: 'Monitoring', stateKey: 'state_value', distKey: 'namespace', distKey2: 'state_value',
    // Worst-first default (gap L68): firing alarms surface on top with zero interaction.
    worstFirst: { col: 'state_value', rank: { ALARM: 0, INSUFFICIENT_DATA: 1, OK: 2 }, tieBreak: 'state_updated_timestamp' },
    // Semantic alarm-state colors (gap-audit L190): green OK / red ALARM / gray INSUFFICIENT_DATA
    // — the palette otherwise assigns colors by slice size, so ALARM could render green.
    distKey2Colors: { OK: '#01A88D', ALARM: '#D13212', INSUFFICIENT_DATA: '#9AA6B2' }, columns: [
    { key: 'state_value', label: 'State' }, { key: 'metric_name', label: 'Metric' }, { key: 'namespace', label: 'Namespace' },
    { key: 'threshold', label: 'Threshold' }, { key: 'state_reason', label: 'Reason' }, { key: 'actions_enabled', label: 'Actions' } ],
    sections: [
      { label: 'Identity', keys: ['resource_id', 'name', 'account_id', 'region', 'arn'] },
      { label: 'State', keys: ['state_value', 'state_reason', 'state_updated_timestamp'] },
      { label: 'Metric', keys: ['namespace', 'metric_name', 'statistic', 'comparison_operator', 'threshold', 'period', 'evaluation_periods'] },
      { label: 'Actions', keys: ['actions_enabled', 'alarm_actions', 'ok_actions', 'insufficient_data_actions'] },
    ],
    filterKeys: ['region', 'metric_name', 'namespace', 'statistic', 'comparison_operator', 'period'] },
};

const GROUP_ORDER = ['Compute', 'Storage & DB', 'Network', 'Security', 'Monitoring'];
export function inventoryGroups(): { group: string; types: string[] }[] {
  return GROUP_ORDER.map((group) => ({
    group, types: Object.keys(INVENTORY_TYPES).filter((t) => INVENTORY_TYPES[t].group === group),
  })).filter((g) => g.types.length > 0);
}

// ───────────────────────────────────────────────────────────────────────────
// Nav tree (sidebar IA) — collapsible groups + 2-level subgroups + per-group
// overview pages. ADDITIVE over inventoryGroups(): that stays the flat source
// for CommandPalette + mobile-tabs; navTree() is the sidebar's hierarchy.
// ───────────────────────────────────────────────────────────────────────────

// summary.splits keys (see app/api/inventory/summary/route.ts) shown on overviews.
export type SplitKey = 'ec2Running' | 'ec2Stopped' | 'ebsUnencrypted' | 'iamUserNoMfa' | 'sgOpenIngress';
// Splits representing something needing attention — drive the overview verdict.
export const ATTENTION_SPLITS: SplitKey[] = ['ec2Stopped', 'ebsUnencrypted', 'sgOpenIngress', 'iamUserNoMfa'];

interface SubgroupMeta { key: string; labelKey: string; types: string[]; links?: { key: string; href: string; labelKey: string }[] }
interface GroupMeta {
  slug: string;            // url segment + i18n suffix
  labelKey: string;        // i18n key (Security → "Security Resources")
  singleton?: boolean;     // true → flat render, no overview page
  splitKeys: SplitKey[];   // summary.splits shown on the overview status band
  order: string[];         // explicit order for direct inventory items (not in a subgroup)
  injected?: { key: string; href: string; labelKey: string }[]; // non-inventory feature links (EKS) placed first
  subgroups?: SubgroupMeta[];
}

// Keyed by the INVENTORY_TYPES `.group` display name. GROUP_ORDER drives sidebar order.
// Single bridge: slug ↔ display-group ↔ labelKey ↔ ordering ↔ singleton ↔ splitKeys.
// split→group mapping is pinned here (security_group ∈ Network → sgOpenIngress is Network's).
const GROUPS: Record<string, GroupMeta> = {
  'Compute': {
    slug: 'compute', labelKey: 'group.compute', splitKeys: ['ec2Running', 'ec2Stopped'],
    order: ['ec2', 'lambda', 'ecr'],
    subgroups: [
      // EKS family (v1 parity): fleet overview + per-kind fleet pages + K9s-style explorer + cost.
      {
        key: 'eks', labelKey: 'group.compute.eks', types: [],
        links: [
          { key: 'eks', href: '/eks', labelKey: 'nav.eksOverview' },
          { key: 'eks-nodes', href: '/eks/nodes', labelKey: 'nav.eksNodes' },
          { key: 'eks-pods', href: '/eks/pods', labelKey: 'nav.eksPods' },
          { key: 'eks-deployments', href: '/eks/deployments', labelKey: 'nav.eksDeployments' },
          { key: 'eks-services', href: '/eks/services', labelKey: 'nav.eksServices' },
          { key: 'eks-explorer', href: '/eks/explorer', labelKey: 'nav.eksExplorer' },
          { key: 'eks-cost', href: '/eks/cost', labelKey: 'nav.eksCost' },
        ],
      },
      { key: 'ecs', labelKey: 'group.compute.ecs', types: ['ecs_cluster', 'ecs_service', 'ecs_task'] },
    ],
  },
  'Storage & DB': {
    slug: 'storage', labelKey: 'group.storage', splitKeys: ['ebsUnencrypted'],
    order: ['s3', 'ebs_volume', 'ebs_snapshot', 'rds', 'dynamodb', 'elasticache', 'opensearch', 'opensearch_serverless', 'msk', 'neptune_cluster', 'elasticache_replication_group'],
  },
  'Network': {
    slug: 'network', labelKey: 'group.network', splitKeys: ['sgOpenIngress'],
    order: ['vpc', 'subnet', 'route_table', 'nat_gateway', 'internet_gateway', 'transit_gateway', 'route53', 'cloudfront', 'cloudfront_vpc_origin'],
    // Network Flow Monitor (nfm-dashboard 이식): NFM 온보딩(모니터) 시 플로우 top-contributors 조회.
    injected: [
      { key: 'network-flow', href: '/network-flow', labelKey: 'nav.networkFlow' },
      // DNS Query Log 분석 (Route53 Resolver query logging + Logs Insights)
      { key: 'dns-query', href: '/dns-query', labelKey: 'nav.dnsQuery' },
      // IP 인벤토리/조회 (ENI + EIP + 파드 IP 조인 — IP→리소스 검색, 미사용 EIP)
      { key: 'ip-addresses', href: '/ip-addresses', labelKey: 'nav.ipAddresses' },
      // VPC Endpoint 리스트+분석 (PrivateLink 메트릭 기반 미사용 감지, 커버리지 갭)
      { key: 'vpc-endpoints', href: '/vpc-endpoints', labelKey: 'nav.vpcEndpoints' },
      // Direct Connect 리스트+분석 (AWS/DX 메트릭 다운 감지·피크 사용률, 로케이션 이중화)
      { key: 'direct-connect', href: '/direct-connect', labelKey: 'nav.directConnect' },
      // Network Firewall 리스트+분석 (보호/로깅/전량 통과 기본 액션/룰 용량, 트래픽·드롭)
      { key: 'network-firewall', href: '/network-firewall', labelKey: 'nav.networkFirewall' },
      // Network Path Check (async, read-only policy checklist — docs/superpowers/specs/
      // 2026-08-13-network-path-check-design.md) — dedicated top-level Network entry per spec,
      // not nested under Security Group.
      { key: 'network-paths', href: '/network-paths', labelKey: 'nav.networkPathCheck' },
    ],
    subgroups: [
      { key: 'loadBalancing', labelKey: 'group.network.loadBalancing', types: ['alb', 'nlb', 'target_group', 'alb_listener_rule'] },
      { key: 'apiGateway', labelKey: 'group.network.apiGateway', types: ['apigatewayv2_api', 'apigatewayv2_integration', 'apigatewayv2_route'] },
      // Security Group family: the existing inventory list (as a real `types` member, so it
      // keeps its normal TYPE_ICON + `kind: 'inventory'` leaf shape and is excluded from Network's
      // direct items via subMembers) + the new Rules/Usage screens as `links`
      // (docs/superpowers/specs/2026-08-13-security-group-rules-usage-design.md) — navTree()
      // renders a subgroup's `types` before its `links`, so the order here is exactly
      // Security Groups -> Rules -> Usage.
      {
        key: 'securityGroup', labelKey: 'group.network.securityGroup', types: ['security_group'],
        links: [
          { key: 'sg-rules', href: '/network/security-groups/rules', labelKey: 'nav.sgRules' },
          { key: 'sg-usage', href: '/network/security-groups/usage', labelKey: 'nav.sgUsage' },
        ],
      },
    ],
  },
  'Security': {
    slug: 'security', labelKey: 'group.security', splitKeys: ['iamUserNoMfa'],
    order: ['iam_role', 'iam_user', 'iam_policy', 'waf', 'cloudtrail', 's3_public_access'],
  },
  'Monitoring': {
    slug: 'monitoring', labelKey: 'group.monitoring', singleton: true, splitKeys: [],
    order: ['cloudwatch_alarm'],
    injected: [{ key: 'monitoring-hub', href: '/monitoring', labelKey: 'nav.monitoringHub' }],
  },
};

// Slugs reserved by group overview routes — no inventory type may collide (incl. the 'g' segment).
export const RESERVED_NAV_SLUGS: string[] = ['g', ...Object.values(GROUPS).map((m) => m.slug)];

export type NavLeafKind = 'inventory' | 'feature';
export interface NavLeaf {
  key: string;
  kind: NavLeafKind;
  type?: string;        // inventory slug (kind === 'inventory')
  href: string;
  label?: string;       // literal (inventory: INVENTORY_TYPES[type].label)
  labelKey?: string;    // i18n key (feature links, e.g. EKS)
}
export interface NavSubgroupNode { key: string; labelKey: string; items: NavLeaf[] }
export interface NavGroupNode {
  group: string; slug: string; labelKey: string;
  singleton: boolean; href?: string; splitKeys: SplitKey[];
  items: NavLeaf[]; subgroups: NavSubgroupNode[];
}

function invLeaf(type: string): NavLeaf {
  return { key: type, kind: 'inventory', type, href: `/inventory/${type}`, label: INVENTORY_TYPES[type]?.label ?? type };
}
// Order `types` by `order` (known first, in that order); append any leftover so a
// newly-registered type is never silently dropped from the sidebar.
function ordered(types: string[], order: string[]): string[] {
  const present = new Set(types);
  const head = order.filter((t) => present.has(t));
  const tail = types.filter((t) => !order.includes(t));
  return [...head, ...tail];
}

/** Sidebar hierarchy: collapsible groups (GROUP_ORDER) + 2-level subgroups + injected feature links. */
export function navTree(): NavGroupNode[] {
  return inventoryGroups().map(({ group, types }) => {
    const meta: GroupMeta = GROUPS[group] ?? {
      slug: group.toLowerCase().replace(/[^a-z0-9]+/g, '-'), labelKey: group, splitKeys: [], order: [],
    };
    const subgroupMeta = meta.subgroups ?? [];
    const subMembers = new Set(subgroupMeta.flatMap((s) => s.types));
    const directTypes = ordered(types.filter((t) => !subMembers.has(t)), meta.order);
    const injected: NavLeaf[] = (meta.injected ?? []).map((f) => ({ key: f.key, kind: 'feature', href: f.href, labelKey: f.labelKey }));
    const items: NavLeaf[] = [...injected, ...directTypes.map(invLeaf)];
    const subgroups: NavSubgroupNode[] = subgroupMeta
      .map((s) => ({
        key: s.key,
        labelKey: s.labelKey,
        // types before links: no existing subgroup mixes both (eks is links-only, ecs is
        // types-only) — this order lets the new securityGroup subgroup put the existing
        // /inventory/security_group route first, followed by the Rules/Usage feature links, per
        // docs/superpowers/specs/2026-08-13-security-group-rules-usage-design.md's nav order.
        items: [
          ...ordered(types.filter((t) => s.types.includes(t)), s.types).map(invLeaf),
          ...(s.links ?? []).map((f): NavLeaf => ({ key: f.key, kind: 'feature', href: f.href, labelKey: f.labelKey })),
        ],
      }))
      .filter((s) => s.items.length > 0);
    const singleton = !!meta.singleton;
    return {
      group, slug: meta.slug, labelKey: meta.labelKey, singleton,
      href: singleton ? undefined : `/inventory/g/${meta.slug}`,
      splitKeys: meta.splitKeys, items, subgroups,
    };
  });
}

/** Non-singleton groups that own an overview page (server route validation + Cmd-K). */
export function overviewGroups(): NavGroupNode[] {
  return navTree().filter((g) => !g.singleton);
}

/** Resolve a slug to its overview group node, or null if unknown/singleton (→ notFound). */
export function groupBySlug(slug: string): NavGroupNode | null {
  return overviewGroups().find((g) => g.slug === slug) ?? null;
}

/** Map an active pathname to its owning group/subgroup — drives 2-level auto-expand. */
export function groupForPath(path: string): { slug: string; subgroupKey?: string } | null {
  for (const g of navTree()) {
    if (g.href && (path === g.href || path.startsWith(`${g.href}/`))) return { slug: g.slug };
    for (const leaf of g.items) {
      if (leaf.kind === 'feature' && (path === leaf.href || path.startsWith(`${leaf.href}/`))) return { slug: g.slug };
      if (leaf.kind === 'inventory' && leaf.href === path) return { slug: g.slug };
    }
    for (const s of g.subgroups) {
      if (s.items.some((l) =>
        l.href === path || (l.kind === 'feature' && path.startsWith(`${l.href}/`)))) {
        return { slug: g.slug, subgroupKey: s.key };
      }
    }
  }
  return null;
}

// Lambda runtimes past AWS end-of-support. Static list (no date math / API call) —
// ported from v1 src/app/lambda/page.tsx. Surfaced as an EOL badge in the inventory table.
export const DEPRECATED_RUNTIMES = [
  'python2.7', 'python3.6', 'python3.7',
  'nodejs10.x', 'nodejs12.x', 'nodejs14.x',
  'dotnetcore2.1', 'dotnetcore3.1',
  'ruby2.5', 'ruby2.7', 'java8', 'go1.x',
];
const DEPRECATED_SET = new Set(DEPRECATED_RUNTIMES);

/** True when a Lambda runtime string is a known end-of-support runtime (case/space-insensitive). */
export function isDeprecatedRuntime(runtime: unknown): boolean {
  if (typeof runtime !== 'string') return false;
  return DEPRECATED_SET.has(runtime.trim().toLowerCase());
}

// ───────────────────────────────────────────────────────────────────────────
// Per-type highlight cards — tailored top KPIs so each inventory page reads
// distinctly (vs the old identical total + top-4-state template). Derived ONLY
// from already-synced row columns (no new AWS calls). Types without an entry
// fall back to the generic state-count tiles.
// ───────────────────────────────────────────────────────────────────────────
export type Highlight =
  | { kind: 'countWhere'; label: string; col: string; eq: string; tone?: 'accent' | 'danger' }
  | { kind: 'countTruthy'; label: string; col: string; tone?: 'accent' | 'danger' }
  | { kind: 'distinct'; label: string; col: string }
  | { kind: 'sum'; label: string; col: string; suffix?: string; fmt?: 'bytes' }
  | { kind: 'sumWhere'; label: string; col: string; where: string; eq: string; suffix?: string; tone?: 'accent' | 'danger' }
  | { kind: 'countGt'; label: string; col: string; gt: number; tone?: 'accent' | 'danger' }
  | { kind: 'avg'; label: string; col: string; suffix?: string }
  // percent: count(cell==eq)/rows as 'NN% (n/total)'. Variant comes from the RAW ratio (v1
  // parity, L100): every row matching → accent, ratio ≥0.8 → default, else danger; 0 rows → '—'.
  // Displays ONE DECIMAL whenever rounding would move the rate into a different threshold class
  // than the raw ratio (e.g. 499/500 → '99.8%', 399/500 → '79.8%'), so a near-complete fleet
  // never reads as a finished '100%' and an 80%-rounded rate never contradicts its danger tone.
  // When the row set is a capped sample (opts.capped), the rate can never render 'accent' and the
  // value is marked ' 표본' — a 500-row-capped sample is not fleet-wide completeness.
  | { kind: 'percent'; label: string; col: string; eq: string }
  // sumProductWhere: Σ(colA×colB) over rows matching where==eq — per-row factors, so a
  // custom-CPU-options instance counts its ACTUAL vCPUs, not the type default (L103).
  | { kind: 'sumProductWhere'; label: string; cols: [string, string]; where: string; eq: string; suffix?: string }
  | { kind: 'deprecatedRuntime'; label: string; col: string };

export interface HighlightCard { label: string; value: string | number; variant: 'default' | 'accent' | 'danger' }

const FALSY = new Set(['', 'false', 'null', 'undefined', '0', 'none', 'no', 'disabled']);
const sv = (v: unknown): string => (v == null ? '' : String(v));

// Resolve a highlight column that may be a dotted JSONB path (e.g. 'provisioned.number_of_broker_nodes').
// Segment matching is case-insensitive (Steampipe JSONB keys vary between snake_case and PascalCase),
// and JSON-encoded strings are parsed one level so nested lookups work on raw API rows.
function cell(r: Record<string, unknown>, col: string): unknown {
  if (!col.includes('.')) return r[col];
  let cur: unknown = r;
  for (const seg of col.split('.')) {
    if (typeof cur === 'string' && (cur.startsWith('{') || cur.startsWith('['))) {
      try { cur = JSON.parse(cur); } catch { return undefined; }
    }
    if (cur == null || typeof cur !== 'object' || Array.isArray(cur)) return undefined;
    const o = cur as Record<string, unknown>;
    const key = Object.keys(o).find((k) => k.toLowerCase().replace(/_/g, '') === seg.toLowerCase().replace(/_/g, ''));
    if (key == null) return undefined;
    cur = o[key];
  }
  return cur;
}

const BYTE_UNITS = ['B', 'KB', 'MB', 'GB', 'TB', 'PB'];
function humanBytes(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return '0 B';
  const i = Math.min(BYTE_UNITS.length - 1, Math.floor(Math.log(n) / Math.log(1024)));
  return `${(n / 1024 ** i).toFixed(i === 0 ? 0 : 1)} ${BYTE_UNITS[i]}`;
}

/** Compute highlight cards from the full row set. Pure — unit-tested. */
export function computeHighlights(
  rows: Array<Record<string, unknown>>,
  highlights: Highlight[],
  opts?: { capped?: boolean },
): HighlightCard[] {
  const tone = (t: 'accent' | 'danger' | undefined, n: number): HighlightCard['variant'] =>
    t === 'danger' ? (n > 0 ? 'danger' : 'default') : t === 'accent' ? 'accent' : 'default';
  return highlights.map((h) => {
    switch (h.kind) {
      case 'countWhere': {
        const n = rows.filter((r) => sv(cell(r, h.col)).trim().toLowerCase() === h.eq.toLowerCase()).length;
        return { label: h.label, value: n, variant: tone(h.tone, n) };
      }
      case 'countTruthy': {
        const n = rows.filter((r) => !FALSY.has(sv(cell(r, h.col)).trim().toLowerCase())).length;
        return { label: h.label, value: n, variant: tone(h.tone, n) };
      }
      case 'distinct': {
        const set = new Set(rows.map((r) => sv(cell(r, h.col)).trim()).filter((x) => x !== ''));
        return { label: h.label, value: set.size, variant: 'default' };
      }
      case 'sum': {
        const total = rows.reduce((acc, r) => acc + (Number(cell(r, h.col)) || 0), 0);
        if (h.fmt === 'bytes') return { label: h.label, value: humanBytes(total), variant: 'default' };
        return { label: h.label, value: `${Math.round(total).toLocaleString()}${h.suffix ?? ''}`, variant: 'default' };
      }
      case 'sumWhere': {
        const total = rows
          .filter((r) => sv(cell(r, h.where)).trim().toLowerCase() === h.eq.toLowerCase())
          .reduce((acc, r) => acc + (Number(cell(r, h.col)) || 0), 0);
        return { label: h.label, value: `${Math.round(total).toLocaleString()}${h.suffix ?? ''}`, variant: tone(h.tone, total) };
      }
      case 'countGt': {
        const n = rows.filter((r) => {
          const v = Number(cell(r, h.col));
          return Number.isFinite(v) && v > h.gt;
        }).length;
        return { label: h.label, value: n, variant: tone(h.tone, n) };
      }
      case 'avg': {
        // Exclude null/undefined/blank cells — Number(null) === 0 would skew the mean.
        const nums = rows
          .map((r) => cell(r, h.col))
          .filter((v) => v != null && String(v).trim() !== '')
          .map(Number)
          .filter((n) => Number.isFinite(n));
        if (!nums.length) return { label: h.label, value: '—', variant: 'default' };
        const mean = Math.round(nums.reduce((a, b) => a + b, 0) / nums.length);
        return { label: h.label, value: `${mean.toLocaleString()}${h.suffix ?? ''}`, variant: 'default' };
      }
      case 'percent': {
        if (!rows.length) return { label: h.label, value: '—', variant: 'default' };
        const n = rows.filter((r) => sv(cell(r, h.col)).trim().toLowerCase() === h.eq.toLowerCase()).length;
        // A capped row set is a sample, not the fleet — a complete match can never claim the
        // accented all-clear.
        const capped = !!opts?.capped;
        // Variant from the RAW ratio, never the rounded pct: 499/500 rounds to 100% but is
        // not a complete match, so it must not read as 'accent'.
        const variant: HighlightCard['variant'] =
          n === rows.length && !capped ? 'accent' : n / rows.length >= 0.8 ? 'default' : 'danger';
        const ratio = n / rows.length;
        const rounded = Math.round(ratio * 100);
        // Show one decimal whenever rounding would cross a threshold class the raw ratio is not
        // in (rounded 100 but incomplete, rounded ≥80 but raw <0.8, rounded 0 but nonzero).
        const crosses = (rounded === 100 && n !== rows.length)
          || (rounded >= 80 && ratio < 0.8)
          || (rounded === 0 && n > 0);
        const pctStr = crosses ? (ratio * 100).toFixed(1) : String(rounded);
        return {
          label: h.label,
          value: `${pctStr}% (${n}/${rows.length}${capped ? ' 표본' : ''})`,
          variant,
        };
      }
      case 'sumProductWhere': {
        const total = rows
          .filter((r) => sv(cell(r, h.where)).trim().toLowerCase() === h.eq.toLowerCase())
          .reduce((acc, r) => {
            const a = Number(cell(r, h.cols[0]));
            const b = Number(cell(r, h.cols[1]));
            return acc + (Number.isFinite(a) && Number.isFinite(b) ? a * b : 0);
          }, 0);
        return { label: h.label, value: `${Math.round(total).toLocaleString()}${h.suffix ?? ''}`, variant: 'default' };
      }
      case 'deprecatedRuntime': {
        const n = rows.filter((r) => isDeprecatedRuntime(cell(r, h.col))).length;
        return { label: h.label, value: n, variant: n > 0 ? 'danger' : 'default' };
      }
    }
  });
}

// High-value types first (synced columns only). EKS is a feature route (/eks), not an inventory type.
export const HIGHLIGHTS: Record<string, Highlight[]> = {
  ec2: [
    { kind: 'countWhere', label: '실행 중', col: 'instance_state', eq: 'running', tone: 'accent' },
    { kind: 'countWhere', label: '중지됨', col: 'instance_state', eq: 'stopped', tone: 'danger' },
    { kind: 'countTruthy', label: '퍼블릭 IP', col: 'public_ip_address' },
    { kind: 'distinct', label: '타입 종류', col: 'instance_type' },
    { kind: 'sumProductWhere', label: '실행 중 총 vCPU', cols: ['cpu_options_core_count', 'cpu_options_threads_per_core'], where: 'instance_state', eq: 'running' },
  ],
  rds: [
    { kind: 'countWhere', label: '가용', col: 'status', eq: 'available', tone: 'accent' },
    { kind: 'countWhere', label: 'Multi-AZ', col: 'multi_az', eq: 'true', tone: 'accent' },
    { kind: 'countWhere', label: '퍼블릭 노출', col: 'publicly_accessible', eq: 'true', tone: 'danger' },
    { kind: 'distinct', label: '엔진 종류', col: 'engine' },
    // Aurora reports a nominal allocated_storage placeholder — this is provisioned storage, not Aurora usage.
    { kind: 'sum', label: '총 프로비저닝 스토리지', col: 'allocated_storage', suffix: ' GB' },
  ],
  lambda: [
    { kind: 'countWhere', label: '활성', col: 'state', eq: 'active', tone: 'accent' },
    { kind: 'deprecatedRuntime', label: 'EOL 런타임', col: 'runtime' },
    { kind: 'countGt', label: '타임아웃 >300s', col: 'timeout', gt: 300, tone: 'danger' },
    { kind: 'avg', label: '평균 메모리', col: 'memory_size', suffix: ' MB' },
    { kind: 'distinct', label: '런타임 종류', col: 'runtime' },
  ],
  ecs_cluster: [
    { kind: 'countWhere', label: 'ACTIVE', col: 'status', eq: 'active', tone: 'accent' },
    { kind: 'sum', label: '실행 태스크', col: 'running_tasks_count' },
    { kind: 'sum', label: '활성 서비스', col: 'active_services_count' },
    { kind: 'sum', label: '컨테이너 인스턴스', col: 'registered_container_instances_count' },
  ],
  ecs_task: [
    { kind: 'countWhere', label: 'RUNNING', col: 'last_status', eq: 'running', tone: 'accent' },
    { kind: 'countWhere', label: 'Fargate', col: 'launch_type', eq: 'fargate' },
    { kind: 'sum', label: '일일 비용 합 (est.)', col: 'cost_day_num', suffix: ' USD' },
    { kind: 'distinct', label: '클러스터 수', col: 'cluster_h' },
  ],
  ecs_service: [
    { kind: 'sum', label: 'Desired', col: 'desired_count' },
    { kind: 'sum', label: 'Running', col: 'running_count' },
    { kind: 'sum', label: 'Pending', col: 'pending_count' },
    { kind: 'distinct', label: 'Clusters', col: 'cluster_arn' },
  ],
  ebs_volume: [
    { kind: 'countWhere', label: '사용 중', col: 'state', eq: 'in-use', tone: 'accent' },
    { kind: 'countWhere', label: '미암호화', col: 'encrypted', eq: 'false', tone: 'danger' },
    { kind: 'percent', label: '암호화율', col: 'encrypted', eq: 'true' },
    { kind: 'sum', label: '총 용량', col: 'size', suffix: ' GB' },
    { kind: 'countWhere', label: '유휴 볼륨', col: 'state', eq: 'available', tone: 'danger' },
    { kind: 'sumWhere', label: '유휴(낭비) 용량', col: 'size', where: 'state', eq: 'available', suffix: ' GB', tone: 'danger' },
  ],
  ebs_snapshot: [
    { kind: 'sum', label: '총 용량', col: 'volume_size', suffix: ' GB' },
    { kind: 'countWhere', label: '완료', col: 'state', eq: 'completed', tone: 'accent' },
    { kind: 'countWhere', label: '미암호화', col: 'encrypted', eq: 'false', tone: 'danger' },
    { kind: 'distinct', label: '볼륨 수', col: 'volume_id' },
  ],
  alb: [
    { kind: 'countWhere', label: '활성', col: 'state_code', eq: 'active', tone: 'accent' },
    { kind: 'countWhere', label: '인터넷 노출', col: 'scheme', eq: 'internet-facing' },
    { kind: 'countWhere', label: '내부', col: 'scheme', eq: 'internal' },
  ],
  nlb: [
    { kind: 'countWhere', label: '활성', col: 'state_code', eq: 'active', tone: 'accent' },
    { kind: 'countWhere', label: '인터넷 노출', col: 'scheme', eq: 'internet-facing' },
    { kind: 'countWhere', label: '내부', col: 'scheme', eq: 'internal' },
  ],
  iam_user: [
    { kind: 'countWhere', label: 'MFA 미설정', col: 'mfa_enabled', eq: 'false', tone: 'danger' },
    { kind: 'countWhere', label: 'MFA 설정', col: 'mfa_enabled', eq: 'true', tone: 'accent' },
  ],
  cloudwatch_alarm: [
    { kind: 'countWhere', label: 'ALARM', col: 'state_value', eq: 'alarm', tone: 'danger' },
    { kind: 'countWhere', label: 'OK', col: 'state_value', eq: 'ok', tone: 'accent' },
    { kind: 'countWhere', label: 'INSUFFICIENT_DATA', col: 'state_value', eq: 'insufficient_data' },
    { kind: 'countWhere', label: '액션 비활성', col: 'actions_enabled', eq: 'false' },
  ],
  elasticache: [
    { kind: 'countWhere', label: '가용', col: 'cache_cluster_status', eq: 'available', tone: 'accent' },
    { kind: 'sum', label: '총 노드', col: 'num_cache_nodes' },
    { kind: 'countWhere', label: 'At-Rest 미암호화', col: 'at_rest_encryption_enabled', eq: 'false', tone: 'danger' },
    { kind: 'distinct', label: '노드 타입 종류', col: 'cache_node_type' },
  ],
  dynamodb: [
    { kind: 'countWhere', label: 'ACTIVE', col: 'table_status', eq: 'active', tone: 'accent' },
    { kind: 'sum', label: '총 아이템', col: 'item_count' },
    { kind: 'sum', label: '총 크기', col: 'table_size_bytes', fmt: 'bytes' },
    { kind: 'countWhere', label: 'On-Demand', col: 'billing_mode', eq: 'pay_per_request' },
  ],
  msk: [
    { kind: 'countWhere', label: 'ACTIVE', col: 'state', eq: 'active', tone: 'accent' },
    { kind: 'sum', label: '총 브로커', col: 'provisioned.number_of_broker_nodes' },
    { kind: 'distinct', label: 'Kafka 버전', col: 'provisioned.current_broker_software_info.kafka_version' },
  ],
  ecr: [
    { kind: 'countTruthy', label: 'Scan on Push', col: 'image_scanning_configuration.scan_on_push', tone: 'accent' },
    { kind: 'countWhere', label: '태그 불변', col: 'image_tag_mutability', eq: 'immutable', tone: 'accent' },
    { kind: 'countWhere', label: '태그 변경 가능', col: 'image_tag_mutability', eq: 'mutable' },
  ],
  cloudfront: [
    { kind: 'countTruthy', label: '활성', col: 'enabled', tone: 'accent' },
    { kind: 'countWhere', label: 'HTTP 허용', col: 'default_cache_behavior.viewer_protocol_policy', eq: 'allow-all', tone: 'danger' },
    { kind: 'countWhere', label: 'WAF 미연결', col: 'web_acl_id', eq: '' },
  ],
  opensearch: [
    { kind: 'countTruthy', label: 'At-Rest 암호화', col: 'encryption_at_rest_options.enabled', tone: 'accent' },
    { kind: 'countTruthy', label: 'N2N 암호화', col: 'node_to_node_encryption_options_enabled', tone: 'accent' },
    { kind: 'countTruthy', label: '처리 중', col: 'processing' },
  ],
  s3: [
    { kind: 'countWhere', label: 'Versioning 미설정', col: 'versioning_enabled', eq: 'false', tone: 'danger' },
    { kind: 'countWhere', label: '미암호화', col: 'encryption', eq: 'none', tone: 'danger' },
    { kind: 'countTruthy', label: 'Logging', col: 'logging_enabled', tone: 'accent' },
    { kind: 'distinct', label: '리전 수', col: 'region' },
  ],
  s3_public_access: [
    { kind: 'countWhere', label: '정책 공개', col: 'bucket_policy_is_public', eq: 'true', tone: 'danger' },
    { kind: 'countWhere', label: '정책차단 해제', col: 'block_public_policy', eq: 'false', tone: 'danger' },
    { kind: 'countWhere', label: '공개버킷 미제한', col: 'restrict_public_buckets', eq: 'false', tone: 'danger' },
  ],
  cloudtrail: [
    { kind: 'countWhere', label: '로깅 중', col: 'is_logging', eq: 'true', tone: 'accent' },
    { kind: 'countWhere', label: '로깅 꺼짐', col: 'is_logging', eq: 'false', tone: 'danger' },
    { kind: 'countWhere', label: '검증 비활성', col: 'log_file_validation_enabled', eq: 'false', tone: 'danger' },
    { kind: 'countWhere', label: '멀티리전', col: 'is_multi_region_trail', eq: 'true', tone: 'accent' },
  ],
};

// ───────────────────────────────────────────────────────────────────────────
// Layout archetypes — each inventory page composes its sections to match the
// resource's nature, so pages read distinctly (vs one identical template):
//   risk      → danger-verdict hero on top, table-first (security posture)
//   chart     → distribution/utilization donut prominent up top, table below
//   capacity  → donut-left + table-right side-by-side (engine/type/size)
//   directory → compact KPIs, table-dominant scanning, donut as a small aside
// ───────────────────────────────────────────────────────────────────────────
export type Archetype = 'risk' | 'chart' | 'capacity' | 'directory';

const LAYOUTS: Record<string, Archetype> = {
  // risk — types with genuine danger signals → lead with the verdict
  iam_user: 'risk', s3_public_access: 'risk', cloudtrail: 'risk',
  // chart — state/utilization distribution is the story
  ec2: 'chart', lambda: 'chart', ecs_cluster: 'chart', ecs_service: 'chart', cloudwatch_alarm: 'chart',
  // capacity — engine/type/size; donut beside the table
  rds: 'capacity', ebs_volume: 'capacity', ebs_snapshot: 'capacity', dynamodb: 'capacity', elasticache: 'capacity',
  opensearch: 'capacity', msk: 'capacity', s3: 'capacity', ecr: 'capacity',
  // directory — listing/scanning, table-dominant (default for the rest)
  vpc: 'directory', subnet: 'directory', security_group: 'directory', waf: 'directory',
  alb: 'directory', nlb: 'directory', target_group: 'directory', alb_listener_rule: 'directory',
  apigatewayv2_api: 'directory', apigatewayv2_integration: 'directory', apigatewayv2_route: 'directory',
  cloudfront: 'directory', cloudfront_vpc_origin: 'directory', route53: 'directory', ecs_task: 'directory',
};

/** The layout archetype for an inventory type (unmapped → 'directory', a safe table-lead default). */
export const layoutOf = (type: string): Archetype => LAYOUTS[type] ?? 'directory';
