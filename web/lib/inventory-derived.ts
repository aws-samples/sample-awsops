// Client-side derived fields per inventory type — flattens JSONB nests / formats raw values
// into table-ready columns (v1 parity: readable MSK/DynamoDB/EBS/ECS-task lists). Pure, no React.

type Row = Record<string, unknown>;

const asObj = (v: unknown): Row | null => {
  if (typeof v === 'string' && (v.startsWith('{') || v.startsWith('['))) {
    try { v = JSON.parse(v); } catch { return null; }
  }
  return v !== null && typeof v === 'object' && !Array.isArray(v) ? (v as Row) : null;
};
const asArr = (v: unknown): unknown[] | null => {
  if (typeof v === 'string' && v.startsWith('[')) {
    try { v = JSON.parse(v); } catch { return null; }
  }
  return Array.isArray(v) ? v : null;
};

/** Case/underscore-insensitive nested lookup (Steampipe JSONB mixes snake_case and PascalCase). */
function walk(root: unknown, path: string): unknown {
  let cur: unknown = root;
  for (const seg of path.split('.')) {
    const o = asObj(cur);
    if (!o) return undefined;
    const want = seg.toLowerCase().replace(/_/g, '');
    const key = Object.keys(o).find((k) => k.toLowerCase().replace(/_/g, '') === want);
    if (key == null) return undefined;
    cur = o[key];
  }
  return cur;
}

const BYTE_UNITS = ['B', 'KB', 'MB', 'GB', 'TB', 'PB'];
function bytesH(v: unknown): string | undefined {
  const n = Number(v);
  if (!Number.isFinite(n)) return undefined;
  if (n <= 0) return '0 B';
  const i = Math.min(BYTE_UNITS.length - 1, Math.floor(Math.log(n) / Math.log(1024)));
  return `${(n / 1024 ** i).toFixed(i === 0 ? 0 : 1)} ${BYTE_UNITS[i]}`;
}
function dateH(v: unknown): string | undefined {
  if (typeof v !== 'string' || !v) return undefined;
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? v : d.toISOString().slice(0, 16).replace('T', ' ');
}

const boolH = (v: unknown): string | undefined =>
  v === true || v === 'true' ? 'true' : v === false || v === 'false' ? 'false' : undefined;

function _ecsTaskBase(r: Row): Row {
  return {
    task_short: typeof r.resource_id === 'string' ? r.resource_id.split('/').pop()?.slice(0, 12) : undefined,
    cpu_h: Number.isFinite(Number(r.cpu)) ? `${r.cpu} (${(Number(r.cpu) / 1024).toFixed(2)} vCPU)` : undefined,
    memory_h: Number.isFinite(Number(r.memory)) ? `${r.memory} MB (${(Number(r.memory) / 1024).toFixed(1)} GB)` : undefined,
    started_h: dateH(r.started_at),
  };
}

const DERIVERS: Record<string, (r: Row) => Row> = {
  opensearch: (r) => {
    // L150 structured detail: flatten cluster_config/ebs_options/vpc_options/encryption/
    // advanced-security JSONB into readable fields (v1's structured detail panel). The raw
    // blobs are then hidden from the panel via the spec's hideKeys.
    const cc = r.cluster_config;
    const ebs = r.ebs_options;
    const vpc = r.vpc_options;
    const enc = r.encryption_at_rest_options;
    const adv = r.advanced_security_options;
    // Tolerant boolean (boolH parity — Steampipe JSONB can carry 'true'/'false' strings);
    // an ABSENT key yields undefined so a `{}` blob never fabricates a confident 'disabled'.
    const flag = (v: unknown): boolean | undefined =>
      v === true || v === 'true' ? true : v === false || v === 'false' ? false : undefined;
    // Raw arrays pass through so formatDetailValue's one-per-row idlist rendering applies
    // (a pre-joined comma string would flatten v1's subnet/SG chip list into one line).
    const arr = (v: unknown): unknown[] | undefined => {
      const a = asArr(v);
      return a && a.length ? a : undefined;
    };
    const iops = walk(ebs, 'iops');
    const thr = walk(ebs, 'throughput');
    const dm = flag(walk(cc, 'dedicated_master_enabled'));
    const za = flag(walk(cc, 'zone_awareness_enabled'));
    const warm = flag(walk(cc, 'warm_enabled'));
    const cold = flag(walk(cc, 'cold_storage_options.enabled'));
    const standby = flag(walk(cc, 'multi_az_with_standby_enabled'));
    const ebsOn = flag(walk(ebs, 'ebs_enabled'));
    return {
      instance_type_h: walk(cc, 'instance_type'),
      instance_count_h: walk(cc, 'instance_count'),
      storage_gb_h: walk(ebs, 'volume_size'),
      n2n_enc_h: boolH(r.node_to_node_encryption_options_enabled),
      rest_enc_h: boolH(walk(enc, 'enabled')),
      dedicated_master_h: dm === true
        ? `${walk(cc, 'dedicated_master_type') ?? '?'} × ${walk(cc, 'dedicated_master_count') ?? '?'}`
        : dm === false ? 'disabled' : undefined,
      zone_awareness_h: za === true
        ? `enabled (${walk(cc, 'zone_awareness_config.availability_zone_count') ?? '?'} AZ)`
        : za === false ? 'disabled' : undefined,
      warm_storage_h: warm === true
        ? `${walk(cc, 'warm_type') ?? '?'} × ${walk(cc, 'warm_count') ?? '?'}`
        : warm === false ? 'disabled' : undefined,
      cold_storage_h: cold === true ? 'enabled' : cold === false ? 'disabled' : undefined,
      multi_az_standby_h: standby === true ? 'enabled' : standby === false ? 'disabled' : undefined,
      ebs_volume_h: ebsOn === true
        ? `${walk(ebs, 'volume_type') ?? '?'} · ${walk(ebs, 'volume_size') ?? '?'} GB`
          + (iops != null ? ` · ${iops} IOPS` : '')
          + (thr != null ? ` · ${thr} MB/s` : '')
        : ebsOn === false ? 'disabled' : undefined,
      vpc_id_h: walk(vpc, 'vpc_id'),
      subnets_h: arr(walk(vpc, 'subnet_ids')),
      security_groups_h: arr(walk(vpc, 'security_group_ids')),
      azs_h: arr(walk(vpc, 'availability_zones')),
      kms_key_h: walk(enc, 'kms_key_id'),
      // real booleans → the DetailPanel's Badge rendering (green true / neutral false)
      adv_security_h: flag(walk(adv, 'enabled')),
      internal_user_db_h: flag(walk(adv, 'internal_user_database_enabled')),
      anonymous_auth_h: flag(walk(adv, 'anonymous_auth_enabled')),
      cognito_h: flag(walk(r.cognito_options, 'enabled')),
      // L153 sync additions — service software / endpoint policy / auto-tune / snapshots.
      software_update_h: (() => {
        // UpdateAvailable:false does NOT mean healthy — it also covers IN_PROGRESS and the
        // persistently unhealthy NOT_ELIGIBLE (domain must upgrade first). Derive from
        // UpdateStatus when present; UpdateAvailable is only the last-resort fallback.
        const sso = r.service_software_options;
        const cur = walk(sso, 'current_version');
        const next = walk(sso, 'new_version');
        const status = walk(sso, 'update_status');
        if (typeof status === 'string' && status) {
          const st = status.toUpperCase();
          if (st === 'COMPLETED') return `up to date${cur != null ? ` (${cur})` : ''}`;
          if (st === 'IN_PROGRESS') return `update in progress: ${cur ?? '?'} → ${next ?? '?'}`;
          if (st === 'PENDING_UPDATE') return `update pending: ${cur ?? '?'} → ${next ?? '?'}`;
          if (st === 'NOT_ELIGIBLE') return `not eligible for update${cur != null ? ` (${cur})` : ''} — domain upgrade required`;
          if (st === 'ELIGIBLE') return `update available: ${cur ?? '?'} → ${next ?? '?'}`;
          return `${status}${cur != null ? ` (${cur})` : ''}`;
        }
        const avail = flag(walk(sso, 'update_available'));
        if (avail === true) return `update available: ${cur ?? '?'} → ${next ?? '?'}`;
        if (avail === false) return `no update available${cur != null ? ` (${cur})` : ''}`;
        return undefined;
      })(),
      enforce_https_h: flag(walk(r.domain_endpoint_options, 'enforce_https')),
      tls_policy_h: walk(r.domain_endpoint_options, 'tls_security_policy'),
      custom_endpoint_h: flag(walk(r.domain_endpoint_options, 'custom_endpoint_enabled')) === true
        ? walk(r.domain_endpoint_options, 'custom_endpoint') ?? 'enabled'
        : flag(walk(r.domain_endpoint_options, 'custom_endpoint_enabled')) === false ? 'disabled' : undefined,
      custom_endpoint_cert_h: walk(r.domain_endpoint_options, 'custom_endpoint_certificate_arn'),
      auto_tune_h: walk(r.auto_tune_options, 'state'),
      snapshot_hour_h: (() => {
        const h = walk(r.snapshot_options, 'automated_snapshot_start_hour');
        return Number.isFinite(Number(h)) && h !== null && h !== '' ? `${h}:00 UTC` : undefined;
      })(),
    };
  },
  cloudfront: (r) => ({
    protocol_h: walk(r.default_cache_behavior, 'viewer_protocol_policy'),
  }),
  iam_user: (r) => ({
    create_date: dateH(r.create_date) ?? (r.create_date as string | undefined),
    password_last_used: dateH(r.password_last_used) ?? (r.password_last_used ? String(r.password_last_used) : 'Never'),
  }),
  iam_role: (r) => ({
    create_date: dateH(r.create_date) ?? (r.create_date as string | undefined),
    session_hours: Number.isFinite(Number(r.max_session_duration)) ? `${(Number(r.max_session_duration) / 3600).toFixed(1)}h` : undefined,
  }),
  iam_policy: (r) => ({
    create_date: dateH(r.create_date) ?? (r.create_date as string | undefined),
    update_date: dateH(r.update_date) ?? (r.update_date as string | undefined),
  }),
  msk: (r) => ({
    kafka_version: walk(r.provisioned, 'current_broker_software_info.kafka_version'),
    broker_nodes: walk(r.provisioned, 'number_of_broker_nodes'),
    broker_instance_type: walk(r.provisioned, 'broker_node_group_info.instance_type'),
    broker_ebs_gb: walk(r.provisioned, 'broker_node_group_info.storage_info.ebs_storage_info.volume_size'),
    created_h: dateH(r.creation_time),
  }),
  dynamodb: (r) => ({
    pitr_h: walk(r.point_in_time_recovery_description, 'point_in_time_recovery_status'),
    sse_h: walk(r.sse_description, 'status'),
    item_count_h: Number.isFinite(Number(r.item_count)) ? Number(r.item_count).toLocaleString() : undefined,
    table_size_h: bytesH(r.table_size_bytes),
    billing_h:
      String(r.billing_mode ?? '').toUpperCase() === 'PAY_PER_REQUEST' ? 'On-Demand'
        : String(r.billing_mode ?? '').toUpperCase() === 'PROVISIONED' ? 'Provisioned'
          : (r.billing_mode as string | undefined),
    created_h: dateH(r.creation_date_time),
  }),
  ebs_volume: (r) => {
    const att = asArr(r.attachments);
    const first = att && att.length > 0 ? asObj(att[0]) : null;
    const inst = first ? (walk(first, 'instance_id') as string | undefined) : undefined;
    return { attached_to: inst ?? 'Unattached' };
  },
  // Lambda value formatting (gap L137, v1 parity): null/absent runtime → 'custom' (container-
  // image functions; overriding the raw column keeps the table, runtime donut, facet, and
  // detail panel in agreement — v1 did the COALESCE in SQL), and last_modified formatted.
  lambda: (r) => ({
    runtime: r.runtime ?? 'custom',
    last_modified: dateH(r.last_modified) ?? (r.last_modified as string | undefined),
  }),
  // scan_on_push (gap-audit L107): Yes/No from the JSONB scanning config. A missing/malformed
  // config means scanning is off (the API default), so 'No' — never undefined (keeps the column
  // filterable and the No count honest). The truthiness test deliberately mirrors
  // computeHighlights' countTruthy FALSY set (inventory-types.ts), so a config carrying `1` or
  // "True" can never read KPI-enabled but column-'No'.
  ecr: (r) => {
    const v = walk(r.image_scanning_configuration, 'scan_on_push');
    return {
      scan_on_push: v != null
        && !['', 'false', 'null', 'undefined', '0', 'none', 'no', 'disabled'].includes(String(v).trim().toLowerCase())
        ? 'Yes' : 'No',
    };
  },
  ecs_task: (r) => {
    // Fargate on-demand (ap-northeast-2): $/vCPU-h + $/GB-h — v1 constants (config-overridable in v1).
    const VCPU_H = 0.04656;
    const GB_H = 0.00511;
    const cpu = Number(r.cpu);
    const mem = Number(r.memory);
    const isFargate = String(r.launch_type ?? '').toUpperCase() === 'FARGATE';
    const daily = isFargate && Number.isFinite(cpu) && Number.isFinite(mem)
      ? (cpu / 1024) * VCPU_H * 24 + (mem / 1024) * GB_H * 24
      : undefined;
    const clusterArn = String(r.cluster_arn ?? '');
    return {
      cluster_h: clusterArn ? clusterArn.split('/').pop() : undefined,
      cost_day_num: daily != null ? Math.round(daily * 100) / 100 : undefined,
      cost_day_h: daily != null ? `$${daily.toFixed(2)}` : undefined,
      cost_month_h: daily != null ? `$${(daily * 30).toFixed(2)}` : undefined,
      ..._ecsTaskBase(r),
    };
  },
};

/** Merge type-specific derived fields into a flattened row (missing sources stay undefined). */
export function deriveRow(type: string, row: Row): Row {
  const fn = DERIVERS[type];
  if (!fn) return row;
  const extra = fn(row);
  for (const k of Object.keys(extra)) if (extra[k] === undefined) delete extra[k];
  return { ...row, ...extra };
}
