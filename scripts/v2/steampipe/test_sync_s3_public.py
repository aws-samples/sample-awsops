"""s3_public_access SDK sync: denial-safe per-bucket public-access flags. One denied bucket must
not fail the whole sync; the SDK_SYNCS contract is (rows: list[dict], id_col, region_col)."""
from botocore.exceptions import ClientError

import sync_lambda  # PYTHONPATH must include scripts/v2/steampipe


class FakeS3:
    def __init__(self, buckets, denied=(), no_pab=()):
        self._buckets = buckets
        self._denied = set(denied)
        self._no_pab = set(no_pab)

    def list_buckets(self):
        return {"Buckets": [{"Name": b} for b in self._buckets]}

    def get_bucket_location(self, Bucket):
        return {"LocationConstraint": "ap-northeast-2"}

    def get_public_access_block(self, Bucket):
        if Bucket in self._denied:
            raise ClientError({"Error": {"Code": "AccessDenied"}}, "GetPublicAccessBlock")
        if Bucket in self._no_pab:
            raise ClientError({"Error": {"Code": "NoSuchPublicAccessBlock"}}, "GetPublicAccessBlock")
        return {"PublicAccessBlockConfiguration": {
            "BlockPublicAcls": True, "BlockPublicPolicy": True,
            "RestrictPublicBuckets": True, "IgnorePublicAcls": True}}

    def get_bucket_policy_status(self, Bucket):
        if Bucket in self._denied:
            raise ClientError({"Error": {"Code": "AccessDenied"}}, "GetBucketPolicyStatus")
        return {"PolicyStatus": {"IsPublic": Bucket == "pub"}}


def test_contract_shape_is_rows_idcol_regioncol():
    rows, id_col, region_col = sync_lambda._fetch_s3_public_access(FakeS3(["x"]))
    assert id_col == "name" and region_col == "region"
    assert isinstance(rows, list) and rows[0]["name"] == "x" and rows[0]["region"] == "ap-northeast-2"


def test_one_denied_bucket_does_not_fail_sync():
    fake = FakeS3(buckets=["pub", "priv", "locked"], denied=["locked"])
    rows, _id, _rg = sync_lambda._fetch_s3_public_access(fake)
    by = {r["name"]: r for r in rows}
    assert by["pub"]["bucket_policy_is_public"] is True
    assert by["priv"]["bucket_policy_is_public"] is False
    assert by["priv"]["block_public_acls"] is True
    # denied bucket still emitted, flags unknown (None) — sync did not raise
    assert "locked" in by
    assert by["locked"]["bucket_policy_is_public"] is None
    assert by["locked"]["block_public_acls"] is None


def test_no_public_access_block_marks_blocks_false():
    rows, _id, _rg = sync_lambda._fetch_s3_public_access(FakeS3(["open"], no_pab=["open"]))
    rec = rows[0]
    assert rec["block_public_acls"] is False
    assert rec["block_public_policy"] is False


def test_registered_in_sdk_syncs():
    assert sync_lambda.SDK_SYNCS["s3_public_access"] is sync_lambda._fetch_s3_public_access
    assert "s3_public_access" in sync_lambda._ALLOWED
