"""Haiku request-shape guard shared by the short Haiku worker calls.

Haiku 5.x accepts `thinking: {"type": "disabled"}`; Haiku 4.5 (the rollback value of every
override env) takes no thinking field, so the guard must match `claude-haiku-5` only.
"""
import json
import os
import sys
import types

import pytest

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
sys.path.insert(0, os.path.join(HERE, "diagnosis"))

import graph_querygen  # noqa: E402
import signal_catalog_gen  # noqa: E402
from finops import llm  # noqa: E402
from insight import generate  # noqa: E402

HAIKU_55 = "global.anthropic.claude-haiku-5-5"
HAIKU_45 = "global.anthropic.claude-haiku-4-5-20251001-v1:0"


class _FakeClient:
    def __init__(self):
        self.body = None

    def invoke_model(self, modelId, body):
        self.body = json.loads(body)

        class _R:
            def read(self):
                return json.dumps({"content": [{"type": "text", "text": "ok"}]}).encode()

        return {"body": _R()}


def _fake_boto3(monkeypatch):
    client = _FakeClient()
    monkeypatch.setitem(sys.modules, "boto3", types.SimpleNamespace(client=lambda *a, **k: client))
    return client


@pytest.mark.parametrize("module,env", [
    (graph_querygen, "GRAPH_QUERYGEN_MODEL_ID"),
    (signal_catalog_gen, "GRAPH_QUERYGEN_MODEL_ID"),
    (generate, "INSIGHT_MODEL_ID"),
])
@pytest.mark.parametrize("model_id,expected", [(HAIKU_55, {"type": "disabled"}), (HAIKU_45, None)])
def test_bedrock_invoke_disables_thinking_only_for_haiku_5(monkeypatch, module, env, model_id, expected):
    client = _fake_boto3(monkeypatch)
    monkeypatch.setenv(env, model_id)
    module._bedrock_invoke("prompt")
    assert client.body.get("thinking") == expected
    assert "temperature" not in client.body


@pytest.mark.parametrize("model_id,expected", [(HAIKU_55, {"type": "disabled"}), (HAIKU_45, None)])
def test_finops_explain_disables_thinking_only_for_haiku_5(monkeypatch, model_id, expected):
    client = _FakeClient()
    monkeypatch.setattr(llm, "_get_client", lambda: client)
    monkeypatch.setattr(llm, "_MODEL_ID", model_id)
    llm.explain("Unattached EBS volume vol-1", "storage", 9.12, {"size_gib": 100})
    assert client.body.get("thinking") == expected
    assert "temperature" not in client.body
