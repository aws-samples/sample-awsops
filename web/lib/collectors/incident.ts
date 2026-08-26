// Incident Analyzer collector — v1 port (v1 src/lib/collectors/incident.ts) on v2 sources.
// 다중 소스 인시던트 분석 컬렉터: CloudWatch 알람(ALARM) + K8s 경고 이벤트(Steampipe) +
// 최근 CloudTrail 변경 이벤트 + 알람 관련 메트릭 시계열 수집.
//
// v1 → v2 source mapping:
// - CloudWatch ALARM alarms (v1 Steampipe)  → runSteampipeQuery (guarded), + NEW: the alarmed
//   metric's last-1h series via GetMetricData (v1 had no related-metric fetch).
// - K8s warning events (v1 Steampipe)       → same query; fails gracefully without a K8s connection.
// - Recent CloudTrail events (v1 gap in this collector, task spec): cloudtrail LookupEvents,
//   write events only (ReadOnly=false) — "who changed what right before the incident".
// - Prometheus anomalies / Loki error logs / Tempo error traces (v1 optional datasources)
//   → 미가용 in v2 (no datasource client here) — SKIPPED per item and disclosed.
import { CloudTrailClient, LookupEventsCommand } from '@aws-sdk/client-cloudtrail';
import { CloudWatchClient, GetMetricDataCommand } from '@aws-sdk/client-cloudwatch';
import { runSteampipeQuery, steampipeAvailable } from '../aws-data';
import type { ChatCollector, CollectCtx, CollectOutput } from './index';

const REGION = process.env.AWS_REGION || 'ap-northeast-2';
let ct: CloudTrailClient | null = null;
let cw: CloudWatchClient | null = null;
const ctClient = () => (ct ??= new CloudTrailClient({ region: REGION }));
const cwClient = () => (cw ??= new CloudWatchClient({ region: REGION }));

/** Test hook: drop the cached SDK clients. */
export function _resetForTests(): void {
  ct = null;
  cw = null;
}

const ALARM_METRIC_CAP = 5;   // alarms whose metric series we fetch
const TRAIL_MAX = 50;         // recent write events

// ── Steampipe SQL (v1 incident.ts queries + region/dimensions for the related-metric fetch) ──

export const INCIDENT_SQL = {
  // v1 CLOUDWATCH_ALARMS_SQL + dimensions/region (dimensions feed the GetMetricData follow-up)
  alarms: `
SELECT
  name,
  namespace,
  metric_name,
  state_value,
  state_reason,
  state_updated_timestamp,
  dimensions::text AS dimensions,
  region,
  account_id
FROM aws_cloudwatch_alarm
WHERE state_value = 'ALARM'
ORDER BY state_updated_timestamp DESC
LIMIT 20`,

  // v1 K8S_WARNING_EVENTS_SQL verbatim (+ LIMIT kept)
  k8sEvents: `
SELECT
  reason,
  message,
  type,
  namespace,
  involved_object_kind,
  involved_object_name,
  last_timestamp
FROM kubernetes_event
WHERE type = 'Warning'
ORDER BY last_timestamp DESC
LIMIT 30`,
} as const;

const oneLine = (sql: string) => sql.trim().replace(/\s+/g, ' ');
const str = (v: unknown) => (v == null ? '' : String(v));

interface AlarmRow {
  name: string; namespace: string; metricName: string;
  dims: { Name: string; Value: string }[]; region: string;
}

function parseAlarmRow(row: Record<string, unknown>): AlarmRow | null {
  const namespace = str(row.namespace);
  const metricName = str(row.metric_name);
  if (!namespace || !metricName) return null;
  let dims: { Name: string; Value: string }[] = [];
  try {
    const raw = typeof row.dimensions === 'string' ? JSON.parse(row.dimensions) : row.dimensions;
    if (Array.isArray(raw)) {
      dims = raw
        .map((d) => ({ Name: str((d as Record<string, unknown>).Name), Value: str((d as Record<string, unknown>).Value) }))
        .filter((d) => d.Name && d.Value);
    }
  } catch { /* dimensionless alarm metrics are still queryable */ }
  return { name: str(row.name), namespace, metricName, dims, region: str(row.region) };
}

/** Last-1h series (Period 300, Average) for each alarmed metric — one GetMetricData batch.
 *  Fail-open: any error returns {} (disclosed by the caller as 미가용). */
async function alarmMetricSeries(alarms: AlarmRow[]): Promise<Record<string, { t: string; v: number }[]>> {
  if (!alarms.length) return {};
  try {
    const r = await cwClient().send(new GetMetricDataCommand({
      StartTime: new Date(Date.now() - 3600_000), EndTime: new Date(),
      MetricDataQueries: alarms.map((a, i) => ({
        Id: `alarm_i${i}`, ReturnData: true,
        MetricStat: {
          Metric: { Namespace: a.namespace, MetricName: a.metricName, Dimensions: a.dims },
          Period: 300, Stat: 'Average',
        },
      })),
    }));
    const out: Record<string, { t: string; v: number }[]> = {};
    for (const res of r.MetricDataResults ?? []) {
      const m = (res.Id ?? '').match(/^alarm_i(\d+)$/);
      const alarm = m ? alarms[Number(m[1])] : undefined;
      if (!alarm) continue;
      const points = (res.Timestamps ?? []).map((t, j) => ({
        t: t instanceof Date ? t.toISOString() : String(t),
        v: res.Values?.[j] ?? NaN,
      })).filter((p) => Number.isFinite(p.v));
      points.sort((a, b) => a.t.localeCompare(b.t));
      if (points.length) out[alarm.name] = points;
    }
    return out;
  } catch {
    return {};
  }
}

/** Recent CloudTrail WRITE events (ReadOnly=false) — "who changed what". Throws to the caller
 *  (Promise.allSettled) so the failure is disclosed per-source, never fatal. */
async function recentWriteEvents(): Promise<Record<string, unknown>[]> {
  const r = await ctClient().send(new LookupEventsCommand({
    MaxResults: TRAIL_MAX,
    LookupAttributes: [{ AttributeKey: 'ReadOnly', AttributeValue: 'false' }],
  }));
  return (r.Events ?? []).map((e) => {
    const res = e.Resources?.[0];
    return {
      time: e.EventTime instanceof Date ? e.EventTime.toISOString() : String(e.EventTime ?? ''),
      name: e.EventName ?? '',
      source: e.EventSource ?? '',
      user: e.Username ?? '',
      resourceType: res?.ResourceType?.replace(/^AWS::/, '') ?? '',
      resourceName: res?.ResourceName ?? '',
    };
  });
}

// ── Collector implementation ────────────────────────────────────────────────

const incidentCollector: ChatCollector = {
  key: 'incident',
  sectionMeta: { agentName: 'Incident Analyzer' },

  // The primary signal (ALARM-state alarms) rides Steampipe — down ⇒ normal routing.
  available: () => steampipeAvailable(),

  async collect(ctx: CollectCtx): Promise<CollectOutput> {
    const summary: string[] = [];
    const sections: string[] = [];
    const tools: string[] = [];
    let collected = 0;

    // All sources in parallel (v1 Promise.allSettled pattern) — per-source fail-open.
    ctx.onStep({ tool: 'steampipe_sql', query: oneLine(INCIDENT_SQL.alarms) });
    ctx.onStep({ tool: 'steampipe_sql', query: oneLine(INCIDENT_SQL.k8sEvents) });
    ctx.onStep({ tool: 'cloudtrail_lookup', query: `LookupEvents ReadOnly=false (last ${TRAIL_MAX} write events)` });
    const [alarmsR, k8sR, trailR] = await Promise.allSettled([
      runSteampipeQuery(INCIDENT_SQL.alarms),
      runSteampipeQuery(INCIDENT_SQL.k8sEvents),
      recentWriteEvents(),
    ]);

    // 1) CloudWatch alarms (ALARM state)
    let alarmRows: Record<string, unknown>[] = [];
    if (alarmsR.status === 'fulfilled') {
      alarmRows = alarmsR.value.rows;
      collected++;
      tools.push('steampipe_sql');
      summary.push(alarmRows.length > 0
        ? `CloudWatch alarms (Steampipe): ${alarmRows.length} in ALARM state`
        : 'CloudWatch alarms (Steampipe): no active alarms');
      sections.push(alarmRows.length > 0
        ? `## CloudWatch Alarms in ALARM State\n\`\`\`json\n${JSON.stringify(alarmRows)}\n\`\`\``
        : '## CloudWatch Alarms\nNo active alarms.');
    } else {
      summary.push(`CloudWatch alarms (Steampipe): 미가용 (query failed: ${(alarmsR.reason instanceof Error ? alarmsR.reason.message : String(alarmsR.reason)).slice(0, 120)})`);
    }

    // 2) Related metric series for the alarmed metrics (NEW vs v1 — the timeline evidence)
    const parsed = alarmRows.map(parseAlarmRow).filter((a): a is AlarmRow => a !== null).slice(0, ALARM_METRIC_CAP);
    if (parsed.length > 0 && !ctx.signal?.aborted) {
      ctx.onStep({ tool: 'cloudwatch_metrics', query: `GetMetricData: last-1h series for ${parsed.length} alarmed metric(s)` });
      const series = await alarmMetricSeries(parsed);
      const got = Object.keys(series).length;
      if (got > 0) {
        collected++;
        tools.push('cloudwatch_metrics');
        summary.push(`Alarmed-metric series (CloudWatch): ${got}/${parsed.length} alarms with last-1h datapoints`);
        sections.push(`## Alarmed Metric Series (CloudWatch, last 1h, Period 300 Average — keyed by alarm name)\n\`\`\`json\n${JSON.stringify(series)}\n\`\`\``);
      } else {
        summary.push('Alarmed-metric series (CloudWatch): 미가용 (no datapoints returned)');
      }
    }

    // 3) K8s warning events (optional — no K8s connection fails gracefully)
    if (k8sR.status === 'fulfilled') {
      const events = k8sR.value.rows;
      collected++;
      if (!tools.includes('steampipe_sql')) tools.push('steampipe_sql');
      summary.push(events.length > 0
        ? `K8s warning events (Steampipe): ${events.length} recent warnings`
        : 'K8s warning events (Steampipe): none');
      if (events.length > 0) {
        sections.push(`## Kubernetes Warning Events (recent)\n\`\`\`json\n${JSON.stringify(events)}\n\`\`\``);
      }
    } else {
      summary.push('K8s warning events (Steampipe): 미가용 (no kubernetes connection — skipped)');
    }

    // 4) CloudTrail recent write events
    if (trailR.status === 'fulfilled') {
      const events = trailR.value;
      collected++;
      tools.push('cloudtrail_lookup');
      summary.push(`CloudTrail write events: ${events.length} recent changes`);
      if (events.length > 0) {
        sections.push(`## Recent CloudTrail Write Events (who changed what, newest first)\n\`\`\`json\n${JSON.stringify(events)}\n\`\`\``);
      }
    } else {
      summary.push(`CloudTrail write events: 미가용 (LookupEvents failed: ${(trailR.reason instanceof Error ? trailR.reason.message : String(trailR.reason)).slice(0, 120)})`);
    }

    // 5) v1 datasource-backed sources v2 does not wire here — disclosed (fail-open).
    summary.push('Prometheus anomalies / Loki error logs / Tempo error traces: 미가용 (external datasources not integrated in this v2 collector)');

    sections.push('\n## Collection Summary\n' + summary.map((s) => `- ${s}`).join('\n'));
    const totalFindings = alarmRows.length
      + (k8sR.status === 'fulfilled' ? k8sR.value.rows.length : 0)
      + (trailR.status === 'fulfilled' ? trailR.value.length : 0);
    const context = collected === 0
      ? '--- No incident data could be collected ---\n' + sections.join('\n\n')
      : '--- INCIDENT ANALYSIS DATA (collected automatically) ---\n' + sections.join('\n\n');

    return {
      context,
      summary,
      tools,
      collected,
      via: `Incident Analyzer (${totalFindings} findings, ${tools.length} sources)`,
    };
  },

  // v1 analysisPrompt adapted: CloudTrail change-correlation replaces the Prometheus/Loki/Tempo
  // sections; alarmed-metric series give the timeline evidence.
  analysisPrompt: `You are an SRE incident analysis expert. You have been given REAL data collected from the user's AWS environment:
- CloudWatch alarms currently in ALARM state (name, metric, state reason, when they flipped)
- Last-1h series of the alarmed metrics (timeline evidence)
- Recent Kubernetes warning events (if a cluster is connected)
- Recent CloudTrail WRITE events (who changed what, newest first)

## Analysis Structure

### 1. Incident Summary
- Current severity assessment (Critical/Warning/Info)
- Affected services/resources
- Timeline of events (alarm flip times, metric inflection points, K8s warnings)

### 2. Root Cause Analysis
- Most likely root cause(s) based on cross-source correlation — pay special attention to
  CloudTrail write events shortly BEFORE an alarm flipped (deploys, config changes, scaling actions)
- Evidence from each data source supporting the hypothesis
- Alternative hypotheses if data is ambiguous

### 3. Impact Assessment
- Which services are affected
- User-facing impact (if detectable from the metrics)
- Blast radius estimation

### 4. Remediation Steps
- Immediate actions to mitigate
- Investigation commands (kubectl, AWS CLI)
- Rollback procedures if a CloudTrail change is the likely trigger

### 5. Prevention
- Monitoring gaps identified
- Suggested alarms/dashboards to add
- Configuration/change-management improvements to prevent recurrence

## Rules
- Correlate timestamps across sources to build a coherent timeline
- If a source is marked 미가용/unavailable or has no data, note it but don't treat it as "no issues"
- No active alarms + no warnings ⇒ say the environment currently LOOKS healthy and list what was checked
- Prioritize actionable findings over exhaustive listings`,
};

export default incidentCollector;
