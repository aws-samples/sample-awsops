from rca.anonymize import anonymize, deanonymize

def test_roundtrip_masks_and_restores():
    text = "pod web-7d9f8c6b5-x2k9 on 10.0.3.14 owner ops@corp.io"
    masked, mapping = anonymize(text)
    assert "web-7d9f8c6b5-x2k9" not in masked
    assert "10.0.3.14" not in masked
    assert "ops@corp.io" not in masked
    assert deanonymize(masked, mapping) == text

def test_stable_tokens_same_entity_same_token():
    masked, _ = anonymize("10.0.0.1 and 10.0.0.1")
    assert masked.count(masked.split()[0]) == 2

def test_roundtrip_masks_aws_resource_ids_and_ipv6():
    text = (
        "instance i-0abcd1234efgh5678 subnet subnet-0abc1234def567890 "
        "source 2001:db8:85a3::8a2e:370:7334"
    )

    masked, mapping = anonymize(text)

    assert "i-0abcd1234efgh5678" not in masked
    assert "subnet-0abc1234def567890" not in masked
    assert "2001:db8:85a3::8a2e:370:7334" not in masked
    assert deanonymize(masked, mapping) == text

def test_deanonymize_does_not_replace_short_token_inside_long_token():
    text = "primary ENT_1 secondary ENT_12"
    mapping = {"ENT_1": "i-00000001", "ENT_12": "subnet-00000012"}

    assert deanonymize(text, mapping) == "primary i-00000001 secondary subnet-00000012"
