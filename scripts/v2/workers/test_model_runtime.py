"""model_runtime: deploy-time model provider switching (Terraform var.model_provider)."""
import io
import json
import os
import pathlib
import sys
import unittest
from unittest import mock

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import model_runtime  # noqa: E402

ROOT = pathlib.Path(__file__).resolve().parents[3]


class FakeBedrock:
    def __init__(self):
        self.calls = []
        self.meta = mock.Mock(region_name="ap-northeast-2", config=None)

    def invoke_model(self, **kwargs):
        self.calls.append(("invoke_model", kwargs))
        return {"body": io.BytesIO(b'{"content":[{"type":"text","text":"claude"}]}')}

    def converse(self, **kwargs):
        self.calls.append(("converse", kwargs))
        return {"output": {"message": {"role": "assistant", "content": [
                    {"reasoningContent": {"reasoningText": {"text": "hidden"}}}, {"text": "gpt"}]}},
                "stopReason": "end_turn", "usage": {"inputTokens": 4, "outputTokens": 2}}


ANTHROPIC_BODY = {"anthropic_version": "bedrock-2023-05-31", "max_tokens": 400,
                  "thinking": {"type": "disabled"}, "system": "sys",
                  "messages": [{"role": "user", "content": "hello"}]}


class ProviderTests(unittest.TestCase):
    def setUp(self):
        model_runtime._API_KEY = None

    def test_mixed_and_bedrock_claude_pass_through_unchanged(self):
        for provider in ("", "mixed", "bedrock_claude"):
            with self.subTest(provider=provider), mock.patch.dict(os.environ, {"MODEL_PROVIDER": provider}):
                fake = FakeBedrock()
                body = json.dumps(ANTHROPIC_BODY)
                out = model_runtime.wrap(fake).invoke_model(modelId="global.anthropic.claude-haiku-5-5", body=body)
                self.assertEqual(fake.calls, [("invoke_model", {"modelId": "global.anthropic.claude-haiku-5-5", "body": body})])
                self.assertEqual(json.loads(out["body"].read())["content"][0]["text"], "claude")

    def test_openai_models_get_converse_and_an_anthropic_shaped_reply(self):
        with mock.patch.dict(os.environ, {"MODEL_PROVIDER": "bedrock_openai"}):
            fake = FakeBedrock()
            out = model_runtime.wrap(fake).invoke_model(modelId="global.openai.gpt-6-luna",
                                                        body=json.dumps(ANTHROPIC_BODY))
        name, kwargs = fake.calls[0]
        self.assertEqual(name, "converse")
        self.assertEqual(kwargs, {"modelId": "global.openai.gpt-6-luna",
                                  "messages": [{"role": "user", "content": [{"text": "hello"}]}],
                                  "system": [{"text": "sys"}], "inferenceConfig": {"maxTokens": 400}})
        reply = json.loads(out["body"].read())
        self.assertEqual(reply["content"], [{"type": "text", "text": "gpt"}])
        self.assertEqual(reply["usage"], {"input_tokens": 4, "output_tokens": 2})

    def _api(self, response, status=200):
        class Resp(io.BytesIO):
            def __enter__(self):
                return self

            def __exit__(self, *a):
                return False
        seen = {}

        def urlopen(request, timeout):
            seen.update(url=request.full_url, headers=dict(request.header_items()),
                        body=json.loads(request.data), timeout=timeout)
            if status != 200:
                import urllib.error
                raise urllib.error.HTTPError(request.full_url, status, "x", {}, io.BytesIO(json.dumps(response).encode()))
            return Resp(json.dumps(response).encode())
        return seen, urlopen

    def test_anthropic_api_invoke_model_posts_messages_with_the_secret_key(self):
        seen, urlopen = self._api({"content": [{"type": "text", "text": "1p"}], "stop_reason": "end_turn"})
        secrets = mock.Mock()
        secrets.get_secret_value.return_value = {"SecretString": '{"api_key": "sk-test"}'}
        env = {"MODEL_PROVIDER": "anthropic_api", "ANTHROPIC_API_KEY_SECRET_ARN": "arn:aws:secretsmanager:x"}
        with mock.patch.dict(os.environ, env), mock.patch("urllib.request.urlopen", urlopen), \
                mock.patch("boto3.client", return_value=secrets):
            out = model_runtime.client("ap-northeast-2").invoke_model(modelId="claude-haiku-5-5",
                                                                      body=json.dumps(ANTHROPIC_BODY))
        self.assertEqual(seen["url"], "https://api.anthropic.com/v1/messages")
        self.assertEqual(seen["headers"]["X-api-key"], "sk-test")
        self.assertNotIn("anthropic_version", seen["body"])
        self.assertEqual(seen["body"]["model"], "claude-haiku-5-5")
        self.assertEqual(seen["body"]["thinking"], {"type": "disabled"})
        self.assertEqual(json.loads(out["body"].read())["content"][0]["text"], "1p")
        secrets.get_secret_value.assert_called_once_with(SecretId="arn:aws:secretsmanager:x")

    def test_anthropic_api_converse_maps_request_and_reply(self):
        seen, urlopen = self._api({"content": [{"type": "text", "text": "READY"}], "stop_reason": "end_turn",
                                   "usage": {"input_tokens": 3, "output_tokens": 1}})
        model_runtime._API_KEY = "sk-cached"
        with mock.patch.dict(os.environ, {"MODEL_PROVIDER": "anthropic_api"}), \
                mock.patch("urllib.request.urlopen", urlopen):
            out = model_runtime.client("ap-northeast-2").converse(
                modelId="claude-sonnet-5-5", messages=[{"role": "user", "content": [{"text": "ping"}]}],
                inferenceConfig={"maxTokens": 128},
                additionalModelRequestFields={"thinking": {"type": "between_tools"}})
        self.assertEqual(seen["body"], {"messages": [{"role": "user", "content": [{"type": "text", "text": "ping"}]}],
                                        "max_tokens": 128, "thinking": {"type": "between_tools"},
                                        "model": "claude-sonnet-5-5"})
        self.assertEqual(out["stopReason"], "end_turn")
        self.assertEqual(out["output"]["message"], {"role": "assistant", "content": [{"text": "READY"}]})
        self.assertEqual(out["ResponseMetadata"]["HTTPStatusCode"], 200)

    def test_api_errors_expose_only_status_and_type(self):
        seen, urlopen = self._api({"error": {"type": "permission_error", "message": "sk-cached is bad"}}, 403)
        model_runtime._API_KEY = "sk-cached"
        with mock.patch.dict(os.environ, {"MODEL_PROVIDER": "anthropic_api"}), \
                mock.patch("urllib.request.urlopen", urlopen):
            with self.assertRaises(RuntimeError) as ctx:
                model_runtime.client("r").converse(modelId="claude-haiku-5-5", messages=[])
        self.assertEqual(str(ctx.exception), "anthropic_api_error:403:permission_error")

    def test_rotated_key_is_refetched_once_after_401(self):
        import urllib.error
        keys = []

        def urlopen(request, timeout):
            keys.append(dict(request.header_items())["X-api-key"])
            if len(keys) == 1:
                raise urllib.error.HTTPError(request.full_url, 401, "x", {}, io.BytesIO(b'{"error":{"type":"authentication_error"}}'))
            return io.BytesIO(json.dumps({"content": [{"type": "text", "text": "ok"}], "stop_reason": "end_turn"}).encode())
        secrets = mock.Mock()
        secrets.get_secret_value.return_value = {"SecretString": "sk-new"}
        model_runtime._API_KEY = "sk-old"
        env = {"MODEL_PROVIDER": "anthropic_api", "ANTHROPIC_API_KEY_SECRET_ARN": "arn:aws:secretsmanager:x"}
        with mock.patch.dict(os.environ, env), mock.patch("urllib.request.urlopen", urlopen), \
                mock.patch("boto3.client", return_value=secrets):
            reply = model_runtime.anthropic_messages({"messages": []}, "claude-haiku-5-5")
        self.assertEqual(keys, ["sk-old", "sk-new"])
        self.assertEqual(reply["content"][0]["text"], "ok")

    def test_missing_secret_arn_fails_closed(self):
        with mock.patch.dict(os.environ, {"MODEL_PROVIDER": "anthropic_api", "ANTHROPIC_API_KEY_SECRET_ARN": ""}):
            with self.assertRaisesRegex(RuntimeError, "anthropic_api_key_unconfigured"):
                model_runtime.client("r").converse(modelId="claude-haiku-5-5", messages=[])

    def test_agent_copy_is_byte_identical(self):
        self.assertEqual((ROOT / "agent/model_runtime.py").read_bytes(),
                         (ROOT / "scripts/v2/workers/model_runtime.py").read_bytes())


class ProvisionerModelEnvTests(unittest.TestCase):
    def test_only_known_keys_with_plain_values_reach_the_runtime(self):
        sys.path.insert(0, str(ROOT / "scripts/v2/agentcore"))
        import provision
        env = provision.runtime_model_env({
            "MODEL_PROVIDER": "bedrock_openai", "AGENT_MODEL_ID": "global.openai.gpt-6-luna",
            "DATASOURCE_QUERYGEN_FALLBACK_MODEL_ID": "",
            "ANTHROPIC_API_KEY_SECRET_ARN": "arn:aws:secretsmanager:ap-northeast-2:123456789012:secret:k-AbC",
            "GATEWAYS_JSON": "{}", "AGENT_MAX_TOKENS": "1", "RCA_MODEL_ID": "bad value; rm -rf"})
        self.assertEqual(env, {"MODEL_PROVIDER": "bedrock_openai", "AGENT_MODEL_ID": "global.openai.gpt-6-luna",
                               "DATASOURCE_QUERYGEN_FALLBACK_MODEL_ID": "",
                               "ANTHROPIC_API_KEY_SECRET_ARN": "arn:aws:secretsmanager:ap-northeast-2:123456789012:secret:k-AbC"})
        self.assertEqual(provision.runtime_model_env(None), {})


if __name__ == "__main__":
    unittest.main()
