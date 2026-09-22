import json

from datasource_diag_mcp import _validate_datasource_url


def test_aws_dns_suffix_cannot_be_embedded_in_an_unrelated_hostname():
    def classify(host):
        response = _validate_datasource_url({"url": "https://" + host})
        assert response["statusCode"] == 200
        return json.loads(response["body"])

    actual = classify("k8s-service.elb.ap-northeast-2.amazonaws.com")
    assert actual["is_nlb_dns"] is True
    assert actual["is_alb_dns"] is True
    assert actual["ssrf_risk"] == "requires_allowlist"

    spoof = classify("k8s-service.elb.ap-northeast-2.amazonaws.com.evil.test")
    assert spoof["is_nlb_dns"] is False
    assert spoof["is_alb_dns"] is False
