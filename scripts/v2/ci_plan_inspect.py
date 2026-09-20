"""Inspect an authenticated saved plan privately; never initialize, approve or apply."""
import argparse
import json
import os
from pathlib import Path
import re
import selectors
import shutil
import signal
import stat
import subprocess
import sys
import tempfile
import time

import ci_plan_context
import ci_tf_assets as assets

MAX_ARTIFACT = 136 * 1024 * 1024
MAX_RENDER = 32 * 1024 * 1024


class ArtifactError(ValueError):
    """Only fixed categories may cross the CLI boundary."""


class Parser(argparse.ArgumentParser):
    def error(self, message):
        raise ArtifactError("invalid_arguments")


def real_path(path):
    path = Path(path).absolute()
    if path != path.resolve() or any(ord(c) < 32 for c in str(path)):
        raise ArtifactError("unsafe_path")
    return path


def new_destination(path):
    path = real_path(path)
    if path.exists() or not path.parent.is_dir():
        raise ArtifactError("destination_not_new")
    return path


def private_write(path, value):
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
    with os.fdopen(fd, "wb") as output:
        output.write(value)


def regular_bytes(path, limit):
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    with os.fdopen(fd, "rb") as source:
        info = os.fstat(source.fileno())
        if not stat.S_ISREG(info.st_mode) or info.st_size > limit:
            raise ArtifactError("invalid_file")
        value = source.read(limit + 1)
        if len(value) > limit:
            raise ArtifactError("output_limit")
        return value


def tool_env(source=None, *, github=False):
    source = os.environ if source is None else source
    keys = ["PATH", "LANG", "LC_ALL", "LD_LIBRARY_PATH", "SYSTEMROOT"]
    if github:
        keys += ["HOME", "GH_CONFIG_DIR", "GH_TOKEN", "GITHUB_TOKEN"]
    return {key: source[key] for key in keys if key in source}


def private_command(args, output, *, cwd=None, env=None, limit=MAX_RENDER,
                    timeout=120, truncate=False, include_stderr=False):
    """Drain output with bounded storage. Truncation never interrupts Terraform apply."""
    fd = os.open(output, os.O_WRONLY | os.O_CREAT | os.O_TRUNC | os.O_NOFOLLOW, 0o600)
    process = None
    handlers = {}
    with os.fdopen(fd, "wb") as target:
        if not stat.S_ISREG(os.fstat(target.fileno()).st_mode):
            raise ArtifactError("invalid_file")
        os.fchmod(target.fileno(), 0o600)
        try:
            process = subprocess.Popen(args, cwd=cwd, env=env, stdin=subprocess.DEVNULL,
                stdout=subprocess.PIPE, stderr=subprocess.STDOUT if include_stderr else subprocess.DEVNULL)
            for sig in (signal.SIGINT, signal.SIGTERM):
                handlers[sig] = signal.signal(sig, lambda number, frame: process.send_signal(number))
            end = None if timeout is None else time.monotonic() + timeout
            stored, clipped = 0, False
            with selectors.DefaultSelector() as selector:
                selector.register(process.stdout, selectors.EVENT_READ)
                while selector.get_map():
                    if end is not None and time.monotonic() >= end:
                        raise ArtifactError("command_timeout")
                    for key, _ in selector.select(0.1):
                        chunk = os.read(key.fd, 65536)
                        if not chunk:
                            selector.unregister(key.fileobj)
                            continue
                        room = max(0, limit - stored)
                        target.write(chunk[:room])
                        stored += min(len(chunk), room)
                        if len(chunk) > room:
                            clipped = True
                            if not truncate:
                                raise ArtifactError("output_limit")
            remaining = None if end is None else max(0.01, end - time.monotonic())
            return process.wait(timeout=remaining), clipped
        finally:
            if process is not None:
                if process.poll() is None:
                    process.kill()
                    process.wait()
                process.stdout.close()
            for sig, handler in handlers.items():
                signal.signal(sig, handler)


def checked_command(args, output, **kwargs):
    # Reserve mode before invoking the external boundary, including test doubles.
    private_write(output, b"")
    code, clipped = private_command(args, output, **kwargs)
    if code != 0 or clipped:
        raise ArtifactError("command_failed")


def crypt(source, destination, *, decrypt=False, env=None):
    """Use the existing cipher; in-memory payloads are encrypted through stdin."""
    env = os.environ if env is None else env
    if not env.get("TF_PLAN_ENC_KEY", "").strip():
        raise ArtifactError("key_required")
    in_memory = isinstance(source, bytes)
    if in_memory:
        if decrypt or len(source) > MAX_ARTIFACT:
            raise ArtifactError("invalid_file")
    else:
        regular_bytes(source, MAX_ARTIFACT)
    private_write(destination, b"")
    args = ["openssl", "enc"]
    args += ["-d"] if decrypt else []
    args += ["-aes-256-cbc", "-pbkdf2", "-iter", "200000"]
    args += [] if decrypt else ["-salt"]
    args += [] if in_memory else ["-in", str(source)]
    args += ["-out", str(destination), "-pass", "env:TF_PLAN_ENC_KEY"]
    command_env = {**tool_env(env), "TF_PLAN_ENC_KEY": env["TF_PLAN_ENC_KEY"]}
    if in_memory:
        result = subprocess.run(args, input=source, env=command_env, timeout=120,
                                stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        if result.returncode:
            raise ArtifactError("command_failed")
    else:
        with tempfile.TemporaryDirectory(prefix=".crypto-", dir=Path(destination).parent) as temporary:
            checked_command(args, Path(temporary) / "result", env=command_env, limit=1024)
    regular_bytes(destination, MAX_ARTIFACT)


def validate_identity(repository, branch, commit, run_id):
    if (not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9_.-]*/[A-Za-z0-9][A-Za-z0-9_.-]*", repository)
            or branch not in {"main", "dev", "atomoh", "ssminji", "whchoi"}
            or not re.fullmatch(r"[a-f0-9]{40}", commit)
            or not re.fullmatch(r"[1-9][0-9]{0,19}", str(run_id))):
        raise ArtifactError("invalid_context")


def fetch_run(repository, run_id, scratch, *, attempt=None):
    path = Path(scratch) / "run.json"
    suffix = "" if attempt is None else f"/attempts/{attempt}"
    checked_command(["gh", "api", "--hostname", "github.com",
        f"repos/{repository}/actions/runs/{run_id}{suffix}"], path,
        env=tool_env(github=True), limit=2 * 1024 * 1024)
    return json.loads(regular_bytes(path, 2 * 1024 * 1024), object_pairs_hook=assets.unique_object)


def require_run(run, repository, branch, commit, run_id, *, failed=False):
    if not isinstance(run, dict) or type(run.get("id")) is not int or run["id"] != int(run_id):
        raise ArtifactError("run_mismatch")
    if failed:
        # Failure recovery is distinct from apply eligibility. Never normalize a failed run to success.
        if (run.get("path") != ".github/workflows/terraform.yml"
                or run.get("event") != "workflow_dispatch" or run.get("status") != "completed"
                or run.get("conclusion") not in {"failure", "cancelled", "timed_out"}
                or run.get("head_sha") != commit or run.get("head_branch") != branch
                or any(not isinstance(run.get(key), dict)
                       or run[key].get("full_name") != repository
                       for key in ("repository", "head_repository"))):
            raise ArtifactError("run_mismatch")
    else:
        ci_plan_context.validate_run(run, repository, branch, commit)


def inspect_plan(*, repository, branch, commit, run_id, scope, foundation, destination):
    try:
        if os.environ.get("GITHUB_ACTIONS") == "true":
            raise ArtifactError("local_inspection_only")
        validate_identity(repository, branch, commit, run_id)
        assets.validate_context(commit, scope)
        destination = new_destination(destination)
        foundation = real_path(foundation)
        if not foundation.is_dir():
            raise ArtifactError("invalid_checkout")
        with tempfile.TemporaryDirectory(prefix=".plan-inspection-", dir=destination.parent) as temporary:
            scratch = Path(temporary)
            require_run(fetch_run(repository, run_id, scratch),
                        repository, branch, commit, run_id)
            checkout = scratch / "checkout"
            checked_command(["git", "-C", str(foundation), "rev-parse", "HEAD"],
                            checkout, env=tool_env(), limit=128)
            if regular_bytes(checkout, 128).decode().strip() != commit:
                raise ArtifactError("checkout_mismatch")
            download, restored, result = (scratch / name for name in ("download", "restored", "result"))
            for path in (download, restored, result):
                path.mkdir(mode=0o700)
            checked_command(["gh", "run", "download", str(run_id), "--repo", repository,
                             "--name", "tfplan", "--dir", str(download)],
                            scratch / "download-result", env=tool_env(github=True), limit=4096)
            crypt(download / "tfplan.enc", restored / "tfplan", decrypt=True)
            crypt(download / "tfassets.enc", restored / "tfassets.tar.gz", decrypt=True)
            assets.restore_assets(restored, restored / "tfassets.tar.gz", commit, scope)
            for path in restored.rglob("*"):
                path.chmod(0o700 if path.is_dir() else 0o600)
            render_env = {**tool_env(), "TF_DATA_DIR": str(foundation / ".terraform"),
                          "TF_IN_AUTOMATION": "1", "CHECKPOINT_DISABLE": "1",
                          "AWS_EC2_METADATA_DISABLED": "true"}
            for option, name in (("-no-color", "plan.txt"), ("-json", "plan.json")):
                checked_command(["terraform", "show", option, str(restored / "tfplan")],
                                result / name, cwd=foundation, env=render_env, limit=MAX_RENDER)
            # Never replace an existing operator directory, even an empty one.
            destination.mkdir(mode=0o700)
            try:
                for path in result.iterdir():
                    shutil.move(str(path), destination / path.name)
            except BaseException:
                shutil.rmtree(destination)
                raise
        return {"status": "inspected"}
    except ArtifactError:
        raise
    except (ValueError, TypeError, KeyError, OSError, subprocess.SubprocessError):
        raise ArtifactError("inspection_failed") from None


def identity_arguments(parser):
    for name in ("repository", "branch", "commit", "run-id"):
        parser.add_argument("--" + name, required=True)


def main():
    try:
        parser = Parser(description=__doc__)
        identity_arguments(parser)
        parser.add_argument("--scope", choices=assets.SCOPES, required=True)
        parser.add_argument("--foundation", type=Path, required=True)
        parser.add_argument("--destination", type=Path, required=True)
        inspect_plan(**vars(parser.parse_args()))
        print("Private plan inspection complete; no approval or apply performed.")
        return 0
    except (ArtifactError, OSError, ValueError):
        print("Private plan inspection refused (verification_failed).", file=sys.stderr)
        return 1


if __name__ == "__main__":
    sys.exit(main())
