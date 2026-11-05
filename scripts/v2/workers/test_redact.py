import redact
import pytest


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


@pytest.mark.parametrize('partition', ['aws-cn', 'aws-us-gov'])
def test_redact_noncommercial_arn(partition):
    assert redact.redact(f'arn:{partition}:rds:region:123456789012:db:orders') == '<arn>'


def test_ipv6_redaction_preserves_timestamps_units_and_opaque_identifiers():
    text = '2026-11-05T12:00:00+00:00 12:00:00 e:abc123 r:123abc Count/Second bad:de:ad'
    assert redact.redact(text) == text
