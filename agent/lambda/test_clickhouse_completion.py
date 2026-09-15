"""Completion evidence must originate at the real ClickHouse HTTP boundary."""
import json
from unittest.mock import patch

import pytest
import clickhouse_mcp as ch

META = [{"name": "TraceId", "type": "String"}]


@pytest.mark.parametrize("data,expected", [
    ({"data": [], "meta": META}, "empty"),
    ({"data": [{"TraceId": "a"}], "meta": META}, "ok"),
    ({"meta": META}, "unknown"),
    ({"data": [], "meta": None}, "unknown"),
    ({"data": [], "meta": []}, "unknown"),
    ({"data": [], "meta": META, "exception": "PRIVATE"}, "error"),
    ({"data": [{"TraceId": "a"}, None], "meta": META}, "partial"),
    ({"data": [{"TraceId": "a"}] * 3, "meta": META}, "partial"),
])
def test_query_completion(data, expected):
    with patch.object(ch, "load_datasource", return_value={"endpoint": "https://fixture.invalid"}), \
            patch.object(ch, "assert_host_allowed"), patch.object(ch, "auth_headers", return_value={}), \
            patch.object(ch, "http_json", return_value=(200, data)):
        response = ch.clickhouse_query({"sql": "SELECT TraceId FROM traces", "max_rows": 3})
    body = json.loads(response["body"])
    assert body["collectionStatus"] == expected
    assert len(body["rows"]) <= 3
    assert "PRIVATE" not in json.dumps(body)
