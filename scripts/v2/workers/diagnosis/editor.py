"""Compose the operator report from validated findings, keeping the evidence ledger in an appendix."""
from . import presentation as view
from .report import _has_mutating_cli

_TITLES = {
    "ko": ("진단 의견", "주요 소견과 평가 범위", "확인할 순서", "근거 부록",
           "일부 근거가 누락되거나 제한됐습니다. 세부 수집 범위는 부록에 있습니다.",
           "이 기록에서 구체적인 후속 확인 항목을 도출하지 못했습니다."),
    "en": ("Assessment", "Supporting findings and scope", "Next checks", "Evidence appendix",
           "Some evidence is incomplete. The appendix describes collection coverage.",
           "No specific follow-up check was established."),
    "ja": ("診断所見", "主な所見と評価範囲", "確認の順序", "根拠資料",
           "一部の根拠は不完全です。収集範囲は付録を参照してください。", "具体的な確認項目は特定できませんでした。"),
    "zh": ("诊断意见", "主要发现与评估范围", "后续核查", "证据附录",
           "部分证据不完整。采集范围见附录。", "现有证据未能确定具体的后续核查。"),
}


def compose(bundle, analysis, invariant, lang):
    titles = _TITLES[lang]
    copy = view._COPY[lang]
    ordered = view._ordered(analysis)
    by_id = {f["id"]: f for f in ordered}
    resources = {r["id"]: r for r in bundle.get("resources", [])}
    plan = analysis.get("editor_plan") or {
        "lead": [f["id"] for f in ordered[:3]], "context": [f["id"] for f in ordered[3:11]],
        "next": [f["id"] for f in ordered if f.get("prerequisites")][:4],
    }

    def subject(f):
        names = [view._code(resources[r]["resource_id"]) for r in f.get("resource_ids", []) if r in resources]
        return ", ".join(names) or view._label(view._PILLARS, f["pillar"], lang)

    def paragraph(f):
        # Specialist explanatory language is a hypothesis even when the selected claim is observed.
        claim = f["claim"]
        text = f.get("explanation")
        if claim != "observation":
            text = plan.get("paragraphs", {}).get(f["id"], text)
        prose = view._safe_explanation(text) or view._WITHHELD[lang]
        label = {"observation": copy[3], "sizing_candidate": copy[5],
                 "coverage_gap": copy[6]}.get(claim, copy[4])
        return f"**{subject(f)}** · {label}\n\n{prose}"

    def block(key, title, body):
        return {"key": key, "title": title, "body": body}

    def paragraphs(ids, severity_scope=None):
        if not ids:
            return copy[7]
        ranks = [view._SEVERITY.get(by_id[i]["severity"], 5) for i in (severity_scope or ids)]
        marker = "[Critical]\n\n" if min(ranks) <= 1 else "[Warning]\n\n" if min(ranks) == 2 else ""
        return marker + "\n\n".join(paragraph(by_id[i]) for i in ids)

    lead = paragraphs(plan["lead"], by_id)
    if any(bundle.get(k) or analysis.get(k) for k in ("gaps", "degraded", "incomplete", "rejected")):
        lead += "\n\n" + titles[4]
    result = [block("assessment", titles[0], lead)]
    labels = {
        "ko": ("분석 완료", "부분 평가", "분석 실패", "미평가", "채택 소견"),
        "en": ("Analysis completed", "Partial assessment", "Analysis failed", "Unassessed", "Admitted findings"),
        "ja": ("分析完了", "部分評価", "分析失敗", "未評価", "採用所見"),
        "zh": ("分析完成", "部分评估", "分析失败", "未评估", "采纳发现"),
    }[lang]
    priority = list(dict.fromkeys(plan["context"] + list(by_id)))
    coverage = analysis.get("pillar_coverage", {})
    for pillar in view._PILLARS:
        ids = [i for i in priority if by_id[i]["pillar"] == pillar]
        state = coverage.get(pillar, {}).get("status")
        status = labels[{"completed": 0, "partial": 1, "failed": 2}.get(state, 3)]
        warning = "[Warning]\n\n" if state in {"partial", "failed"} else ""
        body = f"{warning}{status} · {labels[4]} {len(ids)}\n\n{paragraphs(ids)}"
        result.append(block(pillar, view._label(view._PILLARS, pillar, lang), body))
    checks = []
    withheld = False
    for ident in plan["next"]:
        f = by_id[ident]
        for raw in f.get("prerequisites", []):
            check = view._safe_explanation(raw)
            if check and not _has_mutating_cli(raw):
                checks.append(f"{subject(f)} — {check}")
            else:
                withheld = True
    checks = list(dict.fromkeys(checks))[:4]
    body = "\n\n".join("- " + check for check in checks) or titles[5]
    if withheld:
        body += "\n\n" + view._WITHHELD[lang]
    result.append(block("next_checks", titles[2], body))
    for section in result:
        section["body"] = view._swept(section["body"], lang)
    result.append(invariant)
    return result


def appendix_title(lang):
    return _TITLES[lang][3]
