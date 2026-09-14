"""Bounded private Terraform diagnostics; capture never writes while Terraform runs."""
import base64
from datetime import datetime, timezone
import errno
import hashlib
import hmac
import json
import os
from pathlib import Path
import re
import shutil
import signal
import stat
import subprocess
import sys
import tempfile

import ci_tf_assets as assets
from ci_plan_inspect import (
    ArtifactError, Parser, crypt, fetch_run, identity_arguments, new_destination,
    private_write, real_path, regular_bytes, require_run, validate_identity,
)

LOG_LIMIT = 1024 * 1024
CAPSULE_LIMIT = 2 * LOG_LIMIT
DOMAIN = b"awsops:terraform-failure:manifest:v2\0"
COMMAND_FILES = {"GITHUB_OUTPUT", "GITHUB_ENV", "GITHUB_PATH", "GITHUB_STATE", "GITHUB_STEP_SUMMARY"}
ANSI = re.compile(rb"\x1b\[[0-?]*[ -/]*[@-~]")
CATEGORIES = {
    "state_lock": ("Error acquiring the state lock",),
    "access_denied": ("AccessDenied", "UnauthorizedOperation",),
    "authentication": ("No valid credential sources", "ExpiredToken", "InvalidClientTokenId"),
    "provider_install": ("Failed to install provider", "Failed to query available provider packages"),
    "invalid_plan": ("Saved plan is stale", "Saved plan does not match", "Inconsistent dependency lock file"),
    "configuration": ("Error: Unsupported argument", "Error: Missing required argument", "Error: Invalid value"),
}


def child_environment(env):
    # Terraform still needs temporary AWS credentials and explicitly supplied TF_VAR inputs.
    return {key: value for key, value in env.items()
            if key not in COMMAND_FILES
            and not key.startswith(("ACTIONS_", "TF_TOKEN_", "TF_LOG", "TF_CLI_ARGS"))
            and not key.endswith("_ENC_KEY")
            and not (key.endswith("_TOKEN") and not key.startswith(("AWS_", "TF_VAR_")))}


class OutputCapture:
    def __init__(self, phase):
        self.phase, self.tail, self.pending = phase, b"", b""
        self.total, self.damaged, self.overflow = 0, False, False
        self.counts, self.categories = None, set()

    def line(self, value):
        text = ANSI.sub(b"", value).decode("utf-8", errors="replace").strip()
        pattern = (r"Plan: ([0-9]{1,9}) to add, ([0-9]{1,9}) to change, ([0-9]{1,9}) to destroy\."
                   if self.phase == "plan" else
                   r"Apply complete! Resources: ([0-9]{1,9}) added, ([0-9]{1,9}) changed, ([0-9]{1,9}) destroyed\.")
        match = re.fullmatch(pattern, text)
        if match:
            self.counts = dict(zip(("add", "change", "destroy"), map(int, match.groups())))
        elif text == "No changes. Your infrastructure matches the configuration.":
            self.counts = {"add": 0, "change": 0, "destroy": 0}
        for category, markers in CATEGORIES.items():
            if any(marker in text for marker in markers):
                self.categories.add(category)

    def feed(self, chunk):
        self.tail = (self.tail + chunk)[-LOG_LIMIT:]
        for segment in chunk.splitlines(keepends=True):
            complete = segment.endswith((b"\n", b"\r"))
            if not self.overflow:
                self.pending += segment
                if len(self.pending) > 4096:
                    self.pending, self.overflow = b"", True
            if complete:
                if not self.overflow:
                    self.line(self.pending)
                self.pending, self.overflow = b"", False

    def finish(self, code, launched):
        if self.pending and not self.overflow and not self.damaged:
            self.line(self.pending)
        category = (None if code == 0 else "launch_failed" if not launched else
                    "interrupted" if code in (130, 143) else
                    next((name for name in CATEGORIES if name in self.categories), "command_failed"))
        return {
            "phase": self.phase, "launched": launched, "exit_code": code if launched else None,
            "capture_status": "launch_failed" if not launched else "capture_failed" if self.damaged
                              else "truncated" if self.total > len(self.tail) else "complete",
            "truncated": self.total > len(self.tail), "total_output_bytes": self.total,
            "retained_bytes": len(self.tail), "failure_category": category,
            "action_counts": self.counts if code == 0 and not self.damaged else None,
            "retention_status": "not_needed", "cleanup_status": "not_needed",
        }


def collect_command(args, env, output):
    """Drain into bounded memory; no scratch I/O and no capture-induced SIGKILL."""
    try:
        process = subprocess.Popen(args, env=child_environment(env), stdin=subprocess.DEVNULL,
                                   stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
                                   start_new_session=True)
    except (OSError, ValueError):
        return 127, False
    handlers = {}
    forwarded = False

    def forward_once(number, frame):
        nonlocal forwarded
        if not forwarded:
            forwarded = True
            try:
                process.send_signal(number)
            except ProcessLookupError:
                pass

    try:
        for sig in (signal.SIGINT, signal.SIGTERM):
            try:
                handlers[sig] = signal.signal(sig, forward_once)
            except ValueError:  # Library use outside the main thread has no signal ownership.
                pass
        while True:
            try:
                chunk = process.stdout.read1(65536)
            except OSError as error:
                if error.errno in (errno.EINTR, errno.EAGAIN):
                    continue
                output.damaged = True
                # No disk is involved. A failed buffered reader gets one raw drain path.
                while True:
                    try:
                        chunk = os.read(process.stdout.fileno(), 65536)
                    except OSError:
                        break
                    if not chunk:
                        break
                    output.total += len(chunk)
                break
            if not chunk:
                break
            output.total += len(chunk)
            if not output.damaged:
                try:
                    output.feed(chunk)
                except (MemoryError, OSError, ValueError):
                    output.damaged = True
                    output.tail, output.pending, output.counts = b"", b"", None
        code = process.wait()
        return (code if code >= 0 else 128 - code), True
    finally:
        # A capture/storage failure never kills Terraform or invents its exit status.
        process.wait()
        process.stdout.close()
        for sig, handler in handlers.items():
            signal.signal(sig, handler)


def diagnostic_mac(manifest, key):
    value = json.dumps(manifest, sort_keys=True, separators=(",", ":"), allow_nan=False).encode()
    return hmac.new(key, DOMAIN + value, hashlib.sha256).hexdigest()


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
    return "tf-diagnostics-" + "-".join(values) + "-"


def seal(value, output, metadata, audit, env):
    manifest = {
        "schema_version": 2, "kind": "terraform-failure",
        "context": metadata, "exit_code": audit["exit_code"], "launched": audit["launched"],
        "truncated": audit["truncated"], "capture_status": audit["capture_status"],
        "total_output_bytes": audit["total_output_bytes"],
        "captured_at": datetime.now(timezone.utc).isoformat(),
        "bytes": len(value), "sha256": hashlib.sha256(value).hexdigest(),
    }
    key = env.get("TF_PLAN_ENC_KEY", "")
    if not key.strip():
        raise ArtifactError("key_required")
    payload = {"manifest": manifest, "hmac_sha256": diagnostic_mac(manifest, key.encode()),
               "log_base64": base64.b64encode(value).decode()}
    crypt(json.dumps(payload, separators=(",", ":")).encode(), output, env=env)


def capture(args, phase, *, env=None, audit=None):
    env = dict(os.environ if env is None else env)
    if (phase not in {"plan", "apply"} or args[:2] != ["terraform", phase]
            or phase == "apply" and args != ["terraform", "apply", "-input=false", "tfplan"]):
        raise ArtifactError("invalid_capture_command")
    observed = OutputCapture(phase)
    code, launched = collect_command(args, env, observed)
    result = observed.finish(code, launched)
    directory, file = None, None
    try:
        if code == 0:
            return 0, None
        if env.get("GITHUB_EVENT_NAME") != "workflow_dispatch":
            result["retention_status"] = "policy_not_retained"
            return code, None
        if not env.get("TF_PLAN_ENC_KEY", "").strip():
            result["retention_status"] = "key_missing"
            return code, None
        try:
            metadata = context(env, phase)
        except ArtifactError:
            result["retention_status"] = "context_invalid"
            return code, None
        try:
            parent = real_path(env.get("RUNNER_TEMP") or tempfile.gettempdir())
            directory = Path(tempfile.mkdtemp(prefix=prefix(env), dir=parent))
            output = directory / "diagnostics.enc"
            seal(observed.tail, output, metadata, result, env)
            result["cipher_sha256"] = validate_cipher_file(output, env)
            file = str(output)
            result["retention_status"] = "sealed"
            result["cleanup_status"] = "pending_upload"
            return code, file
        except OSError as error:
            result["retention_status"] = "storage_failed" if error.errno in (errno.ENOSPC, errno.EDQUOT) else "seal_failed"
            return code, None
        except (ArtifactError, ValueError, subprocess.SubprocessError):
            result["retention_status"] = "seal_failed"
            return code, None
    finally:
        if directory is not None and file is None:
            try:
                shutil.rmtree(directory)
                result["cleanup_status"] = "complete"
            except OSError:
                result["cleanup_status"] = "failed"
        if audit is not None:
            audit.update(result)


def validate_cipher_file(file, env, expected_hash=None):
    file = real_path(file)
    parent = real_path(env.get("RUNNER_TEMP") or tempfile.gettempdir())
    if (file.name != "diagnostics.enc" or file.parent.parent != parent
            or not file.parent.name.startswith(prefix(env))
            or any(c in str(file) for c in "*?[]{}!")
            or set(p.name for p in file.parent.iterdir()) != {"diagnostics.enc"}):
        raise ArtifactError("cipher_not_owned")
    directory, info = file.parent.stat(), file.lstat()
    if (directory.st_uid != os.getuid() or directory.st_mode & 0o777 != 0o700
            or not stat.S_ISREG(info.st_mode) or info.st_uid != os.getuid()
            or info.st_nlink != 1 or info.st_mode & 0o777 != 0o600):
        raise ArtifactError("cipher_not_owned")
    value = regular_bytes(file, CAPSULE_LIMIT)
    if len(value) < 32 or not value.startswith(b"Salted__"):
        raise ArtifactError("invalid_cipher")
    digest = hashlib.sha256(value).hexdigest()
    if expected_hash is not None and not hmac.compare_digest(digest, expected_hash):
        raise ArtifactError("cipher_changed")
    return digest


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
                    or not hmac.compare_digest(signature, diagnostic_mac(manifest, assets.authentication_key()))
                    or set(manifest) != {"schema_version", "kind", "context", "exit_code",
                                         "launched", "truncated", "bytes", "sha256",
                                         "total_output_bytes", "capture_status", "captured_at"}
                    or type(manifest["schema_version"]) is not int or manifest["schema_version"] != 2
                    or manifest["kind"] != "terraform-failure" or manifest["context"] != expected
                    or type(manifest["truncated"]) is not bool
                    or type(manifest["launched"]) is not bool
                    or (manifest["launched"] and
                        (type(manifest["exit_code"]) is not int or not 1 <= manifest["exit_code"] <= 255))
                    or (not manifest["launched"] and manifest["exit_code"] is not None)
                    or type(manifest["bytes"]) is not int or not 0 <= manifest["bytes"] <= LOG_LIMIT
                    or type(manifest["total_output_bytes"]) is not int
                    or not manifest["bytes"] <= manifest["total_output_bytes"] <= 2**63 - 1
                    or manifest["truncated"] != (manifest["total_output_bytes"] > manifest["bytes"])
                    or manifest["capture_status"] not in {"complete", "truncated", "capture_failed", "launch_failed"}
                    or (manifest["capture_status"] == "launch_failed") == manifest["launched"]
                    or not isinstance(manifest["captured_at"], str) or len(manifest["captured_at"]) > 40
                    or datetime.fromisoformat(manifest["captured_at"]).tzinfo is None):
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
    except subprocess.TimeoutExpired:
        raise ArtifactError("recovery_timeout") from None
    except (ValueError, TypeError, KeyError, OSError, subprocess.SubprocessError):
        raise ArtifactError("recovery_failed") from None


def cleanup(file, env=None, *, upload_outcome=""):
    env = os.environ if env is None else env
    audit = {
        "upload_status": upload_outcome if upload_outcome in {
            "success", "failure", "cancelled", "skipped"} else "unavailable",
        "cleanup_status": "not_available",
    }
    if not file:
        return audit
    if upload_outcome != "success":
        audit["cleanup_status"] = "retained_unpublished"
        return audit
    file = real_path(file)
    parent = real_path(env.get("RUNNER_TEMP") or tempfile.gettempdir())
    if (file.name != "diagnostics.enc" or file.parent.parent != parent
            or not file.parent.name.startswith(prefix(env))):
        raise ArtifactError("cleanup_not_owned")
    if file.parent.exists():
        validate_cipher_file(file, env)
        file.unlink()
        file.parent.rmdir()
    audit["cleanup_status"] = "complete"
    return audit


def publish_audit(audit, file, env):
    # The parent is the sole writer of this pointer; the child has no command-file environment.
    try:
        with open(env["GITHUB_OUTPUT"], "a") as output:
            output.write("diagnostics_file=\n")
            if file:
                validate_cipher_file(file, env, audit["cipher_sha256"])
                output.write(f"diagnostics_file={file}\n")
    except (KeyError, OSError, ArtifactError):
        if file:
            audit["retention_status"] = "publication_failed"
            audit["cleanup_status"] = "retained_unpublished"
        # Keep already sealed ciphertext for private owner recovery, never raw plaintext.
    publish_status(audit, env)


def publish_status(audit, env):
    public = {key: value for key, value in audit.items() if key != "cipher_sha256"}
    if env.get("GITHUB_STEP_SUMMARY"):
        try:
            with open(env["GITHUB_STEP_SUMMARY"], "a") as summary:
                summary.write("### Terraform diagnostic audit\n\n```json\n" +
                              json.dumps(public, sort_keys=True) + "\n```\n")
        except OSError:
            public["audit_publication"] = "unavailable"
    try:
        print(json.dumps(public, sort_keys=True))
    except OSError:
        try:
            print("Terraform audit output unavailable.", file=sys.stderr)
        except OSError:
            pass  # Publication failure cannot replace the already observed command result.


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
        clean.add_argument("--upload-outcome", default="")
        args = vars(parser.parse_args())
        command = args.pop("command")
        if command == "capture":
            values = args.pop("args")
            audit = {}
            code, file = capture(values[1:] if values[:1] == ["--"] else values, audit=audit, **args)
            publish_audit(audit, file, os.environ)
            return code
        if command == "recover":
            recover(**args)
            print("Private failure recovery complete; no deployment action performed.")
        else:
            try:
                audit = cleanup(**args)
            except (ArtifactError, ValueError, OSError):
                publish_status({"cleanup_status": "failed"}, os.environ)
                return 1
            publish_status(audit, os.environ)
        return 0
    except (ArtifactError, ValueError, OSError, subprocess.SubprocessError):
        print("Terraform diagnostics refused (verification_failed).", file=sys.stderr)
        return 1


if __name__ == "__main__":
    sys.exit(main())
