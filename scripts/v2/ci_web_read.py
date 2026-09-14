"""Bounded, single-attempt AWS reads for the release controller (stdlib only).

Usage: ``with read_window(deadline, now=now): read_request(service, operation, options)``. Options map CLI names (without --) to strings/string lists. Only the seven listed reads are admitted, in ap-northeast-2; no writes, sleeps, SDK retries or auto-pages. The caller validates successful response bodies and owns bounded backoff.

TransientReadError covers recognized transport/service failures and exhausted budgets. Permission, identity, unknown, response-limit and cleanup failures are fatal. Fixed labels expose no provider output or arguments. Keep writes on ci_web_image.command. Each call has at most 30 seconds and needs 50ms to launch; nested windows only shorten it. A real watchdog also bounds injected-clock tests, reserving cleanup time inside the budget. Timeout kills the owned group and reaps the child boundedly. Parsed success is retained; the next read checks expiry. OS scheduling is not hard realtime. See docs/runbooks/release-safety-primitives.md for the complete caller contract.
"""
from contextlib import contextmanager
from contextvars import ContextVar
import json
import math
import os
import re
import selectors
import signal
import subprocess
import tempfile
import time

from ci_web_image import ImageError, child_environment, require

__all__ = ["TransientReadError", "read_window", "read_request"]
MAX_REQUEST_SECONDS = 30.0
MIN_REQUEST_SECONDS = 0.05
MAX_RESPONSE_BYTES = 1024 * 1024
MAX_ERROR_BYTES = 64 * 1024

# This is an authorization boundary, independent of the base diagnostic labels.
_OPERATIONS = {
    ("ecs", "describe-services"): ("ecs:DescribeServices", {"cluster", "services"}),
    ("ecs", "describe-tasks"): ("ecs:DescribeTasks", {"cluster", "tasks"}),
    ("ecs", "describe-task-definition"): (
        "ecs:DescribeTaskDefinition", {"task-definition"}),
    ("ecs", "list-tasks"): ("ecs:ListTasks", {
        "cluster", "service-name", "desired-status", "max-results", "next-token"}),
    ("ecr", "batch-get-image"): ("ecr:BatchGetImage", {
        "registry-id", "repository-name", "image-ids"}),
    ("ecr", "get-download-url-for-layer"): ("ecr:GetDownloadUrlForLayer", {
        "registry-id", "repository-name", "layer-digest"}),
    ("sts", "get-caller-identity"): ("sts:GetCallerIdentity", set()),
}
_RETRY_CODES = frozenset({
    "Throttling", "ThrottlingException", "ThrottledException",
    "TooManyRequestsException", "RequestLimitExceeded",
    "RequestThrottled", "RequestThrottledException", "SlowDown",
    "ServiceUnavailable", "ServiceUnavailableException", "ServiceUnavailableError",
    "InternalFailure", "InternalError", "InternalServerError", "InternalServerException",
    "ServerException", "RequestTimeout", "RequestTimeoutException", "429",
})
_SERVICE_ERROR = re.compile(
    r"An error occurred \(([A-Za-z0-9]+)\) when calling the ([A-Za-z0-9]+)"
    r" operation(?: \(reached max retries: [0-9]+\))?:[\s\S]*")
_NETWORK_ERRORS = re.compile(
    r'(?:(?:Read timeout on endpoint URL|Connect timeout on endpoint URL|'
    r'Could not connect to the endpoint URL): "[^\r\n]*"|'
    r'Connection was closed before we received a valid response from endpoint URL: '
    r'"[^\r\n]*"\.?|Connection reset by peer(?:: [^\r\n]*)?)')
_WINDOWS = ContextVar("ci_web_read_windows", default=())


class TransientReadError(ImageError):
    """A failed single read attempt that the bounded outer poll may retry."""


def _finite(value):
    return type(value) in (int, float) and math.isfinite(value)


@contextmanager
def read_window(deadline, now=time.monotonic):
    """Apply an already computed absolute deadline/clock to all nested reads.

    Context-local and reset on every exit, including exceptions. No fresh timeout
    is created here: repeated checks share the original poll's deadline.
    """
    require(_finite(deadline) and callable(now), "Invalid AWS read window")
    token = _WINDOWS.set(_WINDOWS.get() + ((deadline, now),))
    try:
        yield
    finally:
        _WINDOWS.reset(token)


def _budget():
    remaining = MAX_REQUEST_SECONDS
    for deadline, now in _WINDOWS.get():
        current = now()
        require(_finite(current), "Invalid AWS read clock")
        remaining = min(remaining, deadline - current)
    return remaining


def _argv(service, operation, args):
    require(isinstance(service, str) and isinstance(operation, str)
            and (service, operation) in _OPERATIONS, "Unsupported AWS read operation")
    label, allowed = _OPERATIONS[(service, operation)]
    require(isinstance(args, dict) and all(key in allowed for key in args),
            f"Invalid AWS read arguments [{label}]")
    argv = ["aws", service, operation, "--region", "ap-northeast-2", "--output", "json",
            "--no-cli-pager", "--no-paginate"]
    total = 0
    for key, value in args.items():
        values = [value] if isinstance(value, str) else value
        require(isinstance(values, (list, tuple)) and 0 < len(values) <= 100,
                f"Invalid AWS read arguments [{label}]")
        for item in values:
            require(isinstance(item, str) and 0 < len(item) <= 16384
                    and not item.startswith("-") and all(ord(c) >= 32 and ord(c) != 127 for c in item)
                    and not any(s in item.lower() for s in ("file://", "fileb://", "http://", "https://"))
                    and "@=" not in item, f"Invalid AWS read arguments [{label}]")
            total += len(item.encode("utf-8"))
        argv += ["--" + key, *values]
    require(total <= 65536, f"Invalid AWS read arguments [{label}]")
    return argv, label


def _transient(stderr, label):
    # Parse the root error, not retry words inside an arbitrary provider message.
    text = stderr.decode("utf-8", errors="replace").strip()
    # Current CLI releases wrap both service and transport errors. Strip only
    # that fixed outer prefix; retry words inside a denial never change its type.
    text = text.removeprefix("aws: [ERROR]: ").lstrip()
    service_error = _SERVICE_ERROR.fullmatch(text)
    if service_error:
        code, operation = service_error.groups()
        return (operation == label.split(":", 1)[1]
                and (code in _RETRY_CODES or re.fullmatch(r"5[0-9]{2}", code) is not None))
    return _NETWORK_ERRORS.fullmatch(text) is not None


def _stop(proc, deadline, label):
    # A reaped PID may have been reused. Do not poll here: an exited, unreaped
    # leader still owns the group whose descendant may be holding a pipe open.
    if proc.returncode is not None:
        return
    try:
        os.killpg(proc.pid, signal.SIGKILL)
    except ProcessLookupError:
        pass
    try:
        proc.wait(timeout=max(0.0, deadline - time.monotonic()))
    except subprocess.TimeoutExpired:
        raise ImageError(f"AWS read process cleanup failed [{label}]") from None


def _capture(argv, env, seconds, label):
    deadline = time.monotonic() + seconds
    # Reserve up to 250ms for group kill/reap, with no extra wait after the budget.
    capture_deadline = deadline - min(0.25, seconds / 4)
    proc = subprocess.Popen(argv, stdin=subprocess.DEVNULL, stdout=subprocess.PIPE,
                            stderr=subprocess.PIPE, env=env, bufsize=0, start_new_session=True)
    buffers = [bytearray(), bytearray()]
    try:
        with selectors.DefaultSelector() as selector:
            selector.register(proc.stdout, selectors.EVENT_READ, (0, MAX_RESPONSE_BYTES))
            selector.register(proc.stderr, selectors.EVENT_READ, (1, MAX_ERROR_BYTES))
            while selector.get_map():
                remaining = capture_deadline - time.monotonic()
                if remaining <= 0:
                    raise TransientReadError(f"AWS read timed out [{label}]")
                for key, _ in selector.select(remaining):
                    index, limit = key.data
                    # Bounded pipes and bounded reads, not communicate()'s growing buffer.
                    chunk = os.read(key.fd, min(65536, limit - len(buffers[index]) + 1))
                    if not chunk:
                        selector.unregister(key.fileobj)
                        continue
                    buffers[index].extend(chunk)
                    require(len(buffers[index]) <= limit, f"Oversized AWS read response [{label}]")
            try:
                code = proc.wait(timeout=max(0.0, capture_deadline - time.monotonic()))
            except subprocess.TimeoutExpired:
                raise TransientReadError(f"AWS read timed out [{label}]") from None
        return code, bytes(buffers[0]), bytes(buffers[1])
    finally:
        try:
            _stop(proc, deadline, label)
        finally:
            proc.stdout.close()
            proc.stderr.close()


def read_request(service, operation, args):
    """Perform exactly one allowlisted CLI read under the current read_window."""
    argv, label = _argv(service, operation, args)
    try:
        # Fixed, trusted child environment, including AWS_MAX_ATTEMPTS=1.
        # Recompute budget after setup so setup cannot extend the outer deadline.
        request_deadline = time.monotonic() + MAX_REQUEST_SECONDS
        with tempfile.TemporaryDirectory(prefix="web-read-config-") as config_dir:
            env = child_environment("aws", config_dir)
            seconds = min(_budget(), request_deadline - time.monotonic())
            if seconds < MIN_REQUEST_SECONDS:
                raise TransientReadError(f"AWS read budget exhausted [{label}]")
            code, stdout, stderr = _capture(argv, env, seconds, label)
        if code != 0:
            if _transient(stderr, label):
                raise TransientReadError(f"AWS read temporarily unavailable [{label}]")
            raise ImageError(f"AWS read failed [{label}]")
        result = json.loads(stdout)
        require(isinstance(result, dict), f"Invalid AWS read response [{label}]")
        return result
    except (OSError, ValueError, RecursionError, subprocess.SubprocessError):
        raise ImageError(f"AWS read failed [{label}]") from None
