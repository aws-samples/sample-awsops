"""Bounded cross-section handoff state (pure; no strands/boto imports).

A chat section agent can call ``consult_section`` to attach another section's
gateway tools to itself for the rest of the answer. This module holds only the
state and policy; the caller supplies ``connect``/``register``/``existing_names``.
"""
from typing import Callable

SECTION_CAPABILITIES: dict[str, str] = {
    "network": "VPC, subnet, ENI, security group, NACL, route table, TGW, VPN, flow logs, reachability",
    "container": "EKS, ECS, Istio",
    "data": "RDS, Aurora, DynamoDB, ElastiCache, MSK",
    "security": "IAM users, roles, groups, policies, access keys, policy simulation",
    "cost": "Cost Explorer, budgets, reserved instances",
    "monitoring": "CloudWatch metrics, alarms, logs, CloudTrail, Loki, Tempo, Mimir",
    "iac": "CloudFormation, Terraform drift",
    "ops": "inventory, topology, EC2 listing, unused resources, load balancers, target groups, CloudFront",
    "external-obs": "Prometheus, ClickHouse, vendor observability",
}

_TOOL_NAME = "consult_section"


class HandoffState:
    def __init__(
        self,
        primary: str,
        available: dict[str, str],
        connect: Callable[[str], list],
        register: Callable[[object], None],
        existing_names: Callable[[], set[str]],
        max_sections: int = 2,
    ) -> None:
        self.primary = primary
        self.available = available
        self._connect = connect
        self._register = register
        self._existing_names = existing_names
        self.max_sections = max_sections
        self.used: list[str] = [primary]

    def consult(self, section: str) -> str:
        if section == self.primary or section not in self.available:
            return f"Section '{section}' is not consultable. Consultable: {', '.join(self.available) or 'none'}."
        if section in self.used:
            return f"The tools of '{section}' are already attached; use them directly."
        if len(self.used) >= self.max_sections + 1:
            return (
                f"Consult limit reached ({self.max_sections} extra sections). "
                "Answer with the tools already attached."
            )
        try:
            tools = self._connect(section)
        except Exception as exc:  # noqa: BLE001 - never leak details (may contain URLs)
            return f"Section '{section}' is unavailable right now ({type(exc).__name__}). Answer with your current tools."

        registered: list[str] = []
        skipped: list[str] = []
        existing = set(self._existing_names())
        for tool in tools:
            name = tool.tool_name
            if name == _TOOL_NAME or name in existing:
                skipped.append(name)
                continue
            try:
                self._register(tool)
            except ValueError:
                skipped.append(name)
                continue
            registered.append(name)
            existing.add(name)
        self.used.append(section)

        if not registered:
            return f"Consulted '{section}': no new tools were attached (all {len(skipped)} skipped)."
        msg = f"Attached {len(registered)} tools from '{section}': {', '.join(registered)}. Use them now."
        if skipped:
            msg += f" Tools skipped: {', '.join(skipped)}."
        return msg


def handoff_prompt(state: HandoffState) -> str:
    lines = [f"- {key}: {SECTION_CAPABILITIES.get(key, '')}" for key in state.available]
    return (
        "## Consultable sections\n"
        "You can call consult_section to attach another section's tools. Sections:\n"
        + "\n".join(lines)
        + "\nIf the question needs data your tools cannot read, call consult_section with the section "
        "that can; never answer that no tool is available while a listed section can read it. "
        "Do not ask the user before consulting."
    )
