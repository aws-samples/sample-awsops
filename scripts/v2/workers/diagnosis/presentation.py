"""Deterministic report presentation. Models select claims; code prints admitted facts."""
import html
import json
import re
from .evidence import _NUMBER

_COPY = {
    "en": ("Finding", "Evidence", "Scope / window", "Observation", "Hypothesis",
           "Provider candidate — manual verification required", "Coverage gap",
           "No admitted findings; coverage remains unknown.", "Unresolved prerequisites",
           "Read-only verification", "Coverage and withheld claims"),
    "ko": ("진단", "근거", "범위 / 기간", "관측", "가설",
           "공급자 후보 — 수동 검증 필요", "커버리지 공백",
           "검증된 진단 없음; 커버리지는 미확인입니다.", "미해결 전제 조건",
           "읽기 전용 검증", "커버리지 및 보류된 주장"),
    "zh": ("诊断", "证据", "范围 / 时间", "观测", "假设",
           "提供商候选 — 需要手动验证", "覆盖缺口",
           "没有已验证的诊断；覆盖情况仍未知。", "未解决的前提",
           "只读验证", "覆盖情况和已保留的结论"),
    "ja": ("診断", "根拠", "範囲 / 期間", "観測", "仮説",
           "プロバイダー候補 — 手動検証が必要", "カバレッジの不足",
           "検証済み診断なし。カバレッジは未確認です。", "未解決の前提条件",
           "読み取り専用の検証", "カバレッジと保留された主張"),
}
_PILLARS = {
    "operational_excellence": ("Operational Excellence", "運用上の優秀性", "运营卓越", "운영 우수성"),
    "security": ("Security", "セキュリティ", "安全性", "보안"),
    "reliability": ("Reliability", "信頼性", "可靠性", "안정성"),
    "performance_efficiency": ("Performance Efficiency", "パフォーマンス効率", "性能效率", "성능 효율성"),
    "cost_optimization": ("Cost Optimization", "コスト最適化", "成本优化", "비용 최적화"),
    "sustainability": ("Sustainability", "持続可能性", "可持续性", "지속 가능성"),
}
_SECTION_PILLARS = {
    "security_posture": {"security"}, "identity_access": {"security"},
    "data_protection": {"security"}, "network_exposure": {"security"},
    "network_architecture": {"security", "reliability"},
    "reliability_ha": {"reliability"},
    "compute_infrastructure": {"performance_efficiency", "reliability", "sustainability"},
    "database_storage": {"performance_efficiency", "reliability"},
    "cost_overview": {"cost_optimization", "sustainability"},
    "cost_optimization": {"cost_optimization", "performance_efficiency", "sustainability"},
    "recent_changes": {"operational_excellence"},
    "observability_coverage": {"operational_excellence"},
    "external_obs_signals": {"operational_excellence", "reliability"},
}
_SEVERITY = {"critical": 0, "high": 1, "medium": 2, "low": 3, "info": 4}
# Templates are instructions for the operator, never executed and never model supplied.
_VERIFY = {
    "resource_metrics": "aws cloudwatch get-metric-data --region <evidence-region> "
                        "--metric-data-queries file://reviewed-queries.json "
                        "--start-time <window-start> --end-time <window-end>",
    "provider_sizing": "aws compute-optimizer get-ec2-instance-recommendations "
                       "--region <evidence-region> --instance-arns <verified-instance-arn>; "
                       "aws compute-optimizer get-rds-database-recommendations "
                       "--region <evidence-region> --resource-arns <verified-db-arn>",
    "graph_refresh": "aws xray get-service-graph --region <evidence-region> "
                     "--start-time <window-start> --end-time <window-end>",
}


def _cell(value, limit=700):
    """Literal table text: never allow telemetry/model text to become Markdown/HTML."""
    if not isinstance(value, str):
        value = json.dumps(value, ensure_ascii=False, sort_keys=True, default=str)
    return (html.escape(value[:limit], quote=True).replace("|", "&#124;")
            .replace("\n", " ").replace("\r", " ").replace("`", "&#96;")
            .replace("[", "&#91;").replace("]", "&#93;")
            .replace("*", "&#42;").replace("_", "&#95;")
            .replace("\\", "&#92;"))


def _code(value):
    return f"`{_cell(value)}`"


def _ordered(analysis):
    return sorted(analysis.get("findings", []),
                  key=lambda f: (_SEVERITY.get(f.get("severity"), 5), str(f.get("id", ""))))


def _safe_explanation(value):
    # Numeric observations and targets belong to code-owned facts. Refuse unsafe prose
    # defensively even though EvidenceIndex already rejects these before presentation.
    if not isinstance(value, str) or _NUMBER.search(value) or re.search(
            r"https?://|```|\b(?:aws|curl|wget|sudo|kubectl|terraform)\b", value, re.I):
        return ""
    return _cell(value, 600)


def _facts(value, prefix="", depth=0):
    if isinstance(value, dict) and depth < 4:
        rows = []
        for key, item in sorted(value.items()):
            rows.extend(_facts(item, f"{prefix}.{key}" if prefix else str(key), depth + 1))
            if len(rows) >= 40:
                break
        return rows[:40]
    return [(prefix, value)]


def _finding_body(finding, evidence, resources, copy, *, verification=False, lang="ko"):
    claims = {"observation": copy[3], "hypothesis": copy[4],
              "sizing_candidate": copy[5], "coverage_gap": copy[6]}
    claim = finding.get("claim", "hypothesis")
    label = claims.get(claim, copy[4])
    target_ids = finding.get("resource_ids", [])
    targets = [resources[rid] for rid in target_ids if rid in resources]
    output = [f"**{copy[0]} {_code(finding.get('id', ''))} — {_cell(label)}**",
              f"{_cell(finding.get('pillar', ''))} / {_cell(finding.get('severity', ''))}",
              ", ".join(_code(r["resource_id"]) for r in targets), ""]
    explanation = _safe_explanation(finding.get("explanation"))
    if explanation:
        # Explanatory language is always a hypothesis, even for an observed metric/call.
        output += [f"_{copy[4]}_: {explanation}", ""]
    refs = [evidence[eid] for eid in finding.get("evidence_ids", []) if eid in evidence]
    if refs:
        output += [f"| {copy[1]} | {copy[2]} | {copy[3]} |",
                   "| --- | --- | --- |"]
    for record in refs:
        scope = {"account": record.get("account"), "region": record.get("region"),
                 "regions": record.get("regions"),
                 "captured_at": record.get("captured_at"), "window": record.get("window"),
                 "coverage": record.get("coverage"), "fresh": record.get("fresh"),
                 "kind": record.get("kind"), "resource_ids": record.get("resource_ids")}
        rows = _facts(record.get("facts", {})) or [("unknown", None)]
        for field, value in rows:
            output.append(f"| {_code(record['id'])} / {_cell(record.get('source', ''))} "
                          f"| {_cell(scope)} | {_cell(field)} = {_cell(value)} |")
    prerequisites = finding.get("prerequisites", [])
    # Model-authored prerequisites get the base renderer's read-only CLI rule. A
    # mutating command is withheld (never printed) and the section carries the mark.
    from .report import _MUTATING_MARK, _has_mutating_cli
    safe = [p for p in prerequisites if not (isinstance(p, str) and _has_mutating_cli(p))]
    if safe:
        output += ["", f"**{copy[8]}:** " + ", ".join(_cell(p) for p in safe)]
    if len(safe) != len(prerequisites):
        output += ["", _MUTATING_MARK.get(lang, _MUTATING_MARK["ko"]).strip()]
    capability = finding.get("verification")
    if verification and capability in _VERIFY:
        output += ["", f"**{copy[9]}:**", "", f"`{_VERIFY[capability]}`"]
    return "\n".join(output)


def _coverage(bundle, analysis, copy):
    diagnostics = {"coverage": bundle.get("coverage", {}), "gaps": bundle.get("gaps", []),
                   "degraded": list(bundle.get("degraded", [])) + list(analysis.get("degraded", [])),
                   "incomplete": list(bundle.get("incomplete", [])) + list(analysis.get("incomplete", [])),
                   "pillar_coverage": analysis.get("pillar_coverage", {}),
                   "withheld": analysis.get("rejected", [])}
    rows = [f"**{copy[10]}**", "", "| Field | Value |", "| --- | --- |"]
    rows.extend(f"| {_cell(k)} | {_cell(v, 2500)} |" for k, v in diagnostics.items())
    return "\n".join(rows)


def render(catalog, bundle, analysis, *, lang="ko", invariant_md=""):
    """Return catalog-ordered section bodies, rendering only admitted finding facts."""
    copy = _COPY.get(lang, _COPY["ko"])
    evidence = {e["id"]: e for e in bundle.get("evidence", [])}
    resources = {r["id"]: r for r in bundle.get("resources", [])}
    findings = _ordered(analysis)
    output = {}
    # Details first. The final two selections reuse exactly these admitted records.
    for section in catalog:
        key = section["key"]
        if key in {"executive_summary", "recommendations"}:
            continue
        if key == "intended_vs_actual":
            output[key] = invariant_md
            continue
        selected = [f for f in findings if f.get("pillar") in _SECTION_PILLARS.get(key, set())]
        output[key] = "\n\n".join(_finding_body(f, evidence, resources, copy, lang=lang)
                                  for f in selected)
        if not output[key]:
            output[key] = copy[7]
        # Missing discovery/sizing prerequisites remain explicit in every detail section.
        output[key] += "\n\n" + _coverage(bundle, analysis, copy)
    for key in ("executive_summary", "recommendations"):
        if any(s["key"] == key for s in catalog):
            output[key] = ("\n\n".join(_finding_body(f, evidence, resources, copy,
                                                    verification=key == "recommendations",
                                                    lang=lang)
                                       for f in findings[:12]) or copy[7])
            output[key] += "\n\n" + _coverage(bundle, analysis, copy)
    return [(section["key"], output[section["key"]]) for section in catalog]


def title_and_tags(bundle, analysis, *, lang="ko"):
    findings = _ordered(analysis)
    default = {"ko": "근거 기반 AWS 진단", "en": "Evidence-based AWS diagnosis",
               "zh": "基于证据的 AWS 诊断", "ja": "根拠に基づく AWS 診断"}
    if not findings:
        return {"title": default.get(lang, default["ko"]), "tags": ["diagnosis"]}
    top = findings[0]
    pillar = top.get("pillar")
    names = _PILLARS.get(pillar, ("AWS",) * 4)
    label = names[{"en": 0, "ja": 1, "zh": 2, "ko": 3}.get(lang, 3)]
    resources = {r["id"]: r for r in bundle.get("resources", [])}
    targets = [resources[rid]["resource_id"] for rid in top.get("resource_ids", []) if rid in resources]
    # Titles are plain text; never echo model prose or telemetry labels.
    title = label + (" — " + str(targets[0])[:100] if targets else "")
    return {"title": title[:200],
            "tags": list(dict.fromkeys(f["pillar"] for f in findings if f.get("pillar") in _PILLARS))[:6]}
