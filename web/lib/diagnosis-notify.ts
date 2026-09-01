import {
  SNSClient,
  SubscribeCommand,
  UnsubscribeCommand,
  ListSubscriptionsByTopicCommand,
  PublishCommand,
} from '@aws-sdk/client-sns';

// In-app management of the scheduled-diagnosis mailing list (v1 report-scheduler parity). The worker
// publishes scheduled report summaries to one dedicated SNS topic; this manages its email subscriptions.
// Governed external-comms write (ADR-040/041), scoped by IAM to the single topic ARN — NOT AWS-resource
// mutation. The topic ARN is injected by Terraform (gated on diagnosis_notify_enabled); absent → disabled.
const REGION = process.env.AWS_REGION || 'ap-northeast-2';

export function topicArn(): string | null {
  return process.env.DIAGNOSIS_SNS_TOPIC_ARN || null;
}

let client: SNSClient | null = null;
function sns(): SNSClient {
  return (client ??= new SNSClient({ region: REGION }));
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
export function isValidEmail(e: unknown): e is string {
  return typeof e === 'string' && e.length <= 254 && EMAIL_RE.test(e);
}

export interface Subscriber {
  email: string;
  status: 'Confirmed' | 'PendingConfirmation';
  // null when pending (a pending sub has no real ARN yet → cannot be unsubscribed via the API).
  subscriptionArn: string | null;
}

export async function listSubscribers(arn: string): Promise<Subscriber[]> {
  const out: Subscriber[] = [];
  let token: string | undefined;
  do {
    const r = await sns().send(new ListSubscriptionsByTopicCommand({ TopicArn: arn, NextToken: token }));
    for (const s of r.Subscriptions ?? []) {
      if (s.Protocol !== 'email') continue;
      // A pending subscription's SubscriptionArn is the literal "PendingConfirmation".
      const pending = !s.SubscriptionArn || s.SubscriptionArn === 'PendingConfirmation';
      out.push({
        email: s.Endpoint ?? '',
        status: pending ? 'PendingConfirmation' : 'Confirmed',
        subscriptionArn: pending ? null : (s.SubscriptionArn as string),
      });
    }
    token = r.NextToken;
  } while (token);
  return out;
}

export async function subscribeEmail(arn: string, email: string): Promise<void> {
  // SNS sends a confirmation email; the address is not on the list until the recipient confirms.
  await sns().send(
    new SubscribeCommand({ TopicArn: arn, Protocol: 'email', Endpoint: email, ReturnSubscriptionArn: true }),
  );
}

export async function unsubscribe(subscriptionArn: string): Promise<void> {
  await sns().send(new UnsubscribeCommand({ SubscriptionArn: subscriptionArn }));
}

/** Admin-triggered test message (gap L53) so a subscriber can verify delivery after confirming.
 *  Subject MUST stay ASCII — SNS rejects non-ASCII subjects (same constraint as the worker's
 *  notify.py _SUBJECT). Errors propagate — the route surfaces them (never a silent success). */
export async function publishTest(arn: string): Promise<string | undefined> {
  const at = new Date().toLocaleString('ko-KR', { timeZone: 'Asia/Seoul' });
  // The triggering admin's identity deliberately stays OUT of the body (it would broadcast an
  // email address to every subscriber) — the server log on the route carries the audit trail.
  const body = [
    'AWSops 진단 알림 테스트 메시지입니다. 이 메일이 도착했다면 구독이 정상 동작합니다.',
    'This is a test message from AWSops diagnosis notifications. Receiving it confirms your subscription works.',
    '',
    'Triggered by: an AWSops administrator',
    `At: ${at} (KST)`,
  ].join('\n');
  const r = await sns().send(new PublishCommand({
    TopicArn: arn, Subject: '[AWSops] Test Notification', Message: body,
  }));
  return r.MessageId;
}

/** A subscription ARN must belong to OUR topic: `${topicArn}:${uuid}`. Guards against unsubscribing
 *  an arbitrary ARN of some other topic. */
export function belongsToTopic(subscriptionArn: string, arn: string): boolean {
  return typeof subscriptionArn === 'string' && subscriptionArn.startsWith(arn + ':');
}
