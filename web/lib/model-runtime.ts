// Model client selected by the deploy-time MODEL_PROVIDER (Terraform var.model_provider, models.tf).
// Call sites keep their Bedrock command shapes and only swap `new BedrockRuntimeClient(...)` for
// `modelRuntimeClient(...)`:
// - mixed (default): the plain BedrockRuntimeClient, unchanged.
// - bedrock_claude / bedrock_openai: Bedrock, plus an Anthropic-format InvokeModel body sent to an
//   `openai.*` model is converted to Converse and its reply returned in the Anthropic shape.
// - anthropic_api: Converse, ConverseStream and Anthropic-format InvokeModel go to the Anthropic
//   Messages API with the key read from ANTHROPIC_API_KEY_SECRET_ARN. The key is never logged.
import {
  BedrockRuntimeClient, ConverseCommand, ConverseStreamCommand, InvokeModelCommand,
  type ConverseCommandInput, type ConverseCommandOutput, type ConverseStreamCommandOutput,
  type ConverseStreamOutput, type InvokeModelCommandOutput,
} from '@aws-sdk/client-bedrock-runtime';
import { GetSecretValueCommand, SecretsManagerClient } from '@aws-sdk/client-secrets-manager';

export type ModelProvider = 'mixed' | 'bedrock_claude' | 'bedrock_openai' | 'anthropic_api';
type SendOptions = { abortSignal?: AbortSignal };

export interface ModelRuntimeClient {
  send(command: ConverseCommand, options?: SendOptions): Promise<ConverseCommandOutput>;
  send(command: ConverseStreamCommand, options?: SendOptions): Promise<ConverseStreamCommandOutput>;
  send(command: InvokeModelCommand, options?: SendOptions): Promise<InvokeModelCommandOutput>;
}

export const ANTHROPIC_URL = 'https://api.anthropic.com/v1/messages';
const ANTHROPIC_VERSION = '2023-06-01';

export function modelProvider(): ModelProvider {
  const value = process.env.MODEL_PROVIDER?.trim();
  return value === 'bedrock_claude' || value === 'bedrock_openai' || value === 'anthropic_api' ? value : 'mixed';
}

export function modelRuntimeClient(config: { region: string }): ModelRuntimeClient {
  const provider = modelProvider();
  if (provider === 'anthropic_api') return new AnthropicApiClient();
  const bedrock = new BedrockRuntimeClient(config);
  return provider === 'mixed' ? bedrock as unknown as ModelRuntimeClient : new BedrockFamilyClient(bedrock);
}

type Json = Record<string, unknown>;
type TextBlock = { text?: string };
type AnthropicStreamEvent = {
  type?: string; index?: number; delta?: { type?: string; text?: string; stop_reason?: string };
  message?: AnthropicReply; usage?: { output_tokens?: number };
};

let apiKey: Promise<string> | null = null;
/** Forget the cached key (401 from the API, or tests). */
export function resetAnthropicApiKey(): void { apiKey = null; }
/** Anthropic API key from Secrets Manager: a plain string or JSON `{ "api_key": ... }`. */
export function anthropicApiKey(): Promise<string> {
  if (!apiKey) {
    apiKey = (async () => {
      const arn = process.env.ANTHROPIC_API_KEY_SECRET_ARN?.trim();
      if (!arn) throw new Error('anthropic_api_key_unconfigured');
      const out = await new SecretsManagerClient({}).send(new GetSecretValueCommand({ SecretId: arn }));
      const raw = (out.SecretString ?? '').trim();
      let key: unknown = raw;
      try { const parsed = JSON.parse(raw) as unknown; key = typeof parsed === 'object' && parsed ? (parsed as Json).api_key : parsed; } catch { /* plain string */ }
      if (typeof key !== 'string' || !key) throw new Error('anthropic_api_key_invalid');
      return key;
    })();
    apiKey.catch(() => { apiKey = null; });
  }
  return apiKey;
}

/** Bedrock Converse input -> Anthropic Messages body (text blocks; cache points dropped). */
export function converseToAnthropicBody(input: ConverseCommandInput): Json {
  const text = (blocks: unknown) => ((blocks as TextBlock[] | undefined) ?? [])
    .filter((b) => typeof b?.text === 'string').map((b) => ({ type: 'text', text: b.text as string }));
  const body: Json = {
    model: input.modelId,
    max_tokens: input.inferenceConfig?.maxTokens ?? 1024,
    messages: (input.messages ?? []).map((m) => ({ role: m.role, content: text(m.content) })),
  };
  const system = ((input.system ?? []) as TextBlock[]).filter((b) => typeof b.text === 'string').map((b) => b.text);
  if (system.length) body.system = system.join('\n\n');
  const cfg = input.inferenceConfig ?? {};
  if (cfg.temperature !== undefined) body.temperature = cfg.temperature;
  if (cfg.topP !== undefined) body.top_p = cfg.topP;
  if (cfg.stopSequences?.length) body.stop_sequences = cfg.stopSequences;
  Object.assign(body, (input.additionalModelRequestFields ?? {}) as Json);
  return body;
}

type AnthropicReply = {
  content?: { type?: string; text?: string }[];
  stop_reason?: string;
  usage?: { input_tokens?: number; output_tokens?: number; cache_read_input_tokens?: number; cache_creation_input_tokens?: number };
};

function converseOutput(reply: AnthropicReply): ConverseCommandOutput {
  const u = reply.usage ?? {};
  return {
    output: { message: { role: 'assistant', content: (reply.content ?? []).filter((b) => b.type === 'text').map((b) => ({ text: b.text ?? '' })) } },
    stopReason: reply.stop_reason as ConverseCommandOutput['stopReason'],
    usage: { inputTokens: u.input_tokens ?? 0, outputTokens: u.output_tokens ?? 0, totalTokens: (u.input_tokens ?? 0) + (u.output_tokens ?? 0) },
    metrics: { latencyMs: 0 },
    $metadata: { httpStatusCode: 200 },
  };
}

function encodeBody(value: unknown): InvokeModelCommandOutput {
  return { body: new TextEncoder().encode(JSON.stringify(value)) as InvokeModelCommandOutput['body'], contentType: 'application/json', $metadata: { httpStatusCode: 200 } };
}

/** Anthropic Messages body -> Converse input (used for `openai.*` models on Bedrock). */
export function anthropicBodyToConverse(modelId: string, body: Json): ConverseCommandInput {
  const blocks = (content: unknown) => typeof content === 'string'
    ? [{ text: content }]
    : ((content as { type?: string; text?: string }[]) ?? []).filter((b) => (b.type ?? 'text') === 'text').map((b) => ({ text: b.text ?? '' }));
  const input: ConverseCommandInput = {
    modelId,
    messages: ((body.messages as { role: 'user' | 'assistant'; content: unknown }[]) ?? []).map((m) => ({ role: m.role, content: blocks(m.content) })),
    inferenceConfig: { maxTokens: (body.max_tokens as number) ?? 1024 },
  };
  if (body.system) input.system = blocks(body.system);
  return input;
}

class BedrockFamilyClient {
  constructor(private readonly bedrock: BedrockRuntimeClient) {}

  async send(command: any, options?: SendOptions): Promise<any> {
    if (command instanceof InvokeModelCommand && String(command.input.modelId).includes('openai.')) {
      const body = JSON.parse(new TextDecoder().decode(command.input.body as Uint8Array)) as Json;
      const out = await this.bedrock.send(new ConverseCommand(anthropicBodyToConverse(String(command.input.modelId), body)), options);
      return encodeBody({
        type: 'message', role: 'assistant', stop_reason: out.stopReason,
        content: (out.output?.message?.content ?? []).filter((b) => typeof b.text === 'string').map((b) => ({ type: 'text', text: b.text })),
        usage: { input_tokens: out.usage?.inputTokens ?? 0, output_tokens: out.usage?.outputTokens ?? 0 },
      });
    }
    return this.bedrock.send(command, options);
  }
}

class AnthropicApiClient {
  async send(command: any, options?: SendOptions): Promise<any> {
    if (command instanceof InvokeModelCommand) {
      const body = JSON.parse(new TextDecoder().decode(command.input.body as Uint8Array)) as Json;
      delete body.anthropic_version;
      return encodeBody(await this.post({ ...body, model: command.input.modelId }, options));
    }
    if (command instanceof ConverseStreamCommand) {
      return { stream: this.stream(converseToAnthropicBody(command.input as ConverseCommandInput), options), $metadata: { httpStatusCode: 200 } };
    }
    if (command instanceof ConverseCommand) {
      return converseOutput(await this.post(converseToAnthropicBody(command.input), options) as AnthropicReply);
    }
    throw new Error('anthropic_api_unsupported_command');
  }

  private async request(body: Json, options?: SendOptions, retry = true): Promise<Response> {
    const res = await fetch(ANTHROPIC_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'anthropic-version': ANTHROPIC_VERSION, 'x-api-key': await anthropicApiKey() },
      body: JSON.stringify(body),
      signal: options?.abortSignal,
    });
    if (res.status === 401 && retry) {
      // A rotated secret: drop the cached key and retry once with a fresh read.
      resetAnthropicApiKey();
      return this.request(body, options, false);
    }
    if (!res.ok) {
      let kind = '';
      try { kind = String(((await res.json()) as { error?: { type?: string } }).error?.type ?? ''); } catch { /* no body */ }
      throw new Error(`anthropic_api_error:${res.status}:${kind}`.slice(0, 120));
    }
    return res;
  }

  private async post(body: Json, options?: SendOptions): Promise<unknown> {
    return (await this.request(body, options)).json();
  }

  private async *stream(body: Json, options?: SendOptions): AsyncGenerator<ConverseStreamOutput> {
    const res = await this.request({ ...body, stream: true }, options);
    if (!res.body) return;
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let inputTokens = 0;
    const events = function* (frames: string[]) {
      for (const frame of frames) {
        const data = frame.split('\n').filter((l) => l.startsWith('data:')).map((l) => l.slice(5).trim()).join('');
        if (!data) continue;
        try { yield JSON.parse(data) as AnthropicStreamEvent; } catch { /* skip an unparseable frame */ }
      }
    };
    try {
      for (;;) {
        const { done, value } = await reader.read();
        // CRLF-tolerant framing; at EOF a final frame without a trailing blank line still counts.
        buffer = (buffer + (done ? decoder.decode() : decoder.decode(value, { stream: true }))).replace(/\r\n/g, '\n');
        const frames = buffer.split('\n\n');
        buffer = done ? '' : frames.pop() ?? '';
        for (const event of events(frames)) {
          if (event.type === 'message_start') inputTokens = event.message?.usage?.input_tokens ?? 0;
          else if (event.type === 'content_block_delta' && event.delta?.type === 'text_delta') {
            yield { contentBlockDelta: { contentBlockIndex: event.index ?? 0, delta: { text: event.delta.text ?? '' } } };
          } else if (event.type === 'message_delta') {
            if (event.delta?.stop_reason) yield { messageStop: { stopReason: event.delta.stop_reason as never } };
            const outputTokens = event.usage?.output_tokens ?? 0;
            yield { metadata: { usage: { inputTokens, outputTokens, totalTokens: inputTokens + outputTokens }, metrics: { latencyMs: 0 } } };
          } else if (event.type === 'error') {
            throw new Error('anthropic_api_stream_error');
          }
        }
        if (done) break;
      }
    } finally {
      // A consumer that stops early must not leak the locked response body.
      await reader.cancel().catch(() => undefined);
    }
  }
}
