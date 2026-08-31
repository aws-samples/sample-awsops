import redact


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
