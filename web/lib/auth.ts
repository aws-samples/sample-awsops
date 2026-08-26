import { createRemoteJWKSet, jwtVerify } from 'jose';

export interface User {
  sub: string;
  email?: string;
  groups?: string[];
}

function parseCookie(header: string | null, name: string): string | null {
  if (!header) return null;
  for (const part of header.split(';')) {
    const [k, ...v] = part.trim().split('=');
    if (k === name) return v.join('=');
  }
  return null;
}

let jwks: ReturnType<typeof createRemoteJWKSet> | null = null;
function getJwks() {
  if (!jwks) {
    const region = process.env.AWS_REGION || 'ap-northeast-2';
    const pool = process.env.COGNITO_USER_POOL_ID;
    jwks = createRemoteJWKSet(
      new URL(`https://cognito-idp.${region}.amazonaws.com/${pool}/.well-known/jwks.json`),
    );
  }
  return jwks;
}

/** Re-verify the edge-set Cognito id_token (awsops_token cookie). Returns the user or null. */
export async function verifyUser(cookieHeader: string | null): Promise<User | null> {
  const token = parseCookie(cookieHeader, 'awsops_token');
  if (!token) return null;
  const region = process.env.AWS_REGION || 'ap-northeast-2';
  const pool = process.env.COGNITO_USER_POOL_ID;
  try {
    const { payload } = await jwtVerify(token, getJwks(), {
      issuer: `https://cognito-idp.${region}.amazonaws.com/${pool}`,
      audience: process.env.COGNITO_CLIENT_ID,
      algorithms: ['RS256'], // Cognito id tokens are always RS256; pin to block alg-confusion
    });
    if (payload.token_use !== 'id' || !payload.sub) return null;
    const rawGroups = (payload as Record<string, unknown>)['cognito:groups'];
    const groups = Array.isArray(rawGroups) ? rawGroups.map(String) : [];
    return {
      sub: String(payload.sub),
      email: payload.email ? String(payload.email) : undefined,
      groups,
    };
  } catch {
    return null;
  }
}
