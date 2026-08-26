// web/lib/ssrf-guard.ts
// ADR-039 §11 / ADR-011 — static SSRF host blocklist for egress integration REGISTRATION.
// v2 runs in-VPC (mgmt-vpc, near 169.254.169.254 + the internal ALB), so an admin-registered egress
// endpoint pointing at a private/link-local/metadata address is the SSRF risk this guards.
// NOTE: there is NO v1 code to mirror (src/lib/datasource-client.ts does not implement this); the
// CIDRs are taken from ADR-011's decision. DNS-resolution-before-request + redirect:'manual' are the
// CONNECTION-TIME defenses (P2-infra); this module is the registration-time literal-host/IP guard.

function ipv4Blocked(a: number, b: number): boolean {
  return (
    a === 10 ||                       // 10.0.0.0/8
    (a === 172 && b >= 16 && b <= 31) || // 172.16.0.0/12
    (a === 192 && b === 168) ||       // 192.168.0.0/16
    (a === 169 && b === 254) ||       // 169.254.0.0/16 (incl. 169.254.169.254 metadata)
    a === 127                          // 127.0.0.0/8 loopback
  );
}

function parseIpv4(host: string): [number, number, number, number] | null {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (!m) return null;
  const o = m.slice(1, 5).map(Number) as [number, number, number, number];
  if (o.some((n) => n > 255)) return null;
  return o;
}

/** Decode a 6to4 IPv6 literal (2002:WWXX:YYZZ::/16) to its embedded IPv4 WW.XX.YY.ZZ, else null.
 *  Mirrors datasource_http `_ip_always_blocked`'s `sixtofour` normalization so a 6to4-wrapped
 *  metadata/loopback target (e.g. 2002:a9fe:a9fe:: = 169.254.169.254) can't evade the IPv4 checks. */
function sixToFour(host: string): string | null {
  const m = /^2002:([0-9a-f]{1,4}):([0-9a-f]{1,4})(?::|$)/i.exec(host);
  if (!m) return null;
  const h1 = parseInt(m[1], 16), h2 = parseInt(m[2], 16);
  return `${(h1 >> 8) & 255}.${h1 & 255}.${(h2 >> 8) & 255}.${h2 & 255}`;
}

/** True for a LITERAL private/link-local/loopback/metadata IP (v4 or v6). Non-literal hostnames → false
 *  (their resolution is deferred to connection time, P2-infra). */
export function isBlockedHost(hostOrIp: string): boolean {
  const host = hostOrIp.trim().replace(/^\[/, '').replace(/\]$/, '').toLowerCase();
  const v4 = parseIpv4(host);
  if (v4) return ipv4Blocked(v4[0], v4[1]);
  if (host.includes(':')) {
    // IPv6 literal
    if (host === '::1' || host === '0:0:0:0:0:0:0:1') return true;     // loopback
    if (/^f[cd][0-9a-f]*:/.test(host) || host.startsWith('fc') || host.startsWith('fd')) return true; // fc00::/7 ULA
    if (/^fe[89ab][0-9a-f]*:/.test(host)) return true;                // fe80::/10 link-local
    // IPv4-mapped IPv6 (::ffff:a.b.c.d)
    const mapped = /::ffff:(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/i.exec(host);
    if (mapped) return isBlockedHost(mapped[1]);
    const s2 = sixToFour(host);
    if (s2) return isBlockedHost(s2);                                 // 6to4 (2002::/16) → embedded IPv4
  }
  return false;
}

/** Throw if a registered egress endpoint is unsafe: non-https, or a literal blocked host unless the
 *  per-account `allowPrivate` (ADR-011 allowPrivateDatasource) opt-in is set. */
export function assertEgressEndpointAllowed(urlString: string, opts: { allowPrivate?: boolean } = {}): void {
  let url: URL;
  try { url = new URL(urlString); } catch { throw new Error('endpoint must be a valid URL'); }
  if (url.protocol !== 'https:') throw new Error('endpoint must use https');
  if (isBlockedHost(url.hostname) && !opts.allowPrivate) {
    throw new Error(`endpoint host ${url.hostname} is a private/metadata address; enable allowPrivateDatasource for this account to permit it`);
  }
}

/** True for a LITERAL ALWAYS-BLOCKED IP — metadata / loopback / link-local / multicast / unspecified /
 *  broadcast — i.e. blocked even for datasources (which otherwise ALLOW private RFC1918/ULA). Mirrors
 *  agent.py `_ip_always_blocked`. RFC1918 (10/172.16/192.168) and ULA fc00::/7 are NOT blocked here
 *  (in-cluster datasources are the intended target); the metadata IPv6 fd00:ec2::254 IS blocked. */
export function isAlwaysBlockedHost(hostOrIp: string): boolean {
  const host = hostOrIp.trim().replace(/^\[/, '').replace(/\]$/, '').toLowerCase();
  const v4 = parseIpv4(host);
  if (v4) {
    const [a, b] = v4;
    return (
      a === 127 ||                       // loopback
      (a === 169 && b === 254) ||        // link-local incl. 169.254.169.254 metadata
      (a >= 224 && a <= 239) ||          // multicast
      a === 0 ||                         // unspecified/this-network
      v4.join('.') === '255.255.255.255' // broadcast
    );
  }
  if (host.includes(':')) {
    if (host === '::1' || host === '0:0:0:0:0:0:0:1' || host === '::') return true; // loopback / unspecified
    if (host === 'fd00:ec2::254') return true;                                       // IPv6 IMDS metadata
    if (/^fe[89ab][0-9a-f]*:/.test(host)) return true;                               // fe80::/10 link-local
    if (/^ff[0-9a-f]{2}:/.test(host)) return true;                                   // ff00::/8 multicast
    const mapped = /::ffff:(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/i.exec(host);
    if (mapped) return isAlwaysBlockedHost(mapped[1]);
    const s2 = sixToFour(host);
    if (s2) return isAlwaysBlockedHost(s2);                           // 6to4 (2002::/16) → embedded IPv4
  }
  return false;
}

/** Throw if a user-supplied DATASOURCE endpoint (ClickHouse/Prometheus/Loki/…) is unsafe: only
 *  http/https schemes; a literal ALWAYS-BLOCKED host (metadata/loopback/link-local/multicast) is
 *  rejected. Private RFC1918/ULA is ALLOWED (in-cluster datasources). Non-literal hostnames pass the
 *  registration guard and are re-checked at connection time by the connector Lambda (datasource_http). */
export function assertDatasourceEndpointAllowed(urlString: string): void {
  let url: URL;
  try { url = new URL(urlString); } catch { throw new Error('endpoint must be a valid URL'); }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error(`endpoint scheme ${url.protocol} not allowed (http/https only)`);
  }
  if (isAlwaysBlockedHost(url.hostname)) {
    throw new Error(`endpoint host ${url.hostname} is a metadata/loopback/link-local address (blocked)`);
  }
}
