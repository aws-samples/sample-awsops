"""Custom MCP pinning: origin, redirects, replay boundaries and real TLS verification."""
import asyncio
import http.server
import ssl
import subprocess
import sys
import threading
from pathlib import Path

import httpx
import pytest

sys.path.insert(0, str(Path(__file__).parent))
from pinned_http import PinnedAsyncTransport, pinned_client_factory

ORIGIN = "https://synthetic-mcp.example.test:8443/mcp"


def test_pins_socket_target_and_preserves_host_sni_body_and_auth_origin():
    seen = {}
    class Auth(httpx.Auth):
        def auth_flow(self, request):
            seen["auth_url"] = str(request.url)
            request.headers["Authorization"] = "synthetic"
            yield request
    async def upstream(request):
        seen.update(url=str(request.url), host=request.headers["Host"],
                    sni=request.extensions["sni_hostname"],
                    body=await request.aread(), authorization=request.headers["Authorization"])
        return httpx.Response(200, json={"ok": True})
    async def run():
        transport = PinnedAsyncTransport(ORIGIN, ("192.0.2.10",), transport=httpx.MockTransport(upstream))
        async with httpx.AsyncClient(transport=transport, auth=Auth()) as client:
            response = await client.post(ORIGIN, content=b"synthetic body")
            assert response.json()["ok"]
    asyncio.run(run())
    assert seen == {
        "auth_url": ORIGIN, "url": "https://192.0.2.10:8443/mcp",
        "host": "synthetic-mcp.example.test:8443", "sni": "synthetic-mcp.example.test",
        "body": b"synthetic body", "authorization": "synthetic",
    }


@pytest.mark.parametrize("location", ["/next", "https://169.254.169.254/", "https://another.example.test/mcp"])
def test_rejects_all_redirects_before_mcp_sdk_can_follow_them(location):
    calls = []
    async def upstream(request):
        calls.append(request)
        return httpx.Response(307, headers={"Location": location})
    async def run():
        transport = PinnedAsyncTransport(ORIGIN, ("192.0.2.10",), transport=httpx.MockTransport(upstream))
        async with httpx.AsyncClient(transport=transport, follow_redirects=True) as client:
            with pytest.raises(httpx.HTTPStatusError, match="redirect rejected"):
                await client.post(ORIGIN, content=b"synthetic")
    asyncio.run(run())
    assert len(calls) == 1


@pytest.mark.parametrize("changed", [
    "https://another.example.test:8443/mcp", "https://synthetic-mcp.example.test/mcp",
    "http://synthetic-mcp.example.test:8443/mcp",
])
def test_unapproved_origin_never_reaches_transport(changed):
    async def upstream(request):
        pytest.fail("unapproved origin reached transport")
    async def run():
        transport = PinnedAsyncTransport(ORIGIN, ("192.0.2.10",), transport=httpx.MockTransport(upstream))
        async with httpx.AsyncClient(transport=transport) as client:
            with pytest.raises(httpx.ConnectError, match="origin was not approved"):
                await client.get(changed)
    asyncio.run(run())


@pytest.mark.parametrize("error,expected_calls", [(httpx.ConnectError, 2), (httpx.ReadError, 1), (httpx.WriteError, 1)])
def test_fallback_is_only_before_body_delivery(error, expected_calls):
    calls = []
    async def upstream(request):
        calls.append(request.url.host)
        raise error("synthetic failure", request=request)
    async def run():
        transport = PinnedAsyncTransport(ORIGIN, ("192.0.2.10", "192.0.2.11"), transport=httpx.MockTransport(upstream))
        async with httpx.AsyncClient(transport=transport) as client:
            with pytest.raises(error):
                await client.post(ORIGIN, content=b"synthetic")
    asyncio.run(run())
    assert len(calls) == expected_calls


def test_factory_disables_proxy_routing_and_sdk_redirect_budget():
    async def run():
        async with pinned_client_factory(ORIGIN, ("192.0.2.10",))() as client:
            assert client.follow_redirects is False and client.max_redirects == 0
            assert isinstance(client._transport, PinnedAsyncTransport)
    asyncio.run(run())


@pytest.fixture
def tls_server(tmp_path):
    host = "mcp-never-resolved.invalid"
    certificate, key = tmp_path / "cert.pem", tmp_path / "key.pem"
    subprocess.run([
        "openssl", "req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", str(key),
        "-out", str(certificate), "-days", "1", "-subj", f"/CN={host}",
        "-addext", f"subjectAltName=DNS:{host}",
    ], check=True, capture_output=True, timeout=30)
    seen = {}
    class Handler(http.server.BaseHTTPRequestHandler):
        def do_GET(self):
            seen["host"] = self.headers["Host"]
            payload = b'{"ok":true}'
            self.send_response(200)
            self.send_header("Content-Length", str(len(payload)))
            self.end_headers()
            self.wfile.write(payload)
        def log_message(self, *args):
            pass
    server = http.server.HTTPServer(("127.0.0.1", 0), Handler)
    context = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
    context.load_cert_chain(str(certificate), str(key))
    context.set_servername_callback(lambda sock, name, ctx: seen.update(sni=name))
    server.socket = context.wrap_socket(server.socket, server_side=True)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    try:
        yield host, server.server_port, ssl.create_default_context(cafile=str(certificate)), seen
    finally:
        server.shutdown()
        server.server_close()
        thread.join(timeout=2)


def test_real_tls_uses_original_hostname_with_a_pinned_socket(tls_server):
    host, port, context, seen = tls_server
    async def run():
        transport = PinnedAsyncTransport(f"https://{host}:{port}/", ("127.0.0.1",),
                                        transport=httpx.AsyncHTTPTransport(verify=context, trust_env=False))
        async with httpx.AsyncClient(transport=transport) as client:
            response = await client.get(f"https://{host}:{port}/probe")
            assert response.json() == {"ok": True}
    asyncio.run(run())
    assert seen == {"sni": host, "host": f"{host}:{port}"}


def test_real_tls_still_rejects_a_wrong_certificate_hostname(tls_server):
    host, port, context, seen = tls_server
    async def run():
        endpoint = f"https://wrong-certificate.invalid:{port}/"
        transport = PinnedAsyncTransport(endpoint, ("127.0.0.1",),
                                        transport=httpx.AsyncHTTPTransport(verify=context, trust_env=False))
        async with httpx.AsyncClient(transport=transport) as client:
            with pytest.raises(httpx.ConnectError):
                await client.get(endpoint)
    asyncio.run(run())
    assert "host" not in seen
