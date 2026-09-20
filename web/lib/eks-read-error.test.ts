import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const SECRET = 'arn:aws:iam::222222222222:role/private-role ExternalId=private-external SessionToken=private-session';
beforeEach(() => { vi.spyOn(console, 'warn').mockImplementation(() => {}); });
afterEach(() => vi.restoreAllMocks());

describe('EKS read failure classification', () => {
  it.each([
    [{ name: 'AccessDeniedException' }, 'denied'],
    [{ name: 'ForbiddenException' }, 'denied'],
    [{ $metadata: { httpStatusCode: 403, requestId: SECRET } }, 'denied'],
    [{ statusCode: 401 }, 'denied'],
    [{ statusCode: 503 }, 'upstream-error'],
    [{ statusCode: 504 }, 'timeout'],
    [{ name: 'TimeoutError' }, 'timeout'],
    [{ code: 'ETIMEDOUT' }, 'timeout'],
    [{ code: 'ECONNREFUSED' }, 'unreachable'],
    [{ code: 'ENOTFOUND' }, 'unreachable'],
    [{ code: 'EHOSTUNREACH' }, 'unreachable'],
    [{ code: 'EAI_AGAIN' }, 'unreachable'],
  ])('classifies controlled metadata %j as %s without exposing it', async (metadata, reason) => {
    const { eksReadFailure } = await import('./eks-read-error');
    const error = Object.assign(new Error(SECRET), metadata, { cause: SECRET, stack: SECRET });
    const result = eksReadFailure(error, 'incluster-list');
    expect(result.reason).toBe(reason);
    expect(JSON.stringify([result, vi.mocked(console.warn).mock.calls])).not.toContain('private');
    const record = vi.mocked(console.warn).mock.calls[0][0];
    expect(Object.keys(record).sort()).toEqual(['operation', 'reason', 'status']);
    expect(record.operation).toBe('incluster-list');
    expect(record.reason).toBe(reason);
    expect(typeof record.status).toBe('number');
  });

  it.each([
    new Error(`403 TimeoutError ECONNREFUSED ${SECRET}`), SECRET, null,
    { name: SECRET, code: SECRET, statusCode: SECRET, $metadata: { httpStatusCode: SECRET }, message: SECRET },
    { name: 'EksScopeError', status: 403, message: SECRET },
  ])('does not classify raw messages or trust spoofed secret-bearing metadata %#', async error => {
    const { eksReadFailure } = await import('./eks-read-error');
    expect(eksReadFailure(error, 'incluster-list')).toEqual({
      message: 'EKS resources are unavailable.', reason: 'upstream-error',
    });
    expect(console.warn).toHaveBeenCalledWith({ operation: 'incluster-list', reason: 'upstream-error', status: 502 });
  });

  it('preserves a real application scope error and its 403 classification', async () => {
    const { EksScopeError } = await import('./eks-context');
    const { eksReadFailure } = await import('./eks-read-error');
    expect(eksReadFailure(new EksScopeError('EKS account is disabled', 403), 'incluster-list')).toEqual({
      message: 'EKS account is disabled', reason: 'denied',
    });
    expect(console.warn).toHaveBeenCalledWith({ operation: 'incluster-list', reason: 'denied', status: 403 });
  });

  it('uses fixed phrases for classified failures and a controlled operation fallback', async () => {
    const { eksReadFailure } = await import('./eks-read-error');
    expect(eksReadFailure({ statusCode: 403 }, 'incluster-list').message).toBe(
      'EKS resources are unavailable. Access denied; check read permissions.',
    );
    expect(eksReadFailure({ code: 'ECONNREFUSED' }, 'incluster-list').message).toContain('Endpoint unreachable; check network connectivity and DNS.');
    expect(eksReadFailure({ code: 'ETIMEDOUT' }, 'incluster-list').message).toContain('Request timed out; check connectivity and retry.');
    eksReadFailure(new Error(SECRET), SECRET as never);
    expect(JSON.stringify(vi.mocked(console.warn).mock.calls)).not.toContain('private');
  });
});
