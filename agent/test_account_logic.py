"""Tests for agent/account_utils.py (effective_account_id / _host_account_id).

These functions live in account_utils.py (not agent.py) precisely so they can be
imported directly here — agent.py pulls runtime-only deps and runs AWS calls at
import time, so it isn't importable in a plain test env.

Regression: a chat targeting the host account injected target_account_id=<host>,
which made the tool layer self-assume the nonexistent host-account
AWSopsReadOnlyRole. effective_account_id() blanks the host account so the
directive is never emitted.
"""
import os
import sys

import pytest

sys.path.insert(0, os.path.dirname(__file__))
import account_utils as au  # noqa: E402

HOST = "123456789012"


@pytest.fixture
def acct(monkeypatch):
    # Pin host via env so _host_account_id makes no STS call; clear the lru_cache
    # so cases don't leak into each other.
    monkeypatch.setenv("AWSOPS_HOST_ACCOUNT_ID", HOST)
    au._host_account_id.cache_clear()
    yield au
    au._host_account_id.cache_clear()


def test_host_account_blanked(acct):
    # host account → '' (same-account: use the agent's own role, no directive)
    assert acct.effective_account_id(HOST) == ""
    assert acct.effective_account_id(f"  {HOST}  ") == ""


def test_other_account_passthrough(acct):
    assert acct.effective_account_id("222222222222") == "222222222222"
    assert acct.effective_account_id("  222222222222  ") == "222222222222"  # stripped


def test_all_and_empty_blanked(acct):
    assert acct.effective_account_id("__all__") == ""
    assert acct.effective_account_id("") == ""
    assert acct.effective_account_id(None) == ""


def test_host_unresolved_passes_through(monkeypatch):
    # env unset + STS failure → host is None → real account passes through (degraded)
    monkeypatch.delenv("AWSOPS_HOST_ACCOUNT_ID", raising=False)

    def _boom(*a, **k):
        raise RuntimeError("no sts")

    monkeypatch.setattr(au.boto3, "client", _boom)
    au._host_account_id.cache_clear()
    # tight oracle: prove the except→None branch fired (not just a non-matching host)
    assert au._host_account_id() is None
    assert au.effective_account_id("222222222222") == "222222222222"
    assert au.effective_account_id("  222222222222  ") == "222222222222"  # strip on degraded path too
    au._host_account_id.cache_clear()
