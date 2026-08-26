import { getPool } from './db';

// Single source for "which EKS clusters may the app query".
// Allow-list = ONBOARDED_EKS_CLUSTERS env (Terraform-managed, immutable here) ∪ eks_registrations (runtime).
// DB failure/absence degrades to env-only — existing clusters keep working (never throws).

const TTL_MS = 30_000; // PR #36: revocation propagates within ≤TTL per Fargate task (register/unregister bust only the local cache); acceptable for a read-only proxy
let cache: { set: Set<string>; at: number } | null = null;

const dbOn = () => !!process.env.AURORA_ENDPOINT;

export function envClusters(): string[] {
  return (process.env.ONBOARDED_EKS_CLUSTERS || '').split(',').filter(Boolean);
}

export function isEnvCluster(name: string): boolean {
  return envClusters().includes(name);
}

export function _resetForTests() { cache = null; }

export async function getAllowedClusters(): Promise<Set<string>> {
  if (cache && Date.now() - cache.at < TTL_MS) return cache.set;
  const set = new Set(envClusters());
  if (dbOn()) {
    try {
      const r = await getPool().query(`SELECT cluster_name FROM eks_registrations`);
      for (const row of r.rows) set.add(row.cluster_name);
    } catch (e) {
      console.warn(`[eks-registry] falling back to env-only: ${e instanceof Error ? e.message : e}`);
    }
  }
  cache = { set, at: Date.now() };
  return set;
}

// ── Per-cluster auth override (Aurora, v1 kubeconfig-parity) ────────────────
export type EksAuth =
  | { mode: 'sa-token'; token: string }
  | { mode: 'assume-role'; roleArn: string; externalId?: string };

const AUTH_TTL_MS = 30_000;
const authCache = new Map<string, { auth: EksAuth | null; at: number }>();

/** Stored auth for a cluster (null = default task-role path). 30s cache; DB failure → null. */
export async function getClusterAuth(cluster: string): Promise<EksAuth | null> {
  const hit = authCache.get(cluster);
  if (hit && Date.now() - hit.at < AUTH_TTL_MS) return hit.auth;
  let auth: EksAuth | null = null;
  if (dbOn()) {
    try {
      const r = await getPool().query(`SELECT auth FROM eks_registrations WHERE cluster_name = $1`, [cluster]);
      const raw = r.rows[0]?.auth;
      if (raw && typeof raw === 'object' && (raw.mode === 'sa-token' || raw.mode === 'assume-role')) auth = raw as EksAuth;
    } catch (e) {
      console.warn(`[eks-registry] auth read failed (task-role fallback): ${e instanceof Error ? e.message : e}`);
    }
  }
  authCache.set(cluster, { auth, at: Date.now() });
  return auth;
}

/** Upsert the row + auth (null clears → task-role default). Admin-gated at the route. */
export async function setClusterAuth(cluster: string, registeredBy: string, auth: EksAuth | null): Promise<boolean> {
  if (!dbOn()) return false;
  try {
    await getPool().query(
      `INSERT INTO eks_registrations (cluster_name, registered_by, auth) VALUES ($1, $2, $3)
       ON CONFLICT (cluster_name) DO UPDATE SET auth = EXCLUDED.auth`,
      [cluster, registeredBy, auth === null ? null : JSON.stringify(auth)],
    );
  } catch (e) {
    console.warn(`[eks-registry] auth write failed: ${e instanceof Error ? e.message : e}`);
    return false;
  }
  cache = null;
  authCache.delete(cluster);
  return true;
}

/** Auth MODES per cluster for listings (never the token/role values). */
export async function getAuthModes(): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  if (!dbOn()) return out;
  try {
    const r = await getPool().query(`SELECT cluster_name, auth->>'mode' AS mode FROM eks_registrations WHERE auth IS NOT NULL`);
    for (const row of r.rows) if (row.mode) out.set(row.cluster_name, row.mode);
  } catch { /* listing degrades to no-modes */ }
  return out;
}

export function _resetAuthCacheForTests() { authCache.clear(); }

export async function isAllowed(cluster: string): Promise<boolean> {
  return (await getAllowedClusters()).has(cluster);
}

export async function registerCluster(cluster: string, userSub: string): Promise<boolean> {
  if (!dbOn()) return false;
  try {
    await getPool().query(
      `INSERT INTO eks_registrations (cluster_name, registered_by) VALUES ($1, $2)
       ON CONFLICT (cluster_name) DO NOTHING`,
      [cluster, userSub],
    );
  } catch (e) { // write failure degrades to "storage unavailable" (route → 503), never a 500
    console.warn(`[eks-registry] register failed: ${e instanceof Error ? e.message : e}`);
    return false;
  }
  cache = null; // bust so the next read sees it immediately
  return true;
}

// PR #36 review: 'not-found' and 'unavailable' must stay distinct — a DB outage shown
// as "already unregistered" misleads the operator (route maps them to 404 vs 503).
export type UnregisterResult = 'deleted' | 'not-found' | 'unavailable';

export async function unregisterCluster(cluster: string): Promise<UnregisterResult> {
  if (!dbOn()) return 'unavailable';
  try {
    const r = await getPool().query(`DELETE FROM eks_registrations WHERE cluster_name = $1`, [cluster]);
    cache = null;
    return (r.rowCount ?? 0) > 0 ? 'deleted' : 'not-found';
  } catch (e) {
    console.warn(`[eks-registry] unregister failed: ${e instanceof Error ? e.message : e}`);
    return 'unavailable';
  }
}
