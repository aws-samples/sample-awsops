import {
  Search, Server, Zap, Boxes, Package, Archive, HardDrive, Camera, Database, Table2,
  DatabaseZap, Radio, Network, Split, BrickWall, Scale, Target, Globe, ListFilter,
  FileSearch, Bell, BellRing, KeyRound, Users, Shield, Activity,
  AlertTriangle, AlertCircle, CheckCircle2, Circle, CircleOff, CircleStop,
  MapPin, Lock, LockOpen, Copy, Clock, Layers, Hash, Share2, Route, ArrowLeftRight, Waypoints, type LucideIcon,
} from 'lucide-react';

// v1-parity KPI glyphs (v1 StatsCard used lucide icons in a translucent corner box, not emoji).
// Shared by the inventory type page, the dashboard resource tiles, and group overviews so a
// resource type renders the SAME icon everywhere. Per-type icon for total tiles; a group
// fallback covers unlisted types.
export const TYPE_ICON: Record<string, LucideIcon> = {
  ec2: Server, lambda: Zap, ecs_cluster: Boxes, ecs_service: Boxes, ecs_task: Boxes, ecr: Package,
  s3: Archive, ebs_volume: HardDrive, ebs_snapshot: Camera, rds: Database, dynamodb: Table2,
  elasticache: DatabaseZap, opensearch: Search, msk: Radio, vpc: Network, subnet: Split,
  security_group: BrickWall, alb: Scale, nlb: Scale, target_group: Target,
  cloudfront: Globe, cloudfront_vpc_origin: Globe, alb_listener_rule: ListFilter,
  waf: BrickWall, cloudtrail: FileSearch, cloudwatch_alarm: Bell,
  iam_role: KeyRound, iam_user: Users, route53: Globe,
  neptune_cluster: Share2, opensearch_serverless: Search,
  route_table: Route, nat_gateway: ArrowLeftRight, internet_gateway: Globe, transit_gateway: Waypoints,
  apigatewayv2_api: Network, apigatewayv2_stage: Network,
};

export const GROUP_ICON: Record<string, LucideIcon> = {
  Compute: Server, 'Storage & DB': Database, Network: Network, Security: Shield, Monitoring: Activity,
};

/** KPI health glyph by tile variant (총 tile uses the type icon; state tiles use these). */
export function variantIcon(v: 'default' | 'accent' | 'danger' | 'warn'): LucideIcon {
  return v === 'danger' ? AlertTriangle : v === 'warn' ? AlertCircle : v === 'accent' ? CheckCircle2 : Circle;
}

// Highlight-card glyphs by label semantics. A bare Circle on default-variant cards read as
// "no icon", so every card gets a meaningful glyph: keyword match first (KO+EN, covers all
// HIGHLIGHTS labels and raw state values), then tile variant, then Hash (it's a count).
const HIGHLIGHT_ICONS: [RegExp, LucideIcon][] = [
  [/중지|정지|stopp?ed/i, CircleStop],
  [/퍼블릭|공개|public|인터넷|internet|노출/i, Globe],
  [/리전|region/i, MapPin],
  [/미암호화|unencrypt/i, LockOpen],
  [/암호화|encrypt|내부|internal/i, Lock],
  [/mfa|credential/i, KeyRound],
  [/멀티|multi/i, Copy],
  [/알람|alarm/i, BellRing],
  [/개방|오픈|ingress|보안 그룹|security group|\bsgs?\b/i, BrickWall],
  [/액션|action/i, Bell],
  [/로깅|logging|trail|검증|validation/i, FileSearch],
  [/eol|deprecated|만료/i, AlertCircle],
  [/pending|대기|유휴|idle/i, Clock],
  [/desired|target/i, Target],
  [/클러스터|cluster/i, Boxes],
  [/용량|볼륨|size|volume|storage/i, HardDrive],
  [/종류|타입|유형|kinds?|runtime|런타임|엔진|engine|네임스페이스|namespace/i, Layers],
  [/실행|running|가용|available|활성|active|사용 중|in-?use|완료|complete|ok|healthy|설정/i, CheckCircle2],
  [/비활성|꺼짐|미설정|해제|미제한|disabled|inactive/i, CircleOff],
];

export function highlightIcon(label: string, variant?: 'default' | 'accent' | 'danger' | 'warn'): LucideIcon {
  for (const [re, I] of HIGHLIGHT_ICONS) if (re.test(label)) return I;
  if (variant === 'danger') return AlertTriangle;
  if (variant === 'warn') return AlertCircle;
  if (variant === 'accent') return CheckCircle2;
  return Hash;
}
