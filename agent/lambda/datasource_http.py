"""
Shared datasource-connector helper for the v1 datasource family (ClickHouse/Prometheus/Loki/Tempo/
Mimir). Each is a user-supplied HTTP endpoint + credential queried in a query language. This module
centralizes: reading the per-slug credential from the single integrations secret, SSRF host guarding
(always-block metadata/loopback/...; private allowed — in-cluster datasources are the target),
auth headers (Basic/Bearer), and a no-redirect HTTP fetch. Stdlib + boto3 only.

SECURITY: never log credential material. The endpoint is user-supplied → assert_host_allowed before
every request; redirects are NOT auto-followed (a malicious endpoint can't 30x to metadata/internal).
KNOWN LIMITATION (accepted, matches agent.py inc2 + ADR-011): resolve-and-recheck, not IP-pinning —
a DNS-rebinding host could resolve safe here and blocked at connect; layered defenses = always-block
+ no-redirect + (for SQL) read-only/table-function guards. IP-pinning deferred.
"""
import base64
import ipaddress
import json
import os
import re
import socket
import urllib.error
import urllib.request
from urllib.parse import urlparse

HTTP_TIMEOUT = 12

_SM = None
_SECRET_CACHE = None
_SECRET_CACHE_AT = 0.0
_SECRET_TTL = 60.0  # bound stale creds in a warm (long-lived worker) container


class NotConnected(Exception):
    """Raised when a datasource slug has no stored credential/endpoint."""


class SsrfBlocked(Exception):
    """Raised when an endpoint host/scheme is disallowed."""


# Cloud instance-metadata endpoints blocked even though private is otherwise allowed (mirror agent.py).
_METADATA_IPS = frozenset({
    ipaddress.ip_address("169.254.169.254"),
    ipaddress.ip_address("fd00:ec2::254"),
})


def _ip_always_blocked(ip_str):
    """Metadata, loopback, link-local, multicast, reserved, unspecified — blocked regardless of private."""
    try:
        ip = ipaddress.ip_address(ip_str)
        # Normalize embedded IPv4 so ::ffff:169.254.169.254 / ::ffff:127.0.0.1 / 2002::/16 can't
        # evade the IPv4 metadata/loopback/link-local checks via a dual-stack socket.
        mapped = getattr(ip, "ipv4_mapped", None)
        if mapped is not None:
            ip = mapped
        sixtofour = getattr(ip, "sixtofour", None)
        if sixtofour is not None:
            ip = sixtofour
        if ip in _METADATA_IPS:
            return True
        return ip.is_loopback or ip.is_link_local or ip.is_multicast or ip.is_reserved or ip.is_unspecified
    except ValueError:
        return True  # invalid IP → blocked


def assert_host_allowed(endpoint, resolver=socket.getaddrinfo):
    """Allow only http/https to a host whose every resolved IP is not always-blocked. Private
    (RFC1918/ULA) is ALLOWED — in-cluster datasources are the intended target."""
    parsed = urlparse(endpoint)
    if parsed.scheme not in ("http", "https"):
        raise SsrfBlocked(f"endpoint blocked: scheme '{parsed.scheme}' not allowed (http/https only)")
    host = parsed.hostname
    if not host:
        raise SsrfBlocked(f"endpoint blocked: missing host in URL")
    port = parsed.port or (443 if parsed.scheme == "https" else 80)
    try:
        addr_info = resolver(host, port, proto=socket.IPPROTO_TCP)
    except socket.gaierror as e:
        raise SsrfBlocked(f"endpoint blocked: cannot resolve host {host}: {e}")
    if not addr_info:
        raise SsrfBlocked(f"endpoint blocked: cannot resolve host {host}")
    for entry in addr_info:
        ip_str = entry[4][0]
        if _ip_always_blocked(ip_str):
            raise SsrfBlocked(f"endpoint blocked: {host} resolved to blocked IP {ip_str}")


_HEADER_NAME_RE = re.compile(r"^[A-Za-z0-9!#$%&'*+.^_`|~-]+$")
_FORBIDDEN_HEADERS = frozenset({"host", "content-length", "authorization"})


def _safe_custom_header(name, value):
    """Block header-injection: invalid/forbidden name or control chars (CR/LF) in name or value."""
    if not name or not _HEADER_NAME_RE.match(name) or name.lower() in _FORBIDDEN_HEADERS:
        return False
    if any(ord(ch) < 0x20 or ord(ch) == 0x7F for ch in str(value)):
        return False
    return True


def auth_headers(creds):
    """Build auth headers. Honors an explicit `authType` (none/basic/bearer/custom_header) when present
    (the BFF inline conn-config); otherwise INFERS from filled fields (legacy slug-map shape). Always
    adds X-Scope-OrgID when org_id is set. Never logged."""
    h = {}
    at = creds.get("authType")
    if at == "basic" or (at is None and creds.get("username")):
        if creds.get("username"):
            raw = f"{creds['username']}:{creds.get('password', '')}".encode()
            h["Authorization"] = "Basic " + base64.b64encode(raw).decode()
    elif at == "bearer" or (at is None and creds.get("token")):
        if creds.get("token"):
            h["Authorization"] = f"Bearer {creds['token']}"
    elif at == "custom_header":
        # Up to TWO custom headers — Datadog needs DD-API-KEY + DD-APPLICATION-KEY as a pair.
        for nk, vk in (("headerName", "headerValue"), ("headerName2", "headerValue2")):
            name, value = creds.get(nk), creds.get(vk, "")
            if name:
                if not _safe_custom_header(name, value):
                    raise SsrfBlocked("unsafe custom auth header rejected")
                h[name] = value
    if creds.get("org_id"):
        h["X-Scope-OrgID"] = creds["org_id"]
    return h


# Request-scoped inline connection config (set per lambda_handler invocation). When present it takes
# precedence over the slug credential map — this is how the BFF drives multi-instance + the pre-save
# Test. Reset on every invocation (warm Lambdas reuse the module). Must contain an `endpoint`.
_REQUEST_CONN = None


def set_request_conn(conn):
    """Stash (or clear) the request's inline conn-config. Call at the top of every lambda_handler."""
    global _REQUEST_CONN
    _REQUEST_CONN = conn if isinstance(conn, dict) and conn.get("endpoint") else None


def health(creds, path):
    """Lightweight connectivity probe: GET endpoint+path with auth, SSRF-guarded. {ok, latency_ms, error?}."""
    import time as _t
    endpoint = (creds or {}).get("endpoint")
    if not endpoint:
        return {"ok": False, "error": "no endpoint configured"}
    url = endpoint.rstrip("/") + path
    t0 = _t.time()
    try:
        assert_host_allowed(url)
        status, _ = http_json("GET", url, headers=auth_headers(creds))
        latency = int((_t.time() - t0) * 1000)
        if status >= 400:
            return {"ok": False, "latency_ms": latency, "error": f"HTTP {status}"}
        return {"ok": True, "latency_ms": latency}
    except (SsrfBlocked, urllib.error.URLError, OSError) as e:
        return {"ok": False, "latency_ms": int((_t.time() - t0) * 1000), "error": str(e)[:200]}


def _sm():
    global _SM
    if _SM is None:
        import boto3
        _SM = boto3.client("secretsmanager", region_name=os.environ.get("AWS_REGION", "ap-northeast-2"))
    return _SM


def _load_secret_map():
    global _SECRET_CACHE, _SECRET_CACHE_AT
    import time as _t
    now = _t.time()
    if _SECRET_CACHE is not None and (now - _SECRET_CACHE_AT) < _SECRET_TTL:
        return _SECRET_CACHE
    name = os.environ.get("INTEGRATIONS_SECRET_NAME", "ops/awsops-v2/integrations/credentials")
    try:
        raw = _sm().get_secret_value(SecretId=name).get("SecretString", "")
    except Exception as e:  # noqa: BLE001
        if "ResourceNotFound" in type(e).__name__ or "ResourceNotFound" in str(e):
            raw = ""
        else:
            raise
    parsed = json.loads(raw) if raw else {}
    _SECRET_CACHE = parsed if isinstance(parsed, dict) else {}
    _SECRET_CACHE_AT = now
    return _SECRET_CACHE


def load_datasource(slug, instance_id=None):
    """Resolve a datasource's connection blob. Precedence:
       1. the request-scoped inline conn-config (`_REQUEST_CONN`) — the trusted BFF path only;
       2. the per-instance secret key `map[str(instance_id)]` — the credential-blind worker path,
          where the caller sends ONLY an instance_id and the connector reads the secret server-side;
       3. the `map[slug]` kind-mirror (the default instance) as the fallback.
    `instance_id` is a pure argument (no module-global), so warm-container reuse cannot bleed one
    invocation's instance into the next."""
    if _REQUEST_CONN is not None:
        return _REQUEST_CONN
    m = _load_secret_map()
    creds = m.get(str(instance_id)) if instance_id is not None else None
    if not (isinstance(creds, dict) and creds.get("endpoint")):
        creds = m.get(slug)  # kind-mirror (default instance) fallback
    if not isinstance(creds, dict) or not creds.get("endpoint"):
        raise NotConnected(f"{slug} not connected (no endpoint configured in the Connectors UI)")
    return creds


class _NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        raise SsrfBlocked(f"endpoint blocked: redirect to {newurl} not followed")


_opener = urllib.request.build_opener(_NoRedirect)


def _parse(raw):
    if not raw:
        return {}
    try:
        return json.loads(raw)
    except ValueError:
        return {"raw": raw.decode("utf-8", "replace")[:4000]}


def http_json(method, url, headers=None, body=None, timeout=HTTP_TIMEOUT):
    """Send a request (no auto-redirect). Returns (status, parsed_dict). Non-2xx → (status, body)."""
    data = body if isinstance(body, (bytes, bytearray)) else (body.encode() if isinstance(body, str) else None)
    req = urllib.request.Request(url, data=data, method=method, headers=headers or {})
    try:
        resp = _opener.open(req, timeout=timeout)
        return resp.getcode(), _parse(resp.read())
    except urllib.error.HTTPError as e:
        try:
            raw = e.read()
        except Exception:  # noqa: BLE001
            raw = b""
        return e.code, _parse(raw)
