# Phase 1 현실 감사 리포트 (2026-06-21)

> 대상: docs(ADR/reference/architecture) ↔ code/terraform/state ↔ 배포 현실.
> 방법: 정적 대조 + 라이브 프로빙(read-only). 모든 주장은 file:line 교차검증됨(chair).
> 산출 소비처: Phase 2 BASELINE §1/§2/§3 + 통합 ADR 001~N 클러스터 + Phase 3 갭 백로그.

## finding 스키마
| 필드 | 값 |
|---|---|
| id | <lane>-NN |
| 라벨 | LIVE/GATED-OFF/FROZEN/MISSING/MIS-IMPL/DRIFT/SUPERSEDED/v1-only |
| 문서 says | <doc:line> |
| 실제 | <file:line 또는 probe 결과> |
| verdict | 일치 / drift(어느쪽 맞음) / 미구현 / 오구현 |
| pillar | <WA 기둥> |
| priority | P0/P1/P2/P3 |
| BASELINE | §2(동결/게이트) / §3(결정인덱스) / 제외(archive) |

## A. ADR 라벨 대조 + 3분류 + 병합 클러스터 (001~046) _(검증 완료)_

**라벨 요약:** LIVE 26 · GATED-OFF 6(031,032,034,035,040,043) · FROZEN 2(029,036) · SUPERSEDED 7(001,002,005,009,024,025,030) · v1-only 1(011) · brainstorm-mislabeled 1(046, Proposed). FROZEN/GATED 근거는 §D terraform flag와 일치(✓V).

**브레인스토밍-오분류 → `history/brainstorm/`:** **046**(DevOps RCA EoG) — Status=Proposed 표류, Decision 미확정(2 open decisions), 코드/flag 구현 흔적 없음 = exploration mislabeled as ADR.

**병합 클러스터 = 새 통합 ADR 001~N 후보 (Phase 2 청사진):**
| 새 ADR(제목) | 구성 LEGACY | net 결정 | BASELINE |
|---|---|---|---|
| AWS 변경·자율 = FROZEN | 029,036,031-P4 | AWS-리소스 mutation/자율 영구 동결, flag-OFF substrate 보존 | §2 동결 |
| 인시던트 = ANALYSIS-ONLY (GATED) | 009,032,034,035 | read-only triage/RCA만, 자율 mitigation 폐기, writeback decouple 전 OFF | §2 게이트 |
| AI 에이전트 라우팅 = LIVE 하이브리드 | 002,025,038,044 | 정규식+Haiku 분류기+교차도메인 자동합성, chat=025/044 | §3 |
| 외부 데이터 통합 거버넌스 (keystone) | 011,039,040,041 | read-only=리소스 한정; 외부 read LIVE, write GATED 거버넌스 | §2+§3 |
| v2 파운데이션 (CDK→Terraform) | 001,005,024,030,037 | Terraform/Fargate/Aurora 기반, CDK·라이브 Steampipe 폐기 | §3 |
| 런타임 에이전트 플랫폼 (LIVE 페이즈) | 031-P1/P2,039-P1/P2 | Agent Space+Skills+Frontier Agents, BYO-MCP(P3) 제외 | §3 |
| 인증·로그인 | 020,023,042 | Cognito+엣지 RS256+adminEmails, 인앱 /login | §3 |
| AI 진단 파이프라인 | 016,019,021,033,045 | 모델선택+포맷+병렬렌더/스트리밍+비용캐싱, raw boto3 direct | §3 |
| 그래프 substrate (옵션) | 043 | Postgres-first 확정, Neptune/Neo4j deferred | §2 게이트 |
| (잔여 단독 유지) | 003,004,006,007,008,010,012,013,014,015,017,018,022,026,027,028 | 각자 단일 genuine 결정 — 병합 없이 새 번호로 이관 or 토픽 흡수(Phase 2 owner 판단) | §3 |

→ 46개 → **약 9 병합 클러스터 + 잔여 단독결정**. owner가 잔여 단독(특히 003/006/007/017/027/028 등 세부)을 어디까지 병합/흡수할지 Phase 2 착수 시 확정.

## B. 컴포넌트 Drift
> 핵심 패턴: **reference/ 7개 문서 대부분이 작성 시점(P1x snapshot)에 FROZEN** → 이후 추가된 라우트·테이블·게이트웨이·기능이 전면 DRIFT. 코드 자체는 대체로 건강. ✓V = chair가 file:line 재확인.

### B1 엣지/네트워크 _(검증 완료)_
핵심축(VPC Origin https-only, 내부 ALB HTTPS:443 리전 ACM, ALB SG가 CF 관리형 SG에서 443, create_network 분기, SG desc 불변) 모두 **LIVE**. 결함 2:
| id | 라벨 | 문서 says | 실제 | priority |
|---|---|---|---|---|
| edge-05 | DRIFT ✓V | TG health `/awsops/healthz` (01:33) | `workload.tf:437 /api/health` (컨테이너도 :331 /api/health) | P2 (문서오류, 코드정상) |
| edge-09 | DRIFT | 신규VPC 기본 CIDR `10.30.0.0/16` (01:39) | `variables.tf:23 = 10.20.0.0/16` | P3 (문서오기, live는 reuse) |

### B2 인증 _(검증 완료)_
코드는 핵심축(USER_PASSWORD_AUTH, id_token 12h, `/login` 리다이렉트, RS256 JWKS, PKCE 다크폴백) **일치**. **문서 전체가 ADR-042 인앱 로그인 전환 이전(Hosted-UI-1차) 모델에 동결** → 광범위 DRIFT:
| id | 라벨 | 문서 says | 실제 | priority |
|---|---|---|---|---|
| auth-06 | MISSING(doc) | 인앱 `/login`+USER_PASSWORD_AUTH 전무 | `login/page.tsx`, `api/auth/login/route.ts`, `lib/login.ts:42`, `auth.tf:36` | P1 |
| auth-07 | DRIFT | 미인증→Cognito `/login` (02:36) | `py.tftpl:100 → 자체 /login` | P2 |
| auth-08 | DRIFT | `awsops_token` 1h (02:21) | 12h (`py.tftpl:176`, `auth.tf:37`) | P2 |
| auth-09 | DRIFT | 공개경로 2개 (02:18) | py.tftpl:22 추가 signout/login/api-login/icon/webhook | P2 |
| auth-13 | SUPERSEDED | Purpose=Hosted-UI 1차 | 실제 인앱폼 1차, Hosted UI 다크폴백 | P1 |

### B3 데이터/Aurora _(검증 완료)_
핵심축(PG17.9, 0.5–4 ACU, KMS CMK, RDS master secret, node-pg, ULID 마이그레이션, schema_migrations) 모두 **LIVE/MATCH**. DRIFT 2:
| id | 라벨 | 문서 says | 실제 | priority |
|---|---|---|---|---|
| data-06 | DRIFT ✓V | ADR-030 7-table schema | `schema.sql CREATE TABLE = 30개`, baseline v9 | P1 (테이블 수 미갱신) |
| data-14 | DRIFT | Purpose=v1 JSON 치환만 | 스키마가 agents/remediation/incidents/k8s/chat 신규 도메인 다수 | P2 |
비고: RDS Data API(`data.tf:58 enable_http_endpoint`) 문서 미기재(MISSING-doc).

### B4 web/BFF _(검증 완료)_
문서화된 5개 라우트(health/stream/db/jobs/jobs[id])는 전부 **LIVE·정합**. 그러나 thin-BFF 시점에 동결되어 대규모 DRIFT:
| id | 라벨 | 문서 says | 실제 | priority |
|---|---|---|---|---|
| web-08 | DRIFT ✓V | `/api/*` 4개 | **실제 24개** (accounts,actions,ai-usage,auth,bedrock-metrics,chat,compliance,cost,customization,datasources,diagnosis,eks,graph,incidents,integrations,inventory,me,opencost,overview,security…) | P1 |
| web-09/10/11 | DRIFT | 페이지·핵심 lib(auth/jobs/http-body)·redirects 미기재 | 다수 page.tsx(전부 export default), `lib/{auth,jobs,http-body}` | P2 |
| web-12 | SUPERSEDED | "deliberately thin, P1d" | chat/compliance/diagnosis/eks/cost/datasources 풀스택 BFF로 확장 | P1 |

### B5 AgentCore _(검증 완료)_
| id | 라벨 | 문서 says | 실제 | priority |
|---|---|---|---|---|
| agentcore-01 | **DRIFT ✓V** | "EXACTLY 8 / external-obs는 9th 아님"(05:22-25,61) ↔ 문서 타 위치 "9"(05:31,38,74,90) | `agent.py:339=8 라우트` · `catalog.py:18=9(external-obs 포함)` · `provision.py:5=9 프로비저닝`. **net: 9 게이트웨이 프로비저닝 / 8 에이전트 라우트.** 문서 자기모순 | **P0 (독트린↔코드, 메모리 C1/C9)** |
| agentcore-02 | SUPERSEDED ✓V | README.md:62 + 05:111 "OpenCost install button (ADR-029 mutating)" | 번복됐는데 두 문서에 잔존 | P1 (번복 잔재) |
| agentcore-03 | DRIFT | "배포=2 슬라이스(iam14,flow1), 함대=P3"(05:32-34) | `ai.tf` ~18 lambda + integ 6, `catalog.py` ~25 target — 함대 대부분 착륙 | P1 (대폭 과소기재) |
| agentcore-04/05/06 | LIVE | SSM SoT·agentcore_enabled 게이트·Memory 365 | `ai.tf:306,61`, `provision.py:164` | — |

### B6 워커 _(검증 완료)_
핵심축(workers_enabled 게이트, ledger-first, dispatcher 멱등, SFN $.runtime Choice, Catch→status_updater failed, reaper 5min, Fargate CMD, ESM kill-switch, SG reuse) 모두 **LIVE/MATCH**. 문서가 P2(noop only) 동결 → 신규 미반영:
| id | 라벨 | 문서 says | 실제 | priority |
|---|---|---|---|---|
| worker-19 | SUPERSEDED | "P2 noop/noop-heavy only, real ops P3+" | report/compliance/remediation(action)/incident_stage 전부 배선 | P1 |
| worker-04 | DRIFT | type-guard registry-only | dispatcher.py:30-70 action/incident_stage를 별도 SM으로 분기(레지스트리 검사 전) | P1 |
| worker-07/08 | DRIFT | "4 Lambda / noop만" | 실제 6 lambda(+ai_cost_aggregator,+schedule_dispatcher), REGISTRY에 report/compliance | P2 |
| worker-17/18 | DRIFT | 미언급 | schedule_dispatcher(hourly report), ai_cost_aggregator(6h) 신규 | P2 |
| worker-10 | DRIFT | reaper=worker_jobs만 | reaper도 remediation/diagnosis_reports 보정 | P2 |

### B7 EKS _(검증 완료)_
| id | 라벨 | 문서 says | 실제 | priority |
|---|---|---|---|---|
| eks-02 | **DRIFT ✓V** | web_view = `AmazonEKSViewPolicy`(07:18,48,52) | `eks.tf:34 = AmazonEKSAdminViewPolicy`(web), agent role=View(eks.tf:46) | P1 (load-bearing 오류) |
| eks-04/05/06/07/08 | DRIFT/MISSING | "kubeconfig 자동등록·K8s UI = P3 연기" | 이미 LIVE: in-cluster read(`eks-incluster.ts`), runtime register(env∪DB `eks-registry.ts`), `eks_auto_register_enabled`, K8sGPT(`k8sgpt_enabled` GATED-OFF) 전부 문서 누락 | P1 |
| eks-11 | SUPERSEDED | "EKS ADR 없음(gap)" | ADR-035가 in-cluster 진단 관할 | P2 |
| eks-10 | PARTIAL | OpenCost=ADR-029 mutating 버튼(P3) | 실제 out-of-band install 번들 생성(read-only, 사용자 실행) — 번복 정합 | P2 |

### B8 AI 진단/챗 (cross-cutting) _(검증 완료)_
챗 라우팅(ADR-038/044), 진단 read-only 방어, cross-account self-assume 가드는 대체로 **LIVE·정합**(ai-01~09,11,12,14,16). 갭 2:
| id | 라벨 | 기대 | 실제 | priority |
|---|---|---|---|---|
| ai-10 | MISSING(DRIFT) | ADR-045 #2 섹션 출력 스트리밍 | 병렬화(#1)만 구현, `invoke_model_with_response_stream` 0건(`report.py:142` non-stream) | P2 (ADR가 "구현 후속"이라 명시 — 미완) |
| ai-13 | **LATENT BUG ✓V** | observability 활성화 전 `SKILL_BASE`에 키 존재 | `agent.py:106 SKILL_BASE`에 observability 키 **부재**(network/container/ops/data/security/monitoring/cost/diagnostics/iac만) + `build_skill_prompt` `.get(role,DEFAULT)` 무음폴백. `sections.ts:61` observability active:false라 오늘은 차단되어 안전 | P2 (P3 활성화 시 무음 오라우팅 → active↔SKILL_BASE 패리티 기동체크 필요) |
ai-06/15는 클라이언트/agentcore 미정독 UNVERIFIED.

## C. V1→V2 기능 갭 (미구현/오구현) _(검증 완료)_
06-10 기준 대비 **11건 해소**(진단 리포트 전군·DOCX/PDF·스케줄러·SNS통지·토폴로지·i18n·EOL배지·cost트렌드·bedrock토큰·datasources) 확인. 잔존:
| id | 기능 | v2 상태 | 근거 | pillar | priority |
|---|---|---|---|---|---|
| parity-12 | ECS 서비스 목록(desired/running) | **MISSING ✓V** | `sync_lambda.py`는 ecs_cluster/ecs_task만, service 차원 0건 | OpEx | **P0** |
| parity-13 | EBS 스냅샷 탭 | MISSING | inventory-types ebs_snapshot 0건 | Reliability | P1 |
| parity-14 | CVE/Trivy 컨테이너 취약점 | MISSING | trivy/cve 0건(Steampipe Trivy 폐기 대체물 없음) | Security | P1 |
| parity-15 | 부서(Cognito그룹)별 접근제어 | MISSING | admin/non-admin 이분만 | Security | P2 |
| parity-16 | Lambda long-timeout/메모리 KPI | MISSING | EOL배지만 해소, timeout KPI 없음 | Cost | P2 |
| parity-17/18 | Container-Cost / Event Pre-Scaling 페이지 | MISSING | 0건 | Cost | P2 |
| parity-19 | EKS 노드 용량/Pod요청 바차트 | MIS-IMPL | NodeRow에 capacity/allocatable/podRequest 없음(리스트뷰만)→스케줄링 압박 진단 불가 | Performance | P2 |
| parity-20 | AI 챗 container/iac/observability 섹션 | MIS-IMPL | `sections.ts` active:false → 사용자 도달 불가(MCP는 배포) | OpEx | P2 |
| parity-21 | 인시던트 라이프사이클 에스컬레이션 | MIS-IMPL | `incident.ts` 기본 OFF→503, escalateSeverity 미이식 | Reliability | P2 |
PPTX 산출·i18n 페이지본문·EKS 노드용량은 부분/UNVERIFIED.

## D. terraform *_enabled 교차검증 _(완료)_
tfvars 실제 토글(live state 대용). 모든 flag default=false.

**ON (tfvars=true) → §1/§3 LIVE:** `agentcore_enabled · integrations_enabled · {prometheus,loki,tempo,mimir,clickhouse}_vpc_enabled · workers_enabled · steampipe_enabled · hybrid_routing_enabled · eks_auto_register_enabled · ai_cost_tracking_enabled · diagnosis_schedule_enabled · diagnosis_notify_enabled`.

**OFF (default false, tfvars 미설정) → §2 동결/게이트:**
| flag | ADR | 분류 | description 키워드 |
|---|---|---|---|
| `remediation_enabled` | 029/036 | **FROZEN** | "⛔REVERSED … DO NOT ENABLE … Stays false permanently" |
| `incident_lifecycle_enabled` | 032 | GATED(analysis-only) | "DOWNGRADED … autonomous abandoned … ANALYSIS-ONLY" |
| `rca_writeback_enabled` | 034 | GATED | "requires remediation_enabled(frozen) decouple 선행" |
| `k8sgpt_enabled` | 035 | GATED(GET-only) | default false, dark 503 |
| `integrations_write_enabled` | 040/041 | GATED(거버넌스) | "independent control plane · no-AWS-mutation IAM" |
| `datasource_diagnosis_enabled` | 039/041 | GATED | governed egress collector |

**주목:** `diagnosis_notify_enabled=true`(ON)는 외부-comms write(SNS 이메일, IAM 단일 토픽 스코프, ADR-040/041 "NOT AWS-resource mutation")의 **이미 LIVE인 인스턴스** — 외부 DATA write 티어가 일률 OFF가 아님. 광역 `integrations_write_enabled`(Slack/Notion/Jira)만 OFF. → BASELINE §2 "외부 데이터 write" 항목은 "일부 LIVE(notify)/일부 GATED(integrations_write)"로 정밀 기술 필요.

## E. 종합 — 우선순위 · self-contradiction · BASELINE 매핑 _(완료)_

### self-contradiction 체크 (Phase 2 BASELINE 무모순 사전검증) — **PASS**
§A FROZEN/GATED 라벨(029/036/032/034/035/040) ↔ §D flag 상태(전부 OFF) = **일치**. §B LIVE 주장(hybrid/workers/agentcore/steampipe) ↔ §D(true) = **일치**. 모순 0 → **BASELINE을 무모순으로 생성 가능.** (단 §D 주목사항: diagnosis_notify는 외부-write이나 LIVE → §2에서 2-티어를 정밀 분기.)

### P0 (먼저)
- **agentcore-01** — 게이트웨이 8↔9 독트린↔코드 모순(`agent.py` 8 ↔ catalog/provision 9). AI가 "EXACTLY 8"을 읽고 9번째(external-obs) 부정 → 정직성/라우팅 영향. **BASELINE §3 + 새 ADR "AgentCore 게이트웨이"에서 net=9 프로비저닝/8 라우트로 확정**, reference 갱신.
- **parity-12** — ECS 서비스 인벤토리 미구현(desired/running). 핵심 운영 기능 결손. Phase 3 백로그 P0.

### P1 (다음)
auth-06/13(인앱 로그인 문서 전면 stale·Hosted-UI 모델 SUPERSEDED) · data-06(테이블 7→30) · web-08/12(라우트 4→24·thin-BFF SUPERSEDED) · agentcore-02(OpenCost 번복 잔재 2곳)/03(함대 과소기재) · eks-02(AmazonEKSAdminViewPolicy 오기)·eks-04+(P3 기능 미문서) · worker-19/04(P2-동결 문서 vs report/compliance/incident 배선) · parity-13(EBS 스냅샷)/14(CVE).

### P2/P3
edge-05(헬스경로 문서오류)·edge-09(CIDR 오기)·ai-10(ADR-045 스트리밍 미구현)·**ai-13(observability SKILL_BASE 키 부재 잠복버그)**·parity-15~21·eks-11 등.

### BASELINE/통합 ADR 매핑 (Phase 2 입력)
- **§0 북극성** = spec 확정(WA 6기둥 + 점진실행/FROZEN).
- **§2 동결/게이트** ← §D OFF 표(remediation FROZEN · incident/rca/k8sgpt/integrations_write/datasource_diag GATED) + diagnosis_notify 2-티어 주의.
- **§3 결정 인덱스** ← §A 9 병합 클러스터 + 잔여 단독결정.
- **reference/ 재작성** ← §B 전 컴포넌트 DRIFT(7개 문서 P1x 동결). architecture.md(v1) 폐기.
- **Phase 3 갭 백로그** ← §C parity 잔존(P0 parity-12 우선) + ai-10/ai-13.

### 핵심 결론
문서는 **대체로 P1x 시점에 동결되어 광범위 DRIFT**(reference 7개·인덱스·CLAUDE.md). **코드/인프라는 건강**하고 FROZEN/GATED invariant도 flag로 정확히 지켜짐(§D). 즉 *결정·진실은 코드에 살아있고 문서만 뒤처진 상태* → BASELINE+통합 ADR 리셋으로 해소 가능. 진짜 코드 결함은 소수(parity-12 P0, ai-13 잠복, 미구현 parity 9건).
