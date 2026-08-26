import { describe, it, expect, vi, beforeEach } from 'vitest';

const ssmSend = vi.fn();
const acSend = vi.fn();
vi.mock('@aws-sdk/client-ssm', () => ({
  SSMClient: class { send = ssmSend; },
  GetParameterCommand: class { constructor(public input: unknown) {} },
}));
vi.mock('@aws-sdk/client-bedrock-agentcore', () => ({
  BedrockAgentCoreClient: class { send = acSend; },
  InvokeAgentRuntimeCommand: class { constructor(public input: unknown) {} },
}));

beforeEach(() => {
  ssmSend.mockReset();
  acSend.mockReset();
  process.env.SSM_RUNTIME_ARN_PARAM = '/ops/awsops-v2/agentcore/runtime_arn';
});

function streamOf(s: string) {
  return { transformToString: async () => s };
}

/** Mock an SSE (text/event-stream) runtime response. Each frame is a `data: <payload>` line;
 *  `splitAt` lets a test slice the byte stream mid-frame to exercise the line buffer. */
function eventStreamOf(frames: string[], splitAt?: number) {
  const enc = new TextEncoder();
  const bytes = enc.encode(frames.map((f) => `data: ${f}\n\n`).join(''));
  const chunks = splitAt != null ? [bytes.slice(0, splitAt), bytes.slice(splitAt)] : [bytes];
  return {
    contentType: 'text/event-stream',
    response: {
      transformToWebStream: () =>
        new ReadableStream<Uint8Array>({
          start(c) {
            for (const ch of chunks) c.enqueue(ch);
            c.close();
          },
        }),
    },
  };
}

describe('agentcore', () => {
  it('caches the runtime ARN (SSM hit once)', async () => {
    vi.resetModules();
    ssmSend.mockResolvedValue({ Parameter: { Value: 'arn:rt' } });
    const { getRuntimeArn } = await import('./agentcore');
    expect(await getRuntimeArn()).toBe('arn:rt');
    expect(await getRuntimeArn()).toBe('arn:rt');
    expect(ssmSend).toHaveBeenCalledTimes(1);
  });
  it('invokes and returns the agent text', async () => {
    vi.resetModules();
    ssmSend.mockResolvedValue({ Parameter: { Value: 'arn:rt' } });
    acSend.mockResolvedValue({ response: streamOf(JSON.stringify('이번 달 비용은 $4,210입니다')) });
    const { invokeAgent } = await import('./agentcore');
    const text = await invokeAgent({ gateway: 'cost', messages: [{ role: 'user', content: 'hi' }], sessionId: 's'.repeat(36) });
    expect(text).toContain('$4,210');
  });
  it('retries once on transient failure', async () => {
    vi.resetModules();
    ssmSend.mockResolvedValue({ Parameter: { Value: 'arn:rt' } });
    acSend.mockRejectedValueOnce(new Error('throttle')).mockResolvedValueOnce({ response: streamOf('"ok"') });
    const { invokeAgent } = await import('./agentcore');
    const text = await invokeAgent({ gateway: 'ops', messages: [{ role: 'user', content: 'x' }], sessionId: 's'.repeat(36) });
    expect(text).toBe('ok');
    expect(acSend).toHaveBeenCalledTimes(2);
  });
  it('includes systemPromptOverride + traceability in the payload when present', async () => {
    vi.resetModules();
    ssmSend.mockResolvedValue({ Parameter: { Value: 'arn:rt' } });
    acSend.mockResolvedValue({ response: streamOf('"ok"') });
    const { invokeAgent } = await import('./agentcore');
    await invokeAgent({
      gateway: 'security', messages: [{ role: 'user', content: 'hi' }], sessionId: 's'.repeat(36),
      systemPromptOverride: 'OVERRIDE', toolAllowlist: ['t1'], agentName: 'compliance', agentVersion: 3, skillHashes: ['h1'],
    });
    const cmd = acSend.mock.calls[0][0] as { input: { payload: Uint8Array } };
    const sent = JSON.parse(new TextDecoder().decode(cmd.input.payload));
    expect(sent.systemPromptOverride).toBe('OVERRIDE');
    expect(sent.toolAllowlist).toEqual(['t1']);
    expect(sent.agentName).toBe('compliance');
    expect(sent.agentVersion).toBe(3);
    expect(sent.skillHashes).toEqual(['h1']);
  });
  it('threads accountId + accountAlias into the payload when present, omits them otherwise', async () => {
    vi.resetModules();
    ssmSend.mockResolvedValue({ Parameter: { Value: 'arn:rt' } });
    acSend.mockResolvedValue({ response: streamOf('"ok"') });
    const { invokeAgent } = await import('./agentcore');
    await invokeAgent({
      gateway: 'cost', messages: [{ role: 'user', content: 'hi' }], sessionId: 's'.repeat(36),
      accountId: '123456789012', accountAlias: 'prod',
    });
    const withAcct = JSON.parse(new TextDecoder().decode((acSend.mock.calls[0][0] as { input: { payload: Uint8Array } }).input.payload));
    expect(withAcct.accountId).toBe('123456789012');
    expect(withAcct.accountAlias).toBe('prod');

    acSend.mockClear();
    await invokeAgent({ gateway: 'cost', messages: [{ role: 'user', content: 'hi' }], sessionId: 's'.repeat(36) });
    const without = JSON.parse(new TextDecoder().decode((acSend.mock.calls[0][0] as { input: { payload: Uint8Array } }).input.payload));
    expect('accountId' in without).toBe(false);
    expect('accountAlias' in without).toBe(false);
  });

  it('ADR-039: threads integrations into the payload when non-empty, omits otherwise', async () => {
    vi.resetModules();
    ssmSend.mockResolvedValue({ Parameter: { Value: 'arn:rt' } });
    acSend.mockResolvedValue({ response: streamOf('"ok"') });
    const { invokeAgent } = await import('./agentcore');
    const integrations = [{ name: 'dd', endpoint: 'https://x/mcp', transport: 'api_key', credentialsRef: 'arn:sec', exposedTools: ['datadog_query'], allowPrivate: false }];
    await invokeAgent({ gateway: 'security', messages: [{ role: 'user', content: 'hi' }], sessionId: 's'.repeat(36), integrations });
    const withI = JSON.parse(new TextDecoder().decode((acSend.mock.calls[0][0] as { input: { payload: Uint8Array } }).input.payload));
    expect(withI.integrations).toEqual(integrations);

    acSend.mockClear();
    await invokeAgent({ gateway: 'security', messages: [{ role: 'user', content: 'hi' }], sessionId: 's'.repeat(36), integrations: [] });
    const empty = JSON.parse(new TextDecoder().decode((acSend.mock.calls[0][0] as { input: { payload: Uint8Array } }).input.payload));
    expect('integrations' in empty).toBe(false);

    acSend.mockClear();
    await invokeAgent({ gateway: 'security', messages: [{ role: 'user', content: 'hi' }], sessionId: 's'.repeat(36) });
    const none = JSON.parse(new TextDecoder().decode((acSend.mock.calls[0][0] as { input: { payload: Uint8Array } }).input.payload));
    expect('integrations' in none).toBe(false);
  });

  // --- real streaming (SSE) ---
  it('invokeAgentStream yields SSE deltas incrementally', async () => {
    vi.resetModules();
    ssmSend.mockResolvedValue({ Parameter: { Value: 'arn:rt' } });
    acSend.mockResolvedValue(eventStreamOf([
      JSON.stringify({ delta: '이번 ' }), JSON.stringify({ delta: '달 비용은 ' }), JSON.stringify({ delta: '$4,210' }),
    ]));
    const { invokeAgentStream } = await import('./agentcore');
    const out: string[] = [];
    for await (const d of invokeAgentStream({ gateway: 'cost', messages: [{ role: 'user', content: 'hi' }], sessionId: 's'.repeat(36) })) out.push(d);
    expect(out).toEqual(['이번 ', '달 비용은 ', '$4,210']);
  });

  it('invokeAgent collects SSE deltas into the full answer (buffered consumer)', async () => {
    vi.resetModules();
    ssmSend.mockResolvedValue({ Parameter: { Value: 'arn:rt' } });
    acSend.mockResolvedValue(eventStreamOf([
      JSON.stringify({ delta: 'a' }), JSON.stringify({ delta: 'b' }), JSON.stringify({ delta: 'c' }),
    ]));
    const { invokeAgent } = await import('./agentcore');
    const text = await invokeAgent({ gateway: 'cost', messages: [{ role: 'user', content: 'hi' }], sessionId: 's'.repeat(36) });
    expect(text).toBe('abc');
  });

  it('buffers SSE frames split across stream chunks', async () => {
    vi.resetModules();
    ssmSend.mockResolvedValue({ Parameter: { Value: 'arn:rt' } });
    // split mid-frame so a `data:` line spans two reads → exercises the line buffer
    acSend.mockResolvedValue(eventStreamOf([JSON.stringify({ delta: 'hello ' }), JSON.stringify({ delta: 'world' })], 9));
    const { invokeAgentStream } = await import('./agentcore');
    const out: string[] = [];
    for await (const d of invokeAgentStream({ gateway: 'ops', messages: [{ role: 'user', content: 'x' }], sessionId: 's'.repeat(36) })) out.push(d);
    expect(out.join('')).toBe('hello world');
  });

  it('tolerates a raw Strands event shape ({data}) and skips non-text frames', async () => {
    vi.resetModules();
    ssmSend.mockResolvedValue({ Parameter: { Value: 'arn:rt' } });
    acSend.mockResolvedValue(eventStreamOf([
      JSON.stringify({ data: 'hi' }),                 // raw strands event → text
      JSON.stringify({ current_tool_use: { name: 'x' } }), // non-text event → skipped
      JSON.stringify({ delta: ' there' }),
    ]));
    const { invokeAgentStream } = await import('./agentcore');
    const out: string[] = [];
    for await (const d of invokeAgentStream({ gateway: 'ops', messages: [{ role: 'user', content: 'x' }], sessionId: 's'.repeat(36) })) out.push(d);
    expect(out.join('')).toBe('hi there');
  });

  it('cancels the upstream reader when the consumer stops early (client abort)', async () => {
    vi.resetModules();
    ssmSend.mockResolvedValue({ Parameter: { Value: 'arn:rt' } });
    let cancelled = false;
    const enc = new TextEncoder();
    const frames = [JSON.stringify({ delta: 'a' }), JSON.stringify({ delta: 'b' }), JSON.stringify({ delta: 'c' })];
    acSend.mockResolvedValue({
      contentType: 'text/event-stream',
      response: {
        transformToWebStream: () =>
          new ReadableStream<Uint8Array>({
            start(c) {
              for (const f of frames) c.enqueue(enc.encode(`data: ${f}\n\n`));
              c.close();
            },
            cancel() {
              cancelled = true;
            },
          }),
      },
    });
    const { invokeAgentStream } = await import('./agentcore');
    for await (const _d of invokeAgentStream({ gateway: 'ops', messages: [{ role: 'user', content: 'x' }], sessionId: 's'.repeat(36) })) {
      break; // stop after the first delta → streamDeltas' finally must cancel the upstream body
    }
    expect(cancelled).toBe(true);
  });

  it('backward-compat: a legacy buffered JSON answer streams as one delta', async () => {
    vi.resetModules();
    ssmSend.mockResolvedValue({ Parameter: { Value: 'arn:rt' } });
    acSend.mockResolvedValue({ response: streamOf(JSON.stringify('legacy answer')) }); // no contentType
    const { invokeAgentStream } = await import('./agentcore');
    const out: string[] = [];
    for await (const d of invokeAgentStream({ gateway: 'ops', messages: [{ role: 'user', content: 'x' }], sessionId: 's'.repeat(36) })) out.push(d);
    expect(out).toEqual(['legacy answer']);
  });

  // --- real streaming + provenance (invokeAgentStreamDetailed) ---
  it('invokeAgentStreamDetailed yields delta/tool/model events live, in arrival order', async () => {
    vi.resetModules();
    ssmSend.mockResolvedValue({ Parameter: { Value: 'arn:rt' } });
    acSend.mockResolvedValue(eventStreamOf([
      JSON.stringify({ model: 'sonnet-4-6' }),
      JSON.stringify({ delta: '이번 ' }),
      JSON.stringify({ tool: 'get_cost' }),
      JSON.stringify({ delta: '달 비용은 $4,210' }),
    ]));
    const { invokeAgentStreamDetailed } = await import('./agentcore');
    const events: unknown[] = [];
    for await (const ev of invokeAgentStreamDetailed({ gateway: 'cost', messages: [{ role: 'user', content: 'hi' }], sessionId: 's'.repeat(36) })) events.push(ev);
    expect(events).toEqual([
      { model: 'sonnet-4-6' },
      { delta: '이번 ' },
      { tool: 'get_cost' },
      { delta: '달 비용은 $4,210' },
    ]);
  });

  it('invokeAgentStreamDetailed keeps frame boundaries intact when split mid-frame', async () => {
    vi.resetModules();
    ssmSend.mockResolvedValue({ Parameter: { Value: 'arn:rt' } });
    acSend.mockResolvedValue(eventStreamOf([JSON.stringify({ delta: 'hello ' }), JSON.stringify({ delta: 'world' })], 9));
    const { invokeAgentStreamDetailed } = await import('./agentcore');
    const deltas: string[] = [];
    for await (const ev of invokeAgentStreamDetailed({ gateway: 'ops', messages: [{ role: 'user', content: 'x' }], sessionId: 's'.repeat(36) })) {
      if (ev.delta) deltas.push(ev.delta);
    }
    // Two distinct events, not one coalesced string — a mid-byte split must not merge the frames.
    expect(deltas).toEqual(['hello ', 'world']);
  });

  it('invokeAgentStreamDetailed backward-compat: a legacy buffered JSON answer yields one delta event', async () => {
    vi.resetModules();
    ssmSend.mockResolvedValue({ Parameter: { Value: 'arn:rt' } });
    acSend.mockResolvedValue({ response: streamOf(JSON.stringify('legacy answer')) }); // no contentType
    const { invokeAgentStreamDetailed } = await import('./agentcore');
    const events: unknown[] = [];
    for await (const ev of invokeAgentStreamDetailed({ gateway: 'ops', messages: [{ role: 'user', content: 'x' }], sessionId: 's'.repeat(36) })) events.push(ev);
    expect(events).toEqual([{ delta: 'legacy answer' }]);
  });
});
