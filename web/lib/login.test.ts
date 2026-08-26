import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { sessionCookie, safeNext } from './login';

beforeEach(() => {
  process.env.COGNITO_CLIENT_ID = 'client123';
  process.env.AWS_REGION = 'ap-northeast-2';
});

afterEach(() => {
  vi.unstubAllGlobals();
});

function jsonResponse(body: unknown, init?: { status?: number }) {
  return new Response(JSON.stringify(body), {
    status: init?.status ?? 200,
    headers: { 'Content-Type': 'application/x-amz-json-1.1' },
  });
}

describe('initiateAuth', () => {
  it('returns ok with idToken and expiresIn on success', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        jsonResponse({ AuthenticationResult: { IdToken: 'eyJ.id.tok', ExpiresIn: 43200 } }),
      ),
    );
    const { initiateAuth } = await import('./login');
    const res = await initiateAuth('admin@example.com', 'pw');
    expect(res).toEqual({ ok: true, idToken: 'eyJ.id.tok', expiresIn: 43200 });
  });

  it('sends the correct cognito-idp request shape', async () => {
    const fetchMock = vi.fn(async () =>
      jsonResponse({ AuthenticationResult: { IdToken: 'tok', ExpiresIn: 43200 } }),
    );
    vi.stubGlobal('fetch', fetchMock);
    const { initiateAuth } = await import('./login');
    await initiateAuth('admin@example.com', 'pw');

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://cognito-idp.ap-northeast-2.amazonaws.com/');
    expect(init.method).toBe('POST');
    const headers = init.headers as Record<string, string>;
    expect(headers['X-Amz-Target']).toBe('AWSCognitoIdentityProviderService.InitiateAuth');
    expect(headers['Content-Type']).toBe('application/x-amz-json-1.1');
    const body = JSON.parse(init.body as string);
    expect(body.AuthFlow).toBe('USER_PASSWORD_AUTH');
    expect(body.ClientId).toBe('client123');
    expect(body.AuthParameters).toEqual({ USERNAME: 'admin@example.com', PASSWORD: 'pw' });
  });

  it('maps NotAuthorizedException to invalid_credentials', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        jsonResponse(
          { __type: 'NotAuthorizedException', message: 'Incorrect username or password.' },
          { status: 400 },
        ),
      ),
    );
    const { initiateAuth } = await import('./login');
    expect(await initiateAuth('a@b.com', 'wrong')).toEqual({ ok: false, code: 'invalid_credentials' });
  });

  it('maps UserNotFoundException to invalid_credentials', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        jsonResponse({ __type: 'UserNotFoundException', message: 'User does not exist.' }, { status: 400 }),
      ),
    );
    const { initiateAuth } = await import('./login');
    expect(await initiateAuth('a@b.com', 'pw')).toEqual({ ok: false, code: 'invalid_credentials' });
  });

  it('maps a ChallengeName response to challenge', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => jsonResponse({ ChallengeName: 'NEW_PASSWORD_REQUIRED', Session: 'sess' })),
    );
    const { initiateAuth } = await import('./login');
    expect(await initiateAuth('a@b.com', 'pw')).toEqual({ ok: false, code: 'challenge' });
  });

  it('maps PasswordResetRequiredException to challenge', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        jsonResponse({ __type: 'PasswordResetRequiredException', message: 'reset' }, { status: 400 }),
      ),
    );
    const { initiateAuth } = await import('./login');
    expect(await initiateAuth('a@b.com', 'pw')).toEqual({ ok: false, code: 'challenge' });
  });

  it('maps a network error to unavailable', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error('ECONNREFUSED');
      }),
    );
    const { initiateAuth } = await import('./login');
    expect(await initiateAuth('a@b.com', 'pw')).toEqual({ ok: false, code: 'unavailable' });
  });

  it('maps a 5xx response to unavailable', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        jsonResponse({ __type: 'InternalErrorException', message: 'boom' }, { status: 500 }),
      ),
    );
    const { initiateAuth } = await import('./login');
    expect(await initiateAuth('a@b.com', 'pw')).toEqual({ ok: false, code: 'unavailable' });
  });
});

describe('sessionCookie', () => {
  it('sets the awsops_token cookie with the security attributes', () => {
    const c = sessionCookie('eyJ.tok', false, 43200);
    expect(c).toContain('awsops_token=eyJ.tok');
    expect(c).toContain('Path=/');
    expect(c).toContain('Secure');
    expect(c).toContain('HttpOnly');
    expect(c).toContain('SameSite=Lax');
  });

  it('omits Max-Age when remember is false (session cookie)', () => {
    const c = sessionCookie('tok', false, 43200);
    expect(c).not.toContain('Max-Age');
  });

  it('includes the exact Max-Age when remember is true (persistent cookie)', () => {
    const c = sessionCookie('tok', true, 43200);
    expect(c).toContain('Max-Age=43200');
  });
});

describe('safeNext', () => {
  it('allows a same-origin relative path', () => {
    expect(safeNext('/cost')).toBe('/cost');
    expect(safeNext('/eks/pods?ns=default')).toBe('/eks/pods?ns=default');
  });

  it('allows a path with @ (same-origin path, not an authority)', () => {
    expect(safeNext('/@evil.com')).toBe('/@evil.com');
  });

  it('rejects protocol-relative //evil.com', () => {
    expect(safeNext('//evil.com')).toBe('/');
  });

  it('rejects backslash-bypass /\\evil.com (browsers normalize \\ to /)', () => {
    expect(safeNext('/\\evil.com')).toBe('/');
  });

  it('rejects an absolute URL', () => {
    expect(safeNext('https://evil.com')).toBe('/');
  });

  it('rejects an over-length value (> 2048)', () => {
    const long = '/' + 'a'.repeat(2049);
    expect(safeNext(long)).toBe('/');
  });

  it('rejects empty / non-path input', () => {
    expect(safeNext('')).toBe('/');
    expect(safeNext('cost')).toBe('/');
  });
});
