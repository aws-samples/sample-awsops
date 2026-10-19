"""HTTPX transport for one administrator-approved MCP origin and validated IP set."""
import ipaddress
import asyncio
import time

import httpx

# Connect budget (TCP + TLS to one pinned address) and the separate read budget (time to response
# headers / between SSE events). The read budget stays well under the 120s chat request budget
# but must not collapse to the connect budget: an integration whose upstream takes a few seconds to
# start answering is a normal tool call, not a dead connection.
CONNECT_TIMEOUT = 8
READ_TIMEOUT = 60


def _pinned_host(address):
    """URL host form of a validated address: IPv6 literals must be bracketed or httpx treats the
    colon-bearing string as a registered name and the pin fails for every AAAA-only endpoint."""
    return f"[{address}]" if ":" in address else address


class PinnedAsyncTransport(httpx.AsyncBaseTransport):
    def __init__(self, endpoint, addresses, transport=None):
        self.endpoint = httpx.URL(endpoint)
        self.addresses = tuple(str(ipaddress.ip_address(address)) for address in addresses)
        if self.endpoint.scheme != "https" or not self.addresses:
            raise ValueError("MCP HTTPS origin and validated addresses are required")
        self.transport = transport or httpx.AsyncHTTPTransport(trust_env=False)

    async def handle_async_request(self, request):
        origin = lambda url: (url.scheme, url.host, url.port or 443)
        if origin(request.url) != origin(self.endpoint):
            raise httpx.ConnectError("MCP request origin was not approved", request=request)
        # The transport-level deadline bounds the time to response headers (connect + request +
        # first response bytes): it is a READ budget, so it follows the request's read timeout and
        # never the much shorter connect timeout.
        timeouts = request.extensions.get("timeout") or {}
        budget = timeouts.get("read")
        budget = budget if isinstance(budget, (int, float)) and budget > 0 else READ_TIMEOUT
        deadline = time.monotonic() + budget
        last_error = None
        for address in self.addresses:
            # Auth runs against the original URL. Only the socket destination changes.
            pinned = httpx.Request(
                request.method, request.url.copy_with(host=_pinned_host(address)),
                headers=request.headers, stream=request.stream,
                extensions={**request.extensions, "sni_hostname": request.url.raw_host.decode("ascii")},
            )
            try:
                remaining = deadline - time.monotonic()
                if remaining <= 0:
                    raise httpx.ReadTimeout("MCP connection request deadline exceeded", request=request)
                async with asyncio.timeout(remaining):
                    response = await self.transport.handle_async_request(pinned)
            except TimeoutError as exc:
                # The timeout may occur after body delivery, so it must not be replayed.
                raise httpx.ReadTimeout("MCP connection request deadline exceeded", request=request) from exc
            except (httpx.ConnectError, httpx.ConnectTimeout) as exc:
                # Connection failure occurs before a body is sent; never replay read/write failures.
                # Each discarded attempt is logged so a certificate-verification failure on one
                # address is not hidden behind the last address's error.
                print(f"[pinned_http] {address} failed before any body was sent: {type(exc).__name__}: {exc}")
                last_error = exc
                continue
            if 300 <= response.status_code < 400:
                await response.aclose()
                # 3xx without Location (e.g. 304) is still outside the MCP contract; the message is
                # about the class of response, so it stays accurate for both.
                raise httpx.HTTPStatusError("MCP 3xx response rejected (redirects are never followed)",
                                            request=request, response=response)
            return response
        raise last_error

    async def aclose(self):
        await self.transport.aclose()


def pinned_client_factory(endpoint, addresses):
    """McpHttpClientFactory contract; no proxy, redirects, or second hostname lookup."""
    def factory(headers=None, timeout=None, auth=None):
        return httpx.AsyncClient(
            headers=headers, timeout=timeout or httpx.Timeout(READ_TIMEOUT, connect=CONNECT_TIMEOUT),
            auth=auth, follow_redirects=False, max_redirects=0, trust_env=False,
            transport=PinnedAsyncTransport(endpoint, addresses),
        )
    return factory
