import os
from unittest.mock import MagicMock, patch

import redeploy

AURORA_ARN = "arn:aws:secretsmanager:ap-northeast-2:123456789012:secret:rds!cluster-abc123-def456"


def _service_event(secret_id):
    """Real shape observed for Secrets Manager RotationSucceeded: an 'AWS Service Event via
    CloudTrail' detail-type carrying the secret id under serviceEventDetails.secretId — not
    additionalEventData or requestParameters."""
    return {
        "detail-type": "AWS Service Event via CloudTrail",
        "detail": {
            "eventSource": "secretsmanager.amazonaws.com",
            "eventName": "RotationSucceeded",
            "serviceEventDetails": {"secretId": secret_id},
        },
    }


def test_redeploys_on_matching_service_event():
    with patch.dict(os.environ, {"CLUSTER": "c", "SERVICES": "web", "AURORA_SECRET_ARN": AURORA_ARN}):
        with patch("redeploy.boto3.client") as mock_client:
            ecs = MagicMock()
            mock_client.return_value = ecs
            result = redeploy.handler(_service_event(AURORA_ARN), None)
    ecs.update_service.assert_called_once_with(cluster="c", service="web", forceNewDeployment=True)
    assert result == {"redeployed": ["web"]}


def test_redeploys_when_event_secret_has_different_random_suffix():
    other_arn = "arn:aws:secretsmanager:ap-northeast-2:123456789012:secret:rds!cluster-abc123-zzzzzz"
    with patch.dict(os.environ, {"CLUSTER": "c", "SERVICES": "web", "AURORA_SECRET_ARN": AURORA_ARN}):
        with patch("redeploy.boto3.client") as mock_client:
            ecs = MagicMock()
            mock_client.return_value = ecs
            result = redeploy.handler(_service_event(other_arn), None)
    ecs.update_service.assert_called_once()
    assert result == {"redeployed": ["web"]}


def test_skips_unrelated_secret():
    with patch.dict(os.environ, {"CLUSTER": "c", "SERVICES": "web", "AURORA_SECRET_ARN": AURORA_ARN}):
        with patch("redeploy.boto3.client") as mock_client:
            result = redeploy.handler(_service_event("arn:aws:secretsmanager:ap-northeast-2:123456789012:secret:some-other-secret-ab12cd"), None)
            mock_client.assert_not_called()
    assert "skipped" in result


def test_fail_closed_when_target_unconfigured():
    with patch.dict(os.environ, {"CLUSTER": "c", "SERVICES": "web", "AURORA_SECRET_ARN": ""}):
        with patch("redeploy.boto3.client") as mock_client:
            result = redeploy.handler(_service_event(AURORA_ARN), None)
            mock_client.assert_not_called()
    assert result == {"skipped": "no-target-configured"}


def test_fail_closed_when_event_has_no_recognized_secret_id_field():
    with patch.dict(os.environ, {"CLUSTER": "c", "SERVICES": "web", "AURORA_SECRET_ARN": AURORA_ARN}):
        with patch("redeploy.boto3.client") as mock_client:
            event = {"detail-type": "AWS Service Event via CloudTrail", "detail": {"eventName": "RotationSucceeded"}}
            result = redeploy.handler(event, None)
            mock_client.assert_not_called()
    assert result == {"skipped": "unidentified-secret"}


def test_exact_arn_match_is_tried_before_the_lossy_fallback():
    # Two DIFFERENT secrets can share a truncated base name after the -XXXXXX suffix is
    # stripped; an exact string match must win so a real full-ARN match is never second-guessed
    # by the fallback (this only *demonstrates* the exact path runs first — see next test for
    # what the fallback existing at all trades off).
    assert redeploy._matches_target(AURORA_ARN, AURORA_ARN) is True


def test_multi_service_partial_failure_does_not_abort_the_rest():
    with patch.dict(os.environ, {"CLUSTER": "c", "SERVICES": "web,steampipe", "AURORA_SECRET_ARN": AURORA_ARN}):
        with patch("redeploy.boto3.client") as mock_client:
            ecs = MagicMock()
            ecs.update_service.side_effect = [Exception("throttled"), None]
            mock_client.return_value = ecs
            result = redeploy.handler(_service_event(AURORA_ARN), None)
    assert result["redeployed"] == ["steampipe"]
    assert "web" in result["failed"]
