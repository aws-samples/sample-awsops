"""Offline dev rollout boundaries: persistent inputs, public zone and scoped DNS."""
import copy
import importlib.util
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest


SCRIPT = Path(__file__).with_name("ci_dev_domain.py")
DOMAIN = "dev.example.com"
ZONE = {
    "name": "dev.example.com.", "zone_id": "Z123CHILD", "id": "Z123CHILD",
    "private_zone": False,
    "name_servers": ["ns-1.example.net", "ns-2.example.org",
                     "ns-3.example.co.uk", "ns-4.example.com"],
    "unrelated_secret": "MUST-NOT-PRINT",
}


def plan_fixture(changes=()):
    return {
        "format_version": "1.2",
        "variables": {key: {"value": value} for key, value in {
            "domain_name": DOMAIN, "hosted_zone_name": DOMAIN,
            "extra_domain_aliases": ["extra.dev.example.com"],
        }.items()},
        "planned_values": {"root_module": {"resources": [{
            "address": "data.aws_route53_zone.main", "mode": "data",
            "type": "aws_route53_zone", "name": "main", "values": copy.deepcopy(ZONE),
        }]}},
        "resource_changes": list(changes),
        "configuration": {"secret": "MUST-NOT-PRINT"},
    }


def record(kind="alias", host=DOMAIN, **values):
    return {
        "address": f'aws_route53_record.{kind}["{host}"]', "type": "aws_route53_record",
        "change": {"actions": ["create"], "before": None, "after": {
            "zone_id": "Z123CHILD", "name": host, "type": "A", **values,
        }, "after_unknown": {}},
    }


class DevDomainTests(unittest.TestCase):
    def module(self):
        self.assertTrue(SCRIPT.is_file(), "dev domain helper is missing")
        spec = importlib.util.spec_from_file_location("ci_dev_domain", SCRIPT)
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        return module

    def test_only_dev_uses_repo_variables_and_returns_canonical_overrides(self):
        build = self.module().dev_overrides
        self.assertEqual(build("dev", "Dev.Example.COM", "Example.COM", ""), (
            {"domain_name": DOMAIN, "hosted_zone_name": "example.com"}, "preserve",
        ))
        self.assertEqual(build("dev", "", "", "managed"), ({}, "managed"))
        self.assertEqual(build("dev", "", "", ""), ({}, "preserve"))
        for target in ("main", "atomoh", "ssminji", "whchoi", "feature/dev"):
            self.assertEqual(build(target, "invalid\n", "", "invalid"), ({}, "preserve"))

    def test_invalid_names_pairs_mode_and_zone_escape_fail_closed(self):
        build = self.module().dev_overrides
        for domain, zone, mode in [
            (DOMAIN, "", ""), ("", DOMAIN, ""), (DOMAIN, DOMAIN, "auto"),
            ("evilexample.com", "example.com", ""),
            ("dev.example.com", "other.example.com", ""),
        ]:
            with self.subTest(domain=domain, zone=zone, mode=mode), self.assertRaises(ValueError):
                build("dev", domain, zone, mode)
        for bad in ("a..example.com", "-dev.example.com", "dev-.example.com",
                    "dev._example.com", "*.example.com", "https://dev.example.com",
                    "dev.example.com.", "dev.example.com\n", " dev.example.com",
                    "dev.example.com:443", "$(id).example.com", "déV.example.com",
                    "127.0.0.1", "localhost", "x." + "a" * 64 + ".com", "x." * 127 + "com"):
            with self.subTest(bad=bad), self.assertRaises(ValueError):
                build("dev", bad, "example.com", "")

    def test_cli_cleans_stale_override_before_validation_without_touching_tfvars(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            protected = root / "terraform.tfvars"
            protected.write_text('domain_name = "protected.invalid"\n# MUST-NOT-PRINT\n')
            original = protected.read_bytes()
            override = root / "ci-domain.auto.tfvars.json"
            outputs = root / "outputs"
            env = {**os.environ, "TARGET": "dev", "DOMAIN_NAME_DEV": DOMAIN,
                   "HOSTED_ZONE_NAME_DEV": DOMAIN, "CERTIFICATE_MODE_DEV": "managed",
                   "GITHUB_OUTPUT": str(outputs)}
            for target, domain, expected in (("dev", DOMAIN, 0), ("main", "invalid", 0),
                                              ("dev", "invalid", 1)):
                override.write_text('{"stale": true}')
                result = subprocess.run(
                    [sys.executable, str(SCRIPT), "overrides"], cwd=root,
                    env={**env, "TARGET": target, "DOMAIN_NAME_DEV": domain},
                    capture_output=True, text=True,
                )
                self.assertEqual(result.returncode, expected, result.stderr)
                self.assertEqual(protected.read_bytes(), original)
                self.assertNotIn("MUST-NOT-PRINT", result.stdout + result.stderr)
                if expected:
                    self.assertFalse(override.exists())
                else:
                    self.assertEqual(json.loads(override.read_text()), (
                        {"domain_name": DOMAIN, "hosted_zone_name": DOMAIN} if target == "dev" else {}
                    ))
            self.assertIn("certificate_mode=managed", outputs.read_text())
            self.assertIn("rollout=true", outputs.read_text())

    def test_public_zone_summary_selects_only_expected_data_source(self):
        summary = self.module().zone_summary(plan_fixture())
        self.assertEqual(summary, {"name": DOMAIN, "zone_id": "Z123CHILD",
                                   "name_servers": sorted(ZONE["name_servers"])})
        self.assertNotIn("MUST-NOT-PRINT", json.dumps(summary))

    def test_plan_time_data_source_is_read_from_refreshed_prior_state(self):
        # Terraform omits already-read data sources from planned_values, even
        # when a newly created resource references them.
        for changes in ([], [record()]):
            plan = plan_fixture(changes)
            data = plan["planned_values"]["root_module"]["resources"].pop()
            plan["prior_state"] = {"values": {"root_module": {"resources": [data]}}}
            with self.subTest(changes=changes):
                result = self.module().check_scoped_dns(plan, changes)
                self.assertEqual(result["zone_id"], "Z123CHILD")
                self.assertEqual(result["name_servers"], sorted(ZONE["name_servers"]))
                self.assertNotIn("MUST-NOT-PRINT", json.dumps(result))

    def test_prior_state_does_not_bypass_deferred_or_invalid_selected_zone(self):
        for mutation in ("deferred", "wrong-prior", "duplicate-prior", "invalid-planned"):
            plan = plan_fixture()
            data = plan["planned_values"]["root_module"]["resources"].pop()
            plan["prior_state"] = {"values": {"root_module": {"resources": [data]}}}
            if mutation == "deferred":
                plan["resource_changes"] = [{
                    "address": "data.aws_route53_zone.main", "mode": "data",
                    "type": "aws_route53_zone",
                    "change": {"actions": ["read"], "after_unknown": True},
                }]
            elif mutation == "wrong-prior":
                data["values"]["name"] = "other.example.com"
            elif mutation == "duplicate-prior":
                plan["prior_state"]["values"]["root_module"]["resources"].append(copy.deepcopy(data))
            else:
                planned = copy.deepcopy(data)
                planned["values"]["private_zone"] = True
                plan["planned_values"]["root_module"]["resources"].append(planned)
            with self.subTest(mutation=mutation), self.assertRaises(ValueError):
                self.module().zone_summary(plan)

    def test_missing_ambiguous_private_unknown_or_wrong_zone_is_rejected(self):
        for mutation in ("missing", "duplicate", "private", "name", "zone_id",
                         "name_servers", "unknown", "aliases", "domain", "id"):
            plan = plan_fixture()
            resources = plan["planned_values"]["root_module"]["resources"]
            values = resources[0]["values"]
            if mutation == "missing":
                resources.clear()
            elif mutation == "duplicate":
                resources.append(copy.deepcopy(resources[0]))
            elif mutation == "private":
                values["private_zone"] = True
            elif mutation == "name":
                values["name"] = "example.com."
            elif mutation == "zone_id":
                values["zone_id"] = "ZBAD\nINJECTION"
            elif mutation == "name_servers":
                values["name_servers"] = []
            elif mutation == "unknown":
                values.pop("zone_id")
            elif mutation == "aliases":
                plan["variables"]["extra_domain_aliases"]["value"] = ["old.example.net"]
            elif mutation == "domain":
                plan["variables"]["domain_name"]["value"] = "bad..dev.example.com"
            else:
                values["id"] = "ZOTHER"
            with self.subTest(mutation=mutation), self.assertRaises(ValueError):
                self.module().zone_summary(plan)

    def test_scoped_plan_allows_only_selected_service_and_validation_records(self):
        validate = self.module().check_scoped_dns
        for change in (
            record(), record(host="extra.dev.example.com"),
            record("cf_validation", name="_token.dev.example.com.", type="CNAME",
                   records=["_value.acm-validations.aws."]),
        ):
            validate(plan_fixture([change]), [change])
        # First ACM issuance has unknown token/type/value, but a known domain key
        # and selected public zone. The existing TF ACM resource supplies the token.
        change = record("cf_validation")
        change["change"]["after"] = {"zone_id": "Z123CHILD"}
        change["change"]["after_unknown"] = {"name": True, "type": True, "records": True}
        validate(plan_fixture([change]), [change])
        change["change"]["after"]["records"] = [None]
        change["change"]["after_unknown"]["records"] = [True]
        validate(plan_fixture([change]), [change])
        change = record("cf_validation", name="_token.dev.example.com.", type="CNAME",
                        records=["_value.segment.acm-validations.aws."])
        validate(plan_fixture([change]), [change])
        change = record(host="EXTRA.dev.example.com", name="EXTRA.DEV.EXAMPLE.COM.")
        validate(plan_fixture([change]), [change])

    def test_scoped_permission_rejects_parent_unrelated_records_and_cloudmap(self):
        changes = [
            record(zone_id="ZPARENT"), record(host="old.example.net"),
            record(name="old.example.net"), record(type="NS"),
            record("delegation", type="NS"), record("cf_validation", type="TXT"),
            record("cf_validation", name="_token.old.example.net", type="CNAME"),
            record("cf_validation", name="_token.dev.example.com", type="CNAME",
                   records=["unrelated.example.net"]),
            {"address": "aws_route53_zone.parent", "type": "aws_route53_zone",
             "change": {"actions": ["update"]}},
            {"address": "aws_service_discovery_service.main", "type": "aws_service_discovery_service",
             "change": {"actions": ["create"]}},
            {"address": "aws_ecs_service.registered", "type": "aws_ecs_service",
             "change": {"actions": ["update"]}},
        ]
        for change in changes:
            with self.subTest(change=change), self.assertRaises(ValueError):
                self.module().check_scoped_dns(plan_fixture([change]), [change])

    def test_scoped_updates_check_before_and_unknown_names_cannot_hide_old_records(self):
        for side, field, value in (
            ("before", "zone_id", "ZPARENT"), ("before", "name", "old.example.net"),
            ("after", "zone_id", None), ("after", "name", None),
        ):
            change = record()
            change["change"]["actions"] = ["update"]
            change["change"]["before"] = dict(change["change"]["after"])
            change["change"][side][field] = value
            with self.subTest(side=side, field=field), self.assertRaises(ValueError):
                self.module().check_scoped_dns(plan_fixture([change]), [change])


if __name__ == "__main__":
    unittest.main()
