"""Deterministic report presentation. Models select claims; code prints admitted facts."""
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
# Disclosed in place of model prose the guard withholds, so a finding never silently loses it.
_WITHHELD = {
    "en": "_(model text withheld: it contained a number, link or command)_",
    "ko": "_(모델 문구 보류: 숫자·링크·명령이 포함됨)_",
    "zh": "_(已保留模型文本：其中包含数字、链接或命令)_",
    "ja": "_(モデルの文章を保留: 数値・リンク・コマンドを含むため)_",
}
# Model prose is refused (and disclosed as withheld) when it carries anything copyable as a
# command. Word boundaries are ASCII-only so CJK letters glued to a tool word ("AWS의 rds ...")
# never hide it, and every check is case-insensitive.
_B, _E = r"(?<![A-Za-z0-9_-])", r"(?![A-Za-z0-9_-])"
_COMMAND = re.compile(
    r"(?i)https?://|```|\$\(|&&|\|\|?\s*(?:sh|bash)" + _E +
    # Distinctive operator tools: any ASCII argument makes it a command.
    r"|" + _B + r"(?:curl|wget|sudo|su|kubectl|terraform|helm|docker|podman|eksctl|psql|mysql|"
    r"mongosh|mongo|redis-cli|systemctl|ssh|scp|rsync|chmod|chown|mkfs|pkill|killall|gcloud|az|"
    r"pip|npm|npx|yarn|apt|apt-get|yum|dnf|brew|powershell|pwsh)" + _E + r"\s+[A-Za-z0-9./~$'\"-]"
    # Generic words that are also shell commands: only with a flag or path argument.
    r"|" + _B + r"(?:rm|cp|mv|dd|kill|git|sed|sh|bash|python3?|node|cat|tee|truncate)" + _E +
    r"\s+(?:-|/|~|\.|\$|[A-Za-z0-9_-]*[./=])"
    # Destructive SQL and double-dash flags read as commands in any language.
    r"|" + _B + r"(?:drop|truncate|alter)\s+(?:table|database|schema|index|user|role|view)" + _E +
    r"|" + _B + r"delete\s+from" + _E + r"|(?<![\w-])--[a-z][a-z0-9-]+")
# AWS CLI invocations use report.py's own tokenizer (options skipped, hyphenated and single-word
# operations, s3 commands). `aws` is folded to lowercase in both readings.
_AWS_WORD = re.compile(r"(?i)" + _B + r"aws" + _E)
_AWS_FLAG = re.compile(r"(?i)" + _B + r"aws\s+--?[a-z]")
# Punctuation, CJK particles and other non-CLI characters glued to a token ("terminate-instances.",
# "invoke를", "rm,") become separators, so a trailing character never hides an operation.
_NON_CLI = re.compile(r"[^A-Za-z0-9\s_/:=@+-]|\.(?=\s|$)")


def _commandlike(value):
    from .report import _cli_commands
    # Either reading is enough: the original keeps option values intact
    # ("--filters Name=a,Values=b"), the separated form exposes glued punctuation/particles.
    for text in (value, _NON_CLI.sub(" ", value)):
        folded = _AWS_WORD.sub("aws", text)
        if (_COMMAND.search(folded) or _AWS_FLAG.search(folded)
                or next(_cli_commands(folded), None) is not None):
            return True
    return False


_PILLARS = {
    "operational_excellence": ("Operational Excellence", "運用上の優秀性", "运营卓越", "운영 우수성"),
    "security": ("Security", "セキュリティ", "安全性", "보안"),
    "reliability": ("Reliability", "信頼性", "可靠性", "신뢰성"),
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
# Deep-only sections dedicated to one pillar outrank the shared sections that precede them.
_DEDICATED = {"reliability": "reliability_ha", "cost_optimization": "cost_optimization"}
_SEVERITY = {"critical": 0, "high": 1, "medium": 2, "low": 3, "info": 4}
_LANG_INDEX = {"en": 0, "ja": 1, "zh": 2, "ko": 3}
# Code-owned display labels; unknown values fall back to a literal cell.
_SEVERITY_LABEL = {
    "critical": ("Critical", "重大", "严重", "심각"), "high": ("High", "高", "高", "높음"),
    "medium": ("Medium", "中", "中", "중간"), "low": ("Low", "低", "低", "낮음"),
    "info": ("Info", "情報", "信息", "정보"),
}
# Scope labels: (complete, partial, stale, more regions)
_SCOPE = {"en": ("complete", "partial", "stale", " more"), "ko": ("전체 수집", "부분 수집", "오래된 데이터", "개 더"),
          "zh": ("完整", "部分", "已过期", " 个更多"), "ja": ("完全", "一部", "古いデータ", "件以上")}
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


MAX_MARKDOWN_BYTES = 256 * 1024
_TRUNCATED = "…[truncated]"
# Code-only marker (cells escape "[" so models cannot forge it). "(degraded)" keeps the UI
# section icon non-green, as the legacy renderer's localized _TRUNCATED_MARK does.
SIZE_MARK = _TRUNCATED + " (report size bound, degraded)"
_SIZE_NOTE = {"ko": "출력 크기 한도로 이 섹션이 잘렸습니다.", "en": "This section was cut at the report size limit.",
              "zh": "此章节因报告大小上限被截断。", "ja": "レポートサイズの上限によりこのセクションは切れました。"}


def _clip(value, limit):
    """Bound text/JSON at a token or element boundary, never inside a number."""
    if isinstance(value, (list, dict)):
        items = sorted(value.items()) if isinstance(value, dict) else list(value)
        size, kept = 2, 0
        for item in items:
            size += len(_json(dict([item]) if isinstance(value, dict) else item)) + 2
            if size > limit:
                break
            kept += 1
        if kept == len(items):
            return _json(value)
        part = dict(items[:kept]) if isinstance(value, dict) else items[:kept]
        return f"{_json(part)}{_TRUNCATED} {len(items) - kept} more"
    value = value if isinstance(value, str) else _json(value)
    if len(value) <= limit:
        return value
    cut = re.search(r"[\w.+-]*$", value[:limit]).start() if re.match(r"[\w.+-]", value[limit]) else limit
    return value[:cut] + _TRUNCATED


def _cell(value, limit=700):
    """Literal table text: never allow telemetry/model text to become Markdown/HTML."""
    text = _clip(value, limit).translate(str.maketrans({"|": "｜", "[": "［", "]": "］"}))
    return _literal(text)


def _scrubbed(value, key=""):
    """Rendered fact/coverage values get the same scrub as the model boundary (report.py's
    _invariant_text parity): raw provider error text, hosts and IPs never reach the artifact.
    Resource identities render separately through _code and stay literal."""
    from .evidence import _scrub_text
    if isinstance(value, str):
        return _scrub_text(value, key)
    if isinstance(value, dict):
        return {k: _scrubbed(v, k if isinstance(k, str) else "") for k, v in value.items()}
    if isinstance(value, (list, tuple)):
        return [_scrubbed(v, key) for v in value]
    return value


def _literal(value):
    """Use a collision-free code span; entities remain literal inside code spans."""
    text = " ".join(str(value).split())
    text = "".join(char if char.isprintable() else " " for char in text)
    fence = "`" * (1 + max((len(run) for run in re.findall(r"`+", text)), default=0))
    return f"{fence} {text} {fence}"


def _json(value):
    return json.dumps(value, ensure_ascii=False, sort_keys=True, default=str)


def _swept(body, lang):
    """Final read-only sweep of an assembled body (render_section parity)."""
    from .report import _MUTATING_MARK, _has_mutating_cli
    mark = _MUTATING_MARK.get(lang, _MUTATING_MARK["ko"]).strip()
    return body + "\n\n" + mark if mark not in body and _has_mutating_cli(body) else body


def _code(value):
    # Ordinary AWS identifiers stay literal within the existing presentation bound;
    # malformed stored identities
    # still cannot introduce table columns or code-owned severity/size markers.
    text = _clip(value, 700).translate(str.maketrans({"|": "｜", "[": "［", "]": "］"}))
    return _literal(text)


def _ordered(analysis):
    return sorted(analysis.get("findings", []),
                  key=lambda f: (_SEVERITY.get(f.get("severity"), 5), str(f.get("id", ""))))


def _safe_explanation(value):
    # Numeric observations and targets belong to code-owned facts. Refuse unsafe prose
    # defensively even though EvidenceIndex already rejects these before presentation.
    if not isinstance(value, str) or _NUMBER.search(value) or _commandlike(value):
        return ""
    return _prose(value, 600)


# Characters that could start Markdown/HTML markup, an entity, an autolink or a code-owned marker.
_MARKUP = re.compile(r"[\\`*_{}\[\]<>#|~&@=]|www\.|://|^\s*[-+>!]")


def _prose(value, limit):
    """Readable plain text for vetted model sentences; anything markup-capable stays a literal."""
    text = " ".join(_clip(value, limit).split())
    text = "".join(char if char.isprintable() else " " for char in text)
    return _cell(value, limit) if not text or _MARKUP.search(text) or _TRUNCATED in text else text


def _facts(value, prefix="", depth=0):
    if isinstance(value, dict) and depth < 4:
        return [row for key, item in sorted(value.items())
                for row in _facts(item, f"{prefix}.{key}" if prefix else str(key), depth + 1)]
    return [(prefix, value)]


def _label(table, value, lang):
    names = table.get(value) if isinstance(value, str) else None
    return names[_LANG_INDEX.get(lang, 3)] if names else _cell(value)


def _scope_text(record, lang):
    """One readable line (regions · capture time · window · coverage) instead of a JSON dict."""
    labels = _SCOPE.get(lang, _SCOPE["ko"])
    kind = record.get("kind")
    parts = [kind] if isinstance(kind, str) and kind else []
    region = record.get("region")
    regions = [r for r in record.get("regions") or [] if isinstance(r, str) and r]
    if isinstance(region, str) and region and region not in regions:
        regions.insert(0, region)
    if regions:
        parts.append(", ".join(regions[:3]) + (f" +{len(regions) - 3}{labels[3]}" if len(regions) > 3 else ""))
    captured = record.get("captured_at")
    if isinstance(captured, str) and captured:
        parts.append(captured[:16].replace("T", " ") + " UTC")
    window = record.get("window")
    if isinstance(window, dict) and window:
        if isinstance(window.get("start"), str) and isinstance(window.get("end"), str):
            parts.append(f"{window['start'][:16].replace('T', ' ')} ~ {window['end'][:16].replace('T', ' ')}")
        else:
            parts.append(", ".join(f"{k}={v}" for k, v in sorted(window.items())
                                   if isinstance(v, (str, int, float)) and not isinstance(v, bool)))
    coverage = record.get("coverage")
    if isinstance(coverage, dict):
        complete = coverage.get("complete")
        ratio = coverage.get("sample_ratio")
        # A sampled record is never shown as complete, even when the producer marked it so.
        sampled = isinstance(ratio, (int, float)) and not isinstance(ratio, bool) and ratio < 1
        sampled = sampled or coverage.get("sampled") is True
        if isinstance(complete, bool):
            parts.append(labels[0] if complete and not sampled else labels[1])
        # Every other qualifier (sample ratio, lookback, counts, storage scope) stays visible.
        rest = {k: v for k, v in coverage.items() if k != "complete"}
        if rest:
            parts.append(_flat(rest))
    if record.get("fresh") is False:
        parts.append(labels[2])
    account = record.get("account")
    if isinstance(account, str) and account:
        parts.append(f"account={account}")
    ids = [r for r in record.get("resource_ids") or [] if isinstance(r, str)]
    if ids:
        parts.append("resources=" + ", ".join(ids[:3]) + (f" +{len(ids) - 3}{labels[3]}" if len(ids) > 3 else ""))
    return " · ".join(p for p in parts if p)


def _flat(value):
    """Readable `key=value` list for nested diagnostics; leaves keep compact JSON."""
    if isinstance(value, dict):
        rows = _facts(value)
        return ", ".join(f"{k}={v if isinstance(v, str) else _json(v)}" for k, v in rows) if rows else _json(value)
    if isinstance(value, list):
        return ", ".join(dict.fromkeys(v if isinstance(v, str) else _json(v) for v in value))
    return value


def _finding_body(finding, evidence, resources, copy, *, lang="ko"):
    claims = {"observation": copy[3], "hypothesis": copy[4],
              "sizing_candidate": copy[5], "coverage_gap": copy[6]}
    claim = finding.get("claim", "hypothesis")
    label = claims.get(claim, copy[4])
    target_ids = finding.get("resource_ids", [])
    targets = [resources[rid] for rid in target_ids if rid in resources]
    output = [f"**{copy[0]} {_code(finding.get('id', ''))} — {_cell(label)}**",
              f"{_label(_PILLARS, finding.get('pillar', ''), lang)} · "
              f"{_label(_SEVERITY_LABEL, finding.get('severity', ''), lang)}",
              ", ".join(_code(r["resource_id"]) for r in targets), ""]
    explanation = _safe_explanation(finding.get("explanation"))
    withheld_note = _WITHHELD.get(lang, _WITHHELD["ko"])
    if explanation:
        # Explanatory language is always a hypothesis, even for an observed metric/call.
        output += [f"_{copy[4]}_: {explanation}", ""]
    elif isinstance(finding.get("explanation"), str) and finding["explanation"].strip():
        output += [f"_{copy[4]}_: {withheld_note}", ""]
    refs = [evidence[eid] for eid in finding.get("evidence_ids", []) if eid in evidence]
    if refs:
        output += [f"| {copy[1]} | {copy[2]} | {copy[3]} |",
                   "| --- | --- | --- |"]
    for record in refs:
        scope = _scope_text(record, lang)
        rows = _facts(record.get("facts", {})) or [("unknown", None)]
        if len(rows) > 40:
            rows = rows[:40] + [(_TRUNCATED, f"{len(rows) - 40} rows omitted")]
        for index, (field, value) in enumerate(rows):
            # Source and scope print once per evidence record, not once per fact.
            head = (f"{_code(record['id'])} / {_cell(record.get('source', ''))} | "
                    f"{_cell(_scrubbed(scope)) if scope else ''}") if index == 0 else " | "
            output.append(f"| {head} | {_cell(field)} = {_cell(_scrubbed(value, field.rsplit('.', 1)[-1]))} |")
    prerequisites = finding.get("prerequisites", [])
    prerequisites = [p if isinstance(p, str) else _json(p) for p in
                     (prerequisites if isinstance(prerequisites, list) else [prerequisites])]
    # Model-authored prerequisites get the base renderer's read-only CLI rule. A
    # mutating command is withheld (never printed) and the section carries the mark.
    # Each remaining one passes the explanation prose guard (URLs, numerals, fences,
    # CLI words); an unsafe prerequisite is withheld exactly like an unsafe explanation.
    from .report import _MUTATING_MARK, _has_mutating_cli
    mutating = [p for p in prerequisites if _has_mutating_cli(p)]
    safe = [cell for p in prerequisites if not _has_mutating_cli(p)
            for cell in [_safe_explanation(p)] if cell]
    if safe:
        output += ["", f"**{copy[8]}:** " + ", ".join(safe)]
    if len(safe) < len(prerequisites) - len(mutating):
        output += ["", f"**{copy[8]}:** {withheld_note}"]
    if mutating:
        output += ["", _MUTATING_MARK.get(lang, _MUTATING_MARK["ko"]).strip()]
    return "\n".join(output)


def withheld(analysis):
    """Code-owned {id, reason} only; model prose never reaches rendering or persistence."""
    rows = analysis.get("rejected") if isinstance(analysis, dict) else None
    result = []
    for r in rows[:200] if isinstance(rows, list) else []:
        if not isinstance(r, dict):
            continue
        value = r.get("id")
        valid = isinstance(value, str) and re.fullmatch(r"[\w:.-]{1,128}", value)
        reason = r.get("reason")
        result.append({"id": value if valid else "invalid",
                       "reason": reason[:64] if isinstance(reason, str) else "invalid"})
    return result


def _coverage(bundle, analysis, copy, lang="ko"):
    diagnostics = {"coverage": bundle.get("coverage", {}), "gaps": bundle.get("gaps", []),
                   "degraded": list(bundle.get("degraded", [])) + list(analysis.get("degraded", [])),
                   "incomplete": list(bundle.get("incomplete", [])) + list(analysis.get("incomplete", [])),
                   "withheld": [f"{w['id']} ({w['reason']})" for w in withheld(analysis)]}
    rows = [f"**{copy[10]}**", "", "| Field | Value |", "| --- | --- |"]
    # Empty values are omitted: the UI reads a literal "degraded" anywhere as a warning, so the
    # row only appears when something actually degraded.
    rows.extend(f"| {_cell(k)} | {_cell(_flat(_scrubbed(v)), 2500)} |" for k, v in diagnostics.items()
                if v not in ([], {}, None))
    pillars = analysis.get("pillar_coverage")
    if isinstance(pillars, dict) and pillars:
        fixed = ("status", "findings", "rejected", "downgraded")
        rows += ["", "| Pillar | Status | Findings | Rejected | Downgraded | Other |",
                 "| --- | --- | --- | --- | --- | --- |"]
        for pillar, row in sorted(pillars.items(), key=lambda kv: str(kv[0])):
            row = row if isinstance(row, dict) else {}
            other = {k: v for k, v in row.items() if k not in fixed}
            cells = [_cell(_scrubbed(row[k])) if k in row else "—" for k in fixed]
            rows.append(f"| {_label(_PILLARS, pillar, lang)} | " + " | ".join(cells)
                        + f" | {_cell(_flat(_scrubbed(other))) if other else '—'} |")
    return "\n".join(rows)


def _reference(finding, copy, lang="ko"):
    # Same claim labeling as the full body: model prose is never shown as an unqualified assertion,
    # and guard-withheld prose is disclosed here too.
    claims = {"observation": copy[3], "hypothesis": copy[4],
              "sizing_candidate": copy[5], "coverage_gap": copy[6]}
    label = claims.get(finding.get("claim", "hypothesis"), copy[4])
    raw = finding.get("explanation")
    explanation = _safe_explanation(raw)
    if not explanation and isinstance(raw, str) and raw.strip():
        explanation = _WITHHELD.get(lang, _WITHHELD["ko"])
    # Explanatory language is always a hypothesis; the claim label states what kind of claim it is.
    prose = f"_{copy[4]}_: {explanation} " if explanation else ""
    return (f"- **{_label(_PILLARS, finding.get('pillar', ''), lang)} · "
            f"{_label(_SEVERITY_LABEL, finding.get('severity', ''), lang)}** — "
            f"{_cell(label)} — {prose}({copy[0]} {_code(finding.get('id', ''))})")


def render(catalog, bundle, analysis, *, lang="ko", invariant_md="", max_bytes=None):
    """Return catalog-ordered bodies; each admitted finding renders in full exactly once."""
    copy = _COPY.get(lang, _COPY["ko"])
    evidence = {e["id"]: e for e in bundle.get("evidence", [])}
    resources = {r["id"]: r for r in bundle.get("resources", [])}
    findings = _ordered(analysis)
    keys = [s["key"] for s in catalog]
    summary = "executive_summary" if "executive_summary" in keys else keys[0] if keys else None
    # Primary section: the pillar's dedicated section when cataloged, else the first catalog
    # section covering the pillar (else the summary).
    home = {id(f): _DEDICATED.get(f.get("pillar")) if _DEDICATED.get(f.get("pillar")) in keys
            else next((k for k in keys if f.get("pillar") in _SECTION_PILLARS.get(k, ())), summary)
            for f in findings}
    top, output = {id(f) for f in findings[:12]}, {}
    for key in keys:
        if key == "intended_vs_actual":
            output[key] = invariant_md
            continue
        parts = []
        shown = [f for f in findings if home[id(f)] == key
                 or (key in {"executive_summary", "recommendations"} and id(f) in top)
                 or f.get("pillar") in _SECTION_PILLARS.get(key, ())]
        # Code-owned severity marker (report.py _render_intended_vs_actual parity) so the UI
        # section icon reflects every admitted finding the section shows, in full or by
        # reference; model text can never forge it (cells escape [ ]).
        ranks = [_SEVERITY.get(f.get("severity"), 5) for f in shown]
        if ranks and min(ranks) <= _SEVERITY["high"]:
            parts.append("[Critical]")
        elif ranks and min(ranks) <= _SEVERITY["medium"]:
            parts.append("[Warning]")
        for f in findings:
            if home[id(f)] == key:
                parts.append(_finding_body(f, evidence, resources, copy, lang=lang))
            elif (key in {"executive_summary", "recommendations"} and id(f) in top
                    or f.get("pillar") in _SECTION_PILLARS.get(key, ())):
                parts.append(_reference(f, copy, lang))
                capability = f.get("verification")
                if key == "recommendations" and capability in _VERIFY:
                    parts.append(f"**{copy[9]}:** `{_VERIFY[capability]}`")
        output[key] = "\n\n".join(parts) or copy[7]
        if key == summary:
            # Missing discovery/sizing prerequisites are stated once, not per section.
            output[key] += "\n\n" + _coverage(bundle, analysis, copy, lang)
    bodies = {key: _swept(output[key], lang) for key in keys}
    # Trim the largest sections first; the deterministic intended-vs-actual verdicts go last.
    limit = MAX_MARKDOWN_BYTES if max_bytes is None else max_bytes
    for key in sorted(keys, key=lambda k: (k == "intended_vs_actual", -len(bodies[k].encode()))):
        over = sum(len(b.encode()) for b in bodies.values()) - limit
        if over <= 0:
            break
        bodies[key] = _trim(bodies[key], len(bodies[key].encode()) - over, lang)
    return [(key, bodies[key]) for key in keys]


def _trim(body, limit, lang):
    """Reserve room for the marker and a read-only sweep mark; cut at a line boundary if any."""
    kept = body.encode()[:max(0, limit - 256)].decode(errors="ignore")
    cut = kept.rfind("\n")
    note = f" {_SIZE_NOTE.get(lang, _SIZE_NOTE['ko'])}"
    return _swept((kept[:cut + 1] if cut >= 0 else kept) + SIZE_MARK + note, lang)


# Report titles are also used in digests. Only code-owned topics, derived from
# cited, admitted evidence, can appear here. Resource names and model prose stay in the body.
_TOPICS = {
    "storage": ("저장 암호화가 꺼진 리소스 확인", "Resource found with storage encryption disabled", "保存時の暗号化が無効なリソースを確認", "发现未启用存储加密的资源"),
    "posture": ("보안 탐지 범위 확인", "Verify security detection coverage", "セキュリティ検出範囲を確認", "核实安全检测覆盖范围"),
    "backup": ("백업 보존과 복구 목표 검토", "Compare backup retention with recovery objectives", "バックアップ保持と復旧目標を確認", "对照备份保留期与恢复目标"),
    "cost": ("비용 귀속과 절감 근거 검토", "Review cost attribution and savings evidence", "費用の帰属と削減根拠を確認", "核查成本归属与节省依据"),
    "metrics": ("워크로드 부하와 용량 검토", "Review workload demand and capacity", "負荷と容量を確認", "核查工作负载与容量"),
    "calls": ("서비스 호출 경로 확인", "Verify service call paths", "サービス呼び出し経路を確認", "核实服务调用路径"),
}
_SOURCE_TAGS = {"inventory": "AWS Inventory", "cloudwatch": "CloudWatch", "xray": "X-Ray",
                "cost": "Cost Explorer", "compute_optimizer": "Compute Optimizer"}
_RESOURCE_TAGS = {"rds": "Amazon RDS", "rds_cluster": "Amazon RDS", "ec2": "Amazon EC2",
                  "ebs_volume": "Amazon EBS", "ecs_service": "Amazon ECS"}


def _finding_topic(finding, records):
    pillar = finding["pillar"]
    kinds = {r["kind"] for r in records}
    inventory = [r.get("facts", {}) for r in records if r["kind"] == "inventory"
                 and r.get("fresh") is True and r.get("coverage", {}).get("complete") is True
                 and len(finding.get("resource_ids", [])) == 1
                 and r.get("resource_ids") == finding["resource_ids"]]
    if pillar == "security":
        flags = [f[k] for f in inventory for k in ("storage_encrypted", "encrypted") if k in f]
        if flags and all(value is False for value in flags):
            return "storage"
        if any(r.get("source") == "posture" for r in records):
            return "posture"
    if pillar == "reliability" and any("backup_retention_period" in f or "backup_retention" in f for f in inventory):
        return "backup"
    if pillar == "cost_optimization" and ("provider_sizing" in kinds or any(r.get("source") == "cost" for r in records)):
        return "cost"
    if pillar in {"performance_efficiency", "sustainability"} and "metrics" in kinds:
        return "metrics"
    if "observed_call" in kinds:
        return "calls"
    return None


def customer_explanation(finding, analysis):
    """Only readable, admitted assessments support a customer-facing risk."""
    if finding.get("claim") == "coverage_gap":
        return ""
    text = finding.get("explanation")
    if finding.get("claim") != "observation":
        text = (analysis.get("editor_plan") or {}).get("paragraphs", {}).get(finding["id"], text)
    return _safe_explanation(text)


def title_and_tags(bundle, analysis, *, lang="ko"):
    findings = _ordered(analysis)
    titles = {"ko": "AWS 계정 종합진단 — Well-Architected 6대 영역 점검",
              "en": "AWS account assessment — six Well-Architected pillars",
              "zh": "AWS 账户综合诊断 — Well-Architected 六大支柱",
              "ja": "AWS アカウント総合診断 — Well-Architected の六つの柱"}
    tags = list(dict.fromkeys(f["pillar"] for f in findings if f.get("pillar") in _PILLARS))
    title = titles.get(lang, titles["ko"])
    index = {r["id"]: r for r in bundle.get("resources", [])}
    evidence = {r["id"]: r for r in bundle.get("evidence", [])}
    topics = []
    service_tags = []
    lead_severity = None
    for finding in findings:
        records = [evidence[k] for k in finding.get("evidence_ids", []) if k in evidence]
        if not records or not customer_explanation(finding, analysis):
            continue
        if lead_severity is None:
            lead_severity = finding["severity"]
        topic = _finding_topic(finding, records)
        if topic and finding["severity"] == lead_severity and topic not in topics:
            topics.append(topic)
        service_tags.extend(_RESOURCE_TAGS.get(index[k]["kind"])
                            for k in finding.get("resource_ids", []) if k in index)
        service_tags.extend(_SOURCE_TAGS.get(r.get("source")) for r in records)
    if topics:
        i = ("ko", "en", "ja", "zh").index(lang) if lang in titles else 0
        title = _TOPICS[topics[0]][i] + " · " + title
    services = list(dict.fromkeys(t for t in service_tags if t))[:3]  # leave room for a manual tag
    tags = services + tags
    return {"title": title, "tags": tags or ["diagnosis"]}
