"""Unit tests for rca_orchestrator.py's _bedrock_invoke request body.

Run from this directory:  cd agent && python3 -m unittest test_rca_orchestrator
"""
import json
import unittest
from unittest.mock import MagicMock, patch

import rca_orchestrator


class BedrockInvokeRequestBodyTest(unittest.TestCase):
    def _invoke_and_capture_body(self):
        fake_response = {"body": MagicMock(read=lambda: json.dumps({"content": []}).encode())}
        fake_client = MagicMock(invoke_model=MagicMock(return_value=fake_response))
        with patch("boto3.client", return_value=fake_client):
            rca_orchestrator._bedrock_invoke("prompt text")
        _, kwargs = fake_client.invoke_model.call_args
        return kwargs["modelId"], json.loads(kwargs["body"])

    def test_stays_on_sonnet_4_6_with_deterministic_temperature(self):
        # Model stays on sonnet-4-6 (AGENTS.md's pinned RCA model) — bumping to sonnet-5 is a
        # separate decision (own PR + ADR), not something to bundle into a hotfix. And since
        # sonnet-4-6 accepts `temperature`, ADR-038 determinism (temperature=0) stays in force
        # on this path. NOTE for the future model-bump PR: sonnet-5 rejects `temperature`
        # outright (ValidationException — see agent.py's MODEL_ID + hotfix c30ac9e7), so that
        # PR must drop the param and update this test together with the modelId.
        model_id, body = self._invoke_and_capture_body()
        self.assertEqual(model_id, "global.anthropic.claude-sonnet-4-6")
        self.assertEqual(body.get("temperature"), 0)


if __name__ == "__main__":
    unittest.main()
