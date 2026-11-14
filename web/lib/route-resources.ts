// Resource-first routing: a prompt that names a concrete AWS resource (ID or ARN) belongs to the
// section that owns that resource's tools, regardless of incidental keywords ("i-0abc 보안 점검"
// is an instance question, not an IAM one).

const ID_TAIL = '-(?:[0-9a-f]{17}|[0-9a-f]{8})\\b';
const NETWORK_PREFIXES = 'eni|sg|acl|rtb|subnet|vpc|vpce|tgw-attach|tgw-rtb|tgw|nat|igw|pcx|vpn|vgw|cgw';
const NETWORK_ID = new RegExp(`\\b(?:${NETWORK_PREFIXES})${ID_TAIL}`, 'i');
const INSTANCE_ID = new RegExp(`\\bi${ID_TAIL}`, 'i');
// An ARN's resource part uses ASCII ARN characters only, so the match stops at CJK text or a comma.
const ARN = /arn:aws[a-z-]*:([a-z0-9-]+):[\w:/.+=@*-]*/gi;

// Ordered list; the match with the lowest index in the prompt wins (first-named resource).
const RESOURCE_RULES: { re: RegExp; key: string }[] = [
  { re: NETWORK_ID, key: 'network' },
  { re: INSTANCE_ID, key: 'ops' },
  { re: /arn:aws[a-z-]*:iam:/i, key: 'security' },
  { re: /arn:aws[a-z-]*:(?:eks|ecs):/i, key: 'container' },
  { re: /arn:aws[a-z-]*:rds:/i, key: 'data' },
  { re: /arn:aws[a-z-]*:(?:elasticloadbalancing|cloudfront):/i, key: 'ops' },
  { re: /arn:aws[a-z-]*:cloudformation:/i, key: 'iac' },
];

/** Section key of the first-named recognised AWS resource in the prompt, else undefined. */
export function resourceSection(prompt: string): string | undefined {
  let best: { index: number; key: string } | undefined;
  for (const { re, key } of RESOURCE_RULES) {
    const m = re.exec(prompt);
    if (m && (best === undefined || m.index < best.index)) best = { index: m.index, key };
  }
  return best?.key;
}

/** The prompt prepared for keyword matching: IDs are blanked and an ARN is reduced to its service
 *  name, so `sg-…`/`eni-…` or ARN resource text is never read as a keyword while
 *  `arn:aws:dynamodb:…` still matches the data rule. */
export function stripResources(prompt: string): string {
  return prompt
    .replace(ARN, (_m, service: string) => ` ${service} `)
    .replace(new RegExp(NETWORK_ID.source, 'gi'), ' ')
    .replace(new RegExp(INSTANCE_ID.source, 'gi'), ' ');
}
