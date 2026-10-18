"""HTTPX transport for one administrator-approved MCP origin and validated IP set."""
import ipaddress
import asyncio
import time

import httpx


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
        budget = request.extensions.get("timeout", {}).get("connect", 8)
        budget = budget if isinstance(budget, (int, float)) and budget > 0 else 8
        deadline = time.monotonic() + budget
        last_error = None
        for address in self.addresses:
            # Auth runs against the original URL. Only the socket destination changes.
            pinned = httpx.Request(
                request.method, request.url.copy_with(host=address),
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
                last_error = exc
                continue
            if 300 <= response.status_code < 400:
                await response.aclose()
                raise httpx.HTTPStatusError("MCP redirect rejected", request=request, response=response)
            return response
        raise last_error

    async def aclose(self):
        await self.transport.aclose()


def pinned_client_factory(endpoint, addresses):
    """McpHttpClientFactory contract; no proxy, redirects, or second hostname lookup."""
    def factory(headers=None, timeout=None, auth=None):
        return httpx.AsyncClient(
            headers=headers, timeout=timeout or httpx.Timeout(8),
            auth=auth, follow_redirects=False, max_redirects=0, trust_env=False,
            transport=PinnedAsyncTransport(endpoint, addresses),
        )
    return factory
