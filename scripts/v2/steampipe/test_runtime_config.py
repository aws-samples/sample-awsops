"""Private SPC/profile publication completes before a stopped service can restart."""
import os
from pathlib import Path
import stat
import sys
import threading
from unittest import mock

import pytest

sys.path.insert(0, str(Path(__file__).parent))
import gen_spc_entrypoint as entrypoint


@pytest.fixture
def private_paths(tmp_path, monkeypatch):
    root = tmp_path / "runtime"
    spc = tmp_path / "steampipe" / "config" / "aws.spc"
    monkeypatch.setattr(entrypoint, "RUNTIME_CONFIG_DIR", str(root), raising=False)
    monkeypatch.setattr(entrypoint, "SPC_PATH", str(spc))
    monkeypatch.setenv("AWS_CONFIG_FILE", str(root / "current" / "config"))
    return root, spc


def test_spc_is_a_regular_private_file_and_profiles_use_a_private_generation(private_paths):
    root, spc = private_paths
    entrypoint.write_spc("first SPC", "first profile")
    profile = Path(os.environ["AWS_CONFIG_FILE"])
    assert spc.read_text() == "first SPC"
    assert profile.read_text() == "first profile"
    assert stat.S_ISREG(spc.lstat().st_mode)
    assert stat.S_IMODE(spc.stat().st_mode) == stat.S_IMODE(profile.stat().st_mode) == 0o600
    assert stat.S_IMODE(root.stat().st_mode) == stat.S_IMODE(profile.resolve().parent.stat().st_mode) == 0o700
    old = profile.resolve().parent
    entrypoint.write_spc("second SPC", "second profile")
    assert spc.read_text() == "second SPC" and profile.read_text() == "second profile"
    assert stat.S_ISREG(spc.lstat().st_mode)
    assert profile.resolve().parent != old


@pytest.mark.parametrize("failure", ["second_file", "publish"])
def test_failure_before_profile_publication_preserves_previous_files(private_paths, monkeypatch, failure):
    root, spc = private_paths
    entrypoint.write_spc("old SPC", "old profile")
    profile = Path(os.environ["AWS_CONFIG_FILE"])
    old = profile.resolve().parent
    if failure == "second_file":
        original = entrypoint._write_private
        def write(path, contents):
            if Path(path).name == "config":
                raise OSError("PRIVATE_FILE_DETAIL")
            return original(path, contents)
        monkeypatch.setattr(entrypoint, "_write_private", write)
    else:
        original = entrypoint.os.replace
        def replace(source, target):
            if Path(target) == root / "current":
                raise OSError("PRIVATE_FILE_DETAIL")
            return original(source, target)
        monkeypatch.setattr(entrypoint.os, "replace", replace)
    with pytest.raises(ValueError, match="runtime_configuration_write_failed") as error:
        entrypoint.write_spc("new SPC", "new profile")
    assert "PRIVATE_FILE_DETAIL" not in str(error.value)
    assert spc.read_text() == "old SPC" and profile.read_text() == "old profile"
    assert stat.S_ISREG(spc.lstat().st_mode)
    assert profile.resolve().parent == old
    assert sorted(root.glob("gen-*")) == [old]


def test_profile_root_symlink_is_rejected_without_writing_outside(private_paths, tmp_path):
    root, _ = private_paths
    outside = tmp_path / "outside"
    outside.mkdir()
    root.symlink_to(outside, target_is_directory=True)
    with pytest.raises(ValueError, match="runtime_configuration_write_failed"):
        entrypoint.write_spc("SPC", "profile")
    assert list(outside.iterdir()) == []

@pytest.mark.parametrize("failure", ["profile_committed", "spc_publish"])
def test_incomplete_publication_keeps_profiles_but_never_restarts(private_paths, monkeypatch, failure):
    root, spc = private_paths
    entrypoint.write_spc("old SPC", "old profile")
    original = entrypoint.os.replace
    def replace(source, target):
        if failure == "spc_publish" and Path(target) == spc:
            raise OSError("PRIVATE_FILE_DETAIL")
        original(source, target)
        if failure == "profile_committed" and Path(target) == root / "current":
            raise OSError("PRIVATE_FILE_DETAIL")
    monkeypatch.setattr(entrypoint.os, "replace", replace)
    stop, fatal = threading.Event(), threading.Event()
    proc = mock.Mock()
    refs = [proc]
    with mock.patch.object(entrypoint, "_stop_steampipe_service", return_value=True), \
            mock.patch.object(entrypoint, "_start_steampipe") as start:
        with pytest.raises(RuntimeError, match="steampipe_configuration_publish_failed"):
            entrypoint._restart_steampipe(refs, threading.Lock(), proc, stop, fatal,
                prepare=lambda: entrypoint.write_spc("new SPC", "new profile"))
        assert stop.is_set() and fatal.is_set() and refs[0] is None
        start.assert_not_called()
    profile = Path(os.environ["AWS_CONFIG_FILE"])
    assert spc.read_text() == "old SPC" and profile.read_text() == "new profile"
    assert stat.S_ISREG(spc.lstat().st_mode)
    assert profile.resolve().is_file()
    assert not list(spc.parent.glob(".awsops-spc-*"))
    assert not list(root.glob(".current-*"))


def test_previous_owned_spc_symlink_is_replaced_without_modifying_its_target(private_paths):
    root, spc = private_paths
    entrypoint.write_spc("old SPC", "old profile")
    old = (root / "current" / "aws.spc").resolve()
    spc.unlink()
    spc.symlink_to(root / "current" / "aws.spc")
    entrypoint.write_spc("new SPC", "new profile")
    assert old.read_text() == "old SPC"
    assert spc.read_text() == "new SPC"
    assert stat.S_ISREG(spc.lstat().st_mode)
    assert stat.S_IMODE(spc.lstat().st_mode) == 0o600


def test_image_exposes_profile_path_to_service_and_healthcheck_processes():
    dockerfile = (Path(__file__).parent / "Dockerfile").read_text()
    assert f"ENV AWS_CONFIG_FILE={entrypoint.RUNTIME_CONFIG_DIR}/current/config" in dockerfile


def test_external_id_only_change_stops_then_publishes_then_restarts(monkeypatch):
    row = {"account_id": "210987654321", "is_host": False, "role_name": "AWSopsReadOnlyRole",
           "external_id": "old-value", "all_regions": True, "regions": []}
    monkeypatch.delenv("INVENTORY_HOST_ONLY", raising=False)
    monkeypatch.delenv("INVENTORY_TARGET_ACCOUNT_IDS", raising=False)
    initial = entrypoint._render_runtime_config([row])
    changed = {**row, "external_id": "new-value"}
    desired = entrypoint._render_runtime_config([changed])
    assert initial[0] == desired[0] and initial[1] != desired[1]
    calls = []
    stop = threading.Event()
    proc = mock.Mock()
    proc.wait.return_value = 0
    with mock.patch.object(stop, "wait", side_effect=[False, True]), \
            mock.patch.object(entrypoint, "fetch_rows", return_value=[changed]), \
            mock.patch.object(entrypoint, "_stop_steampipe_service", side_effect=lambda: calls.append("stop") or True), \
            mock.patch.object(entrypoint, "write_spc", side_effect=lambda *pair: calls.append(("publish", pair))), \
            mock.patch.object(entrypoint, "_start_steampipe", side_effect=lambda: calls.append("start") or mock.Mock()):
        entrypoint._scope_watchdog(initial, [proc], threading.Lock(), stop, threading.Event())
    assert calls == ["stop", ("publish", desired), "start"]


def test_publish_failure_prevents_launch_and_sets_fatal_before_unlock():
    stop, fatal = threading.Event(), threading.Event()
    proc = mock.Mock()
    proc.wait.return_value = 0
    refs = [proc]
    with mock.patch.object(entrypoint, "_stop_steampipe_service", return_value=True), \
            mock.patch.object(entrypoint, "_start_steampipe") as start:
        with pytest.raises(RuntimeError, match="steampipe_configuration_publish_failed"):
            entrypoint._restart_steampipe(refs, threading.Lock(), proc, stop, fatal,
                prepare=lambda: (_ for _ in ()).throw(ValueError("PRIVATE_PROFILE_DETAIL")))
        assert stop.is_set() and fatal.is_set() and refs[0] is None
        start.assert_not_called()


def test_publish_failure_keeps_the_underlying_fixed_diagnostic(capsys):
    stop, fatal = threading.Event(), threading.Event()
    proc = mock.Mock()
    with mock.patch.object(entrypoint, "_stop_steampipe_service", return_value=True):
        with pytest.raises(entrypoint.SteampipeRestartError, match="steampipe_configuration_publish_failed"):
            entrypoint._restart_steampipe([proc], threading.Lock(), proc, stop, fatal,
                prepare=lambda: (_ for _ in ()).throw(
                    entrypoint.HostScopeError("runtime_configuration_write_failed")))
    assert "[gen-spc] FATAL: runtime_configuration_write_failed" in capsys.readouterr().err
