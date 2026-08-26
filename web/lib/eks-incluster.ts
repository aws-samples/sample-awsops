import https from 'node:https';
import { SignatureV4 } from '@smithy/signature-v4';
import { HttpRequest } from '@smithy/protocol-http';
import { Sha256 } from '@aws-crypto/sha256-js';
import { fromNodeProviderChain } from '@aws-sdk/credential-providers';
import { EKSClient, DescribeClusterCommand } from '@aws-sdk/client-eks';
import { parseCpuCores, parseMem, type NodeRow, type PodRow } from './eks-resources';

// Re-export the client-safe row types so existing importers keep resolving them here.
export type { NodeRow, PodRow } from './eks-resources';

const REGION = process.env.AWS_REGION || 'ap-northeast-2';
// Per-request K8s API-server timeout (thin-BFF: bound how long a single in-cluster read
// can occupy the web task when the API server is slow/unreachable).
const K8S_REQUEST_TIMEOUT_MS = 4000;

/**
 * Replicate `aws eks get-token`: presign an STS GetCallerIdentity GET with the
 * `x-k8s-aws-id: <cluster>` header SIGNED, then `k8s-aws-v1.` + base64url(url).
 * The web task role's P1e Access Entry + AmazonEKSAdminViewPolicy authorize the read.
 */
// Cached AssumeRole creds per roleArn (50-min TTL vs 1h default session).
const assumeCache = new Map<string, { creds: { accessKeyId: string; secretAccessKey: string; sessionToken?: string }; at: number }>();
const ASSUME_TTL_MS = 50 * 60 * 1000;

async function assumeRoleCreds(roleArn: string, externalId?: string) {
  const hit = assumeCache.get(roleArn);
  if (hit && Date.now() - hit.at < ASSUME_TTL_MS) return hit.creds;
  const { STSClient, AssumeRoleCommand } = await import('@aws-sdk/client-sts');
  const sts = new STSClient({ region: REGION });
  const r = await sts.send(new AssumeRoleCommand({
    RoleArn: roleArn, RoleSessionName: 'awsops-eks-read', DurationSeconds: 3600,
    ...(externalId ? { ExternalId: externalId } : {}),
  }));
  const c = r.Credentials;
  if (!c?.AccessKeyId || !c.SecretAccessKey) throw new Error('AssumeRole returned no credentials');
  const creds = { accessKeyId: c.AccessKeyId, secretAccessKey: c.SecretAccessKey, sessionToken: c.SessionToken };
  assumeCache.set(roleArn, { creds, at: Date.now() });
  return creds;
}

/** Bearer token for a cluster. Auth override from Aurora (v1 kubeconfig parity) wins:
 *  sa-token → stored ServiceAccount bearer as-is; assume-role → presigned STS token minted
 *  with the assumed role's creds; null → task-role presigned token (Access Entry required). */
export async function eksToken(cluster: string, region: string): Promise<string> {
  try {
    const { getClusterAuth } = await import('./eks-registry');
    const auth = await getClusterAuth(cluster);
    if (auth?.mode === 'sa-token') return auth.token;
    if (auth?.mode === 'assume-role') {
      const creds = await assumeRoleCreds(auth.roleArn, auth.externalId);
      return presignEksToken(cluster, region, creds);
    }
  } catch (e) {
    console.warn(`[eks-incluster] auth override failed, task-role fallback: ${e instanceof Error ? e.message : e}`);
  }
  return presignEksToken(cluster, region, fromNodeProviderChain());
}

async function presignEksToken(
  cluster: string,
  region: string,
  credentials: Parameters<typeof SignatureV4.prototype.presign> extends never ? never : ConstructorParameters<typeof SignatureV4>[0]['credentials'],
): Promise<string> {
  const host = `sts.${region}.amazonaws.com`;
  const signer = new SignatureV4({ service: 'sts', region, sha256: Sha256, credentials });
  const req = new HttpRequest({
    method: 'GET', protocol: 'https:', hostname: host, path: '/',
    query: { Action: 'GetCallerIdentity', Version: '2011-06-15' },
    headers: { host, 'x-k8s-aws-id': cluster }, // x-k8s-aws-id MUST be signed
  });
  const p = await signer.presign(req, { expiresIn: 60 });
  const qs = Object.entries(p.query as Record<string, string | string[]>)
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(Array.isArray(v) ? v[0] : v)}`).join('&');
  const url = `https://${host}/?${qs}`;
  return `k8s-aws-v1.${Buffer.from(url).toString('base64url').replace(/=+$/, '')}`;
}

// ── cluster connection (endpoint + CA), 5-min in-memory cache ──────────────
export interface ClusterConn { endpoint: string; caPem: Buffer }
interface CacheEntry { conn: ClusterConn; at: number }
const CONN_TTL_MS = 5 * 60 * 1000;
const connCache = new Map<string, CacheEntry>();

let eks: EKSClient | null = null;
function eksClient(): EKSClient { if (!eks) eks = new EKSClient({ region: REGION }); return eks; }

export async function clusterConn(cluster: string): Promise<ClusterConn> {
  const cached = connCache.get(cluster);
  if (cached && Date.now() - cached.at < CONN_TTL_MS) return cached.conn;
  const { cluster: c } = await eksClient().send(new DescribeClusterCommand({ name: cluster }));
  const endpoint = c?.endpoint;
  const caData = c?.certificateAuthority?.data;
  if (!endpoint || !caData) throw new Error(`cluster ${cluster}: missing endpoint or certificateAuthority`);
  const conn: ClusterConn = { endpoint, caPem: Buffer.from(caData, 'base64') };
  connCache.set(cluster, { conn, at: Date.now() });
  return conn;
}

// ── in-cluster list + normalize ────────────────────────────────────────────
export type Kind =
  | 'nodes' | 'pods' | 'deployments' | 'services' | 'namespaces' | 'events' | 'endpoints'
  // EKS 탐색기 kinds (v1 K9s-style explorer parity). SECURITY: secrets stay REJECTED (the pinned
  // allow-list invariant); configmaps are METADATA-ONLY — the normalizer never carries data values.
  | 'replicasets' | 'daemonsets' | 'statefulsets' | 'jobs' | 'configmaps' | 'pvcs';

const KIND_PATH: Record<Kind, string> = {
  nodes: '/api/v1/nodes',
  pods: '/api/v1/pods',
  deployments: '/apis/apps/v1/deployments',
  services: '/api/v1/services',
  namespaces: '/api/v1/namespaces',
  // Core /api/v1/events (not events.k8s.io/v1): the events.k8s.io/v1 API renames
  // count/lastTimestamp to deprecatedCount/series, so the core endpoint is what
  // preserves the fields our normalizeEvent fallbacks read.
  events: '/api/v1/events?fieldSelector=type=Warning', // Warning만 (v1 parity, read-only GET; 미인코딩 '='가 k8s 표준형 — PR #36)
  endpoints: '/api/v1/endpoints', // service↔podIP mapping for topology target resolution (read-only GET)
  replicasets: '/apis/apps/v1/replicasets',
  daemonsets: '/apis/apps/v1/daemonsets',
  statefulsets: '/apis/apps/v1/statefulsets',
  jobs: '/apis/batch/v1/jobs',
  configmaps: '/api/v1/configmaps',
  pvcs: '/api/v1/persistentvolumeclaims',
};

export function isKind(k: string): k is Kind {
  return (
    k === 'nodes' ||
    k === 'pods' ||
    k === 'deployments' ||
    k === 'services' ||
    k === 'namespaces' ||
    k === 'events' ||
    k === 'endpoints' ||
    k === 'replicasets' ||
    k === 'daemonsets' ||
    k === 'statefulsets' ||
    k === 'jobs' ||
    k === 'configmaps' ||
    k === 'pvcs'
  );
}

/** ISO timestamp → compact age like "3d", "5h", "12m", "8s". */
function age(ts?: string): string {
  if (!ts) return '';
  const ms = Date.now() - new Date(ts).getTime();
  if (!Number.isFinite(ms) || ms < 0) return '';
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h`;
  return `${Math.floor(h / 24)}d`;
}

// minimal K8s shapes (only the fields we read)
interface K8sList { items?: K8sItem[]; message?: string; kind?: string }
interface K8sItem {
  metadata?: { name?: string; namespace?: string; creationTimestamp?: string; labels?: Record<string, string>;
    ownerReferences?: { kind?: string; name?: string }[] };
  status?: {
    conditions?: { type?: string; status?: string; reason?: string; message?: string }[];
    nodeInfo?: { kubeletVersion?: string };
    phase?: string;
    podIP?: string;
    containerStatuses?: { restartCount?: number }[];
    readyReplicas?: number;
    availableReplicas?: number;
    updatedReplicas?: number;
    capacity?: Record<string, string>;
    allocatable?: Record<string, string>;
  };
  spec?: {
    nodeName?: string;
    replicas?: number;
    type?: string;
    clusterIP?: string;
    ports?: { port?: number; protocol?: string }[];
    containers?: { resources?: { requests?: Record<string, string> } }[];
    initContainers?: { resources?: { requests?: Record<string, string> } }[];
    overhead?: Record<string, string>;
    taints?: { key?: string; value?: string; effect?: string }[];
  };
  // core /api/v1 Endpoints: subsets[].addresses[].ip = the pod IPs backing the Service
  // (the Endpoints object name == the Service name). Read by normalizeEndpoint.
  subsets?: { addresses?: { ip?: string }[] }[];
  // core /api/v1 Event fields (read by normalizeEvent)
  involvedObject?: { kind?: string; name?: string };
  reason?: string;
  message?: string;
  count?: number;
  lastTimestamp?: string;
  eventTime?: string;
  series?: { lastObservedTime?: string };
  type?: string;
}

// NodeRow / PodRow are defined (and re-exported) from ./eks-resources (client-safe).
export interface DeploymentRow { name: string; namespace: string; ready: string; upToDate: number; available: number; age: string }
export interface ServiceRow { name: string; namespace: string; type: string; clusterIP: string; ports: string; age: string }
export interface NamespaceRow { name: string; status: string; age: string }
/** A Service's backing pod IPs. name == the Service name (Endpoints object name). */
export interface EndpointRow { name: string; namespace: string; ips: string[] }
export interface EventRow {
  kind: string; object: string; reason: string; message: string;
  count: number; lastSeen: string; lastSeenTs: number;
}
// EKS 탐색기 rows — 요약 메타데이터만 (configmap/secret VALUES는 절대 미전송).
export interface ReplicaSetRow { name: string; namespace: string; desired: number; ready: number; age: string }
export interface DaemonSetRow { name: string; namespace: string; desired: number; current: number; ready: number; age: string }
export interface StatefulSetRow { name: string; namespace: string; ready: string; age: string }
export interface JobRow { name: string; namespace: string; completions: string; status: string; age: string }
export interface ConfigMapRow { name: string; namespace: string; keys: number; age: string }
export interface PvcRow { name: string; namespace: string; status: string; volume: string; capacity: string; storageClass: string; age: string }

export type InClusterRow =
  | NodeRow | PodRow | DeploymentRow | ServiceRow | NamespaceRow | EventRow | EndpointRow
  | ReplicaSetRow | DaemonSetRow | StatefulSetRow | JobRow | ConfigMapRow | PvcRow;

export function normalizeEndpoint(it: K8sItem): EndpointRow {
  const ips = (it.subsets ?? []).flatMap((s) => (s.addresses ?? []).map((a) => a.ip ?? '').filter(Boolean));
  return { name: it.metadata?.name ?? '', namespace: it.metadata?.namespace ?? '', ips };
}

function nodeRoles(labels: Record<string, string> = {}): string {
  const roles = Object.keys(labels)
    .filter((k) => k.startsWith('node-role.kubernetes.io/'))
    .map((k) => k.slice('node-role.kubernetes.io/'.length))
    .filter(Boolean);
  if (roles.length) return roles.join(',');
  // EKS managed/Karpenter/Fargate workers carry no node-role label (kubectl shows <none>) —
  // surface the pool identity instead so the column carries real signal.
  const ng = labels['eks.amazonaws.com/nodegroup'];
  if (ng) return `nodegroup:${ng}`;
  const pool = labels['karpenter.sh/nodepool'] ?? labels['karpenter.sh/provisioner-name'];
  if (pool) return `karpenter:${pool}`;
  if (labels['eks.amazonaws.com/compute-type'] === 'fargate') return 'fargate';
  return 'worker';
}

export function normalizeNode(it: K8sItem): NodeRow {
  const labels = it.metadata?.labels ?? {};
  const specAny = (it.spec ?? {}) as Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
  const ready = it.status?.conditions?.find((c) => c.type === 'Ready');
  const cap = it.status?.capacity ?? {};
  const alloc = it.status?.allocatable ?? {};
  const taints = (it.spec?.taints ?? []).map((t) => ({
    key: t.key ?? '',
    value: t.value ?? '',
    effect: t.effect ?? '',
  }));
  const conditions = (it.status?.conditions ?? []).map((c) => ({
    type: c.type ?? '',
    status: c.status ?? '',
    reason: c.reason ?? '',
    message: c.message ?? '',
  }));
  return {
    name: it.metadata?.name ?? '',
    status: ready?.status === 'True' ? 'Ready' : 'NotReady',
    roles: nodeRoles(labels),
    version: it.status?.nodeInfo?.kubeletVersion ?? '',
    instanceType: labels['node.kubernetes.io/instance-type'] ?? labels['beta.kubernetes.io/instance-type'] ?? '',
    zone: labels['topology.kubernetes.io/zone'] ?? labels['failure-domain.beta.kubernetes.io/zone'] ?? '',
    age: age(it.metadata?.creationTimestamp),
    cpuCapacity: parseCpuCores(cap.cpu),
    cpuAllocatable: parseCpuCores(alloc.cpu),
    memCapacity: parseMem(cap.memory),
    memAllocatable: parseMem(alloc.memory),
    diskCapacity: parseMem(cap['ephemeral-storage']),
    diskAllocatable: parseMem(alloc['ephemeral-storage']),
    ...(Object.keys(labels).length ? { labels } : {}),
    ...(taints.length ? { taints } : {}),
    ...(conditions.length ? { conditions } : {}),
    podCIDR: typeof specAny.podCIDR === 'string' ? specAny.podCIDR : undefined,
    createdAt: it.metadata?.creationTimestamp,
  };
}

/** Owning workload for a pod: Deployment (strip ReplicaSet hash) / StatefulSet / DaemonSet, else label/app. */
export function podWorkload(it: K8sItem): string {
  const owner = it.metadata?.ownerReferences?.[0];
  if (owner?.name) {
    // ReplicaSet name = <deployment>-<rs-hash> → strip the trailing hash to get the Deployment.
    if (owner.kind === 'ReplicaSet') return owner.name.replace(/-[a-z0-9]+$/, '');
    return owner.name;
  }
  const l = it.metadata?.labels ?? {};
  return l['app.kubernetes.io/name'] || l['app'] || it.metadata?.name || '';
}

export function normalizePod(it: K8sItem): PodRow {
  const restarts = (it.status?.containerStatuses ?? []).reduce((s, c) => s + (c.restartCount ?? 0), 0);
  // Effective pod request = max(sum(app containers), max(init container)) + overhead —
  // the scheduler's reservation semantics, so node bars match `kubectl describe node`
  // (P4 gate: codex — app-container sum alone underreports init-heavy pods).
  const app = (it.spec?.containers ?? []).map((c) => c.resources?.requests ?? {});
  const init = (it.spec?.initContainers ?? []).map((c) => c.resources?.requests ?? {});
  const eff = (sum: number, mx: number, overhead: number) => Math.max(sum, mx) + overhead;
  return {
    name: it.metadata?.name ?? '',
    namespace: it.metadata?.namespace ?? '',
    status: it.status?.phase ?? '',
    node: it.spec?.nodeName ?? '',
    restarts,
    age: age(it.metadata?.creationTimestamp),
    podIP: it.status?.podIP ?? '',
    workload: podWorkload(it),
    cpuRequest: eff(
      app.reduce((s, r) => s + parseCpuCores(r.cpu), 0),
      init.reduce((mx, r) => Math.max(mx, parseCpuCores(r.cpu)), 0),
      parseCpuCores(it.spec?.overhead?.cpu),
    ),
    memRequest: eff(
      app.reduce((s, r) => s + parseMem(r.memory), 0),
      init.reduce((mx, r) => Math.max(mx, parseMem(r.memory)), 0),
      parseMem(it.spec?.overhead?.memory),
    ),
    diskRequest: eff(
      app.reduce((s, r) => s + parseMem(r['ephemeral-storage']), 0),
      init.reduce((mx, r) => Math.max(mx, parseMem(r['ephemeral-storage'])), 0),
      parseMem(it.spec?.overhead?.['ephemeral-storage']),
    ),
  };
}

export function normalizeDeployment(it: K8sItem): DeploymentRow {
  const desired = it.spec?.replicas ?? 0;
  const ready = it.status?.readyReplicas ?? 0;
  return {
    name: it.metadata?.name ?? '',
    namespace: it.metadata?.namespace ?? '',
    ready: `${ready}/${desired}`,
    upToDate: it.status?.updatedReplicas ?? 0,
    available: it.status?.availableReplicas ?? 0,
    age: age(it.metadata?.creationTimestamp),
  };
}

export function normalizeService(it: K8sItem): ServiceRow {
  const ports = (it.spec?.ports ?? [])
    .map((p) => `${p.port}${p.protocol ? `/${p.protocol}` : ''}`)
    .join(',');
  return {
    name: it.metadata?.name ?? '',
    namespace: it.metadata?.namespace ?? '',
    type: it.spec?.type ?? '',
    clusterIP: it.spec?.clusterIP ?? '',
    ports,
    age: age(it.metadata?.creationTimestamp),
  };
}

export function normalizeNamespace(it: K8sItem): NamespaceRow {
  return {
    name: it.metadata?.name ?? '',
    status: it.status?.phase ?? '',
    age: age(it.metadata?.creationTimestamp),
  };
}

export function normalizeEvent(it: K8sItem): EventRow {
  const ns = it.metadata?.namespace;
  const name = it.involvedObject?.name ?? '';
  // events.k8s.io/v1 renames count/lastTimestamp → deprecatedCount/series; the
  // core /api/v1/events endpoint preserves the fields these fallbacks read.
  // series.lastObservedTime is the freshest signal for high-frequency events
  // (kubectl LAST SEEN order) — then lastTimestamp → eventTime → creationTimestamp
  // (P4 gate: gemini).
  const ts = it.series?.lastObservedTime ?? it.lastTimestamp ?? it.eventTime ?? it.metadata?.creationTimestamp ?? '';
  const tsMs = ts ? Date.parse(ts) : 0;
  return {
    kind: it.involvedObject?.kind ?? '',
    object: ns ? `${ns}/${name}` : name, // namespace embedded in object (by design)
    reason: it.reason ?? '',
    message: it.message ?? '',
    count: it.count ?? 1,
    lastSeen: age(ts),
    lastSeenTs: Number.isFinite(tsMs) ? tsMs : 0,
  };
}

// EKS 탐색기 normalizers — SUMMARY metadata only. K8sItem is typed for the classic kinds, so the
// explorer kinds read their extra fields via a narrow local cast (never the raw payload passthrough).
type AnyObj = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

export function normalizeReplicaSet(it: K8sItem): ReplicaSetRow {
  const o = it as AnyObj;
  return {
    name: it.metadata?.name ?? '', namespace: it.metadata?.namespace ?? '',
    desired: Number(o.spec?.replicas ?? 0), ready: Number(o.status?.readyReplicas ?? 0),
    age: age(it.metadata?.creationTimestamp),
  };
}
export function normalizeDaemonSet(it: K8sItem): DaemonSetRow {
  const o = it as AnyObj;
  return {
    name: it.metadata?.name ?? '', namespace: it.metadata?.namespace ?? '',
    desired: Number(o.status?.desiredNumberScheduled ?? 0),
    current: Number(o.status?.currentNumberScheduled ?? 0),
    ready: Number(o.status?.numberReady ?? 0),
    age: age(it.metadata?.creationTimestamp),
  };
}
export function normalizeStatefulSet(it: K8sItem): StatefulSetRow {
  const o = it as AnyObj;
  return {
    name: it.metadata?.name ?? '', namespace: it.metadata?.namespace ?? '',
    ready: `${Number(o.status?.readyReplicas ?? 0)}/${Number(o.spec?.replicas ?? 0)}`,
    age: age(it.metadata?.creationTimestamp),
  };
}
export function normalizeJob(it: K8sItem): JobRow {
  const o = it as AnyObj;
  const conds = (o.status?.conditions ?? []) as AnyObj[];
  const done = conds.find((c) => c.type === 'Complete' && c.status === 'True');
  const failed = conds.find((c) => c.type === 'Failed' && c.status === 'True');
  return {
    name: it.metadata?.name ?? '', namespace: it.metadata?.namespace ?? '',
    completions: `${Number(o.status?.succeeded ?? 0)}/${Number(o.spec?.completions ?? 1)}`,
    status: failed ? 'Failed' : done ? 'Complete' : 'Running',
    age: age(it.metadata?.creationTimestamp),
  };
}
export function normalizeConfigMap(it: K8sItem): ConfigMapRow {
  // METADATA ONLY — key COUNT, never key names or values (values can carry credentials-ish config).
  const o = it as AnyObj;
  const keys = Object.keys(o.data ?? {}).length + Object.keys(o.binaryData ?? {}).length;
  return { name: it.metadata?.name ?? '', namespace: it.metadata?.namespace ?? '', keys, age: age(it.metadata?.creationTimestamp) };
}
export function normalizePvc(it: K8sItem): PvcRow {
  const o = it as AnyObj;
  return {
    name: it.metadata?.name ?? '', namespace: it.metadata?.namespace ?? '',
    status: String(o.status?.phase ?? ''), volume: String(o.spec?.volumeName ?? ''),
    capacity: String(o.status?.capacity?.storage ?? o.spec?.resources?.requests?.storage ?? ''),
    storageClass: String(o.spec?.storageClassName ?? ''),
    age: age(it.metadata?.creationTimestamp),
  };
}

const NORMALIZERS: Record<Kind, (it: K8sItem) => InClusterRow> = {
  nodes: normalizeNode,
  pods: normalizePod,
  deployments: normalizeDeployment,
  services: normalizeService,
  namespaces: normalizeNamespace,
  events: normalizeEvent,
  endpoints: normalizeEndpoint,
  replicasets: normalizeReplicaSet,
  daemonsets: normalizeDaemonSet,
  statefulsets: normalizeStatefulSet,
  jobs: normalizeJob,
  configmaps: normalizeConfigMap,
  pvcs: normalizePvc,
};

/** HTTPS GET against the cluster K8s API, verifying TLS with the cluster CA. */
function k8sGet(endpoint: string, path: string, token: string, caPem: Buffer): Promise<string> {
  const u = new URL(endpoint);
  return new Promise((resolve, reject) => {
    const r = https.request(
      {
        hostname: u.hostname,
        port: u.port || 443,
        path,
        method: 'GET',
        headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
        agent: new https.Agent({ ca: caPem }),
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (d) => chunks.push(d as Buffer));
        res.on('end', () => {
          const body = Buffer.concat(chunks).toString('utf8');
          const status = res.statusCode ?? 0;
          if (status < 200 || status >= 300) {
            let msg = `HTTP ${status}`;
            try { msg = (JSON.parse(body) as { message?: string }).message ?? msg; } catch { /* keep msg */ }
            reject(new Error(msg));
            return;
          }
          resolve(body);
        });
      },
    );
    r.on('error', reject);
    // Server-side bound: a slow/stuck K8s API must not occupy the web task indefinitely
    // (thin-BFF). On timeout, destroy the socket → 'error' rejects this read; callers
    // (e.g. /api/eks/fleet) degrade that cluster to empty rather than hanging the request.
    r.setTimeout(K8S_REQUEST_TIMEOUT_MS, () => r.destroy(new Error('k8s request timeout')));
    r.end();
  });
}

/** GET an arbitrary in-cluster API path (e.g. an OpenCost service-proxy URL). Raw body string. */
export async function k8sGetPath(cluster: string, path: string): Promise<string> {
  const { endpoint, caPem } = await clusterConn(cluster);
  const token = await eksToken(cluster, REGION);
  return k8sGet(endpoint, path, token, caPem);
}

// ── describe (탐색기 심층 조회) — full object GET, read-only. managedFields stripped (huge);
// configmap data/binaryData VALUES are redacted (키 이름만) — the metadata-only invariant holds
// for describe too. Secrets are not a Kind, so they can never be described.
const DESCRIBE_BASE: Partial<Record<Kind, { base: string; namespaced: boolean }>> = {
  nodes: { base: '/api/v1/nodes', namespaced: false },
  pods: { base: '/api/v1/namespaces/{ns}/pods', namespaced: true },
  deployments: { base: '/apis/apps/v1/namespaces/{ns}/deployments', namespaced: true },
  services: { base: '/api/v1/namespaces/{ns}/services', namespaced: true },
  replicasets: { base: '/apis/apps/v1/namespaces/{ns}/replicasets', namespaced: true },
  daemonsets: { base: '/apis/apps/v1/namespaces/{ns}/daemonsets', namespaced: true },
  statefulsets: { base: '/apis/apps/v1/namespaces/{ns}/statefulsets', namespaced: true },
  jobs: { base: '/apis/batch/v1/namespaces/{ns}/jobs', namespaced: true },
  configmaps: { base: '/api/v1/namespaces/{ns}/configmaps', namespaced: true },
  pvcs: { base: '/api/v1/namespaces/{ns}/persistentvolumeclaims', namespaced: true },
};

export function isDescribableKind(k: string): k is Kind {
  return isKind(k) && k in DESCRIBE_BASE;
}

export async function describeInCluster(
  cluster: string, kind: Kind, name: string, namespace?: string,
): Promise<Record<string, unknown>> {
  const spec = DESCRIBE_BASE[kind];
  if (!spec) throw new Error(`kind not describable: ${kind}`);
  if (spec.namespaced && !namespace) throw new Error('namespace required');
  const base = spec.namespaced ? spec.base.replace('{ns}', encodeURIComponent(namespace!)) : spec.base;
  const { endpoint, caPem } = await clusterConn(cluster);
  const token = await eksToken(cluster, REGION);
  const body = await k8sGet(endpoint, `${base}/${encodeURIComponent(name)}`, token, caPem);
  const obj = JSON.parse(body) as Record<string, unknown>;
  const meta = obj.metadata as Record<string, unknown> | undefined;
  if (meta) delete meta.managedFields; // noise — huge and useless for diagnosis
  if (kind === 'configmaps') {
    for (const field of ['data', 'binaryData'] as const) {
      const d = obj[field] as Record<string, unknown> | undefined;
      if (d) obj[field] = Object.fromEntries(Object.keys(d).map((k) => [k, '(redacted)']));
    }
  }
  return obj;
}

export async function listInCluster(cluster: string, kind: Kind): Promise<InClusterRow[]> {
  const { endpoint, caPem } = await clusterConn(cluster);
  const token = await eksToken(cluster, REGION);
  const body = await k8sGet(endpoint, KIND_PATH[kind], token, caPem);
  const parsed = JSON.parse(body) as K8sList;
  const norm = NORMALIZERS[kind];
  return (parsed.items ?? []).map(norm);
}

// ── K8sGPT Result CRDs (ADR-035) — SAME presigned-STS token path, different API group ─────
// result.core.k8sgpt.ai/v1, namespaced `results`; cluster-wide collection across namespaces.
// READ-ONLY: a single HTTP GET, exactly like listInCluster. AWSops issues NO write verb.
const K8SGPT_RESULTS_PATH = '/apis/result.core.k8sgpt.ai/v1/results';

import type { K8sgptResultCrd } from '@/lib/k8sgpt-adapter';

/** GET the K8sGPT Result CRD collection. Throws on transport/HTTP error (caller degrades gracefully).
 *  A 404 here typically means the operator/CRD is absent → the caller treats it as "no operator". */
export async function listK8sgptResults(cluster: string): Promise<K8sgptResultCrd[]> {
  const { endpoint, caPem } = await clusterConn(cluster);   // reuse P3-D DescribeCluster+CA (cached)
  const token = await eksToken(cluster, REGION);            // reuse P3-D presigned-STS bearer
  const body = await k8sGet(endpoint, K8SGPT_RESULTS_PATH, token, caPem); // reuse P3-D GET-with-CA
  const parsed = JSON.parse(body) as { items?: K8sgptResultCrd[] };
  return parsed.items ?? [];
}
