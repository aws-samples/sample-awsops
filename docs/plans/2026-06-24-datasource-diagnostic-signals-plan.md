# Datasource Diagnostic Signals — 구현 계획 (Implementation Plan, rev2)

> Source spec: `docs/specs/2026-06-24-datasource-diagnostic-signals-design.md`
> 브랜치: `feat/v2-datasource-diag-signals` · base: `origin/feat/v2-architecture-design`
> 방식: TDD (test-first) + Tidy-First, 태스크당 1 커밋. 게이트: `datasource_diagnosis_enabled`(기본 OFF→$0).
> rev2: P2 멀티모델 게이트 findings 반영 — id=BIGINT, kind→tool, multi-query PromQL 수정, 워커는 스키마 **캐시 read**(재introspect 아님), 안정 해시(sha256+catalog-version), dispatcher 추가, 테스트파일 충돌 해소, 구체 파일경로, 크로스태스크 의존.

## 검증된 사실 (코드 확인)
- `datasource_schemas.integration_id` = **BIGINT**, PK `(account_id, integration_id)`. `integrations.id` = BIGSERIAL. → 신규 테이블 `integration_id` = **BIGINT NOT NULL**.
- 스키마 캐시는 `web/lib/datasource-schema.ts upsertSchema()`가 `(account_id, integration_id, kind, schema)` 기록. `schema.metrics`(이름 리스트)·`schema.version`(서버버전) 포함. → 워커는 **이 캐시를 read**, 재introspect 안 함.
- 라우트 패턴 = `web/app/api/datasources/[id]/...` (BIGINT id, slug 아님). add=`api/datasources/manage`, refresh=`api/integrations/schema`, query 실행=`api/datasources/query`. Explore 페이지=`web/app/datasources/page.tsx`.
- 스케줄 패턴 = `aws_cloudwatch_event_rule`+target+permission, `local.X` count 게이트. 기존 SQS/SFN 잡 백본 재사용(신규 큐 불필요).

## 의존 순서
Task 1 → 2 → 3 → 4 → 5(needs 3) → 6 → 7 → 8 → 9(precede/accompany 5 in deploy) → 10 → 11. Prom/Mimir만 stored-signal 경로; **loki/tempo/clickhouse는 기존 `_plan_queries` 유지**.

### Task 1: DB migration — datasource_diag_signals (구조)

**Files:**
- Create: `terraform/foundation/migrations/01KVVGYJYRQWKA3151J5CEWXFE_datasource_diag_signals.sql`

- [ ] spec §4 테이블 `CREATE TABLE IF NOT EXISTS datasource_diag_signals`: `integration_id BIGINT NOT NULL`(datasource_schemas와 정합), `signal_key text`, `title text`, `status text`, `query jsonb`, `missing_metrics jsonb`, `meta jsonb`, `schema_version text`, `built_at timestamptz` + PK `(account_id, integration_id, signal_key)` + `dds_instance_idx (account_id, integration_id, status)`. 멱등.
- [ ] 헤더 주석: 목적 + ADR-007 read-only + ULID 형식. DB 적용은 배포 `migrate.mjs`.

### Task 2: 신호 카탈로그 + 순수 빌드 (TDD)

**Files:**
- Create: `scripts/v2/workers/diagnosis/signal_catalog.py`
- Test: `scripts/v2/workers/diagnosis/test_signal_catalog.py`

- [ ] **test-first**: (a) 전 메트릭 존재+kind=prometheus → 8 신호 ready, `query.tool=="prometheus_query"`; kind=mimir → `"mimir_query"`. (b) 멀티쿼리 신호(network_pps, pod_right_sizing)는 `query.queries`가 리스트. (c) 일부 메트릭 부재 → `unavailable` + 정확한 `missing_metrics`. (d) 빈 metrics → 전부 unavailable, never raise.
- [ ] `CATALOG`(8 신호) 각 항목 `{key,title,pillar,required_metrics[],queries:[{expr,label}],threshold,unit}`. **PromQL 수정**:
  - `pod_right_sizing`: 2쿼리 — usage `quantile_over_time(0.95, (sum by(namespace,pod)(container_memory_working_set_bytes))[1h:5m])` (서브쿼리 내부 괄호 `(sum …)[1h:5m]` 필수), requests `sum by(namespace,pod)(kube_pod_container_resource_requests{resource="memory"})`.
  - `oom_kills`: `max_over_time(kube_pod_container_status_last_terminated_reason{reason="OOMKilled"}[1h])` (gauge → 윈도 max).
  - `network_pps`: 2쿼리 — pps `rate(node_network_receive_packets_total[5m])`, drop `rate(node_network_receive_drop_total[5m])`; required_metrics에 **두 메트릭 모두**.
  - `node_disk_usage`: `node_filesystem_avail_bytes{fstype!~"tmpfs|overlay"}` (실제 `|`, 마크다운 이스케이프 아님).
  - 나머지(throttling/node_mem/cpu_sat/pod_restarts)는 spec §5 그대로.
- [ ] 순수 `build_signals(kind, schema) -> rows`: `kind→tool` 맵(`prometheus→prometheus_query`, `mimir→mimir_query`); `required_metrics ⊆ schema.get("metrics")`이면 ready+queries(템플릿 상수, 사용자값 미주입), 아니면 unavailable+missing. `CATALOG_VERSION` 상수 노출(Task4 해시용).
- [ ] `python3 -m pytest scripts/v2/workers/diagnosis/test_signal_catalog.py` GREEN.

### Task 3: DB helpers — diag_signals upsert/list/sweep (TDD)

**Files:**
- Modify: `scripts/v2/workers/db.py`
- Test: `scripts/v2/workers/test_db.py`

- [ ] **test-first** (`test_db.py`, Task4 핸들러 테스트와 **분리**): `upsert_diag_signals(conn, integration_id, rows, schema_version)` 멱등·바인드파라미터; `read_signal_schema_version(conn, integration_id)`; `list_diag_signals(conn, integration_id)`→ready+unavailable; `sweep_diag_signals(conn, integration_id, keep_keys)`.
- [ ] `db.py`에 위 헬퍼 추가(기존 conn/Data API 패턴).
- [ ] GREEN.

### Task 4: datasource_index 잡 — 캐시 read + 안정 해시 재빌드 (TDD)

**Files:**
- Create: `scripts/v2/workers/datasource_index.py`
- Modify: `scripts/v2/workers/handlers.py`
- Test: `scripts/v2/workers/test_datasource_index.py`

- [ ] **test-first**: DB 주입 → (a) `datasource_schemas` 캐시 read; 해시 동일=스킵; (b) 변경=build_signals→upsert+sweep; (c) 캐시 **없음/None**(connector 미성공)=기존 행 보존·스킵; (d) 캐시 present·**metrics 빈** = 전부 unavailable로 재빌드(보존 아님); (e) never raise.
- [ ] `datasource_index.py run(payload, conn)`: integration_id로 `datasource_schemas.schema` read(재introspect 아님) → `schema_version = sha256(json.dumps(sorted(set(metrics)),separators=(',',':')) + "|" + CATALOG_VERSION).hexdigest()[:16]` → 기존 `read_signal_schema_version`와 비교 → 변경 시 `build_signals(kind, schema)`→`upsert_diag_signals`+`sweep`. bounded·idempotent·never-raise.
- [ ] `handlers.py`: `_datasource_index(payload, dry_run)` + `REGISTRY["datasource_index"]=(_datasource_index,"lambda")`.
- [ ] GREEN.

### Task 5: collect_datasources 개편 — prom/mimir는 저장신호, 그 외 유지 (TDD)

**Files:**
- Modify: `scripts/v2/workers/diagnosis/sources.py`
- Test: `scripts/v2/workers/diagnosis/test_datasources.py`
- Test: `scripts/v2/workers/diagnosis/test_sources.py`

- [ ] **test-first**: prom/mimir 인스턴스 → `list_diag_signals` ready 실행(멀티쿼리 포함)·PII 미반출·`meta.threshold` 플래그; **loki/tempo/clickhouse 인스턴스 → 기존 `_plan_queries` 경로 그대로**(회귀 없음); 게이트 OFF→"비활성" note; ready 없음→"신호 미빌드/연결없음"; unavailable→사유 note.
- [ ] `collect_datasources`: kind∈{prometheus,mimir}면 `datasource_diag_signals`(ready) 실행, 그 외엔 `_plan_queries` 유지. fan-out·deadline·byte-cap·redaction 재사용. (`_plan_queries` 삭제 금지 — 비-prom/mimir용 보존.) **Task 3 의존.**
- [ ] GREEN.

### Task 6: 리포트 통합 + 활용 여부 (TDD)

**Files:**
- Modify: `scripts/v2/workers/diagnosis/sections.py`
- Modify: `scripts/v2/workers/diagnosis/report.py`
- Test: `scripts/v2/workers/diagnosis/test_report.py`
- Test: `scripts/v2/workers/diagnosis/test_sections_wadd.py`

- [ ] **test-first**: `_coverage_note`가 `datasources_obs`에 4상태(사용 N신호/M인스턴스·비활성·연결없음·unavailable metric X) 출력; 신규 섹션 `external_obs_signals`(sources=["datasources_obs"]) 존재, 데이터 없으면 "데이터 불가".
- [ ] `sections.py` 섹션 추가; `report.py _coverage_note` 개선(empty 분기도 notes 출력).
- [ ] GREEN.

### Task 7: datasource_index dispatcher + 일일 스케줄 (TDD + 구조, 게이트)

**Files:**
- Create: `scripts/v2/workers/datasource_index_dispatcher.py`
- Test: `scripts/v2/workers/test_datasource_index_dispatcher.py`
- Modify: `terraform/foundation/workers.tf`

- [ ] **test-first**: dispatcher가 enabled **prometheus/mimir** integrations를 조회(`integrations` direction=egress capability=read enabled, kind in prom/mimir) → 각 instance에 `datasource_index` job enqueue(기존 `db.insert_job`+SQS, `schedule_dispatcher` 패턴). enqueue 실패는 격리(다른 instance 미차단), never block.
- [ ] `datasource_index_dispatcher.py lambda_handler` 구현.
- [ ] `workers.tf`: `aws_cloudwatch_event_rule`(`rate(24 hours)`) + target=dispatcher lambda + `aws_lambda_permission`, `local.X = workers_enabled && datasource_diagnosis_enabled` count 게이트. 기존 connector invoke IAM·SQS·SFN 재사용(신규 큐 없음).
- [ ] py 테스트 GREEN; `terraform -chdir=terraform/foundation validate` 통과; 게이트 OFF→`plan` no-op(apply는 컨트롤러).

### Task 8: BFF — diag-signals 읽기 라우트 (TDD)

**Files:**
- Create: `web/lib/diag-signals.ts`
- Create: `web/app/api/datasources/[id]/diag-signals/route.ts`
- Test: `web/lib/diag-signals.test.ts`
- Test: `web/app/api/datasources/[id]/diag-signals/route.test.ts`

- [ ] **test-first**: `verifyUser` 필요; `WHERE account_id='self' AND integration_id=$id`(단일계정); ready/unavailable 분리 JSON; egress 없음(DB read만).
- [ ] `diag-signals.ts`(쿼리 + Task9 enqueue 헬퍼) + `route.ts`(GET). 기존 `[id]` 라우트 패턴과 정합.
- [ ] 관련 `npm test` GREEN.

### Task 9: BFF — add/refresh 시 datasource_index enqueue (TDD)

**Files:**
- Modify: `web/app/api/datasources/manage/route.ts`
- Modify: `web/app/api/integrations/schema/route.ts`
- Test: `web/lib/diag-signals.test.ts`

- [ ] **test-first**: datasource 추가(`manage` POST)·스키마 refresh(`integrations/schema`) 성공 후 `enqueueDatasourceIndex(integration_id)`(기존 enqueueJob 재사용) 호출 검증. prom/mimir kind만 enqueue.
- [ ] 두 라우트에 enqueue 추가(스키마 캐시 write 직후). **배포 시 Task 5보다 먼저/함께** — 안 그러면 신규 datasource 진단이 다음 일일 인덱스 전까지 신호 없음(plan 주석).
- [ ] GREEN.

### Task 10: Explore — quick-query 칩 (TDD)

**Files:**
- Create: `web/app/datasources/DiagSignalChips.tsx`
- Modify: `web/app/datasources/page.tsx`
- Test: `web/app/datasources/DiagSignalChips.test.tsx`

- [ ] **test-first**: ready=클릭가능 칩(클릭→`onPick(query)` 콜백으로 쿼리창 채움/실행), unavailable=비활성 칩+툴팁("metric X 없음 — Refresh schema"). 멀티쿼리 신호는 대표쿼리 1개 또는 펼침.
- [ ] `DiagSignalChips.tsx` + Explore 페이지(`datasources/page.tsx`)에 마운트(기존 `api/datasources/query` 실행 경로 연결). **Integration 페이지엔 추가 안 함.**
- [ ] 관련 `npm test` GREEN.

### Task 11: end-to-end 스모크 (TDD, 경량)

**Files:**
- Test: `scripts/v2/workers/test_datasource_index.py`

- [ ] index(빌드)→`datasource_diag_signals`→`collect_datasources` 실행→`_coverage_note` "사용 N" 까지 한 흐름을 주입 fixture로 검증(워커 측 통합). 외부 호출 없음.
- [ ] GREEN.

## 검증 (전체)
- Python: `python3 -m pytest scripts/v2/workers/` GREEN.
- Web: 관련 `npm test` GREEN; `next build` 타입 통과(*.test.ts 비차단).
- Terraform: `validate` 통과; 게이트 OFF→`plan` no-op.

## 배포 (구현 후, 별도)
- `migrate.mjs`(신규 테이블) → Task 9(enqueue) 배포 ≥ Task 5 → targeted terraform apply(게이트 ON 시) → `make workers`(arm64) → `make deploy`(web). 전부 게이트 하: 기본 OFF면 비용/변경 0.
