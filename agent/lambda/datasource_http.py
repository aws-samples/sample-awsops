"""
Shared datasource-connector helper for the v2 external-observability datasource family
(ClickHouse/Prometheus/Loki/Tempo/Mimir/Jaeger/Dynatrace/Datadog). Each is a user-supplied HTTP
endpoint + credential queried in a query language. This module
centralizes: reading the per-slug credential from the single integrations secret, SSRF host guarding
(always-block metadata/loopback/...; private allowed — in-cluster datasources are the target),
auth headers (Basic/Bearer), and a no-redirect HTTP fetch. Explicit instance IDs require an
ID-bound credential; kind-only reads retain the default mirror. Responses are byte-bounded before
parsing and body reads share the request's monotonic deadline. Connection tests execute bounded
queries instead of trusting public health endpoints. Stdlib + boto3 only.

SECURITY: never log credential material. The endpoint is user-supplied → assert_host_allowed before
every request; redirects are NOT auto-followed (a malicious endpoint can't 30x to metadata/internal).

pentest-remediation P1-3 (Finding 2/7): assert_host_allowed() used to only resolve-and-recheck — the
IP it validated was thrown away, and http_json()'s urllib re-resolved the hostname independently at
connect time. A DNS-rebinding host (safe IP on the first lookup, 169.254.169.254/internal on a later
one with a short TTL) could pass the guard here and land on the blocked target at actual connect.
Fixed via IP-pinning: assert_host_allowed() now caches ALL validated IPs for that host
(_PINNED_IP_CACHE), and http_json() connects the TCP socket to the first one, falling back to the
next cached IP on connect failure (same fallback-through-the-address-list behavior as stdlib
socket.create_connection — needed for dual-stack/multi-A-record endpoints where the first resolved
address may be unreachable) — while keeping the original hostname for the Host header and TLS
SNI/cert validation (_PinnedHTTPConnection / _PinnedHTTPSConnection override only the socket target,
not self.host). Trying any/all of the cached IPs is security-equivalent to pinning one, since every
IP in the list already passed assert_host_allowed's checks. Every real call site already
calls assert_host_allowed(endpoint) immediately before http_json(same endpoint) — that invariant is
what makes the cache safe; it is reset every invocation by set_request_conn() (called at the top of
every lambda_handler) so a warm container never reuses a stale pinned IP across invocations.
The separate custom-MCP transport (agent/agent.py `_assert_host_allowed` + agent/pinned_http.py) pins
its invocation-local validated address set the same way (its address classification additionally
decodes translator-embedded IPv4 forms — IPv4-mapped, 6to4, Teredo, well-known NAT64); registration-time checks (web/lib/ssrf-guard.ts)
stay resolve-based, connection time is pinned on both transports.
"""
import base64
import concurrent.futures
import functools
import http.client
import ipaddress
import json
import os
import re
import socket
import time
import urllib.error
import urllib.request
from urllib.parse import urlparse

HTTP_TIMEOUT = 12
MAX_RESPONSE_BYTES = 4 * 1024 * 1024
MAX_ERROR_BYTES = 64 * 1024

_SM = None
_SECRET_CACHE = None
_SECRET_CACHE_AT = 0.0
_SECRET_TTL = 60.0  # bound stale creds in a warm (long-lived worker) container

# host -> the ordered list of IPs assert_host_allowed most recently validated it to (deduped, in
# getaddrinfo order). Populated only after every resolved IP passed the always-blocked check;
# consumed (not required) by http_json for pinning, which tries them in order until one connects.
# Reset every invocation by set_request_conn — see module docstring.
_PINNED_IP_CACHE = {}

# Shared (not per-call) pool for _open_within; 4 workers: a connection that ignores shutdown()
# must not stall every later request.
_OPEN_POOL = concurrent.futures.ThreadPoolExecutor(max_workers=4, thread_name_prefix="ds-open")


class NotConnected(Exception):
    """Raised when a datasource slug has no stored credential/endpoint."""


class SsrfBlocked(Exception):
    """Raised when an endpoint host/scheme is disallowed."""


class ResponseTooLarge(ValueError):
    """The upstream body exceeded the read budget; this is never an empty result."""


def _seconds(value, default, ceiling=55):
    if isinstance(value, bool):
        return default
    text = str(value).strip()
    if not re.fullmatch(r"\d+s?", text):
        return default
    return max(1, min(ceiling, int(text.removesuffix("s"))))


def request_timeout(creds):
    """Saved transport deadline for APIs without a provider execution-time parameter."""
    return _seconds(creds.get("timeoutS"), HTTP_TIMEOUT)


def execution_timeout(creds, requested=None):
    """Provider execution ceiling, with a caller allowed only to tighten it."""
    configured = _seconds(creds.get("timeoutS"), 10)
    return min(configured, _seconds(requested, configured))


def finite_number(value, bound=1.7976931348623157e308):
    """JSON chart numbers exclude booleans, non-finite values and oversized integers."""
    return type(value) in (int, float) and abs(value) <= bound


class ObservedPayload(dict):
    """Transport evidence is an attribute, so upstream JSON cannot impersonate it."""
    def __init__(self, data, status):
        super().__init__(data)
        self.http_status = status


def observed_payload(data, status):
    return ObservedPayload(data, status) if isinstance(data, dict) else data


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
    # URL-parser-differential completion (PR #286 rounds 9-10): the Node-side guards reject
    # backslash endpoints at WRITE time; re-reject here so a PRE-EXISTING stored endpoint
    # (written before the guard) can't exploit the WHATWG-vs-urlparse host disagreement.
    # SsrfBlocked (the module's contract), placed BELOW the docstring (round-10 minor).
    if "\\" in str(endpoint):
        raise SsrfBlocked("endpoint blocked: must not contain a backslash")
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
    pinned_ips = []
    for entry in addr_info:
        ip_str = entry[4][0]
        if _ip_always_blocked(ip_str):
            raise SsrfBlocked(f"endpoint blocked: {host} resolved to blocked IP {ip_str}")
        if ip_str not in pinned_ips:
            pinned_ips.append(ip_str)
    # every resolved IP passed — pin the full (deduped) list for the immediate subsequent
    # http_json() call, which tries each in order until one connects (IP-pinning; see module
    # docstring). Preserves the pre-existing multi-address fallback behavior of
    # socket.create_connection for dual-stack/multi-A-record endpoints.
    _PINNED_IP_CACHE[host] = pinned_ips


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
    """Stash (or clear) the request's inline conn-config. Call at the top of every lambda_handler.
    Also resets _PINNED_IP_CACHE — a warm container must never reuse a pinned IP validated for a
    previous, unrelated invocation."""
    global _REQUEST_CONN, _PINNED_IP_CACHE
    _REQUEST_CONN = conn if isinstance(conn, dict) and conn.get("endpoint") else None
    _PINNED_IP_CACHE = {}


def query_probe(run, error, accepted=("ok", "empty", "partial")):
    """Time one real bounded query for the connection test. `run` executes the connector's own
    query tool and returns its `collectionStatus` (None when the response was unrecognizable).
    Returns {ok, verified, latency_ms, error?} — fixed sentences only, never upstream text; the
    connector's own classification (SSRF policy vs. unverifiable) is kept because an admin needs it."""
    t0 = time.monotonic()
    try:
        state = run()
    except SsrfBlocked:
        state, error = None, "endpoint rejected by the private-network policy"
    except NotConnected:
        state, error = None, "datasource not connected"
    except Exception as exc:
        print(f"[datasource_http] connection probe failed: {type(exc).__name__}")
        state = None
    latency = int((time.monotonic() - t0) * 1000)
    verified = state in accepted
    return {"ok": verified, "verified": ["query"] if verified else [], "latency_ms": latency,
            **({} if verified else {"error": error})}


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
       2. for an explicit instance_id, the per-instance secret key `map[str(instance_id)]` — the
          credential-blind worker path, where the caller sends ONLY an instance_id and the connector
          reads the secret server-side — or the kind mirror when it is stamped with that exact id
          (`instanceId`, written by the web default-mirror writer). A sibling never inherits the
          default's credential, and an unstamped legacy mirror never serves an explicit id: a migrated
          default must be re-saved first (the administrator save writes the id key and the stamp);
       3. the `map[slug]` kind mirror, only when no explicit instance was requested.
    `instance_id` is a pure argument (no module-global), so warm-container reuse cannot bleed one
    invocation's instance into the next."""
    if _REQUEST_CONN is not None:
        return _REQUEST_CONN
    m = _load_secret_map()
    if instance_id is not None:
        creds = m.get(str(instance_id))
        if not isinstance(creds, dict) or not creds.get("endpoint"):
            mirror = m.get(slug)
            stamp = mirror.get("instanceId") if isinstance(mirror, dict) else None
            if isinstance(mirror, dict) and mirror.get("endpoint") and stamp is not None and str(stamp) == str(instance_id):
                creds = mirror  # the default's own stamped mirror
            else:
                print(f"[datasource_http] strict instance lookup failed: slug={slug} instance_id={instance_id}")
                raise NotConnected("requested datasource instance is not configured")
    else:
        creds = m.get(slug)
    if not isinstance(creds, dict) or not creds.get("endpoint"):
        raise NotConnected(f"{slug} not connected (no endpoint configured in the Connectors UI)")
    return creds


class _NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        raise SsrfBlocked(f"endpoint blocked: redirect to {newurl} not followed")


# ProxyHandler({}) disables HTTP_PROXY/HTTPS_PROXY env-var routing — pinning implies a direct
# connection to the validated IP; honoring a proxy would route the request elsewhere and defeat
# the point of pinning (and break it, since the socket wouldn't reach the pinned IP at all).
class _ConnTracker:
    """Per-request handle: the connection urllib opens for this request, so the deadline watchdog
    in _open_within can close it (which unblocks the worker's recv) instead of abandoning it."""
    conn = None


def _tracked(conn_class, req):
    def make(*args, **kwargs):
        conn = conn_class(*args, **kwargs)
        tracker = getattr(req, "_awsops_tracker", None)
        if tracker is not None:
            tracker.conn = conn
        return conn
    return make


class _TrackingHTTPHandler(urllib.request.HTTPHandler):
    def http_open(self, req):
        return self.do_open(_tracked(http.client.HTTPConnection, req), req)


class _TrackingHTTPSHandler(urllib.request.HTTPSHandler):
    def https_open(self, req):
        return self.do_open(_tracked(http.client.HTTPSConnection, req), req, context=self._context)


_opener = urllib.request.build_opener(
    _NoRedirect, urllib.request.ProxyHandler({}), _TrackingHTTPHandler, _TrackingHTTPSHandler)


def _pin_create_connection(base_create, pinned_ips):
    """Wrap an HTTPConnection's `_create_connection` (normally `socket.create_connection`) so the TCP
    socket lands on one of `pinned_ips` regardless of what `address[0]` (the hostname) is — while
    leaving `self.host` (used for the default Host header and, for HTTPS, SNI/cert
    `server_hostname`) untouched. This is IP-pinning: it uses the IPs assert_host_allowed already
    validated instead of letting the connection re-resolve the hostname (the DNS-rebinding gap).
    Tries each IP in order and returns on the first that connects, matching stdlib
    socket.create_connection's multi-address fallback (needed for dual-stack/multi-A-record
    endpoints where the first address may be unreachable) — every IP here already passed
    assert_host_allowed, so trying any/all of them is security-equivalent to pinning one."""
    def _create(address, *args, **kwargs):
        _, port = address
        last_err = None
        for ip in pinned_ips:
            try:
                return base_create((ip, port), *args, **kwargs)
            except OSError as e:
                last_err = e
        raise last_err
    return _create


class _PinnedHTTPConnection(http.client.HTTPConnection):
    def __init__(self, host, pinned_ips=None, **kwargs):
        super().__init__(host, **kwargs)
        if pinned_ips:
            self._create_connection = _pin_create_connection(self._create_connection, pinned_ips)


class _PinnedHTTPSConnection(http.client.HTTPSConnection):
    def __init__(self, host, pinned_ips=None, **kwargs):
        super().__init__(host, **kwargs)
        if pinned_ips:
            self._create_connection = _pin_create_connection(self._create_connection, pinned_ips)


class _PinnedHTTPHandler(urllib.request.HTTPHandler):
    def __init__(self, pinned_ips):
        super().__init__()
        self._pinned_ips = pinned_ips

    def http_open(self, req):
        return self.do_open(
            _tracked(functools.partial(_PinnedHTTPConnection, pinned_ips=self._pinned_ips), req), req)


class _PinnedHTTPSHandler(urllib.request.HTTPSHandler):
    def __init__(self, pinned_ips):
        super().__init__()
        self._pinned_ips = pinned_ips

    def https_open(self, req):
        # ponytail: no check_hostname= kwarg here — stdlib HTTPSHandler._check_hostname is always
        # None on py3.11 (a no-op) and the parameter was REMOVED from http.client.HTTPSConnection /
        # ssl on py3.12+ (upgrade landmine fixed in review round 2). TLS verification for the pinned
        # connection still happens: self._context defaults to ssl._create_default_https_context()
        # inside HTTPSConnection, and self.host (unchanged — only the socket target is pinned) is
        # passed as server_hostname for SNI + the default context's built-in hostname/cert check.
        return self.do_open(
            _tracked(functools.partial(_PinnedHTTPSConnection, pinned_ips=self._pinned_ips), req),
            req,
            context=self._context,
        )


def _opener_for(host):
    """The shared no-redirect opener, or — when assert_host_allowed already validated `host` this
    invocation — a fresh one-off opener pinned to those validated IPs (tried in order, with
    fallback on connect failure)."""
    pinned_ips = _PINNED_IP_CACHE.get(host)
    if not pinned_ips:
        return _opener
    return urllib.request.build_opener(
        _NoRedirect, urllib.request.ProxyHandler({}),
        _PinnedHTTPHandler(pinned_ips), _PinnedHTTPSHandler(pinned_ips),
    )


def _parse(raw):
    if not raw:
        return {}
    try:
        return json.loads(raw)
    except ValueError:
        return {"raw": raw.decode("utf-8", "replace")[:4000]}


def _response_socket(response):
    """Find urllib's HTTPResponse socket, including HTTPError's extra fp wrapper."""
    stream = response
    for _ in range(4):
        raw = getattr(stream, "raw", None)
        sock = getattr(raw, "_sock", None)
        if sock is not None:
            return sock
        stream = getattr(stream, "fp", None)
        if stream is None:
            break
    return None


def _read_bounded(response, max_bytes, deadline):
    """Read at most budget+1 bytes before the absolute monotonic `deadline`; never trust
    Content-Length or parse before the bound. The deadline is the request's — connect, headers
    and body share one budget, so a slow-but-alive upstream cannot double it."""
    chunks = []
    total = 0
    read = getattr(response, "read1", response.read)
    try:
        while True:
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                raise TimeoutError("datasource response read deadline exceeded")
            sock = _response_socket(response)
            if sock is not None:
                sock.settimeout(remaining)
            try:
                chunk = read(min(65536, max_bytes - total + 1))
            except socket.timeout as exc:
                raise TimeoutError("datasource response read deadline exceeded") from exc
            if time.monotonic() >= deadline:
                raise TimeoutError("datasource response read deadline exceeded")
            if not chunk:
                return b"".join(chunks)
            total += len(chunk)
            if total > max_bytes:
                raise ResponseTooLarge(f"datasource response exceeds {max_bytes} bytes")
            chunks.append(chunk)
    finally:
        response.close()


def _open_within(opener, req, timeout, deadline):
    """Open the connection and read the response headers under the request's absolute deadline.
    urllib's `timeout` is per socket operation, so a server dripping header bytes could hold
    open() past the deadline. The open runs on the shared worker pool; at the deadline the
    watchdog shuts the request's socket down (close() alone is a no-op while the response is
    being read, because the file wrapper holds an io ref) and cancels an open that never
    started; any response that still arrives later is closed by the completion callback."""
    remaining = deadline - time.monotonic()
    if remaining <= 0:
        raise TimeoutError("datasource request deadline exceeded before connect")
    req._awsops_tracker = tracker = _ConnTracker()
    future = _OPEN_POOL.submit(opener.open, req, timeout=min(timeout, remaining))
    try:
        return future.result(timeout=remaining)
    except concurrent.futures.TimeoutError as exc:
        if future.cancel():
            raise TimeoutError("datasource request deadline exceeded before connect") from exc
        sock = getattr(tracker.conn, "sock", None)
        if sock is not None:
            try:
                sock.shutdown(socket.SHUT_RDWR)
            except OSError:
                pass
        if tracker.conn is not None:
            try:
                tracker.conn.close()
            except OSError:
                pass
        future.add_done_callback(_close_late)
        raise TimeoutError("datasource response header deadline exceeded") from exc


def _close_late(future):
    """Close whatever a timed-out open eventually produced: a response, or an HTTPError's body."""
    error = future.exception()
    late = future.result() if error is None else getattr(error, "fp", None)
    if late is not None:
        try:
            late.close()
        except OSError:
            pass


def http_json(method, url, headers=None, body=None, timeout=HTTP_TIMEOUT, max_bytes=MAX_RESPONSE_BYTES):
    """Send a request (no auto-redirect). Returns (status, parsed_dict). Non-2xx → (status, body).
    Pinned to the IPs assert_host_allowed(url) most recently validated for this host, if any (tried
    in order with fallback) — see module docstring (IP-pinning)."""
    data = body if isinstance(body, (bytes, bytearray)) else (body.encode() if isinstance(body, str) else None)
    req = urllib.request.Request(url, data=data, method=method, headers=headers or {})
    # One absolute deadline covers connect, headers and body. The socket timeout is per operation, so
    # the header phase is bounded by the worker wait in _open_within and the body by _read_bounded;
    # the connector Lambda's 60s wall assumes the aligned HTTP timeout (at most 55s + 3s) is the whole request.
    deadline = time.monotonic() + timeout
    try:
        resp = _open_within(_opener_for(urlparse(url).hostname), req, timeout, deadline)
        return resp.getcode(), _parse(_read_bounded(resp, max_bytes, deadline))
    except urllib.error.HTTPError as e:
        # Keep the (status, body) contract for error responses: an oversized or slow error body is
        # reported as such under its real HTTP status instead of replacing the status with a
        # transport exception.
        try:
            raw = _read_bounded(e, min(max_bytes, MAX_ERROR_BYTES), deadline)
        except ResponseTooLarge:
            return e.code, {"error": f"error body exceeded {MAX_ERROR_BYTES} bytes"}
        except TimeoutError:
            return e.code, {"error": "error body read deadline exceeded"}
        except (OSError, http.client.HTTPException):
            return e.code, {"error": "error body could not be read"}
        return e.code, _parse(raw)
