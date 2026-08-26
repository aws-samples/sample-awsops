# AWSops v2 — 아키텍처 설계 문서 (Design Spec)

- **작성일**: 2026-05-30
- **상태**: Draft (브레인스토밍 합의 완료, 구현 계획 착수 전)
- **관계**: v1은 그대로 유지. v2는 **완전 분리된 신규 시스템**. ADR-024/029/030의 *결정*을 계승/확장하되 supersede 아님.
- **후속**: 이 설계안 → Phase별 spec → writing-plans → 구현

---

## 1. 개요 & 목표

v1(EC2 모놀리스)은 손대지 않고, 완전 분리된 v2를 신규 구축한다. 4대 목표:

1. **모놀리스 → MSA**: 단일 EC2에서 web + Steampipe + Docker 빌드가 자원 충돌하던 구조를 분리.
2. **OOM/좀비 프로세스 안전성**: 무겁고 메모리가 튀는 작업을 요청 경로에서 떼어 managed service로 격리 → 워커가 OOM으로 죽어도 web은 무사.
3. **CDK → Terraform**: 인프라를 Terraform으로 재표현 (포터빌리티·고객 소유 IaC).
4. **UI 개선 + 섹션별 테마 에이전트**: 각 페이지에 도메인 전용 AI 에이전트를 임베드.

**계승 원칙**: ADR-030의 결정(Fargate 분리, Aurora 앱 상태 모델, 7-테이블 스키마)은 dev 환경에서 검증된 자산이므로 그대로 계승한다. CDK 코드만 버리고 Terraform으로 재작성한다.

---

## 2. 아키텍처 개관 (컴퓨트 토폴로지 = "비동기 워커 계층")

```
Internet
   │
CloudFront (CACHING_DISABLED, Lambda@Edge Cognito 인증)
   │  VPC Origin (private subnet에 CloudFront 관리형 ENI)
   ▼
Internal ALB (private subnet, SG: VPC Origin SG만 허용)
   │
   ▼
awsops-web (Fargate, 경량: 라우팅·SSE만)
   │  ├─ Service Connect → awsops-steampipe (Fargate, FDW PostgreSQL, 내부 전용)
   │  └─ enqueue (SQS)
   ▼
SQS → Step Functions → ┌─ Lambda 워커 (<15분 작업)
                       └─ Fargate 태스크 워커 (긴/메모리 큰 작업)
   │
Aurora Serverless v2 (앱 상태, 7 테이블)
```

- web·steampipe는 **가볍게 유지** → 메모리 스파이크 원천 제거.
- **steampipe는 ALB 뒤가 아님** — web에서 Service Connect(`awsops-steampipe.awsops.local:9193`)로만 접근하는 내부 전용 서비스.
- 무거운 작업(AI 멀티라우트 합성, 15섹션 리포트, 대용량 Steampipe 스캔, incident 진단)은 **SQS + Step Functions + 단명 워커**로 분리.
- 워커 OOM 시 web 영향 0, Step Functions가 실행 상태를 보존 → 재시도·복구 가능.
- 기각된 대안: (A) ADR-030 그대로 + 가드레일만 → AI/리포트가 web 안에 남아 스파이크 위험 잔존. (C) 도메인별 전면 분해 → 이 규모엔 운영 표면 과도(ADR-030의 EKS 기각 논리와 동일).

### 2.1 엣지/LB 계층 (Internal ALB + CloudFront VPC Origin)

v1은 **CloudFront → public ALB → EC2**, ALB를 CloudFront 관리형 prefix list SG로 잠그는 방식(ADR-028). 문제는 ALB가 결국 **internet-facing**이라 퍼블릭 표면이 잔존한다는 점. v2는 이를 제거한다.

- **CloudFront VPC Origin (2024.11 GA)**: CloudFront가 private subnet의 internal LB에 직접 연결(VPC 내 CloudFront 관리형 ENI 경유) → **origin LB를 internet-facing으로 둘 필요가 없음**.
- **결정 함의**: "Private LB"는 사실상 VPC Origin을 *요구*한다. private/internal LB는 인터넷에서 안 보이므로 CloudFront의 유일한 정규 도달 경로가 VPC Origin (대안은 v1의 public ALB + prefix list뿐 — private 아님). 두 결정은 묶인다.
- **LB 타입 = ALB** (NLB 아님): 워크로드가 HTTP/L7(Next.js)이라 ALB의 경로/호스트 라우팅·HTTP 헬스체크·SSE 제어·향후 멀티서비스(web+API+incident) 단일 LB 통합 이점이 큼. NLB의 강점(정적IP·PrivateLink·L4 throughput·source IP 보존)은 이 워크로드에 무의미.
- **보안 모델 변화**: ALB SG는 CloudFront prefix list가 아니라 **VPC Origin SG만 허용** → 완전 사설. Lambda@Edge Cognito 인증(ADR-020)은 CloudFront 단(viewer-request)이라 origin 타입과 무관하게 그대로 동작.
- **검증 필요(P1)**: SSE 스트리밍(ADR-021)이 CloudFront VPC Origin + Internal ALB 경로에서 정상 동작하는지 — ALB idle timeout 상향 + origin keepalive(heartbeat) 주기를 CloudFront origin read timeout 이내로 유지. v1에서 CloudFront→ALB SSE는 이미 동작하므로 패턴 계승하되 VPC Origin 타임아웃 의미를 P1에서 실측.

---

## 3. 컴퓨트 & OOM 안전성 (워커 런타임 = 하이브리드)

| 작업 성격 | 런타임 | 이유 |
|---|---|---|
| 짧고 가벼움 (<15분) | **Lambda** | 빠른 시작·저렴·자동 스케일 |
| 길고 메모리 큼 (리포트/전체 스캔/Opus 진단) | **단명 Fargate 태스크** | 시간·메모리 제한 없음, ARM64 이미지 재활용 |

- **Step Functions가 작업 성격으로 라우팅** — ADR-029의 "작업별 Lambda 디스패처 + Step Functions" 패턴을 *전 영역 실행 백본*으로 일반화.
- 모든 워커: **하드 메모리 한도 + 헬스체크 + circuit breaker**.
- ADR-029의 멱등성 토큰 · 필수 dry-run · 1급 롤백 · S3 Object Lock 감사 · 킬 스위치 프레임워크 계승.

---

## 4. AI 에이전트 계층 (9 섹션 에이전트 + 1 Incident 오케스트레이터)

**핵심 원리 — 섹션 = 라우팅**: 페이지가 이미 도메인을 알려주므로 분류기 LLM 호출을 제거한다 → 분류 왕복 제거(빠름) + 오분류 제거(정확). 전역 검색(omnibox)용 분류기만 잔존.

**근거**: v1이 8 Gateway로 나눈 이유가 *속도·정확성*(125개 도구 중 고르지 않고 도메인 ~10–24개 안에서만 고름). v2는 섹션 경계 = 에이전트 경계로 이 이점을 극대화한다.

**9 도메인 에이전트** (도구 ≤~25/agent 예산, 기본 모델 Sonnet):

| # | 에이전트 | 도메인 | 비고 |
|---|---|---|---|
| 1 | Network | VPC·ENI·reachability·flow logs·TGW·VPN·firewall | |
| 2 | Container/K8s | EKS·ECS·Istio·K8s | |
| 3 | Data | DynamoDB·RDS/Aurora·ElastiCache·MSK·OpenSearch | |
| 4 | Security & Compliance | IAM·정책 시뮬·**CIS/벤치마크 통합** | security+compliance 병합 |
| 5 | Cost/FinOps | Cost Explorer·예측·예산·컨테이너 비용 | |
| 6 | AWS Monitoring | CloudWatch·CloudTrail (AWS 네이티브만) | |
| 7 | **External Observability** | Prometheus·Loki·Tempo·ClickHouse·Jaeger·Dynatrace·Datadog | **신규 분리** (쿼리 언어 생성이 CloudWatch와 근본적으로 다름 → 정확성↑) |
| 8 | IaC | CDK·CloudFormation·Terraform | |
| 9 | Ops/Inventory | Steampipe SQL 목록·현황·문서·인벤토리 | **조회 전용 경량** (속도↑) |

**+ 1 Incident 오케스트레이터**: 자체 Gateway 없음, 기본 Opus, 비동기 워커 위에서 동작. 9개 도메인 에이전트 + 조사 엔진을 federate.

**v1 대비 변화**:
- 8 Gateway → **9 Gateway** (Monitoring이 AWS Monitoring + External Observability로 분리).
- "125 MCP 도구"(고정 수)는 폐기 → **도메인별 재분배, ≤~25/agent 예산**. 정확한 수는 Gateway 재설계 시 확정.
- 단일 11-route 분류기 → 섹션=라우팅 (전역 검색용만 잔존) + Incident 오케스트레이터 추가.
- **7번 External Observability 에이전트는 플러그형 데이터소스 레지스트리로 구동** (§8.1) — 고정 7종이 아니라 카테고리화된 확장 가능 목록 + OTLP 제너릭.

---

## 5. UI/UX (우측 도킹 패널 + 테마링)

- 각 섹션 페이지에 **우측 접이식 도킹 패널**로 그 도메인 에이전트를 임베드.
- **섹션 강조색으로 에이전트 크롬 테마링** (Network=cyan, Cost=green, Security=red 등) → "테마에 맞는 에이전트" 시각화.
- 테이블·차트·토폴로지를 **보면서 동시에 대화**, 접으면 콘텐츠 풀폭.
- 전역 **Incidents/Response 섹션**(빨강 테마, 동일 패널 패턴) — Incident 오케스트레이터와 대화.
- Next.js 14 App Router 유지. **v2는 basePath 제거** — 전용 도메인(`awsops-v2.example.com`)에서 루트(`/`) 서빙. v1의 `/awsops` 접두사 규칙(`basePath: '/awsops'`, 모든 fetch `/awsops/api/*`)은 v2에서 **폐기** → fetch는 `/api/*`, 정적 자산 `/_next/static/*`, CloudFront 기본 behavior가 `/` 전체 커버. (실제 앱은 P1d에서 `next.config.mjs` basePath 제거 + fetch 경로 정리.)
- 기각된 대안: 하단 드로어(차트 가림), 플로팅 버블(동시 참조 불편).

---

## 6. Incident & ChatOps 계층 (federate-ready, config 게이팅)

AWS DevOps Agent(re:Invent 2025, preview·us-east-1)와 v2가 패턴상 평행함을 확인. 그러나 **preview·리전 제약**과 **비용(초 단위 과금)** 때문에 종속하지 않고, **config 플래그로 켜고 끄는 federate-ready** 구조를 택한다.

**조사 엔진 포트** — 10번 오케스트레이터가 두 구현을 config로 선택:

```json
"features": {
  "investigationEngine": "agentcore-native",   // 기본값, 모든 리전(서울 포함) 동작
  "devopsAgent": {
    "enabled": true,                            // 지원 리전 고객사만 배포 시 ON
    "region": "us-east-1",
    "agentSpaceId": "...",
    "fallbackToNative": true                    // DevOps Agent 불가 시 자동 폴백
  }
}
```

- 기본 `agentcore-native` → 서울 포함 어디서나 즉시 동작.
- 해외 리전 고객은 `devopsAgent.enabled:true`로 **배포 시점 활성화** (GA 대기 불필요). 멀티어카운트 `features{}` 패턴(ADR-008) 따름 → 계정별로도 다르게 가능.
- **양방향 ChatOps** (우리 소유): 담당자가 Slack 스레드에서 답하면 오케스트레이터가 9개 에이전트를 호출해 in-thread 응답. DevOps Agent의 Slack은 주로 결과 게시·티켓 업데이트 중심이므로 풍부한 ChatOps는 우리 layer가 담당.

**federated 모드(config ON) 통합 지점**:
- ① 우리 9 Gateway를 **계정 레벨 커스텀 MCP 서버**로 등록 → Agent Space가 도구 선택.
- ② 알림 파이프라인(ADR-009 상관분석) → **incident webhook** → Agent Space.
- ③ DevOps Agent findings → 우리 notification + 대시보드 Incidents 섹션으로 회수.
- Agent Space는 **셋업 시 1회 프로비저닝**(Console/Terraform) — 앱이 런타임에 생성하지 않음.

---

## 7. 상태 & 데이터 (ADR-030 계승)

- **Aurora Serverless v2** + 7 테이블 스키마(`inventory_snapshots`, `cost_snapshots`, `agentcore_memory`, `agentcore_stats`, `alert_diagnosis`, `event_scaling_plans`, `report_schedules`) 그대로 계승.
- v2는 **별도 신규 Aurora**로 provisioning (v1 데이터와 완전 격리).
- `data/config.json`은 파일 유지(DB 연결 부트스트랩). `features{}`에 `investigationEngine`·`devopsAgent` 추가.
- Steampipe는 stateless → 자체 Fargate 태스크, config는 Secrets Manager 마운트.

---

## 8. IaC & 배포 — Terraform + 선언적 + CI/CD

v1의 가장 큰 운영 통증인 **17개 순차 셸 스크립트**(00~12, 6a~6f)를 근본적으로 단순화한다.

**v1 통증 → v2 개선 매핑**:

| v1 | v2 |
|---|---|
| `00-deploy-infra.sh` (CDK) | `terraform apply` — 상태관리·멱등·plan 미리보기 |
| `01~03` EC2에서 설치·빌드 | **CI(CodeBuild/GitHub Actions)에서 빌드** → ECR(dev private/prod public) → ECS 롤링 |
| `06a~06f` AgentCore CLI/boto3 수동 | **선언적 agent 카탈로그**(ADR-029 registry 일반화) + 멱등 provisioner |
| `06e` config.json ARN 손주입 | **Terraform output → SSM/Secrets → 컨테이너 런타임 read** |
| `09~11` start/stop/verify | ECS 헬스체크 + **deployment circuit breaker(자동 롤백)** + CI 스모크 테스트 |
| `12` 멀티어카운트 | Terraform workspace / tfvars |

**"쉽게 배포·개선"의 4원칙**:

1. **명령 최소화**: `make configure`(Node TUI: 클러스터 발견·선택·도메인·계정·feature 플래그 입력 → `terraform.tfvars` 생성/갱신) → `terraform apply`(전 인프라 + 선택 EKS Access Entry + OpenCost) → `make deploy ENV=dev`(앱 빌드+푸시+ECS 갱신). 17단계 → 3명령. **EKS는 별도 make 타깃 없이 `make configure`에 통합** (전용 타깃은 활용성 낮음).
2. **선언적·멱등**: 모든 게 코드. `terraform plan`으로 변경 미리보기, 재실행 안전. AgentCore Gateway/도구/메모리/인터프리터도 카탈로그(YAML/TS)에서 선언 → 한 곳 수정 = 한 PR.
3. **config-driven (손편집 제거)**: v1의 "단계 사이 config.json 주입"·"agent.py GATEWAYS 하드코딩 후 Docker 재빌드" 제거 → Gateway URL·ARN은 Terraform output/SSM에서 런타임 주입.
4. **안전한 개선 루프**: 코드 변경 → CI 빌드 → **ECS 롤링 + circuit breaker 자동 롤백**. 인프라 변경 → `plan` 리뷰 → `apply`.

**OSS 이식성 (단일 repo 자가 배포)**: awsops repo에 private 값(backend 버킷·도메인·계정·인증서)을 박지 않는다. backend는 **partial**(`backend "s3" {}`) — 고객이 `make configure`로 `terraform.tfvars` + `backend.hcl`(둘 다 gitignored)을 생성 → `make deploy`가 bootstrap(state 버킷, `use_lockfile`) + `init -backend-config` + apply. **private consumer root 불필요** — OSS repo만으로 고객이 배포(원안의 make 흐름 유지). 사용자 자신의 배포도 동일 경로다. (사내 Atlantis(`AWS-Demo-Platform`)를 배포 백엔드로 평가했으나 — TF 1.9.6 핀 + private 백엔드 + OSS에 못 박는 제약 때문에 — 미사용으로 결정, 대신 **신규 backend + Terraform 1.15 + `use_lockfile`**(DynamoDB 불필요) 채택.)

**네트워크 선택 (신규 vs 기존 VPC)**: `make configure`는 **새 VPC 생성** 또는 **기존 VPC 재사용**을 운영자가 고르게 한다 — v1 `scripts/00-deploy-infra.sh`의 선택 UX(1=새 VPC / 2=기존→`describe-vpcs`→private subnet 분류→NAT 확인→CIDR 도출)를 그대로 미러. Terraform은 `create_network` 플래그 + `data.aws_vpc`(기존 CIDR) + locals(vpc_id/subnets/cidr 분기)로 흡수. 기존 VPC 재사용 시 NAT 신규 비용·`ec2:Create*` 권한 불필요.

**OSS 메트릭/배지 (P1d 배포 폴백)**: README에 GitHub stars/forks/issues/license/last-commit/CI 배지는 즉시 추가(인프라 0). "다운로드 수"는 GitHub clone 통계가 비공개라 공개 배지 불가 — 대신 **릴리스 자산 다운로드 배지**(릴리스 자산 발행 시) 또는 **Public ECR pull-count용 커스텀 shields.io endpoint 배지**(작은 Lambda가 `ecr-public` 통계 조회)를 P1d 배포 단계에서 추가. Docker Hub 미러링 시 `docker/pulls` 배지도 가능.

**스택 분할**(실패 도메인 기준, ADR-024 정신 계승): `edge`(CloudFront·**VPC Origin**·**Internal ALB**·Lambda@Edge·Cognito) / `network`(VPC·서브넷·SG) / `data`(Aurora) / `workload`(ECS·web·steampipe) / `ai`(AgentCore·워커·SQS·SFN) / `incident`.

**위험**: AgentCore를 완전 선언적 IaC로 만드는 영역은 v1에서 CLI/boto3 quirk가 많았음(Gateway Target inlinePayload, Code Interpreter 언더스코어 제약, Runtime 업데이트 시 role-arn 필수 등) → P1에서 **멱등 provisioner 한 겹**으로 감싸 멱등성 확보. Terraform 네이티브 리소스가 없으면 작은 멱등 provisioner 권장(`null_resource`+raw 스크립트 지양).

### 8.1 외부 통합 온보딩 (EKS · OpenCost · Observability)

**신뢰 경계 원칙**: 고객 인프라(EKS 클러스터)에 접근/설치하는 것은 고객 권한이 필요한 작업이라 대시보드가 자기에게 부여 불가. 따라서 **"자동화 가능한 건 전부 자동화, 게이트되는 한 단계는 one-command"** 로 설계한다.

**모델: 통합 `make configure`(Node TUI)가 `terraform.tfvars`를 생성 → 단일 `terraform apply`가 선언적으로 전부 처리.** EKS는 이 통합 흐름의 한 단계일 뿐 별도 make 타깃이 아니다. TUI는 HCL을 손편집하지 않게 해주는 친절한 프런트엔드일 뿐, 진짜 작업은 Terraform이 한다.

1. **자동 발견**: `make configure` TUI가 `eks:ListClusters`(계정 레벨 read IAM, ADR-008 assume-role로 크로스 계정·리전)로 클러스터 인벤토리 수집. (앱이 쓰는 AWS SDK·`config.json` 재사용, 크로스플랫폼)
2. **TUI 멀티 선택 → tfvars 기록**: 발견된 클러스터를 **Node TUI(`@inquirer/prompts` 또는 `ink`)** 로 표시(이름·계정·리전·연결상태) → 등록할 클러스터 + `enable_opencost` 등 선택 → **`terraform.tfvars`에 데이터로 기록** (예: `onboard_eks_clusters = ["arn:...:cluster/a", ...]`, `enable_opencost = true`). 도메인·리전·계정·feature 플래그(`investigationEngine`/`devopsAgent`)도 같은 TUI에서 tfvars로.
3. **`terraform apply` (선언적)**: tfvars의 클러스터 목록을 순회하며 각 클러스터에 **Access Entry + AccessPolicy 바인딩**(AWS provider, 대상 계정 assume-role) + 선택 시 **OpenCost Helm 릴리스**(helm/kubernetes provider). 멱등 — tfvars에서 추가/제거 후 재apply만 하면 반영.
4. **자동 등록**: apply 후 Terraform output(또는 SSM)에 기록된 접근 정보를 대시보드가 감지 → kubeconfig **자동 등록** (v1의 수동 등록 제거).
5. **신뢰 경계 (preflight)**: `terraform apply`는 Access Entry 생성 권한이 있는 자격으로 실행돼야 함(대상 클러스터 admin / assume-role). 권한 없는 클러스터는 TUI가 **preflight로 표시** → 소유자가 적용할 **분리 tfvars/모듈을 핸드오프**.

**OpenCost**: tfvars `enable_opencost=true` → 위 3에서 Helm 릴리스로 설치. **Provider 주의**: 같은 apply에서 Access Entry(AWS) + OpenCost(helm)를 함께 처리 시, helm provider는 *운영자 자격*으로 인증(대시보드 role 아님)하며 access-entry 생성에 순서 의존(`depends_on` 또는 2-stage apply) → P1에서 검증. v1의 request 기반 폴백(`eks-container-cost`) 유지 → 없으면 graceful degrade(필수 아님).

**Observability 데이터소스 (플러그형 레지스트리 + OTLP + 카테고리)**:
- **플러그형**: `datasource-registry.ts` 확장 — 데이터소스 추가 = 레지스트리 항목 1 + 클라이언트 어댑터 1 (ADR-029 카탈로그 패턴). SSRF allowlist 유지.
- **카테고리화**: Metrics / Logs / Traces / Profiling(신규) / 표준·통합.
- **OTLP 1급 제너릭 어댑터** → OTel 호환 백엔드를 벤더별 코드 없이 흡수.
- **시드 확장** (현재 7종 → ): +AMP(Amazon Managed Prometheus), AWS X-Ray, Elasticsearch/OpenSearch, Splunk, New Relic, Grafana/Mimir, Honeycomb, Zipkin, VictoriaMetrics, Sumo Logic, Pyroscope/Parca. **AWS DevOps Agent 연동 목록과 정렬** → federation parity.

**위험**: EKS Access Entry 부여는 끝까지 고객 권한이 필요(완전 무인 불가) — 자동 발견·자동 등록으로 *체감 단계*만 1개로 축소. OTLP 어댑터의 쿼리 표현력은 백엔드별 차이가 있어 공통 분모로 시작.

---

## 9. Phasing & 분해 (독립 sub-project 4개)

v2는 다중 서브시스템이라 독립 spec으로 나눠 순차 진행한다. 각 Phase = 별도 spec → plan → 구현 사이클.

| Phase | Sub-project | 산출물 | 완료 기준(초안) |
|---|---|---|---|
| **P1** | Terraform 기반 인프라 + 배포 토폴로지 | VPC/ECS/Aurora/ECR/**Internal ALB+VPC Origin**/CloudFront/Cognito 스택, CI/CD 파이프라인, **`make configure` Node TUI(tfvars 생성, EKS 선택 통합)** + EKS Access Entry/OpenCost Terraform 모듈, AgentCore 멱등 provisioner, 빈 web 띄우기 + **SSE 경로 실측** | `terraform apply`로 신규 도메인에 web 헬스체크 통과 + SSE 정상 + `make configure`+apply로 클러스터 1개 등록·자동연결 |
| **P2** | 비동기 워커 백본 | SQS+Step Functions+Lambda/Fargate 워커, OOM 격리, 기존 무거운 작업(AI 합성·리포트·대용량 스캔) 이전 | 무거운 작업이 web 밖에서 실행, 워커 OOM 시 web 무영향 검증 |
| **P3** | 9+1 에이전트 + UI | 9 Gateway 재분배, 섹션=라우팅, 우측 패널 UI, 테마링, **플러그형 데이터소스 레지스트리 + OTLP + 시드 확장**(External Observability 에이전트) | 각 섹션에서 분류기 없이 도메인 에이전트 응답 + OTLP 백엔드 1종 쿼리 |
| **P4** | Incident & ChatOps | 오케스트레이터, 조사 엔진 포트, Slack 양방향, DevOps Agent config 게이팅 | native 엔진으로 incident 자동 진단 + Slack 양방향 동작; config로 DevOps Agent 토글 |

---

## 10. ADR 전략

- **ADR-031** (신규): "AWSops v2 — Terraform MSA + 비동기 워커 백본 + 섹션 에이전트 + federated incident response". ADR-024(스택 분할)·029(변경 작업 프레임워크)·030(Fargate+Aurora)을 *확장/계승* (supersede 아님 — v1에서 ADR-030은 계속 유효).
- Phase별 세부 ADR은 필요 시 추가 (예: 조사 엔진 포트 추상화, 9 Gateway 재분배).

---

## 11. 위험 & 트레이드오프

- **비용**: Fargate + Aurora + SFN + 워커 = v1 대비 증가. 다만 web 경량화로 상시 vCPU는 절감 여지. v1/v2 이중 운영 기간 비용 발생.
- **운영 표면 증가**: 9 Gateway + 워커 + SFN. 단 도메인 경계가 명확해 디버깅은 쉬워짐.
- **엣지(VPC Origin) SSE 검증**: CloudFront VPC Origin + Internal ALB 경로에서 SSE 스트리밍(ADR-021)의 타임아웃 동작을 P1에서 실측 필요 (ALB idle timeout 상향 + origin keepalive). VPC Origin은 비교적 신규 기능이라 엣지 케이스 가능성.
- **DevOps Agent preview 의존**: config 게이팅 + `fallbackToNative`로 격리. 기본은 native라 영향 0.
- **AgentCore IaC화 난이도**: 위 §8 위험 참조 — 멱등 provisioner로 흡수.
- **완전 신규(마이그레이션 아님)**: 데이터 backfill 불요, v1 영향 0. 대신 두 시스템 병렬 운영 부담.

---

## 부록 A — 확정된 결정 요약

| 결정 | 선택 |
|---|---|
| v2 기반선 | ADR-030 결정 계승 + Terraform 재작성 |
| 엣지/LB | **Internal ALB + CloudFront VPC Origin** (완전 사설, prefix list 폐기) |
| 컴퓨트 토폴로지 | 비동기 워커 계층 (web 경량 + SQS+SFN+워커) |
| 워커 런타임 | 하이브리드 (Lambda <15분 / Fargate 태스크 긴·무거운) |
| 에이전트 | 9 도메인 + 1 Incident 오케스트레이터 |
| 에이전트 백엔드 | 섹션=라우팅, 9 Gateway, ≤~25 도구/agent |
| UI 배치 | 우측 도킹 패널 + 섹션 테마링 |
| Incident/ChatOps | federate-ready, config 게이팅(native 기본/devopsAgent 옵트인), Slack 양방향 우리 소유 |
| 상태/데이터 | Aurora Serverless v2 + 7 테이블 (별도 신규 provisioning) |
| IaC/배포 | Terraform + CI/CD + 3-명령 + 선언적 AgentCore |
| EKS/OpenCost 온보딩 | 통합 `make configure` TUI가 tfvars에 클러스터 선택 기록 → `terraform apply`가 Access Entry+OpenCost (preflight 핸드오프 폴백) + 자동등록. **EKS 전용 make 없음** |
| Observability | 플러그형 레지스트리 + OTLP 제너릭 + 카테고리 시드 (DevOps Agent parity) |
| v1/v2 공존 | 완전 분리 병렬 (새 스택 + 새 도메인) |

## 부록 B — 참고

- ADR-024 (CDK 3-Stack 분할), ADR-029 (변경 작업 프레임워크), ADR-030 (ECS Fargate + Aurora), ADR-008 (멀티어카운트), ADR-009 (알림 트리거 AI 진단), ADR-016 (Bedrock 모델 선택).
- AWS DevOps Agent: <https://docs.aws.amazon.com/devopsagent/latest/userguide/about-aws-devops-agent.html>, <https://aws.amazon.com/devops-agent/>
