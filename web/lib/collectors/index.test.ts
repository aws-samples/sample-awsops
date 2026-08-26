import { describe, it, expect, vi, beforeEach } from 'vitest';

const { runQ, avail, clusterCI, nodesCI, rdsFleet, ecFleet, osFleet, mskNodes, mskBrokers, mskHealth, mskLags, albFleet, ctSend, cwSend } = vi.hoisted(() => ({
  runQ: vi.fn(), avail: vi.fn(), clusterCI: vi.fn(), nodesCI: vi.fn(),
  rdsFleet: vi.fn(), ecFleet: vi.fn(), osFleet: vi.fn(),
  mskNodes: vi.fn(), mskBrokers: vi.fn(), mskHealth: vi.fn(), mskLags: vi.fn(),
  albFleet: vi.fn(), ctSend: vi.fn(), cwSend: vi.fn(),
}));

vi.mock('../aws-data', () => ({
  runSteampipeQuery: runQ,
  steampipeAvailable: avail,
  AWS_DATA_ANALYSIS_MODEL: 'test-analysis-model',
}));
vi.mock('../metrics', () => ({
  eksClusterCI: clusterCI, eksNodesCI: nodesCI,
  rdsFleetLive: rdsFleet, elasticacheFleetLive: ecFleet, opensearchFleetLive: osFleet,
  mskListNodes: mskNodes, mskBrokerFleetLive: mskBrokers, mskClusterHealth: mskHealth, mskOffsetLags: mskLags,
  albFleetLive: albFleet,
}));
vi.mock('@aws-sdk/client-cloudtrail', () => ({
  CloudTrailClient: class { send = ctSend },
  LookupEventsCommand: class { constructor(public input: unknown) {} },
}));
vi.mock('@aws-sdk/client-cloudwatch', () => ({
  CloudWatchClient: class { send = cwSend },
  GetMetricDataCommand: class { constructor(public input: unknown) {} },
}));

import { COLLECTORS, collectorByKey, buildAnalysisInput, CONTEXT_CAP, type CollectStep } from './index';
import { IDLE_CATEGORIES } from './idle-scan';
import { albDimFromArn } from './trace-analyze';
import { sectionByKey } from '../sections';
import { matchedSections } from '../route';
import type { ChatLang } from '../chat-i18n';

const ctx = (steps: CollectStep[] = []) => ({
  lang: 'ko' as ChatLang,
  onStep: (s: CollectStep) => steps.push(s),
});

beforeEach(() => {
  for (const m of [runQ, avail, clusterCI, nodesCI, rdsFleet, ecFleet, osFleet, mskNodes, mskBrokers, mskHealth, mskLags, albFleet, ctSend, cwSend]) m.mockReset();
});

// ── registry contract ────────────────────────────────────────────────────────

describe('collector registry', () => {
  it('registers all six v1 collectors; unknown keys return undefined', () => {
    expect(COLLECTORS.map((c) => c.key)).toEqual([
      'idle-scan', 'eks-optimize', 'db-optimize', 'msk-optimize', 'trace-analyze', 'incident',
    ]);
    for (const key of COLLECTORS.map((c) => c.key)) expect(collectorByKey(key)?.key).toBe(key);
    expect(collectorByKey('aws-data')).toBeUndefined(); // aws-data keeps its OWN branch
    expect(collectorByKey('bogus')).toBeUndefined();
  });
  it('every collector key is an ACTIVE section (chat meta/chips depend on it)', () => {
    for (const c of COLLECTORS) {
      const s = sectionByKey(c.key);
      expect(s, c.key).toBeDefined();
      expect(s?.active, c.key).toBe(true);
      expect(c.sectionMeta.agentName.length).toBeGreaterThan(0);
      expect(c.analysisPrompt.length).toBeGreaterThan(100);
    }
  });
  it('every collector key is reachable by at least one keyword rule (classifier aside)', () => {
    expect(matchedSections('유휴 리소스 스캔해줘')).toContain('idle-scan');
    expect(matchedSections('EKS rightsizing 해줘')).toContain('eks-optimize');
    expect(matchedSections('RDS 인스턴스 다운사이징 후보 찾아줘')).toContain('db-optimize');
    expect(matchedSections('MSK 브로커 rightsizing 분석')).toContain('msk-optimize');
    expect(matchedSections('서비스 의존성 분석해줘')).toContain('trace-analyze');
    expect(matchedSections('장애 원인 분석해줘')).toContain('incident');
  });
  it('availability gates ride steampipeAvailable (pre-commit fail-open probe)', async () => {
    avail.mockResolvedValue(false);
    for (const c of COLLECTORS) expect(await c.available()).toBe(false);
    avail.mockResolvedValue(true);
    for (const c of COLLECTORS) expect(await c.available()).toBe(true);
  });
});

// ── analysis prompt assembly (aws-data analyzeStream pattern) ────────────────

describe('buildAnalysisInput', () => {
  const base = { question: 'q?', context: 'CTX', analysisPrompt: 'You are X.' };
  it('wraps question and context in containment tags', () => {
    const { system, user } = buildAnalysisInput(base);
    expect(system).toContain('You are X.');
    expect(system).toContain('DATA ONLY');
    expect(user).toContain('<user_query>\nq?\n</user_query>');
    expect(user).toContain('<collected_data>\nCTX\n</collected_data>');
  });
  it('adds the language directive from the fixed enum only', () => {
    expect(buildAnalysisInput({ ...base, lang: 'ko' as ChatLang }).system).toContain('Korean(한국어)');
    expect(buildAnalysisInput(base).system).not.toContain('CRITICAL: Write');
  });
  it('caps the context block at CONTEXT_CAP', () => {
    const { user } = buildAnalysisInput({ ...base, context: 'x'.repeat(CONTEXT_CAP + 5000) });
    expect(user.length).toBeLessThan(CONTEXT_CAP + 200);
  });
});

// ── idle-scan collector ───────────────────────────────────────────────────────

describe('idle-scan collect', () => {
  it('collects all categories, estimates cost, and reports steps/tools/via', async () => {
    runQ.mockImplementation(async (sql: string) => {
      if (sql.includes('aws_vpc_eip')) {
        return { rows: [{ allocation_id: 'e1', public_ip: '1.1.1.1' }, { allocation_id: 'e2', public_ip: '2.2.2.2' }], rowCount: 2, truncated: false };
      }
      if (sql.includes("volume_type = 'gp2'")) {
        return { rows: [{ volume_id: 'v1', size: 100 }], rowCount: 1, truncated: false };
      }
      return { rows: [], rowCount: 0, truncated: false };
    });
    const steps: CollectStep[] = [];
    const out = await collectorByKey('idle-scan')!.collect(ctx(steps));

    expect(out.collected).toBe(IDLE_CATEGORIES.length); // every query succeeded
    expect(out.tools).toEqual(['steampipe_sql']);
    expect(steps).toHaveLength(IDLE_CATEGORIES.length);
    expect(steps.every((s) => s.tool === 'steampipe_sql' && !!s.query)).toBe(true);
    // 2 EIPs * $3.60 + 100GB gp2 * $0.02 = $9.20
    expect(out.via).toBe('Idle Resource Scanner (3 idle, ~$9/mo)');
    expect(out.context).toContain('$9.20');
    expect(out.context).toContain('Unassociated Elastic IPs');
    expect(out.context).toContain('allocation_id');
  });
  it('fail-open: a failed category is disclosed, the rest still collect', async () => {
    runQ.mockImplementation(async (sql: string) => {
      if (sql.includes('aws_ebs_snapshot')) throw new Error('relation missing');
      return { rows: [], rowCount: 0, truncated: false };
    });
    const out = await collectorByKey('idle-scan')!.collect(ctx());
    expect(out.collected).toBe(IDLE_CATEGORIES.length - 1);
    expect(out.summary.some((s) => s.includes('미가용'))).toBe(true);
    expect(out.context).toContain('Query failed');
  });
  it('total failure ⇒ collected 0 and no tools (chat route degrades honestly)', async () => {
    runQ.mockRejectedValue(new Error('steampipe down'));
    const out = await collectorByKey('idle-scan')!.collect(ctx());
    expect(out.collected).toBe(0);
    expect(out.tools).toEqual([]);
  });
});

// ── eks-optimize collector ────────────────────────────────────────────────────

describe('eks-optimize collect', () => {
  const okSteampipe = () => runQ.mockImplementation(async (sql: string) => {
    if (sql.includes('aws_eks_cluster')) {
      return { rows: [{ name: 'prod', version: '1.31', status: 'ACTIVE', region: 'ap-northeast-2' }], rowCount: 1, truncated: false };
    }
    if (sql.includes('kubernetes_pod')) {
      return { rows: [{ pod_name: 'api-1', namespace: 'default', cpu_request: '500m', memory_request: '1Gi' }], rowCount: 1, truncated: false };
    }
    if (sql.includes('kubernetes_node')) {
      return { rows: [{ node_name: 'n1', capacity_cpu: '4', instance_type: 'm7g.xlarge' }], rowCount: 1, truncated: false };
    }
    return { rows: [], rowCount: 0, truncated: false };
  });

  it('collects clusters + CI metrics + K8s config; discloses skipped v1 sources as 미가용', async () => {
    okSteampipe();
    clusterCI.mockResolvedValue({ nodeCount: 3, restarts: 1, oomKilled: null });
    nodesCI.mockResolvedValue({ n1: { cpu: 12.5, mem: 40 } });
    const steps: CollectStep[] = [];
    const out = await collectorByKey('eks-optimize')!.collect(ctx(steps));

    expect(out.collected).toBe(4); // clusters + 1 CI cluster + pods + nodes
    expect(out.tools).toContain('steampipe_sql');
    expect(out.tools).toContain('cloudwatch_ci');
    expect(out.via).toBe('EKS Cost Optimizer (1 clusters, CI 1/1)');
    expect(out.context).toContain('Container Insights — prod');
    expect(out.context).toContain('m7g.xlarge');
    // skipped v1 sources disclosed, not fatal
    expect(out.summary.filter((s) => s.includes('미가용'))).toHaveLength(2);
    expect(out.summary.some((s) => s.startsWith('Prometheus'))).toBe(true);
    // CI steps carry the cloudwatch tool tag
    expect(steps.some((s) => s.tool === 'cloudwatch_ci' && s.query?.includes('prod'))).toBe(true);
  });
  it('CI without data (Container Insights off) is disclosed; Steampipe data still collects', async () => {
    okSteampipe();
    clusterCI.mockResolvedValue({ nodeCount: null, restarts: null });
    nodesCI.mockResolvedValue({});
    const out = await collectorByKey('eks-optimize')!.collect(ctx());
    expect(out.collected).toBe(3); // clusters + pods + nodes (no CI)
    expect(out.tools).not.toContain('cloudwatch_ci');
    expect(out.summary.some((s) => s.includes('Container Insights') && s.includes('미가용'))).toBe(true);
  });
  it('total failure ⇒ collected 0 (chat route degrades honestly)', async () => {
    runQ.mockRejectedValue(new Error('steampipe down'));
    clusterCI.mockResolvedValue({});
    nodesCI.mockResolvedValue({});
    const out = await collectorByKey('eks-optimize')!.collect(ctx());
    expect(out.collected).toBe(0);
    expect(out.tools).toEqual([]);
  });
});

// ── db-optimize collector ─────────────────────────────────────────────────────

describe('db-optimize collect', () => {
  const okSteampipe = () => runQ.mockImplementation(async (sql: string) => {
    if (sql.includes('aws_rds_db_instance')) {
      return { rows: [{ db_instance_identifier: 'db1', engine: 'aurora-postgresql', engine_version: '15.4', instance_class: 'db.r6g.xlarge', status: 'available', multi_az: true, allocated_storage: 100, storage_type: 'gp3', region: 'ap-northeast-2', account_id: '1' }], rowCount: 1, truncated: false };
    }
    if (sql.includes('aws_elasticache_cluster')) {
      return { rows: [{ cache_cluster_id: 'c1', cache_node_type: 'cache.r6g.large', engine: 'redis', engine_version: '7.1', cache_cluster_status: 'available', num_cache_nodes: 1, region: 'ap-northeast-2', account_id: '1' }], rowCount: 1, truncated: false };
    }
    if (sql.includes('aws_opensearch_domain')) {
      return { rows: [{ domain_name: 'logs', engine_version: 'OpenSearch_2.11', processing: false, cluster_config: '{"InstanceType":"r6g.large.search","InstanceCount":3}', ebs_options: '{"VolumeSize":100,"VolumeType":"gp3"}', region: 'ap-northeast-2', account_id: '1' }], rowCount: 1, truncated: false };
    }
    return { rows: [], rowCount: 0, truncated: false };
  });

  it('collects lists + CloudWatch fleets; enriches config with metrics', async () => {
    okSteampipe();
    rdsFleet.mockResolvedValue({ db1: { cpu: 11.2, conn: 4, freeStorage: 9e10 } });
    ecFleet.mockResolvedValue({ c1: { cpu: 6.1, dbMemPct: 22 } });
    osFleet.mockResolvedValue({ logs: { cpu: 9.9, jvm: 41 } });
    const steps: CollectStep[] = [];
    const out = await collectorByKey('db-optimize')!.collect(ctx(steps));

    expect(out.collected).toBe(4); // 3 lists + 1 metrics pass
    expect(out.tools).toEqual(['steampipe_sql', 'cloudwatch_metrics']);
    expect(out.via).toBe('DB Rightsizing (3 resources, 3 metric sets)');
    expect(out.context).toContain('## RDS Instances');
    expect(out.context).toContain('db.r6g.xlarge');
    expect(out.context).toContain('r6g.large.search'); // parsed cluster_config JSONB
    expect(out.context).toContain('"cpu":11.2');
    expect(steps.filter((s) => s.tool === 'steampipe_sql')).toHaveLength(3);
    expect(steps.filter((s) => s.tool === 'cloudwatch_metrics')).toHaveLength(3);
    expect(rdsFleet).toHaveBeenCalledWith(['db1']);
  });
  it('fail-open: one failed list is disclosed; all-null metrics disclosed as 미가용', async () => {
    runQ.mockImplementation(async (sql: string) => {
      if (sql.includes('aws_rds_db_instance')) throw new Error('rds table hydrate blocked');
      if (sql.includes('aws_elasticache_cluster')) {
        return { rows: [{ cache_cluster_id: 'c1' }], rowCount: 1, truncated: false };
      }
      return { rows: [], rowCount: 0, truncated: false };
    });
    ecFleet.mockResolvedValue({ c1: { cpu: null, conn: null } }); // no datapoints
    const out = await collectorByKey('db-optimize')!.collect(ctx());
    expect(out.collected).toBe(2); // ec + os lists
    expect(out.summary.some((s) => s.startsWith('RDS instances') && s.includes('미가용'))).toBe(true);
    expect(out.summary.some((s) => s.startsWith('CloudWatch metrics') && s.includes('미가용'))).toBe(true);
    expect(out.tools).toEqual(['steampipe_sql']);
    expect(rdsFleet).not.toHaveBeenCalled(); // no ids to probe
  });
  it('total failure ⇒ collected 0 and no tools (chat route degrades honestly)', async () => {
    runQ.mockRejectedValue(new Error('steampipe down'));
    const out = await collectorByKey('db-optimize')!.collect(ctx());
    expect(out.collected).toBe(0);
    expect(out.tools).toEqual([]);
    expect(out.context).toContain('No DB optimization data');
  });
});

// ── msk-optimize collector ────────────────────────────────────────────────────

describe('msk-optimize collect', () => {
  const clusterRow = {
    cluster_name: 'events', cluster_arn: 'arn:aws:kafka:ap-northeast-2:1:cluster/events/uuid',
    state: 'ACTIVE', kafka_version: '3.6.0', number_of_broker_nodes: 3,
    instance_type: 'kafka.m5.large', ebs_volume_gb: '1000', region: 'ap-northeast-2', account_id: '1',
  };

  it('collects cluster config + nodes + broker metrics + health + offset lag; Prometheus 미가용', async () => {
    runQ.mockResolvedValue({ rows: [clusterRow], rowCount: 1, truncated: false });
    mskNodes.mockResolvedValue([
      { nodeType: 'BROKER', brokerId: 1, instanceType: 'kafka.m5.large', clientVpcIp: null, eni: null, endpoints: ['b-1'] },
      { nodeType: 'BROKER', brokerId: 2, instanceType: 'kafka.m5.large', clientVpcIp: null, eni: null, endpoints: ['b-2'] },
    ]);
    mskBrokers.mockResolvedValue({ '1': { cpuUser: 9.5, dataDisk: 31 }, '2': { cpuUser: 12.1, dataDisk: 30 } });
    mskHealth.mockResolvedValue({ activeControllers: 1, offlinePartitions: 0 });
    mskLags.mockResolvedValue([{ consumerGroup: 'g1', topic: 't1', maxOffsetLag: 42 }]);
    const steps: CollectStep[] = [];
    const out = await collectorByKey('msk-optimize')!.collect(ctx(steps));

    expect(out.collected).toBe(3); // clusters + nodes + 1 cluster with CW data
    expect(out.tools).toEqual(['steampipe_sql', 'msk_api', 'cloudwatch_metrics']);
    expect(out.via).toBe('MSK Broker Optimizer (1 clusters, 2 brokers, CW 1/1)');
    expect(out.context).toContain('## Cluster events — broker topology');
    expect(out.context).toContain('MaxOffsetLag');
    expect(out.context).toContain('"cpuUser":9.5');
    expect(out.summary.some((s) => s.startsWith('Prometheus') && s.includes('미가용'))).toBe(true);
    expect(mskBrokers).toHaveBeenCalledWith('events', [1, 2], 'ap-northeast-2');
    expect(steps.some((s) => s.tool === 'msk_api')).toBe(true);
  });
  it('no CloudWatch data is disclosed; config/nodes still collect', async () => {
    runQ.mockResolvedValue({ rows: [clusterRow], rowCount: 1, truncated: false });
    mskNodes.mockResolvedValue([{ nodeType: 'BROKER', brokerId: 1, instanceType: 'kafka.m5.large', clientVpcIp: null, eni: null, endpoints: [] }]);
    mskBrokers.mockResolvedValue({ '1': { cpuUser: null } });
    mskHealth.mockResolvedValue({ activeControllers: null });
    mskLags.mockResolvedValue([]);
    const out = await collectorByKey('msk-optimize')!.collect(ctx());
    expect(out.collected).toBe(2); // clusters + nodes
    expect(out.tools).toEqual(['steampipe_sql', 'msk_api']);
    expect(out.summary.some((s) => s.includes('CloudWatch broker/cluster metrics') && s.includes('미가용'))).toBe(true);
  });
  it('total failure ⇒ collected 0 and no tools', async () => {
    runQ.mockRejectedValue(new Error('steampipe down'));
    const out = await collectorByKey('msk-optimize')!.collect(ctx());
    expect(out.collected).toBe(0);
    expect(out.tools).toEqual([]);
    expect(mskNodes).not.toHaveBeenCalled(); // no clusters to probe
  });
});

// ── trace-analyze collector ───────────────────────────────────────────────────

describe('trace-analyze collect', () => {
  it('albDimFromArn extracts the CloudWatch LoadBalancer dimension (app/* only)', () => {
    expect(albDimFromArn('arn:aws:elasticloadbalancing:ap-northeast-2:1:loadbalancer/app/web/50dc6c495c0c9188')).toBe('app/web/50dc6c495c0c9188');
    expect(albDimFromArn('arn:aws:elasticloadbalancing:ap-northeast-2:1:loadbalancer/net/tcp/abc')).toBeNull();
    expect(albDimFromArn('garbage')).toBeNull();
  });
  it('collects ALBs + latency/error metrics sorted worst-p99-first; v1 trace sources 미가용', async () => {
    runQ.mockResolvedValue({
      rows: [
        { name: 'web', arn: 'arn:aws:elasticloadbalancing:ap-northeast-2:1:loadbalancer/app/web/aaa', region: 'ap-northeast-2', account_id: '1' },
        { name: 'api', arn: 'arn:aws:elasticloadbalancing:ap-northeast-2:1:loadbalancer/app/api/bbb', region: 'ap-northeast-2', account_id: '1' },
      ], rowCount: 2, truncated: false,
    });
    albFleet.mockResolvedValue({
      'app/web/aaa': { respP50: 0.02, respP99: 0.4, elb5xx: 0, tgt5xx: 2, requests: 1000 },
      'app/api/bbb': { respP50: 0.1, respP99: 2.5, elb5xx: 7, tgt5xx: 0, requests: 500 },
    });
    const steps: CollectStep[] = [];
    const out = await collectorByKey('trace-analyze')!.collect(ctx(steps));

    expect(out.collected).toBe(2);
    expect(out.tools).toEqual(['steampipe_sql', 'cloudwatch_metrics']);
    expect(out.via).toBe('Service Latency Analyzer (2 ALBs, metrics 2)');
    // worst p99 first: api (2.5s) before web (0.4s)
    expect(out.context.indexOf('"service":"api"')).toBeLessThan(out.context.indexOf('"service":"web"'));
    // v1 sources disclosed as unavailable, never fatal
    expect(out.summary.filter((s) => s.includes('미가용'))).toHaveLength(3);
    expect(out.summary.some((s) => s.startsWith('Tempo/Jaeger'))).toBe(true);
    expect(albFleet).toHaveBeenCalledWith(['app/web/aaa', 'app/api/bbb']);
    expect(steps.some((s) => s.tool === 'cloudwatch_metrics' && s.query?.includes('2 ALBs'))).toBe(true);
  });
  it('all-null fleet (idle ALBs) is disclosed; discovery still collects', async () => {
    runQ.mockResolvedValue({
      rows: [{ name: 'web', arn: 'arn:aws:elasticloadbalancing:ap-northeast-2:1:loadbalancer/app/web/aaa' }], rowCount: 1, truncated: false,
    });
    albFleet.mockResolvedValue({ 'app/web/aaa': { respP99: null, elb5xx: null } });
    const out = await collectorByKey('trace-analyze')!.collect(ctx());
    expect(out.collected).toBe(1);
    expect(out.tools).toEqual(['steampipe_sql']);
    expect(out.summary.some((s) => s.includes('ALB latency/error metrics') && s.includes('미가용'))).toBe(true);
  });
  it('total failure ⇒ collected 0 and no tools', async () => {
    runQ.mockRejectedValue(new Error('steampipe down'));
    const out = await collectorByKey('trace-analyze')!.collect(ctx());
    expect(out.collected).toBe(0);
    expect(out.tools).toEqual([]);
    expect(albFleet).not.toHaveBeenCalled();
  });
});

// ── incident collector ────────────────────────────────────────────────────────

describe('incident collect', () => {
  const alarmRow = {
    name: 'HighCPU', namespace: 'AWS/EC2', metric_name: 'CPUUtilization',
    state_value: 'ALARM', state_reason: 'Threshold Crossed', state_updated_timestamp: '2026-08-02T01:00:00Z',
    dimensions: '[{"Name":"InstanceId","Value":"i-1"}]', region: 'ap-northeast-2', account_id: '1',
  };

  it('correlates alarms + alarmed-metric series + K8s warnings + CloudTrail writes', async () => {
    runQ.mockImplementation(async (sql: string) => {
      if (sql.includes('aws_cloudwatch_alarm')) return { rows: [alarmRow], rowCount: 1, truncated: false };
      if (sql.includes('kubernetes_event')) return { rows: [{ reason: 'BackOff', message: 'restarting', namespace: 'default' }], rowCount: 1, truncated: false };
      return { rows: [], rowCount: 0, truncated: false };
    });
    cwSend.mockResolvedValue({
      MetricDataResults: [{ Id: 'alarm_i0', Timestamps: [new Date('2026-08-02T00:55:00Z')], Values: [97.2] }],
    });
    ctSend.mockResolvedValue({
      Events: [{ EventTime: new Date('2026-08-02T00:50:00Z'), EventName: 'ModifyInstanceAttribute', EventSource: 'ec2.amazonaws.com', Username: 'admin', Resources: [{ ResourceType: 'AWS::EC2::Instance', ResourceName: 'i-1' }] }],
    });
    const steps: CollectStep[] = [];
    const out = await collectorByKey('incident')!.collect(ctx(steps));

    expect(out.collected).toBe(4); // alarms + series + k8s + trail
    expect(out.tools).toEqual(['steampipe_sql', 'cloudwatch_metrics', 'cloudtrail_lookup']);
    expect(out.via).toBe('Incident Analyzer (3 findings, 3 sources)');
    expect(out.context).toContain('HighCPU');
    expect(out.context).toContain('Alarmed Metric Series');
    expect(out.context).toContain('ModifyInstanceAttribute');
    expect(out.context).toContain('BackOff');
    expect(out.summary.some((s) => s.includes('Prometheus') && s.includes('미가용'))).toBe(true);
    expect(steps.some((s) => s.tool === 'cloudtrail_lookup')).toBe(true);
    expect(steps.some((s) => s.tool === 'cloudwatch_metrics')).toBe(true);
  });
  it('no alarms + no K8s connection still collects (healthy state is a finding)', async () => {
    runQ.mockImplementation(async (sql: string) => {
      if (sql.includes('aws_cloudwatch_alarm')) return { rows: [], rowCount: 0, truncated: false };
      throw new Error('kubernetes plugin not connected');
    });
    ctSend.mockResolvedValue({ Events: [] });
    const out = await collectorByKey('incident')!.collect(ctx());
    expect(out.collected).toBe(2); // alarms(empty ok) + trail(empty ok)
    expect(out.context).toContain('No active alarms.');
    expect(out.summary.some((s) => s.startsWith('K8s warning events') && s.includes('미가용'))).toBe(true);
    expect(cwSend).not.toHaveBeenCalled(); // no alarmed metrics to fetch
  });
  it('total failure ⇒ collected 0 and no tools (chat route degrades honestly)', async () => {
    runQ.mockRejectedValue(new Error('steampipe down'));
    ctSend.mockRejectedValue(new Error('AccessDenied'));
    const out = await collectorByKey('incident')!.collect(ctx());
    expect(out.collected).toBe(0);
    expect(out.tools).toEqual([]);
    expect(out.summary.some((s) => s.includes('CloudTrail') && s.includes('미가용'))).toBe(true);
  });
});
