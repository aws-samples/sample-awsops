"""s3_public_access SDK sync: denial-safe rows plus safe partial-failure metadata."""
from botocore.exceptions import ClientError

import sync_lambda  # PYTHONPATH must include scripts/v2/steampipe


class FakeS3:
    def __init__(self, buckets, denied=(), no_pab=(), no_policy=(), loc_denied=()):
        self._buckets = buckets
        self._denied = set(denied)
        self._no_pab = set(no_pab)
        self._no_policy = set(no_policy)
        self._loc_denied = set(loc_denied)

    def list_buckets(self):
        return {"Buckets": [{"Name": b} for b in self._buckets]}

    def get_bucket_location(self, Bucket):
        if Bucket in self._loc_denied:
            raise ClientError(
                {"Error": {"Code": "AccessDenied", "Message": f"secret={Bucket}"}},
                "GetBucketLocation",
            )
        return {"LocationConstraint": "ap-northeast-2"}

    def get_public_access_block(self, Bucket):
        if Bucket in self._denied:
            raise ClientError(
                {"Error": {"Code": "AccessDenied", "Message": f"secret={Bucket}"}},
                "GetPublicAccessBlock",
            )
        if Bucket in self._no_pab:
            # the REAL live error code (the short "NoSuchPublicAccessBlock" is also accepted)
            raise ClientError({"Error": {"Code": "NoSuchPublicAccessBlockConfiguration"}}, "GetPublicAccessBlock")
        return {"PublicAccessBlockConfiguration": {
            "BlockPublicAcls": True, "BlockPublicPolicy": True,
            "RestrictPublicBuckets": True, "IgnorePublicAcls": True}}

    def get_bucket_policy_status(self, Bucket):
        if Bucket in self._denied:
            raise ClientError(
                {"Error": {"Code": "AccessDenied", "Message": f"secret={Bucket}"}},
                "GetBucketPolicyStatus",
            )
        if Bucket in self._no_policy:
            raise ClientError(
                {"Error": {"Code": "NoSuchBucketPolicy", "Message": f"bucket={Bucket}"}},
                "GetBucketPolicyStatus",
            )
        return {"PolicyStatus": {"IsPublic": Bucket == "pub"}}


def test_contract_shape_includes_empty_failure_metadata():
    rows, id_col, region_col, failures = sync_lambda._fetch_s3_public_access(FakeS3(["x"]))
    assert id_col == "name" and region_col == "region"
    assert isinstance(rows, list) and rows[0]["name"] == "x" and rows[0]["region"] == "ap-northeast-2"
    assert failures == {
        "failure_count": 0,
        "failure_types": [],
        "unknown_attribute_count": 0,
    }


def test_attribute_denied_bucket_keeps_row_with_unknowns_and_is_not_partial(capsys):
    # A steady-state attribute-level denial (SCP-denied bucket) is already modeled as
    # "unknown -> None" on the row, so it must NOT make the run partial — otherwise one
    # such bucket would disable stale-pruning and freeze last_success_at forever. The blind
    # reads are still DISCLOSED as unknown_attribute_count so freshness can degrade.
    fake = FakeS3(buckets=["pub", "priv", "locked"], denied=["locked"])
    rows, _id, _rg, failures = sync_lambda._fetch_s3_public_access(fake)
    by = {r["name"]: r for r in rows}
    assert by["pub"]["bucket_policy_is_public"] is True
    assert by["priv"]["bucket_policy_is_public"] is False
    assert by["priv"]["block_public_acls"] is True
    # denied bucket still emitted, flags unknown (None) — sync did not raise
    assert "locked" in by
    assert by["locked"]["bucket_policy_is_public"] is None
    assert by["locked"]["block_public_acls"] is None
    # ...and the blind fields travel WITH the row, so a reader can render "unassessable"
    # instead of silently showing the None flags as verified-clean.
    assert by["locked"]["attributes_unknown"] == [
        "block_public_acls", "block_public_policy",
        "restrict_public_buckets", "ignore_public_acls",
        "bucket_policy_is_public",
    ]
    # a fully-read bucket carries no marker at all
    assert "attributes_unknown" not in by["pub"]
    # 'locked' is denied on PAB + policy-status = 2 blind attribute reads
    assert failures == {
        "failure_count": 0,
        "failure_types": [],
        "unknown_attribute_count": 2,
    }
    assert "locked" not in capsys.readouterr().out


def test_location_denied_bucket_is_skipped_and_counts_as_partial(capsys):
    # A bucket we cannot place is skipped for the run instead of upserted under
    # region "" (which would land a duplicate row under a different conflict key).
    # Counting the failure keeps the run partial, so the skipped prunes preserve the
    # bucket's last-good row.
    fake = FakeS3(buckets=["pub", "nowhere"], loc_denied=["nowhere"])
    rows, _id, _rg, failures = sync_lambda._fetch_s3_public_access(fake)
    by = {r["name"]: r for r in rows}
    assert "nowhere" not in by
    assert by["pub"]["bucket_policy_is_public"] is True
    assert failures == {
        "failure_count": 1,
        "failure_types": ["ClientError:AccessDenied"],
        "unknown_attribute_count": 0,
    }
    assert "nowhere" not in capsys.readouterr().out


def test_throttle_on_attribute_call_still_counts_as_partial():
    # Throttles are transient (not steady-state denials) — they must keep the run
    # partial so pruning/last_success_at wait for a complete sweep. The transiently
    # degraded rec is also SKIPPED: upserting it would overwrite the bucket's
    # last-known-good row content with None fields while the prunes are skipped.
    class ThrottledS3(FakeS3):
        def get_public_access_block(self, Bucket):
            if Bucket == "throttled":
                raise ClientError({"Error": {"Code": "SlowDown"}}, "GetPublicAccessBlock")
            return super().get_public_access_block(Bucket)

    rows, _id, _rg, failures = sync_lambda._fetch_s3_public_access(
        ThrottledS3(["pub", "throttled"])
    )
    by = {r["name"]: r for r in rows}
    assert "throttled" not in by
    assert by["pub"]["block_public_acls"] is True
    assert failures["failure_count"] == 1
    assert failures["unknown_attribute_count"] == 0
    assert "ClientError:SlowDown" in failures["failure_types"]


def test_no_public_access_block_marks_blocks_false():
    rows, _id, _rg, failures = sync_lambda._fetch_s3_public_access(
        FakeS3(["open"], no_pab=["open"])
    )
    rec = rows[0]
    assert rec["block_public_acls"] is False
    assert rec["block_public_policy"] is False
    assert failures == {
        "failure_count": 0,
        "failure_types": [],
        "unknown_attribute_count": 0,
    }


def test_no_bucket_policy_is_expected_absence_not_a_partial_failure():
    # NoSuchBucketPolicy is a definitive "not public via policy" (False, lockstep with
    # _fetch_s3_security's gap-L240 handler) — an expected absence, never a partial failure.
    rows, _id, _rg, failures = sync_lambda._fetch_s3_public_access(
        FakeS3(["private"], no_policy=["private"])
    )
    assert rows[0]["bucket_policy_is_public"] is False
    assert failures == {
        "failure_count": 0,
        "failure_types": [],
        "unknown_attribute_count": 0,
    }


def test_no_bucket_policy_is_definitively_not_public():
    """NoSuchBucketPolicy => False — kept in LOCKSTEP with _fetch_s3_security's identical call:
    the same column on the same bucket must never carry different semantics across the two
    inventory types (/inventory/s3 vs /inventory/s3_public_access)."""
    rows, _id, _rg, _meta = sync_lambda._fetch_s3_public_access(FakeS3(["bare"], no_policy=["bare"]))
    assert rows[0]["bucket_policy_is_public"] is False


def test_registered_in_sdk_syncs():
    assert sync_lambda.SDK_SYNCS["s3_public_access"] is sync_lambda._fetch_s3_public_access
    assert "s3_public_access" in sync_lambda._ALLOWED
