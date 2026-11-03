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

    def test_uses_sonnet_5_5_without_temperature(self):
        # sonnet-5-5 rejects `temperature` with a ValidationException; sending it fails every call.
        model_id, body = self._invoke_and_capture_body()
        self.assertEqual(model_id, "global.anthropic.claude-sonnet-5-5")
        self.assertNotIn("temperature", body)
        self.assertEqual(body.get("thinking"), {"type": "between_tools"})


if __name__ == "__main__":
    unittest.main()
