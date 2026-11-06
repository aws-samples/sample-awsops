"""Model client selected by the deploy-time MODEL_PROVIDER (Terraform var.model_provider).

Call sites keep their Bedrock request shapes and swap `boto3.client("bedrock-runtime", ...)` for
`model_runtime.client(...)`:
- mixed / bedrock_claude: requests go to Bedrock unchanged.
- bedrock_openai: an Anthropic-format `invoke_model` body sent to an `openai.*` model is converted to
  Bedrock Converse, and the reply is returned in the Anthropic Messages shape the caller parses.
- anthropic_api: `invoke_model` and `converse` go to the Anthropic Messages API
  (https://api.anthropic.com/v1/messages) with the key read from ANTHROPIC_API_KEY_SECRET_ARN.
  The key is never logged or returned.

Keep the agent/ and scripts/v2/workers/ copies byte-identical (parity is unit-tested).
"""
import io
import json
import os
import threading
import urllib.error
import urllib.request

ANTHROPIC_URL = "https://api.anthropic.com/v1/messages"
ANTHROPIC_VERSION = "2023-06-01"
_KEY_LOCK = threading.Lock()
_API_KEY = None


def provider():
    return os.environ.get("MODEL_PROVIDER", "").strip() or "mixed"


def client(region, config=None):
    return ModelClient(region, config)


def wrap(bedrock_client):
    """Route an existing bedrock-runtime client through the configured provider. mixed and
    bedrock_claude need no translation, so they get the original client back unchanged."""
    if provider() in ("mixed", "bedrock_claude"):
        return bedrock_client
    meta = getattr(bedrock_client, "meta", None)
    wrapped = ModelClient(getattr(meta, "region_name", None), getattr(meta, "config", None))
    wrapped._bedrock = bedrock_client
    return wrapped


def api_key():
    """Read and cache the Anthropic API key from Secrets Manager (plain string or {"api_key"})."""
    global _API_KEY
    with _KEY_LOCK:
        if _API_KEY is None:
            import boto3
            arn = os.environ.get("ANTHROPIC_API_KEY_SECRET_ARN", "")
            if not arn:
                raise RuntimeError("anthropic_api_key_unconfigured")
            raw = boto3.client("secretsmanager").get_secret_value(SecretId=arn)["SecretString"].strip()
            try:
                parsed = json.loads(raw)
            except ValueError:
                parsed = raw
            key = parsed.get("api_key") if isinstance(parsed, dict) else parsed
            if not isinstance(key, str) or not key:
                raise RuntimeError("anthropic_api_key_invalid")
            _API_KEY = key
        return _API_KEY


def _timeout(config):
    value = getattr(config, "read_timeout", None)
    return value if isinstance(value, (int, float)) and value > 0 else 300


def anthropic_messages(body, model_id, timeout=300, _retry=True):
    """POST an Anthropic Messages request; returns the decoded JSON reply.

    A 401 drops the cached key and retries once, so a rotated secret takes effect without a redeploy.
    """
    global _API_KEY
    payload = {k: v for k, v in body.items() if k != "anthropic_version"}
    payload["model"] = model_id
    request = urllib.request.Request(
        ANTHROPIC_URL, data=json.dumps(payload).encode(), method="POST",
        headers={"content-type": "application/json", "anthropic-version": ANTHROPIC_VERSION,
                 "x-api-key": api_key()})
    try:
        with urllib.request.urlopen(request, timeout=timeout) as response:
            return json.loads(response.read())
    except urllib.error.HTTPError as error:
        if error.code == 401 and _retry:
            with _KEY_LOCK:
                _API_KEY = None
            return anthropic_messages(body, model_id, timeout, _retry=False)
        try:
            kind = json.loads(error.read()).get("error", {}).get("type", "")
        except (ValueError, AttributeError):
            kind = ""
        raise RuntimeError(f"anthropic_api_error:{error.code}:{kind}"[:120]) from None


def _text_blocks(content):
    if isinstance(content, str):
        return [{"text": content}]
    return [{"text": part.get("text", "")} for part in content or []
            if isinstance(part, dict) and part.get("type", "text") == "text"]


def anthropic_body_to_converse(body):
    """Anthropic Messages body -> Bedrock Converse kwargs (text only; thinking/cache fields drop)."""
    kwargs = {"messages": [{"role": m["role"], "content": _text_blocks(m.get("content"))}
                           for m in body.get("messages", [])]}
    system = body.get("system")
    if system:
        kwargs["system"] = _text_blocks(system)
    config = {"maxTokens": body.get("max_tokens", 1024)}
    for source, target in (("temperature", "temperature"), ("top_p", "topP"),
                           ("stop_sequences", "stopSequences")):
        if source in body:
            config[target] = body[source]
    kwargs["inferenceConfig"] = config
    return kwargs


def converse_to_anthropic_reply(response):
    """Bedrock Converse reply -> Anthropic Messages reply (text blocks, stop reason, usage)."""
    blocks = response.get("output", {}).get("message", {}).get("content", []) or []
    usage = response.get("usage", {}) or {}
    return {"type": "message", "role": "assistant",
            "content": [{"type": "text", "text": b["text"]} for b in blocks if isinstance(b.get("text"), str)],
            "stop_reason": response.get("stopReason"),
            "usage": {"input_tokens": usage.get("inputTokens", 0), "output_tokens": usage.get("outputTokens", 0)}}


def converse_to_anthropic_body(kwargs):
    """Bedrock Converse kwargs -> Anthropic Messages body."""
    body = {"messages": [{"role": m["role"], "content": [{"type": "text", "text": b["text"]}
                                                          for b in m.get("content", []) if "text" in b]}
                         for m in kwargs.get("messages", [])],
            "max_tokens": kwargs.get("inferenceConfig", {}).get("maxTokens", 1024)}
    system = [b["text"] for b in kwargs.get("system", []) or [] if "text" in b]
    if system:
        body["system"] = "\n\n".join(system)
    config = kwargs.get("inferenceConfig", {})
    for source, target in (("temperature", "temperature"), ("topP", "top_p"),
                           ("stopSequences", "stop_sequences")):
        if source in config:
            body[target] = config[source]
    body.update(kwargs.get("additionalModelRequestFields") or {})
    return body


def anthropic_reply_to_converse(reply):
    usage = reply.get("usage", {}) or {}
    return {"output": {"message": {"role": "assistant", "content": [
                {"text": b.get("text", "")} for b in reply.get("content", []) if b.get("type") == "text"]}},
            "stopReason": reply.get("stop_reason"),
            "usage": {"inputTokens": usage.get("input_tokens", 0), "outputTokens": usage.get("output_tokens", 0)},
            "ResponseMetadata": {"HTTPStatusCode": 200}}


class ModelClient:
    def __init__(self, region, config=None):
        self._region, self._config, self._bedrock = region, config, None

    def _runtime(self):
        if self._bedrock is None:
            import boto3
            kwargs = {"region_name": self._region}
            if self._config is not None:
                kwargs["config"] = self._config
            self._bedrock = boto3.client("bedrock-runtime", **kwargs)
        return self._bedrock

    def invoke_model(self, modelId, body, **kwargs):
        parsed = json.loads(body) if isinstance(body, (str, bytes, bytearray)) else body
        if provider() == "anthropic_api":
            reply = anthropic_messages(parsed, modelId, _timeout(self._config))
        elif "openai." in modelId:
            reply = converse_to_anthropic_reply(
                self._runtime().converse(modelId=modelId, **anthropic_body_to_converse(parsed)))
        else:
            return self._runtime().invoke_model(modelId=modelId, body=body, **kwargs)
        return {"body": io.BytesIO(json.dumps(reply).encode()), "contentType": "application/json",
                "ResponseMetadata": {"HTTPStatusCode": 200}}

    def converse(self, **kwargs):
        if provider() == "anthropic_api":
            return anthropic_reply_to_converse(anthropic_messages(
                converse_to_anthropic_body(kwargs), kwargs["modelId"], _timeout(self._config)))
        return self._runtime().converse(**kwargs)
