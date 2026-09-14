"""Bounded private Terraform failure capture; existing CBC transport and manifest HMAC."""
import base64
import hashlib
import hmac
import json
import os
from pathlib import Path
import re
import shutil
import sys
import tempfile

import ci_tf_assets as assets
from ci_plan_inspect import (
    ArtifactError, Parser, crypt, fetch_run, identity_arguments, new_destination,
    private_command, private_write, real_path, regular_bytes, require_run, validate_identity,
)

LOG_LIMIT = 1024 * 1024
CAPSULE_LIMIT = 2 * LOG_LIMIT


def context(env, phase):
    repository, branch, commit = (env.get(key, "") for key in
                                 ("GITHUB_REPOSITORY", "GITHUB_REF_NAME", "GITHUB_SHA"))
    run_id, attempt = env.get("GITHUB_RUN_ID", ""), env.get("GITHUB_RUN_ATTEMPT", "")
    validate_identity(repository, branch, commit, run_id)
    if (env.get("GITHUB_EVENT_NAME") != "workflow_dispatch"
            or phase not in {"plan", "apply"} or env.get("GITHUB_JOB") != phase
            or not re.fullmatch(r"[1-9][0-9]{0,8}", attempt)):
        raise ArtifactError("invalid_failure_context")
    return {"repository": repository, "branch": branch, "commit": commit,
            "run_id": run_id, "attempt": attempt, "phase": phase}


def prefix(env):
    # Used only for ownership of scratch/cleanup, not proof of an authenticated run.
    values = [env.get(key, "") for key in ("GITHUB_RUN_ID", "GITHUB_RUN_ATTEMPT", "GITHUB_JOB")]
    if (not all(re.fullmatch(r"[1-9][0-9]{0,19}", value) for value in values[:2])
            or values[2] not in {"plan", "apply"}):
        raise ArtifactError("invalid_failure_context")
    return ".tf-diagnostics-" + "-".join(values) + "-"


def seal(log, output, metadata, code, clipped, env):
    value = regular_bytes(log, LOG_LIMIT)
    manifest = {
        "schema_version": 1, "kind": "terraform-failure",
        "context": metadata, "exit_code": code, "truncated": clipped,
        "bytes": len(value), "sha256": hashlib.sha256(value).hexdigest(),
    }
    key = env.get("TF_PLAN_ENC_KEY", "")
    if not key.strip():
        raise ArtifactError("key_required")
    payload = {"manifest": manifest, "hmac_sha256": assets.manifest_mac(manifest, key.encode()),
               "log_base64": base64.b64encode(value).decode()}
    plain = output.parent / "capsule.json"
    try:
        private_write(plain, json.dumps(payload, separators=(",", ":")).encode())
        crypt(plain, output, env=env)
    finally:
        plain.unlink(missing_ok=True)


def capture(args, phase, *, env=None):
    env = dict(os.environ if env is None else env)
    if (phase not in {"plan", "apply"} or args[:2] != ["terraform", phase]
            or phase == "apply" and args != ["terraform", "apply", "-input=false", "tfplan"]):
        raise ArtifactError("invalid_capture_command")
    parent = real_path(env.get("RUNNER_TEMP") or tempfile.gettempdir())
    # Ordinary/advisory invocations still suppress raw failures, but retain nothing without dispatch context.
    try:
        name = prefix(env)
    except ArtifactError:
        name = ".tf-diagnostics-unretained-"
    directory = Path(tempfile.mkdtemp(prefix=name, dir=parent))
    retained = False
    code = 127
    try:
        child_env = {key: value for key, value in env.items()
                     if key not in {"TF_PLAN_ENC_KEY", "GH_TOKEN", "GITHUB_TOKEN"}}
        try:
            code, clipped = private_command(args, directory / "command.log", env=child_env,
                limit=LOG_LIMIT, timeout=None, truncate=True, include_stderr=True)
            code = code if code >= 0 else 128 - code
        except OSError:
            clipped = False
        if code == 0:
            return 0, None
        try:
            metadata = context(env, phase)
            output = directory / "diagnostics.enc"
            seal(directory / "command.log", output, metadata, code, clipped, env)
            (directory / "command.log").unlink()
            retained = True
            return code, str(output)
        except (ArtifactError, ValueError, OSError):
            return code, None
    finally:
        if not retained:
            try:
                shutil.rmtree(directory)
            except OSError:
                # Cleanup is observable without replacing an existing Terraform
                # failure or publishing a secret-bearing path/error.
                print("Terraform diagnostic cleanup incomplete; inspect owned runner scratch privately.",
                      file=sys.stderr)
                if code == 0:
                    raise ArtifactError("cleanup_failed") from None


def recover(file, destination, *, repository, branch, commit, run_id, attempt, phase):
    try:
        if os.environ.get("GITHUB_ACTIONS") == "true":
            raise ArtifactError("local_recovery_only")
        validate_identity(repository, branch, commit, run_id)
        if phase not in {"plan", "apply"} or not re.fullmatch(r"[1-9][0-9]{0,8}", attempt):
            raise ArtifactError("invalid_failure_context")
        destination = new_destination(destination)
        expected = {"repository": repository, "branch": branch, "commit": commit,
                    "run_id": run_id, "attempt": attempt, "phase": phase}
        with tempfile.TemporaryDirectory(prefix=".failure-recovery-", dir=destination.parent) as temporary:
            scratch = Path(temporary)
            run = fetch_run(repository, run_id, scratch, attempt=attempt)
            require_run(run, repository, branch, commit, run_id, failed=True)
            if type(run.get("run_attempt")) is not int or run["run_attempt"] != int(attempt):
                raise ArtifactError("run_mismatch")
            source = scratch / "input.enc"
            private_write(source, regular_bytes(file, CAPSULE_LIMIT))
            crypt(source, scratch / "capsule.json", decrypt=True)
            payload = json.loads(regular_bytes(scratch / "capsule.json", CAPSULE_LIMIT),
                                 object_pairs_hook=assets.unique_object)
            if not isinstance(payload, dict) or set(payload) != {"manifest", "hmac_sha256", "log_base64"}:
                raise ArtifactError("invalid_capsule")
            manifest, signature = payload["manifest"], payload["hmac_sha256"]
            if (not isinstance(manifest, dict) or not isinstance(signature, str)
                    or not hmac.compare_digest(signature, assets.manifest_mac(manifest, assets.authentication_key()))
                    or set(manifest) != {"schema_version", "kind", "context", "exit_code",
                                         "truncated", "bytes", "sha256"}
                    or type(manifest["schema_version"]) is not int or manifest["schema_version"] != 1
                    or manifest["kind"] != "terraform-failure" or manifest["context"] != expected
                    or type(manifest["truncated"]) is not bool
                    or type(manifest["exit_code"]) is not int or not 1 <= manifest["exit_code"] <= 255
                    or type(manifest["bytes"]) is not int or not 0 <= manifest["bytes"] <= LOG_LIMIT):
                raise ArtifactError("capsule_authentication_failed")
            value = base64.b64decode(payload["log_base64"], validate=True)
            if len(value) != manifest["bytes"] or hashlib.sha256(value).hexdigest() != manifest["sha256"]:
                raise ArtifactError("capsule_content_mismatch")
            destination.mkdir(mode=0o700)
            try:
                private_write(destination / "diagnostics.log", value)
                private_write(destination / "metadata.json", json.dumps(manifest, indent=2).encode())
            except BaseException:
                shutil.rmtree(destination)
                raise
        return manifest
    except ArtifactError:
        raise
    except (ValueError, TypeError, KeyError, OSError):
        raise ArtifactError("recovery_failed") from None


def cleanup(file, env=None):
    env = os.environ if env is None else env
    if not file:
        return
    file = real_path(file)
    parent = real_path(env.get("RUNNER_TEMP") or tempfile.gettempdir())
    if (file.name != "diagnostics.enc" or file.parent.parent != parent
            or not file.parent.name.startswith(prefix(env))):
        raise ArtifactError("cleanup_not_owned")
    if file.parent.exists():
        if set(p.name for p in file.parent.iterdir()) != {"diagnostics.enc"}:
            raise ArtifactError("cleanup_not_owned")
        regular_bytes(file, CAPSULE_LIMIT)
        file.unlink()
        file.parent.rmdir()


def main():
    try:
        parser = Parser(description=__doc__)
        sub = parser.add_subparsers(dest="command", required=True)
        capture_parser = sub.add_parser("capture")
        capture_parser.add_argument("--phase", choices=("plan", "apply"), required=True)
        capture_parser.add_argument("args", nargs="...")
        recovery = sub.add_parser("recover")
        identity_arguments(recovery)
        recovery.add_argument("--attempt", required=True)
        recovery.add_argument("--phase", choices=("plan", "apply"), required=True)
        recovery.add_argument("--file", type=Path, required=True)
        recovery.add_argument("--destination", type=Path, required=True)
        clean = sub.add_parser("cleanup")
        clean.add_argument("--file", default="")
        args = vars(parser.parse_args())
        command = args.pop("command")
        if command == "capture":
            values = args.pop("args")
            code, file = capture(values[1:] if values[:1] == ["--"] else values, **args)
            if file:
                try:
                    with open(os.environ["GITHUB_OUTPUT"], "a") as output:
                        output.write(f"diagnostics_file={file}\n")
                except (KeyError, OSError):
                    try:
                        cleanup(file)
                    except (ArtifactError, OSError):
                        print("Encrypted diagnostic cleanup incomplete.", file=sys.stderr)
                    file = None
            print("Terraform command completed." if code == 0 else
                  "Terraform command failed (encrypted_diagnostics_retained)." if file else
                  "Terraform command failed (diagnostics_unavailable).", file=sys.stderr)
            return code
        if command == "recover":
            recover(**args)
            print("Private failure recovery complete; no deployment action performed.")
        else:
            cleanup(**args)
        return 0
    except (ArtifactError, ValueError, OSError):
        print("Terraform diagnostics refused (verification_failed).", file=sys.stderr)
        return 1


if __name__ == "__main__":
    sys.exit(main())
