#!/usr/bin/env python3
"""Prepare and run an immutable codec without workspace mounts or network."""
import argparse
import json
import os
from pathlib import Path
import re
import shutil
import stat
import subprocess
import tempfile
import threading
import uuid

LABEL = "io.awsops.review-codec.run"
PREFIX = "awsops-review-codec"
Timer = threading.Timer


class SandboxError(Exception):
    """Fixed code only; never surface Docker/provider output."""


def docker():
    binary = shutil.which("docker")
    if not binary:
        raise SandboxError("image_sandbox_unavailable")
    return binary

def client_env():
    allowed = ("PATH", "HOME", "DOCKER_HOST", "DOCKER_CONTEXT", "DOCKER_CONFIG",
               "DOCKER_CERT_PATH", "DOCKER_TLS_VERIFY", "XDG_RUNTIME_DIR")
    return {**{key: os.environ[key] for key in allowed if key in os.environ}, "LANG": "C", "LC_ALL": "C"}


def validate_state(value):
    if (not isinstance(value, dict) or type(value.get("schema")) is not int or value["schema"] != 1
            or not isinstance(value.get("run"), str) or not re.fullmatch("[0-9a-f]{32}", value["run"])
            or value.get("tag") != f"{PREFIX}:{value['run']}"
            or not isinstance(value.get("image"), str)
            or not re.fullmatch("sha256:[0-9a-f]{64}", value["image"])):
        raise SandboxError("image_sandbox_invalid_state")
    return value


def load_state(path):
    try:
        descriptor = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
        with os.fdopen(descriptor, "rb") as stream:
            info = os.fstat(stream.fileno())
            if (not stat.S_ISREG(info.st_mode) or info.st_size > 4096
                    or info.st_uid != os.getuid() or stat.S_IMODE(info.st_mode) & 0o077):
                raise SandboxError("image_sandbox_invalid_state")
            return validate_state(json.loads(stream.read(4097)))
    except (OSError, ValueError, TypeError):
        raise SandboxError("image_sandbox_invalid_state") from None


def prepare(output):
    root = Path(__file__).resolve().parent
    run = uuid.uuid4().hex
    tag = f"{PREFIX}:{run}"
    try:
        with tempfile.TemporaryDirectory(prefix="awsops-codec-build-") as temporary:
            context = Path(temporary)
            for source, target in [("codec.Dockerfile", "Dockerfile"),
                                   ("render_head_image.py", "render_head_image.py"),
                                   ("image-formats.json", "image-formats.json"),
                                   ("image-requirements.txt", "image-requirements.txt")]:
                shutil.copyfile(root / source, context / target)
            subprocess.run([docker(), "build", "--quiet", "--iidfile", str(context / "image.id"),
                            "--tag", tag, str(context)], check=True, timeout=600, env=client_env())
            value = validate_state({"schema": 1, "run": run, "tag": tag,
                                    "image": (context / "image.id").read_text().strip()})
        descriptor = os.open(output, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
        with os.fdopen(descriptor, "w") as stream:
            json.dump(value, stream)
            stream.write("\n")
    except BaseException:
        try:
            subprocess.run([docker(), "image", "rm", tag], capture_output=True, timeout=15, env=client_env())
        except (OSError, subprocess.SubprocessError, SandboxError):
            pass
        raise
    return value


def command(value, suffix, dimension, pixels, byte_limit):
    value = validate_state(value)
    if (suffix not in (".png", ".webp", ".ico")
            or any(type(n) is not int or n <= 0 for n in (dimension, pixels, byte_limit))
            or dimension > 8192 or pixels > 16777216 or byte_limit > 8388608):
        raise SandboxError("image_sandbox_invalid_input")
    try:
        actual = subprocess.check_output([docker(), "image", "inspect", "--format", "{{.Id}}", value["tag"]],
                                         stderr=subprocess.DEVNULL, timeout=5, env=client_env()).decode().strip()
    except (OSError, subprocess.SubprocessError):
        raise SandboxError("image_sandbox_unavailable") from None
    if actual != value["image"]:
        raise SandboxError("image_sandbox_image_mismatch")
    name = f"{PREFIX}-{uuid.uuid4().hex}"
    return [docker(), "run", "--rm", "--interactive", "--name", name,
            "--label", f"{LABEL}={value['run']}", "--network", "none", "--read-only",
            "--cap-drop", "ALL", "--security-opt", "no-new-privileges",
            "--user", "65532:65532", "--pids-limit", "32", "--memory", "512m",
            "--cpus", "1", "--log-driver", "none",
            "--tmpfs", "/tmp:rw,noexec,nosuid,nodev,size=32m",
            "--env", "LANG=C", "--env", "LC_ALL=C", value["image"],
            suffix, str(dimension), str(pixels), str(byte_limit)], name


def remove_container(name):
    if not re.fullmatch(f"{PREFIX}-[0-9a-f]{{32}}", name):
        raise SandboxError("image_sandbox_invalid_container")
    try:
        result = subprocess.run([docker(), "rm", "--force", name], capture_output=True, timeout=5, env=client_env())
    except (OSError, subprocess.TimeoutExpired):
        raise SandboxError("image_sandbox_cleanup_failed") from None
    if result.returncode and b"No such container" not in result.stderr:
        raise SandboxError("image_sandbox_cleanup_failed")


def decode(value, suffix, dimension, pixels, byte_limit, blob):
    argv, name = command(value, suffix, dimension, pixels, byte_limit)
    if not isinstance(blob, bytes) or len(blob) > byte_limit:
        raise SandboxError("image_sandbox_invalid_input")
    process = None
    timer = None
    expired = threading.Event()
    try:
        # Create before starting the deadline. A timed-out client cannot leave a
        # late-created, already-running decoder behind an unsuccessful removal.
        create = [argv[0], "create", *[arg for arg in argv[2:] if arg != "--rm"]]
        subprocess.run(create, check=True, capture_output=True, timeout=15, env=client_env())
        process = subprocess.Popen([argv[0], "start", "--attach", "--interactive", name],
                                   stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                                   stderr=subprocess.DEVNULL, env=client_env())
        def kill():
            expired.set()
            process.kill()
        timer = Timer(25, kill)
        timer.start()
        try:
            process.stdin.write(blob)
            process.stdin.close()
        except BrokenPipeError:
            pass
        output = process.stdout.read(byte_limit + 2049)
        if len(output) > byte_limit + 2048:
            process.kill()
            raise SandboxError("image_output_limit")
        status = process.wait()
        if expired.is_set():
            raise SandboxError("image_decode_timeout")
        if status in (137, 139, 152):
            raise SandboxError("image_resource_limit")
        if status in (125, 126, 127) or (status == 1 and not output):
            raise SandboxError("image_sandbox_unavailable")
        return status, output
    except (OSError, subprocess.SubprocessError):
        raise SandboxError("image_sandbox_unavailable") from None
    finally:
        if process:
            if process.poll() is None:
                process.kill()
            process.wait()
            for stream in (process.stdin, process.stdout):
                try:
                    stream.close()
                except OSError:
                    pass
        if timer:
            timer.cancel()
        remove_container(name)


def cleanup(value):
    value = validate_state(value)
    result = subprocess.run([docker(), "ps", "--all", "--quiet", "--filter",
                             f"label={LABEL}={value['run']}"], check=True, capture_output=True, timeout=15, env=client_env())
    ids = result.stdout.decode().split()
    if any(not re.fullmatch("[0-9a-f]{12,64}", item) for item in ids):
        raise SandboxError("image_sandbox_cleanup_failed")
    if ids:
        subprocess.run([docker(), "rm", "--force", *ids], check=True, capture_output=True, timeout=15, env=client_env())
    result = subprocess.run([docker(), "image", "rm", value["tag"]], capture_output=True, timeout=15, env=client_env())
    if result.returncode and b"No such image" not in result.stderr:
        raise SandboxError("image_sandbox_cleanup_failed")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("mode", choices=("prepare", "cleanup"))
    parser.add_argument("--state", required=True)
    args = parser.parse_args()
    try:
        if args.mode == "prepare":
            prepare(args.state)
            print("Prepared isolated image codec.")
        else:
            cleanup(load_state(args.state))
            print("Removed owned codec containers and image tag.")
    except (SandboxError, OSError, subprocess.SubprocessError) as error:
        print(str(error) if isinstance(error, SandboxError) else "image_sandbox_operation_failed")
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
