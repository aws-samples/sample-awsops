"""DNS-free deploys need public, matching certificates and zero DNS mutations."""
import importlib.util
import json
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from datetime import datetime, timezone


SCRIPT = Path(__file__).with_name("ci_dns_policy.py")
ACCOUNT = "123456789012"
ARN = f"arn:aws:acm:us-east-1:{ACCOUNT}:certificate/11111111-2222-3333-4444-555555555555"
NOW = datetime(2026, 9, 12, tzinfo=timezone.utc)
CERTIFICATE = {
    "CertificateArn": ARN, "Status": "ISSUED", "Type": "AMAZON_ISSUED",
    "KeyAlgorithm": "RSA_2048", "SubjectAlternativeNames": ["*.example.com"],
    "NotBefore": "2026-01-01T00:00:00+00:00",
    "NotAfter": "2027-01-01T00:00:00+00:00",
}


class DnsPolicyTests(unittest.TestCase):
    def module(self):
        self.assertTrue(SCRIPT.is_file(), "DNS policy implementation is missing")
        spec = importlib.util.spec_from_file_location("ci_dns_policy", SCRIPT)
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        return module

    def check_plan(self, changes, allow=False):
        plan = {
            "format_version": "1.2", "planned_values": {},
            "resource_changes": changes,
        }
        return subprocess.run(
            [sys.executable, str(SCRIPT), "check-plan", "--allow-dns", str(allow).lower()],
            input=json.dumps(plan), text=True, capture_output=True,
        )

    def test_all_dns_writes_are_blocked_including_deletion(self):
        for actions in (["create"], ["update"], ["delete"], ["delete", "create"]):
            with self.subTest(actions=actions):
                result = self.check_plan([{
                    "address": "aws_route53_record.validation",
                    "type": "aws_route53_record", "change": {"actions": actions},
                }])
                self.assertNotEqual(result.returncode, 0)
                self.assertIn("DNS change", result.stderr)

    def test_reads_and_non_dns_bootstrap_are_allowed(self):
        result = self.check_plan([
            {"address": "data.aws_route53_zone.main", "type": "aws_route53_zone",
             "change": {"actions": ["read"]}},
            {"address": "aws_route53_record.old", "type": "aws_route53_record",
             "change": {"actions": ["no-op"]}},
            {"address": "aws_ecr_repository.web", "type": "aws_ecr_repository",
             "change": {"actions": ["create"]}},
        ])
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(json.loads(result.stdout)["dns_changes"], [])

    def test_domain_registration_and_discovery_namespaces_are_dns_changes(self):
        for resource_type in ("aws_route53domains_registered_domain", "aws_service_discovery_private_dns_namespace",
                              "aws_service_discovery_public_dns_namespace"):
            with self.subTest(resource_type=resource_type):
                result = self.check_plan([{
                    "address": resource_type + ".main", "type": resource_type,
                    "change": {"actions": ["create"]},
                }])
                self.assertNotEqual(result.returncode, 0)
                self.assertIn("DNS change", result.stderr)

    def test_dns_requires_explicit_permission_and_valid_plan_data(self):
        change = {"address": "aws_route53_record.service", "type": "aws_route53_record",
                  "change": {"actions": ["create"]}}
        self.assertEqual(self.check_plan([change], allow=True).returncode, 0)
        result = subprocess.run(
            [sys.executable, str(SCRIPT), "check-plan", "--allow-dns", "false"],
            input="{}", text=True, capture_output=True,
        )
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("plan", result.stderr)

    def test_wildcard_matches_only_one_label(self):
        match = self.module().domain_matches
        self.assertTrue(match("*.example.com", "dev.example.com"))
        self.assertTrue(match("DEV.example.com.", "dev.example.com"))
        self.assertFalse(match("*.example.com", "example.com"))
        self.assertFalse(match("*.example.com", "nested.dev.example.com"))
        self.assertFalse(match("*.example.com", "dev.evil-example.com"))

    def test_certificate_must_cover_all_hosts_and_match_account_region(self):
        eligible = self.module().eligible_certificate
        self.assertTrue(eligible(CERTIFICATE, ["dev.example.com"], "us-east-1", ACCOUNT, NOW))
        self.assertFalse(eligible(CERTIFICATE, ["dev.example.com", "other.invalid"], "us-east-1", ACCOUNT, NOW))
        self.assertFalse(eligible(CERTIFICATE, ["dev.example.com"], "ap-northeast-2", ACCOUNT, NOW))
        self.assertFalse(eligible(CERTIFICATE, ["dev.example.com"], "us-east-1", "999999999999", NOW))

    def test_pending_expired_private_or_missing_validity_cannot_be_reused(self):
        eligible = self.module().eligible_certificate
        cases = [
            {"Status": "PENDING_VALIDATION"},
            {"NotAfter": "2026-09-01T00:00:00+00:00"},
            {"NotBefore": "2027-01-01T00:00:00+00:00"},
            {"NotAfter": None}, {"Type": "PRIVATE"},
            {"CertificateAuthorityArn": "arn:aws:acm-pca:us-east-1:123456789012:certificate-authority/test"},
            {"KeyAlgorithm": "RSA_1024"},
        ]
        for override in cases:
            with self.subTest(override=override):
                self.assertFalse(eligible(
                    {**CERTIFICATE, **override}, ["dev.example.com"], "us-east-1", ACCOUNT, NOW,
                ))

    def test_self_signed_chain_is_not_treated_as_a_public_origin_certificate(self):
        module = self.module()
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            certificate, key = root / "cert.pem", root / "key.pem"
            subprocess.run(
                ["openssl", "req", "-x509", "-newkey", "rsa:2048", "-nodes",
                 "-keyout", str(key), "-out", str(certificate), "-days", "1",
                 "-subj", "/CN=dev.example.com", "-addext", "subjectAltName=DNS:dev.example.com"],
                check=True, capture_output=True, timeout=15,
            )
            self.assertFalse(module.verify_chain(certificate.read_text(), "", ["dev.example.com"]))


if __name__ == "__main__":
    unittest.main()
