"""Deterministic deployment proof. No model-selected tools, prompts, SQL or endpoints."""
import asyncio
import copy
import functools
import json
import os
import re
import threading
import time
from datetime import timedelta

TOOL_NAMES = ("inventory-read-target___inventory_summary", "inventory-read-target___query_inventory")
CHECK_NAMES = ("identity", "inventorySummary", "inventoryQuery", "knownResource", "freshInventory", "model")
MAX_TOOL_BYTES = 256 * 1024


@functools.lru_cache(maxsize=8)
def _client(service, region, budget):
    # Lazy imports also keep offline protocol tests independent of SDK/credential discovery.
    import boto3
    from botocore.config import Config
    connect = min(3, budget / 2)
    return boto3.client(service, region_name=region, config=Config(
        connect_timeout=connect, read_timeout=min(20 if service == "bedrock-runtime" else 5, budget - connect),
        retries={"total_max_attempts": 1, "mode": "standard"}))


def _valid(payload):
    return (isinstance(payload, dict)
            and set(payload) == {"mode", "nonce", "expectedAccountId", "expectedCloudfrontId"}
            and payload["mode"] == "deployment_readiness"
            and all(isinstance(payload.get(k), str) for k in
                    ("nonce", "expectedAccountId", "expectedCloudfrontId"))
            and re.fullmatch(r"[a-zA-Z0-9_-]{32,64}", payload["nonce"])
            and re.fullmatch(r"[0-9]{12}", payload["expectedAccountId"])
            and re.fullmatch(r"[A-Z0-9]{5,32}", payload["expectedCloudfrontId"]))


def _result(payload):
    valid = _valid(payload)
    return dict(schemaVersion=1, mode="deployment_readiness",
                nonce=payload["nonce"] if valid else "",
                accountId=payload["expectedAccountId"] if valid else "",
                status="not_ready", reason="invalid_request",
                checks={key: False for key in CHECK_NAMES},
                inventory=dict(count=None, ageMinutes=None))


class _Progress:
    """Shared bounded work state; timeout snapshots never alias the worker's result."""
    def __init__(self, payload):
        self.result = _result(payload)
        self.deadline = time.monotonic() + 40
        self.cancelled = threading.Event()
        self.lock = threading.Lock()

    def remaining(self, minimum=0):
        left = self.deadline - time.monotonic()
        if self.cancelled.is_set() or left <= minimum:
            raise TimeoutError()
        return left

    def record(self, *, reason=None, checks=None, inventory=None, status=None):
        with self.lock:
            self.remaining()
            if reason is not None:
                self.result["reason"] = reason
            if checks:
                self.result["checks"].update(checks)
            if inventory:
                self.result["inventory"].update(inventory)
            if status is not None:
                self.result["status"] = status

    def cancel(self):
        self.cancelled.set()
        with self.lock:
            self.result.update(status="not_ready", reason="timeout")

    def snapshot(self):
        with self.lock:
            return copy.deepcopy(self.result)


def _tool_body(result):
    if not isinstance(result, dict) or result.get("status") != "success":
        raise ValueError()
    blocks = result.get("content")
    if not isinstance(blocks, list) or len(blocks) != 1 or not isinstance(blocks[0], dict):
        raise ValueError()
    text = blocks[0].get("text")
    if not isinstance(text, str) or len(text.encode("utf-8")) > MAX_TOOL_BYTES:
        raise ValueError()
    body = json.loads(text)
    # Lambda tools use the existing statusCode/body envelope. Some Gateway versions
    # unwrap it; accept either object representation, but never an error envelope.
    if isinstance(body, dict) and "statusCode" in body:
        if body["statusCode"] != 200 or not isinstance(body.get("body"), str):
            raise ValueError()
        body = json.loads(body["body"])
    if not isinstance(body, dict) or "error" in body:
        raise ValueError()
    return body


def _fresh(value):
    return (isinstance(value, dict) and value.get("resource_type") == "cloudfront"
            and value.get("status") == "succeeded" and value.get("freshness") == "healthy"
            and type(value.get("unknown_attribute_count")) is int and value["unknown_attribute_count"] == 0
            and type(value.get("stale_after_minutes")) is int and 1 <= value["stale_after_minutes"] <= 1440
            and type(value.get("age_minutes")) is int
            and 0 <= value["age_minutes"] <= value["stale_after_minutes"])


def check_readiness(payload, gateway_url, mcp_factory, region, model_id, *, progress=None):
    progress = progress or _Progress(payload)
    if not _valid(payload):
        return progress.snapshot()
    if os.environ.get("DEPLOYMENT_READINESS_ENABLED") != "true":
        progress.record(reason="disabled")
        return progress.snapshot()
    try:
        # Only the existing Ops map supplies this URL, never the request payload.
        progress.record(reason="gateway_unavailable")
        if not isinstance(gateway_url, str) or not re.fullmatch(
                r"https://[a-z0-9-]+\.gateway\.bedrock-agentcore\." + re.escape(region) + r"\.amazonaws\.com/mcp",
                gateway_url):
            return progress.snapshot()
        progress.record(reason="identity_failed")
        sts = _client("sts", region, min(8, progress.remaining()))
        progress.remaining()  # Client/credential initialization also consumes the budget.
        identity = sts.get_caller_identity()
        progress.remaining()
        if identity.get("Account") != payload["expectedAccountId"]:
            progress.record(reason="account_mismatch")
            return progress.snapshot()
        progress.record(reason="gateway_unavailable", checks={"identity": True})
        # The existing factory caps MCP startup/transport reads at eight seconds.
        # Do not start a fixed-budget operation if that budget no longer fits.
        progress.remaining(8)
        with mcp_factory(gateway_url) as client:
            progress.record(reason="tools_unavailable")
            names = []
            token = None
            for _ in range(3):
                progress.remaining(8)
                batch = client.list_tools_sync(pagination_token=token)
                progress.remaining()
                names.extend(getattr(tool, "tool_name", "") for tool in batch)
                token = getattr(batch, "pagination_token", None)
                if len(names) > 128:
                    return progress.snapshot()
                if token is None:
                    break
            if token is not None or any(names.count(name) != 1 for name in TOOL_NAMES):
                return progress.snapshot()
            progress.record(reason="inventory_unavailable")
            summary = _tool_body(client.call_tool_sync(
                "readiness-summary", TOOL_NAMES[0], arguments={},
                read_timeout_seconds=timedelta(seconds=min(8, progress.remaining()))))
            progress.remaining()
            sync = summary.get("sync")
            if not isinstance(sync, list):
                return progress.snapshot()
            rows = [row for row in sync if isinstance(row, dict) and row.get("resource_type") == "cloudfront"]
            if len(rows) != 1:
                return progress.snapshot()
            progress.record(checks={"inventorySummary": True})
            inventory = _tool_body(client.call_tool_sync(
                "readiness-query", TOOL_NAMES[1],
                arguments={"resource_type": "cloudfront", "limit": 500},
                read_timeout_seconds=timedelta(seconds=min(8, progress.remaining()))))
            progress.remaining()
            resources = inventory.get("resources")
            if (inventory.get("resource_type") != "cloudfront" or not isinstance(resources, list)
                    or not all(isinstance(row, dict) for row in resources) or len(resources) > 500
                    or type(inventory.get("count")) is not int or inventory["count"] != len(resources)):
                return progress.snapshot()
            progress.record(reason="inventory_incomplete", checks={"inventoryQuery": True},
                            inventory={"count": len(resources)})  # bounded sample, not a fleet total
            fresh = inventory.get("freshness")
            if any(not isinstance(value, dict) or type(value.get("unknown_attribute_count")) is not int
                   or value["unknown_attribute_count"] != 0 for value in (rows[0], fresh)):
                return progress.snapshot()
            progress.record(reason="inventory_stale")
            if not _fresh(rows[0]) or not _fresh(fresh):
                return progress.snapshot()
            progress.record(reason="known_resource_missing", checks={"freshInventory": True},
                            inventory={"ageMinutes": max(rows[0]["age_minutes"], fresh["age_minutes"])})
            if not any(row.get("id") == payload["expectedCloudfrontId"] for row in resources):
                return progress.snapshot()
            # If session teardown fails, it is not evidence that the known ID was absent.
            progress.record(reason="gateway_unavailable", checks={"knownResource": True})
        progress.record(reason="model_failed")
        model = _client("bedrock-runtime", region, min(23, progress.remaining()))
        progress.remaining()
        # A bounded service-protocol check; inventory and resource data never enter this prompt.
        response = model.converse(
            modelId=model_id, messages=[{"role": "user", "content": [{"text": "Reply with exactly READY."}]}],
            inferenceConfig={"maxTokens": 128})
        progress.remaining()
        message = response.get("output", {}).get("message", {})
        content = message.get("content")
        if (response.get("ResponseMetadata", {}).get("HTTPStatusCode") != 200
                or response.get("stopReason") != "end_turn" or message.get("role") != "assistant"
                or not isinstance(content, list) or not 1 <= len(content) <= 8
                or not all(isinstance(block, dict) and isinstance(block.get("text", ""), str) for block in content)):
            return progress.snapshot()
        text = "".join(block.get("text", "") for block in content).strip()
        if not text or len(text.encode("utf-8")) > 4096:
            return progress.snapshot()
        progress.record(status="ready", reason="ok", checks={"model": True})
    except TimeoutError:
        progress.cancel()
    except Exception:
        # Keep the fixed stage code. Never return/log SDK, MCP, resource or model text.
        if progress.cancelled.is_set() or time.monotonic() >= progress.deadline:
            progress.cancel()
    return progress.snapshot()


async def handle_readiness(payload, gateway_url, mcp_factory, region, model_id):
    progress = _Progress(payload)  # Queueing the worker also consumes the same work budget.
    if not _valid(payload):
        return progress.snapshot()
    if os.environ.get("DEPLOYMENT_READINESS_ENABLED") != "true":
        progress.record(reason="disabled")
        return progress.snapshot()
    try:
        return await asyncio.wait_for(asyncio.to_thread(
            check_readiness, payload, gateway_url, mcp_factory, region, model_id, progress=progress), timeout=45)
    except asyncio.TimeoutError:
        progress.cancel()
        return progress.snapshot()
    except asyncio.CancelledError:
        progress.cancel()
        raise
