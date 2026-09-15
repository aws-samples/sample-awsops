"""Real container confinement and byte transport; Docker is a required prerequisite."""
import importlib.util
import json
import os
import re
from pathlib import Path
import struct
import subprocess
import uuid
import zlib

import pytest

ROOT = Path(__file__).resolve().parents[2]
SPEC = importlib.util.spec_from_file_location("codec_sandbox", ROOT / "scripts/pr-review/codec_sandbox.py")
codec = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(codec)


@pytest.fixture(scope="module")
def state():
    path = os.environ.get("AWSOPS_REVIEW_CODEC_STATE")
    if not path:
        pytest.fail("Prepare the codec with codec_sandbox.py and set AWSOPS_REVIEW_CODEC_STATE")
    return codec.load_state(path)


def png(width=2, height=2):
    def chunk(kind, data):
        return struct.pack(">I", len(data)) + kind + data + struct.pack(">I", zlib.crc32(kind + data))
    return (b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", struct.pack(">IIBBBBB", width, height, 8, 2, 0, 0, 0))
            + chunk(b"IDAT", zlib.compress((b"\0" + b"\xff\0\0" * width) * height)) + chunk(b"IEND", b""))


def test_png_transport_retains_exact_validated_bytes(state):
    data = png()
    status, output = codec.decode(state, ".png", 8192, 16777216, 8388608, data)
    header, rendered = output.split(b"\n", 1)
    assert status == 0 and rendered == data
    assert json.loads(header) == {"source_format": "PNG", "source_width": 2,
                                  "source_height": 2, "frames": 1, "decoder": "Pillow-12.3.0",
                                  "rendered_width": 2, "rendered_height": 2}

@pytest.mark.parametrize("limit,expected", [(32, "image_dimension_limit"), (128, None)])
def test_ico_checks_embedded_dimensions_after_load(state, limit, expected):
    embedded = png(64, 2)
    ico = struct.pack("<HHHBBBBHHII", 0, 1, 1, 16, 16, 0, 0, 1, 32, len(embedded), 22) + embedded
    status, output = codec.decode(state, ".ico", limit, 16777216, 8388608, ico)
    if expected:
        assert status == 1 and json.loads(output)["error"] == expected
    else:
        header, _ = output.split(b"\n", 1)
        assert status == 0
        assert json.loads(header) == {
            "source_format": "ICO", "source_width": 64, "source_height": 2, "frames": 1,
            "decoder": "Pillow-12.3.0", "rendered_width": 64, "rendered_height": 2}

def test_pixel_limit_has_a_fixed_dimension_reason(state):
    status, output = codec.decode(state, ".png", 8192, 10, 8388608, png(8, 2))
    assert status == 1 and json.loads(output)["error"] == "image_dimension_limit"

def test_png_drops_trailing_non_image_bytes(state):
    data = png()
    status, output = codec.decode(state, ".png", 8192, 16777216, 8388608, data + b"PRIVATE_TRAILER")
    assert status == 0 and output.split(b"\n", 1)[1] == data


def test_malformed_image_is_a_bounded_decoder_error(state):
    status, output = codec.decode(state, ".png", 8192, 16777216, 8388608, b"PRIVATE-invalid-image")
    assert status == 1
    assert json.loads(output)["error"] == "image_decode_failed"
    assert b"PRIVATE" not in output


@pytest.mark.parametrize("suffix", [".jpg", ".gif", ".svg", "--privileged"])
def test_unapproved_decoder_input_is_rejected_before_docker(state, suffix, monkeypatch):
    monkeypatch.setattr(codec.subprocess, "Popen", lambda *a, **k: pytest.fail("Docker must not start"))
    with pytest.raises(codec.SandboxError, match="image_sandbox_invalid_input"):
        codec.decode(state, suffix, 8192, 16777216, 8388608, b"data")


def test_state_rejects_mutable_image_or_foreign_cleanup_tag():
    base = {"schema": 1, "run": "a" * 32, "tag": "awsops-review-codec:" + "a" * 32,
            "image": "sha256:" + "b" * 64}
    for change in [{"image": "python:latest"}, {"tag": "unrelated:latest"}, {"run": "../foreign"}, {"schema": True}]:
        with pytest.raises(codec.SandboxError):
            codec.validate_state({**base, **change})

def test_deadline_removes_the_created_decoder(state, monkeypatch):
    original_command, original_timer = codec.command, codec.Timer
    names = []

    def sleeping(*args):
        argv, name = original_command(*args)
        names.append(name)
        index = argv.index(state["image"])
        return argv[:index] + ["--entrypoint", "python", state["image"],
                               "-I", "-c", "import time; time.sleep(60)"], name

    monkeypatch.setattr(codec, "command", sleeping)
    monkeypatch.setattr(codec, "Timer", lambda _seconds, callback: original_timer(.2, callback))
    with pytest.raises(codec.SandboxError, match="image_decode_timeout"):
        codec.decode(state, ".png", 8192, 16777216, 8388608, png())
    result = subprocess.run([codec.docker(), "inspect", names[0]], capture_output=True, timeout=5)
    assert result.returncode != 0 and b"No such" in result.stderr


def test_actual_namespace_cannot_write_root_or_read_host_credentials(state, tmp_path):
    marker = ROOT / f".codec-host-marker-{uuid.uuid4().hex}"
    marker.write_text("HOST_PRIVATE")
    argv, name = codec.command(state, ".png", 8192, 16777216, 8388608)
    index = argv.index(state["image"])
    probe = f"""
import json,os,socket
from pathlib import Path
status = dict(line.split(':',1) for line in Path('/proc/self/status').read_text().splitlines() if ':' in line)
mounts = [line.split() for line in Path('/proc/mounts').read_text().splitlines()]
print(json.dumps({{
 'uid':os.getuid(), 'caps':status['CapEff'].strip(), 'no_new_privs':status['NoNewPrivs'].strip(),
 'interfaces':[name for _,name in socket.if_nameindex()],
 'root_readonly':any(row[1]=='/' and 'ro' in row[3].split(',') for row in mounts),
 'host_marker_visible':Path({str(marker)!r}).exists(),
 'host_env_visible':any(key in os.environ for key in ('GH_TOKEN','AWS_ACCESS_KEY_ID','AWS_SESSION_TOKEN')),
}}))
"""
    try:
        result = subprocess.run(argv[:index] + ["--entrypoint", "python", state["image"], "-I", "-c", probe],
                                capture_output=True, timeout=15,
                                env={**os.environ, "GH_TOKEN": "HOST_TOKEN_CANARY"})
        assert result.returncode == 0, result.stderr.decode(errors="replace")
        proof = json.loads(result.stdout)
        assert proof == {"uid": 65532, "caps": "0000000000000000", "no_new_privs": "1",
                         "interfaces": ["lo"], "root_readonly": True,
                         "host_marker_visible": False, "host_env_visible": False}
    finally:
        codec.remove_container(name)
        marker.unlink()


def test_cleanup_removes_only_its_own_run(state):
    owned = []
    try:
        for _ in range(2):
            nonce = uuid.uuid4().hex
            current = {**state, "run": nonce, "tag": f"{codec.PREFIX}:{nonce}"}
            subprocess.run([codec.docker(), "tag", state["image"], current["tag"]],
                           check=True, capture_output=True, timeout=10)
            argv, name = codec.command(current, ".png", 8192, 16777216, 8388608)
            index = argv.index(current["image"])
            subprocess.run(argv[:2] + ["--detach"] + argv[2:index]
                           + ["--entrypoint", "python", current["image"], "-I", "-c", "import time; time.sleep(60)"],
                           check=True, capture_output=True, timeout=15)
            owned.append((current, name))
        codec.cleanup(owned[0][0])
        codec.cleanup(owned[0][0])  # An already-cleaned run is a benign no-op.
        absent = subprocess.run([codec.docker(), "inspect", owned[0][1]], capture_output=True)
        other = subprocess.check_output([codec.docker(), "inspect", "--format", "{{.State.Running}}", owned[1][1]], text=True)
        assert absent.returncode != 0 and other.strip() == "true"
        owned.pop(0)
    finally:
        for current, _ in owned:
            codec.cleanup(current)

def test_state_permissions_and_tag_binding_are_verified(state, tmp_path):
    path = tmp_path / "state.json"
    path.write_text(json.dumps(state))
    path.chmod(0o644)
    with pytest.raises(codec.SandboxError, match="invalid_state"):
        codec.load_state(path)
    path.chmod(0o600)
    assert codec.load_state(path) == state
    with pytest.raises(codec.SandboxError, match="image_mismatch"):
        codec.command({**state, "image": "sha256:" + "f" * 64}, ".png", 8192, 16777216, 8388608)

def test_docker_client_does_not_inherit_review_credentials(monkeypatch):
    for key in ("GH_TOKEN", "GITHUB_TOKEN", "AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY", "AWS_SESSION_TOKEN"):
        monkeypatch.setenv(key, "PRIVATE_CANARY")
    assert not any(key.startswith("AWS_") or "TOKEN" in key for key in codec.client_env())

def test_fixed_codes_are_documented():
    text = (ROOT / "docs/runbooks/review-codec-sandbox.md").read_text()
    codes = set()
    for path in ("codec_sandbox.py", "render_head_image.py"):
        codes.update(re.findall(r'["\'](image_[a-z_]+)["\']', (ROOT / "scripts/pr-review" / path).read_text()))
    assert codes and all(f"`{code}`" in text for code in codes)
