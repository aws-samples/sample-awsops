// Login core logic for the v2 in-app /login form.
//
// InitiateAuth (USER_PASSWORD_AUTH) is an *unsigned* public Cognito operation, so we
// call cognito-idp over plain fetch with no SDK dependency. The BFF route is a thin
// adapter over these pure helpers.
//
// Coupling contract: the cookie name `awsops_token` MUST match the edge Lambda template
// (cognito_edge.py.tftpl) and lib/auth.ts — change all sites together.

/** Result of an InitiateAuth attempt. Discriminated on `ok`. */
export type LoginResult =
  | { ok: true; idToken: string; expiresIn: number }
  | { ok: false; code: 'invalid_credentials' | 'challenge' | 'unavailable' };

const COOKIE_NAME = 'awsops_token';

function region(): string {
  return process.env.AWS_REGION || 'ap-northeast-2';
}

/**
 * Authenticate against Cognito via the unsigned public InitiateAuth operation.
 *
 * - Success → AuthenticationResult.{IdToken,ExpiresIn} (ExpiresIn is in *seconds*).
 * - NotAuthorizedException / UserNotFoundException → invalid_credentials.
 * - Any ChallengeName response (e.g. NEW_PASSWORD_REQUIRED) or
 *   PasswordResetRequiredException → challenge (the seeded admin uses a permanent
 *   password, so challenges are an exceptional path).
 * - Network error / 5xx / unexpected shape → unavailable.
 */
export async function initiateAuth(email: string, password: string): Promise<LoginResult> {
  const url = `https://cognito-idp.${region()}.amazonaws.com/`;
  let resp: Response;
  try {
    resp = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-amz-json-1.1',
        'X-Amz-Target': 'AWSCognitoIdentityProviderService.InitiateAuth',
      },
      body: JSON.stringify({
        AuthFlow: 'USER_PASSWORD_AUTH',
        ClientId: process.env.COGNITO_CLIENT_ID,
        AuthParameters: { USERNAME: email, PASSWORD: password },
      }),
    });
  } catch {
    // Transport failure (DNS / connection reset / timeout).
    return { ok: false, code: 'unavailable' };
  }

  if (resp.status >= 500) return { ok: false, code: 'unavailable' };

  let data: Record<string, unknown>;
  try {
    data = (await resp.json()) as Record<string, unknown>;
  } catch {
    return { ok: false, code: 'unavailable' };
  }

  if (resp.ok) {
    if (data.ChallengeName) return { ok: false, code: 'challenge' };
    const result = data.AuthenticationResult as { IdToken?: string; ExpiresIn?: number } | undefined;
    if (result?.IdToken && typeof result.ExpiresIn === 'number') {
      return { ok: true, idToken: result.IdToken, expiresIn: result.ExpiresIn };
    }
    return { ok: false, code: 'unavailable' };
  }

  // Error responses carry __type like "...#NotAuthorizedException".
  const type = String(data.__type || '');
  if (type.includes('NotAuthorizedException') || type.includes('UserNotFoundException')) {
    return { ok: false, code: 'invalid_credentials' };
  }
  if (type.includes('PasswordResetRequiredException')) {
    return { ok: false, code: 'challenge' };
  }
  return { ok: false, code: 'unavailable' };
}

/**
 * Build the Set-Cookie value carrying the id token.
 *
 * `remember=true` → persistent cookie capped at the token lifetime (`Max-Age={expiresIn}`,
 * seconds). `remember=false` → session cookie (no Max-Age, dies with the browser session).
 */
export function sessionCookie(idToken: string, remember: boolean, expiresIn: number): string {
  let cookie = `${COOKIE_NAME}=${idToken}; Path=/; Secure; HttpOnly; SameSite=Lax`;
  if (remember) cookie += `; Max-Age=${expiresIn}`;
  return cookie;
}

/**
 * Sanitize the `next` redirect to a safe same-origin relative path; otherwise '/'.
 *
 * Allow only: starts with '/', the 2nd char is not '/' or '\\' (blocks //evil.com and the
 * backslash-bypass /\evil.com — browsers normalize '\' to '/'), contains no '\\' anywhere,
 * and length ≤ 2048. '/@evil.com' is allowed (it is a same-origin path, not an authority).
 */
export function safeNext(raw: string): string {
  if (typeof raw !== 'string') return '/';
  if (raw.length === 0 || raw.length > 2048) return '/';
  if (raw[0] !== '/') return '/';
  if (raw[1] === '/' || raw[1] === '\\') return '/';
  if (raw.includes('\\')) return '/';
  return raw;
}
