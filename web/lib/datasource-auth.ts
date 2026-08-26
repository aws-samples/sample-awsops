// web/lib/datasource-auth.ts
// Builds outbound HTTP auth headers for a datasource connection from an explicit auth method.
// Mirrors the connector Lambda's logic (agent/lambda/datasource_http.py auth_headers) but driven by
// an explicit `authType` (the UI selector) rather than inferring from which fields are filled.
//
// SECURITY: never log the returned headers. Custom headers are validated against header-injection
// (CRLF/control chars) and forbidden names so a custom-header datasource cannot smuggle in Host/
// Content-Length/Authorization or split the request.

export type AuthType = 'none' | 'basic' | 'bearer' | 'custom_header';

export interface DatasourceCreds {
  username?: string;
  password?: string;
  token?: string;
  headerName?: string;
  headerValue?: string;
  /** Optional SECOND custom header — Datadog auth is a DD-API-KEY + DD-APPLICATION-KEY pair. */
  headerName2?: string;
  headerValue2?: string;
  org_id?: string;
}

// RFC 7230 token: header field-name grammar (no separators / control chars / whitespace).
const HEADER_NAME_RE = /^[A-Za-z0-9!#$%&'*+.^_`|~-]+$/;
// Names a custom header may never set (would let a datasource override transport-critical headers).
const FORBIDDEN_HEADER_NAMES = new Set(['host', 'content-length', 'authorization']);
// Any control char (incl. CR/LF/NUL) in a header value is a request-splitting vector.
const HAS_CONTROL_CHAR = /[\x00-\x1f\x7f]/;

function assertSafeCustomHeader(name: string, value: string): void {
  if (!name || !HEADER_NAME_RE.test(name)) {
    throw new Error('invalid custom header name');
  }
  if (FORBIDDEN_HEADER_NAMES.has(name.toLowerCase())) {
    throw new Error(`custom header name not allowed: ${name}`);
  }
  if (HAS_CONTROL_CHAR.test(value)) {
    throw new Error('custom header value contains control characters');
  }
}

/**
 * Returns the auth headers for the given method. `none` (and any empty creds) yields no
 * Authorization header — auth is optional by design. `X-Scope-OrgID` is added whenever `org_id` is
 * present, regardless of auth type (Loki/Tempo/Mimir multi-tenancy scope).
 */
export function buildAuthHeaders(authType: AuthType, creds: DatasourceCreds): Record<string, string> {
  const headers: Record<string, string> = {};

  switch (authType) {
    case 'basic': {
      if (creds.username) {
        const raw = `${creds.username}:${creds.password ?? ''}`;
        headers.Authorization = 'Basic ' + Buffer.from(raw).toString('base64');
      }
      break;
    }
    case 'bearer': {
      if (creds.token) headers.Authorization = `Bearer ${creds.token}`;
      break;
    }
    case 'custom_header': {
      // Up to TWO custom headers — Datadog needs the DD-API-KEY + DD-APPLICATION-KEY pair.
      for (const [n, v] of [
        [creds.headerName, creds.headerValue],
        [creds.headerName2, creds.headerValue2],
      ] as const) {
        if (n || v) {
          const name = n ?? '';
          const value = v ?? '';
          assertSafeCustomHeader(name, value);
          headers[name] = value;
        }
      }
      break;
    }
    case 'none':
    default:
      break;
  }

  if (creds.org_id) headers['X-Scope-OrgID'] = creds.org_id;
  return headers;
}
