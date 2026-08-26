import { CloudTrailClient, LookupEventsCommand } from '@aws-sdk/client-cloudtrail';
import { verifyUser } from '@/lib/auth';

export const dynamic = 'force-dynamic';

const REGION = process.env.AWS_REGION || 'ap-northeast-2';
let ct: CloudTrailClient | null = null;
const ctClient = () => (ct ??= new CloudTrailClient({ region: REGION }));

export interface TrailEvent {
  time: string; name: string; source: string; user: string;
  resourceType: string; resourceName: string; readOnly: boolean;
}

/** Recent CloudTrail events (v1 parity: last 20, live LookupEvents). ?write=1 → write-only audit view. */
export async function GET(request: Request) {
  if (!(await verifyUser(request.headers.get('cookie')))) {
    return Response.json({ status: 'error', message: 'unauthenticated' }, { status: 401 });
  }
  const writeOnly = new URL(request.url).searchParams.get('write') === '1';
  try {
    const r = await ctClient().send(new LookupEventsCommand({
      MaxResults: 20,
      ...(writeOnly ? { LookupAttributes: [{ AttributeKey: 'ReadOnly', AttributeValue: 'false' }] } : {}),
    }));
    const events: TrailEvent[] = (r.Events ?? []).map((e) => {
      let readOnly = true;
      try { readOnly = JSON.parse(e.CloudTrailEvent ?? '{}')?.readOnly !== false; } catch { /* keep true */ }
      const res = e.Resources?.[0];
      return {
        time: e.EventTime instanceof Date ? e.EventTime.toISOString() : String(e.EventTime ?? ''),
        name: e.EventName ?? '',
        source: e.EventSource ?? '',
        user: e.Username ?? '',
        resourceType: res?.ResourceType?.replace(/^AWS::/, '') ?? '',
        resourceName: res?.ResourceName ?? '',
        readOnly,
      };
    });
    return Response.json({ events });
  } catch (e) {
    return Response.json({ status: 'error', message: e instanceof Error ? e.message : String(e) }, { status: 500 });
  }
}
