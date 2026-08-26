# AWSops 라이브 QA 워크스루 — 2026-06-17

- 대상: `https://awsops-v2.example.com` (계정 `123456789012`, ap-northeast-2, Cobalt 기본 테마)
- 계정: `admin@awsops.local` (관리자 — Cognito admins 그룹/SSM allowlist 확인됨)
- 도구: Playwright (뷰포트 1440×900)
- 범위: 전 페이지 기능+시각 검증 + 가이드용 스크린샷

## 결과 요약 (진행 중)

| 페이지 | 라우트 | 결과 | 콘솔 | 비고 |
|---|---|---|---|---|
| 로그인 | /login | ✅ PASS | 0 err | 이메일/비번 폼 정상, 로그인 성공 |
| 대시보드 | / | ✅ PASS | 0 err / 2 warn | KPI 15·차트 4·AI Ops 정상. EKS 4·작업 8/6·비용 $16,547.88 실데이터 |
| AI 어시스턴트 | /assistant | ✅ PASS | 0 err | 스트리밍·도메인 라우팅(💰 Cost)·마크다운 표·스레드 영속 전부 정상 |
| AI 진단 | /ai-diagnosis | ✅ PASS | 0 err | 리포트 자동오픈·목차·MD/DOCX/PDF·Intent 패널·마크다운 본문 정상 |
| 작업(Jobs) | /jobs | ✅ PASS | 0 err | worker_jobs 테이블·상태 배지·정렬 정상 |
| Cost Explorer | /cost | ✅ PASS | 0 err / 1 warn | KPI 5·월별/일별 차트·서비스 드릴다운 패널 정상 |
| Bedrock Usage | /bedrock | ✅ PASS | 0 err / 1 warn | 기간 세그먼트·KPI 5·토큰 추이·모델별 호출/비용 차트 정상 |
| 토폴로지 | /topology | ⚠️ PASS(시각 버그) | 0 err | 그래프(노드 214·엣지 161)·포커스 모드·상세 패널·ARN복사·AI칩 정상. 헤더 레이아웃 버그 ↓ |
| 커스텀 에이전트 | /customization | ⚠️ 렌더 PASS(결함) | 1 err(500) | 관리자 폼·에이전트 목록 정상. /api/integrations/credential 500 ↓ |
| 데이터소스 탐색 | /datasources | ❌ 결함 | 1 err(500) | /api/datasources 500 → 목록 로드 실패, '설정된 데이터소스 없음' 저하 ↓ |
| 리소스 인벤토리 | /inventory/ec2 | ✅ PASS | 0 err / 1 warn | KPI·시간당 비용·정렬 테이블·상세 패널 정상(EC2 대표; 22종 동일 페이지) |
| EKS | /eks · /eks/[cluster] | ✅ PASS | 0 err / 2 warn | 함대 KPI 6·클러스터 카드 4(Connected)·노드 미터·탭(Nodes/Pods/…/Diagnosis)·OpenCost 패널 정상 |
| 내비/테마 | (공통) | ✅ PASS | 0 err | Cmd-K 팔레트·테마 3종(Cobalt/Teal/Dark, theme-reactive)·모바일(상단바+하단탭+FAB) 정상 |

## 발견 사항 / 메모

### 🔴 결함 (수정 검토 필요)
1. **`GET /api/datasources` → 500** (`/datasources`): 데이터소스 목록 호출이 500. 화면은 "설정된 데이터소스가 없습니다 — Connectors에서 연결하세요."로 저하되어, 커넥터가 없는 것처럼 보이지만 실제로는 목록 API 실패. → Datasources 탐색이 라이브에서 사실상 동작 불가.
2. **`GET /api/integrations/credential` → 500** (`/customization`): 커넥터 자격증명 상태 섹션 로드 실패. New Agent/Skill 폼·Agents 목록은 정상. (1과 함께 **integrations/관측성 데이터 계층 공통 원인** 의심 — Aurora 테이블/마이그레이션 또는 쿼리.)
3. **토폴로지 헤더 레이아웃 버그** (`/topology`, ≤1440px): 우측 필터 툴바(검색 + CloudFront + 'LB: 전체'[비정상적으로 넓음] + Refresh)가 제목 칼럼을 밀어내 부제 범례가 **한 글자씩 세로로 줄바꿈**됨. 그래프 기능엔 영향 없음. 'LB' 드롭다운 폭/헤더 반응형 점검 권장.

### 비차단(benign)
- **recharts 경고** `width(-1)/height(-1) of chart should be greater than 0` — 데이터가 없거나 레이아웃 직전 0크기 컨테이너에서 ResponsiveContainer가 내는 경고. 콘솔 warning만, 기능/렌더 영향 없음(대시보드·Cost에서 관측).
- 대시보드 진입 직후 수집 완료 전 KPI(EKS/비용)가 일시적으로 `—`로 표시되다 채워짐 — 의도된 우아한 저하.
- `/jobs`에 `TaskDefinition is inactive`로 failed된 report 작업 다수 — 최근 워커 task-def 패밀리 참조 버그 수정 커밋(ece6c52)과 일치하는 과거 실데이터. 최신 작업은 succeeded.

### 민감정보 (공개 전 검토 — 마스킹/크롭 대상 후보)
- 대시보드/리포트/어시스턴트에 **실제 비용 수치**($16,547.88, 서비스별 금액), **계정 ID `123456789012`**(AI 진단 리포트 본문), 리소스 개수, 보안 카운트 노출.
- 어시스턴트 대화 목록에 데모 리소스명/IP(fsi-demo-monitor-nlb, mgmt-vpc-VSCode-Serv, 10.2.40.11 등).
- Cost 드릴다운에 EC2 인스턴스 타입별 사용량(BoxUsage:g5e/m6i 등).
- 데모/워크숍 계정(example.com·fsi-demo)으로 보이나, 공개 가이드 게시 전 사용자 검토 권장.

## 종합 판정

- **13개 사용자 페이지 + 내비/테마/모바일 전수 검증.** 핵심 기능(대시보드·AI 어시스턴트·AI 진단·작업·비용·Bedrock·토폴로지·인벤토리·EKS)은 모두 **실데이터로 정상 동작** — 인증, 차트, 테이블 정렬, 드릴다운/상세 패널, 스트리밍 채팅(도메인 라우팅·마크다운), 리포트 생성·내보내기, 테마 전환, 모바일 반응형 PASS.
- **결함 3건**(위): `/api/datasources` 500, `/api/integrations/credential` 500(공통 원인 의심), 토폴로지 헤더 레이아웃 글리치(≤1440px). 가이드 게시와 별개로 **추적/수정 권장**.
- **콘솔**: 전 페이지 JS 에러 0(위 500 네트워크 오류 제외). recharts width/height 경고는 비차단.

## 캡처된 스크린샷 (20장)
- getting-started/: login.png, command-palette.png, theme-dark.png, mobile.png
- overview/: dashboard.png, assistant.png, assistant-answer.png
- operations/: ai-diagnosis.png, jobs.png, custom-agents.png
- cost/: cost-explorer.png, cost-drilldown.png, bedrock.png
- resources/: topology.png, topology-detail.png, inventory.png, inventory-detail.png, eks.png, eks-cluster.png
- observability/: datasources.png
