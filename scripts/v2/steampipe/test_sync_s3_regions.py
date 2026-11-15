"""Authoritative list-region evidence must survive denied bucket metadata reads."""
import pytest
from botocore.exceptions import ClientError

import sync_lambda


COLLECTORS = (sync_lambda._fetch_s3_security, sync_lambda._fetch_s3_public_access)


class BucketClient:
    def __init__(self, pages, *, deny_attributes=False):
        self.pages = pages
        self.deny_attributes = deny_attributes
        self.list_calls = []
        self.location_calls = []

    def list_buckets(self, **kwargs):
        self.list_calls.append(kwargs)
        page = self.pages[len(self.list_calls) - 1]
        if isinstance(page, Exception):
            raise page
        return page

    def get_bucket_location(self, Bucket):
        self.location_calls.append(Bucket)
        if Bucket == "legacy":
            return {"LocationConstraint": None}
        raise ClientError({"Error": {"Code": "AccessDenied"}}, "GetBucketLocation")

    def __getattr__(self, name):
        if name.startswith("get_"):
            def attribute(**kwargs):
                if self.deny_attributes:
                    raise ClientError({"Error": {"Code": "AccessDenied"}}, name)
                return {}
            return attribute
        raise AttributeError(name)


@pytest.mark.parametrize("collect", COLLECTORS)
def test_list_region_keeps_denied_bucket_with_truthful_unknown_attributes(collect):
    client = BucketClient(
        [{"Buckets": [{"Name": "locked", "BucketRegion": "ap-northeast-2"}]}],
        deny_attributes=True,
    )
    rows, _, _, evidence = collect(client)
    assert len(rows) == 1
    assert rows[0]["region"] == "ap-northeast-2"
    assert rows[0]["attributes_unknown"]
    assert rows[0]["bucket_policy_is_public"] is None
    assert client.location_calls == []
    assert evidence["failure_count"] == 0
    assert evidence["unknown_attribute_count"] > 0


@pytest.mark.parametrize("collect", COLLECTORS)
def test_collects_all_list_pages_and_falls_back_only_for_missing_region(collect):
    client = BucketClient([
        {"Buckets": [{"Name": "first", "BucketRegion": "eu-west-1"}],
         "ContinuationToken": "private-next-page"},
        {"Buckets": [{"Name": "legacy"}]},
    ])
    rows, _, _, evidence = collect(client)
    assert [(row["name"], row["region"]) for row in rows] == [
        ("first", "eu-west-1"), ("legacy", "us-east-1"),
    ]
    assert client.location_calls == ["legacy"]
    assert client.list_calls == [
        {"MaxBuckets": 1000},
        {"MaxBuckets": 1000, "ContinuationToken": "private-next-page"},
    ]
    assert evidence["failure_count"] == 0


@pytest.mark.parametrize("collect", COLLECTORS)
def test_failed_later_page_never_returns_a_complete_first_page(collect):
    client = BucketClient([
        {"Buckets": [{"Name": "first", "BucketRegion": "eu-west-1"}],
         "ContinuationToken": "next"},
        ClientError({"Error": {"Code": "SlowDown"}}, "ListBuckets"),
    ])
    with pytest.raises(ClientError):
        collect(client)


@pytest.mark.parametrize("collect", COLLECTORS)
def test_repeated_page_token_fails_closed_without_disclosing_token(collect):
    client = BucketClient([
        {"Buckets": [], "ContinuationToken": "private-token"},
        {"Buckets": [], "ContinuationToken": "private-token"},
    ])
    with pytest.raises(RuntimeError, match="bucket listing") as error:
        collect(client)
    assert "private-token" not in str(error.value)


@pytest.mark.parametrize("collect", COLLECTORS)
def test_missing_region_and_denied_location_remain_incomplete(collect):
    client = BucketClient([{"Buckets": [{"Name": "locked"}]}])
    rows, _, _, evidence = collect(client)
    assert rows == []
    assert evidence["failure_count"] == 1


@pytest.mark.parametrize("collect", COLLECTORS)
def test_duplicate_bucket_identity_does_not_prove_complete_enumeration(collect):
    client = BucketClient([
        {"Buckets": [{"Name": "duplicate", "BucketRegion": "eu-west-1"}],
         "ContinuationToken": "next"},
        {"Buckets": [{"Name": "duplicate", "BucketRegion": "us-east-1"}]},
    ])
    with pytest.raises(RuntimeError, match="bucket listing"):
        collect(client)
