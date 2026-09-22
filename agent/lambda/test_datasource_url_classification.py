import json
import pytest

from datasource_diag_mcp import _validate_datasource_url


@pytest.mark.parametrize("host", [
    "k8s-service.elb.ap-northeast-2.amazonaws.com",
    "k8s-service.elb.ap-northeast-2.amazonaws.com.",
    "K8S-SERVICE.ELB.AP-NORTHEAST-2.AMAZONAWS.COM.",
    "k8s-service.elb.cn-north-1.amazonaws.com.cn",
    "k8s-service.elb.cn-north-1.amazonaws.com.cn.",
])
def test_aws_dns_suffix_cannot_be_embedded_in_an_unrelated_hostname(host):
    def classify(host):
        response = _validate_datasource_url({"url": "https://" + host})
        assert response["statusCode"] == 200
        return json.loads(response["body"])

    actual = classify(host)
    assert actual["is_nlb_dns"] is True
    assert actual["is_alb_dns"] is True
    assert actual["ssrf_risk"] == "requires_allowlist"

    spoof = classify(host.rstrip(".") + ".evil.test")
    assert spoof["is_nlb_dns"] is False
    assert spoof["is_alb_dns"] is False
