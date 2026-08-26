import { CloudWatchLogsClient, StartQueryCommand, GetQueryResultsCommand, StopQueryCommand } from '@aws-sdk/client-cloudwatch-logs';
import { Route53ResolverClient, ListResolverQueryLogConfigsCommand } from '@aws-sdk/client-route53resolver';

// DNS Query Log 분석 (Network 메뉴) — Route53 Resolver query logging의 CloudWatch Logs
// 대상 그룹을 라이브 발견하고, 원시 라인을 퍼오는 대신 Logs Insights **집계 쿼리**를
// 병렬 실행한다 (rcode/qtype 분포, top 도메인/NXDOMAIN/소스, 타임라인, DNS Firewall).
// 게이트: 쿼리 로그 설정이 없으면 configs가 비고 페이지는 온보딩 안내로 degrade.
// Insights는 스캔 GB당 과금 → NFM과 동일하게 TTL 캐시 + in-flight 공유로 재조회를 막는다.

const REGION = process.env.AWS_REGION || 'ap-northeast-2';
let logsClient: CloudWatchLogsClient | null = null;
let r53Client: Route53ResolverClient | null = null;
const logs = () => (logsClient ??= new CloudWatchLogsClient({ region: REGION }));
const r53 = () => (r53Client ??= new Route53ResolverClient({ region: REGION }));

// ── TTL cache + in-flight dedupe (lib/nfm.ts와 동일 패턴) ────────────────────
const TTL_MS = 4 * 60_000;
const cache = new Map<string, { at: number; v: unknown }>();
const inflight = new Map<string, Promise<unknown>>();
async function cached<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.v as T;
  const running = inflight.get(key);
  if (running) return running as Promise<T>;
  const p = fn().then((v) => {
    cache.set(key, { at: Date.now(), v });
    return v;
  }).finally(() => inflight.delete(key));
  inflight.set(key, p);
  return p;
}
export function _resetDnsCacheForTests() { cache.clear(); inflight.clear(); logsClient = null; r53Client = null; }

// ── Status (menu gate): resolver query-log configs → CW log-group destinations ──
export interface DnsLogConfig {
  id: string; name: string; status: string; associationCount: number;
  destinationArn: string;
  /** CloudWatch Logs 대상일 때의 로그 그룹 이름 (S3/Firehose 대상이면 null → 분석 불가). */
  logGroup: string | null;
}
export interface DnsLogStatus { configs: DnsLogConfig[]; groups: string[] }

// arn:aws:logs:REGION:ACCT:log-group:/name(:*)? → /name
function logGroupOf(arn: string): string | null {
  const m = /^arn:aws:logs:[^:]+:[^:]+:log-group:(.+?)(?::\*)?$/.exec(arn);
  return m ? m[1] : null;
}

export async function dnsLogStatus(): Promise<DnsLogStatus> {
  return cached('status', async () => {
    const r = await r53().send(new ListResolverQueryLogConfigsCommand({}));
    const configs: DnsLogConfig[] = (r.ResolverQueryLogConfigs ?? []).map((c) => ({
      id: c.Id ?? '', name: c.Name ?? '', status: c.Status ?? '',
      associationCount: c.AssociationCount ?? 0,
      destinationArn: c.DestinationArn ?? '',
      logGroup: c.DestinationArn ? logGroupOf(c.DestinationArn) : null,
    }));
    const groups = [...new Set(configs.map((c) => c.logGroup).filter((g): g is string => g != null))];
    return { configs, groups };
  });
}

// ── Logs Insights runner ────────────────────────────────────────────────────
type Row = Record<string, string>;

async function runInsights(group: string, query: string, rangeSec: number): Promise<Row[]> {
  const end = Math.floor(Date.now() / 1000);
  const { queryId } = await logs().send(new StartQueryCommand({
    logGroupName: group, queryString: query, startTime: end - rangeSec, endTime: end, limit: 1000,
  }));
  if (!queryId) return [];
  for (let i = 0; i < 30; i++) {
    const res = await logs().send(new GetQueryResultsCommand({ queryId }));
    if (res.status === 'Complete') {
      return (res.results ?? []).map((row) =>
        Object.fromEntries(row.filter((f) => f.field && f.field !== '@ptr').map((f) => [f.field as string, f.value ?? ''])));
    }
    if (res.status === 'Failed' || res.status === 'Cancelled' || res.status === 'Timeout') {
      throw new Error(`Insights query ${res.status}`);
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
  await logs().send(new StopQueryCommand({ queryId })).catch(() => {});
  throw new Error('Insights query poll cap reached');
}

// 타임라인 bin: 기간별 ~24-30 포인트.
const BIN_SEC: Record<number, number> = { 3600: 120, 21600: 900, 86400: 3600, 604800: 21600 };

export interface DnsAnalytics {
  totals: { total: number; nxdomain: number; servfail: number; uniqueDomains: number };
  rcode: { name: string; value: number }[];
  qtype: { name: string; value: number }[];
  topDomains: { name: string; value: number }[];
  topNxdomain: { name: string; value: number }[];
  topSources: { srcaddr: string; instance: string | null; value: number }[];
  timeline: { t: string; value: number }[];
  firewall: { action: string; domain: string; value: number }[];
  /** 부분 실패한 분석 키 (해당 패널만 비움 — 페이지는 살아있음). */
  failed: string[];
}

const num = (s: string | undefined): number => (s != null && s !== '' ? Number(s) || 0 : 0);
const nv = (rows: Row[], nameField: string): { name: string; value: number }[] =>
  rows.filter((r) => r[nameField] != null && r[nameField] !== '').map((r) => ({ name: r[nameField], value: num(r.cnt) }));

/** Resolver 쿼리 로그 집계 분석 — 7개 Insights 쿼리를 병렬 실행 (개별 실패는 failed로 degrade). */
export async function dnsAnalytics(group: string, rangeSec: number): Promise<DnsAnalytics> {
  return cached(`a|${group}|${rangeSec}`, async () => {
    const bin = BIN_SEC[rangeSec] ?? 300;
    const Q: Record<string, string> = {
      totals: 'stats count(*) as total, count_distinct(query_name) as uniq',
      rcode: 'stats count(*) as cnt by rcode | sort cnt desc',
      qtype: 'stats count(*) as cnt by query_type | sort cnt desc | limit 12',
      topDomains: 'stats count(*) as cnt by query_name | sort cnt desc | limit 25',
      topNxdomain: 'filter rcode = "NXDOMAIN" | stats count(*) as cnt by query_name | sort cnt desc | limit 25',
      topSources: 'fields srcids.instance as instance | stats count(*) as cnt by srcaddr, instance | sort cnt desc | limit 25',
      timeline: `stats count(*) as cnt by bin(${bin}s) as t | sort t asc`,
      firewall: 'filter ispresent(firewall_rule_action) | stats count(*) as cnt by firewall_rule_action, query_name | sort cnt desc | limit 25',
    };
    const failed: string[] = [];
    const out: Record<string, Row[]> = {};
    await Promise.all(Object.entries(Q).map(async ([k, q]) => {
      try { out[k] = await runInsights(group, q, rangeSec); }
      catch { out[k] = []; failed.push(k); }
    }));

    const rcode = nv(out.rcode ?? [], 'rcode');
    const find = (n: string) => rcode.find((r) => r.name === n)?.value ?? 0;
    return {
      totals: {
        total: num(out.totals?.[0]?.total),
        nxdomain: find('NXDOMAIN'),
        servfail: find('SERVFAIL'),
        uniqueDomains: num(out.totals?.[0]?.uniq),
      },
      rcode,
      qtype: nv(out.qtype ?? [], 'query_type'),
      topDomains: nv(out.topDomains ?? [], 'query_name'),
      topNxdomain: nv(out.topNxdomain ?? [], 'query_name'),
      topSources: (out.topSources ?? [])
        .filter((r) => r.srcaddr)
        .map((r) => ({ srcaddr: r.srcaddr, instance: r.instance || null, value: num(r.cnt) })),
      timeline: (out.timeline ?? []).filter((r) => r.t).map((r) => ({ t: r.t, value: num(r.cnt) })),
      firewall: (out.firewall ?? [])
        .filter((r) => r.firewall_rule_action)
        .map((r) => ({ action: r.firewall_rule_action, domain: r.query_name ?? '', value: num(r.cnt) })),
      failed,
    };
  });
}

// ── CoreDNS (EKS 클러스터 내부 DNS) — Container Insights application 로그 ────
// CoreDNS `log` 플러그인 라인을 Logs Insights `parse`로 서버측 집계한다 (원시 라인
// fan-out 없음). Resolver 로그에는 per-query latency가 없으므로 지연 비교는 CoreDNS만
// 실측을 갖고 Resolver는 '—'로 정직 표시 (nfm-dashboard G3 패리티).
import { DescribeLogGroupsCommand } from '@aws-sdk/client-cloudwatch-logs';

export interface CoreDnsGroup { cluster: string; group: string }

/** /aws/containerinsights/<cluster>/application 로그 그룹 발견 (CI 미설치 클러스터는 자연히 빠짐). */
export async function coreDnsGroups(): Promise<CoreDnsGroup[]> {
  return cached('coredns-groups', async () => {
    const r = await logs().send(new DescribeLogGroupsCommand({ logGroupNamePrefix: '/aws/containerinsights/' }));
    return (r.logGroups ?? [])
      .map((g) => g.logGroupName ?? '')
      .filter((n) => n.endsWith('/application'))
      .map((n) => ({ cluster: n.split('/')[3] ?? n, group: n }));
  });
}

// CoreDNS 쿼리 라인 parse (라이브 검증: CI JSON 래핑 그대로 @message에 매칭).
// [INFO] ip:port - id "A IN name. udp 94 false 1232" RCODE flags size 0.0001s
// 주의: @message는 원시 JSON 텍스트라 내부 따옴표가 \" 로 이스케이프되어 있음 —
// 정규식은 리터럴 백슬래시+따옴표(\\")를 매칭해야 함 (\"만 쓰면 0행, 라이브 실측).
const CORE_PARSE = String.raw`parse @message /\[INFO\] (?<client>[0-9.]+):\d+ - \d+ \\"(?<qtype>\S+) IN (?<qname>\S+?)\.? (?<proto>\S+) \d+ \S+ \d+\\" (?<rcode>\S+) \S+ \d+ (?<dur>[\d.]+)s/ | filter ispresent(qname)`;

export interface CoreDnsAnalytics {
  totals: { total: number; nxdomain: number; servfail: number; p50Ms: number | null; p95Ms: number | null };
  rcode: { name: string; value: number }[];
  topDomains: { name: string; value: number }[];
  timeline: { t: string; value: number }[];
  failed: string[];
}

/** 한 클러스터 CoreDNS 로그의 집계 분석 (4개 Insights 쿼리 병렬, 개별 실패 degrade). */
export async function coreDnsAnalytics(group: string, rangeSec: number): Promise<CoreDnsAnalytics> {
  return cached(`cd|${group}|${rangeSec}`, async () => {
    const bin = BIN_SEC[rangeSec] ?? 300;
    const Q: Record<string, string> = {
      totals: `${CORE_PARSE} | stats count(*) as total, percentile(dur, 50) as p50, percentile(dur, 95) as p95`,
      rcode: `${CORE_PARSE} | stats count(*) as cnt by rcode | sort cnt desc`,
      topDomains: `${CORE_PARSE} | stats count(*) as cnt by qname | sort cnt desc | limit 25`,
      timeline: `${CORE_PARSE} | stats count(*) as cnt by bin(${bin}s) as t | sort t asc`,
    };
    const failed: string[] = [];
    const out: Record<string, Row[]> = {};
    await Promise.all(Object.entries(Q).map(async ([k, q]) => {
      try { out[k] = await runInsights(group, q, rangeSec); }
      catch { out[k] = []; failed.push(k); }
    }));
    const rcode = nv(out.rcode ?? [], 'rcode');
    const find = (n: string) => rcode.find((r) => r.name === n)?.value ?? 0;
    const t0 = out.totals?.[0];
    const secToMs = (s: string | undefined) => (s != null && s !== '' ? Math.round(Number(s) * 1e6) / 1000 : null);
    return {
      totals: {
        total: num(t0?.total), nxdomain: find('NXDOMAIN'), servfail: find('SERVFAIL'),
        p50Ms: secToMs(t0?.p50), p95Ms: secToMs(t0?.p95),
      },
      rcode,
      topDomains: nv(out.topDomains ?? [], 'qname'),
      timeline: (out.timeline ?? []).filter((r) => r.t).map((r) => ({ t: r.t, value: num(r.cnt) })),
      failed,
    };
  });
}
