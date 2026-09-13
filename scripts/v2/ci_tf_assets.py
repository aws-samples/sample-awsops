"""Bind private Lambda asset scratch to one saved plan; callers encrypt for transport."""
import argparse
import base64
import hashlib
import hmac
import io
import json
import os
from pathlib import Path, PurePosixPath
import re
import shutil
import stat
import subprocess
import sys
import tarfile
import tempfile

MAX_BYTES = 128 * 1024 * 1024
MAX_FILES = 20_000
MANIFEST = "assets-manifest.json"
SCOPES = ("full", "ecr-bootstrap", "runtime-ecr-bootstrap")
LOCK = Path(__file__).parent / "ci" / "pg8000-requirements.txt"
EPOCH = 315532800
MANIFEST_DOMAIN = b"awsops:terraform-assets:manifest:v2\0"
LAYERS = ("inv_layer", "pg8000_layer")
LAYER_IMPORTS = ("pg8000/__init__.py", "pg8000/native.py", "pg8000/core.py", "pg8000/dbapi.py",
                 "scramp/__init__.py", "scramp/core.py", "asn1crypto/__init__.py",
                 "dateutil/__init__.py", "dateutil/parser/__init__.py", "six.py")


def authentication_key():
    key = os.environ.get("TF_PLAN_ENC_KEY", "")
    if not key.strip():
        raise ValueError("Asset authentication key is required")
    return key.encode()


def manifest_mac(manifest, key):
    payload = json.dumps(manifest, sort_keys=True, separators=(",", ":"), allow_nan=False).encode()
    return hmac.new(key, MANIFEST_DOMAIN + payload, hashlib.sha256).hexdigest()


def unique_object(pairs):
    result = {}
    for name, value in pairs:
        if name in result:
            raise ValueError("Duplicate JSON member")
        result[name] = value
    return result


def validate_dependency_pins(repository=None):
    repository = Path(repository) if repository is not None else Path(__file__).resolve().parents[2]
    versions = []
    for relative in (
        "scripts/v2/ci/pg8000-requirements.txt",
        "scripts/v2/workers/requirements.txt", "scripts/v2/steampipe/requirements.txt",
        "scripts/v2/incident/requirements.txt", "scripts/v2/remediation/requirements.txt",
    ):
        lines = [line for line in (repository / relative).read_text().splitlines()
                 if not line.lstrip().startswith(("#", "//"))]
        pattern = r"(?m)^[ \t]*pg8000==([A-Za-z0-9][A-Za-z0-9._+!-]*)(?=\s|$)"
        pins = re.findall(pattern, "\n".join(lines))
        if len(pins) != 1:
            raise ValueError("Each layer input must contain one exact pg8000 pin")
        versions.extend(pins)
    if len(set(versions)) != 1:
        raise ValueError("Layer pg8000 pins must match the CI dependency lock")


def validate_destination(destination):
    try:
        mode = destination.lstat().st_mode
    except FileNotFoundError:
        return
    if not stat.S_ISDIR(mode):
        raise ValueError("Asset destination must be a directory, not a link or special file")


def digest(file):
    value = hashlib.sha256()
    with Path(file).open("rb") as source:
        while chunk := source.read(1024 * 1024):
            value.update(chunk)
    return value.hexdigest()


def validate_context(commit, scope):
    if not isinstance(commit, str) or not re.fullmatch(r"[a-f0-9]{40}", commit) or scope not in SCOPES:
        raise ValueError("Invalid reviewed asset context")


def safe_member(name):
    path = PurePosixPath(name)
    return (isinstance(name, str) and "\\" not in name and "\x00" not in name
            and not path.is_absolute() and ".." not in path.parts
            and len(path.parts) > 1 and path.parts[0] == ".build"
            and path.as_posix() == name and not any(ord(c) < 32 for c in name))


def load_plan(root):
    result = subprocess.run(["terraform", "show", "-json", "tfplan"], cwd=root,
                            check=True, capture_output=True, timeout=120)
    if len(result.stdout) > 32 * 1024 * 1024:
        raise ValueError("Plan projection is too large")
    return json.loads(result.stdout, object_pairs_hook=unique_object)


def planned_zip_hashes(root):
    plan = load_plan(root)
    modules = [plan["planned_values"]["root_module"]]
    expected = {}
    while modules:
        module = modules.pop()
        modules.extend(module.get("child_modules", []))
        for resource in module.get("resources", []):
            values = resource.get("values", {})
            filename = values.get("filename") or values.get("output_path")
            encoded = values.get("source_code_hash") or values.get("output_base64sha256")
            if not isinstance(filename, str) or not filename.endswith(".zip") or encoded is None:
                continue  # Deferred archives must be generated from the verified directory at apply.
            path = Path(filename)
            try:
                name = (path if path.is_absolute() else root / path).resolve().relative_to(root.resolve()).as_posix()
            except ValueError:
                continue
            if not safe_member(name):
                continue
            value = base64.b64decode(encoded, validate=True)
            if len(value) != 32 or name in expected and expected[name] != value.hex():
                raise ValueError("Ambiguous planned archive hash")
            expected[name] = value.hex()
    return expected


def bundle_assets(root, output, commit, scope):
    validate_context(commit, scope)
    key = authentication_key()
    validate_dependency_pins()
    root, output = Path(root), Path(output)
    build = root / ".build"
    if build.is_symlink() or not build.is_dir():
        raise ValueError("Prepared .build directory is required")
    plan_hash = digest(root / "tfplan")
    expected_zips = planned_zip_hashes(root)
    files, total = {}, 0
    for path in sorted(build.rglob("*")):
        if path.is_symlink() or not (path.is_file() or path.is_dir()):
            raise ValueError("Assets must be regular files and directories")
        if path.is_dir():
            continue
        name = path.relative_to(root).as_posix()
        info = path.stat()
        total += info.st_size
        if not safe_member(name) or total > MAX_BYTES or len(files) >= MAX_FILES:
            raise ValueError("Asset size or path limit exceeded")
        files[name] = {"sha256": digest(path), "mode": stat.S_IMODE(info.st_mode) & 0o777}
        if path.suffix == ".zip" and expected_zips.get(name) != files[name]["sha256"]:
            raise ValueError("Archive does not match a known hash inside the saved plan")
    if digest(root / "tfplan") != plan_hash:
        raise ValueError("Plan changed during asset validation")
    if set(expected_zips) - set(files):
        raise ValueError("Planned archive is missing from the prepared assets")
    manifest = {
        "schema_version": 2, "commit": commit, "scope": scope,
        "tfplan_sha256": plan_hash, "files": files,
    }
    manifest["hmac_sha256"] = manifest_mac(manifest, key)
    payload = json.dumps(manifest, sort_keys=True).encode()
    if len(payload) > 4 * 1024 * 1024:
        raise ValueError("Asset manifest is too large")
    # Private 0600 scratch, like tfplan itself. This utility has no upload path.
    # The caller must encrypt before publication; archives can contain rendered secrets.
    fd, temporary = tempfile.mkstemp(prefix=".assets-", dir=output.parent)
    os.close(fd)
    try:
        with tarfile.open(temporary, "w:gz") as archive:
            header = tarfile.TarInfo(MANIFEST)
            header.size, header.mode, header.mtime = len(payload), 0o600, EPOCH
            archive.addfile(header, io.BytesIO(payload))
            for name, metadata in files.items():
                path = root / name
                header = tarfile.TarInfo(name)
                header.size, header.mode, header.mtime = path.stat().st_size, metadata["mode"], EPOCH
                with path.open("rb") as contents:
                    archive.addfile(header, contents)
        os.replace(temporary, output)
    finally:
        Path(temporary).unlink(missing_ok=True)
    return {"files": len(files), "bytes": total}


def restore_assets(root, bundle, commit, scope):
    validate_context(commit, scope)
    key = authentication_key()
    validate_dependency_pins()
    root, bundle = Path(root), Path(bundle)
    destination = root / ".build"
    validate_destination(destination)
    if bundle.stat().st_size > MAX_BYTES + 8 * 1024 * 1024:
        raise ValueError("Asset archive is too large")
    staging = Path(tempfile.mkdtemp(prefix=".ci-assets-", dir=root))
    backup = staging / "previous-build"
    installed = False
    try:
        with tarfile.open(bundle, "r:gz") as archive:
            members, total = {}, 0
            for member in archive:
                if (len(members) > MAX_FILES or member.name in members or not member.isfile()
                        or member.size < 0 or member.mode & ~0o777
                        or member.name != MANIFEST and not safe_member(member.name)):
                    raise ValueError("Unsafe or duplicate asset archive member")
                total += member.size
                if total > MAX_BYTES + 4 * 1024 * 1024:
                    raise ValueError("Asset expansion limit exceeded")
                members[member.name] = member
            header = members.get(MANIFEST)
            if header is None or header.size > 4 * 1024 * 1024:
                raise ValueError("Missing bounded asset manifest")
            manifest = json.load(archive.extractfile(header), object_pairs_hook=unique_object)
            if not isinstance(manifest, dict):
                raise ValueError("Invalid authenticated asset manifest")
            signature = manifest.pop("hmac_sha256", None)
            if (not isinstance(signature, str) or not re.fullmatch(r"[a-f0-9]{64}", signature)
                    or not hmac.compare_digest(signature, manifest_mac(manifest, key))):
                raise ValueError("Asset manifest authentication failed")
            if (type(manifest.get("schema_version")) is not int or manifest["schema_version"] != 2
                    or set(manifest) != {"schema_version", "commit", "scope", "tfplan_sha256", "files"}
                    or manifest.get("commit") != commit or manifest.get("scope") != scope
                    or manifest.get("tfplan_sha256") != digest(root / "tfplan")
                    or not isinstance(manifest.get("files"), dict)
                    or set(manifest["files"]) != set(members) - {MANIFEST}):
                raise ValueError("Assets do not belong to this exact plan and reviewed commit")
            (staging / ".build").mkdir(mode=0o700)
            for name, metadata in manifest["files"].items():
                member = members[name]
                if (not isinstance(metadata, dict) or set(metadata) != {"mode", "sha256"}
                        or type(metadata.get("mode")) is not int or metadata["mode"] != member.mode
                        or not isinstance(metadata.get("sha256"), str)
                        or not re.fullmatch(r"[a-f0-9]{64}", metadata["sha256"])):
                    raise ValueError("Invalid asset metadata")
                target = staging / name
                target.parent.mkdir(parents=True, exist_ok=True, mode=0o755)
                with archive.extractfile(member) as source, target.open("xb") as output:
                    shutil.copyfileobj(source, output, length=1024 * 1024)
                if digest(target) != metadata["sha256"]:
                    raise ValueError("Asset content differs from the reviewed manifest")
                target.chmod(member.mode)
                os.utime(target, (EPOCH, EPOCH))
            validate_destination(destination)
            try:
                if destination.exists():
                    destination.rename(backup)
                (staging / ".build").rename(destination)
            except BaseException:
                # Inspect the filesystem: an interrupt can arrive immediately after
                # either successful rename, before Python records its completion.
                if backup.exists() and not destination.exists():
                    backup.rename(destination)
                raise
            installed = True
        return {"files": len(manifest["files"]), "assets_verified": True}
    except (tarfile.TarError, json.JSONDecodeError) as error:
        raise ValueError("Invalid asset archive") from error
    finally:
        # Preserve the last good tree if rollback failed. A killed process leaves
        # only its own 0700 staging directory; a fresh verified restore can retry.
        if installed or not backup.exists():
            shutil.rmtree(staging, ignore_errors=True)


def layer_hash(target):
    if target.is_symlink() or not target.is_dir():
        raise ValueError("Layer directory must be real")
    if any(not (target / "python" / name).is_file() for name in LAYER_IMPORTS):
        raise ValueError("Layer import closure is incomplete")
    files, total = {}, 0
    for path in sorted(target.rglob("*")):
        if path.is_symlink() or not (path.is_file() or path.is_dir()):
            raise ValueError("Layer contains a link or special file")
        if path.is_file():
            total += path.stat().st_size
            if total > MAX_BYTES or len(files) >= MAX_FILES:
                raise ValueError("Layer size limit exceeded")
            files[path.relative_to(target).as_posix()] = [digest(path), stat.S_IMODE(path.stat().st_mode)]
    return hashlib.sha256(json.dumps(files, sort_keys=True).encode()).hexdigest()


def build_layer(root, folder):
    if folder not in LAYERS:
        raise ValueError("Invalid layer")
    validate_dependency_pins()
    build = Path(root) / ".build"
    validate_destination(build)
    build.mkdir(mode=0o700, exist_ok=True)
    (build / ".ci-prepared.json").unlink(missing_ok=True)  # Invalidate before any layer mutation.
    target = build / folder
    validate_destination(target)
    if target.exists():
        shutil.rmtree(target)
    python = target / "python"
    python.mkdir(parents=True, mode=0o755)
    try:
        subprocess.run([
            sys.executable, "-m", "pip", "install", "--disable-pip-version-check",
            "--no-cache-dir", "--no-compile", "--only-binary=:all:", "--require-hashes",
            "--index-url", "https://pypi.org/simple", "-r", str(LOCK), "--target", str(python),
        ], check=True, capture_output=True, timeout=180, env={
            "PATH": os.environ.get("PATH", ""), "LANG": "C", "LC_ALL": "C", "PIP_CONFIG_FILE": os.devnull,
        })
    except subprocess.TimeoutExpired:
        raise ValueError("pip_timeout") from None
    except (subprocess.SubprocessError, OSError):
        raise ValueError("pip_install_failed") from None
    for path in [target, *target.rglob("*")]:
        if path.is_symlink():
            raise ValueError("Layer dependencies must not contain links")
        path.chmod(0o755 if path.is_dir() else 0o644)
        os.utime(path, (EPOCH, EPOCH))
    return layer_hash(target)


def prepare_layers(root, flags, scope):
    root = Path(root)
    if scope not in SCOPES or not isinstance(flags, dict):
        raise ValueError("Invalid asset preparation scope")
    for name in ("steampipe_enabled", "workers_enabled"):
        if type(flags.get(name)) is not bool:
            raise ValueError("Explicit layer feature flags are required")
    validate_dependency_pins()
    build = root / ".build"
    if build.is_symlink():
        raise ValueError("Asset directory must not be a symlink")
    build.mkdir(mode=0o700, exist_ok=True)
    marker = build / ".ci-prepared.json"
    marker.unlink(missing_ok=True)
    built = []
    hashes = {}
    if scope == "full":
        for flag, folder in (("steampipe_enabled", "inv_layer"), ("workers_enabled", "pg8000_layer")):
            if not flags[flag]:
                continue
            hashes[folder] = build_layer(root, folder)
            built.append(folder)
    fd = os.open(marker, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    with os.fdopen(fd, "w") as output:
        json.dump({"schema_version": 2, "layers": built, "lock_sha256": digest(LOCK), "file_sha256": hashes}, output)
    return {"prepared_layers": built}


def validate_layer(root, layer):
    validate_dependency_pins()
    root = Path(root)
    if layer not in LAYERS or (root / ".build").is_symlink():
        raise ValueError("Invalid prepared layer")
    marker_file = root / ".build/.ci-prepared.json"
    if marker_file.is_symlink():
        raise ValueError("Invalid layer marker")
    marker = json.loads(marker_file.read_text(), object_pairs_hook=unique_object)
    if (not isinstance(marker, dict) or set(marker) != {"schema_version", "layers", "lock_sha256", "file_sha256"}
            or type(marker.get("schema_version")) is not int or marker["schema_version"] != 2
            or not isinstance(marker.get("layers"), list)
            or any(not isinstance(item, str) or item not in LAYERS for item in marker["layers"])
            or len(set(marker["layers"])) != len(marker["layers"]) or layer not in marker["layers"]
            or not isinstance(marker.get("lock_sha256"), str)
            or marker.get("lock_sha256") != digest(LOCK)
            or not isinstance(marker.get("file_sha256"), dict)
            or set(marker["file_sha256"]) != set(marker["layers"])
            or marker["file_sha256"].get(layer) != layer_hash(root / ".build" / layer)):
        raise ValueError("Prepared layer does not match the locked build inputs")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("command", choices=("prepare", "build-layer", "pack", "restore", "check-layer"))
    parser.add_argument("--layer", choices=("inv_layer", "pg8000_layer"))
    parser.add_argument("--scope", choices=SCOPES, default=os.environ.get("PLAN_SCOPE", "full") or "full")
    args = parser.parse_args()
    try:
        if args.scope not in SCOPES:
            raise ValueError("Invalid asset scope")
        root = Path.cwd()
        if root.name != "foundation" or root.parent.name != "terraform":
            raise ValueError("Run only from terraform/foundation")
        if args.command == "check-layer":
            validate_layer(root, args.layer)
            result = {"prepared_layer_verified": True}
        elif args.command == "build-layer":
            build_layer(root, args.layer)
            result = {"built_layer": args.layer}
        elif args.command == "prepare":
            flags = json.load(sys.stdin)
            if isinstance(flags, str):
                flags = json.loads(flags)
            result = prepare_layers(root, flags, args.scope)
        else:
            # That event's GITHUB_SHA identifies the default branch, not reviewed source.
            if os.environ.get("GITHUB_EVENT_NAME") == "pull_request_target":
                raise ValueError("Ambiguous reviewed-source context")
            fn = bundle_assets if args.command == "pack" else restore_assets
            result = fn(root, root / "tfassets.tar.gz", os.environ.get("GITHUB_SHA", ""), args.scope)
        print(json.dumps(result))
    except (ValueError, TypeError, KeyError, OSError, tarfile.TarError, subprocess.SubprocessError) as error:
        category = str(error) if str(error) in ("pip_timeout", "pip_install_failed") else "asset_verification_failed"
        print(f"Terraform assets failed ({category}); no unverified assets may be applied.", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
