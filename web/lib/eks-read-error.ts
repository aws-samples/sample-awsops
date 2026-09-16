// Server-only error boundary. Node's proxy check also prevents inspecting hostile error objects.
import { isProxy } from 'node:util/types';
import { isEksScopeError } from './eks-scope';

export type EksReadReason = 'denied' | 'unreachable' | 'upstream-error' | 'timeout';
export interface EksReadFailure { message: string; reason: EksReadReason }

/** Marks an actual Kubernetes HTTP response, distinct from discovery/scope errors. */
export class EksKubernetesHttpError extends Error {
  constructor(public readonly statusCode: number) {
    super('Kubernetes API request failed.');
    this.name = 'KubernetesHttpError';
  }
}

const OPERATIONS = {
  'eks-read': ['EKS read is unavailable.', 502],
  'incluster-list': ['EKS resources are unavailable.', 502],
  'incluster-describe': ['EKS resource details are unavailable.', 502],
  k8sgpt: ['K8sGPT diagnosis is unavailable.', 502],
  'pod-transfer': ['Pod transfer metrics are unavailable.', 502],
  'node-eni': ['Node ENI details are unavailable.', 500],
  'node-eni-traffic': ['Node traffic metrics are unavailable.', 502],
  'eks-list': ['EKS inventory is unavailable', 500],
  'eks-list-target': ['EKS inventory query failed', 502],
  'eks-fleet': ['EKS scope could not be loaded', 503],
  'eks-fleet-cluster': ['Kubernetes resource read unavailable', 502],
  'eks-fleet-events': ['Kubernetes events are unavailable.', 502],
  'opencost-config': ['OpenCost configuration is unavailable.', 500],
  'opencost-status': ['OpenCost status is unavailable.', 500],
  'opencost-bundle': ['OpenCost bundle is unavailable.', 500],
  'opencost-allocation': ['OpenCost allocation is unavailable.', 200],
} as const;
export type EksReadOperation = keyof typeof OPERATIONS;

const PHRASES: Record<EksReadReason, string> = {
  denied: ' Access denied; check read permissions.',
  unreachable: ' Endpoint unreachable; check network connectivity and DNS.',
  timeout: ' Request timed out; check connectivity and retry.',
  'upstream-error': '',
};
const DENIED = new Set([
  'AccessDenied', 'AccessDeniedException', 'Forbidden', 'ForbiddenException', 'Unauthorized',
  'UnauthorizedException', 'UnauthorizedOperation', 'UnrecognizedClientException',
  'InvalidClientTokenId', 'ExpiredToken', 'ExpiredTokenException', 'InvalidSignatureException',
  'SignatureDoesNotMatch',
]);
const TIMEOUT = new Set([
  'TimeoutError', 'RequestTimeout', 'RequestTimeoutException', 'ETIMEDOUT', 'ESOCKETTIMEDOUT',
  'UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_HEADERS_TIMEOUT', 'UND_ERR_BODY_TIMEOUT',
]);
const UNREACHABLE = new Set(['ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN', 'EHOSTUNREACH', 'ENETUNREACH', 'ECONNRESET', 'EPIPE']);
const HTTP_STATUS = new Set([200, 400, 401, 403, 404, 408, 409, 413, 422, 429, 500, 502, 503, 504]);

function object(value: unknown): value is object {
  return typeof value === 'object' && value !== null && !isProxy(value);
}
/** Never invoke a provider object's getters, coercion, or toJSON. */
function field(value: unknown, key: string): unknown {
  if (!object(value)) return undefined;
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  return descriptor && 'value' in descriptor ? descriptor.value : undefined;
}
function scopeError(error: unknown): boolean {
  return object(error) && isEksScopeError(error);
}
function upstreamStatus(error: unknown): number | undefined {
  const candidates = [
    scopeError(error) ? field(error, 'status') : undefined,
    field(error, 'statusCode'),
    field(field(error, '$metadata'), 'httpStatusCode'),
  ];
  return candidates.find((status): status is number => typeof status === 'number' && HTTP_STATUS.has(status));
}

/** Exact allowlists only: raw error messages, bodies, causes and arbitrary names are not evidence. */
export function classifyEksReadError(error: unknown): EksReadReason {
  const status = upstreamStatus(error);
  const codes = [field(error, 'name'), field(error, 'code')].filter((code): code is string => typeof code === 'string');
  if (status === 401 || status === 403 || codes.some(code => DENIED.has(code))) return 'denied';
  if (status === 408 || status === 504 || codes.some(code => TIMEOUT.has(code))) return 'timeout';
  if (codes.some(code => UNREACHABLE.has(code))) return 'unreachable';
  return 'upstream-error';
}

/** Public response + one controlled diagnostic record. Call only at the boundary handling a failure. */
export function eksReadFailure(error: unknown, operation: EksReadOperation): EksReadFailure {
  const op = typeof operation === 'string' && Object.hasOwn(OPERATIONS, operation) ? operation : 'eks-read';
  const [fallback, fallbackStatus] = OPERATIONS[op];
  const reason = classifyEksReadError(error);
  const expectedMessage = scopeError(error) ? field(error, 'message') : undefined;
  console.warn({ operation: op, reason, status: upstreamStatus(error) ?? fallbackStatus });
  return {
    message: typeof expectedMessage === 'string' ? expectedMessage : fallback + PHRASES[reason],
    reason,
  };
}
