"""Host-only inventory fails before rendering; all AWS/DB calls are mocked."""
import os
import sys
import threading
from unittest import mock

import pytest
from botocore.exceptions import ClientError

sys.path.insert(0, os.path.dirname(__file__))
import gen_spc_entrypoint as entrypoint

ACCOUNT = "123456789012"
HOST = {"account_id": ACCOUNT, "is_host": True, "role_name": "AWSopsReadOnlyRole",
        "external_id": None, "all_regions": False, "regions": []}
ENV = {"INVENTORY_HOST_ONLY": "true", "EXPECTED_HOST_ACCOUNT_ID": ACCOUNT}


@pytest.fixture(autouse=True)
def clear_identity_client():
    entrypoint._host_sts_client.cache_clear()
    yield
    entrypoint._host_sts_client.cache_clear()


def test_default_mode_preserves_existing_render_without_sts():
    with mock.patch.dict(os.environ, {}, clear=True), mock.patch.object(entrypoint, "boto3") as sdk:
        assert 'regions = ["*"]' in entrypoint._render_spc([HOST])
        sdk.client.assert_not_called()


def test_verified_host_keeps_all_regions_without_self_assume():
    with mock.patch.dict(os.environ, ENV, clear=True), mock.patch.object(entrypoint, "boto3") as sdk:
        sdk.client.return_value.get_caller_identity.return_value = {"Account": ACCOUNT}
        result = entrypoint._render_spc([HOST])
        assert 'regions = ["*"]' in result
        assert "assume_role_arn" not in result
        sdk.client.assert_called_once()
        assert sdk.client.call_args.args == ("sts",)


@pytest.mark.parametrize("rows", [
    [], [HOST, HOST], [{**HOST, "is_host": False}], [{**HOST, "is_host": 1}],
    [{**HOST, "account_id": "999999999999"}], [None],
    [HOST, {**HOST, "account_id": "999999999999", "is_host": False}],
])
def test_invalid_enabled_scope_never_reaches_renderer(rows):
    with mock.patch.dict(os.environ, ENV, clear=True), mock.patch.object(entrypoint, "boto3") as sdk, \
            mock.patch.object(entrypoint, "render_spc") as render:
        sdk.client.return_value.get_caller_identity.return_value = {"Account": ACCOUNT}
        with pytest.raises(entrypoint.HostScopeError):
            entrypoint._render_spc(rows)
        render.assert_not_called()


@pytest.mark.parametrize("change", [
    {"EXPECTED_HOST_ACCOUNT_ID": ""}, {"EXPECTED_HOST_ACCOUNT_ID": "self"},
    {"INVENTORY_HOST_ONLY": "TRUE"}, {"INVENTORY_HOST_ONLY": "invalid"},
])
def test_invalid_configuration_fails_before_any_sdk_call(change):
    with mock.patch.dict(os.environ, {**ENV, **change}, clear=True), \
            mock.patch.object(entrypoint, "boto3") as sdk:
        with pytest.raises(entrypoint.HostScopeError):
            entrypoint._render_spc([HOST])
        sdk.client.assert_not_called()


@pytest.mark.parametrize("response", [{}, {"Account": "999999999999"}, None])
def test_actual_sts_account_must_match(response):
    with mock.patch.dict(os.environ, ENV, clear=True), mock.patch.object(entrypoint, "boto3") as sdk, \
            mock.patch.object(entrypoint, "render_spc") as render:
        sdk.client.return_value.get_caller_identity.return_value = response
        with pytest.raises(entrypoint.HostScopeError):
            entrypoint._render_spc([HOST])
        render.assert_not_called()


def test_identity_failure_is_redacted_and_cannot_render():
    with mock.patch.dict(os.environ, ENV, clear=True), mock.patch.object(entrypoint, "boto3") as sdk, \
            mock.patch.object(entrypoint, "render_spc") as render:
        sdk.client.return_value.get_caller_identity.side_effect = ClientError(
            {"Error": {"Code": "AccessDenied", "Message": "PRIVATE_REMOTE_DETAIL"}}, "GetCallerIdentity")
        with pytest.raises(entrypoint.HostScopeError, match="^host_identity_unavailable$"):
            entrypoint._render_spc([HOST])
        render.assert_not_called()


def test_invalid_boot_scope_cannot_write_or_start_inventory():
    with mock.patch.dict(os.environ, {**ENV, "AURORA_ENDPOINT": "fixture", "AURORA_DATABASE": "fixture"}, clear=True), \
            mock.patch.object(entrypoint, "fetch_rows", return_value=[]), \
            mock.patch.object(entrypoint, "write_spc") as write, \
            mock.patch.object(entrypoint, "_start_steampipe") as start:
        with pytest.raises(SystemExit) as error:
            entrypoint.main()
        assert error.value.code == 1
        write.assert_not_called()
        start.assert_not_called()


def test_watchdog_scope_rejection_stops_running_inventory_instead_of_keeping_stale_scope():
    proc = mock.Mock()
    stop = mock.Mock()
    stop.wait.side_effect = [False, True]
    with mock.patch.object(entrypoint, "fetch_rows", return_value=[]), \
            mock.patch.object(entrypoint, "_render_spc", side_effect=entrypoint.HostScopeError("invalid_host_scope")), \
            mock.patch.object(entrypoint, "write_spc") as write, \
            mock.patch.object(entrypoint, "_stop_steampipe_service") as shutdown:
        entrypoint._scope_watchdog("previous", [proc], threading.Lock(), stop)
        stop.set.assert_called_once()
        shutdown.assert_called_once()
        proc.terminate.assert_called_once()
        write.assert_not_called()
