# AI Insights (Overview 대시보드) — 설계 (Design)

> 작성일: 2026-06-24 · 브랜치: `feat/v2-ai-insights` · base: `origin/feat/v2-architecture-design`
> 게이트: `ai_insights_enabled` (기본 false → 0 리소스/$0). read-only (ADR-007 governed reads; ADR-005 무관).

## 1. 문제 (Problem)

Overview 대시보드는 KPI/차트만 보여줄 뿐, admin이 **지금 무엇이 특이한지**(운영 이상 징후)를 한눈에 못 본다. 전체 AI 진단(WADD 리포트)은 무겁고 on-demand다. 가볍고 항상-신선한 **"AI 인사이트"** — 최근 운영 특이점을 3~5개 우선순위 불릿으로 — 이 필요하다. (참고: llm-monitor류 "AI insight" 패널.)

## 2. 목표 / 비목표

**Goals**
- 운영 특이점을 **K8s 이벤트 · CloudWatch 알람/이상 · 비용 이상** 3개 소스에서 수집해 LLM이 admin용 3~5개 우선순위 불릿으로 종합.
- 주기 워커가 생성·캐시, 대시보드는 캐시 read + admin 수동 새로고침.
- 전부 read-only. 게이트 OFF 기본 → $0.

**Non-goals (v1)**
- 자동 조치/리메디에이션 (ADR-005 FROZEN). 인사이트는 **권고/관찰만**.
- 미사용 리소스·보안 갭·진단 drift 등 기존-재사용 신호 (후속 enrich 가능; v1은 위 3소스).
- 실시간 스트리밍/푸시 알림 (SNS 진단 알림과 별개).

## 3. 결정 (확정)

| # | 결정 | 비고 |
|---|------|------|
| D1 | v1 소스 = K8s 이벤트 + CloudWatch 이상 + 비용 이상 | 운영 "특이점" 중심 |
| D2 | 생성 = 주기 워커 잡 + admin 수동 새로고침 | egress+Bedrock → 워커(thin-BFF) |
| D3 | LLM 종합 + **결정론 폴백** | Bedrock 실패 시 raw 상위 이상 불릿화(빈칸 없음) |
| D4 | 캐시 테이블 `ai_insights`, 대시보드는 최신 read | 히스토리 보존 |
| D5 | 게이트 `ai_insights_enabled` (기본 false) | $0/무변경 |

## 4. 데이터 모델

ULID 마이그레이션 `terraform/foundation/migrations/<ULID>_ai_insights.sql` (schema.sql append 아님):

```sql
CREATE TABLE IF NOT EXISTS ai_insights (
  id            bigserial   PRIMARY KEY,
  account_id    text        NOT NULL DEFAULT 'self',
  status        text        NOT NULL CHECK (status IN ('succeeded','partial','failed')),
  insights      jsonb       NOT NULL DEFAULT '[]'::jsonb,  -- [{severity,title,detail,source,refs}]
  sources_used  jsonb       NOT NULL DEFAULT '{}'::jsonb,  -- {k8s_events:n, cw:n, cost:n}
  model         text,
  error         text,
  generated_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS ai_insights_latest_idx ON ai_insights (account_id, generated_at DESC);
```
- `severity ∈ {critical, warning, info}`; `source ∈ {k8s, cloudwatch, cost}`; `refs` = 비민감 식별자(cluster/ns/pod, alarm name, service).
- 대시보드 read = `... WHERE account_id='self' ORDER BY generated_at DESC LIMIT 1`.

## 5. 수집기 (`scripts/v2/workers/insight/`, read-only · bounded · never-raise)

각 수집기는 `{source, items:[{severity,title,detail,refs}], notes}` 구조 반환. PII 방어 redaction(이벤트 메시지·라벨 값 등).

- **`k8s_events.py`** — 온보딩 EKS 클러스터별 k8s API(`/api/v1/events`, presigned-STS 토큰; `istio_read_mcp` 패턴 재사용)로 최근 **Warning** 이벤트 수집. 주목 reason: `OOMKilling/OOMKilled, FailedScheduling, BackOff/CrashLoopBackOff, Failed, Unhealthy, FailedMount, Evicted, NodeNotReady`. 시간창(기본 1h)·건수(클러스터당 ≤N) bounded, reason×object 집계.
- **`cw_anomalies.py`** — `cloudwatch:DescribeAlarms`(StateValue=ALARM, AlarmTypes 알람) + 선택적 주요 지표 급변. 알람명·네임스페이스·차원만(값 redaction). bounded.
- **`cost_anomalies.py`** — Cost Explorer `GetCostAndUsage`(일별·서비스별) day-over-day 급증 탐지(임계 %·절대액) + Bedrock 비용(ai_cost 재사용). 집계값만(비민감).

수집기 레지스트리 `collect_all_insight(conn)` → 신호 리스트.

## 6. 종합 (`insight/generate.py`)

- 수집 신호(이미 비민감·요약됨)를 Bedrock(기본 Haiku, 비용/지연 최적; 설정으로 Sonnet) 1회 호출 → 우선순위 **3~5 불릿** `{severity,title,detail,source,refs}`. 프롬프트: "운영자에게 즉시 의미있는 특이점만, 중복 병합, 조치 권고만(자동 변경 금지), 데이터 없으면 '특이사항 없음'."
- **결정론 폴백**: Bedrock 실패/빈응답 시 수집 신호의 severity 상위 N개를 그대로 불릿화 → status='partial', 절대 빈칸 없음.
- 출력 bounded(불릿 수·길이 캡), JSON 강제 파싱(마커 또는 tool-use), 파싱 실패 시 폴백.

## 7. 워커 잡 + 스케줄

- REGISTRY `"insight": (_insight, "lambda")` (수집 egress + Bedrock, 15분 내). `_insight(payload, dry_run)`: connect → `collect_all_insight` → `generate` → `ai_insights` insert(status succeeded/partial/failed) → close.
- **`insight_dispatcher.py`** (EventBridge `rate(6 hours)`, `local.aii` 게이트) → `insight` 잡 enqueue(db.insert_job + SQS, schedule_dispatcher 패턴). 단일 인스턴스(account=self)라 dispatcher는 enqueue 1건.
- **수동 새로고침**: `POST /api/insights/refresh`(admin) → `insight` 잡 enqueue. 중복 방지: 최근 N분 내 running 잡 있으면 202 재사용.

## 8. BFF + 대시보드 UI

- `GET /api/insights` (auth) → 최신 `ai_insights` 행 {insights, generated_at, status, sources_used}. DB read만(egress 없음).
- `POST /api/insights/refresh` (admin) → enqueue.
- `web/app/page.tsx` 상단에 **AI 인사이트 카드**: severity 뱃지(critical 적·warning 황·info 회) + 제목 + 상세(접기) + source 칩 + `generated_at` 상대시각 + 새로고침 버튼(admin) + "전체 진단 보기"(/ai-diagnosis) 링크. 빈 상태: "아직 인사이트 없음 — 새로고침". 컴포넌트 `web/components/insights/InsightCard.tsx`.

## 9. 거버넌스 / 보안

- **전부 read-only**: k8s API read, `cloudwatch:DescribeAlarms`/`GetMetricData`, `ce:GetCostAndUsage`. AWS 변경 없음(ADR-005 무관). ADR-007 governed reads.
- **게이트** `ai_insights_enabled` (기본 false → 워커/스케줄/IAM 0개, $0). `workers_enabled` 동반 필요(validation).
- **IAM**(게이트 시 워커 role에 추가): `cloudwatch:DescribeAlarms`·`cloudwatch:GetMetricData`·`ce:GetCostAndUsage`(비용 기존 보유 가능)·Bedrock invoke(기존). **EKS 이벤트**: 워커 role의 **EKS Access Entry**(클러스터 스코프 read) 필요 — `istio`처럼 운영자 out-of-band 등록(`scripts/v2/eks/`), terraform 아님. 미등록 시 k8s_events 수집은 graceful skip(인사이트는 CW/Cost로 계속).
- **PII**: 이벤트 메시지·차원 값 redaction, 비용은 집계값. Bedrock 컨텍스트엔 비민감 요약만.

## 10. 단위 경계

| 단위 | 책임 | 의존 | 테스트 |
|------|------|------|--------|
| `k8s_events.py` | 클러스터 Warning 이벤트 수집·집계 | k8s API | 클라이언트 주입 |
| `cw_anomalies.py` | ALARM/지표이상 수집 | cloudwatch | 클라이언트 주입 |
| `cost_anomalies.py` | 비용 급증 탐지 | cost explorer | 클라이언트 주입 |
| `generate.py` | 신호→불릿 종합 + 폴백 | bedrock | bedrock 주입 + 폴백 |
| `_insight` 핸들러 | collect→generate→store | DB | DB 주입 |
| `insight_dispatcher.py` | 주기 enqueue | SQS/DB | 주입 |
| BFF `/api/insights`(+refresh) | read / enqueue | DB/jobs | 라우트 |
| `InsightCard.tsx` | 카드 렌더·새로고침 | 라우트 | 컴포넌트 |

## 11. 테스트 전략
- 수집기: 정상/빈/에러(never-raise)·redaction.
- 종합: bedrock 정상 파싱·폴백(실패시 raw 불릿)·빈신호("특이사항 없음").
- 핸들러/dispatcher: enqueue·store·status.
- BFF: auth/admin·최신 read·refresh 중복방지.
- 카드: severity 렌더·빈상태·새로고침(admin).

## 12. 마이그레이션 / 배포 (게이트 ON 시)
- ULID 마이그레이션(`ai_insights`).
- `ai_insights_enabled=true` + (EKS 이벤트 원할 시) 워커 role EKS Access Entry 등록(out-of-band).
- targeted terraform apply → `make workers`(arm64) → `make deploy`(web). 기본 OFF면 $0.

## 13. 리스크 / 오픈
- **K8s 이벤트 access-entry 운영부담**: 미등록 시 graceful skip(CW/Cost만) → 점진 도입 가능.
- 멀티클러스터/멀티계정 확장은 후속(현 single-account 'self').
- 6h 주기 적정성은 운영 피드백으로 조정(설정값).
