"""Dynatrace nested caps and advertised page-loss regressions; no live provider."""
import json
import sys
from pathlib import Path
from unittest.mock import patch

import pytest

sys.path.insert(0, str(Path(__file__).parent))
import dynatrace_mcp as dt


def query(response):
    with patch.object(dt, "_ds", return_value={"endpoint": "https://provider.example.test"}), \
            patch.object(dt, "_get", return_value=response) as request:
        result = json.loads(dt.dynatrace_query({"query": "fixture.metric"})["body"])
    request.assert_called_once()
    return result


def series(count):
    return [{"dimensions": [str(i)], "timestamps": [1000], "values": [i]} for i in range(count)]


def test_nested_dimension_loss_is_partial_even_for_one_metric():
    response = {"result": [{"metricId": "fixture.metric", "data": series(dt.MAX_SERIES + 1)}]}
    result = query(response)
    assert len(result["result"][0]["data"]) == dt.MAX_SERIES
    assert result["truncated"] is True and result["collectionStatus"] == "partial"
    assert len(response["result"][0]["data"]) == dt.MAX_SERIES + 1


def test_outer_metric_cap_is_disclosed():
    result = query({"result": [{"metricId": str(i), "data": series(1)} for i in range(dt.MAX_SERIES + 1)]})
    assert len(result["result"]) == dt.MAX_SERIES and result["truncated"] is True


def test_unconsumed_compatibility_page_is_partial_and_is_not_automatically_fetched():
    result = query({"result": [{"metricId": "fixture.metric", "data": series(1)}], "nextPageKey": "next-fixture"})
    assert result["truncated"] is True and result["collectionStatus"] == "partial"


@pytest.mark.parametrize("page", [None, ""])
def test_exact_dimension_cap_and_no_next_page_are_not_loss(page):
    result = query({"result": [{"metricId": "fixture.metric", "data": series(dt.MAX_SERIES)}], "nextPageKey": page})
    assert result["truncated"] is False
