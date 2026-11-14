import { sectionByKey, activeSections } from './sections';
import { resourceSection, stripResources, INSTANCE_TOKEN } from './route-resources';

// Network objects whose names or questions carry security words; the security gateway is IAM-only.
const NETWORK_OBJECTS = /security ?group|보안\s*그룹|\bsg\b|\beni\b|nacl|network ?acl|네트워크 ?acl|라우팅 ?테이블|라우트 ?테이블|route ?table/i;

// An IAM principal named in the question (IAM, role, 역할, principal) makes a question about a
// network object an IAM question ("which IAM role may modify the security group"); the network rule
// steps aside and the security rule (which holds the same words) answers. Bare
// 정책/권한/policy/permission do not: "보안 그룹 정책", "ENI 권한" stay with the network object.
// user/사용자 are deliberately NOT principals: "the route table for the user subnet" is a network question.
const PRINCIPAL_INTENT = /\biam\b|\broles?\b|역할|\bprincipals?\b/i;
// who/누가 are deliberately NOT principals: "보안 그룹 누가 변경했어" is a change-history question.

// A network object together with its own policy words directly after it ("보안 그룹 정책", "ENI 권한",
// "보안 그룹의 정책", "security group policy"): only whitespace or 의/에 대한 may sit between them. A
// policy word anywhere else ("보안 그룹과 버킷 정책", "security group and S3 policy") is another
// security subject and keeps `security` in the candidates.
const NETWORK_OBJECT_WITH_POLICY = new RegExp(
  `(?:${NETWORK_OBJECTS.source})(?:\\s*(?:의|에\\s*대한)?\\s*(?:정책|권한|policy|permissions?))?`, 'gi');

// "i-… 보안 점검": the generic word 보안 directly after an instance ID asks about that instance.
const INSTANCE_WITH_GENERIC_SECURITY = new RegExp(`${INSTANCE_TOKEN}\\s*(?:의|에\\s*대한)?\\s*보안`, 'gi');

/** True when every security-rule match in `text` comes from a network object and its own policy
 *  words: with those blanked out, nothing in `text` matches the security rule any more. */
function securityOnlyFromNetworkObjects(text: string): boolean {
  return !SECURITY_WORDS.test(text.replace(NETWORK_OBJECT_WITH_POLICY, ' '));
}

const SECURITY_WORDS = /보안(?!\s*그룹)|권한|역할|정책|iam|policy|role|principals?|denied|permission|public|노출/i;

// MVP keyword heuristics per section (KO + EN). First match wins, in this order.
const RULES: { key: string; re: RegExp; unless?: RegExp }[] = [
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
  // Network objects whose names contain security words: a security GROUP, NACL or route table is a
  // network object (the security gateway is IAM-only), so these must beat the security rule's
  // 정책/policy/권한 ("보안 그룹 정책 검토", "check the security group policy"). It does not apply when
  // an IAM principal is named, so "which IAM role may modify the security group" reaches the security rule.
  { key: 'network', re: NETWORK_OBJECTS, unless: PRINCIPAL_INTENT },
  // The network rule above claims SG/NACL/route-table phrasings first; the `보안(?!\s*그룹)`
  // lookahead keeps a bare `보안` from claiming "보안  그룹" (any whitespace) on prompts it does not reach.
  { key: 'security', re: SECURITY_WORDS },
  { key: 'network', re: /통신|연결|네트워크|포트|라우트|reachab|network|connectivity|tgw|vpn|peering|flow ?log/i },
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

function ruleMatches(r: { re: RegExp; unless?: RegExp }, text: string): boolean {
  return r.re.test(text) && !(r.unless && r.unless.test(text));
}

/** Section of the named resource when it should decide the route, else `undefined`.
 *  Keywords are matched on `stripResources` text, where a network ID becomes its object word (sg,
 *  eni, nacl, route table, network), an instance ID a neutral token and an ARN its service name. A
 *  network ID with policy words therefore follows the same network-object rule as the object's name:
 *  policy words directly after it stay with network on the keyword/classifier path, and any other
 *  security subject ("sg-… 과 버킷 정책") keeps `security` as a candidate. The resource decides alone
 *  only when (a) the question names no IAM principal (IAM/role/역할/principal), unless the resource
 *  is an IAM ARN, (b) at most one area's keywords match, a list/count phrasing (`aws-data`) not
 *  counted, and (c) that area is absent, the resource's own, or `security` only through `보안`
 *  directly after an instance ID ("i-… 보안 점검"). Otherwise ("which IAM role can modify sg-…" →
 *  security, "i-… 의 CPU 지표" → monitoring, "i-… 퍼블릭 노출" → security, "eni-… 와 RDS 연결" →
 *  several areas) the keyword rules, the hybrid classifier and ADR-003 multi-domain fan-out decide. */
function resourceRoute(prompt: string): string | undefined {
  const resource = resourceSection(prompt);
  if (!resource || !sectionByKey(resource)) return undefined;
  const text = stripResources(prompt);
  if (resource !== 'security' && PRINCIPAL_INTENT.test(text)) return undefined; // IAM question about a resource
  // `aws-data` is a list/count phrasing ("list all", "몇 개"), not another area's subject.
  const matched = matchedSections(prompt).filter((k) => k !== 'aws-data');
  if (matched.length > 1) return undefined; // several areas: keywords / classifier / fan-out decide
  const first = matched[0];
  if (first === undefined || first === resource) return resource;
  // The one documented collision: 보안 directly after an instance ID ("i-… 보안 점검").
  if (first === 'security' && !SECURITY_WORDS.test(text.replace(INSTANCE_WITH_GENERIC_SECURITY, ' '))) return resource;
  return undefined;
}

/** Choose the agent gateway. A valid pin always wins; otherwise keyword-match; then the
 *  conversation's previous section (when the caller vouches for it); else 'ops'.
 *
 *  Follow-up continuity: on the regex-only path (hybrid routing off, the default) a follow-up such
 *  as "그럼 그건 왜 그래?" or "더 자세히" carries no domain keyword. It used to land on the 'ops'
 *  catch-all, which dropped the domain prompt and tools the previous answer was built with. A
 *  keyword still wins, so an explicit topic change re-routes as before. The caller filters
 *  `previous` (active, gateway-backed section) — this function only requires it to be a section. */
export function pickGateway(prompt: string, pinned?: string, previous?: string): string {
  // Precedence: pin > named resource (only when no other area's keyword — including an
  // observability vendor — is named; see resourceRoute) > keywords > previous > 'ops'.
  if (pinned && sectionByKey(pinned)) return pinned;
  const resource = resourceRoute(prompt);
  if (resource) return resource;
  const text = stripResources(prompt);
  for (const r of RULES) {
    if (ruleMatches(r, text)) return r.key;
  }
  if (previous && sectionByKey(previous)) return previous;
  return 'ops';
}

// ── ADR-003[legacy 038] hybrid routing ───────────────────────────────────────────────────

export interface RankedEntry { key: string; score: number; active: boolean }
export interface RouteResult {
  primary: string;
  ranked: RankedEntry[];
  method: 'pin' | 'resource' | 'regex' | 'llm' | 'fallback' | 'previous';
  // ADR-003[legacy 044]: cross-domain auto-synthesis signal. `selected` = the active routes the chat
  // handler may fan out over (≤3); `multiDomain` true ⇒ ≥2 selected ⇒ ADR-003[legacy 025] fan-out+synthesis.
  // pin/regex/fallback are always single. NOTE: the Agent-Space/active filter later in
  // chat/route.ts may shrink `selected` — the handler MUST recompute multiDomain after filtering.
  multiDomain: boolean;
  selected: RankedEntry[];
}
export interface ClassifyOpts {
  llmEnabled?: boolean;
  classify?: (prompt: string) => Promise<{ key: string; score: number }[]>;
  /** ADR-003[legacy 044]: min classifier score for a route to join the multi-domain fan-out set. */
  minScore?: number;
  /** Follow-up continuity: the section that answered the previous turn (caller-validated). Used
   *  only when neither a keyword nor the classifier picked a route, instead of the default. */
  previous?: string;
}

/** ADR-003[legacy 044] default multi-route inclusion threshold (env-overridable, golden-set-tuned). */
export const MULTI_ROUTE_MIN_SCORE = Number(process.env.MULTI_ROUTE_MIN_SCORE || 0.3);

/** Active routes (score ≥ minScore), best-first, capped at 3 — the fan-out candidate set (ADR-003[legacy 044]). */
export function selectMultiRoute(ranked: RankedEntry[], minScore = MULTI_ROUTE_MIN_SCORE): RankedEntry[] {
  return ranked.filter((r) => r.active && r.score >= minScore).slice(0, 3);
}

/** Catch-all fallback MUST be an active section — inactive 'ops' would block chat (spec §2.3). */
export const ACTIVE_FALLBACK = activeSections()[0]?.key ?? 'ops';

/** Distinct section keys matched by the keyword RULES (duplicate-rule keys counted once);
 *  resource IDs/ARNs are blanked first. */
export function matchedSections(prompt: string): string[] {
  const keys: string[] = [];
  const text = stripResources(prompt);
  for (const r of RULES) {
    if (ruleMatches(r, text) && !keys.includes(r.key)) keys.push(r.key);
  }
  return keys;
}

function entry(key: string, score: number): RankedEntry {
  return { key, score, active: sectionByKey(key)?.active === true };
}

/**
 * Hybrid route decision: pin → named resource → regex (exactly 1 distinct match) → LLM (ambiguous/no-match)
 * → graceful fallback. Never throws; never blocks chat (spec §2, §6).
 */
export async function classifyRoute(prompt: string, pinned?: string, opts: ClassifyOpts = {}): Promise<RouteResult> {
  // Single-route result: selected = [the one entry], never multi-domain (ADR-003[legacy 044]).
  const single = (primary: string, ranked: RankedEntry[], method: RouteResult['method']): RouteResult =>
    ({ primary, ranked, method, multiDomain: false, selected: [ranked[0]] });

  if (pinned && sectionByKey(pinned)) {
    return single(pinned, [entry(pinned, 1)], 'pin');
  }
  // Precedence: pin > named resource (only when no other area's keyword — including an
  // observability vendor — is named; see resourceRoute) > keywords/classifier > previous > fallback. Otherwise
  // the regex/classifier path below runs unchanged (continuity, multi-domain).
  const resource = resourceRoute(prompt);
  if (resource) {
    return single(resource, [entry(resource, 1)], 'resource');
  }
  const matched = matchedSections(prompt);
  const text = stripResources(prompt);
  // Drop `security` only when its match comes from the network object itself — the object's name plus
  // its own policy/permission words ("보안 그룹 정책", "ENI 권한") — and no IAM principal is named. Any
  // other security subject in the question ("보안 그룹과 퍼블릭 노출된 S3") keeps `security` in the
  // candidates, so the classifier and ADR-003 fan-out still decide.
  const networkOwnsSecurity = NETWORK_OBJECTS.test(text) && !PRINCIPAL_INTENT.test(text)
    && securityOnlyFromNetworkObjects(text);
  const keys = networkOwnsSecurity ? matched.filter((k) => k !== 'security') : matched;
  // v1 lesson (11-route priority ladder: specialized routes above the general catch-all):
  // a lone 'ops' keyword hit is weak evidence — generic nouns (load balancer, certificate,
  // S3 bucket) live in the ops rules while the USER INTENT is often network/cost/monitoring.
  // Let the classifier confirm or override a lone catch-all match; specific single matches
  // keep short-circuiting (fast, no Bedrock call). LLM failure falls through to the same
  // regex result below, so behavior is unchanged when the classifier is off or errors.
  const loneCatchAll = keys.length === 1 && keys[0] === 'ops' && !!(opts.llmEnabled && opts.classify);
  if (keys.length === 1 && !loneCatchAll) {
    return single(keys[0], [entry(keys[0], 1)], 'regex');
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
  if (keys[0] === 'observability') {
    const ranked = keys.map((k, i) => entry(k, i === 0 ? 1 : 0.5));
    const selected = selectMultiRoute(ranked, opts.minScore);
    const multiDomain = selected.length >= 2;
    return { primary: 'observability', ranked, method: 'regex', multiDomain,
             selected: multiDomain ? selected : [ranked[0]] };
  }
  if (opts.llmEnabled && opts.classify) {
    try {
      const ranked = (await opts.classify(prompt)).map((r) => entry(r.key, r.score));
      if (ranked.length > 0) {
        // ADR-003[legacy 044]: ≥2 active routes above threshold ⇒ candidate for cross-domain auto-synthesis.
        const selected = selectMultiRoute(ranked, opts.minScore);
        const multiDomain = selected.length >= 2;
        return { primary: ranked[0].key, ranked, method: 'llm', multiDomain, selected: multiDomain ? selected : [ranked[0]] };
      }
    } catch { /* classifier must never block chat — fall through */ }
  }
  // LLM off/empty/failed: legacy first-match if any rule hit, else fallback.
  if (keys.length > 0) {
    return single(keys[0], [entry(keys[0], 1)], 'regex');
  }
  if (opts.previous && sectionByKey(opts.previous)) {
    // distinct method so ADR-003[legacy 038] routing/misroute telemetry keeps continuity separate from the catch-all
    return single(opts.previous, [entry(opts.previous, 0)], 'previous');
  }
  const fallbackKey = opts.llmEnabled ? ACTIVE_FALLBACK : 'ops'; // flag off = exact legacy behavior
  return single(fallbackKey, [entry(fallbackKey, 0)], opts.llmEnabled ? 'fallback' : 'regex');
}
