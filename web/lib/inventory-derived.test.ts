import { describe, it, expect } from 'vitest';
import { deriveRow, countFlags } from './inventory-derived';

// lambda deriver (gap-audit L137, v1 parity): null runtime → 'custom'; last_modified formatted.
describe('deriveRow lambda formatting', () => {
  it('null/absent runtime becomes custom (container-image functions)', () => {
    expect(deriveRow('lambda', { runtime: null }).runtime).toBe('custom');
    expect(deriveRow('lambda', {}).runtime).toBe('custom');
    expect(deriveRow('lambda', { runtime: 'python3.12' }).runtime).toBe('python3.12');
  });
  it('last_modified formats to YYYY-MM-DD HH:mm; unparseable values pass through', () => {
    expect(deriveRow('lambda', { last_modified: '2026-08-31T10:00:00.000Z' }).last_modified).toBe('2026-08-31 10:00');
    expect(deriveRow('lambda', { last_modified: 'not-a-date' }).last_modified).toBe('not-a-date');
  });
});

// ecr deriver (gap-audit L107): scan_on_push Yes/No from the JSONB scanning config.
describe('deriveRow ecr scan_on_push', () => {
  it('Yes when scan_on_push is true (object form)', () => {
    expect(deriveRow('ecr', { image_scanning_configuration: { scan_on_push: true } }).scan_on_push).toBe('Yes');
  });
  it('Yes when the config arrives as a JSON string with PascalCase key', () => {
    expect(deriveRow('ecr', { image_scanning_configuration: '{"ScanOnPush": "true"}' }).scan_on_push).toBe('Yes');
  });
  // Truthiness mirrors countTruthy's FALSY set — 1 / "True" must not read KPI-enabled but column-'No'.
  it('Yes for a numeric 1 and a capitalized "True" (countTruthy parity)', () => {
    expect(deriveRow('ecr', { image_scanning_configuration: { scan_on_push: 1 } }).scan_on_push).toBe('Yes');
    expect(deriveRow('ecr', { image_scanning_configuration: '{"ScanOnPush": "True"}' }).scan_on_push).toBe('Yes');
  });
  it('No when scan_on_push is false', () => {
    expect(deriveRow('ecr', { image_scanning_configuration: { scan_on_push: false } }).scan_on_push).toBe('No');
  });
  it('No when the config is missing or malformed (API default is off)', () => {
    expect(deriveRow('ecr', {}).scan_on_push).toBe('No');
    expect(deriveRow('ecr', { image_scanning_configuration: 'not json {' }).scan_on_push).toBe('No');
  });
  it('preserves the original row fields', () => {
    const out = deriveRow('ecr', { repository_uri: 'x', image_scanning_configuration: { scan_on_push: true } });
    expect(out.repository_uri).toBe('x');
  });
});

describe('deriveRow opensearch structured detail (gap L150)', () => {
  const full = {
    cluster_config: {
      InstanceType: 'r6g.large.search', InstanceCount: 3,
      DedicatedMasterEnabled: true, DedicatedMasterType: 'm6g.large.search', DedicatedMasterCount: 3,
      ZoneAwarenessEnabled: true, ZoneAwarenessConfig: { AvailabilityZoneCount: 3 },
      WarmEnabled: false, ColdStorageOptions: { Enabled: false }, MultiAZWithStandbyEnabled: true,
    },
    ebs_options: { EBSEnabled: true, VolumeType: 'gp3', VolumeSize: 100, Iops: 3000, Throughput: 125 },
    vpc_options: { VPCId: 'vpc-1', SubnetIds: ['subnet-a', 'subnet-b'], SecurityGroupIds: ['sg-1'], AvailabilityZones: ['apne2-az1'] },
    encryption_at_rest_options: { Enabled: true, KmsKeyId: 'key-1' },
    advanced_security_options: { Enabled: true, InternalUserDatabaseEnabled: false, AnonymousAuthEnabled: false },
    cognito_options: { Enabled: false },
    node_to_node_encryption_options_enabled: true,
  };

  it('flattens cluster_config into readable fields', () => {
    const d = deriveRow('opensearch', { ...full });
    expect(d.dedicated_master_h).toBe('m6g.large.search × 3');
    expect(d.zone_awareness_h).toBe('enabled (3 AZ)');
    expect(d.warm_storage_h).toBe('disabled');
    expect(d.cold_storage_h).toBe('disabled');
    expect(d.multi_az_standby_h).toBe('enabled');
  });

  it('EBS one-liner carries type/size/IOPS/throughput; VPC arrays pass through raw (idlist rows)', () => {
    const d = deriveRow('opensearch', { ...full });
    expect(d.ebs_volume_h).toBe('gp3 · 100 GB · 3000 IOPS · 125 MB/s');
    expect(d.vpc_id_h).toBe('vpc-1');
    expect(d.subnets_h).toEqual(['subnet-a', 'subnet-b']); // arrays stay arrays → one-per-row rendering
    expect(d.security_groups_h).toEqual(['sg-1']);
  });

  it('security fields: KMS key surfaced, advanced-security as real booleans (Badge rendering)', () => {
    const d = deriveRow('opensearch', { ...full });
    expect(d.kms_key_h).toBe('key-1');
    expect(d.adv_security_h).toBe(true);
    expect(d.internal_user_db_h).toBe(false);
    expect(d.cognito_h).toBe(false);
  });

  it('missing JSONB blobs → undefined fields (absent from the panel), never fabricated values', () => {
    const d = deriveRow('opensearch', { resource_id: 'dom-2' });
    expect(d.dedicated_master_h).toBeUndefined();
    expect(d.ebs_volume_h).toBeUndefined();
    expect(d.adv_security_h).toBeUndefined();
    expect(d.cognito_h).toBeUndefined();
  });

  it('EBS disabled renders disabled (blob present, feature off)', () => {
    const d = deriveRow('opensearch', { ebs_options: { EBSEnabled: false } });
    expect(d.ebs_volume_h).toBe('disabled');
  });

  it('an EMPTY {} blob never fabricates disabled — absent keys stay undefined', () => {
    const d = deriveRow('opensearch', { cluster_config: {}, ebs_options: {}, advanced_security_options: {} });
    expect(d.dedicated_master_h).toBeUndefined();
    expect(d.cold_storage_h).toBeUndefined();
    expect(d.ebs_volume_h).toBeUndefined();
    expect(d.adv_security_h).toBeUndefined();
  });

  it('L153 sync additions: service software / endpoint policy / auto-tune / snapshot hour', () => {
    const d = deriveRow('opensearch', {
      service_software_options: { UpdateAvailable: true, CurrentVersion: 'OpenSearch_2.11', NewVersion: 'OpenSearch_2.13' },
      domain_endpoint_options: { EnforceHTTPS: true, TLSSecurityPolicy: 'Policy-Min-TLS-1-2-2019-07', CustomEndpointEnabled: false },
      auto_tune_options: { State: 'ENABLED' },
      snapshot_options: { AutomatedSnapshotStartHour: 3 },
    });
    expect(d.software_update_h).toBe('update available: OpenSearch_2.11 → OpenSearch_2.13');
    expect(d.enforce_https_h).toBe(true);
    expect(d.tls_policy_h).toBe('Policy-Min-TLS-1-2-2019-07');
    expect(d.custom_endpoint_h).toBe('disabled');
    expect(d.auto_tune_h).toBe('ENABLED');
    expect(d.snapshot_hour_h).toBe('3:00 UTC');
  });

  it('L153: UpdateStatus drives the label — NOT_ELIGIBLE/IN_PROGRESS never read as healthy', () => {
    const notEligible = deriveRow('opensearch', {
      service_software_options: { UpdateAvailable: false, UpdateStatus: 'NOT_ELIGIBLE', CurrentVersion: 'ES_7.10' },
    });
    expect(notEligible.software_update_h).toBe('not eligible for update (ES_7.10) — domain upgrade required');
    const inProgress = deriveRow('opensearch', {
      service_software_options: { UpdateAvailable: false, UpdateStatus: 'IN_PROGRESS', CurrentVersion: 'OpenSearch_2.11', NewVersion: 'OpenSearch_2.13' },
    });
    expect(inProgress.software_update_h).toBe('update in progress: OpenSearch_2.11 → OpenSearch_2.13');
    const pending = deriveRow('opensearch', {
      service_software_options: { UpdateStatus: 'PENDING_UPDATE', CurrentVersion: 'OpenSearch_2.11', NewVersion: 'OpenSearch_2.13' },
    });
    expect(pending.software_update_h).toBe('update pending: OpenSearch_2.11 → OpenSearch_2.13');
    const completed = deriveRow('opensearch', {
      service_software_options: { UpdateStatus: 'COMPLETED', CurrentVersion: 'OpenSearch_2.13' },
    });
    expect(completed.software_update_h).toBe('up to date (OpenSearch_2.13)');
  });

  it('L153: up-to-date software, enabled custom endpoint (domain shown), absent blobs → undefined', () => {
    const upToDate = deriveRow('opensearch', {
      service_software_options: { UpdateAvailable: false, CurrentVersion: 'OpenSearch_2.13' },
      domain_endpoint_options: { CustomEndpointEnabled: true, CustomEndpoint: 'search.example.com' },
    });
    expect(upToDate.software_update_h).toBe('no update available (OpenSearch_2.13)');
    expect(upToDate.custom_endpoint_h).toBe('search.example.com');
    const withCert = deriveRow('opensearch', {
      domain_endpoint_options: { CustomEndpointEnabled: true, CustomEndpoint: 's.example.com', CustomEndpointCertificateArn: 'arn:aws:acm:ap-northeast-2:1:certificate/x' },
    });
    expect(withCert.custom_endpoint_cert_h).toBe('arn:aws:acm:ap-northeast-2:1:certificate/x');
    const empty = deriveRow('opensearch', { resource_id: 'dom-2' });
    expect(empty.software_update_h).toBeUndefined();
    expect(empty.enforce_https_h).toBeUndefined();
    expect(empty.auto_tune_h).toBeUndefined();
    expect(empty.snapshot_hour_h).toBeUndefined();
  });

  it("string-typed booleans ('true'/'false') are tolerated like boolH", () => {
    const d = deriveRow('opensearch', {
      cluster_config: { DedicatedMasterEnabled: 'false', ColdStorageOptions: { Enabled: 'true' } },
      advanced_security_options: { Enabled: 'true' },
    });
    expect(d.dedicated_master_h).toBe('disabled');
    expect(d.cold_storage_h).toBe('enabled');
    expect(d.adv_security_h).toBe(true);
  });
});

describe('deriveRow ecr encryption + cloudtrail last delivery (gap L213/L188)', () => {
  it('ecr encryption_type_h extracts AES256/KMS from encryption_configuration (both casings)', () => {
    expect(deriveRow('ecr', { encryption_configuration: { encryptionType: 'AES256' } }).encryption_type_h).toBe('AES256');
    expect(deriveRow('ecr', { encryption_configuration: { encryption_type: 'KMS' } }).encryption_type_h).toBe('KMS');
    // the plugin actually persists PascalCase — and future values (KMS_DSSE) pass through as-is
    expect(deriveRow('ecr', { encryption_configuration: { EncryptionType: 'KMS_DSSE' } }).encryption_type_h).toBe('KMS_DSSE');
    expect(deriveRow('ecr', { resource_id: 'r' }).encryption_type_h).toBeUndefined();
  });
  it('cloudtrail last_delivery_h formats the synced timestamp; absent → undefined', () => {
    expect(deriveRow('cloudtrail', { latest_delivery_time: '2026-09-01T03:04:00Z' }).last_delivery_h).toBe('2026-09-01 03:04');
    // The REAL persisted shape: pg8000 datetime through json.dumps(default=str) — space-separated.
    expect(deriveRow('cloudtrail', { latest_delivery_time: '2026-09-01 03:04:00+00:00' }).last_delivery_h).toBe('2026-09-01 03:04');
    expect(deriveRow('cloudtrail', { resource_id: 't' }).last_delivery_h).toBeUndefined();
  });
});

describe('deriveRow lambda size/layers/vpc + waf action (gap L231/L232/L252)', () => {
  it('code_size_h renders human-readable bytes', () => {
    expect(deriveRow('lambda', { code_size: 1536 }).code_size_h).toBe('1.5 KB');
    expect(deriveRow('lambda', { code_size: 5_242_880 }).code_size_h).toBe('5.0 MB');
    expect(deriveRow('lambda', { resource_id: 'f' }).code_size_h).toBeUndefined();
    // synced-but-null must read unknown, not a confident '0 B'
    expect(deriveRow('lambda', { code_size: null }).code_size_h).toBeUndefined();
  });
  it("layers_h parses ARNs into name:version rows (string and {Arn} shapes); absent → undefined", () => {
    const d = deriveRow('lambda', { layers: [
      'arn:aws:lambda:ap-northeast-2:1:layer:shared-utils:3',
      { Arn: 'arn:aws:lambda:ap-northeast-2:1:layer:telemetry:12' },
    ] });
    expect(d.layers_h).toEqual(['shared-utils:3', 'telemetry:12']);
    expect(deriveRow('lambda', { resource_id: 'f' }).layers_h).toBeUndefined();
    // all-unresolvable entries fall back to undefined (raw layers stays reachable), never []
    expect(deriveRow('lambda', { layers: [{ bogus: 1 }] }).layers_h).toBeUndefined();
  });
  it("vpc_h tri-state: id / explicit 'Not in VPC' when null / undefined when the field is absent", () => {
    expect(deriveRow('lambda', { vpc_id: 'vpc-1' }).vpc_h).toBe('vpc-1');
    expect(deriveRow('lambda', { vpc_id: null }).vpc_h).toBe('Not in VPC');
    expect(deriveRow('lambda', { vpc_id: '' }).vpc_h).toBe('Not in VPC');
    expect(deriveRow('lambda', { resource_id: 'f' }).vpc_h).toBeUndefined();
  });
  it("waf default_action_h is the object's own single top-level key; malformed → undefined", () => {
    expect(deriveRow('waf', { default_action: { Allow: {} } }).default_action_h).toBe('Allow');
    expect(deriveRow('waf', { default_action: { Block: {} } }).default_action_h).toBe('Block');
    expect(deriveRow('waf', { default_action: { Allow: {}, Block: {} } }).default_action_h).toBeUndefined();
    expect(deriveRow('waf', { resource_id: 'w' }).default_action_h).toBeUndefined();
  });
});

describe('opensearch encryption_status_h (gap L236)', () => {
  const row = (rest: unknown, n2n: unknown) => deriveRow('opensearch', {
    encryption_at_rest_options: rest === undefined ? undefined : { Enabled: rest },
    node_to_node_encryption_options_enabled: n2n,
  });
  it('Full / Partial / No from the at-rest + n2n pair', () => {
    expect(row(true, true).encryption_status_h).toBe('Full Encryption');
    expect(row(true, false).encryption_status_h).toBe('Partial');
    expect(row(false, true).encryption_status_h).toBe('Partial');
    expect(row(false, false).encryption_status_h).toBe('No Encryption');
  });
  it("unknown EITHER side → undefined — never counted as 'No Encryption'", () => {
    expect(row(undefined, true).encryption_status_h).toBeUndefined();
    expect(row(true, undefined).encryption_status_h).toBeUndefined();
    expect(deriveRow('opensearch', { resource_id: 'd' }).encryption_status_h).toBeUndefined();
  });
});

describe('countFlags (gap L240 — flagBarKey Security Status bars)', () => {
  const FLAGS = [
    { name: 'Private', col: 'bucket_policy_is_public', negate: true },
    { name: 'Public', col: 'bucket_policy_is_public' },
    { name: 'Versioned', col: 'versioning_enabled' },
  ];
  it('counts strict true / strict false (negate) with string coercion', () => {
    const rows = [
      { bucket_policy_is_public: false, versioning_enabled: true },
      { bucket_policy_is_public: 'false', versioning_enabled: 'true' },
      { bucket_policy_is_public: true, versioning_enabled: false },
    ];
    expect(countFlags(rows, FLAGS)).toEqual([
      { name: 'Private', value: 2 },
      { name: 'Public', value: 1 },
      { name: 'Versioned', value: 2 },
    ]);
  });
  it('an all-unknown column drops its flags entirely (0/0 must not read as all-clear)', () => {
    const rows = [
      { bucket_policy_is_public: null, versioning_enabled: true },
      { versioning_enabled: false },
      { bucket_policy_is_public: 'maybe', versioning_enabled: true },
    ];
    // bucket_policy_is_public has no known value on any row (unsynced/denied) → Private AND
    // Public are omitted; Versioned (known values exist) still charts.
    expect(countFlags(rows, FLAGS)).toEqual([{ name: 'Versioned', value: 2 }]);
  });
  it('keeps the declared order and zero bars once the column has ANY known value', () => {
    const out = countFlags([{ bucket_policy_is_public: false }, { versioning_enabled: true }], FLAGS);
    expect(out.map((d) => d.name)).toEqual(['Private', 'Public', 'Versioned']);
    expect(out[1]).toEqual({ name: 'Public', value: 0 }); // a real zero — signal, kept
  });
});

describe('deriveRow waf_ip_set addresses_count (gap L253)', () => {
  it('counts the addresses array; undefined when absent (never a fabricated 0)', () => {
    expect(deriveRow('waf_ip_set', { resource_id: 'a', addresses: ['1.2.3.4/32', '10.0.0.0/8'] }).addresses_count).toBe(2);
    expect(deriveRow('waf_ip_set', { resource_id: 'b', addresses: [] }).addresses_count).toBe(0);
    expect(deriveRow('waf_ip_set', { resource_id: 'c' }).addresses_count).toBeUndefined();
  });
});
