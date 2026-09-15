"""Offline capability diagnostic fixtures: every Claude call is a local fake."""
import copy
import importlib.util
import json
import os
from pathlib import Path
import struct
import subprocess
import tempfile
import unittest
from unittest.mock import patch
import zlib

ROOT = Path(__file__).resolve().parents[2]
HELPER = ROOT / "scripts/pr-review/image_capability.py"
WORKFLOW = ROOT / ".github/workflows/review-image-capability.yml"


def trace(image, answer):
    return [
        {"type": "system", "subtype": "init"},
        {"type": "assistant", "message": {"content": [
            {"type": "tool_use", "id": "read-1", "name": "Read",
             "input": {"file_path": str(image)}}]}},
        {"type": "user", "message": {"content": [
            {"type": "tool_result", "tool_use_id": "read-1", "content": [
                {"type": "image", "source": {"type": "base64", "data": "synthetic"}}]}]}},
        {"type": "assistant", "message": {"content": [{"type": "text", "text": answer}]}},
        {"type": "result", "subtype": "success", "is_error": False,
         "result": answer, "permission_denials": []},
    ]


def encode(events):
    return ("\n".join(json.dumps(event) for event in events) + "\n").encode()


class CapabilityTests(unittest.TestCase):
    def setUp(self):
        self.assertTrue(HELPER.exists(), "trusted standalone diagnostic helper is missing")
        spec = importlib.util.spec_from_file_location("image_capability", HELPER)
        self.module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(self.module)
        temporary = tempfile.TemporaryDirectory(prefix="image-capability-test-")
        self.addCleanup(temporary.cleanup)
        self.parent = Path(temporary.name)
        self.env = {
            "GITHUB_REPOSITORY": "aws-samples/sample-awsops",
            "GITHUB_REF": "refs/heads/dev", "GITHUB_EVENT_NAME": "workflow_dispatch",
            "GITHUB_SHA": "a" * 40, "RUNNER_TEMP": str(self.parent),
            "GITHUB_OUTPUT": str(self.parent / "output"),
        }

    def prepare(self):
        with patch.object(self.module, "capture", return_value=b"2.1.270 (Claude Code)\n"):
            root = self.module.prepare(self.env)
        self.addCleanup(lambda: self.module.cleanup(root, self.env) if root.exists() else None)
        self.env["PROBE_ROOT"] = str(root)
        return root

    def test_stdlib_png_has_correct_crc_pixels_and_no_plaintext_answer(self):
        image = self.module.make_png("012345")
        self.assertEqual(image[:8], b"\x89PNG\r\n\x1a\n")
        self.assertNotIn(b"012345", image)
        offset, chunks = 8, {}
        while offset < len(image):
            size, kind = struct.unpack(">I4s", image[offset:offset + 8])
            data = image[offset + 8:offset + 8 + size]
            crc = struct.unpack(">I", image[offset + 8 + size:offset + 12 + size])[0]
            self.assertEqual(crc, zlib.crc32(kind + data))
            chunks[kind] = data
            offset += size + 12
        width, height, depth, color, _, _, interlace = struct.unpack(">IIBBBBB", chunks[b"IHDR"])
        self.assertEqual((depth, color, interlace), (8, 2, 0))
        rows = zlib.decompress(chunks[b"IDAT"])
        self.assertEqual(len(rows), height * (1 + width * 3))
        self.assertIn(b"\0\0\0", rows)
        self.assertIn(b"\xff\xff\xff", rows)
        self.assertNotEqual(image, self.module.make_png("987654"))

    def test_prepare_is_before_auth_private_and_answer_is_not_prompt_data(self):
        root = self.prepare()
        self.assertEqual(root.parent, self.parent)
        state = json.loads((root / "control.json").read_text())
        self.assertRegex(state["answer"], r"^\d{6}$")
        self.assertEqual((root.stat().st_mode & 0o777), 0o700)
        self.assertEqual(((root / "control.json").stat().st_mode & 0o777), 0o600)
        image = root / "evidence/image.png"
        self.assertEqual(image.stat().st_mode & 0o777, 0o400)
        self.assertEqual(image.parent.stat().st_mode & 0o777, 0o500)
        self.assertNotIn(state["answer"], self.module.prompt(image))
        self.assertNotIn("AWS_ACCESS_KEY_ID", self.env)

    def test_exact_read_image_result_and_answer_are_required(self):
        image = self.parent / "image.png"
        self.module.validate_trace(encode(trace(image, "012345")), image, "012345")
        changes = {
            "no_read": lambda events: events.pop(1),
            "wrong_path": lambda events: events[1]["message"]["content"][0]["input"].update(file_path="/other"),
            "other_tool": lambda events: events[1]["message"]["content"][0].update(name="Grep"),
            "failed_read": lambda events: events[2]["message"]["content"][0].update(is_error=True),
            "wrong_tool_id": lambda events: events[2]["message"]["content"][0].update(tool_use_id="other"),
            "no_image": lambda events: events[2]["message"]["content"][0].update(content="not an image"),
            "wrong_answer": lambda events: events[-1].update(result="999999"),
            "denied": lambda events: events[-1].update(permission_denials=[{"tool_name": "Read"}]),
            "failed_result": lambda events: events[-1].update(is_error=True),
            "not_success": lambda events: events[-1].update(subtype="error_max_turns"),
            "extra_tool": lambda events: events.insert(3, copy.deepcopy(events[1])),
            "duplicate_result": lambda events: events.append(copy.deepcopy(events[-1])),
            "tool_after_result": lambda events: events.append(copy.deepcopy(events[1])),
        }
        for name, modify in changes.items():
            with self.subTest(name=name):
                events = trace(image, "012345")
                modify(events)
                with self.assertRaises(self.module.ProbeError):
                    self.module.validate_trace(encode(events), image, "012345")
        for raw in (b"not json", b"\xff", b"x" * (self.module.OUTPUT_LIMIT + 1)):
            with self.assertRaises(self.module.ProbeError):
                self.module.validate_trace(raw, image, "012345")

    def test_wrong_context_and_unsafe_cleanup_fail_closed(self):
        for key, value in (("GITHUB_REPOSITORY", "fork/sample-awsops"),
                           ("GITHUB_REF", "refs/heads/main"),
                           ("GITHUB_EVENT_NAME", "pull_request"),
                           ("GITHUB_SHA", "$(bad)")):
            with self.subTest(key=key), self.assertRaises(self.module.ProbeError):
                self.module.prepare({**self.env, key: value})
        outsider = self.parent / "do-not-delete"
        outsider.mkdir()
        with self.assertRaises(self.module.ProbeError):
            self.module.cleanup(outsider, self.env)
        self.assertTrue(outsider.exists())

    def test_child_env_requires_fresh_credentials_and_drops_command_channels(self):
        root = self.prepare()
        with self.assertRaises(self.module.ProbeError):
            self.module.child_env(root, self.env, authenticated=True)
        env = {**self.env, "AWS_ACCESS_KEY_ID": "fake-access", "AWS_SECRET_ACCESS_KEY": "fake-secret",
               "AWS_SESSION_TOKEN": "fake-session", "GITHUB_TOKEN": "must-not-forward",
               "ANTHROPIC_API_KEY": "must-not-forward", "AWS_PROFILE": "must-not-forward"}
        child = self.module.child_env(root, env, authenticated=True)
        self.assertEqual(child["AWS_SESSION_TOKEN"], "fake-session")
        self.assertEqual(child["ANTHROPIC_MODEL"], "us.anthropic.claude-fable-5")
        for name in ("GITHUB_TOKEN", "GITHUB_OUTPUT", "ANTHROPIC_API_KEY", "AWS_PROFILE"):
            self.assertNotIn(name, child)

    def test_one_mocked_cli_call_has_same_read_only_flags_and_safe_proof(self):
        root = self.prepare()
        state = json.loads((root / "control.json").read_text())
        image = root / "evidence/image.png"
        self.env.update(AWS_ACCESS_KEY_ID="fake", AWS_SECRET_ACCESS_KEY="fake", AWS_SESSION_TOKEN="fake")
        with patch.object(self.module, "capture", return_value=encode(trace(image, state["answer"]))) as call:
            proof = self.module.run_probe(root, self.env)
        self.assertEqual(call.call_count, 1)
        args, cwd, env = call.call_args.args[:3]
        self.assertEqual(cwd, root / "base")
        self.assertNotIn(str(cwd), str(image))
        for flag in ("--strict-mcp-config", "--tools", "--allowedTools", "--setting-sources",
                     "--no-session-persistence", "--verbose"):
            self.assertIn(flag, args)
        self.assertEqual(args[args.index("--tools") + 1], "Read,Grep,Glob")
        self.assertEqual(args[args.index("--allowedTools") + 1], "Read,Grep,Glob")
        self.assertEqual(args[args.index("--output-format") + 1], "stream-json")
        self.assertNotIn(state["answer"], " ".join(args))
        self.assertEqual(proof["status"], "passed")
        self.assertTrue(proof["read_exact_file"] and proof["answer_matches"])
        self.assertEqual(proof["invoked_tools"], ["Read"])
        self.assertNotIn(state["answer"], json.dumps(proof))
        self.assertNotIn(str(root), json.dumps(proof))

    def test_capture_bounds_nonzero_timeout_and_output_without_printing_raw(self):
        for command, seconds, limit, code in [
            (["python3", "-c", "print('PRIVATE'); raise SystemExit(1)"], 2, 1024, "cli_failed"),
            (["python3", "-c", "import time; time.sleep(3)"], 0.05, 1024, "timeout"),
            (["python3", "-c", "print('x'*4096)"], 2, 128, "output_limit"),
        ]:
            with self.subTest(code=code), self.assertRaises(self.module.ProbeError) as raised:
                self.module.capture(command, self.parent, dict(os.environ), seconds, limit)
            self.assertEqual(raised.exception.code, code)
            self.assertNotIn("PRIVATE", str(raised.exception))

    def test_real_helper_process_with_fake_cli_publishes_only_safe_proof_and_cleans(self):
        binaries = self.parent / "bin"
        binaries.mkdir()
        fake = binaries / "claude"
        fake.write_text("""#!/usr/bin/python3
import os, pathlib, sys
base = pathlib.Path(__file__).parent
assert os.getcwd().endswith('/base')
assert '--strict-mcp-config' in sys.argv and '--no-session-persistence' in sys.argv
assert 'GITHUB_OUTPUT' not in os.environ and 'GITHUB_TOKEN' not in os.environ
with (base / 'calls').open('a') as stream: stream.write('called\\n')
sys.stdout.buffer.write((base / 'response').read_bytes())
sys.exit(int((base / 'exit').read_text()))
""")
        fake.chmod(0o700)
        for index, mode in enumerate(("valid", "other_tool", "cli_failure", "malformed"), 1):
            with self.subTest(mode=mode):
                root = self.prepare()
                state = json.loads((root / "control.json").read_text())
                events = trace(root / "evidence/image.png", state["answer"])
                events[3]["message"]["content"].insert(0, {"type": "text", "text": "PRIVATE_RESPONSE_MARKER"})
                if mode == "other_tool":
                    events[1]["message"]["content"][0]["name"] = "Bash"
                (binaries / "response").write_bytes(b"PRIVATE_RESPONSE_MARKER" if mode == "malformed" else encode(events))
                (binaries / "exit").write_text("1" if mode == "cli_failure" else "0")
                env = {**os.environ, **self.env, "PATH": f"{binaries}:{os.environ['PATH']}",
                       "AWS_ACCESS_KEY_ID": "fake", "AWS_SECRET_ACCESS_KEY": "fake",
                       "AWS_SESSION_TOKEN": "fake", "GITHUB_TOKEN": "PRIVATE_TOKEN"}
                run = subprocess.run(["python3", str(HELPER), "run"], env=env, capture_output=True, text=True)
                finish = subprocess.run(["python3", str(HELPER), "finish"], env=env, capture_output=True, text=True)
                expected = 0 if mode == "valid" else 1
                self.assertEqual((run.returncode, finish.returncode), (expected, expected))
                proof = json.loads(finish.stdout)
                self.assertEqual(proof["status"], "passed" if mode == "valid" else "failed")
                if mode != "valid":
                    self.assertIsNone(proof["invoked_tools"], "failed proof cannot claim no tools ran")
                public = run.stdout + run.stderr + finish.stdout + finish.stderr
                for private in ("PRIVATE_RESPONSE_MARKER", "PRIVATE_TOKEN", state["answer"], str(root)):
                    self.assertNotIn(private, public)
                self.assertFalse(root.exists())
                self.assertEqual((binaries / "calls").read_text().splitlines(), ["called"] * index)

    def test_finish_handles_missing_proof_and_removes_only_owned_files(self):
        root = self.prepare()
        untouched = self.parent / "unrelated"
        untouched.write_text("keep")
        proof = self.module.finish(self.env)
        self.assertEqual(proof["status"], "failed")
        self.assertFalse(root.exists())
        self.assertEqual(untouched.read_text(), "keep")

    def test_finish_does_not_publish_malformed_or_extra_proof_fields(self):
        for value in ([], {"status": "passed", "private": "SECRET"}):
            with self.subTest(value=value):
                root = self.prepare()
                self.module.private_write(root / "proof.json", json.dumps(value).encode())
                proof = self.module.finish(self.env)
                self.assertEqual(proof["status"], "failed")
                self.assertNotIn("SECRET", json.dumps(proof))
                self.assertFalse(root.exists())


class WorkflowTests(unittest.TestCase):
    def test_dispatch_guard_credentials_order_and_cleanup(self):
        self.assertTrue(WORKFLOW.exists(), "standalone manual diagnostic workflow is missing")
        import yaml
        workflow = yaml.safe_load(WORKFLOW.read_text())
        self.assertEqual(workflow.get("on", workflow.get(True)), {"workflow_dispatch": None})
        job = workflow["jobs"]["capability"]
        for value in ("aws-samples/sample-awsops", "refs/heads/dev", "workflow_dispatch"):
            self.assertIn(value, job["if"])
        self.assertEqual(job["runs-on"], "sample-awsops")
        self.assertEqual(job["environment"], "ci-review-auto")
        self.assertLessEqual(job["timeout-minutes"], 5)
        self.assertEqual(job["permissions"], {"contents": "read", "id-token": "write"})
        steps = job["steps"]
        self.assertEqual(steps[0]["with"], {"ref": "${{ github.sha }}", "persist-credentials": False})
        credential = next(i for i, step in enumerate(steps) if step.get("uses", "").startswith("aws-actions/"))
        self.assertIn(" prepare", steps[credential - 1]["run"])
        self.assertIn(" run", steps[credential + 1]["run"])
        self.assertEqual(steps[credential]["uses"], "aws-actions/configure-aws-credentials@v4")
        config = steps[credential]["with"]
        self.assertEqual(config["role-to-assume"], "${{ secrets.AWS_CI_REVIEW_ROLE_ARN }}")
        self.assertEqual(config["aws-region"], "us-east-1")
        self.assertTrue(config["mask-aws-account-id"] and config["unset-current-credentials"])
        self.assertFalse(config["use-existing-credentials"])
        self.assertEqual(steps[-1]["if"], "always()")
        self.assertIn(" finish", steps[-1]["run"])
        self.assertNotIn("upload-artifact", WORKFLOW.read_text())
        self.assertNotIn("pull_request", WORKFLOW.read_text())


if __name__ == "__main__":
    unittest.main()
