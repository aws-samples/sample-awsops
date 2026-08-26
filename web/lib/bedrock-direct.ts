// v1-parity final fallback (v1 src/app/api/ai/route.ts:1335-1353): when the AgentCore Runtime
// itself is down/unreachable, answer via Bedrock directly instead of surfacing a dead error
// frame. Honest by design — the caller tags the answer `via: 'bedrock-direct-fallback'` and the
// text opens with a notice that live tools were unavailable.
import { BedrockRuntimeClient, ConverseStreamCommand, type Message } from '@aws-sdk/client-bedrock-runtime';
import type { ChatMsg } from './agentcore';

const REGION = process.env.AWS_REGION || 'ap-northeast-2';
const MODEL_ID = process.env.SYNTHESIS_MODEL_ID || 'global.anthropic.claude-sonnet-5';

const SYSTEM =
  'You are the AWSops operations assistant. The live agent runtime (with real AWS tools) is ' +
  'temporarily unavailable, so you are answering from general knowledge WITHOUT live account data. ' +
  'Be explicit about that limitation whenever the question asks about live resources or metrics; ' +
  'give safe general guidance instead of fabricating account-specific facts. ' +
  'Format responses in markdown.';

let client: BedrockRuntimeClient | null = null;

/** Stream a Bedrock-direct answer for the last-resort fallback path. Throws on Bedrock failure —
 *  the caller keeps its existing error frame as the true end of the ladder. */
export async function* bedrockDirectStream(
  prompt: string,
  history: ChatMsg[],
  opts: { abortSignal?: AbortSignal; responseLanguage?: string } = {},
): AsyncGenerator<string> {
  if (!client) client = new BedrockRuntimeClient({ region: REGION });
  const lang = opts.responseLanguage === 'en' ? 'English'
    : opts.responseLanguage === 'zh' ? 'Simplified Chinese'
    : opts.responseLanguage === 'ja' ? 'Japanese' : 'Korean';
  const messages: Message[] = [
    // bound the carried history the same way sanitizeHistory already did upstream
    ...history.slice(-8).map((m) => ({ role: m.role, content: [{ text: m.content }] })),
    { role: 'user' as const, content: [{ text: prompt }] },
  ];
  const res = await client.send(new ConverseStreamCommand({
    modelId: MODEL_ID,
    system: [{ text: `${SYSTEM} Always respond in ${lang}.` }],
    messages,
    // sonnet-5 rejects `temperature` on ConverseStream (see agent/agent.py note) — omit it.
    inferenceConfig: { maxTokens: 4096 },
  }), { abortSignal: opts.abortSignal });
  for await (const ev of res.stream ?? []) {
    const d = ev.contentBlockDelta?.delta;
    if (d && 'text' in d && d.text) yield d.text;
  }
}
