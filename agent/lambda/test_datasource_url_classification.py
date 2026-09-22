import json
import pytest

from datasource_diag_mcp import _validate_datasource_url


@pytest.mark.parametrize("host", [
    "k8s-service.elb.ap-northeast-2.amazonaws.com",
    "k8s-service.elb.ap-northeast-2.amazonaws.com.",
    "K8S-SERVICE.ELB.AP-NORTHEAST-2.AMAZONAWS.COM.",
    "k8s-service.elb.ap-northeast-2.amazonaws.com\u3002",
    "k8s-service.elb.ap-northeast-2.amazonaws.com\uff0e",
    "k8s-service.elb.ap-northeast-2.amazonaws.com\uff61",
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

    spoof = classify(host.rstrip(".\u3002\uff0e\uff61") + ".evil.test")
    assert spoof["is_nlb_dns"] is False
    assert spoof["is_alb_dns"] is False


def test_invalid_dns_labels_do_not_produce_a_safe_classification():
    response = _validate_datasource_url({"url": "https://k8s-service.elb..amazonaws.com/"})
    assert json.loads(response["body"])["valid"] is False
