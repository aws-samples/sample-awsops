// Shared bounded-history rendering for the routing classifier + AWSops Assistant fallback
// (web/lib/classifier.ts, web/lib/assistant.ts). Both feed a short excerpt of the client-supplied
// conversation into a Bedrock call; this is the one place that decides what survives the cap.
export interface HistoryMsg {
  role: 'user' | 'assistant';
  content: string;
  // Which account the turn was answered for ('host' or a 12-digit id), from the server's own meta
  // frame. The agent labels earlier turns with it only when a thread spans accounts.
  account?: string;
}

const ACCOUNT_LABEL_RE = /^(?:host|\d{12})$/;

/** The account label the chat route reports for an answer (and the agent compares turns by). */
export function accountLabel(accountId: string, hostAccountId: string): string {
  return accountId === hostAccountId ? 'host' : accountId;
}

export interface RenderHistoryOpts {
  turns: number;       // how many of the most recent messages to consider at all
  perMsgChars: number;  // per-message cap, applied BEFORE the total cap (one huge message can't starve its neighbors)
  totalChars: number;   // total cap across all rendered lines
}

// Bug fix (PR #138 review, MAJOR): the previous version joined oldest→newest THEN sliced the
// total cap, which truncates the newest — i.e. most relevant — turn once history got long enough
// to exceed totalChars. Fill from the newest message BACKWARD instead, so the cap always drops
// the OLDEST lines first; output is re-assembled in chronological order.
export function renderRecentHistory(messages: HistoryMsg[] | undefined, opts: RenderHistoryOpts): string {
  if (!messages || messages.length === 0) return '';
  const recent = messages.slice(-opts.turns);
  const lines: string[] = [];
  let used = 0;
  for (let i = recent.length - 1; i >= 0; i--) {
    const content = escapeTagBreakout(recent[i].content.slice(0, opts.perMsgChars));
    const line = `${recent[i].role}: ${content}`;
    const sep = lines.length ? 1 : 0; // '\n' joiner, once a second+ line is added
    if (used + line.length + sep > opts.totalChars) break; // older lines dropped first
    lines.unshift(line);
    used += line.length + sep;
  }
  return lines.join('\n');
}

// Bug fix (PR #138 review, MINOR): route.ts previously forwarded raw `body.messages` straight
// into classifyPrompt/assistantAnswer — a non-array or an entry with a non-string `content`
// throws inside String.prototype.slice deep in renderRecentHistory, silently degrading routing
// to its fallback path (classifier) or the deterministic guide (assistant, via its try/catch).
// Sanitize ONCE at the request boundary so every downstream consumer gets a well-formed array.
// Rebuilds each entry from the known fields so no other client-supplied key reaches the agent payload.
export function sanitizeHistory(input: unknown): HistoryMsg[] {
  if (!Array.isArray(input)) return [];
  return input
    .filter((m): m is HistoryMsg =>
      !!m && typeof m === 'object'
      && (m.role === 'user' || m.role === 'assistant')
      && typeof m.content === 'string')
    .map((m) => (typeof m.account === 'string' && ACCOUNT_LABEL_RE.test(m.account)
      ? { role: m.role, content: m.content, account: m.account }
      : { role: m.role, content: m.content }));
}

// Bug fix (PR #138 review, MINOR): history content is untrusted (prior user turns, and prior
// assistant text that itself may echo user input) and gets inlined into an XML-like delimited
// block (<query>, <user_query>, <awsops_chat_history>). Neutralize any literal occurrence of our
// own delimiter tags inside the content so it can't fake-close a tag early and smuggle text that
// reads as being outside the "this is DATA" boundary, ahead of the real closing tag.
function escapeTagBreakout(s: string): string {
  return s.replace(/<\/?(?:awsops_chat_history|user_query|query)>/gi, (m) => m.replace('<', '&lt;').replace('>', '&gt;'));
}

// Outgoing history bound (client → /api/chat). The BFF rejects bodies over 512,000 BYTES (413). Budget
// UTF-8 bytes, reserving the encoded request fields too (a 50k-char prompt can reach 300KB once JSON-
// escaped). Keep the NEWEST turns that fit, skip empty placeholders, never split a message.
export const OUTGOING_HISTORY_MAX_MESSAGES = 40;
export const OUTGOING_HISTORY_MAX_BYTES = 300_000;
const CHAT_REQUEST_MAX_BYTES = 512_000;

const utf8 = new TextEncoder();

export function boundOutgoingHistory(
  messages: HistoryMsg[],
  maxMessages = OUTGOING_HISTORY_MAX_MESSAGES,
  maxBytes = OUTGOING_HISTORY_MAX_BYTES,
  requestFields: object = {},
): HistoryMsg[] {
  const envelopeBytes = utf8.encode(JSON.stringify({ ...requestFields, messages: [] })).length;
  maxBytes = Math.max(0, Math.min(maxBytes, CHAT_REQUEST_MAX_BYTES - envelopeBytes));
  const kept: HistoryMsg[] = [];
  let used = 0;
  for (let i = messages.length - 1; i >= 0 && kept.length < maxMessages; i--) {
    const m = messages[i];
    if (!m.content) continue;
    // JSON.stringify escapes quotes/newlines/control chars, so measure the encoded form.
    // Include role/key framing and one separator (conservative for the first item).
    const size = utf8.encode(JSON.stringify(m)).length + 1;
    if (used + size > maxBytes) break;
    kept.unshift(m);
    used += size;
  }
  return kept;
}
