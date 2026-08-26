// web/lib/integration-credentials.ts
// DevOps-agent-style credential-write UX. ONE Secrets Manager secret
// (ops/${project}/integrations/credentials) holds a JSON map keyed by integration KIND (slug):
//   { "notion": {"token": "..."}, "datadog": {...} }
// The connector Lambda reads the same secret and extracts map[INTEGRATION_SLUG].
//
// SECURITY: the BFF writes (PutSecretValue) but NEVER returns/logs credential values.
// Secrets Manager PutSecretValue has no conditional-put, so concurrent admin writes to different
// slugs would clobber the shared map — we serialize the read-modify-write under a pg advisory lock.
import {
  SecretsManagerClient,
  GetSecretValueCommand,
  PutSecretValueCommand,
} from '@aws-sdk/client-secrets-manager';
import { getPool } from '@/lib/db';

const REGION = process.env.AWS_REGION || 'ap-northeast-2';
const SECRET_NAME =
  process.env.INTEGRATIONS_SECRET_NAME || 'ops/awsops-v2/integrations/credentials';

// Kinds that have a connector Lambda reading this secret (INTEGRATION_SLUG = kind). Extend as
// connectors are added. An arbitrary key is rejected (no arbitrary secret-key injection).
export const KNOWN_CONNECTOR_SLUGS = ['notion', 'clickhouse', 'prometheus', 'loki', 'tempo', 'mimir'] as const;

const MAX_SECRET_PAYLOAD_BYTES = 65000; // Secrets Manager limit is 64 KB/version
const LOCK_KEY = 729153866; // fixed advisory-lock key for the single credentials secret

let smc: SecretsManagerClient | null = null;
function client(): SecretsManagerClient {
  if (!smc) smc = new SecretsManagerClient({ region: REGION });
  return smc;
}

function assertKnownSlug(slug: string): void {
  if (!(KNOWN_CONNECTOR_SLUGS as readonly string[]).includes(slug)) {
    throw new Error(`unknown integration slug: ${slug}`);
  }
}

async function readMap(): Promise<Record<string, unknown>> {
  try {
    const r = await client().send(new GetSecretValueCommand({ SecretId: SECRET_NAME }));
    if (!r.SecretString) return {};
    const m = JSON.parse(r.SecretString);
    return m && typeof m === 'object' && !Array.isArray(m) ? (m as Record<string, unknown>) : {};
  } catch (e: unknown) {
    if ((e as { name?: string })?.name === 'ResourceNotFoundException') return {};
    throw e;
  }
}

/** Read-modify-write the single shared credential map under a pg advisory lock so concurrent admin
 *  writes can't clobber each other. The mutator edits the map in place; size is checked before PUT. */
async function mutateCredentialMap(
  mutate: (map: Record<string, unknown>) => void,
): Promise<void> {
  const c = await getPool().connect();
  try {
    await c.query('BEGIN');
    await c.query('SELECT pg_advisory_xact_lock($1)', [LOCK_KEY]);
    const map = await readMap();
    mutate(map);
    const payload = JSON.stringify(map);
    if (Buffer.byteLength(payload, 'utf8') > MAX_SECRET_PAYLOAD_BYTES) {
      throw new Error('integration credentials payload exceeds size limit');
    }
    await client().send(new PutSecretValueCommand({ SecretId: SECRET_NAME, SecretString: payload }));
    await c.query('COMMIT');
  } catch (e) {
    await c.query('ROLLBACK').catch(() => {});
    throw e;
  } finally {
    c.release();
  }
}

/** Store one integration's credential under its slug (the legacy/kind key). */
export async function setIntegrationCredential(
  slug: string,
  secretObj: Record<string, unknown>,
): Promise<void> {
  assertKnownSlug(slug); // before any I/O — unknown slug ⇒ no SM/DB call
  await mutateCredentialMap((map) => {
    map[slug] = secretObj;
  });
}

// ── Multi-instance datasources (ADR-039 hub) ────────────────────────────────────────────────
// Each datasource INSTANCE stores its connConfig secret blob ({endpoint, authType, creds…, org_id?})
// under its bigint `integrations.id` key. The plain `kind` key is the MANAGED DEFAULT MIRROR — the
// connector Lambda's no-inline (AgentCore gateway) path loads it, so it must always equal the current
// default instance for that kind. The kind key is owned by datasources.ts (create/update/setDefault/
// delete) and is NEVER blind-deleted on a per-instance save.

function assertPositiveId(id: number): void {
  if (!Number.isInteger(id) || id <= 0) throw new Error(`invalid integration id: ${id}`);
}

/** Store a datasource instance's credential under its bigint id key (no clobber of other keys). */
export async function setIntegrationCredentialById(
  id: number,
  secretObj: Record<string, unknown>,
): Promise<void> {
  assertPositiveId(id);
  await mutateCredentialMap((map) => {
    map[String(id)] = secretObj;
  });
}

/** Write the managed default-mirror under the plain `kind` key (agent gateway no-inline path). */
export async function mirrorDefaultCredential(
  kind: string,
  secretObj: Record<string, unknown>,
): Promise<void> {
  assertKnownSlug(kind);
  await mutateCredentialMap((map) => {
    map[kind] = secretObj;
  });
}

/** Resolve an instance's credential: the id entry, else the kind mirror (fallback), else null.
 *  Throws on a Secrets Manager read failure (the caller — query/test — surfaces it). */
export async function getCredentialById(
  id: number,
  fallbackKind?: string,
): Promise<Record<string, unknown> | null> {
  const map = await readMap();
  const byId = map[String(id)];
  if (byId && typeof byId === 'object') return byId as Record<string, unknown>;
  if (fallbackKind) {
    const byKind = map[fallbackKind];
    if (byKind && typeof byKind === 'object') return byKind as Record<string, unknown>;
  }
  return null;
}

/** Configured instance id keys (numeric keys only — excludes kind-mirror keys). Best-effort: [] on a
 *  Secrets Manager read failure (mirrors getConfiguredSlugs degrade so the read-only list doesn't 500). */
export async function getConfiguredIds(): Promise<string[]> {
  try {
    return Object.keys(await readMap()).filter((k) => /^\d+$/.test(k));
  } catch (e) {
    console.warn(
      '[integration-credentials] getConfiguredIds read failed; treating as none configured:',
      (e as { name?: string })?.name || 'unknown error',
    );
    return [];
  }
}

/** Remove the given map keys (e.g. an instance id and, when deleting the default, its kind mirror). */
export async function deleteCredentialKeys(keys: string[]): Promise<void> {
  if (keys.length === 0) return;
  await mutateCredentialMap((map) => {
    for (const k of keys) delete map[k];
  });
}

/** Slugs that currently have a stored credential — KEYS ONLY (never values).
 *  Best-effort: when the integrations secret is absent or unreadable — e.g. the integrations
 *  feature is gated off, so the task role has no access and Secrets Manager returns
 *  AccessDenied (not ResourceNotFound) — treat it as "none configured" so the read-only
 *  list/explore surfaces (/api/datasources, /customization) degrade to an empty state instead
 *  of 500-ing the page. The admin write path (setIntegrationCredential) stays strict and still
 *  surfaces errors. SECURITY: log only the error name, never the secret contents. */
export async function getConfiguredSlugs(): Promise<string[]> {
  try {
    return Object.keys(await readMap());
  } catch (e) {
    console.warn(
      '[integration-credentials] getConfiguredSlugs read failed; treating as none configured:',
      (e as { name?: string })?.name || 'unknown error',
    );
    return [];
  }
}
