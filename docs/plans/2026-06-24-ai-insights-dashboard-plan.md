# AI Insights Dashboard — 구현 계획 (Implementation Plan)

> Source spec: `docs/specs/2026-06-24-ai-insights-dashboard-design.md`
> 브랜치: `feat/v2-ai-insights` · base: `origin/feat/v2-architecture-design`
> 방식: TDD (test-first) + Tidy-First, 태스크당 1 커밋. 게이트: `ai_insights_enabled`(신규, 기본 false→$0).
> 패턴: k8s API = `agent/lambda/istio_read_mcp.py`의 presigned-STS `k8s-aws-v1.` 토큰; CE = `diagnosis/sources.py` get_cost_and_usage; dispatcher/worker = `schedule_dispatcher`/`handlers.REGISTRY`.

## 의존 순서
1(mig) → 2/3/4(수집기, 독립) → 5(종합) → 6(db) → 7(잡/핸들러, needs 5·6) → 8(dispatcher) → 9(terraform, needs var) → 10(BFF) → 11(카드).

### Task 1: DB migration — ai_insights (구조)

**Files:**
- Create: `terraform/foundation/migrations/01KVWHA8699729P4J39XJNDB6M_ai_insights.sql`

- [ ] spec §4 테이블 `CREATE TABLE IF NOT EXISTS ai_insights` (bigserial id, account_id, status CHECK in succeeded/partial/failed, insights jsonb, sources_used jsonb, model, error, generated_at) + `ai_insights_latest_idx (account_id, generated_at DESC)`. 멱등. 헤더 주석: read-only·ADR-007.
- [ ] ULID 파일명 형식 + 기존 migrations와 정합(grep). 실제 ULID로 교체.

### Task 2: cost anomaly collector (TDD)

**Files:**
- Create: `scripts/v2/workers/insight/__init__.py`
- Create: `scripts/v2/workers/insight/cost_anomalies.py`
- Create: `scripts/v2/workers/insight/test_cost_anomalies.py`

- [ ] **test-first**: 일별·서비스별 day-over-day 급증(임계 % + 절대액) 탐지; 정상=빈 items; CE 에러=never-raise(notes); 비민감 집계값만(PII 없음).
- [ ] `collect_cost_anomalies(ce=None)` — `ce.get_cost_and_usage`(GroupBy SERVICE, 최근 `LOOKBACK_DAYS=7`일, DAILY) → 서비스별 전일 대비 급증 item. **명시 임계 상수**: `SPIKE_PCT=50`(전일 대비 +50%↑) AND `SPIKE_ABS_USD=10`(절대 증가≥$10) 동시 충족 시 flag(noise 억제); severity는 증가폭으로(>$100 critical·그외 warning). ce 주입 가능, 집계값만(PII 없음).
- [ ] `python3 -m pytest scripts/v2/workers/insight/test_cost_anomalies.py` GREEN.

### Task 3: CloudWatch anomaly collector (TDD)

**Files:**
- Create: `scripts/v2/workers/insight/cw_anomalies.py`
- Create: `scripts/v2/workers/insight/test_cw_anomalies.py`

- [ ] **test-first**: `DescribeAlarms(StateValue=ALARM)` → item per ALARM(알람명·네임스페이스·차원만, 값 redaction); 알람 없음=빈; 에러=never-raise. 페이지네이션 bounded.
- [ ] `collect_cw_anomalies(cw=None)` — ALARM 상태 알람 수집(MetricAlarms + CompositeAlarms). cw 주입.
- [ ] GREEN.

### Task 4: K8s events collector (TDD)

**Files:**
- Create: `scripts/v2/workers/insight/k8s_events.py`
- Create: `scripts/v2/workers/insight/test_k8s_events.py`
- Create: `scripts/v2/eks/register-insight-access.sh`

- [ ] **test-first**: parse/aggregate — Warning 이벤트(`/api/v1/events`)에서 주목 reason(OOMKilling/OOMKilled·FailedScheduling·BackOff·CrashLoopBackOff·Failed·Unhealthy·FailedMount·Evicted·NodeNotReady) 필터 + (reason × involvedObject.kind × namespace) 집계 → items. **PII redaction 규칙(명시)**: `message` 자유텍스트는 **반출 안 함**(reason+count로 대체); refs는 `{cluster, namespace, kind, name}`만(label/annotation 제외); name이 비어있으면 생략. 시간창(기본 1h)·건수(클러스터당 ≤50) bounded; HTTP/토큰/4xx(access-entry 미등록)=graceful skip(notes, never-raise).
- [ ] `collect_k8s_events(clusters=None, getter=None)` — 클러스터 목록(env `ONBOARD_EKS_CLUSTERS` 콤마분리)별 `_k8s_session`(presigned-STS, istio_read_mcp 패턴 복제; `eks.describe_cluster`로 endpoint/CA) + `_k8s_get('/api/v1/events?...')`. `getter` 주입(테스트는 raw event JSON fixture로 순수 parse 검증).
- [ ] `register-insight-access.sh`: 워커 role에 EKS Access Entry + AmazonEKSViewPolicy 부여(`register-istio-access.sh` 미러). 운영자 out-of-band 실행 — 미실행 시 k8s_events는 graceful skip(인사이트는 CW/Cost로 계속).
- [ ] GREEN.

### Task 5: insight synthesis + deterministic fallback (TDD)

**Files:**
- Create: `scripts/v2/workers/insight/generate.py`
- Create: `scripts/v2/workers/insight/test_generate.py`

- [ ] **test-first**: bedrock 정상→파싱된 3~5 불릿(severity/title/detail/source); bedrock 실패/빈→**결정론 폴백**(수집 신호 severity 상위 N 불릿, status partial); 신호 없음→"특이사항 없음"; 불릿 수/길이 캡; PII 없음.
- [ ] `synthesize(signals, invoke=None)` — 신호 요약을 Bedrock(기본 Haiku) 1회 호출, JSON 마커 파싱, 실패 시 `_fallback(signals)`. invoke 주입.
- [ ] GREEN.

### Task 6: DB helpers — ai_insights (TDD)

**Files:**
- Modify: `scripts/v2/workers/db.py`
- Create: `scripts/v2/workers/insight/test_insight_db.py`

- [ ] **test-first**: `insert_insight(conn, status, insights, sources_used, model, error)` 바인드+::jsonb; `get_latest_insight(conn, account_id='self')` → 최신 행 파싱. 멱등/파라미터화.
- [ ] `db.py`에 두 헬퍼 추가.
- [ ] GREEN.

### Task 7: insight worker job + handler (TDD)

**Files:**
- Create: `scripts/v2/workers/insight/job.py`
- Modify: `scripts/v2/workers/handlers.py`
- Create: `scripts/v2/workers/insight/test_job.py`

- [ ] **test-first**: `AI_INSIGHTS_ENABLED!=true`→`run` no-op(disabled, write 없음); enabled 시 collect_all(주입 stub)→synthesize(stub)→`insert_insight`; 일부 수집기 실패=부분 진행, 전부 실패=status failed; never-raise. handler `_insight(payload, dry_run)` connect/close.
- [ ] `job.py run()` (맨 앞 **`if os.environ.get('AI_INSIGHTS_ENABLED') != 'true': return {'disabled': True}`** — 런타임 하드 게이트, 항상-등록 REGISTRY/enqueue 경로 no-op) + `handlers.py` `_insight` + `REGISTRY["insight"]=(_insight,"lambda")`.
- [ ] GREEN.

### Task 8: insight_dispatcher (TDD)

**Files:**
- Create: `scripts/v2/workers/insight_dispatcher.py`
- Create: `scripts/v2/workers/test_insight_dispatcher.py`

- [ ] **test-first**: `lambda_handler`가 `insight` 잡 1건 enqueue(db.insert_job + SQS, schedule_dispatcher 패턴); QUEUE_URL 미설정=fail-loud; SQS 전송 실패 시 `conn.run("DELETE FROM worker_jobs WHERE job_id=:id AND status='queued'")`로 orphan ledger row 정리 후 재-raise.
- [ ] 구현.
- [ ] GREEN.

### Task 9: Terraform — var/gate + dispatcher + IAM + bundle (구조, 게이트)

**Files:**
- Modify: `terraform/foundation/variables.tf`
- Modify: `terraform/foundation/workers.tf`
- Modify: `terraform/foundation/workload.tf`

- [ ] `variables.tf`: `variable "ai_insights_enabled"`(bool, default false, 설명 "OFF→$0", workers_enabled 동반 validation — 기존 패턴 참고).
- [ ] `workers.tf`: `local.aii = var.workers_enabled && var.ai_insights_enabled ? 1 : 0`(모든 신규 6리소스 `count=local.aii` 일관); insight_dispatcher lambda + `aws_cloudwatch_event_rule`(rate(6 hours)) + target + `aws_lambda_permission`; 워커 role IAM **추가**: `cloudwatch:DescribeAlarms`·`cloudwatch:GetMetricData`·`ce:GetCostAndUsage`·**`eks:DescribeCluster`**(k8s endpoint/CA 조회). **bedrock:InvokeModel은 워커 role에 이미 존재**(report 잡)→확인만. **`sqs:SendMessage`는 기존 정책이 다른 게이트(local.sched/dsd)에 묶여 있어** ai_insights 단독 활성 시 부재할 수 있음 → `local.aii` 게이트 **전용 SendMessage 정책 추가**(jobs 큐 ARN). 워커 lambda+task env에 **`ONBOARD_EKS_CLUSTERS`**(onboard_eks_clusters 콤마조인, 기본 빈값→k8s skip) + **`AI_INSIGHTS_ENABLED`(local.aii?"true":"false")**(런타임 게이트) 추가; **workload.tf 웹 task env에도 `AI_INSIGHTS_ENABLED`** 추가(BFF refresh fail-closed용). `workers_src` 아카이브에 **`insight/` 패키지 구조 보존**(`filename="insight/<x>.py"` + `insight/__init__.py`; flatten 금지 — `from insight.x import`가 깨짐) + `insight_dispatcher.py`. 전부 `local.aii` 게이트. EKS access-entry는 out-of-band(주석).
- [ ] `terraform -chdir=terraform/foundation validate`; 게이트 OFF→`plan` no-op(apply는 컨트롤러).

### Task 10: BFF — /api/insights (read + refresh) (TDD)

**Files:**
- Create: `web/lib/insights.ts`
- Create: `web/app/api/insights/route.ts`
- Create: `web/app/api/insights/refresh/route.ts`
- Create: `web/lib/insights.test.ts`
- Create: `web/app/api/insights/route.test.ts`

- [ ] **test-first**: `GET /api/insights`(verifyUser) → 최신 행; `POST /api/insights/refresh`(verifyUser + **isAdmin**) → **`AI_INSIGHTS_ENABLED!=='true'`면 503 fail-closed**; 아니면 `enqueueJob('insight',…)`, 최근 **queued∪running** insight 잡 있으면 202 재사용(중복 Bedrock 잡 방지); DB read만.
- [ ] `insights.ts`(getLatestInsight + enqueueInsightRefresh) + 두 route.
- [ ] 관련 `npm test` GREEN.

### Task 11: Dashboard AI Insight card (TDD)

**Files:**
- Create: `web/components/insights/InsightCard.tsx`
- Modify: `web/app/page.tsx`
- Create: `web/components/insights/InsightCard.test.tsx`

- [ ] **test-first**: severity 뱃지(critical/warning/info) 렌더; 빈 상태 CTA; 새로고침 버튼(admin)→POST; generated_at 상대시각.
- [ ] `InsightCard.tsx`(fetch /api/insights, 새로고침) + Overview(`page.tsx`) 상단 마운트.
- [ ] 관련 `npm test` GREEN.

## 검증 (전체)
- Python: `python3 -m pytest scripts/v2/workers/` GREEN.
- Web: 관련 `npm test` GREEN; `next build` 타입 통과(*.test.ts 비차단).
- Terraform: `validate` 통과; 게이트 OFF → `plan` no-op.

## 배포 (구현 후, 게이트 ON 시)
- ULID 마이그레이션 → `ai_insights_enabled=true`(+EKS 이벤트 원하면 워커 role EKS Access Entry out-of-band 등록) → targeted apply → `make workers` → `make deploy`. 기본 OFF면 $0.
