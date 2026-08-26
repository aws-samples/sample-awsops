import os, sys
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))  # scripts/v2/workers on path for `import db`

import pytest


@pytest.fixture(autouse=True)
def _clear_bedrock_client_cache():
    # ADR-045 added a region-keyed bedrock client cache (report._bedrock_clients) for concurrent section
    # rendering. The cache persists across tests, so a client built in one test (often a monkeypatched
    # fake) would leak into the next and silently defeat its own boto3.client monkeypatch — making
    # render_section tests order-dependent. Clear it before each test so they stay isolated.
    try:
        from diagnosis import report
        report._bedrock_clients.clear()
    except Exception:
        pass
    yield
