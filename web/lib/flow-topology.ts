// Pure request-flow graph builder — reactflow-independent. Builds a front-door flow:
//   Route53 → CloudFront → ALB/NLB → TargetGroup → target (instance|ip|lambda), + CF→WAF.
// Reads already-synced inventory rows flattened as { resource_id, region, ...data }.
//
// IMPORTANT (Steampipe shape): jsonb COLUMN names are snake_case, but NESTED struct keys are
// PascalCase (AWS SDK shape) — origins[].DomainName, target_health_descriptions[].Target.Id /
// .TargetHealth.State. alb/nlb resource_id is the LB *name*, so joins that use ARNs
// (tg.load_balancer_arns, cloudfront.web_acl_id) must index by the payload `arn` field.
//
// Edges carry `confidence`: directly-observed links are 'observed' (solid). 'inferred' (dashed) is
// used for DERIVED links — Spec 2's env→RDS edges AND Route53-alias-chain-resolved CF→LB edges —
// the renderer keys stroke style off this field.

type Row = Record<string, unknown>;
const str = (v: unknown): string => (v == null ? '' : String(v));

/** Coerce a jsonb value that may arrive as an array or a JSON string into an array. */
function arr(v: unknown): Row[] {
  if (Array.isArray(v)) return v as Row[];
  if (typeof v === 'string' && v.trim().startsWith('[')) {
    try { const p = JSON.parse(v); return Array.isArray(p) ? p : []; } catch { return []; }
  }
  return [];
}
// string-array coercion (e.g. listener-rule condition Values)
const strs = (v: unknown): string[] => (Array.isArray(v) ? v.map(str) : []);

export type FlowKind = 'route53' | 'cloudfront' | 'alb' | 'nlb' | 'tg' | 'target' | 'waf' | 'origin' | 'more' | 'apigw' | 'lambda';
export type Confidence = 'observed' | 'inferred';
export interface FlowNode { id: string; kind: FlowKind; label: string; meta?: Record<string, unknown> }
export interface FlowEdge { id: string; source: string; target: string; confidence: Confidence; label?: string }
export interface FlowGraph { nodes: FlowNode[]; edges: FlowEdge[] }

export interface FlowInput {
  route53?: Row[]; cloudfront?: Row[]; alb?: Row[]; nlb?: Row[]; tg?: Row[]; waf?: Row[];
  ec2?: Row[]; lambda?: Row[]; ecsTask?: Row[];
  // s3 buckets (resource_id = bucket name, carries arn) — lets a CloudFront S3 origin resolve to
  // the REAL bucket resource (full row + ARN) instead of a synthesized placeholder.
  s3?: Row[];
  // API Gateway v2 (HTTP API) — resource_id = api_id. A CloudFront execute-api origin resolves to
  // an apigw node; its integrations chain to Lambda (synced) and/or VPC_LINK→ALB/NLB→TG→ECS.
  apigatewayv2_api?: Row[];
  apigatewayv2_integration?: Row[];
  // CloudFront VPC origins (SDK-sourced; Steampipe omits VpcOriginConfig). Each row: resource_id =
  // vo_id, arn = backing ALB/NLB ARN, status, distribution_ids[] (which CF distributions use it).
  cloudfront_vpc_origin?: Row[];
  // L7 routing labels: ALB listener rules (SDK-sourced: load_balancer_arn, port, conditions[],
  // actions[] → path/host → TG) label the LB→TG edge; API GW routes (route_key + target=
  // 'integrations/<id>') label the apigw→backend edge.
  alb_listener_rule?: Row[];
  apigatewayv2_route?: Row[];
  // ip-target resolution (Spec 2): pod/ENI IP → friendly label + meta. EKS comes live from the
  // page (ipResolved); ECS is derived here from synced ecsTask rows. Builder stays pure.
  ipResolved?: Record<string, { label: string; resolved: 'eks' | 'ecs'; meta?: Record<string, unknown> }>;
}

/** ECS task ENI private IP → service/task. attachments[].Details[Name=privateIPv4Address].Value (PascalCase). */
function ecsIpMap(tasks: Row[]): Map<string, { label: string; resolved: 'ecs'; meta: Record<string, unknown> }> {
  const map = new Map<string, { label: string; resolved: 'ecs'; meta: Record<string, unknown> }>();
  for (const t of tasks) {
    const group = str(t.task_group);
    const svc = group.startsWith('service:') ? group.slice(8) : group;
    const taskId = str(t.resource_id).split('/').pop() || str(t.resource_id);
    for (const att of arr(t.attachments)) {
      for (const d of arr(att.Details)) {
        if (str(d.Name) === 'privateIPv4Address' && d.Value) {
          map.set(str(d.Value), { label: svc || taskId, resolved: 'ecs', meta: { ecsService: svc, task: taskId, cluster: str(t.cluster_arn).split('/').pop() } });
        }
      }
    }
  }
  return map;
}

/** CloudFront `aliases` jsonb → string[] (PascalCase {Items:[...]} or a plain array). */
function aliasesOf(c: Row): string[] {
  const a = c.aliases;
  if (Array.isArray(a)) return a.map(str);
  if (a && typeof a === 'object' && Array.isArray((a as Row).Items)) return ((a as Row).Items as unknown[]).map(str);
  return [];
}

/** Normalize a DNS name for matching (drop trailing dot, lowercase). */
const dns = (v: unknown): string => str(v).replace(/\.$/, '').toLowerCase();

/** Max targets rendered per target group before collapsing the rest into a "+N more" node. */
export const TARGET_CAP = 20;

/** A CloudFront origin domain that is an S3 endpoint → the bucket name, else null.
 *  Matches virtual-hosted REST + website endpoints: <bucket>.s3.<region>.amazonaws.com,
 *  <bucket>.s3.amazonaws.com, <bucket>.s3-<region>.amazonaws.com, ...s3-website... */
function s3Bucket(domain: string): string | null {
  const m = domain.match(/^(.+?)\.s3[.-][^/]*amazonaws\.com$/i);
  return m ? m[1] : null;
}

/** A CloudFront origin DomainName that is an API Gateway execute-api host → the api id, else null. */
function executeApiId(domain: string): string | null {
  const m = domain.match(/^([a-z0-9]+)\.execute-api\.[^.]+\.amazonaws\.com$/i);
  return m ? m[1] : null;
}

/** API GW integration_uri → the UNVERSIONED Lambda function ARN (strips a :alias/:version qualifier
 *  and the arn:aws:apigateway:..:lambda:path/.../functions/<fnArn>/invocations wrapper), else null. */
function lambdaArnFromIntegration(uri: string): string | null {
  let a = uri;
  const wrapped = uri.match(/\/functions\/(arn:aws:lambda:[^/]+)\/invocations/i);
  if (wrapped) a = wrapped[1];
  if (!/^arn:aws:lambda:/i.test(a)) return null;
  const parts = a.split(':'); // arn:aws:lambda:<region>:<acct>:function:<name>[:<qualifier>]
  return parts.length > 7 ? parts.slice(0, 7).join(':') : a;
}

/** An ELBv2 LISTENER arn → the load-balancer arn (':listener/'→':loadbalancer/', drop the listener
 *  id segment), else null. Guarded: only transforms a real listener ARN (never an arbitrary uri). */
function lbArnFromListener(uri: string): string | null {
  if (!/^arn:aws:elasticloadbalancing:[^:]*:[^:]*:listener\/(app|net)\/[^/]+\/[^/]+\/[^/]+$/i.test(uri)) return null;
  return uri.replace(':listener/', ':loadbalancer/').replace(/\/[^/]+$/, '');
}

export function buildFlowGraph(input: FlowInput): FlowGraph {
  const nodes: FlowNode[] = [];
  const edges: FlowEdge[] = [];
  const ids = new Set<string>();
  const edgeIds = new Set<string>();

  const addNode = (id: string, kind: FlowKind, label: string, meta?: Record<string, unknown>) => {
    if (id.endsWith(':') || ids.has(id)) return; // skip empty resource_id + dedup
    ids.add(id);
    nodes.push({ id, kind, label, ...(meta ? { meta } : {}) });
  };
  // label (optional): L7 routing detail on an edge — ALB path/host + port, or API GW route_key.
  // Edges dedup by source->target, so a 2nd edge between the same pair only adds its label.
  const addEdge = (source: string, target: string, confidence: Confidence = 'observed', label?: string) => {
    if (!ids.has(source) || !ids.has(target)) return; // both endpoints must be real nodes
    const id = `${source}->${target}`;
    if (edgeIds.has(id)) {
      if (label) { const e = edges.find((x) => x.id === id); if (e) e.label = e.label ? `${e.label} | ${label}` : label; }
      return;
    }
    edgeIds.add(id);
    edges.push({ id, source, target, confidence, ...(label ? { label } : {}) });
  };

  // 1) nodes first so edge endpoint checks resolve.
  // LB node ids are keyed by the globally-unique ARN (resource_id is just the name, which can
  // collide across regions); the name/dns_name is the display label.
  const lbId = (kind: 'alb' | 'nlb', r: Row) => `${kind}:${str(r.arn) || str(r.resource_id)}`;

  // meta.row + meta.invType carry the full source inventory row so the UI can show every
  // field (vpc, subnet, tags, …) on click — no extra fetch.
  for (const c of input.cloudfront ?? []) {
    const al = aliasesOf(c);
    addNode(`cf:${str(c.resource_id)}`, 'cloudfront', al[0] || str(c.name) || str(c.resource_id), { row: c, invType: 'cloudfront', ...(al.length ? { aliases: al } : {}) });
  }
  for (const a of input.alb ?? []) addNode(lbId('alb', a), 'alb', str(a.dns_name) || str(a.resource_id), { row: a, invType: 'alb' });
  for (const n of input.nlb ?? []) addNode(lbId('nlb', n), 'nlb', str(n.dns_name) || str(n.resource_id), { row: n, invType: 'nlb' });
  for (const w of input.waf ?? []) addNode(`waf:${str(w.resource_id)}`, 'waf', str(w.resource_id), { row: w, invType: 'waf' });
  for (const t of input.tg ?? []) addNode(`tg:${str(t.resource_id)}`, 'tg', str(t.target_group_name) || str(t.resource_id), { targetType: str(t.target_type), row: t, invType: 'target_group' });
  for (const a of input.apigatewayv2_api ?? []) addNode(`apigw:${str(a.resource_id)}`, 'apigw', str(a.name) || str(a.resource_id), { row: a, invType: 'apigatewayv2_api' });

  // Indexes for joins (LB by dns_name for CF origins, by arn for TG load_balancer_arns).
  const lbByDns = new Map<string, string>();   // lowercased dns_name → node id
  const lbByArn = new Map<string, string>();    // lb arn → node id
  const wafByArn = new Map<string, string>();   // waf arn → node id
  for (const a of input.alb ?? []) {
    if (a.dns_name) lbByDns.set(str(a.dns_name).toLowerCase(), lbId('alb', a));
    if (a.arn) lbByArn.set(str(a.arn), lbId('alb', a));
  }
  for (const n of input.nlb ?? []) {
    if (n.dns_name) lbByDns.set(str(n.dns_name).toLowerCase(), lbId('nlb', n));
    if (n.arn) lbByArn.set(str(n.arn), lbId('nlb', n));
  }
  for (const w of input.waf ?? []) if (w.arn) wafByArn.set(str(w.arn), `waf:${str(w.resource_id)}`);

  // Backend resolution (Spec 1 slice): instance targets → EC2 name, lambda targets → function name.
  // (ip targets → ECS task / EKS deployment is Spec 2 — needs ENI/pod-IP data not synced here.)
  const ec2ById = new Map<string, string>();    // instance-id → EC2 Name (or id)
  const lambdaByArn = new Map<string, string>(); // function arn → function name
  for (const e of input.ec2 ?? []) ec2ById.set(str(e.resource_id), str(e.name) || str(e.resource_id));
  for (const l of input.lambda ?? []) if (l.arn) lambdaByArn.set(str(l.arn), str(l.resource_id) || str(l.arn));
  const ecsByIp = ecsIpMap(input.ecsTask ?? []); // ECS task ENI IP → service (from synced inventory)
  // S3 buckets by NAME (resource_id) — join key for resolving CloudFront S3 origins to the real
  // bucket row. Bucket names are globally unique, so this is region-agnostic (a us-east-1 bucket
  // fronted by an ap-northeast-2 app still matches). Depends on the s3 inventory pk being 'name'.
  const s3ByName = new Map<string, Row>();
  for (const b of input.s3 ?? []) s3ByName.set(str(b.resource_id), b);
  // API Gateway nodes that actually exist (api_id) — an execute-api origin links only when synced.
  const apigwIds = new Set<string>();
  for (const a of input.apigatewayv2_api ?? []) apigwIds.add(str(a.resource_id));
  // Lambda row by UNVERSIONED arn — to lazily create the lambda nodes an apigw integration references.
  const lambdaRowByArn = new Map<string, Row>();
  for (const l of input.lambda ?? []) if (l.arn) lambdaRowByArn.set(str(l.arn), l);
  // CloudFront VPC origins: distribution id → backing LB arn(s). DEPLOYED only — a Failed VPC origin
  // falls through to the honest unresolved-origin node (no misleading solid edge). NOTE: VpcOriginConfig
  // is intentionally NOT read from the Steampipe origins jsonb (the SDK omits it); the join is the
  // SDK-sourced distribution_ids membership keyed on the distribution id (= cloudfront resource_id).
  // keyed by (distribution id | origin domain) so ONLY the actual VPC-origin origin links to the LB —
  // a co-resident external/custom origin on the same distribution does NOT get a false CF→LB edge.
  const voByDistDomain = new Map<string, string[]>();
  // ALL-status VPC-origin (dist|domain) keys — used ONLY to DETECT that an origin is a VPC origin
  // (so it's excluded from public Route53 resolution). Deployed-only would let a Deploying/Failed
  // VPC origin slip into the public path; detection must be status-agnostic. Edge LINKING still uses
  // voByDistDomain (Deployed + arn only).
  const vpcOriginKeys = new Set<string>();
  for (const v of input.cloudfront_vpc_origin ?? []) {
    for (const ref of arr(v.origin_refs)) vpcOriginKeys.add(`${str(ref.distribution_id)}|${str(ref.domain)}`);
    if (str(v.status) !== 'Deployed' || !v.arn) continue;
    for (const ref of arr(v.origin_refs)) {
      const k = `${str(ref.distribution_id)}|${str(ref.domain)}`;
      (voByDistDomain.get(k) ?? voByDistDomain.set(k, []).get(k)!).push(str(v.arn));
    }
  }

  // L7 ALB rule label: (lbArn|tgArn) → "<path|host> :<port>". Only FORWARD actions (with a TG)
  // produce a label — a fixed-response/redirect default rule has no TG, so it labels nothing.
  const ruleLabelByLbTg = new Map<string, string>();
  for (const r of input.alb_listener_rule ?? []) {
    const lbArn = str(r.load_balancer_arn); if (!lbArn) continue;
    const port = str(r.port);
    const vals: string[] = [];
    for (const c of arr(r.conditions)) {
      if (str(c.Field) === 'path-pattern') vals.push(...strs(((c.PathPatternConfig as Row)?.Values) ?? c.Values));
      else if (str(c.Field) === 'host-header') vals.push(...strs(((c.HostHeaderConfig as Row)?.Values) ?? c.Values));
    }
    const routing = vals.length ? vals.join(',') : (r.is_default ? 'default' : '');
    const label = `${routing || 'rule'}${port ? ` :${port}` : ''}`;
    const tgArns = new Set<string>();
    for (const a of arr(r.actions)) {
      if (a.TargetGroupArn) tgArns.add(str(a.TargetGroupArn));
      for (const tg of arr((a.ForwardConfig as Row)?.TargetGroups)) if (tg.TargetGroupArn) tgArns.add(str(tg.TargetGroupArn));
    }
    for (const tgArn of tgArns) {
      const key = `${lbArn}|${tgArn}`;
      ruleLabelByLbTg.set(key, ruleLabelByLbTg.has(key) ? `${ruleLabelByLbTg.get(key)} | ${label}` : label);
    }
  }

  // L7 API GW route label: integrationId → route_key(s). route.target = 'integrations/<id>'.
  // keyed by api_id:integration_id — integration ids are API-scoped, so a bare id can collide across APIs.
  const routeKeyByIntegration = new Map<string, string>();
  for (const r of input.apigatewayv2_route ?? []) {
    const m = str(r.target).match(/^integrations\/(.+)$/);
    if (!m) continue;
    const id = `${str(r.api_id)}:${m[1]}`; const rk = str(r.route_key);
    if (rk) routeKeyByIntegration.set(id, routeKeyByIntegration.has(id) ? `${routeKeyByIntegration.get(id)} | ${rk}` : rk);
  }

  // CloudFront indexes for Route53 alias targets: by distribution domain (d111.cloudfront.net)
  // and by custom-domain alias (the CNAMEs on the distribution).
  const cfByDomain = new Map<string, string>(); // cloudfront domain_name → cf node id
  const cfByAlias = new Map<string, string>();  // custom-domain alias → cf node id
  for (const c of input.cloudfront ?? []) {
    const cfId = `cf:${str(c.resource_id)}`;
    if (c.domain_name) cfByDomain.set(dns(c.domain_name), cfId);
    for (const a of aliasesOf(c)) cfByAlias.set(dns(a), cfId);
  }

  // Route53 alias map: record name → its alias_target DNSName (both normalized). Lets a CloudFront
  // CUSTOM-domain origin (not a raw *.elb.amazonaws.com) be resolved to the LB it ultimately points
  // at — the gap that left grafana-internal.example.com-style origins target-less.
  // Normalize a DNS name AND strip a leading `dualstack.` — but ONLY when the result is an ELB host
  // (the `dualstack.` prefix is an ELB ALIAS convention; a literal `dualstack.`-prefixed non-ELB
  // hostname must not be mangled, which would break a later chain-hop lookup).
  // ELB hosts come in two shapes: ALB `<name>.<region>.elb.amazonaws.com` (region BEFORE elb) and
  // NLB `<name>.elb.<region>.amazonaws.com` (region AFTER elb) — accept both.
  const isElbHost = (h: string): boolean => /\.elb\.(?:[a-z0-9-]+\.)?amazonaws\.com$/i.test(h);
  const bareDns = (v: unknown): string => {
    const d = dns(v);
    const stripped = d.replace(/^dualstack\./, '');
    return stripped !== d && isElbHost(stripped) ? stripped : d;
  };
  // Build name → alias_target, but ONLY from PUBLIC-zone records (private_zone === false). A standard
  // CloudFront custom origin resolves its origin over PUBLIC DNS, so a private-zone record can't back
  // a reachable CF→LB edge; private_zone===true (private) or undefined (visibility unknown — e.g. an
  // older sync before the private_zone column) is skipped → the origin stays honestly unresolved.
  // Also drop AMBIGUOUS names (same name → conflicting targets) so resolution is DETERMINISTIC.
  const r53Targets = new Map<string, Set<string>>();
  for (const r of input.route53 ?? []) {
    if (r.private_zone !== false) continue; // public-only (skips private + unknown)
    const name = dns(r.name) || dns(r.resource_id);
    const aliasT = (r.alias_target && typeof r.alias_target === 'object') ? (r.alias_target as Row) : {};
    // ALIAS records carry alias_target.DNSName; CNAME/other records carry the target in `records[]`
    // (string values, or {Value} objects defensively).
    let target = bareDns(aliasT.DNSName);
    if (!target) {
      const recs = arr(r.records);
      const first = recs.length ? (typeof recs[0] === 'string' ? recs[0] : str((recs[0] as Row).Value)) : '';
      target = bareDns(first);
    }
    if (name && target && name !== target) (r53Targets.get(name) ?? r53Targets.set(name, new Set()).get(name)!).add(target);
  }
  const r53AliasByName = new Map<string, string>();
  for (const [name, targets] of r53Targets) if (targets.size === 1) r53AliasByName.set(name, [...targets][0]);

  // LB dns_names that are internet-facing. A STANDARD (non-VPC) CloudFront custom origin reaches its
  // origin over the public internet, so a Route53-resolved CF→LB edge is only honest for these — an
  // internal LB is unreachable from a standard custom origin (the VPC-origin path returned earlier).
  const internetFacingLbDns = new Set<string>();
  for (const lb of [...(input.alb ?? []), ...(input.nlb ?? [])]) {
    if (lb.dns_name && str(lb.scheme).toLowerCase() === 'internet-facing') internetFacingLbDns.add(str(lb.dns_name).toLowerCase());
  }
  // Follow the alias chain (≤4 hops, cycle-guarded) → TERMINAL DNS name, or null if the domain isn't
  // a known Route53 record. The terminal may be a synced LB dns_name (→ real CF→LB edge) or a
  // non-synced (e.g. cross-region) ELB host (→ surfaced as the unresolved origin's resolved target).
  const resolveViaR53 = (domain: string): string | null => {
    let cur = domain, hops = 0;
    const seen = new Set<string>();
    while (r53AliasByName.has(cur)) {
      // cycle (A→B→A) or hop-limit exhaustion → the terminal is untrustworthy; return null rather
      // than a mid-chain record name (which would surface as a misleading resolved target).
      if (hops >= 4 || seen.has(cur)) return null;
      seen.add(cur);
      cur = r53AliasByName.get(cur)!;
      hops++;
    }
    return cur === domain ? null : cur; // terminated outside the map; null if nothing resolved
  };

  // 2) Route53 → CloudFront / LB. Records are the true front door (custom domain). Match the
  // record's alias target (or the record name itself) to a CF distribution domain/alias or an
  // LB dns_name. Records that resolve to nothing we track are skipped (no orphan DNS clutter).
  for (const r of input.route53 ?? []) {
    const aliasT = (r.alias_target && typeof r.alias_target === 'object') ? (r.alias_target as Row) : {};
    const targetDns = dns(aliasT.DNSName);          // ALIAS records: where the name points
    // clean record name (r.resource_id is the composite "name TYPE"); used for label + alias match.
    const recName = dns(r.name) || dns(r.resource_id);
    const downstream =
      cfByDomain.get(targetDns) || lbByDns.get(targetDns) ||  // alias → CF / LB
      cfByAlias.get(recName);                                 // record name == a CF custom-domain alias
    if (!downstream) continue;
    const rid = `r53:${str(r.resource_id) || recName}`;
    addNode(rid, 'route53', recName || str(r.resource_id), { recordType: str(r.type), row: r, invType: 'route53' });
    addEdge(rid, downstream);
  }

  // 3) CloudFront → origins (ALB/NLB by DNS, or unresolved origin node) + CF→WAF.
  for (const c of input.cloudfront ?? []) {
    const cfId = `cf:${str(c.resource_id)}`;
    const wafArn = str(c.web_acl_id);
    if (wafArn && wafByArn.has(wafArn)) addEdge(cfId, wafByArn.get(wafArn)!);

    arr(c.origins).forEach((o, i) => {
      const domain = str(o.DomainName);
      const lbId = lbByDns.get(domain.toLowerCase());
      if (lbId) { addEdge(cfId, lbId); return; }
      // API Gateway execute-api origin → apigw node (ONLY when the api is synced; otherwise fall
      // through so the origin is still represented as an honest unresolved node, not dropped).
      const apiId = executeApiId(domain);
      if (apiId && apigwIds.has(apiId)) { addEdge(cfId, `apigw:${apiId}`); return; }
      // CloudFront VPC origin: this specific origin (distribution id + its domain) → backing ALB/NLB
      // via the SDK-sourced cloudfront_vpc_origin. Domain-scoped so a co-resident external origin
      // on the same distribution is NOT mislinked.
      const voArns = voByDistDomain.get(`${str(c.resource_id)}|${domain}`);
      if (voArns) {
        let linked = false;
        for (const arn of voArns) { const id = lbByArn.get(arn); if (id) { addEdge(cfId, id); linked = true; } }
        if (linked) return;
        // Known VPC origin but backing LB not synced: it is NOT reached via public DNS, so do NOT
        // fall through to the Route53 public-resolution path below (that would draw a misleading
        // public CF→LB edge) — leave it as the honest unresolved VPC-origin node.
      }
      // A VPC origin is ANY origin with VpcOriginConfig (Steampipe path) OR a matched cloudfront_vpc_origin
      // (SDK path) — both are private, NOT reached via public DNS. Detect via EITHER so a non-Deployed or
      // SDK-omitted VPC origin can't slip into public Route53 resolution.
      const isVpcOrigin = vpcOriginKeys.has(`${str(c.resource_id)}|${domain}`)
        || (!!o.VpcOriginConfig && typeof o.VpcOriginConfig === 'object');
      // Custom-domain origin → resolve via the Route53 alias chain. Lands on a SYNCED LB → draw the
      // real CF→LB edge (A). Lands on a non-synced (e.g. cross-region) ELB → fall through to an
      // unresolved node but surface the resolved target so the chain is still legible (C).
      // Skipped for VPC origins — those aren't public-DNS paths.
      let resolvedTarget: string | null = null;
      if (domain && !isVpcOrigin) {
        const term = resolveViaR53(dns(domain));
        if (term) {
          const lid = lbByDns.get(term);
          // Draw the edge ONLY to a synced, internet-facing LB (a standard custom origin can't reach
          // an internal LB). DNS-chain-derived → 'inferred' (dashed). Otherwise surface the target.
          if (lid && internetFacingLbDns.has(term)) { addEdge(cfId, lid, 'inferred'); return; }
          resolvedTarget = term;
        }
      }
      // Otherwise: honest unresolved-origin node, never a false LB edge.
      const vpc = (o.VpcOriginConfig && typeof o.VpcOriginConfig === 'object') ? ' (VPC origin)' : '';
      const oid = `origin:${str(c.resource_id)}:${domain || i}`;
      // S3 origin → resolve to the REAL bucket resource (full row + ARN), not a placeholder.
      // Join the synced s3 inventory by bucket name; if the bucket isn't synced (e.g. >cap, or a
      // not-yet-synced cross-region bucket), synthesize a minimal row with the canonical S3 ARN
      // (arn:aws:s3:::<bucket> — partition-only, no region/account) so ARN copy / Ask-AI still work.
      // Keep service:'s3' in BOTH branches (the Database/S3 icon is keyed on meta.service).
      const bucket = domain ? s3Bucket(domain) : null;
      if (bucket) {
        const row = s3ByName.get(bucket) ?? { resource_id: bucket, name: bucket, arn: `arn:aws:s3:::${bucket}` };
        addNode(oid, 'origin', bucket, { service: 's3', bucket, domain, invType: 's3', row });
      } else {
        const label = resolvedTarget ? `${domain} → ${resolvedTarget}` : `${domain || 'origin'}${vpc}`;
        addNode(oid, 'origin', label, { unresolved: true, ...(resolvedTarget ? { resolvedTarget } : {}) });
      }
      addEdge(cfId, oid);
    });
  }

  // 3b) API Gateway → backend. AWS_PROXY integration_uri → Lambda node (created lazily — only the
  // Lambdas an apigw actually fronts). VPC_LINK (private) integration whose integration_uri is an
  // ELBv2 listener ARN → the existing ALB/NLB node (so apigw→ALB→TG→ECS chains). connection_type is
  // the authoritative VPC_LINK signal; the listener→LB transform is guarded to a real listener ARN.
  for (const ig of input.apigatewayv2_integration ?? []) {
    const apiId = str(ig.api_id);
    if (!apigwIds.has(apiId)) continue;
    const apigwNode = `apigw:${apiId}`;
    const routeKey = routeKeyByIntegration.get(`${apiId}:${str(ig.resource_id)}`); // route path(s) → this integration
    const uri = str(ig.integration_uri);
    const lArn = lambdaArnFromIntegration(uri);
    if (lArn) {
      const node = `lambda:${lArn}`;
      const row = lambdaRowByArn.get(lArn);
      addNode(node, 'lambda', row ? str(row.resource_id) || lArn : lArn.split(':function:')[1] || lArn,
        row ? { row, invType: 'lambda' } : { arn: lArn });
      addEdge(apigwNode, node, 'observed', routeKey);
      continue;
    }
    if (str(ig.connection_type) === 'VPC_LINK') {
      const derived = lbArnFromListener(uri);
      const id = derived ? lbByArn.get(derived) : undefined;
      if (id) addEdge(apigwNode, id, 'observed', routeKey);
    }
  }

  // 4) ALB/NLB → TG (via load_balancer_arns) and TG → targets (target_health_descriptions).
  for (const t of input.tg ?? []) {
    const tgId = `tg:${str(t.resource_id)}`;
    // load_balancer_arns is an array of plain ARN strings (not objects) → normalize separately.
    const lbArns = Array.isArray(t.load_balancer_arns)
      ? (t.load_balancer_arns as unknown[]).map(str)
      : (typeof t.load_balancer_arns === 'string' && t.load_balancer_arns.trim().startsWith('[')
          ? (() => { try { return (JSON.parse(t.load_balancer_arns as string) as unknown[]).map(str); } catch { return []; } })()
          : []);
    for (const lbArn of lbArns) {
      const lbId = lbByArn.get(lbArn);
      if (lbId) addEdge(lbId, tgId, 'observed', ruleLabelByLbTg.get(`${lbArn}|${str(t.resource_id)}`));
    }

    // GROUP targets by resolved workload: an ASG / EKS replicas / ECS tasks behind a TG are ONE
    // workload differing only by IP — collapse them into a single node with the member IPs listed
    // (scales to 100s of replicas without a per-IP node blow-up). A single target keeps its old
    // per-target shape (label/id/port) so 1:1 cases render exactly as before.
    const thds = arr(t.target_health_descriptions);
    const ttype = str(t.target_type);
    interface Grp { key: string; groupLabel: string; resolved: string; meta: Record<string, unknown>; members: { id: string; port: unknown; health: string; label: string }[] }
    const groups = new Map<string, Grp>();
    thds.forEach((thd, i) => {
      const target = (thd.Target && typeof thd.Target === 'object') ? (thd.Target as Row) : {};
      const health = (thd.TargetHealth && typeof thd.TargetHealth === 'object') ? (thd.TargetHealth as Row) : {};
      const targetId = str(target.Id) || `unknown-${i}`;
      // group key + the per-member label + (for multi) the group label. Resolve instance→EC2,
      // lambda→function, ip→EKS/ECS workload.
      let key = 'ip', mlabel = targetId, groupLabel = 'targets', resolved = '', meta: Record<string, unknown> = {};
      if (ttype === 'instance') { resolved = ec2ById.has(targetId) ? 'ec2' : ''; key = 'ec2'; mlabel = ec2ById.get(targetId) || targetId; groupLabel = 'EC2 instances'; }
      else if (ttype === 'lambda') { resolved = lambdaByArn.has(targetId) ? 'lambda' : ''; key = `lambda:${targetId}`; mlabel = lambdaByArn.get(targetId) || targetId; groupLabel = mlabel; }
      else if (ttype === 'ip') {
        const r = input.ipResolved?.[targetId] ?? ecsByIp.get(targetId); // EKS (live) then ECS (synced)
        // group key includes cluster so same-named workloads in different clusters don't merge
        if (r) { resolved = r.resolved; key = `${r.resolved}:${str(r.meta?.cluster ?? '')}/${r.label}`; mlabel = r.label; groupLabel = r.label; meta = r.meta ?? {}; }
      }
      let g = groups.get(key);
      if (!g) { g = { key, groupLabel, resolved, meta, members: [] }; groups.set(key, g); }
      g.members.push({ id: targetId, port: target.Port ?? null, health: str(health.State) || 'unknown', label: mlabel });
    });
    for (const g of groups.values()) {
      const total = g.members.length;
      const healthy = g.members.filter((m) => m.health === 'healthy').length;
      // aggregate state for the node color: all-healthy → healthy; any unhealthy → unhealthy; else the worst non-healthy.
      const aggHealth = total === healthy ? 'healthy' : g.members.some((m) => m.health === 'unhealthy') ? 'unhealthy' : (g.members.find((m) => m.health !== 'healthy')?.health || 'unknown');
      const single = total === 1;
      const nodeId = `target:${str(t.resource_id)}:${g.key}`;
      addNode(nodeId, 'target', single ? g.members[0].label : `${g.groupLabel} ×${total}`, {
        targetType: ttype,
        health: aggHealth,
        ...(single ? { id: g.members[0].id, port: g.members[0].port }
                   : { count: total, healthSummary: `${healthy}/${total} healthy`,
                       // member IP[:port] list (display-capped; count stays accurate)
                       members: g.members.slice(0, TARGET_CAP).map((m) => (m.port == null ? m.id : `${m.id}:${m.port}`)),
                       ...(total > TARGET_CAP ? { membersTruncated: total - TARGET_CAP } : {}) }),
        ...(g.resolved ? { resolved: g.resolved } : {}),
        ...g.meta,
      });
      addEdge(tgId, nodeId);
    }
  }

  return { nodes, edges };
}

/**
 * BFS-reachable subtree from an entry node over outgoing edges. A CloudFront id yields its whole
 * downstream; an LB id yields ALB→TG→targets only (not the CF above it). null / unknown id → full graph.
 */
export function filterFromEntry(graph: FlowGraph, entryId: string | null): FlowGraph {
  if (!entryId || !graph.nodes.some((n) => n.id === entryId)) return graph;
  const out = new Map<string, FlowEdge[]>();
  for (const e of graph.edges) {
    const list = out.get(e.source);
    if (list) list.push(e); else out.set(e.source, [e]);
  }
  const keep = new Set<string>([entryId]);
  const queue = [entryId];
  while (queue.length) {
    const cur = queue.shift()!;
    for (const e of out.get(cur) ?? []) if (!keep.has(e.target)) { keep.add(e.target); queue.push(e.target); }
  }
  return {
    nodes: graph.nodes.filter((n) => keep.has(n.id)),
    edges: graph.edges.filter((e) => keep.has(e.source) && keep.has(e.target)),
  };
}
