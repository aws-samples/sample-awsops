import { describe, it, expect, vi, beforeEach } from 'vitest';

let insertParams: unknown[] = [];
const sqsBodies: string[] = [];

vi.mock('@/lib/db', () => ({
  getPool: () => ({
    query: async (_sql: string, params: unknown[]) => {
      insertParams = params;
      return { rows: [{ job_id: params[0] }] }; // inserted (not a conflict)
    },
  }),
}));

vi.mock('@aws-sdk/client-sqs', () => ({
  SQSClient: class {
    async send(cmd: { input: { MessageBody: string } }) {
      sqsBodies.push(cmd.input.MessageBody);
    }
  },
  SendMessageCommand: class {
    constructor(public input: { MessageBody: string }) {}
  },
}));

import { enqueueJob } from './jobs';

beforeEach(() => {
  insertParams = [];
  sqsBodies.length = 0;
  process.env.JOBS_QUEUE_URL = 'https://sqs.local/q';
  process.env.AWS_REGION = 'ap-northeast-2';
});

describe('enqueueJob — scheduler-provenance hardening', () => {
  it('strips client-supplied `scheduled` from BOTH the ledger row and the SQS message', async () => {
    await enqueueJob('report', { tier: 'mid', scheduled: true, report_id: 7 }, { jobId: 'j1' });

    // worker_jobs INSERT payload is params[2] (job_id, type, payload::jsonb, ...)
    const persisted = JSON.parse(insertParams[2] as string);
    expect(persisted.scheduled).toBeUndefined();
    expect(persisted).toMatchObject({ tier: 'mid', report_id: 7 }); // other fields preserved

    const sqs = JSON.parse(sqsBodies[0]);
    expect(sqs.payload.scheduled).toBeUndefined(); // the worker reads this → must not be forgeable
    expect(sqs.payload).toMatchObject({ tier: 'mid', report_id: 7 });
  });

  it('leaves payloads without `scheduled` unchanged', async () => {
    await enqueueJob('report', { tier: 'deep' }, { jobId: 'j2' });
    expect(JSON.parse(insertParams[2] as string)).toEqual({ tier: 'deep' });
  });
});
