// Server-side Pod env / ConfigMap reference extractor (read-only).
// SECURITY: this module is the ONLY server-side reader of env / ConfigMap VALUES.
// Values never leave it: results carry only hosts returned by extractManagedDbHosts.
// Secret VALUES are never requested (no /secrets path); only Secret NAMES are kept.
// Errors are rethrown/absorbed as fixed strings — never include bodies or values.
import { clusterConn, eksToken, k8sGetWith, podWorkload } from './eks-incluster';
import { EksKubernetesHttpError } from './eks-read-error';
import { extractManagedDbHosts, type DbKind } from './db-endpoint';

export interface WorkloadRef { namespace: string; name: string }
export interface DbRef { workload: WorkloadRef; via: 'env' | 'configmap'; host: string; kind: DbKind }
export interface SecretRef { workload: WorkloadRef; secret: string }
export interface DbRefsResult { refs: DbRef[]; secretRefs: SecretRef[]; truncated: boolean; partial: boolean }

const DEFAULT_CAPS = { pods: 2000, configMaps: 200 };
const CM_CONCURRENCY = 8;
/** Overall wall-clock budget for one run. Past it no new GET is issued (in-flight reads are
 *  still bounded by the per-request timeout); the result is then partial + truncated. */
const DEFAULT_DEADLINE_MS = 20_000;

interface EnvVar {
  name?: string;
  value?: string;
  valueFrom?: { configMapKeyRef?: { name?: string; key?: string }; secretKeyRef?: { name?: string } };
}
interface Container { env?: EnvVar[]; envFrom?: { configMapRef?: { name?: string }; secretRef?: { name?: string } }[] }
interface PodItem {
  metadata?: { name?: string; namespace?: string; ownerReferences?: { kind?: string; name?: string }[]; labels?: Record<string, string> };
  spec?: { containers?: Container[]; initContainers?: Container[] };
}

function parseJson(body: string): unknown {
  try { return JSON.parse(body); } catch { throw new Error('Kubernetes API response could not be parsed.'); }
}

export async function listDbRefs(
  cluster: string,
  caps: { pods: number; configMaps: number } = DEFAULT_CAPS,
  { deadlineMs = DEFAULT_DEADLINE_MS, now = Date.now }: { deadlineMs?: number; now?: () => number } = {},
): Promise<DbRefsResult> {
  const deadline = now() + deadlineMs;
  const refs: DbRef[] = [];
  const secretRefs: SecretRef[] = [];
  const seenRefs = new Set<string>();
  const seenSecrets = new Set<string>();
  let truncated = false;
  let partial = false;

  const addRef = (workload: WorkloadRef, via: DbRef['via'], value: string) => {
    for (const { host, kind } of extractManagedDbHosts(value)) {
      const key = `${workload.namespace}\0${workload.name}\0${via}\0${host}`;
      if (seenRefs.has(key)) continue;
      seenRefs.add(key);
      refs.push({ workload, via, host, kind });
    }
  };

  // Resolve scope, endpoint/CA and bearer ONCE for the whole run (each resolution costs several
  // Aurora queries for a member cluster); every GET below reuses them. Resolution errors rethrow.
  const conn = await clusterConn(cluster);
  const token = await eksToken(cluster);
  const get = (path: string) => k8sGetWith(conn, token, path);

  let podBody: string;
  try {
    podBody = await get(`/api/v1/pods?limit=${caps.pods}`);
  } catch (err) {
    // Read role denied pod list: disclose as partial instead of failing. Other errors are value-free; rethrow.
    if (err instanceof EksKubernetesHttpError && err.statusCode === 403) {
      return { refs: [], secretRefs: [], truncated: false, partial: true };
    }
    throw err;
  }
  const podList = parseJson(podBody) as
    { items?: PodItem[]; metadata?: { continue?: string } } | null;
  const items = Array.isArray(podList?.items) ? podList.items : [];
  if (podList?.metadata?.continue || items.length > caps.pods) truncated = true;

  // (ns/cm) -> consumers; keys === null means envFrom (all keys), else specific keys.
  const cmNeeds = new Map<string, { ns: string; cm: string; users: { workload: WorkloadRef; keys: Set<string> | null }[] }>();

  for (const pod of items.slice(0, caps.pods)) {
    const ns = pod.metadata?.namespace ?? '';
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const name = podWorkload(pod as any);
    if (!ns || !name) continue;
    const workload: WorkloadRef = { namespace: ns, name };
    const addSecret = (secret?: string) => {
      if (!secret) return;
      const k = `${ns}\0${name}\0${secret}`;
      if (seenSecrets.has(k)) return;
      seenSecrets.add(k);
      secretRefs.push({ workload, secret });
    };
    const need = (cm: string | undefined, key: string | null) => {
      if (!cm) return;
      const id = `${ns}\0${cm}`;
      let e = cmNeeds.get(id);
      if (!e) { e = { ns, cm, users: [] }; cmNeeds.set(id, e); }
      let u = e.users.find((x) => x.workload.name === name);
      if (!u) { u = { workload, keys: key === null ? null : new Set() }; e.users.push(u); }
      if (key === null) u.keys = null;
      else u.keys?.add(key);
    };
    for (const c of [...(pod.spec?.containers ?? []), ...(pod.spec?.initContainers ?? [])]) {
      for (const e of c.env ?? []) {
        if (typeof e.value === 'string') addRef(workload, 'env', e.value);
        need(e.valueFrom?.configMapKeyRef?.name, e.valueFrom?.configMapKeyRef?.key ?? '');
        addSecret(e.valueFrom?.secretKeyRef?.name);
      }
      for (const f of c.envFrom ?? []) {
        need(f.configMapRef?.name, null);
        addSecret(f.secretRef?.name);
      }
    }
  }

  let queue = [...cmNeeds.values()];
  if (queue.length > caps.configMaps) { truncated = true; queue = queue.slice(0, caps.configMaps); }

  let outOfTime = false;
  const fetchOne = async (e: (typeof queue)[number]) => {
    if (outOfTime || now() >= deadline) { outOfTime = true; return; }
    try {
      const body = parseJson(await get(
        `/api/v1/namespaces/${encodeURIComponent(e.ns)}/configmaps/${encodeURIComponent(e.cm)}`,
      )) as { data?: Record<string, unknown> } | null;
      const data = body?.data && typeof body.data === 'object' ? body.data : {};
      for (const u of e.users) {
        for (const [k, v] of Object.entries(data)) {
          if (typeof v !== 'string') continue;
          if (u.keys !== null && !u.keys.has(k)) continue;
          addRef(u.workload, 'configmap', v);
        }
      }
    } catch {
      partial = true; // never surface the error (403/404/timeout/parse) detail
    }
  };
  for (let i = 0; i < queue.length && !outOfTime; i += CM_CONCURRENCY) {
    await Promise.all(queue.slice(i, i + CM_CONCURRENCY).map(fetchOne));
  }
  // Deadline hit with reads left unissued: what was gathered is kept and disclosed as incomplete.
  if (outOfTime) { partial = true; truncated = true; }

  return { refs, secretRefs, truncated, partial };
}
