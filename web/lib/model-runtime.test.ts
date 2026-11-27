import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BedrockRuntimeClient, ConverseCommand, ConverseStreamCommand, InvokeModelCommand } from '@aws-sdk/client-bedrock-runtime';
import { SecretsManagerClient } from '@aws-sdk/client-secrets-manager';

const ENV = { ...process.env };

async function load() {
  vi.resetModules();
  return import('./model-runtime');
}

function sse(events: unknown[]): Response {
  const text = events.map((e) => `event: x\ndata: ${JSON.stringify(e)}\n\n`).join('');
  return new Response(new TextEncoder().encode(text), { status: 200 });
}

describe('model runtime client', () => {
  beforeEach(() => {
    process.env = { ...ENV };
    vi.restoreAllMocks();
  });
  afterEach(() => { process.env = { ...ENV }; vi.unstubAllGlobals(); });

  it('mixed (default) returns the plain Bedrock client', async () => {
    delete process.env.MODEL_PROVIDER;
    const { modelRuntimeClient, modelProvider } = await load();
    expect(modelProvider()).toBe('mixed');
    expect(modelRuntimeClient({ region: 'ap-northeast-2' })).toBeInstanceOf(BedrockRuntimeClient);
  });

  it('unknown values fall back to mixed', async () => {
    process.env.MODEL_PROVIDER = 'gpt-everything';
    const { modelProvider } = await load();
    expect(modelProvider()).toBe('mixed');
  });

  it('bedrock_openai converts an Anthropic InvokeModel body to Converse for openai models', async () => {
    process.env.MODEL_PROVIDER = 'bedrock_openai';
    const send = vi.spyOn(BedrockRuntimeClient.prototype, 'send').mockImplementation(async (command: unknown) => {
      expect(command).toBeInstanceOf(ConverseCommand);
      const input = (command as ConverseCommand).input;
      expect(input.modelId).toBe('global.openai.gpt-6.1-terra');
      expect(input.inferenceConfig?.maxTokens).toBe(300);
      expect(input.system).toEqual([{ text: 'sys' }]);
      expect(input.messages).toEqual([{ role: 'user', content: [{ text: 'hi' }] }]);
      return { output: { message: { role: 'assistant', content: [{ text: 'SELECT 1' }] } }, stopReason: 'end_turn', usage: { inputTokens: 3, outputTokens: 2 } };
    });
    const { modelRuntimeClient } = await load();
    const res = await modelRuntimeClient({ region: 'ap-northeast-2' }).send(new InvokeModelCommand({
      modelId: 'global.openai.gpt-6.1-terra', contentType: 'application/json',
      body: new TextEncoder().encode(JSON.stringify({ anthropic_version: 'bedrock-2023-05-31', max_tokens: 300, system: 'sys', messages: [{ role: 'user', content: 'hi' }] })),
    }));
    expect(send).toHaveBeenCalledTimes(1);
    const parsed = JSON.parse(new TextDecoder().decode(res.body));
    expect(parsed.content).toEqual([{ type: 'text', text: 'SELECT 1' }]);
    expect(parsed.stop_reason).toBe('end_turn');
  });

  it('bedrock_claude passes commands to Bedrock unchanged', async () => {
    process.env.MODEL_PROVIDER = 'bedrock_claude';
    const command = new ConverseCommand({ modelId: 'global.anthropic.claude-haiku-5-5', messages: [] });
    const send = vi.spyOn(BedrockRuntimeClient.prototype, 'send').mockResolvedValue({ ok: true } as never);
    const { modelRuntimeClient } = await load();
    await expect(modelRuntimeClient({ region: 'ap-northeast-2' }).send(command)).resolves.toEqual({ ok: true });
    expect(send.mock.calls[0][0]).toBe(command);
  });

  it('anthropic_api sends Converse to the Messages API with the secret key and maps the reply', async () => {
    process.env.MODEL_PROVIDER = 'anthropic_api';
    process.env.ANTHROPIC_API_KEY_SECRET_ARN = 'arn:aws:secretsmanager:ap-northeast-2:123456789012:secret:anthropic';
    vi.spyOn(SecretsManagerClient.prototype, 'send').mockResolvedValue({ SecretString: '{"api_key":"sk-test"}' } as never);
    const fetchMock = vi.fn(async (url: string, init: RequestInit) => {
      expect(url).toBe('https://api.anthropic.com/v1/messages');
      expect((init.headers as Record<string, string>)['x-api-key']).toBe('sk-test');
      const body = JSON.parse(String(init.body));
      expect(body).toEqual({
        model: 'claude-haiku-5-5', max_tokens: 64, system: 'route',
        messages: [{ role: 'user', content: [{ type: 'text', text: 'q' }] }],
        thinking: { type: 'disabled' },
      });
      return new Response(JSON.stringify({ content: [{ type: 'text', text: 'ops' }], stop_reason: 'end_turn', usage: { input_tokens: 5, output_tokens: 1 } }), { status: 200 });
    });
    vi.stubGlobal('fetch', fetchMock);
    const { modelRuntimeClient } = await load();
    const out = await modelRuntimeClient({ region: 'x' }).send(new ConverseCommand({
      modelId: 'claude-haiku-5-5', system: [{ text: 'route' }, { cachePoint: { type: 'default' } }],
      messages: [{ role: 'user', content: [{ text: 'q' }] }], inferenceConfig: { maxTokens: 64 },
      additionalModelRequestFields: { thinking: { type: 'disabled' } },
    }));
    expect(out.output?.message?.content).toEqual([{ text: 'ops' }]);
    expect(out.stopReason).toBe('end_turn');
    expect(out.usage).toMatchObject({ inputTokens: 5, outputTokens: 1 });
  });

  it('anthropic_api streams text deltas, stop reason and usage in the Converse event shape', async () => {
    process.env.MODEL_PROVIDER = 'anthropic_api';
    process.env.ANTHROPIC_API_KEY_SECRET_ARN = 'arn:aws:secretsmanager:ap-northeast-2:123456789012:secret:anthropic';
    vi.spyOn(SecretsManagerClient.prototype, 'send').mockResolvedValue({ SecretString: 'sk-plain' } as never);
    vi.stubGlobal('fetch', vi.fn(async (_url: string, init: RequestInit) => {
      expect(JSON.parse(String(init.body)).stream).toBe(true);
      return sse([
        { type: 'message_start', message: { usage: { input_tokens: 7 } } },
        { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'hidden' } },
        { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Hel' } },
        { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'lo' } },
        { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 2 } },
        { type: 'message_stop' },
      ]);
    }));
    const { modelRuntimeClient } = await load();
    const res = await modelRuntimeClient({ region: 'x' }).send(new ConverseStreamCommand({
      modelId: 'claude-sonnet-5-5', messages: [{ role: 'user', content: [{ text: 'q' }] }],
    }));
    let text = '';
    const usage: unknown[] = [];
    for await (const ev of res.stream ?? []) {
      text += ev.contentBlockDelta?.delta?.text ?? '';
      if (ev.metadata?.usage) usage.push(ev.metadata.usage);
    }
    expect(text).toBe('Hello');
    expect(usage).toEqual([{ inputTokens: 7, outputTokens: 2, totalTokens: 9 }]);
  });

  it('anthropic_api stream tolerates CRLF framing, bad frames and a final frame without a blank line', async () => {
    process.env.MODEL_PROVIDER = 'anthropic_api';
    process.env.ANTHROPIC_API_KEY_SECRET_ARN = 'arn:aws:secretsmanager:ap-northeast-2:123456789012:secret:anthropic';
    vi.spyOn(SecretsManagerClient.prototype, 'send').mockResolvedValue({ SecretString: 'sk-plain' } as never);
    const body = ['data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Hi"}}',
      'data: {not json', 'data: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":1}}'].join('\r\n\r\n');
    vi.stubGlobal('fetch', vi.fn(async () => new Response(new TextEncoder().encode(body), { status: 200 })));
    const { modelRuntimeClient } = await load();
    const res = await modelRuntimeClient({ region: 'x' }).send(new ConverseStreamCommand({ modelId: 'claude-sonnet-5-5', messages: [] }));
    const seen: string[] = [];
    for await (const ev of res.stream ?? []) {
      if (ev.contentBlockDelta) seen.push(ev.contentBlockDelta.delta?.text ?? '');
      if (ev.messageStop) seen.push(`stop:${ev.messageStop.stopReason}`);
    }
    expect(seen).toEqual(['Hi', 'stop:end_turn']);
  });

  it('anthropic_api retries throttling and network errors, then succeeds', async () => {
    process.env.MODEL_PROVIDER = 'anthropic_api';
    process.env.ANTHROPIC_API_KEY_SECRET_ARN = 'arn:aws:secretsmanager:ap-northeast-2:123456789012:secret:anthropic';
    vi.spyOn(SecretsManagerClient.prototype, 'send').mockResolvedValue({ SecretString: 'sk' } as never);
    let calls = 0;
    vi.stubGlobal('fetch', vi.fn(async () => {
      calls += 1;
      if (calls === 1) return new Response('{}', { status: 429, headers: { 'retry-after': '0' } });
      if (calls === 2) throw new TypeError('fetch failed');
      return new Response(JSON.stringify({ content: [{ type: 'text', text: 'ok' }], stop_reason: 'end_turn', usage: { input_tokens: 1, output_tokens: 1 } }), { status: 200 });
    }));
    vi.useFakeTimers();
    try {
      const { modelRuntimeClient } = await load();
      const pending = modelRuntimeClient({ region: 'x' }).send(new ConverseCommand({ modelId: 'claude-haiku-5-5', messages: [] }));
      await vi.runAllTimersAsync();
      const out = await pending;
      expect(out.output?.message?.content?.[0]?.text).toBe('ok');
      expect(calls).toBe(3);
    } finally { vi.useRealTimers(); }
  });

  it('reads the Anthropic API key from the secret ARN region, not the task region', async () => {
    process.env.MODEL_PROVIDER = 'anthropic_api';
    process.env.ANTHROPIC_API_KEY_SECRET_ARN = 'arn:aws:secretsmanager:us-east-1:123456789012:secret:anthropic-AbC';
    let region: unknown;
    vi.spyOn(SecretsManagerClient.prototype, 'send').mockImplementation(async function (this: SecretsManagerClient) {
      region = await this.config.region();
      return { SecretString: 'sk' } as never;
    });
    const { anthropicApiKey, secretRegion } = await load();
    expect(await anthropicApiKey()).toBe('sk');
    expect(region).toBe('us-east-1');
    expect(secretRegion('not-an-arn')).toBeUndefined();
  });

  it('anthropic_api requests never follow redirects (the key must not reach another host)', async () => {
    process.env.MODEL_PROVIDER = 'anthropic_api';
    process.env.ANTHROPIC_API_KEY_SECRET_ARN = 'arn:aws:secretsmanager:ap-northeast-2:123456789012:secret:anthropic';
    vi.spyOn(SecretsManagerClient.prototype, 'send').mockResolvedValue({ SecretString: 'sk' } as never);
    const seen: RequestInit[] = [];
    vi.stubGlobal('fetch', vi.fn(async (_u: string, init: RequestInit) => {
      seen.push(init);
      return new Response(JSON.stringify({ content: [{ type: 'text', text: 'ok' }], stop_reason: 'end_turn', usage: { input_tokens: 1, output_tokens: 1 } }), { status: 200 });
    }));
    const { modelRuntimeClient } = await load();
    await modelRuntimeClient({ region: 'x' }).send(new ConverseCommand({ modelId: 'claude-haiku-5-5', messages: [] }));
    expect(seen[0].redirect).toBe('error');
  });

  it('anthropic_api stream that ends without a terminal event is an error, not a complete answer', async () => {
    process.env.MODEL_PROVIDER = 'anthropic_api';
    process.env.ANTHROPIC_API_KEY_SECRET_ARN = 'arn:aws:secretsmanager:ap-northeast-2:123456789012:secret:anthropic';
    vi.spyOn(SecretsManagerClient.prototype, 'send').mockResolvedValue({ SecretString: 'sk' } as never);
    vi.stubGlobal('fetch', vi.fn(async () => sse([{ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'part' } }])));
    const { modelRuntimeClient } = await load();
    const res = await modelRuntimeClient({ region: 'x' }).send(new ConverseStreamCommand({ modelId: 'claude-sonnet-5-5', messages: [] }));
    const read = async () => { for await (const _ of res.stream ?? []) { /* drain */ } };
    await expect(read()).rejects.toThrow('anthropic_api_stream_truncated');
  });

  it('anthropic_api errors carry only status and error type, never the key', async () => {
    process.env.MODEL_PROVIDER = 'anthropic_api';
    process.env.ANTHROPIC_API_KEY_SECRET_ARN = 'arn:aws:secretsmanager:ap-northeast-2:123456789012:secret:anthropic';
    vi.spyOn(SecretsManagerClient.prototype, 'send').mockResolvedValue({ SecretString: 'sk-secret-value' } as never);
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ error: { type: 'authentication_error', message: 'bad key sk-secret-value' } }), { status: 401 })));
    const { modelRuntimeClient } = await load();
    const error = await modelRuntimeClient({ region: 'x' }).send(new ConverseCommand({ modelId: 'claude-haiku-5-5', messages: [] })).catch((e: Error) => e);
    expect((error as Error).message).toBe('anthropic_api_error:401:authentication_error');
  });

  it('anthropic_api refetches a rotated key once after a 401', async () => {
    process.env.MODEL_PROVIDER = 'anthropic_api';
    process.env.ANTHROPIC_API_KEY_SECRET_ARN = 'arn:aws:secretsmanager:ap-northeast-2:123456789012:secret:anthropic';
    vi.spyOn(SecretsManagerClient.prototype, 'send')
      .mockResolvedValueOnce({ SecretString: 'sk-old' } as never)
      .mockResolvedValueOnce({ SecretString: 'sk-new' } as never);
    const keys: string[] = [];
    vi.stubGlobal('fetch', vi.fn(async (_url: string, init: RequestInit) => {
      keys.push((init.headers as Record<string, string>)['x-api-key']);
      return keys.length === 1
        ? new Response(JSON.stringify({ error: { type: 'authentication_error' } }), { status: 401 })
        : new Response(JSON.stringify({ content: [{ type: 'text', text: 'ok' }], stop_reason: 'end_turn', usage: { input_tokens: 1, output_tokens: 1 } }), { status: 200 });
    }));
    const { modelRuntimeClient } = await load();
    await modelRuntimeClient({ region: 'x' }).send(new ConverseCommand({ modelId: 'claude-haiku-5-5', messages: [] }));
    expect(keys).toEqual(['sk-old', 'sk-new']);
  });

  it('anthropic_api without a configured secret fails closed', async () => {
    process.env.MODEL_PROVIDER = 'anthropic_api';
    delete process.env.ANTHROPIC_API_KEY_SECRET_ARN;
    vi.stubGlobal('fetch', vi.fn());
    const { modelRuntimeClient } = await load();
    await expect(modelRuntimeClient({ region: 'x' }).send(new ConverseCommand({ modelId: 'claude-haiku-5-5', messages: [] })))
      .rejects.toThrow('anthropic_api_key_unconfigured');
  });
});
