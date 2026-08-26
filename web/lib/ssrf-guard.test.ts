// web/lib/ssrf-guard.test.ts
import { describe, it, expect } from 'vitest';
import { isBlockedHost, assertEgressEndpointAllowed } from './ssrf-guard';

describe('isBlockedHost (ADR-011 blocklist)', () => {
  it('blocks private/link-local/loopback/metadata IPv4', () => {
    for (const ip of ['10.0.0.1', '10.255.255.255', '172.16.0.1', '172.31.255.255', '192.168.1.1', '169.254.169.254', '127.0.0.1']) {
      expect(isBlockedHost(ip)).toBe(true);
    }
  });
  it('allows public IPv4 and the just-outside-range edges', () => {
    for (const ip of ['8.8.8.8', '1.1.1.1', '172.15.0.1', '172.32.0.1', '192.167.0.1', '169.253.0.1']) {
      expect(isBlockedHost(ip)).toBe(false);
    }
  });
  it('blocks IPv6 loopback / ULA / link-local (incl. bracketed)', () => {
    expect(isBlockedHost('::1')).toBe(true);
    expect(isBlockedHost('[::1]')).toBe(true);
    expect(isBlockedHost('fc00::1')).toBe(true);
    expect(isBlockedHost('fd12:3456::1')).toBe(true);
    expect(isBlockedHost('fe80::1')).toBe(true);
    expect(isBlockedHost('::ffff:169.254.169.254')).toBe(true); // IPv4-mapped
    expect(isBlockedHost('2002:a9fe:a9fe::')).toBe(true);  // 6to4 → 169.254.169.254 (metadata)
    expect(isBlockedHost('2002:0a00:0001::')).toBe(true);  // 6to4 → 10.0.0.1 (private, blocked here)
    expect(isBlockedHost('2002:0808:0808::')).toBe(false); // 6to4 → 8.8.8.8 (public, not blocked)
  });
  it('treats non-literal hostnames as not-blocked (DNS resolution is connection-time)', () => {
    expect(isBlockedHost('grafana.example.com')).toBe(false);
    expect(isBlockedHost('api.datadoghq.com')).toBe(false);
  });
});

describe('assertEgressEndpointAllowed', () => {
  it('throws on non-https', () => {
    expect(() => assertEgressEndpointAllowed('http://grafana.example.com')).toThrow(/https/);
  });
  it('throws on an invalid URL', () => {
    expect(() => assertEgressEndpointAllowed('not a url')).toThrow(/valid URL/);
  });
  it('throws on a private/metadata literal host unless allowPrivate', () => {
    expect(() => assertEgressEndpointAllowed('https://169.254.169.254/latest/meta-data')).toThrow(/private\/metadata/);
    expect(() => assertEgressEndpointAllowed('https://10.0.0.5:3000')).toThrow(/private/);
    // opt-in permits it (the legitimate private-datasource case)
    expect(() => assertEgressEndpointAllowed('https://10.0.0.5:3000', { allowPrivate: true })).not.toThrow();
  });
  it('allows a public https endpoint', () => {
    expect(() => assertEgressEndpointAllowed('https://api.datadoghq.com/api/v1')).not.toThrow();
  });
});

import { isAlwaysBlockedHost, assertDatasourceEndpointAllowed } from './ssrf-guard';

describe('assertDatasourceEndpointAllowed (datasource — private allowed, always-block only)', () => {
  it('rejects metadata / loopback / link-local / multicast', () => {
    for (const u of [
      'http://169.254.169.254/latest/meta-data/',
      'http://127.0.0.1:8123',
      'https://[::1]:8123',
      'http://[fd00:ec2::254]/',
      'http://[fe80::1]:8123',
      'http://224.0.0.1:8123',
      'http://[2002:a9fe:a9fe::]:8123', // 6to4 → 169.254.169.254 metadata
    ]) {
      expect(() => assertDatasourceEndpointAllowed(u)).toThrow();
    }
  });
  it('allows private RFC1918/ULA and public, over http or https', () => {
    for (const u of [
      'http://10.0.0.5:8123',
      'http://192.168.1.9:8123',
      'http://172.16.3.4:8123',
      'http://[fc00::1]:8123',
      'https://clickhouse.example.com',
      'http://ch.internal:8123',
    ]) {
      expect(() => assertDatasourceEndpointAllowed(u)).not.toThrow();
    }
  });
  it('rejects non-http(s) schemes and invalid URLs', () => {
    expect(() => assertDatasourceEndpointAllowed('file:///etc/passwd')).toThrow();
    expect(() => assertDatasourceEndpointAllowed('gopher://10.0.0.1/')).toThrow();
    expect(() => assertDatasourceEndpointAllowed('not a url')).toThrow();
  });
  it('isAlwaysBlockedHost: RFC1918 is NOT always-blocked but metadata is', () => {
    expect(isAlwaysBlockedHost('10.0.0.1')).toBe(false);
    expect(isAlwaysBlockedHost('169.254.169.254')).toBe(true);
    expect(isAlwaysBlockedHost('127.0.0.1')).toBe(true);
  });

  // Plan-gate round-3 (agy): 0.0.0.0 routes to localhost on Linux — must be blocked. Lock in the
  // unspecified/broadcast bypass vectors for both families.
  it('blocks 0.0.0.0/8 unspecified, IPv6 :: unspecified, and broadcast', () => {
    for (const u of [
      'http://0.0.0.0:8123',
      'http://0.1.2.3:8123',     // 0.0.0.0/8
      'http://[::]:8123',        // IPv6 unspecified
      'http://255.255.255.255:8123',
    ]) {
      expect(() => assertDatasourceEndpointAllowed(u)).toThrow();
    }
    expect(isAlwaysBlockedHost('0.0.0.0')).toBe(true);
    expect(isAlwaysBlockedHost('::')).toBe(true);
  });
});
