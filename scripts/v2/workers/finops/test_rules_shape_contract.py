"""Guards against the exact class of bug a PR review caught in rules.py: hand-guessed Compute
Optimizer response shapes that silently match zero rows forever, because the hand-written
FakeCOPaged test fixtures are drawn from the same (possibly wrong) assumption as the code under
test and so can never catch it. This module asserts every field name / enum value rules.py reads
against botocore's OWN service model — an independent source of truth neither rules.py nor
test_rules.py's fixtures can drift out of sync with silently."""
import botocore.session
import pytest

try:
    _CO = botocore.session.get_session().get_service_model("compute-optimizer")
except Exception as e:  # pragma: no cover - environment without botocore data files
    _CO = None
    _SKIP_REASON = str(e)


pytestmark = pytest.mark.skipif(_CO is None, reason=locals().get("_SKIP_REASON", ""))


def _members(shape_name):
    return set(_CO.shape_for(shape_name).members.keys())


def test_ec2_finding_enum_matches_what_rules_py_filters_on():
    assert set(_CO.shape_for("Finding").enum) == {
        "Underprovisioned", "Overprovisioned", "Optimized", "NotOptimized",
    }


def test_ec2_instance_recommendation_has_the_fields_rules_py_reads():
    fields = _members("InstanceRecommendation")
    for f in ("instanceArn", "currentInstanceType", "finding", "instanceName", "tags",
              "lookBackPeriodInDays", "recommendationOptions"):
        assert f in fields


def test_ec2_recommendation_option_savings_is_nested_under_savings_opportunity():
    list_shape = _CO.shape_for("RecommendationOptions")
    opt_fields = _members(list_shape.member.name)
    assert "savingsOpportunity" in opt_fields
    assert "estimatedMonthlySavings" not in opt_fields  # NOT a top-level field on the option
    savings_fields = _members("EstimatedMonthlySavings")
    assert "value" in savings_fields


def test_ec2_recommendation_option_also_carries_an_after_discounts_savings_field():
    # rules.py's _preferred_savings() prefers this over the on-demand-basis savingsOpportunity
    # when Compute Optimizer provides it (a review round caught the on-demand figure overstating
    # savings for an RI/Savings-Plans-covered fleet).
    list_shape = _CO.shape_for("RecommendationOptions")
    opt_fields = _members(list_shape.member.name)
    assert "savingsOpportunityAfterDiscounts" in opt_fields


def test_rds_finding_enum_matches_what_rules_py_filters_on():
    assert set(_CO.shape_for("RDSInstanceFinding").enum) == {
        "Optimized", "Underprovisioned", "Overprovisioned",
    }


def test_rds_recommendation_shape_is_not_the_ec2_shape():
    op = _CO.operation_model("GetRDSDatabaseRecommendations")
    assert "rdsDBRecommendations" in op.output_shape.members
    assert "rdsDatabaseRecommendations" not in op.output_shape.members  # the wrong guess this fixes

    rec_fields = _members("RDSDBRecommendation")
    for f in ("resourceArn", "currentDBInstanceClass", "engine", "instanceFinding",
              "instanceRecommendationOptions", "lookbackPeriodInDays", "tags"):
        assert f in rec_fields
    assert "recommendationOptions" not in rec_fields  # the wrong (EC2-shaped) guess this fixes


def test_rds_recommendation_option_savings_is_also_nested():
    rec = _CO.shape_for("RDSDBRecommendation")
    opt_shape_name = rec.members["instanceRecommendationOptions"].member.name
    opt_fields = _members(opt_shape_name)
    assert "savingsOpportunity" in opt_fields
    assert "dbInstanceClass" in opt_fields


def test_rds_recommendation_option_also_carries_an_after_discounts_savings_field():
    rec = _CO.shape_for("RDSDBRecommendation")
    opt_shape_name = rec.members["instanceRecommendationOptions"].member.name
    opt_fields = _members(opt_shape_name)
    assert "savingsOpportunityAfterDiscounts" in opt_fields
