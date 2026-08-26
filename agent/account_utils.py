"""Host-account resolution for the AWSops agent runtime.

Extracted from agent.py so it can be imported directly by tests — agent.py runs
AWS calls at import time and pulls runtime-only deps (strands, bedrock_agentcore),
so it is not importable in a plain test environment. This module has no such
side effects.
"""
import functools
import logging
import os

import boto3

logger = logging.getLogger(__name__)


@functools.lru_cache(maxsize=1)
def _host_account_id():
    """The account this agent runtime executes in.

    Prefer AWSOPS_HOST_ACCOUNT_ID (no network call); fall back to STS
    GetCallerIdentity (always permitted). Cached for the warm container.

    Tests that monkeypatch the environment must call
    ``_host_account_id.cache_clear()`` so the cache does not leak across cases.
    """
    env = os.environ.get("AWSOPS_HOST_ACCOUNT_ID", "").strip()
    if env:
        return env
    try:
        return boto3.client("sts").get_caller_identity()["Account"]
    except Exception as e:  # network / permission edge — degrade, don't crash
        logger.warning("host account lookup failed (%s); cross-account guard degraded", e)
        return None


def effective_account_id(account_id):
    """Cross-account target to act on, or '' for same-account access.

    Returns '' (use the agent's own role — no target_account_id) when account_id
    is empty, '__all__', or the host account this runtime runs in. v2 is
    single-account: forcing target_account_id=<host> made tools self-assume the
    nonexistent host-account AWSopsReadOnlyRole. The tool layer also guards this,
    so this is defense-in-depth that keeps the redundant param out of the prompt.

    If the host account can't be resolved (env unset + STS failed), a real
    account_id passes through unchanged — the warning above is the operational
    signal; behavior falls back to the pre-fix cross-account path.
    """
    acct = str(account_id).strip() if account_id else ""
    if not acct or acct == "__all__":
        return ""
    host = _host_account_id()
    if host and acct == host:
        return ""
    return acct
