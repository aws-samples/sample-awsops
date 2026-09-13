"""Deterministic deployment proof. No model-selected tools, prompts, SQL or endpoints."""
import asyncio
import functools
import json
import re
import time
from datetime import timedelta

TOOL_NAMES = ("inventory-read-target___inventory_summary", "inventory-read-target___query_inventory")
CHECK_NAMES = ("identity", "inventorySummary", "inventoryQuery", "knownResource", "freshInventory", "model")
MAX_TOOL_BYTES = 256 * 1024


@functools.lru_cache(maxsize=4)
def _client(service, region):
    # Lazy imports also keep offline protocol tests independent of SDK/credential discovery.
    import boto3
    from botocore.config import Config
    return boto3.client(service, region_name=region, config=Config(
        connect_timeout=3, read_timeout=20 if service == "bedrock-runtime" else 5,
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
            and type(value.get("age_minutes")) is int and 0 <= value["age_minutes"] <= 15)


def check_readiness(payload, gateway_url, mcp_factory, region, model_id):
    result = _result(payload)
    if not _valid(payload):
        return result
    # This URL comes only from the existing discovered/configured Ops gateway map.
    # Payloads cannot supply a URL or tool name.
    result["reason"] = "gateway_unavailable"
    if not isinstance(gateway_url, str) or not re.fullmatch(
            r"https://[a-z0-9-]+\.gateway\.bedrock-agentcore\." + re.escape(region) + r"\.amazonaws\.com/mcp",
            gateway_url):
        return result
    deadline = time.monotonic() + 40

    def remaining():
        left = deadline - time.monotonic()
        if left <= 0:
            raise TimeoutError()
        return timedelta(seconds=min(8, left))

    try:
        result["reason"] = "identity_failed"
        identity = _client("sts", region).get_caller_identity()
        if identity.get("Account") != payload["expectedAccountId"]:
            result["reason"] = "account_mismatch"
            return result
        result["checks"]["identity"] = True
        result["reason"] = "gateway_unavailable"
        remaining()
        with mcp_factory(gateway_url) as client:
            result["reason"] = "tools_unavailable"
            names = []
            token = None
            for _ in range(3):
                remaining()
                batch = client.list_tools_sync(pagination_token=token)
                names.extend(getattr(tool, "tool_name", "") for tool in batch)
                token = getattr(batch, "pagination_token", None)
                if len(names) > 128:
                    return result
                if token is None:
                    break
            if token is not None or any(names.count(name) != 1 for name in TOOL_NAMES):
                return result
            result["reason"] = "inventory_unavailable"
            summary = _tool_body(client.call_tool_sync(
                "readiness-summary", TOOL_NAMES[0], arguments={}, read_timeout_seconds=remaining()))
            sync = summary.get("sync")
            if not isinstance(sync, list):
                return result
            rows = [row for row in sync if isinstance(row, dict) and row.get("resource_type") == "cloudfront"]
            if len(rows) != 1:
                return result
            result["checks"]["inventorySummary"] = True
            inventory = _tool_body(client.call_tool_sync(
                "readiness-query", TOOL_NAMES[1],
                arguments={"resource_type": "cloudfront", "limit": 500}, read_timeout_seconds=remaining()))
            resources = inventory.get("resources")
            if (inventory.get("resource_type") != "cloudfront" or not isinstance(resources, list)
                    or not all(isinstance(row, dict) for row in resources) or len(resources) > 500
                    or type(inventory.get("count")) is not int or inventory["count"] != len(resources)):
                return result
            result["checks"]["inventoryQuery"] = True
            result["inventory"]["count"] = len(resources)  # bounded sample count, not a fleet total
            result["reason"] = "inventory_stale"
            fresh = inventory.get("freshness")
            if not _fresh(rows[0]) or not _fresh(fresh):
                return result
            result["inventory"]["ageMinutes"] = max(rows[0]["age_minutes"], fresh["age_minutes"])
            result["checks"]["freshInventory"] = True
            result["reason"] = "known_resource_missing"
            if not any(row.get("id") == payload["expectedCloudfrontId"] for row in resources):
                return result
            result["checks"]["knownResource"] = True
        remaining()
        result["reason"] = "model_failed"
        # A bounded service-protocol check; inventory and resource data never enter this prompt.
        response = _client("bedrock-runtime", region).converse(
            modelId=model_id, messages=[{"role": "user", "content": [{"text": "Reply with exactly READY."}]}],
            inferenceConfig={"maxTokens": 128})
        message = response.get("output", {}).get("message", {})
        content = message.get("content")
        if (response.get("ResponseMetadata", {}).get("HTTPStatusCode") != 200
                or response.get("stopReason") != "end_turn" or message.get("role") != "assistant"
                or not isinstance(content, list) or not 1 <= len(content) <= 8
                or not all(isinstance(block, dict) for block in content)
                or "".join(block.get("text", "") for block in content).strip() != "READY"):
            return result
        remaining()
        result["checks"]["model"] = True
        result.update(status="ready", reason="ok")
    except TimeoutError:
        result["reason"] = "timeout"
    except Exception:
        # Keep the fixed stage code. Never return/log SDK, MCP, resource or model text.
        pass
    return result


async def handle_readiness(payload, gateway_url, mcp_factory, region, model_id):
    try:
        return await asyncio.wait_for(asyncio.to_thread(
            check_readiness, payload, gateway_url, mcp_factory, region, model_id), timeout=45)
    except asyncio.TimeoutError:
        result = _result(payload)
        result["reason"] = "timeout"
        return result
