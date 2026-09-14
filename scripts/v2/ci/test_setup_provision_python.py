import importlib.util
import json
from pathlib import Path
import subprocess

import pytest

spec = importlib.util.spec_from_file_location(
    "setup_provision_python", Path(__file__).with_name("setup-provision-python.py"))
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


def environment(root):
    return {
        "RUNNER_TEMP": str(root), "GITHUB_PATH": str(root / "path"),
        "GITHUB_OUTPUT": str(root / "output"), "PATH": "/usr/bin:/bin",
        "LD_LIBRARY_PATH": "/toolcache/python/lib",
        "AWS_ACCESS_KEY_ID": "PRIVATE", "AWS_SECRET_ACCESS_KEY": "PRIVATE",
        "AWS_SESSION_TOKEN": "PRIVATE", "DEV_TFVARS_B64": "PRIVATE",
        "PIP_EXTRA_INDEX_URL": "https://PRIVATE.invalid", "PYTHONPATH": "/PRIVATE",
    }


def test_prepare_publishes_only_a_verified_private_sdk_and_filters_credentials(tmp_path):
    env = environment(tmp_path)
    calls = []

    def run(args, **options):
        calls.append((args, options))
        assert not (tmp_path / "path").exists()
        assert not (tmp_path / "output").exists()
        assert options["env"]["LD_LIBRARY_PATH"] == "/toolcache/python/lib"
        assert not any("PRIVATE" in value for value in options["env"].values())
        value = {"python": "3.12.14", "boto3": "1.43.93", "botocore": "1.43.93"}
        return subprocess.CompletedProcess(args, 0, json.dumps(value) if "-c" in args else "")

    directory = module.prepare(env, run)
    assert Path(directory).stat().st_mode & 0o777 == 0o700
    assert (tmp_path / "path").read_text() == directory + "/bin\n"
    assert (tmp_path / "output").read_text() == f"directory={directory}\n"
    assert "--require-hashes" in calls[1][0]
    assert "--only-binary=:all:" in calls[1][0]
    assert calls[-1][0][-1] == "--help"
    module.cleanup(tmp_path, directory)
    assert not Path(directory).exists()


@pytest.mark.parametrize("failure", [0, 1, 2, 3])
def test_preparation_failure_cleans_packages_without_publishing_or_leaking(tmp_path, failure):
    index = 0

    def run(args, **options):
        nonlocal index
        index += 1
        if index - 1 == failure:
            raise subprocess.CalledProcessError(1, args, output="PRIVATE")
        return subprocess.CompletedProcess(args, 0, json.dumps({
            "python": "3.12.14", "boto3": "1.43.93", "botocore": "1.43.93"}))

    with pytest.raises(RuntimeError, match="provision_.*_failed") as error:
        module.prepare(environment(tmp_path), run)
    assert "PRIVATE" not in str(error.value)
    assert list(tmp_path.iterdir()) == []


def test_cleanup_rejects_foreign_paths_and_symlinks(tmp_path):
    other = tmp_path / "other"
    other.mkdir()
    link = tmp_path / (module.PREFIX + "link")
    link.symlink_to(other, target_is_directory=True)
    for path in [str(tmp_path), str(other), str(link), "/tmp/other"]:
        with pytest.raises(ValueError, match="invalid_provision_sdk_directory"):
            module.cleanup(tmp_path, path)
    assert other.exists()


def test_cleanup_os_error_warns_without_overwriting_deployment_result(tmp_path, monkeypatch, capsys):
    path = tmp_path / (module.PREFIX + "fixture")
    path.mkdir()
    monkeypatch.setattr(module.shutil, "rmtree", lambda path: (_ for _ in ()).throw(PermissionError("PRIVATE")))
    assert module.cleanup(tmp_path, str(path)) is False
    assert capsys.readouterr().err.strip() == "::warning::provision_sdk_cleanup_failed"


def test_mkdtemp_failure_is_a_fixed_preparation_error(tmp_path, monkeypatch):
    monkeypatch.setattr(module.tempfile, "mkdtemp", lambda **kwargs: (_ for _ in ()).throw(OSError("PRIVATE")))
    with pytest.raises(RuntimeError, match="^provision_python_create_failed$"):
        module.prepare(environment(tmp_path))


@pytest.mark.parametrize("missing", [False, True])
def test_preflight_derives_late_and_passed_method_operations(tmp_path, monkeypatch, missing):
    import sys
    import types
    source = tmp_path / "provision.py"
    source.write_text("def configure(ctrl):\n    ctrl.synchronize_gateway_targets()\n    use(ctrl.list_gateways)\n\ndef smoke():\n    data.invoke_agent_runtime()\n")
    pins = tmp_path / "pins.txt"
    pins.write_text("boto3==1.43.93 --hash=sha256:fixture\nbotocore==1.43.93 --hash=sha256:fixture\n")
    boto = types.ModuleType("boto3")
    core = types.ModuleType("botocore")
    session = types.ModuleType("botocore.session")
    boto.__version__ = core.__version__ = "1.43.93"
    mapping = {"SynchronizeGatewayTargets": "synchronize_gateway_targets",
               "ListGateways": "list_gateways", "InvokeAgentRuntime": "invoke_agent_runtime"}
    core.xform_name = mapping.__getitem__
    core.session = session
    def model(name):
        operations = ["InvokeAgentRuntime"] if name == "bedrock-agentcore" else ["ListGateways"]
        if not missing and name != "bedrock-agentcore":
            operations.append("SynchronizeGatewayTargets")
        return types.SimpleNamespace(operation_names=operations)
    session.get_session = lambda: types.SimpleNamespace(get_service_model=model)
    for name, value in [("boto3", boto), ("botocore", core), ("botocore.session", session)]:
        monkeypatch.setitem(sys.modules, name, value)
    monkeypatch.setattr(sys, "argv", ["-c", str(source), str(pins)])
    if missing:
        with pytest.raises(AssertionError, match="synchronize_gateway_targets"):
            exec(module.PREFLIGHT, {})
    else:
        exec(module.PREFLIGHT, {})
