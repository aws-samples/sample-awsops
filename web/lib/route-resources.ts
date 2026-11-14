// Resource-first routing: a prompt that names a concrete AWS resource (ID or ARN) belongs to the
// section that owns that resource's tools, regardless of incidental keywords ("i-0abc 보안 점검"
// is an instance question, not an IAM one).

const ID_TAIL = '-(?:[0-9a-f]{17}|[0-9a-f]{8})\\b';
const NETWORK_PREFIXES = 'eni|sg|acl|rtb|subnet|vpc|vpce|tgw-attach|tgw-rtb|tgw|nat|igw|pcx|vpn|vgw|cgw';
const NETWORK_ID = new RegExp(`\\b(?:${NETWORK_PREFIXES})${ID_TAIL}`, 'i');
const INSTANCE_ID = new RegExp(`\\bi${ID_TAIL}`, 'i');
// An ARN's resource part uses ASCII ARN characters only (commas included, as in IAM names), so the
// match stops at whitespace or CJK text.
const ARN = /arn:aws[a-z-]*:([a-z0-9-]+):[\w:/.+=@*,-]*/gi;
// Object word that replaces a network ID before keyword matching, so "sg-… 정책" reads like "sg 정책".
const NETWORK_ID_WORD: Record<string, string> = { eni: 'eni', sg: 'sg', acl: 'nacl', rtb: 'route table' };
const NETWORK_ID_G = new RegExp(`\\b(${NETWORK_PREFIXES})${ID_TAIL}`, 'gi');
const INSTANCE_ID_G = new RegExp(INSTANCE_ID.source, 'gi');
/** Token that replaces an EC2 instance ID; no keyword rule matches it. */
export const INSTANCE_TOKEN = 'ec2-instance';

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

/** The prompt prepared for keyword matching: a network ID becomes its object word (sg, eni, nacl,
 *  route table, or network for the other prefixes), an instance ID a neutral token and an ARN its
 *  service name, so the network-object rule applies to `sg-…` exactly as to "sg" and
 *  `arn:aws:dynamodb:…` still matches the data rule, while resource-name text is never a keyword. */
export function stripResources(prompt: string): string {
  return prompt
    .replace(ARN, (_m, service: string) => ` ${service} `)
    .replace(NETWORK_ID_G, (_m, prefix: string) => ` ${NETWORK_ID_WORD[prefix.toLowerCase()] ?? 'network'} `)
    .replace(INSTANCE_ID_G, ` ${INSTANCE_TOKEN} `);
}
