# Plan — W2b: AlertValidation worker + SM splice + incidents.tf

> 원천 / Source: spec §6 + W2 P2 gate (codex-weighted; glm/agy/opus). **Depends on W2a** (trigger_event column + AlarmArn must ship first). W2a = data foundation.
> Scope: **W2b** — connector_invoke 공유 추출 + AlertValidation 워커(신호 번들 + Haiku verdict + 억제 안전모델) + SM ASL 스플라이스 + incidents.tf(Lambda/IAM/SSM). 전부 `local.il` 게이트(OFF=0/$0). terraform apply는 컨트롤러; PR은 코드/.tf만.
> Posture: 신호 read-only(ADR-006); SNS publish=W3. AWS mutation/autonomy 없음(ADR-005).
> Branch: TBD (off W2a or base after W2a merges). TDD red→green→commit.

## P2-gate fixes baked in (코드 검증됨)
- **Haiku modelId default = `global.anthropic.claude-haiku-4-5-20251001-v1:0`** (repo 우세형 7×; bare는 ap-northeast-2에서 ValidationException). env `ALERT_VALIDATION_MODEL_ID`.
- **ASL `ResultPath: "$.validation"`** + Choice on `$.validation.decision` (기존 모든 스테이지가 ResultPath로 job_id/incident_id 보존 — agy CRITICAL, ASL Comment 확인). Task 출력이 state 입력을 덮어쓰지 않게.
- **suppression_severity = 정규화된 snapshot.severity** (재유도 금지, 드리프트 회피). critical → 절대 억제. CloudWatch ALARM→critical이므로 W2에선 CloudWatch는 항상 에스컬레이트(fail-closed; 태그 기반 opt-in은 후속). Alertmanager warning/info는 억제 적격(주 노이즈원).
- **Haiku 입력 신호 = `summarize_result` 출력만**(label NAME/count/boolean; 원시 로그라인·트레이스·행 값 절대 금지). 프롬프트 본문은 isolatePayload.block만.
- **signal-failure 회계**: 실패=non-2xx/timeout; 실패 소스 추적; **전부 실패 → uncertain**.
- **global wall-clock deadline**(per-call 아님): 신호 수집 전체에 `ALERT_VALIDATION_DEADLINE_S`(기본 25) 적용(collect_datasources `_DS_DEADLINE_S` 미러).
- **IAM least-privilege**: `bedrock:InvokeModel` on `arn:aws:bedrock:*:*:inference-profile/global.anthropic.claude-haiku-*`(wildcard 금지) + `foundation-model/anthropic.*`; connector `lambda:InvokeFunction` 5 ARN 스코프.
- **account scoping**: topology blast-radius SQL에 account_id 바인딩(graph-query 'self' 하드코딩 → 파라미터화; 스키마 변경 없음).
- high-confidence threshold ≥0.85(SSM 튜너블).

## Tasks (요약 — 구현 시 W2a처럼 세분 TDD)
1. **connector_invoke 공유 추출** (`scripts/v2/workers/connector_invoke.py` + test; `diagnosis/sources.py` import 재바인딩, test_datasources green 유지).
2. **alert_validation.py** — load trigger_event(pg8000, degrade-safe) → 신호 번들(topology Aurora account-scoped + CloudWatch GetMetricData boto3 + connector fan-out best-effort via connector_invoke, global deadline, summarize-only) → Haiku(`_bedrock_invoke` 미러, dated model id, `_redact`, isolated block only, 관대한 JSON, fail-closed) → 억제 안전모델(normalized severity·never-critical·shadow `ALERT_SUPPRESSION_ENFORCE`·≥2 corroborating·≥0.85·signal-failure→uncertain·all-fail→uncertain) → 기록(incident_findings sub_agent='alert-validator' + incidents.validation/status) → return `{verdict, decision}`. + test (mock bedrock/connector/pg8000).
3. **SM ASL 스플라이스** (incident.asl.json): TriageDecision.Default→AlertValidation; AlertValidation Task(`Resource ${alert_validation_fn_arn}`, **ResultPath `$.validation`**, Retry/Catch→StageFailed, Next→ValidationDecision); ValidationDecision Choice(`$.validation.decision`=='suppress'→Suppressed, Default→Lead); Suppressed(Succeed). + test_incident.py 그래프 단언.
4. **incidents.tf** — incident_alert_validation Lambda(count=local.il, role=incident_lambda, py3.12 arm64 512MB pg8000-layer vpc, handler alert_validation.lambda_handler) + archive_file.incident_src에 alert_validation.py+connector_invoke.py source{} + IAM(bedrock scoped + connector 5 ARN) + incident_sfn InvokeIncidentLambdas에 ARN 추가 + SSM 튜너블(validation-deadline-s/suppress-confidence-threshold/suppression-enforce, count=local.il ignore_changes) + local.inc_env_base에 *_PARAM + ALERT_VALIDATION_MODEL_ID env + templatefile var alert_validation_fn_arn. `terraform fmt/validate`; no apply.

## Out of scope
SNS publish=W3. source_allowlist UX=W4. CloudWatch 태그 기반 억제 opt-in=후속. AWS mutation 없음(ADR-005).
