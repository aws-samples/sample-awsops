"""Bounded report analysis: specialists, admission, review and one evidence pass."""
from concurrent.futures import ThreadPoolExecutor, as_completed
import hashlib
import json
import re

from . import pillar_agents as agents
from .budget import BudgetExceeded
from .evidence import EvidenceIndex, PILLARS, _NUMBER


MAX_CONCURRENCY = 4
MAX_FOLLOW_UP_REQUESTS = 4
MAX_RERUNS = 2
_IDENTIFIER_TOKEN = re.compile(
    r"\b(?:db\.)?[a-z][a-z0-9-]*\d[a-z0-9-]*\.(?:nano|micro|small|medium|large|\d*xlarge|metal)\b"
    r"|\b[a-z]{2}(?:-gov)?-[a-z]+-\d\b"
    r"|\bsummary-[0-9a-f]{24}\b"
    r"|\b[a-z]{1,7}:[0-9a-f]{32}\b", re.IGNORECASE)
# Opaque AWS resource ids carry a fixed lowercase prefix; any other word-hyphen-hex token
# ("usd-00000500") is a numeric assertion, not an identifier.
_RESOURCE_ID = re.compile(
    r"\b(?:i|vol|sg|subnet|vpc|eni|ami|snap|rtb|igw|nat|acl|vpce|tgw|pcx|eipalloc|lt|db|cluster|prx)"
    r"-[0-9a-f]{8,17}\b", re.IGNORECASE)


def _failure_reason(exc):
    if isinstance(exc, BudgetExceeded):
        return "budget_exhausted"
    if isinstance(exc, agents.ModelUnsupported):
        return "unsupported_model"
    return "output_truncated" if isinstance(exc, agents.OutputTruncated) else "model_failed"


def _fingerprint(index):
    """Compare scoped facts and qualification rather than capture-generated IDs."""
    context = index.model_context()
    def key(value):
        return json.dumps(value, sort_keys=True, ensure_ascii=False, separators=(",", ":"))

    resources = {
        row["id"]: key({name: value for name, value in row.items() if name != "id"})
        for row in context["resources"]
    }
    groups = {}
    identities = {}
    for row in context["evidence"]:
        facts = {name: value for name, value in row.items()
                 if name not in {"id", "captured_at", "resource_ids", "fresh", "coverage"}}
        facts["resource_ids"] = sorted(resources[ref] for ref in row["resource_ids"])
        identity = key(facts)
        identities[row["id"]] = identity
        groups.setdefault(identity, []).append(row)
    qualifications = {}
    for identity, rows in groups.items():
        # Refresh retains stale first-pass facts as history. When an equivalent
        # current record exists, that historical duplicate adds no new evidence.
        current = [row for row in rows if not (
            isinstance(row["coverage"], dict)
            and row["coverage"].get("retained_previous") is True
            and row["coverage"].get("status") in {"refresh_pending", "read_failed"})]
        qualifications[identity] = sorted({
            key({"identity": identity, "fresh": row["fresh"], "coverage": row["coverage"]})
            for row in current or rows
        })
    evidence = {value for values in qualifications.values() for value in values}
    relationships = {
        key({"source": resources[row["source"]], "target": resources[row["target"]],
             "kind": row["kind"], "evidence": sorted({
                 value for ref in row["evidence_ids"]
                 for value in qualifications[identities[ref]]
             })})
        for row in context["relationships"]
    }
    material = {"resources": sorted(set(resources.values())), "evidence": sorted(evidence),
                "relationships": sorted(relationships)}
    return hashlib.sha256(json.dumps(material, sort_keys=True, ensure_ascii=False,
                                     separators=(",", ":")).encode()).hexdigest()


def _validate_review(value, findings, index):
    keys = {"finding_ids", "reject_ids", "follow_up", "rerun_pillars", "issues"}
    if not isinstance(value, dict) or set(value) - {"_stage"} != keys:
        index._reject("", "invalid_review_shape", "review")
        return None
    known = {row["id"] for row in findings}
    for key in ("finding_ids", "reject_ids"):
        values = value[key]
        if (not isinstance(values, list) or any(not isinstance(item, str) or item not in known for item in values)
                or len(set(values)) != len(values)):
            index._reject("", "unknown_review_finding", "review")
            return None
    if set(value["finding_ids"]) & set(value["reject_ids"]):
        index._reject("", "contradictory_review_selection", "review")
        return None
    pillars = value["rerun_pillars"]
    if (not isinstance(pillars, list) or any(item not in PILLARS for item in pillars)
            or len(set(pillars)) != len(pillars)):
        index._reject("", "invalid_review_pillar", "review")
        return None
    if len(pillars) > MAX_RERUNS:
        # Fail closed like an over-limit follow_up: a rerun request is never silently trimmed.
        index._reject("", "review_rerun_limit", "review")
        return None
    issues = value["issues"]
    if not isinstance(issues, list) or len(issues) > 16:
        index._reject("", "invalid_review_issue", "review")
        return None
    kept_issues = []
    for item in issues:
        # Identifier tokens (m5.large, ap-northeast-2, opaque IDs) are not numeric assertions.
        if (not isinstance(item, str) or len(item) > 1000
                or _NUMBER.search(_RESOURCE_ID.sub(" ", _IDENTIFIER_TOKEN.sub(" ", item)))):
            index._reject("", "invalid_review_issue", "review")
        else:
            kept_issues.append(item)
    if not isinstance(value["follow_up"], list) or len(value["follow_up"]) > 16:
        index._reject("", "invalid_follow_up", "review")
        return None
    requests = []
    seen = set()
    for requested in value["follow_up"]:
        admitted = index.validate_request(requested)  # records its own rejection reason
        if admitted is None:
            continue
        key = (admitted["capability"], tuple(admitted["resource_ids"]))
        if key not in seen:
            requests.append(admitted)
            seen.add(key)
    if len(requests) > MAX_FOLLOW_UP_REQUESTS:
        index._reject("", "follow_up_limit", "review")
        return None
    return {**value, "issues": kept_issues, "follow_up": requests, "rerun_pillars": pillars}


def _admit_outputs(outputs, index, coverage, degraded, incomplete):
    admitted = []
    for pillar in PILLARS:
        if pillar not in outputs:
            continue
        value = outputs[pillar]
        if not isinstance(value, dict) or not isinstance(value.get("findings"), list):
            coverage[pillar] = {"status": "failed", "findings": 0, "rejected": 0}
            degraded.append(f"pillar:{pillar}:invalid_output")
            incomplete.append(f"pillar:{pillar}:uncompleted")
            continue
        before = len(index.rejected)
        before_downgrades = len(index.downgraded)
        rows = value["findings"]
        if len(rows) > agents.MAX_FINDINGS:
            coverage[pillar] = {"status": "failed", "findings": 0, "rejected": len(rows)}
            degraded.append(f"pillar:{pillar}:finding_limit")
            continue
        found = []
        for row in rows:
            valid = index.validate_finding(row, pillar=pillar)
            if valid is not None:
                found.append(valid)
        rejected = len(index.rejected) - before
        downgraded = len(index.downgraded) - before_downgrades
        coverage[pillar] = {
            "status": "partial" if rejected or downgraded else "completed",
            "findings": len(found), "rejected": rejected, "downgraded": downgraded,
        }
        if rejected or downgraded:
            degraded.append(f"pillar:{pillar}:semantic_validation")
        context_coverage = value.get("_stage", {}).get("context_coverage", {})
        if context_coverage.get("incomplete"):
            incomplete.append(f"pillar:{pillar}:model_context_partial")
        admitted.extend(found)
    return admitted


def _notify(progress, stage):
    if progress is not None:
        try:
            progress(stage)
        except Exception:  # a heartbeat failure never aborts analysis
            pass


def _run_specialists(pillars, index, *, model_id, budget, lang, coverage, stages, degraded, incomplete,
                     progress=None):
    outputs = {}
    # At most four owned threads and six/two scheduled calls; no nested pools.
    with ThreadPoolExecutor(max_workers=MAX_CONCURRENCY) as pool:
        futures = {pool.submit(agents.analyze, pillar, index, model_id=model_id, budget=budget, lang=lang): pillar
                   for pillar in pillars}
        for future in as_completed(futures):
            pillar = futures[future]
            try:
                value = future.result()
                outputs[pillar] = value
                stages.append(value.get("_stage", {
                    "stage": f"specialist:{pillar}", "status": "succeeded", "model_id": model_id,
                    "prompt_version": agents.PROMPT_VERSION, "schema_version": agents.SCHEMA_VERSION,
                }))
            except Exception as exc:
                reason = _failure_reason(exc)
                coverage[pillar] = {"status": "failed", "findings": 0, "rejected": 0}
                degraded.append(f"pillar:{pillar}:{reason}")
                incomplete.append(f"pillar:{pillar}:uncompleted")
                stages.append({"stage": f"specialist:{pillar}", "status": "failed",
                               "reason": reason, "model_id": model_id,
                               "prompt_version": agents.PROMPT_VERSION,
                               "schema_version": agents.SCHEMA_VERSION})
            _notify(progress, pillar)  # caller thread only: the heartbeat shares the DB connection
    return _admit_outputs(outputs, index, coverage, degraded, incomplete)


def _run_review(findings, index, *, model_id, budget, lang, stages, degraded, incomplete, final=False):
    stage = "final_review" if final else "review"
    try:
        value = agents.review(findings, index, model_id=model_id, budget=budget, final=final, lang=lang)
        stages.append(value.get("_stage", {
            "stage": stage, "status": "succeeded", "model_id": model_id,
            "prompt_version": agents.PROMPT_VERSION, "schema_version": agents.SCHEMA_VERSION,
        }))
        valid = _validate_review(value, findings, index)
        if valid is None:
            # Fail closed: an invalid review can only remove findings. Keep only findings the
            # reviewer explicitly selected and did not also reject.
            degraded.append(f"{stage}:invalid_selection")
            raw = value if isinstance(value, dict) else {}
            ids = {k: {i for i in raw[k] if isinstance(i, str)} if isinstance(raw.get(k), list) else set()
                   for k in ("finding_ids", "reject_ids")}
            keep = ids["finding_ids"] - ids["reject_ids"]
            valid = {"status": "invalid", "follow_up": [], "rerun_pillars": [], "issues": []}
        else:
            keep = set(valid["finding_ids"])
        for row in findings:
            if row["id"] not in keep:
                index._reject(row["id"], "review_withheld")
        retained = [row for row in findings if row["id"] in keep]
        if valid.get("status") == "invalid":
            return retained, valid
        if valid["issues"]:
            degraded.append(f"{stage}:unresolved_issues")
        return retained, {**{key: value for key, value in valid.items() if key != "_stage"}, "status": "completed"}
    except Exception as exc:
        reason = _failure_reason(exc)
        degraded.append(f"{stage}:{reason}")
        incomplete.append(f"{stage}:uncompleted")
        stages.append({"stage": stage, "status": "failed", "reason": reason, "model_id": model_id,
                       "prompt_version": agents.PROMPT_VERSION, "schema_version": agents.SCHEMA_VERSION})
        return findings, {"status": "failed", "follow_up": [], "rerun_pillars": [], "issues": []}


def run(bundle, *, account, tier, model_id, budget, collect_follow_up=None, lang="en", progress=None):
    agents.validate_language(lang)
    if tier not in {"light", "mid", "deep"}:
        raise ValueError("unknown diagnosis tier")
    if budget.tier != tier:
        raise ValueError("analysis tier must match handler budget")
    index = EvidenceIndex(bundle, account)
    degraded, incomplete = list(index.degraded), list(index.incomplete)
    coverage, stages = {}, []
    try:
        agents.validate_provider()
        agents.model_capabilities(model_id)
    except agents.ModelUnsupported as exc:
        reason = str(exc)
        # Only Bedrock Claude Sonnet/Opus 5.5 run the evidence loop (e.g. a bedrock_openai or
        # anthropic_api model_provider): one visible degraded marker, no model calls.
        return {
            "findings": [], "rejected": [], "passes": 0,
            "pillar_coverage": {p: {"status": "failed", "findings": 0, "rejected": 0} for p in PILLARS},
            "review": {"status": "failed", "follow_up": [], "rerun_pillars": [], "issues": []},
            "degraded": list(dict.fromkeys([*degraded, f"analysis:{reason}"])),
            "incomplete": list(dict.fromkeys([*incomplete, "six_pillars"])),
            "model_stages": [{"stage": "analysis", "status": "failed", "reason": reason,
                              "model_id": model_id, "prompt_version": agents.PROMPT_VERSION,
                              "schema_version": agents.SCHEMA_VERSION}],
            "prompt_version": agents.PROMPT_VERSION, "schema_version": agents.SCHEMA_VERSION,
            "budget": budget.snapshot(), "evidence_bundle": index.admitted_bundle(),
        }
    findings = _run_specialists(
        PILLARS, index, model_id=model_id, budget=budget, lang=lang, coverage=coverage,
        stages=stages, degraded=degraded, incomplete=incomplete, progress=progress)
    findings, review = _run_review(
        findings, index, model_id=model_id, budget=budget, lang=lang, stages=stages,
        degraded=degraded, incomplete=incomplete)
    _notify(progress, "review")
    passes = 1
    requests = review.get("follow_up", [])
    reruns = review.get("rerun_pillars", [])
    if reruns and not requests:
        # A rerun is only run with new evidence; disclose the unmet reviewer request.
        incomplete.append("rerun:no_follow_up")
    if requests:
        if tier == "light" or collect_follow_up is None:
            incomplete.append("follow_up:unavailable")
        elif not reruns:
            incomplete.append("follow_up:no_targeted_pillars")
        elif budget.remaining() < 130:
            incomplete.append("follow_up:budget_exhausted")
        else:
            try:
                merged = collect_follow_up(requests)
                next_index = EvidenceIndex(merged, account)
                if _fingerprint(next_index) == _fingerprint(index):
                    incomplete.append("follow_up:no_progress")
                else:
                    passes = 2
                    # Revalidate retained first-pass findings after evidence refresh;
                    # stale/removed evidence cannot survive on its earlier admission.
                    retained = []
                    for row in findings:
                        if row["pillar"] not in reruns:
                            valid = next_index.validate_finding(row)
                            if valid is not None:
                                retained.append(valid)
                    # Pillars not rerun keep pass-1 coverage only if revalidation kept every finding.
                    for pillar, state in coverage.items():
                        if pillar in reruns or state.get("status") == "failed":
                            continue
                        kept = sum(row["pillar"] == pillar for row in retained)
                        if kept != state.get("findings"):
                            coverage[pillar] = {**state, "status": "partial", "findings": kept,
                                                "revalidation_dropped": state.get("findings", 0) - kept}
                            degraded.append(f"pillar:{pillar}:revalidation_dropped")
                    # Pass-1 downgrades stay downgrades; only rejections join the rejected history.
                    first_rejected, first_downgraded = index.rejected, index.downgraded
                    index = next_index
                    index.rejected.extend(first_rejected)
                    index.downgraded.extend(first_downgraded)
                    degraded.extend(index.degraded)
                    incomplete.extend(index.incomplete)
                    findings = retained + _run_specialists(
                        reruns, index, model_id=model_id, budget=budget, lang=lang, coverage=coverage,
                        stages=stages, degraded=degraded, incomplete=incomplete, progress=progress)
                    findings, review = _run_review(
                        findings, index, model_id=model_id, budget=budget, lang=lang, stages=stages,
                        degraded=degraded, incomplete=incomplete, final=True)
                    _notify(progress, "final_review")
            except Exception as exc:
                reason = "budget_exhausted" if isinstance(exc, BudgetExceeded) else "collection_failed"
                degraded.append(f"follow_up:{reason}")
    # Final review cannot request a third pass. Retain unresolved questions visibly.
    if passes == 2 and review.get("follow_up"):
        incomplete.append("follow_up:pass_limit")
    if passes == 2 and review.get("rerun_pillars"):
        incomplete.append("rerun:pass_limit")
    if index.rejected:
        degraded.append("evidence:rejected")
    if index.downgraded:
        degraded.append("evidence:downgraded")
    return {
        "findings": findings, "pillar_coverage": coverage,
        "rejected": [*index.rejected, *index.downgraded], "review": review,
        "passes": passes, "degraded": list(dict.fromkeys(degraded)),
        "incomplete": list(dict.fromkeys(incomplete)), "model_stages": stages,
        "prompt_version": agents.PROMPT_VERSION, "schema_version": agents.SCHEMA_VERSION,
        "budget": budget.snapshot(),
        "evidence_bundle": index.admitted_bundle(),
    }
