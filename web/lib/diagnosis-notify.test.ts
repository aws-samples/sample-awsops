import { describe, it, expect, vi, beforeEach } from 'vitest';

const sends: unknown[] = [];
let responses: unknown[] = [];

vi.mock('@aws-sdk/client-sns', () => ({
  SNSClient: class {
    async send(cmd: unknown) {
      sends.push(cmd);
      return responses.shift();
    }
  },
  ListSubscriptionsByTopicCommand: class {
    constructor(public input: Record<string, unknown>) {}
  },
  SubscribeCommand: class {
    constructor(public input: Record<string, unknown>) {}
  },
  UnsubscribeCommand: class {
    constructor(public input: Record<string, unknown>) {}
  },
}));

import {
  isValidEmail,
  belongsToTopic,
  listSubscribers,
  subscribeEmail,
  unsubscribe,
} from './diagnosis-notify';

const ARN = 'arn:aws:sns:ap-northeast-2:1:awsops-v2-diagnosis-notifications';

beforeEach(() => {
  sends.length = 0;
  responses = [];
});

describe('isValidEmail', () => {
  it('accepts a normal address, rejects garbage and overlong', () => {
    expect(isValidEmail('a@b.io')).toBe(true);
    expect(isValidEmail('nope')).toBe(false);
    expect(isValidEmail('a b@c.io')).toBe(false);
    expect(isValidEmail(123)).toBe(false);
    expect(isValidEmail('x'.repeat(250) + '@b.io')).toBe(false);
  });
});

describe('belongsToTopic', () => {
  it('only matches subscription ARNs under the topic', () => {
    expect(belongsToTopic(ARN + ':uuid', ARN)).toBe(true);
    expect(belongsToTopic('arn:aws:sns:x:1:other:uuid', ARN)).toBe(false);
    expect(belongsToTopic(ARN, ARN)).toBe(false); // the topic ARN itself is not a subscription
  });
});

describe('listSubscribers', () => {
  it('paginates, drops non-email protocols, marks pending vs confirmed', async () => {
    responses = [
      {
        Subscriptions: [
          { Protocol: 'email', Endpoint: 'ok@x.io', SubscriptionArn: ARN + ':c1' },
          { Protocol: 'sqs', Endpoint: 'arn:...:q', SubscriptionArn: ARN + ':q1' }, // dropped
          { Protocol: 'email', Endpoint: 'wait@x.io', SubscriptionArn: 'PendingConfirmation' },
        ],
        NextToken: 'tok',
      },
      {
        Subscriptions: [{ Protocol: 'email', Endpoint: 'p2@x.io', SubscriptionArn: undefined }],
      },
    ];
    const subs = await listSubscribers(ARN);
    expect(subs).toEqual([
      { email: 'ok@x.io', status: 'Confirmed', subscriptionArn: ARN + ':c1' },
      { email: 'wait@x.io', status: 'PendingConfirmation', subscriptionArn: null },
      { email: 'p2@x.io', status: 'PendingConfirmation', subscriptionArn: null },
    ]);
    expect(sends.length).toBe(2); // followed NextToken
  });
});

describe('subscribe / unsubscribe pass the right input', () => {
  it('subscribeEmail uses email protocol', async () => {
    responses = [{}];
    await subscribeEmail(ARN, 'new@x.io');
    expect((sends[0] as { input: Record<string, unknown> }).input).toMatchObject({
      TopicArn: ARN,
      Protocol: 'email',
      Endpoint: 'new@x.io',
    });
  });

  it('unsubscribe passes the subscription ARN', async () => {
    responses = [{}];
    await unsubscribe(ARN + ':c1');
    expect((sends[0] as { input: Record<string, unknown> }).input).toMatchObject({
      SubscriptionArn: ARN + ':c1',
    });
  });
});
