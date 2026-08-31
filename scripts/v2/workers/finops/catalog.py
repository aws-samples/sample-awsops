"""ADR-020 rule catalog — the single registration point ("a rule = one file + one catalog line").

Each entry: {id, title, category, status}. status='active' entries carry `fn` (see rules.py for the
`(conn, ce_calls) -> list[dict]` contract) and are executed by engine.run(). status='requires_cur'
entries are registered but never executed — the ADR-020 Context section is explicit that CUR/Athena/
FOCUS do not exist in this repo, so rules that need CUR 2.0 line-item detail must say so in the
catalog rather than silently not existing (a reader diffing "what rules exist" against "what ran"
would otherwise have no way to tell "not yet built" from "built and found nothing")."""
from . import rules

RULES = [
    {
        "id": "ebs_unattached",
        "title": "Unattached EBS volumes",
        "category": "storage",
        "status": "active",
        "fn": rules.ebs_unattached,
    },
    {
        "id": "ec2_rightsizing",
        "title": "EC2 rightsizing (Compute Optimizer)",
        "category": "compute",
        "status": "active",
        "fn": rules.ec2_rightsizing,
    },
    {
        "id": "rds_rightsizing",
        "title": "RDS rightsizing (Compute Optimizer)",
        "category": "database",
        "status": "active",
        "fn": rules.rds_rightsizing,
    },
    {
        "id": "tag_coverage_spend_detail",
        "title": "Untagged-spend attribution by team/project",
        "category": "governance",
        "status": "requires_cur",
    },
    {
        "id": "bedrock_token_line_items",
        "title": "Bedrock token cost vs. ai_usage_daily reconciliation",
        "category": "ai_cost",
        "status": "requires_cur",
    },
]


def active_rules():
    return [r for r in RULES if r["status"] == "active"]
