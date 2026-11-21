"""Compose the operator report from validated findings, keeping the evidence ledger in an appendix."""
from . import architecture, presentation as view
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


# Operator decision criteria, not claims that these conditions were observed.
_DECISIONS = {
    "operational_excellence": (
        "담당자와 함께 대표 이벤트 하나를 골라 탐지부터 통지, 대응 기록까지 추적하세요. 기록이 끊긴 지점을 먼저 보완하고 같은 이벤트로 재확인하세요.",
        "Trace one representative event from detection to notification and response with its owner. Address the first missing handoff and repeat the check.",
        "担当者と代表イベントの検知から通知・対応記録までを追い、最初の欠落箇所を改善して同じ手順で再確認します。",
        "与负责人跟踪一个典型事件从检测、通知到响应的记录，先补齐第一个断点，再重复验证。"),
    "security": (
        "대상과 접근 주체, 데이터 등급을 확인한 뒤 승인된 정책과 실제 설정을 대조하세요. 차이가 확인된 대상부터 개선 범위와 검증 항목을 정하세요.",
        "Confirm the affected resource, principals and data class. Compare effective settings with the approved policy, then scope remediation and verification to confirmed deviations.",
        "対象・アクセス主体・データ分類を確認し、実効設定を承認済みポリシーと比較します。確認された差異ごとに改善範囲と検証項目を決めます。",
        "确认资源、访问主体及数据分类，将实际配置与批准的策略对照，再为已确认的偏差确定改进范围和验证项。"),
    "reliability": (
        "업무 소유자의 복구 목표와 복원·장애 조치 시험 결과를 비교하세요. 목표를 충족하지 못한 단계가 확인되면 그 구간의 개선을 먼저 설계하세요.",
        "Compare the workload owner's recovery objectives with restore or failover test results. Design the first improvement around the step that missed its objective.",
        "業務の復旧目標と復元・フェイルオーバー試験の結果を比較し、目標に届かなかった工程から改善を設計します。",
        "将业务负责人的恢复目标与恢复或故障转移演练结果对照，优先改进未达目标的环节。"),
    "performance_efficiency": (
        "동일 워크로드·시간대에서 사용자 지연과 자원 포화·대기를 대조하세요. 함께 반복되는 구간에서 원인 후보를 좁히고 변경 전후를 동일 부하로 비교하세요.",
        "Align user latency and resource saturation or wait time for the same workload and interval. Investigate recurring overlap and compare before and after at equivalent load.",
        "同一ワークロード・時間帯の利用者遅延と飽和・待機を比較し、繰り返し重なる区間を調査して同等負荷で変更前後を検証します。",
        "对齐同一工作负载和时段的用户延迟、资源饱和及等待时间，调查重复重合的区间，并在同等负载下比较变更前后。"),
    "cost_optimization": (
        "청구 항목을 실제 사용 주체와 연결하고 피크·대기 용량을 분리하세요. 같은 서비스 수준을 유지할 때의 비용 차이를 계산할 수 있는 후보부터 검토하세요.",
        "Attribute billed usage to its workload and distinguish peak and standby capacity. Evaluate candidates whose cost difference can be calculated at the same service level.",
        "請求項目を利用主体にひも付け、ピーク・待機容量を分離します。同じサービス水準で費用差を算出できる候補から比較します。",
        "将账单用量归属到实际工作负载，区分峰值和备用容量，优先评估能在同等服务水平下计算成本差异的方案。"),
    "sustainability": (
        "처리 요청이나 배치 작업을 단위로 정하고 단위당 자원 사용량을 기록하세요. 가용성과 처리량을 유지한 상태에서 사용량이 줄었는지 비교하세요.",
        "Choose a unit of work such as a request or batch and record resource use per unit. Compare consumption while holding availability and throughput constant.",
        "リクエストやバッチなどの処理単位を定め、単位当たりの資源使用量を記録し、可用性と処理量を維持した状態で比較します。",
        "选取请求或批任务等业务单位，记录单位资源用量，并在可用性和吞吐量相同的前提下比较消耗。"),
}
_GUIDE = {
    "ko": ("먼저 확인할 일", "현장 확인", "개선 여부를 결정하는 기준"),
    "en": ("What to check first", "Verify with the owner", "Decision criteria"),
    "ja": ("最初に確認すること", "担当者による確認", "改善を判断する基準"),
    "zh": ("优先核查", "与负责人核实", "改进决策依据"),
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

    evidence = {r["id"]: r for r in bundle.get("evidence", [])}

    def provenance(f):
        # Qualify every cited source window, without repeating the field ledger or
        # presenting an arbitrary same-resource metric as evidence for a hypothesis.
        notes = []
        for ref in f.get("evidence_ids", []):
            record = evidence.get(ref, {})
            if not record:
                continue
            scope = {k: record[k] for k in ("kind", "region", "regions", "window", "captured_at", "fresh")
                     if k in record}
            coverage = record.get("coverage", {})
            scope["coverage"] = {k: coverage[k] for k in ("sampled", "complete", "sample_ratio") if k in coverage}
            text = view._scope_text(scope, lang)
            if text:
                notes.append(view._code(view._scrubbed(text)))
            # A validated single-resource metrics observation is the code-owned
            # collection statement, never a free-form hypothesis about a different metric.
            refs = f.get("resource_ids", [])
            if (f["claim"] == "observation" and record.get("kind") == "metrics"
                    and len(refs) == 1 and record.get("resource_ids") == refs):
                metrics = record.get("facts", {}).get("metrics", {})
                for name, statistic, field in (("CPUUtilization", "Maximum", "max"),
                                                ("FreeableMemory", "Minimum", "min")):
                    series = metrics.get(name, {}).get(statistic, {})
                    if (series.get("status") == "Complete" and type(series.get(field)) in (int, float)
                            and series.get("unit")):
                        notes.append(view._code(f"{name} ({statistic}, {field}) "
                                                f"{series[field]} {series['unit']}"))
        return ("\n\n" + copy[1] + " · " + "; ".join(dict.fromkeys(notes))) if notes else ""

    def safe_checks(f):
        return list(dict.fromkeys(text for raw in f.get("prerequisites", [])
                                  if isinstance(raw, str) and not _has_mutating_cli(raw)
                                  for text in [view._safe_explanation(raw)] if text))

    def paragraph(f, detailed):
        # Specialist explanatory language is a hypothesis even when the selected claim is observed.
        claim = f["claim"]
        text = f.get("explanation")
        if claim != "observation":
            text = plan.get("paragraphs", {}).get(f["id"], text)
        prose = view._safe_explanation(text) or view._WITHHELD[lang]
        label = {"observation": copy[3], "sizing_candidate": copy[5],
                 "coverage_gap": copy[6]}.get(claim, copy[4])
        body = f"**{subject(f)}** · {label}\n\n{prose}" + provenance(f)
        checks = safe_checks(f) if detailed else []
        if checks:
            body += f"\n\n**{_GUIDE[lang][1]}**\n\n" + "\n".join("- " + check for check in checks)
        return body

    def block(key, title, body):
        return {"key": key, "title": title, "body": body}

    def paragraphs(ids, severity_scope=None):
        if not ids:
            return copy[7]
        ranks = [view._SEVERITY.get(by_id[i]["severity"], 5) for i in (severity_scope or ids)]
        marker = "[Critical]\n\n" if min(ranks) <= 1 else "[Warning]\n\n" if min(ranks) == 2 else ""
        return marker + "\n\n".join(paragraph(by_id[i], detailed=severity_scope is None) for i in ids)

    lead = paragraphs(plan["lead"] or list(by_id)[:1], list(by_id))
    if any(bundle.get(k) or analysis.get(k) for k in ("gaps", "degraded", "incomplete", "rejected")):
        lead += "\n\n" + titles[4]
    # A critical check remains visible even when the editor selects only lower priorities.
    first = next(((f, checks[0]) for f in ordered if (checks := safe_checks(f))), None)
    if first:
        f, check = first
        rank = view._label(view._SEVERITY_LABEL, f["severity"], lang)
        lead = f"### {_GUIDE[lang][0]}\n\n**{subject(f)}** · {rank}\n\n{check}\n\n" + lead
    priorities = {rid for finding in ordered if finding["severity"] in {"critical", "high"}
                  for rid in finding.get("resource_ids", [])}
    current = architecture.section(analysis.get("evidence_bundle", {}), lang, priorities)
    result = [block("assessment", titles[0], lead), current]
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
        if ids:
            language_index = ("ko", "en", "ja", "zh").index(lang)
            body += f"\n\n**{_GUIDE[lang][2]}**\n\n" + _DECISIONS[pillar][language_index]
        result.append(block(pillar, view._label(view._PILLARS, pillar, lang), body))
    checks = []
    withheld = False
    first_ids = [first[0]["id"]] if first else []
    candidates = list(dict.fromkeys(first_ids + plan["next"] + list(by_id)))
    for ident in candidates:
        f = by_id[ident]
        for raw in f.get("prerequisites", []):
            check = view._safe_explanation(raw)
            if check and not _has_mutating_cli(raw):
                rank = view._label(view._SEVERITY_LABEL, f["severity"], lang)
                pillar = view._label(view._PILLARS, f["pillar"], lang)
                item = f"{rank} · {pillar} · {subject(f)} — {check}"
                if item not in checks:
                    checks.append(item)
                    break
            else:
                withheld = True
        if len(checks) == 4:
            break
    body = "\n\n".join("- " + check for check in checks) or titles[5]
    if withheld:
        body += "\n\n" + view._WITHHELD[lang]
    if checks:
        phases = {
            "ko": ("개선 실행 순서", "선정한 대상의 소유자와 현재 구성·영향 범위·측정 기준선을 합의합니다.",
                   "한 워크로드에서 개선안을 검토하고, 적용을 결정하기 전에 성공 조건과 되돌릴 조건을 기록합니다.",
                   "동일한 부하·기간에서 기준선과 비교합니다. 목표를 달성한 경우 의존성이 확인된 대상부터 확대합니다."),
            "en": ("Improvement roadmap", "Agree on the current configuration, impact boundary and baseline with the owner.",
                   "Evaluate the proposal on one workload and record success and rollback criteria before deciding to apply it.",
                   "Compare against the baseline at equivalent load and duration. Expand only after meeting the objective and confirming dependencies."),
            "ja": ("改善の進め方", "対象の所有者と現行構成・影響範囲・測定基準を確認します。",
                   "一つのワークロードで改善案を検討し、適用前に成功条件と切り戻し条件を記録します。",
                   "同じ負荷と期間で比較し、目標達成と依存関係を確認した対象から展開します。"),
            "zh": ("改进实施顺序", "与负责人确认当前配置、影响范围及基线。",
                   "先在一个工作负载上评估方案，决定实施前记录成功和回退条件。",
                   "按相同负载和时段对照基线，达到目标并确认依赖关系后再扩大范围。"),
        }[lang]
        body += f"\n\n### {phases[0]}\n\n" + "\n".join(
            f"{i}. {phase}" for i, phase in enumerate(phases[1:], 1))
    result.append(block("next_checks", titles[2], body))
    for section in result:
        section["body"] = view._swept(section["body"], lang)
    result.append(invariant)
    return result


def appendix_title(lang):
    return _TITLES[lang][3]

def fit_sections(sections, limit, lang):
    """Share body bytes across sections. Short sections return their unused allocation."""
    remaining = max(0, limit)
    ranked = sorted(sections, key=lambda section: len(section["body"].encode()))
    clipped = []
    for index, section in enumerate(ranked):
        allowance = remaining // (len(ranked) - index)
        body = section["body"]
        if len(body.encode()) > allowance:
            clipped.append(section["key"])
            # Under a tiny artificial limit even the localized truncation marker may not fit.
            body = view._trim(body, allowance, lang).encode()[:allowance].decode(errors="ignore")
            section["body"] = body
        remaining -= len(body.encode())
    return clipped
