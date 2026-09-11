"""The operator access plan must not leave a self-service PR identity trusted."""
import copy
import json
from pathlib import Path
import subprocess
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[2]
PROVIDER = "arn:aws:iam::000000000000:oidc-provider/token.actions.githubusercontent.com"
TRUST = {"Version": "2012-10-17", "Statement": [{
    "Effect": "Allow", "Principal": {"Federated": PROVIDER},
    "Action": "sts:AssumeRoleWithWebIdentity",
    "Condition": {
        "StringEquals": {"token.actions.githubusercontent.com:aud": "sts.amazonaws.com"},
        "StringLike": {"token.actions.githubusercontent.com:sub": "repo:example*/repo*:*"},
    },
}]}
OIDC = {"use_default": True, "use_immutable_subject": True,
        "sub_claim_prefix": "repo:example@10/repo@20"}


class ReviewAccessPlanTests(unittest.TestCase):
    def plan(self, trust=None, repository="example/repo", reviewer="12", oidc=None):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            source, output, oidc_file = root / "trust.json", root / "plan.json", root / "oidc.json"
            source.write_text(json.dumps(trust if trust is not None else TRUST))
            oidc_file.write_text(json.dumps(oidc if oidc is not None else OIDC))
            result = subprocess.run([
                "python3", str(ROOT / "scripts/v2/ci_review_access.py"),
                "--trust-file", str(source), "--repository", repository,
                "--oidc-config-file", str(oidc_file),
                "--reviewer-id", reviewer, "--recovery-pr", "41", "--output", str(output),
            ], capture_output=True, text=True)
            return result, json.loads(output.read_text()) if output.exists() else None

    def test_only_exact_repository_protected_subjects_are_allowed(self):
        result, plan = self.plan()
        self.assertEqual(result.returncode, 0, result.stderr)
        statements = plan["trust_policy"]["Statement"]
        self.assertEqual(len(statements), 1)
        self.assertEqual(statements[0]["Principal"], {"Federated": PROVIDER})
        self.assertEqual(statements[0]["Condition"]["StringEquals"], {
            "token.actions.githubusercontent.com:aud": "sts.amazonaws.com",
            "token.actions.githubusercontent.com:sub": [
                "repo:example@10/repo@20:ref:refs/heads/dev",
                "repo:example@10/repo@20:ref:refs/heads/main",
                "repo:example@10/repo@20:environment:ci-review-auto",
                "repo:example@10/repo@20:environment:ci-review-recovery",
            ],
        })

    def test_recovery_requires_named_reviewer_and_exact_pr_execution_ref(self):
        result, plan = self.plan()
        self.assertEqual(result.returncode, 0, result.stderr)
        recovery = plan["environments"]["ci-review-recovery"]
        self.assertEqual(recovery["settings"]["reviewers"], [{"type": "User", "id": 12}])
        self.assertIs(recovery["settings"]["can_admins_bypass"], False)
        self.assertEqual(recovery["branch_policies"], [{"name": "refs/pull/41/merge", "type": "branch"}])
        self.assertEqual(plan["environments"]["ci-review-auto"]["branch_policies"],
                         [{"name": "dev", "type": "branch"}, {"name": "main", "type": "branch"}])

    def test_plan_is_idempotent(self):
        first, plan = self.plan()
        self.assertEqual(first.returncode, 0, first.stderr)
        second, replay = self.plan(trust=plan["trust_policy"])
        self.assertEqual(second.returncode, 0, second.stderr)
        self.assertEqual(replay, plan)

    def test_legacy_subject_format_is_preserved_when_repository_uses_it(self):
        result, plan = self.plan(oidc={"use_default": True})
        self.assertEqual(result.returncode, 0, result.stderr)
        subjects = plan["trust_policy"]["Statement"][0]["Condition"]["StringEquals"]["token.actions.githubusercontent.com:sub"]
        self.assertIn("repo:example/repo:environment:ci-review-recovery", subjects)

    def test_unknown_custom_or_foreign_subject_prefix_is_rejected(self):
        for oidc in ({"use_default": False}, {**OIDC, "sub_claim_prefix": "repo:other@10/repo@20"},
                     {**OIDC, "sub_claim_prefix": "repo:example*/repo*"}):
            with self.subTest(oidc=oidc):
                result, plan = self.plan(oidc=oidc)
                self.assertNotEqual(result.returncode, 0)
                self.assertIsNone(plan)
    def test_unknown_trust_relationship_is_not_silently_removed(self):
        trust = copy.deepcopy(TRUST)
        trust["Statement"].append({"Effect": "Allow", "Principal": {"AWS": "other"}, "Action": "sts:AssumeRole"})
        result, plan = self.plan(trust=trust)
        self.assertNotEqual(result.returncode, 0)
        self.assertIsNone(plan)

    def test_additional_existing_restrictions_are_not_silently_dropped(self):
        trust = copy.deepcopy(TRUST)
        trust["Statement"][0]["Condition"]["IpAddress"] = {"aws:SourceIp": "192.0.2.0/24"}
        result, plan = self.plan(trust=trust)
        self.assertNotEqual(result.returncode, 0)
        self.assertIsNone(plan)

    def test_preserves_existing_explicit_denies(self):
        trust = copy.deepcopy(TRUST)
        deny = {"Sid": "ExistingDeny", "Effect": "Deny", "Principal": {"Federated": PROVIDER},
                "Action": "sts:AssumeRoleWithWebIdentity",
                "Condition": {"StringEquals": {"token.actions.githubusercontent.com:sub": "repo:example/repo:blocked"}}}
        trust["Statement"].append(deny)
        result, plan = self.plan(trust=trust)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn(deny, plan["trust_policy"]["Statement"])

    def test_rejects_subject_injection_and_missing_reviewer(self):
        for kwargs in ({"repository": "example/repo:environment:evil"}, {"reviewer": "0"}):
            with self.subTest(kwargs=kwargs):
                result, plan = self.plan(**kwargs)
                self.assertNotEqual(result.returncode, 0)
                self.assertIsNone(plan)


if __name__ == "__main__":
    unittest.main()
