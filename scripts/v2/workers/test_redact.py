import redact
import pytest


@pytest.mark.parametrize("value", ["2001:db8::1.ec2", "2001:db8::1:..", "2001:db8::1" + "." * 1000])
def test_ipv6_with_suffix_is_redacted(value):
    text = redact.redact("peer " + value)
    assert "2001:db8" not in text and "<ip>" in text


def test_ipv6_candidate_validation_has_a_fixed_length_bound(monkeypatch):
    original = redact.ipaddress.IPv6Address
    seen = []

    def checked(value):
        seen.append(value)
        return original(value)

    monkeypatch.setattr(redact.ipaddress, "IPv6Address", checked)
    text = redact.redact("peer ::ffff:999.999.999.999" + "." * 1000)
    assert "::ffff" not in text and "<ip>" in text
    assert len(seen) <= 45 and all(len(value) <= 45 for value in seen)


def test_redact_strips_pii():
    s = redact.redact('arn:aws:iam::123456789012:role/x user a@b.io ip 10.0.0.1 AKIAABCDEFGHIJKLMNOP')
    assert 'arn:aws' not in s and '123456789012' not in s and 'a@b.io' not in s
    assert '10.0.0.1' not in s and 'AKIAABCDEFGHIJKLMNOP' not in s


def test_redact_email_before_account_id_pattern():
    # An email local-part with 12+ digits would be partially clobbered by the acct rule if it ran
    # first — email must be scrubbed before the standalone-12-digit rule sees it.
    s = redact.redact('contact 123456789012345@example.com')
    assert '@' not in s
    assert '<email>' in s


def test_redact_leaves_non_standalone_digit_runs_alone():
    # The 12-digit account-id pattern uses negative lookarounds so it only matches a STANDALONE
    # run, not a slice of a longer (or shorter) number.
    s = redact.redact('code 1234567890123 short 12345')
    assert '<acct>' not in s
    assert '1234567890123' in s
    assert '12345' in s


@pytest.mark.parametrize('address', [
    'fd00:1234::7', '2001:db8:1234:5678:abcd:ef01:2345:6789',
    '::1', '::', '::ffff:192.0.2.7', 'fe80::1%eth0',
])
def test_redact_valid_ipv6_in_source_strings(address):
    assert redact.redact('answer "' + address + '"') == 'answer "<ip>"'
    assert redact.redact('peer ' + address + '.') == 'peer <ip>.'
    assert redact.redact('peer ' + address + ': down') == 'peer <ip>: down'


@pytest.mark.parametrize('partition', ['aws-cn', 'aws-us-gov', 'aws-iso', 'aws-iso-b', 'aws-iso-f', 'aws-eusc'])
def test_redact_noncommercial_arn(partition):
    assert redact.redact(f'arn:{partition}:rds:region:123456789012:db:orders') == '<arn>'


def test_ipv6_redaction_preserves_timestamps_units_and_opaque_identifiers():
    text = '2026-11-05T12:00:00+00:00 12:00:00 e:abc123 r:123abc Count/Second bad:de:ad'
    assert redact.redact(text) == text


def test_redact_dns_answer_ip_lists_including_ipv6():
    s = redact.redact('answer_ips ["2001:db8::7", "fd00:1234::7", "192.0.2.9", "::ffff:192.0.2.7"]')
    assert s == 'answer_ips ["<ip>", "<ip>", "<ip>", "<ip>"]'


def test_redact_region_qualified_aws_endpoints_but_keeps_service_principals():
    s = redact.redact('db orders.cluster-abc123.ap-northeast-2.rds.amazonaws.com lb a-1.us-east-1.elb.amazonaws.com '
                      'via ec2.amazonaws.com')
    assert s == 'db <host> lb <host> via ec2.amazonaws.com'


def test_regional_service_endpoints_stay_visible_but_resource_endpoints_are_masked():
    kept = ['Could not connect to the endpoint URL: "https://sts.ap-northeast-2.amazonaws.com/"',
            "bedrock-runtime.us-east-1.amazonaws.com", "s3.ap-northeast-2.amazonaws.com", "ec2.amazonaws.com"]
    for text in kept:
        assert redact.redact(text) == text
    for host in ("mybucket.s3.ap-northeast-2.amazonaws.com", "mybucket.s3-us-west-2.amazonaws.com",
                 "abc123.execute-api.ap-northeast-2.amazonaws.com",
                 "vpce-0a1b.sts.ap-northeast-2.vpce.amazonaws.com",
                 "ec2-54-1-2-3.ap-northeast-2.compute.amazonaws.com"):
        assert redact.redact(f"via {host} failed") == "via <host> failed"


def test_ipv6_scan_is_linear_on_long_punctuation_runs():
    import time
    for blob in (":" * 20000, ".:" * 10000, "::" + "0:" * 10000 + "g", "a:" * 10000 + "::"):
        started = time.monotonic()
        redact.redact(blob)
        assert time.monotonic() - started < 1.0
    assert redact.redact(":" * 50 + " peer 2001:db8::1. done").endswith(" peer <ip>. done")
    assert redact.redact("fe80::1%eth0, ::ffff:10.0.0.1:") == "<ip>, <ip>:"
