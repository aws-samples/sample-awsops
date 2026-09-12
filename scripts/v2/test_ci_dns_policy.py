"""DNS-free deploys need public, matching certificates and zero DNS mutations."""
import importlib.util
import json
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch
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

    def test_owned_validation_cnames_cannot_be_retired_even_with_dns_permission(self):
        for allow in (False, True):
            for actions in (["delete"], ["delete", "create"], ["create", "delete"]):
                for prefix in ("", "module.edge."):
                    with self.subTest(allow=allow, actions=actions, prefix=prefix):
                        result = self.check_plan([{
                            "address": prefix + 'aws_route53_record.cf_validation["extra.example.com"]',
                            "type": "aws_route53_record", "change": {"actions": actions},
                        }], allow=allow)
                        self.assertNotEqual(result.returncode, 0)
                        self.assertIn("separately reviewed", result.stderr)

    def test_dns_authorized_alias_updates_and_validation_creation_remain_valid(self):
        for name, actions in (("alias", ["update"]), ("cf_validation", ["create"]),
                              ("cf_validation", ["no-op"])):
            result = self.check_plan([{
                "address": f'aws_route53_record.{name}["dev.example.com"]',
                "type": "aws_route53_record", "change": {"actions": actions},
            }], allow=True)
            self.assertEqual(result.returncode, 0, result.stderr)

    def test_plan_rejects_managed_certificate_retirement_but_allows_rotation(self):
        for name in ("cf", "alb"):
            for allow in (False, True):
                result = self.check_plan([{
                    "address": f"aws_acm_certificate.{name}[0]", "type": "aws_acm_certificate",
                    "change": {"actions": ["delete"]},
                }], allow=allow)
                self.assertNotEqual(result.returncode, 0)
                self.assertIn("ownership migration", result.stderr)
            for actions in (["create"], ["no-op"], ["update"], ["create", "delete"], ["delete", "create"]):
                result = self.check_plan([{
                    "address": f"aws_acm_certificate.{name}[0]", "type": "aws_acm_certificate",
                    "change": {"actions": actions},
                }], allow=True)
                self.assertEqual(result.returncode, 0, result.stderr)

    def test_bad_plan_resources_produce_friendly_refusal(self):
        valid = {"address": "aws_ecr_repository.web", "type": "aws_ecr_repository",
                 "change": {"actions": ["create"]}}
        for resource in (None, [], {**valid, "type": 7}, {**valid, "address": None},
                         {**valid, "change": []}, {**valid, "change": {"actions": [None]}}):
            result = self.check_plan([resource])
            self.assertNotEqual(result.returncode, 0)
            self.assertIn("Deployment preflight refused: invalid Terraform plan", result.stderr)
            self.assertNotIn("Traceback", result.stderr)

    def test_domain_registration_and_discovery_namespaces_are_dns_changes(self):
        for resource_type in ("aws_route53domains_registered_domain", "aws_service_discovery_private_dns_namespace",
                              "aws_service_discovery_public_dns_namespace", "aws_service_discovery_service",
                              "aws_service_discovery_http_namespace", "aws_service_discovery_instance"):
            with self.subTest(resource_type=resource_type):
                result = self.check_plan([{
                    "address": resource_type + ".main", "type": resource_type,
                    "change": {"actions": ["create"]},
                }])
                self.assertNotEqual(result.returncode, 0)
                self.assertIn("DNS change", result.stderr)

    def ecs_change(self, actions, before, after, after_unknown=None):
        return {
            "address": "aws_ecs_service.steampipe[0]", "type": "aws_ecs_service",
            "change": {"actions": actions, "before": before, "after": after,
                       "after_unknown": {} if after_unknown is None else after_unknown},
        }

    def test_registered_ecs_mutations_require_dns_permission(self):
        registered = {"service_registries": [{"registry_arn": "arn:aws:servicediscovery:"
                       "ap-northeast-2:123456789012:service/srv-example"}], "desired_count": 1}
        empty = {"service_registries": []}
        cases = [
            (["create"], None, registered),
            (["delete"], registered, None),
            (["update"], registered, {**registered, "desired_count": 2}),
            (["update"], registered, {**registered, "tags": {"Purpose": "fixture"}}),
            (["update"], registered, empty),
            (["update"], empty, registered),
            (["delete", "create"], registered, registered),
            (["create", "delete"], registered, registered),
        ]
        for actions, before, after in cases:
            with self.subTest(actions=actions, before=before, after=after):
                change = self.ecs_change(actions, before, after)
                denied = self.check_plan([change])
                self.assertNotEqual(denied.returncode, 0)
                self.assertIn("DNS change", denied.stderr)
                self.assertIn(change["address"], denied.stderr)
                allowed = self.check_plan([change], allow=True)
                self.assertEqual(allowed.returncode, 0, allowed.stderr)
                self.assertEqual(json.loads(allowed.stdout)["dns_changes"], [change["address"]])

    def test_ecs_unknown_registry_values_fail_closed(self):
        for unknown in (True, None, [], "unknown",
                        {"service_registries": True},
                        {"service_registries": [{"registry_arn": True}]},
                        {"service_registries": {"registry_arn": True}},
                        {"service_registries": None}, {"service_registries": 0}):
            with self.subTest(unknown=unknown):
                change = self.ecs_change(["update"], {"service_registries": []}, {})
                change["change"]["after_unknown"] = unknown
                result = self.check_plan([change])
                self.assertNotEqual(result.returncode, 0)
                self.assertIn("DNS change", result.stderr)

    def test_ecs_malformed_registry_shapes_fail_closed(self):
        for field in ("before", "after"):
            for value in ([], False, "invalid", {"service_registries": {}},
                          {"service_registries": ""}, {"service_registries": False}):
                with self.subTest(field=field, value=value):
                    change = self.ecs_change(["update"], {"service_registries": []},
                                             {"service_registries": []})
                    change["change"][field] = value
                    result = self.check_plan([change])
                    self.assertNotEqual(result.returncode, 0)
                    self.assertIn("DNS change", result.stderr)

    def test_ecs_empty_registry_mutations_are_allowed(self):
        for empty in ({}, {"service_registries": []}, {"service_registries": None}):
            for actions, before, after in ((["create"], None, empty), (["update"], empty, empty),
                                           (["delete"], empty, None), (["delete", "create"], empty, empty)):
                for unknown in ({}, {"task_definition": True}, {"service_registries": False},
                                {"service_registries": []}, {"service_registries": {}}):
                    with self.subTest(empty=empty, actions=actions, unknown=unknown):
                        result = self.check_plan([self.ecs_change(actions, before, after, unknown)])
                        self.assertEqual(result.returncode, 0, result.stderr)
                        self.assertEqual(json.loads(result.stdout), {"changed_resources": 1, "dns_changes": []})

    def test_registered_ecs_reads_and_noops_are_allowed(self):
        registered = {"service_registries": [{"registry_arn": "fixture"}]}
        for actions in (["no-op"], ["read"]):
            with self.subTest(actions=actions):
                result = self.check_plan([self.ecs_change(actions, registered, registered)])
                self.assertEqual(result.returncode, 0, result.stderr)
                self.assertEqual(json.loads(result.stdout), {"changed_resources": 0, "dns_changes": []})

    def test_supported_large_rsa_and_ec_keys(self):
        module = self.module()
        for key in ("RSA_2048", "RSA_3072", "RSA_4096", "EC_prime256v1", "EC_secp384r1"):
            with self.subTest(key=key):
                self.assertTrue(module.eligible_certificate(
                    {**CERTIFICATE, "KeyAlgorithm": key}, ["dev.example.com"], "us-east-1", ACCOUNT, NOW,
                ))

    def test_ecr_scope_rejects_any_other_mutation(self):
        module = self.module()
        plan = {"format_version": "1.2", "planned_values": {}, "resource_changes": [{
            "address": "aws_ecs_service.web", "type": "aws_ecs_service",
            "change": {"actions": ["update"]},
        }]}
        with self.assertRaisesRegex(ValueError, "ECR bootstrap"):
            module.check_plan(plan, False, "ecr-bootstrap")

    def state(self, resources):
        return {"format_version": "1.0", "values": {"root_module": {"resources": resources}}}

    def resource(self, address, **values):
        kind, name = address.split(".", 1)
        return {"address": address, "mode": "managed", "type": kind,
                "name": name.split("[")[0], "values": values}

    def configuration(self, **changes):
        return {"domain": "dev.example.com", "aliases": [], "region": "ap-northeast-2",
                "cf_arn": None, "alb_arn": None, **changes}

    def test_state_managed_certificates_and_live_aliases_preserve_ownership(self):
        module = self.module()
        alb = ARN.replace("us-east-1", "ap-northeast-2")
        for suffix in ("", "[0]"):
            with self.subTest(suffix=suffix):
                state = self.state([
                    self.resource("aws_acm_certificate.cf" + suffix, arn=ARN),
                    self.resource("aws_acm_certificate.alb" + suffix, arn=alb),
                    self.resource('aws_route53_record.alias["dev.example.com"]', name="dev.example.com"),
                ])
                with patch.object(module, "find_certificate", side_effect=lambda *a, **kw: kw.get("explicit_arn", a[3] if len(a) > 3 else "")):
                    result = module.certificate_overrides(self.configuration(), state, ACCOUNT, False)
                self.assertEqual(result, {"existing_cf_certificate_arn": None,
                                          "existing_alb_certificate_arn": None,
                                          "publish_service_dns": True})
                self.assertIsNone(json.loads(json.dumps(result))["existing_cf_certificate_arn"])

    def test_explicit_managed_arn_is_rejected_even_when_dns_allowed(self):
        module = self.module()
        state = self.state([self.resource("aws_acm_certificate.other", arn=ARN)])
        for allow in (False, True):
            with self.subTest(allow=allow), patch.object(module, "find_certificate") as find:
                with self.assertRaisesRegex(ValueError, "managed"):
                    module.certificate_overrides(self.configuration(cf_arn=ARN), state, ACCOUNT, allow)
                find.assert_not_called()

    def test_managed_to_any_external_arn_is_rejected_in_all_modes(self):
        module = self.module()
        for key in ("cf", "alb"):
            region = "us-east-1" if key == "cf" else "ap-northeast-2"
            current = ARN.replace("us-east-1", region)
            external = current.replace("11111111", "77777777")
            state = self.state([self.resource(f"aws_acm_certificate.{key}[0]", arn=current)])
            for allow in (False, True):
                for scope in ("full", "ecr-bootstrap"):
                    with self.subTest(key=key, allow=allow, scope=scope), patch.object(module, "aws") as aws:
                        with self.assertRaisesRegex(ValueError, "ownership migration"):
                            module.certificate_overrides(
                                self.configuration(**{key + "_arn": external}), state, ACCOUNT,
                                allow, scope=scope,
                            )
                        aws.assert_not_called()

    def test_fresh_dns_authorized_stack_retains_managed_defaults(self):
        module = self.module()
        with patch.object(module, "aws") as aws:
            self.assertEqual(
                module.certificate_overrides(self.configuration(), self.state([]), ACCOUNT, True),
                {"publish_service_dns": True, "existing_cf_certificate_arn": None,
                 "existing_alb_certificate_arn": None},
            )
            aws.assert_not_called()

    def test_selection_excludes_managed_certificates_in_child_modules(self):
        module = self.module()
        other = ARN.replace("11111111", "99999999")
        state = self.state([])
        state["values"]["root_module"]["child_modules"] = [{
            "resources": [self.resource("aws_acm_certificate.other", arn=other)],
        }]
        with patch.object(module, "find_certificate", return_value=ARN) as find:
            result = module.certificate_overrides(self.configuration(), state, ACCOUNT, False)
        self.assertFalse(result["publish_service_dns"])
        self.assertEqual(find.call_args_list[0].kwargs["excluded"], {other})

    def test_attached_external_certificates_are_reused_in_all_modes(self):
        module = self.module()
        alb = ARN.replace("us-east-1", "ap-northeast-2")
        state = self.state([
            self.resource("aws_cloudfront_distribution.main", viewer_certificate=[{"acm_certificate_arn": ARN}]),
            self.resource("aws_lb_listener.https", certificate_arn=alb),
        ])
        for allow in (False, True):
            for scope in ("full", "ecr-bootstrap"):
                with patch.object(module, "find_certificate", side_effect=[ARN, alb]) as find:
                    result = module.certificate_overrides(self.configuration(), state, ACCOUNT, allow, scope=scope)
                self.assertEqual(find.call_args_list[0].kwargs["preferred_arn"], ARN)
                self.assertEqual(find.call_args_list[1].kwargs["preferred_arn"], alb)
                self.assertEqual(result["existing_alb_certificate_arn"], alb)
                self.assertEqual(result["publish_service_dns"], allow)

    def test_missing_or_invalid_state_and_aliases_fail_closed(self):
        module = self.module()
        for state in ({}, {"format_version": "1.0", "values": None}):
            with self.subTest(state=state), self.assertRaisesRegex(ValueError, "state"):
                module.certificate_overrides(self.configuration(), state, ACCOUNT, False)
        with self.assertRaisesRegex(ValueError, "aliases"):
            module.certificate_overrides(self.configuration(aliases=None), self.state([]), ACCOUNT, False)

    def test_fresh_bootstrap_does_not_require_certificates_but_validates_explicit_arns(self):
        module = self.module()
        with patch.object(module, "find_certificate", return_value=ARN) as find:
            result = module.certificate_overrides(self.configuration(), {"format_version": "1.0"},
                                                  ACCOUNT, False, scope="ecr-bootstrap")
            find.assert_not_called()
            self.assertIsNone(result["existing_cf_certificate_arn"])
            module.certificate_overrides(self.configuration(cf_arn=ARN), self.state([]),
                                         ACCOUNT, True, scope="ecr-bootstrap")
            find.assert_called_once()

    def test_selection_does_not_describe_excluded_or_rotate_valid_attached_certificate(self):
        module = self.module()
        attached = ARN.replace("11111111", "88888888")
        def aws(*args):
            if args[:2] == ("acm", "describe-certificate"):
                self.assertEqual(args[-1], attached)
                return {"Certificate": {**CERTIFICATE, "CertificateArn": attached,
                                        "NotAfter": "2099-01-01T00:00:00+00:00"}}
            if args[:2] == ("acm", "get-certificate"):
                return {"Certificate": "public certificate"}
            self.fail("Valid attached certificate must bypass account discovery")
        with patch.object(module, "aws", side_effect=aws), patch.object(module, "verify_chain", return_value=True):
            self.assertEqual(module.find_certificate(
                ["dev.example.com"], "us-east-1", ACCOUNT, excluded={ARN}, preferred_arn=attached,
            ), attached)

    def test_missing_selection_never_scans_account(self):
        module = self.module()
        with patch.object(module, "aws") as aws:
            with self.assertRaisesRegex(ValueError, "explicit.*ARN"):
                module.find_certificate(["dev.example.com"], "us-east-1", ACCOUNT)
            aws.assert_not_called()

    def test_invalid_attached_certificate_does_not_fall_back_to_discovery(self):
        module = self.module()
        with patch.object(module, "aws", return_value={"Certificate": {
            **CERTIFICATE, "Status": "EXPIRED",
        }}) as aws:
            with self.assertRaisesRegex(ValueError, "certificate"):
                module.find_certificate(["dev.example.com"], "us-east-1", ACCOUNT, preferred_arn=ARN)
            self.assertEqual(aws.call_count, 1)
            self.assertEqual(aws.call_args.args[:2], ("acm", "describe-certificate"))

    def test_invalid_explicit_arn_is_rejected_before_aws(self):
        module = self.module()
        for arn in ("garbage", "$(printf injected)", ARN.replace(ACCOUNT, "999999999999"),
                    ARN.replace("us-east-1", "ap-northeast-2"), ARN.replace("11111111-", "111111111")):
            with self.subTest(arn=arn), patch.object(module, "aws") as aws:
                with self.assertRaisesRegex(ValueError, "ARN"):
                    module.find_certificate(["dev.example.com"], "us-east-1", ACCOUNT, arn)
                aws.assert_not_called()

    def test_null_certificate_chain_is_normalized(self):
        module = self.module()
        with patch.object(module, "aws", side_effect=[
            {"Certificate": {**CERTIFICATE, "NotAfter": "2099-01-01T00:00:00+00:00"}},
            {"Certificate": "leaf", "CertificateChain": None},
        ]), patch.object(module, "verify_chain", return_value=True) as verify:
            self.assertEqual(module.find_certificate(["dev.example.com"], "us-east-1", ACCOUNT, ARN), ARN)
            verify.assert_called_once_with("leaf", "", ["dev.example.com"])

    def test_unavailable_managed_certificate_does_not_fall_back_to_externalization(self):
        module = self.module()
        state = self.state([self.resource("aws_acm_certificate.cf[0]", arn=ARN)])
        with patch.object(module, "find_certificate", side_effect=ValueError("unavailable")) as find:
            with self.assertRaisesRegex(ValueError, "unavailable"):
                module.certificate_overrides(self.configuration(), state, ACCOUNT, False)
            self.assertEqual(find.call_count, 1)

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
            {"NotAfter": "2026-09-13T00:00:00+00:00"},  # insufficient rollout/renewal headroom
            {"NotBefore": "2027-01-01T00:00:00+00:00"},
            {"NotAfter": None}, {"Type": "PRIVATE"},
            {"CertificateAuthorityArn": "arn:aws:acm-pca:us-east-1:123456789012:certificate-authority/test"},
            {"KeyAlgorithm": "RSA_1024"},
            {"KeyAlgorithm": "EC_secp521r1"}, {"KeyAlgorithm": "RSA-2048"},
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
