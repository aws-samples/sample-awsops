import { CloudTrailClient, LookupEventsCommand } from '@aws-sdk/client-cloudtrail';
import { verifyUser } from '@/lib/auth';
import { isAdmin } from '@/lib/admin';

export const dynamic = 'force-dynamic';

const REGION = process.env.AWS_REGION || 'ap-northeast-2';
let ct: CloudTrailClient | null = null;
const ctClient = () => (ct ??= new CloudTrailClient({ region: REGION }));

export interface TrailEvent {
  time: string; name: string; source: string; user: string;
  resourceType: string; resourceName: string; readOnly: boolean;
  // Drill-down fields (gap L62) — from the SAME LookupEvents response (no new AWS surface).
  eventId: string;
  awsRegion: string;
  sourceIPAddress: string;
  userAgent: string;
  errorCode: string;
  /** Every resource on the event (the table shows only the first). */
  resources: { type: string; name: string }[];
  /** First-class access key id (v1 parity — a single Event-section field). */
  accessKeyId: string;
  /** The parsed CloudTrailEvent payload, PROJECTED through RAW_KEYS/UID_KEYS — never the
   *  unfiltered blob (repo redaction precedent: dx.ts, eks-incluster). null when the JSON was
   *  malformed. */
  raw: Record<string, unknown> | null;
}

// Allowlist for the drill-down payload: forensic call detail stays (request/response params —
// CloudTrail itself redacts known-sensitive fields there, e.g. passwords), while the
// userIdentity block is reduced to identity NAMES — sessionContext/credential detail never
// leaves the server as a bulk-copyable blob. redactEgress is deliberately NOT applied: it is
// the EXTERNAL-egress scrubber and masks ARNs, which this in-app authed dashboard shows as
// first-class data everywhere (inventory JSONB included).
const RAW_KEYS = [
  'eventVersion', 'eventTime', 'eventName', 'eventSource', 'awsRegion', 'sourceIPAddress',
  'userAgent', 'errorCode', 'errorMessage', 'requestParameters', 'responseElements',
  'readOnly', 'eventType', 'managementEvent', 'recipientAccountId', 'eventID', 'requestID',
] as const;
const UID_KEYS = ['type', 'arn', 'accountId', 'userName', 'invokedBy'] as const;

// requestParameters/responseElements routinely carry credential-adjacent material
// (sts:AssumeRole → responseElements.credentials.sessionToken; iam:CreateAccessKey →
// responseElements.accessKey; lambda Create/UpdateFunction → environment variables;
// ec2:RunInstances → userData; CFN → keyMaterial/authParameters) — key-level projection alone
// is not a redaction. Recursive deny-list over the admitted subtrees, matched against the key
// NORMALIZED to lowercase with separators stripped (x-api-key / access_key / accessKeyId all
// hit); matched keys keep their PRESENCE (forensics: the call set credentials) but never their
// value. Defense-in-depth ATOP CloudTrail's own masking of known-sensitive fields — a
// deny-list can't prove completeness, so the docs describe it as credential-family masking,
// not a guarantee of secretlessness.
const SENSITIVE_KEY = /credential|token|secret|password|userdata|privatekey|authoriz|apikey|accesskey|keymaterial|authparameters|environment/;

function scrubSensitive(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(scrubSensitive);
  if (v && typeof v === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
      const norm = k.toLowerCase().replace(/[-_ ]/g, '');
      out[k] = SENSITIVE_KEY.test(norm) ? '[REDACTED]' : scrubSensitive(val);
    }
    return out;
  }
  return v;
}

function projectRaw(raw: Record<string, unknown> | null): Record<string, unknown> | null {
  if (!raw) return null;
  const out: Record<string, unknown> = {};
  for (const k of RAW_KEYS) if (raw[k] !== undefined) out[k] = scrubSensitive(raw[k]);
  const uid = raw.userIdentity;
  if (uid && typeof uid === 'object') {
    const u: Record<string, unknown> = {};
    for (const k of UID_KEYS) {
      const v = (uid as Record<string, unknown>)[k];
      if (v !== undefined) u[k] = v;
    }
    out.userIdentity = u;
  }
  return out;
}

/** Recent CloudTrail events (v1 parity: last 20, live LookupEvents). ?write=1 → write-only audit
 *  view. The forensic drill-down block (`raw` + `accessKeyId`) is ADMIN-ONLY — the repo already
 *  gates identity-grade data that way (ADMIN_ONLY_TYPES, a pentest remediation), and the value
 *  scrub is a deny-list that cannot prove completeness; non-admins keep the flat Event fields. */
export async function GET(request: Request) {
  const user = await verifyUser(request.headers.get('cookie'));
  if (!user) {
    return Response.json({ status: 'error', message: 'unauthenticated' }, { status: 401 });
  }
  const admin = await isAdmin(user);
  const writeOnly = new URL(request.url).searchParams.get('write') === '1';
  try {
    const r = await ctClient().send(new LookupEventsCommand({
      MaxResults: 20,
      ...(writeOnly ? { LookupAttributes: [{ AttributeKey: 'ReadOnly', AttributeValue: 'false' }] } : {}),
    }));
    const events: TrailEvent[] = (r.Events ?? []).map((e) => {
      // The payload was already parsed for readOnly and thrown away — keep it for the
      // drill-down panel (gap L62). Malformed JSON → raw:null, the row still renders.
      let raw: Record<string, unknown> | null = null;
      try { raw = JSON.parse(e.CloudTrailEvent ?? '') as Record<string, unknown>; } catch { /* keep null */ }
      const readOnly = raw?.readOnly !== false;
      const res = e.Resources?.[0];
      return {
        time: e.EventTime instanceof Date ? e.EventTime.toISOString() : String(e.EventTime ?? ''),
        name: e.EventName ?? '',
        source: e.EventSource ?? '',
        user: e.Username ?? '',
        resourceType: res?.ResourceType?.replace(/^AWS::/, '') ?? '',
        resourceName: res?.ResourceName ?? '',
        readOnly,
        eventId: e.EventId ?? '',
        awsRegion: typeof raw?.awsRegion === 'string' ? raw.awsRegion : '',
        sourceIPAddress: typeof raw?.sourceIPAddress === 'string' ? raw.sourceIPAddress : '',
        userAgent: typeof raw?.userAgent === 'string' ? raw.userAgent : '',
        errorCode: typeof raw?.errorCode === 'string' ? raw.errorCode : '',
        resources: (e.Resources ?? []).map((x) => ({
          type: x.ResourceType?.replace(/^AWS::/, '') ?? '', name: x.ResourceName ?? '',
        })),
        accessKeyId: admin && typeof (raw?.userIdentity as Record<string, unknown> | undefined)?.accessKeyId === 'string'
          ? String((raw!.userIdentity as Record<string, unknown>).accessKeyId) : '',
        raw: admin ? projectRaw(raw) : null,
      };
    });
    return Response.json({ events });
  } catch (e) {
    return Response.json({ status: 'error', message: e instanceof Error ? e.message : String(e) }, { status: 500 });
  }
}
