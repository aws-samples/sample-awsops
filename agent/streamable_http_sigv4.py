"""
StreamableHTTP Client Transport with AWS SigV4 Signing

This module extends the MCP StreamableHTTPTransport to add AWS SigV4 request signing
for authentication with MCP servers that authenticate using AWS IAM.
"""

from collections.abc import AsyncGenerator
from contextlib import asynccontextmanager
from datetime import timedelta
from typing import Generator

import httpx
from anyio.streams.memory import MemoryObjectReceiveStream, MemoryObjectSendStream
from botocore.auth import SigV4Auth
from botocore.awsrequest import AWSRequest
from botocore.credentials import Credentials
from mcp.client.streamable_http import (
    GetSessionIdCallback,
    StreamableHTTPTransport,
    streamablehttp_client,
)
from mcp.shared._httpx_utils import McpHttpClientFactory, create_mcp_http_client
from mcp.shared.message import SessionMessage


class SigV4HTTPXAuth(httpx.Auth):
    """HTTPX Auth class that signs requests with AWS SigV4."""

    def __init__(
        self,
        credentials: Credentials,
        service: str,
        region: str,
    ):
        self.credentials = credentials
        self.service = service
        self.region = region
        self.signer = SigV4Auth(credentials, service, region)

    def auth_flow(
        self, request: httpx.Request
    ) -> Generator[httpx.Request, httpx.Response, None]:
        """Signs the request with SigV4 and adds the signature to the request headers."""

        # Create an AWS request
        headers = dict(request.headers)
        # Header 'connection' = 'keep-alive' is not used in calculating the request
        # signature on the server-side, and results in a signature mismatch if included
        headers.pop("connection", None)  # Remove if present, ignore if not

        aws_request = AWSRequest(
            method=request.method,
            url=str(request.url),
            data=request.content,
            headers=headers,
        )

        # Sign the request with SigV4
        self.signer.add_auth(aws_request)

        # Add the signature header to the original request
        request.headers.update(dict(aws_request.headers))

        yield request


class StreamableHTTPTransportWithSigV4(StreamableHTTPTransport):
    """
    Streamable HTTP client transport with AWS SigV4 signing support.

    This transport enables communication with MCP servers that authenticate using AWS IAM,
    such as servers behind a Lambda function URL or API Gateway.
    """

    def __init__(
        self,
        url: str,
        credentials: Credentials,
        service: str,
        region: str,
        headers: dict[str, str] | None = None,
        timeout: float | timedelta = 30,
        sse_read_timeout: float | timedelta = 60 * 5,
    ) -> None:
        """Initialize the StreamableHTTP transport with SigV4 signing.

        Args:
            url: The endpoint URL.
            credentials: AWS credentials for signing.
            service: AWS service name (e.g., 'lambda').
            region: AWS region (e.g., 'us-east-1').
            headers: Optional headers to include in requests.
            timeout: HTTP timeout for regular operations.
            sse_read_timeout: Timeout for SSE read operations.
        """
        # Initialize parent class with SigV4 auth handler
        super().__init__(
            url=url,
            headers=headers,
            timeout=timeout,
            sse_read_timeout=sse_read_timeout,
            auth=SigV4HTTPXAuth(credentials, service, region),
        )

        self.credentials = credentials
        self.service = service
        self.region = region


def _no_redirect_http_client_factory(*args, **kwargs):
    """ADR-039 redirect:'manual': build the MCP httpx client normally, THEN force follow_redirects=False
    on the instance. create_mcp_http_client does NOT accept a follow_redirects kwarg — passing it raises
    TypeError and breaks transport init (regression caught in live verify) — so we set it on the returned
    client. httpx already defaults to follow_redirects=False; this makes the guarantee explicit + robust."""
    client = create_mcp_http_client(*args, **kwargs)
    try:
        client.follow_redirects = False
    except Exception:
        pass  # best-effort: httpx already defaults to no-follow; never let this break transport init
    return client


@asynccontextmanager
async def streamablehttp_client_with_sigv4(
    url: str,
    credentials: Credentials,
    service: str,
    region: str,
    headers: dict[str, str] | None = None,
    timeout: float | timedelta = 30,
    sse_read_timeout: float | timedelta = 60 * 5,
    terminate_on_close: bool = True,
    httpx_client_factory: McpHttpClientFactory = create_mcp_http_client,
) -> AsyncGenerator[
    tuple[
        MemoryObjectReceiveStream[SessionMessage | Exception],
        MemoryObjectSendStream[SessionMessage],
        GetSessionIdCallback,
    ],
    None,
]:
    """
    Client transport for Streamable HTTP with SigV4 auth (+ redirect:'manual').
    """
    async with streamablehttp_client(
        url=url,
        headers=headers,
        timeout=timeout,
        sse_read_timeout=sse_read_timeout,
        terminate_on_close=terminate_on_close,
        httpx_client_factory=_no_redirect_http_client_factory,
        auth=SigV4HTTPXAuth(credentials, service, region),
    ) as result:
        yield result


@asynccontextmanager
async def streamablehttp_client_with_headers(
    url: str,
    headers: dict[str, str] | None = None,
    timeout: float | timedelta = 30,
    sse_read_timeout: float | timedelta = 60 * 5,
    terminate_on_close: bool = True,
) -> AsyncGenerator[
    tuple[
        MemoryObjectReceiveStream[SessionMessage | Exception],
        MemoryObjectSendStream[SessionMessage],
        GetSessionIdCallback,
    ],
    None,
]:
    """
    Client transport for Streamable HTTP with static headers (API Key / Bearer) + redirect:'manual'.
    """
    async with streamablehttp_client(
        url=url,
        headers=headers,
        timeout=timeout,
        sse_read_timeout=sse_read_timeout,
        terminate_on_close=terminate_on_close,
        httpx_client_factory=_no_redirect_http_client_factory,
    ) as result:
        yield result
