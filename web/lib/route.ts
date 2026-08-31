import { sectionByKey, activeSections } from './sections';

// MVP keyword heuristics per section (KO + EN). First match wins, in this order.
const RULES: { key: string; re: RegExp }[] = [
  // observability = external-obs. FIRST rule on purpose (round-4 review MAJOR, 2026-07-31): an
  // explicit VENDOR NAME is the strongest routing signal there is, so it must be checked before
  // EVERY generic domain rule — not just before 'monitoring' (the round-2/3 fix, which left
  // "ClickHouse 쿼리 느려" and "Datadog database latency" being stolen by the generic 'data' rule's
  // 쿼리/database keywords, since that rule sat above this one). Only a real vendor identifier is
  // listed here; ambiguous generic terms (metric/latency/p99/쿼리) stay on their domain rules so
  // this rule can sit at the top without hijacking anything.
  // Covers the connectors that live here (Prometheus/ClickHouse lambda targets) PLUS the ADR-017
  // (amended 2026-08-05) vendor-hosted official-MCP presets (catalog.py MCP_SERVER_TARGETS —
  // datadog/dynatrace/newrelic, all 'external-obs'): those three have no lambda target anywhere,
  // so this is their ONLY chat path. Grafana/Splunk keywords were REMOVED by the amendment (the
  // kinds are unsupported — no preset, no lambda: FORCING a vendor route for them is a dead end by
  // definition). Jaeger likewise has no chat path today (its lambda is deployed but was never a
  // gateway TARGETS entry) — keyword removed with it; add it back only when a jaeger target
  // actually exists. What removal means precisely: the vendor NAME stops being a routing signal —
  // it does NOT force 'general'. Remaining domain keywords still route by domain (e.g. 'jaeger
  // 트레이스…' hits monitoring's 트레이스 rule, where the tempo tools live), and a query with no
  // matching keyword lands on the ops catch-all (or the LLM classifier on the hybrid path).
  // Tempo/트레이스/trace are DELIBERATELY EXCLUDED here (round-3 review MAJOR, 2026-07-31): round-2
  // put them on this rule to fix the POST-cutover dead-end (tempo-mcp-target retired, tools only
  // live on external-obs), but official_mcp_enabled defaults to false — that made the dead-end the
  // DEFAULT state for every deployment that never opts into ADR-017 presets, not just a brief
  // migration window. There's no runtime signal here (route.ts is a pure prompt->key function; the
  // official_mcp_enabled/ack/endpoint state lives in terraform vars + provision.py, not something
  // this request handler reads) to route dynamically per deployment, so this picks the one static
  // answer that matches the DEFAULT/most-common state: legacy tempo-mcp-target on 'monitoring'.
  // REQUIRED cutover step: when actually flipping official_mcp_enabled=true for the tempo preset,
  // move `tempo|트레이스|\btrace\b` from the monitoring rule below to this rule (see ADR-017 §Trade-offs).
  { key: 'observability', re: /promql|prometheus|프로메테우스|clickhouse|클릭하우스|datadog|데이터독|dynatrace|다이나트레이스|newrelic|new relic|뉴렐릭/i },
  { key: 'cost', re: /비용|요금|예산|절감|billing|cost|budget|forecast|spend/i },
  { key: 'security', re: /보안|권한|역할|정책|iam|policy|role|denied|permission|public|노출/i },
  { key: 'network', re: /통신|연결|네트워크|포트|라우트|reachab|network|connectivity|security ?group|\bsg\b|nacl|tgw|vpn|peering|flow ?log/i },
  { key: 'container', re: /파드|컨테이너|eks|ecs|kubernetes|k8s|pod|istio|namespace|sidecar/i },
  { key: 'data', re: /쿼리|데이터베이스|rds|aurora|dynamo|elasticache|redis|msk|kafka|database|slow query|throttl/i },
  { key: 'cost', re: /\$\d/i },
  // monitoring owns CloudWatch/CloudTrail AND the still-here datasource connectors (Loki logs,
  // Mimir long-term metrics, OpenSearch) — route those keywords here, where the tools are.
  // Ambiguous generic terms (metric/alarm/audit) are matched here but only reached when no
  // vendor-specific observability keyword matched first (see the FIRST rule above). tempo/트레이스/
  // trace stay here too (see that rule's comment) — tempo-mcp-target is the legacy lambda target
  // and lives on this gateway in the DEFAULT (official_mcp_enabled=false) state most deployments run in.
  { key: 'monitoring', re: /알람|지표|로그변경|cloudwatch|cloudtrail|alarm|metric|who changed|audit|loki|mimir|opensearch|tempo|트레이스|\btrace\b/i },
  { key: 'iac', re: /드리프트|스택|terraform|cloudformation|\bcdk\b|drift|stack|iac/i },
  // ops = inventory_read MCP home: topology, unused/orphan resources, and the load-balancer /
  // target-group / CloudFront *listing* tools live here (network only does connectivity).
  { key: 'ops', re: /미사용|안 ?쓰는|놀고 ?있는|orphan|고아|unused|인벤토리|inventory|리소스 ?(현황|목록|정리)|정리하|leftover|미연결|unattached|미할당|토폴로지|topology|origin|\btg\b|로드 ?밸런서|load ?balancer|\belb\b|\balb\b|\bnlb\b|타겟 ?그룹|대상 ?그룹|target ?group|cloudfront|클라우드프론트|리스너|listener/i },
  // v1 auto-collect collectors — dedicated STRONG keywords only, near-last on purpose: generic
  // 미사용/unused listings stay with ops and 비용/절감 stays with cost. A prompt matching BOTH
  // (e.g. '미사용 리소스 찾아줘' hits ops+idle-scan) goes ambiguous → the LLM classifier (which
  // knows these sections) arbitrates; only unmistakable phrasings short-circuit here.
  { key: 'idle-scan', re: /(미사용|유휴|idle|unused).{0,16}(리소스|resources?).{0,12}(찾|스캔|검색|scan)|idle ?scan|유휴 ?리소스/i },
  { key: 'eks-optimize', re: /(eks|k8s|쿠버네티스|kubernetes|컨테이너|container|파드|pod).{0,24}(최적화|낭비|과다 ?할당|rightsiz|optimi[sz])|rightsiz/i },
  // db/msk-optimize need a SERVICE noun + an optimize verb together — generic nouns alone stay with
  // data (troubleshooting) and generic 비용/절감 stays with cost; bare 'rightsiz' stays eks-optimize.
  { key: 'db-optimize', re: /(rds|aurora|elasticache|opensearch|데이터베이스|디비|\bdb\b).{0,20}(rightsiz|다운사이징|downsiz|과다 ?(프로비저닝|할당)|최적화|낭비|적정 ?규모)/i },
  { key: 'msk-optimize', re: /(msk|kafka|카프카|브로커|broker).{0,20}(rightsiz|다운사이징|downsiz|과다 ?(프로비저닝|할당)|최적화|낭비|적정 ?규모)/i },
  // trace-analyze: explicit trace/dependency/bottleneck intents only — a bare 'trace/트레이스' noun
  // stays with monitoring (where the Tempo connector lives); ambiguity goes to the classifier.
  { key: 'trace-analyze', re: /트레이스 ?분석|trace ?analy|분산 ?트레이싱|distributed ?trac|서비스 ?의존성|service ?dependenc|(지연 ?시간?|latency).{0,12}(병목|bottleneck)|병목.{0,8}(찾|분석)/i },
  // incident: root-cause phrasings only — a plain '장애가 났어' report (no 원인/분석 ask) is left to
  // the classifier so monitoring/container keep their troubleshooting flows.
  { key: 'incident', re: /(장애|사고|인시던트|incident).{0,12}(원인|분석|analysis)|root ?cause|무슨 ?문제(가|는)? ?있/i },
  // v1 priority-10 'aws-data' (Steampipe SQL) — MUST stay LAST: only STRONG list/count patterns,
  // and every specialized domain keyword above wins first ('CrashLoop 파드 몇 개야?' → container).
  // This is the receiver for listing/status/count questions nobody else claimed.
  { key: 'aws-data', re: /몇 ?개|개수|총 ?\d|전체 ?(목록|리스트)|목록 ?보여|how many|count of|list all/i },
];

/** Choose the agent gateway. A valid pin always wins; otherwise keyword-match; else 'ops'. */
export function pickGateway(prompt: string, pinned?: string): string {
  if (pinned && sectionByKey(pinned)) return pinned;
  for (const r of RULES) {
    if (r.re.test(prompt)) return r.key;
  }
  return 'ops';
}

// ── ADR-038 hybrid routing ───────────────────────────────────────────────────

export interface RankedEntry { key: string; score: number; active: boolean }
export interface RouteResult {
  primary: string;
  ranked: RankedEntry[];
  method: 'pin' | 'regex' | 'llm' | 'fallback';
  // ADR-044: cross-domain auto-synthesis signal. `selected` = the active routes the chat
  // handler may fan out over (≤3); `multiDomain` true ⇒ ≥2 selected ⇒ ADR-025 fan-out+synthesis.
  // pin/regex/fallback are always single. NOTE: the Agent-Space/active filter later in
  // chat/route.ts may shrink `selected` — the handler MUST recompute multiDomain after filtering.
  multiDomain: boolean;
  selected: RankedEntry[];
}
export interface ClassifyOpts {
  llmEnabled?: boolean;
  classify?: (prompt: string) => Promise<{ key: string; score: number }[]>;
  /** ADR-044: min classifier score for a route to join the multi-domain fan-out set. */
  minScore?: number;
}

/** ADR-044 default multi-route inclusion threshold (env-overridable, golden-set-tuned). */
export const MULTI_ROUTE_MIN_SCORE = Number(process.env.MULTI_ROUTE_MIN_SCORE || 0.3);

/** Active routes (score ≥ minScore), best-first, capped at 3 — the fan-out candidate set (ADR-044). */
export function selectMultiRoute(ranked: RankedEntry[], minScore = MULTI_ROUTE_MIN_SCORE): RankedEntry[] {
  return ranked.filter((r) => r.active && r.score >= minScore).slice(0, 3);
}

/** Catch-all fallback MUST be an active section — inactive 'ops' would block chat (spec §2.3). */
export const ACTIVE_FALLBACK = activeSections()[0]?.key ?? 'ops';

/** Distinct section keys matched by the keyword RULES (duplicate-rule keys counted once). */
export function matchedSections(prompt: string): string[] {
  const keys: string[] = [];
  for (const r of RULES) {
    if (r.re.test(prompt) && !keys.includes(r.key)) keys.push(r.key);
  }
  return keys;
}

function entry(key: string, score: number): RankedEntry {
  return { key, score, active: sectionByKey(key)?.active === true };
}

/**
 * Hybrid route decision: pin → regex (exactly 1 distinct match) → LLM (ambiguous/no-match)
 * → graceful fallback. Never throws; never blocks chat (spec §2, §6).
 */
export async function classifyRoute(prompt: string, pinned?: string, opts: ClassifyOpts = {}): Promise<RouteResult> {
  // Single-route result: selected = [the one entry], never multi-domain (ADR-044).
  const single = (primary: string, ranked: RankedEntry[], method: RouteResult['method']): RouteResult =>
    ({ primary, ranked, method, multiDomain: false, selected: [ranked[0]] });

  if (pinned && sectionByKey(pinned)) {
    return single(pinned, [entry(pinned, 1)], 'pin');
  }
  const matched = matchedSections(prompt);
  // v1 lesson (11-route priority ladder: specialized routes above the general catch-all):
  // a lone 'ops' keyword hit is weak evidence — generic nouns (load balancer, certificate,
  // S3 bucket) live in the ops rules while the USER INTENT is often network/cost/monitoring.
  // Let the classifier confirm or override a lone catch-all match; specific single matches
  // keep short-circuiting (fast, no Bedrock call). LLM failure falls through to the same
  // regex result below, so behavior is unchanged when the classifier is off or errors.
  const loneCatchAll = matched.length === 1 && matched[0] === 'ops' && !!(opts.llmEnabled && opts.classify);
  if (matched.length === 1 && !loneCatchAll) {
    return single(matched[0], [entry(matched[0], 1)], 'regex');
  }
  // PR #194 review MAJOR (L2 + L4): an explicit VENDOR NAME is the strongest routing signal there
  // is — that is why the observability rule sits first in RULES — but the fast-path above only fires
  // on EXACTLY ONE match, so "Datadog metric 확인" (observability + monitoring) fell through to the
  // LLM classifier and the vendor-first ordering that rounds 2-4 established was silently discarded
  // on the hybrid path. pickGateway() kept it (first-match-wins); classifyRoute() did not.
  //
  // Keeping the OTHER matched sections is the second half of the fix. Routing a mixed-intent query
  // like "grafana 대시보드에서 본 trace 이상해" to observability ALONE drops `monitoring`, which is
  // where the tempo tools actually live in the default (official_mcp_enabled=false) deployment — a
  // dead end. Vendor first, then the rest, so the fan-out still reaches the section holding tools.
  if (matched[0] === 'observability') {
    const ranked = matched.map((k, i) => entry(k, i === 0 ? 1 : 0.5));
    const selected = selectMultiRoute(ranked, opts.minScore);
    const multiDomain = selected.length >= 2;
    return { primary: 'observability', ranked, method: 'regex', multiDomain,
             selected: multiDomain ? selected : [ranked[0]] };
  }
  if (opts.llmEnabled && opts.classify) {
    try {
      const ranked = (await opts.classify(prompt)).map((r) => entry(r.key, r.score));
      if (ranked.length > 0) {
        // ADR-044: ≥2 active routes above threshold ⇒ candidate for cross-domain auto-synthesis.
        const selected = selectMultiRoute(ranked, opts.minScore);
        const multiDomain = selected.length >= 2;
        return { primary: ranked[0].key, ranked, method: 'llm', multiDomain, selected: multiDomain ? selected : [ranked[0]] };
      }
    } catch { /* classifier must never block chat — fall through */ }
  }
  // LLM off/empty/failed: legacy first-match if any rule hit, else fallback.
  if (matched.length > 0) {
    return single(matched[0], [entry(matched[0], 1)], 'regex');
  }
  const fallbackKey = opts.llmEnabled ? ACTIVE_FALLBACK : 'ops'; // flag off = exact legacy behavior
  return single(fallbackKey, [entry(fallbackKey, 0)], opts.llmEnabled ? 'fallback' : 'regex');
}
