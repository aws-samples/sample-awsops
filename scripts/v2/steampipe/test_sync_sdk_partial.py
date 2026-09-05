"""SDK inventory collectors preserve successful rows while surfacing safe partial-failure metadata."""
from botocore.exceptions import ClientError

import sync_lambda


def _client_error(code, operation, message="credential=supersecret resource=secret-id"):
    return ClientError({"Error": {"Code": code, "Message": message}}, operation)


def test_cloudfront_collector_drops_rows_on_incomplete_origin_refs_with_redacted_metadata(
    monkeypatch, capsys
):
    class FakeCloudFront:
        def list_vpc_origins(self, **kwargs):
            return {"VpcOriginList": {"Items": [{"Id": "vo-good"}, {"Id": "vo-secret"}]}}

        def get_vpc_origin(self, Id):
            if Id == "vo-secret":
                raise _client_error("AccessDenied", "GetVpcOrigin")
            return {"VpcOrigin": {
                "Status": "Deployed",
                "VpcOriginEndpointConfig": {"Name": "good", "Arn": "arn:good"},
            }}

        def list_distributions(self, **kwargs):
            return {"DistributionList": {
                "Items": [{"Id": "dist-good"}, {"Id": "dist-secret"}],
            }}

        def get_distribution_config(self, Id):
            if Id == "dist-secret":
                raise _client_error("ThrottlingException", "GetDistributionConfig")
            return {"DistributionConfig": {"Origins": {"Items": [{
                "DomainName": "internal.example",
                "VpcOriginConfig": {"VpcOriginId": "vo-good"},
            }]}}}

    monkeypatch.setattr(sync_lambda.boto3, "client", lambda *args, **kwargs: FakeCloudFront())

    rows, id_col, region_col, failures = sync_lambda._fetch_cloudfront_vpc_origins()

    assert id_col == "resource_id"
    assert region_col == "region"
    # A failed get_distribution_config leaves origin-ref attribution incomplete for EVERY
    # row (any distribution can reference any vpc-origin), so no row may be upserted over
    # complete last-known-good content — the counted failure keeps the run partial instead.
    assert rows == []
    assert failures == {
        "failure_count": 2,
        "failure_types": ["ClientError:AccessDenied", "ClientError:ThrottlingException"],
        "unknown_attribute_count": 0,
    }
    output = capsys.readouterr().out
    assert "supersecret" not in output
    assert "vo-secret" not in output
    assert "dist-secret" not in output


def test_alb_listener_collector_returns_good_rows_and_safe_partial_metadata(monkeypatch, capsys):
    class FakeElbv2:
        def describe_load_balancers(self, **kwargs):
            return {"LoadBalancers": [
                {"Type": "application", "LoadBalancerArn": "arn:good"},
                {"Type": "application", "LoadBalancerArn": "arn:secret"},
            ]}

        def describe_listeners(self, LoadBalancerArn):
            if LoadBalancerArn == "arn:secret":
                raise _client_error("AccessDeniedException", "DescribeListeners")
            return {"Listeners": [{
                "ListenerArn": "listener:good",
                "Port": 443,
                "Protocol": "HTTPS",
            }]}

        def describe_rules(self, ListenerArn):
            return {"Rules": [{
                "RuleArn": "rule:good",
                "Priority": "default",
                "IsDefault": True,
                "Conditions": [],
                "Actions": [],
            }]}

    monkeypatch.setattr(sync_lambda.boto3, "client", lambda *args, **kwargs: FakeElbv2())

    rows, id_col, region_col, failures = sync_lambda._fetch_alb_listener_rules()

    assert id_col == "resource_id"
    assert region_col == "region"
    assert [row["resource_id"] for row in rows] == ["rule:good"]
    assert failures == {
        "failure_count": 1,
        "failure_types": ["ClientError:AccessDeniedException"],
        "unknown_attribute_count": 0,
    }
    output = capsys.readouterr().out
    assert "supersecret" not in output
    assert "arn:secret" not in output


def test_s3_security_collector_skips_transiently_degraded_row_and_discloses_unknowns(capsys):
    # Steady-state denials (versioning AccessDenied) are excluded from sdk_partial — the
    # row already carries them as "unknown -> None" — but they ARE disclosed as
    # unknown_attribute_count so freshness can degrade. A transient failure (logging
    # SlowDown) still counts, keeping the run partial, AND drops the rec: upserting it
    # would overwrite the bucket's last-known-good row content with None fields while the
    # partial run skips both prune phases.
    class FakeS3:
        def list_buckets(self):
            return {"Buckets": [{"Name": "secret-bucket"}]}

        def get_bucket_location(self, Bucket):
            return {"LocationConstraint": "ap-northeast-2"}

        def get_bucket_versioning(self, Bucket):
            raise _client_error("AccessDenied", "GetBucketVersioning")

        def get_bucket_encryption(self, Bucket):
            raise _client_error(
                "ServerSideEncryptionConfigurationNotFoundError",
                "GetBucketEncryption",
            )

        def get_bucket_logging(self, Bucket):
            raise _client_error("SlowDown", "GetBucketLogging")

        def get_bucket_tagging(self, Bucket):
            raise _client_error("NoSuchTagSet", "GetBucketTagging")

        def get_bucket_policy_status(self, Bucket):
            raise _client_error("NoSuchBucketPolicy", "GetBucketPolicyStatus")

    rows, id_col, region_col, failures = sync_lambda._fetch_s3_security(FakeS3())

    assert id_col == "name"
    assert region_col == "region"
    assert rows == []
    assert failures == {
        "failure_count": 1,
        "failure_types": ["ClientError:SlowDown"],
        "unknown_attribute_count": 1,
    }
    output = capsys.readouterr().out
    assert "supersecret" not in output
    assert "secret-bucket" not in output


def test_opensearch_serverless_response_errors_become_safe_partial_metadata(capsys):
    class FakeAoss:
        def list_collections(self, **kwargs):
            return {
                "collectionSummaries": [
                    {"id": "collection-good"},
                    {"id": "collection-secret"},
                ]
            }

        def batch_get_collection(self, ids):
            return {
                "collectionDetails": [{
                    "id": "collection-good",
                    "name": "good",
                    "arn": "arn:aws:aoss:ap-northeast-2:111111111111:collection/good",
                    "status": "ACTIVE",
                }],
                "collectionErrorDetails": [{
                    "id": "collection-secret",
                    "name": "secret-name",
                    "errorCode": "AccessDeniedException",
                    "errorMessage": "credential=supersecret account=222222222222",
                }],
            }

    rows, id_col, region_col, failures = sync_lambda._fetch_opensearch_serverless(FakeAoss())

    assert id_col == "name"
    assert region_col == "region"
    assert [row["name"] for row in rows] == ["good"]
    assert failures == {
        "failure_count": 1,
        "failure_types": ["CollectionError:AccessDeniedException"],
        "unknown_attribute_count": 0,
    }
    output = capsys.readouterr().out
    assert "supersecret" not in output
    assert "collection-secret" not in output
    assert "secret-name" not in output
    assert "222222222222" not in output
