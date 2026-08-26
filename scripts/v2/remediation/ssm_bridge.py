# scripts/v2/remediation/ssm_bridge.py
"""Build SSM StartAutomationExecution params from a resolved catalog action. Cross-account
(TargetLocations) is DORMANT: only emitted when ALLOW_CROSS_ACCOUNT_MUTATION=true AND the action's
conditions list non-self accounts. Default = host-account-only (ADR-029 #8 toggle, not a limit)."""
import os

def build_start_params(action, payload, dry_run):
    doc = os.environ["EC2_CREATE_TAGS_DOC"] if action["name"] == "ec2-create-tags" \
        else os.environ.get(f"DOC_{action['name'].upper().replace('-', '_')}")
    role = os.environ[f"ASSUME_ROLE_{action['assume_role_ref'].upper().replace('-', '_')}"]
    params = {
        "DocumentName": doc,
        "Parameters": {
            "AutomationAssumeRole": [role],
            "ResourceId": [payload.get("resourceId", "")],
            "Tags": [],  # StringMap params are passed via the doc-specific shape; left to the runbook contract
            "DryRun": ["true" if dry_run else "false"],
        },
    }
    allow_xacct = os.environ.get("ALLOW_CROSS_ACCOUNT_MUTATION", "false").lower() == "true"
    accts = [a for a in action.get("conditions", {}).get("accounts", ["self"]) if a != "self"]
    if allow_xacct and accts:
        params["TargetLocations"] = [{"Accounts": accts,
                                      "Regions": action["conditions"].get("regions", []),
                                      "ExecutionRoleName": action["assume_role_ref"]}]
    return params
