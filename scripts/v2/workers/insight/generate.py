"""Synthesize collected operational signals into 3-5 prioritized admin bullets.

One Bedrock call (default Haiku — cheap/fast) over a NON-PII signal summary; the model merges/ranks
and writes admin-facing observations. A deterministic fallback (top signals by severity) runs when
Bedrock fails or returns unparseable output, so the panel is NEVER blank. `invoke` is injectable.
"""
import json
import logging
import os

_MAX_BULLETS = 5
_MAX_DETAIL = 280
_SEV_RANK = {"critical": 0, "warning": 1, "info": 2}
_VALID_SEV = set(_SEV_RANK)

_PROMPT = (
    "당신은 AWS/Kubernetes 운영을 보는 수석 SRE다. 아래 수집된 비민감 신호(K8s 이벤트·CloudWatch 알람·비용 이상)에서 "
    "운영자에게 즉시 의미있는 특이점만 3~5개로 추려 JSON으로만 답하라. 중복은 병합하고, 심각한 것부터 정렬하라. "
    "추측·날조 금지(주어진 신호만), 자동 변경 제안 금지(관찰/권고만). 신호가 없으면 빈 배열. "
    ' 형식: {"insights":[{"severity":"critical|warning|info","title":"짧은 제목","detail":"한 줄 근거","source":"k8s|cloudwatch|cost"}]}\n\n'
    "신호:\n"
)


def _bedrock_invoke(prompt):
    """Default Bedrock invoke (Haiku). Returns the model's text. Lazy boto3 import."""
    import boto3
    region = os.environ.get("AWS_REGION", "ap-northeast-2")
    # global inference profile (matches the codebase convention + the worker IAM bedrock allowlist
    # arn:aws:bedrock:*:*:inference-profile/global.anthropic.*); Haiku = cheap/fast for short synthesis.
    model = os.environ.get("INSIGHT_MODEL_ID", "global.anthropic.claude-haiku-4-5-20251001-v1:0")
    body = {"anthropic_version": "bedrock-2023-05-31", "max_tokens": 1200,
            "messages": [{"role": "user", "content": prompt}]}
    resp = boto3.client("bedrock-runtime", region_name=region).invoke_model(
        modelId=model, body=json.dumps(body))
    payload = json.loads(resp["body"].read())
    return "".join(p.get("text", "") for p in payload.get("content", []))


def _all_items(signals):
    out = []
    for s in signals or []:
        for it in (s.get("items") or []):
            out.append({**it, "source": it.get("source") or s.get("source")})
    return out


def _clean(bullet):
    sev = bullet.get("severity") if bullet.get("severity") in _VALID_SEV else "info"
    return {"severity": sev, "title": str(bullet.get("title") or "")[:120],
            "detail": str(bullet.get("detail") or "")[:_MAX_DETAIL],
            "source": bullet.get("source") or "", "refs": bullet.get("refs") or {}}


def _fallback(items):
    """Deterministic: top signals by severity become bullets (never blank when signals exist)."""
    ranked = sorted(items, key=lambda i: _SEV_RANK.get(i.get("severity"), 3))
    return [_clean(i) for i in ranked[:_MAX_BULLETS]]


def synthesize(signals, invoke=None):
    """Return {status, insights:[{severity,title,detail,source,refs}], model}. Never raises."""
    items = _all_items(signals)
    if not items:
        return {"status": "succeeded", "model": None,
                "insights": [{"severity": "info", "title": "특이사항 없음",
                              "detail": "수집된 K8s/CloudWatch/비용 신호에서 주목할 이상이 없습니다.",
                              "source": "", "refs": {}}]}
    invoke = invoke or _bedrock_invoke
    summary = json.dumps([{"severity": i.get("severity"), "title": i.get("title"),
                           "detail": i.get("detail"), "source": i.get("source")} for i in items],
                         ensure_ascii=False)[:6000]
    try:
        text = invoke(_PROMPT + summary)
        start, end = text.find("{"), text.rfind("}")
        parsed = json.loads(text[start:end + 1]) if start >= 0 and end > start else {}
        bullets = parsed.get("insights")
        if not isinstance(bullets, list) or not bullets:
            raise ValueError("no insights array")
        cleaned = [_clean(b) for b in bullets][:_MAX_BULLETS]
        cleaned.sort(key=lambda b: _SEV_RANK.get(b["severity"], 3))
        return {"status": "succeeded", "model": "bedrock", "insights": cleaned}
    except Exception as e:  # noqa: BLE001 — fall back to deterministic top-signals (never blank)
        logging.warning("[insight.generate] synthesis fell back: %s", e)
        return {"status": "partial", "model": "fallback", "insights": _fallback(items)}
