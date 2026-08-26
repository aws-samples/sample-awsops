// web/lib/admin.ts
// ADR-031 Phase 1 — minimal v2 admin gate: cognito:groups OR SSM-listed admin emails.
import { SSMClient, GetParameterCommand } from '@aws-sdk/client-ssm';
import type { User } from '@/lib/auth';

const REGION = process.env.AWS_REGION || 'ap-northeast-2';
const TTL_MS = 5 * 60 * 1000;

let ssm: SSMClient | null = null;
let emailCache: { value: Set<string>; at: number } | null = null;

export function _clearAdminCacheForTests() { emailCache = null; ssm = null; }

async function adminEmails(): Promise<Set<string>> {
  const param = process.env.SSM_ADMIN_EMAILS_PARAM;
  if (!param) return new Set();
  if (emailCache && Date.now() - emailCache.at < TTL_MS) return emailCache.value;
  if (!ssm) ssm = new SSMClient({ region: REGION });
  try {
    const r = await ssm.send(new GetParameterCommand({ Name: param }));
    const raw = r.Parameter?.Value ?? '';
    const set = new Set(raw.split(',').map((s) => s.trim().toLowerCase()).filter(Boolean));
    emailCache = { value: set, at: Date.now() };
    return set;
  } catch {
    return new Set(); // fail-closed
  }
}

/** True iff the user is in the admin group or the SSM admin-email allowlist. Fail-closed. */
export async function isAdmin(user: Pick<User, 'email' | 'groups'>): Promise<boolean> {
  const group = process.env.ADMIN_GROUP || 'admins';
  if (user.groups?.includes(group)) return true;
  if (!user.email) return false;
  return (await adminEmails()).has(user.email.toLowerCase());
}
