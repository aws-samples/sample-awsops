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


def compose(bundle, analysis, sections, lang):
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

    evidence = {r["id"]: r for r in bundle.get("evidence", [])}

    def measurements(f):
        # Never attribute a group metric to an individual or an account-wide observation to a DB.
        if len(f.get("resource_ids", [])) != 1:
            return ""
        for eid in f.get("evidence_ids", []):
            r = evidence.get(eid, {})
            if r.get("kind") != "metrics" or r.get("resource_ids") != f["resource_ids"]:
                continue
            metrics = r.get("facts", {}).get("metrics", {})
            values = []
            if not isinstance(metrics, dict):
                continue
            for name, series in metrics.items():
                if not isinstance(series, dict):
                    continue
                for statistic, aggregate in series.items():
                    if not isinstance(aggregate, dict) or aggregate.get("status") != "Complete":
                        continue
                    key = "min" if statistic == "Minimum" else "max"
                    value = aggregate.get(key)
                    if type(value) not in (int, float) or not aggregate.get("unit"):
                        continue
                    values.append(f"{view._code(name)} ({view._code(statistic)}, {key}) "
                                  f"{value} {view._code(aggregate['unit'])}")
                    break
                if len(values) == 2:
                    break
            if values:
                return "\n\n" + view._code(view._scrubbed(view._scope_text(r, lang))) + " · " + ", ".join(values)
        return ""

    def paragraph(f):
        # Specialist explanatory language is a hypothesis even when the selected claim is observed.
        claim = f["claim"]
        text = f.get("explanation")
        if claim in {"hypothesis", "coverage_gap"}:
            text = plan.get("paragraphs", {}).get(f["id"], text)
        prose = view._safe_explanation(text) or view._WITHHELD[lang]
        label = {"observation": copy[3], "sizing_candidate": copy[5],
                 "coverage_gap": copy[6]}.get(claim, copy[4])
        return f"**{subject(f)}** · {label}\n\n{prose}" + measurements(f)

    def block(key, title, body):
        return {"key": key, "title": title, "body": body}

    def paragraphs(ids):
        if not ids:
            return copy[7]
        ranks = [view._SEVERITY.get(by_id[i]["severity"], 5) for i in ids]
        marker = "[Critical]\n\n" if min(ranks) <= 1 else "[Warning]\n\n" if min(ranks) == 2 else ""
        return marker + "\n\n".join(paragraph(by_id[i]) for i in ids)

    lead = paragraphs(plan["lead"])
    if any(bundle.get(k) or analysis.get(k) for k in ("gaps", "degraded", "incomplete", "rejected")):
        lead += "\n\n" + titles[4]
    result = [block("assessment", titles[0], lead)]
    if plan["context"]:
        result.append(block("supporting_findings", titles[1], paragraphs(plan["context"])))
    checks = []
    for ident in plan["next"]:
        f = by_id[ident]
        for raw in f.get("prerequisites", []):
            check = view._safe_explanation(raw)
            if check and not _has_mutating_cli(raw):
                checks.append(f"{subject(f)} — {check}")
    body = "\n\n".join(f"{n}. {line}" for n, line in enumerate(dict.fromkeys(checks), 1))
    result.append(block("next_checks", titles[2], body or titles[5]))
    # Keep deterministic invariant results in the body, including a finding-free report.
    for s in sections:
        if s["key"] == "intended_vs_actual":
            result.append(s)
    appendix = "\n\n".join(f"### {s['title']}\n\n{s['body']}" for s in sections
                           if s["key"] != "intended_vs_actual")
    remaining = view.MAX_MARKDOWN_BYTES - sum(len(s["body"].encode()) for s in result)
    if len(appendix.encode()) > remaining:
        appendix = view._trim(appendix, remaining, lang)
    result.append(block("evidence_appendix", titles[3], appendix))
    return result
