# AWSops 블로그 원고 편집 리뷰 — Codex 작업 브리프

- 대상 원고: `blog/2026-09-awsops/draft-awsops-architecture.md` (431줄, 커밋 `3b11e396`, 브랜치 `codex/awsops-sre-blog-20260911`)
- 보조 자료: `blog/2026-09-awsops/technical-notes.md`, `README.md`, `drawio/*.drawio`, `images/*.png|svg`, `render_preview.py`
- 리뷰 기준: aws.amazon.com/ko/blogs/tech 편집 기준. 현 판정 **45/100, 게시 반려**.
- 리뷰일: 2026-09-13

## 0. 작업 규칙 (반드시 준수)

1. **사실을 새로 만들지 말 것.** 원고와 `technical-notes.md`에 근거가 없는 수치·기능·성과를 추가하지 않는다. 근거가 없으면 문장을 삭제하거나 질적 서술로 바꾼다.
2. **`technical-notes.md`와의 정합성 유지.** 본문에서 삭제·이동한 항목이 기술 노트에서 "본문 L##"로 참조되면 노트도 함께 갱신한다. "게시 준비" 절에 이번 수정으로 해결된 항목은 체크하고, 남은 항목(저자 소개)은 유지한다.
3. **그림 재생성은 `.drawio`가 원본.** PNG/SVG를 직접 편집하지 말고 `drawio/*.drawio`를 수정한 뒤 PNG·SVG를 다시 내보낸다. 내보내기가 불가능한 환경이면 `.drawio`만 수정하고 `technical-notes.md`에 "PNG/SVG 재내보내기 필요"를 남긴다.
4. **분량 목표 3,800~4,000어절.** 완료 후 `wc -w`로 확인하고 결과를 커밋 메시지에 기록한다.
5. **유지할 것(손대지 말 것):** §4의 프롬프트 블록쿼트 5개, §5.2의 5단계 목록과 "매시간 예약 확인 · 15분 digest" 수치, 그림 1(`fig-sre-workflow`), 기술 노트의 근거 추적 구조.
6. 커밋은 작은 단위로 나눈다(예: 텍스트 감축 / 서비스명·용어 / 그림 / 참고 자료). 커밋 메시지 끝에 `Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>`는 붙이지 않는다(Codex 작업).

## 1. Blocker — 게시 전 필수

### B1. AWS 네이티브 서비스와의 관계 언급 0회 — §3.1 · §3.2 · §4.2
- §3.1 인벤토리 ↔ AWS Config·AWS Resource Explorer, §3.2 관계 그래프 ↔ Resource Explorer, §4.2 `check_reachability` ↔ Amazon VPC Reachability Analyzer. 본문·노트 모두 0회.
- **수정:** 세 절 도입부에 각 2~3문장. 예(§3.1): "AWS Config와 AWS Resource Explorer로도 구성 인벤토리를 조회할 수 있습니다. AWSops가 Steampipe를 사용한 이유는 외부 관측 시스템과 같은 SQL 인터페이스로 조회 경로를 통일하기 위해서입니다." §4.2에는 "Amazon VPC Reachability Analyzer와 목적이 겹치지만 이 구현은 분석 리소스를 생성하지 않고 수집된 구성만 읽습니다." 참고 자료에 세 서비스 문서 링크 추가.

### B2. 미검증 수치를 리드에서 볼드로 강조 — L9, §7 표 L376~379
- "**미암호화 EBS 6건과 미사용으로 확인한 VPC 엔드포인트 관련 ENI 28개**". `technical-notes.md`가 범위·기간·재검증 없음으로 기록.
- **수정:** 리드(L9)에서 수치 문단 삭제. §5 말미(B4에 따라 §7.2가 이동한 자리) 한 곳에만 남기되 볼드 제거하고 범위를 붙인다: "단일 계정·단일 리전 운영 점검 1회에서 발견한…". 범위를 확정할 수 없으면 수치를 빼고 "암호화되지 않은 Amazon EBS 볼륨과 사용 경로가 확인되지 않은 VPC 엔드포인트 인터페이스처럼…" 질적 서술만 남긴다.

### B3. 내부 플래그·환경 변수·테이블명 노출 — L85, L101, L141, L279, L287, `fig1-overview`
- 제거 대상: `workers_enabled`, `diagnosis_schedule_enabled`, `diagnosis_notify_enabled`, `graph_rebuild_interval_mins`, `AWSOPS_EXTERNAL_ID`, `topology_nodes`, `topology_edges`.
- **유지 대상(도구명은 걸어가기 역할):** `get_topology`, `query_inventory`, `inventory_summary`, `get_eni_details`, `check_reachability`, `find_unused_resources`, `AWSopsReadOnlyRole`, `ExternalId`(IAM 개념).
- **수정 예:** L279 → "예약 진단은 기본적으로 비활성 상태이며, 관리자가 워커 기반과 진단 스케줄을 각각 켠 뒤 사용자가 주기를 활성화해야 실행됩니다." L101 → "자동 재구성은 기본적으로 꺼져 있고 주기를 설정해 켭니다." L85 → "결과를 노드·연결선 테이블에 저장합니다."
- **그림:** `drawio/fig1-overview.drawio` 하단 각주 중 `예약 진단: workers_enabled + diagnosis_schedule_enabled 필요 · 모두 기본 OFF / SNS digest도 별도 활성화` 행을 "예약 진단·알림은 기본 비활성(관리자 활성화 필요)" 1행으로 교체. `Resource Graph · topology_nodes / edges` 박스 제목은 "Resource Graph"로. PNG·SVG 재생성.
- **검증:** `grep -nE 'workers_enabled|diagnosis_schedule_enabled|diagnosis_notify_enabled|graph_rebuild_interval_mins|AWSOPS_EXTERNAL_ID|topology_nodes|topology_edges' draft-awsops-architecture.md` 결과 0건.

### B4. 분량 40% 감축 — 6,525 → 3,800~4,000어절
절단 계획(위에서 아래 순서로 적용):

| 대상 | 현재 어절 | 조치 | 절감 |
|---|---|---|---|
| §7 전체(L351~403) | 752 | §7.1 표는 §2 표와 4행 중복 → 삭제. §7.2(발견 사례)·§7.3(워커 검증 표 + 뒤 1단락)만 §5 말미로 이동해 "5.5 검증으로 확인한 것"으로. 나머지 산문은 마치며 3문장으로 흡수 | −680 |
| §3.5(L145~157) ↔ §4.3(L226~252) | 675 | 같은 논지. §3.5 삭제, 필요한 문장(Compute Optimizer·`find_unused_resources`)만 §4.3에 병합 | −350 |
| §3.4(L125~143) | 411 | 외부 관측 3문장 + 교차 계정 3문장 + ExternalId 1문장. 벤더 프리셋 문단(L133)·계정 등록 검증 문단(L139) 삭제 | −230 |
| §1(L15~31) | 373 | 8단락 → 3단락. L21(지식 집중)·L27(알람 없는 위험)은 리드와 중복 | −190 |
| §5.2 후반(L289~295) | — | 5단계 목록 유지, 뒤따르는 3단락(대조·묶음 전달·SRE 가치) 삭제 | −190 |
| §2(L33~46) | 259 | 표 4행만 남기고 산문 삭제, §1 말미로 통합 | −180 |
| §5.4(L309~317) | 159 | §5.1에 "점수는 제품 내부 보조 지표이며 Well-Architected Tool 결과가 아님" 2문장으로 흡수 | −130 |
| 리드(L3~13) | 286 | 6단락 → 3단락(m4 순서 참고) | −120 |
| §6 L337(OpenSearch POST) | — | 삭제 | −80 |
| 헤지 정리(M1) | — | 절당 면책 1개 | −300 |
| **합계** | **6,525** | §4.1·§4.2에서 각 150어절 추가 감축 시 3,800 안쪽 | **−2,450** |

### B5. 제목 교체 — L1
- 현재 "Amazon Bedrock AgentCore로 SRE 모니터링과 비용 가시성 높이기". "높이기"는 개선 주장인데 본문이 6회 부인. AgentCore는 전체의 6%.
- **수정 후보(하나 선택):** "Amazon Bedrock AgentCore와 읽기 전용 MCP 도구로 SRE 장애 조사와 정기 진단 연결하기" / "SRE 온콜 조사와 정기 진단을 위한 읽기 전용 AI 운영 대시보드 구축". `README.md`·`render_preview.py`의 제목 참조도 갱신.

## 2. Major

### M1. 헤지 밀도 — L9, 139, 141, 157, 193, 275, 335, 383 (부인문 ≥ 주장문 단락)
- 규칙: 절당 면책 1개. "측정값이 아님"(L9·161·357·383·391·399, 6회) → §4 도입 L161 한 곳만. "기존 승인·변경 관리 절차"(L50·224·307·385, 4회) → §4.2 L224 한 곳만.
- 모호한 부인은 근거 있는 사실로: L234 "비용 데이터의 갱신 지연도 고려해 … 취급하지 않습니다" → "AWS Cost Explorer 데이터는 최소 24시간 주기로 갱신되며 더 늦어질 수 있습니다. 따라서 비용 수치는 장애 지표와 같은 실시간 신호가 아닙니다."(기술 노트에 근거 있음).
- L141 재작성 예: "제3자나 공유 계정에서는 `ExternalId` 조건을 함께 사용합니다. 이 값은 여러 고객 계정을 대신 조회하는 주체가 권한 사용 맥락을 구분하도록 돕습니다. 현재 구현은 계정마다 다른 값을 자동 선택하지 않으므로, 계정별로 값이 다른 환경에서는 연결 범위를 먼저 확인합니다."
- **검증:** `grep -cE '(아닙니다|않습니다)\.$' draft-awsops-architecture.md`가 현재 28 → 목표 10 이하.

### M2. 정식 서비스명 첫 언급 + bare Fargate
첫 언급을 정식 명칭으로 교체(이후 약칭 허용). 표가 본문보다 먼저 나오면 표 안에서도 정식 명칭.

| 서비스 | 첫 언급 | 교체 |
|---|---|---|
| Amazon Aurora | L39(표) | "Amazon Aurora 저장" |
| Amazon EC2 | L68 | "Amazon EC2 구성 정보" |
| Amazon CloudFront | L83 | "Amazon CloudFront의 오리진" |
| AWS IAM | L117 | "AWS IAM 역할 분리" |
| AWS CloudTrail | L220 | "AWS CloudTrail의 변경 이력" |
| AWS Security Hub | L269(표) | "AWS Security Hub 심각도 통계" |
| Amazon S3 | L286 | "Amazon S3에 저장" |
| Amazon SNS | L287 | "Amazon SNS" |
| Amazon OpenSearch Service | L337 | (B4에서 삭제되면 해당 없음) |
| AWS Step Functions | L343 | "AWS Step Functions 실행" |
| Amazon EBS | L9→이동 위치 | "암호화되지 않은 Amazon EBS 볼륨" |
| Amazon ECS | 첫 언급 | "Amazon ECS" |
| AWS Fargate | L327(alt), L343, 그림 라벨 3곳 | "AWS Fargate 웹 컨테이너", "AWS Fargate 워커"; drawio 라벨 `Steampipe Fargate`·`Fargate 워커`·`Fargate web :3000` → `AWS Fargate` 접두 |

- **검증:** 각 서비스의 첫 등장 줄에 정식 명칭이 있는지 `grep -n` 으로 확인.

### M3. 용어 통일·정의 순서
- "여섯 기둥"(L11·262·311·409·427) / "6개 기둥"(L13·42·254·365·385) → **"여섯 가지 기둥"**으로 통일. §5 제목 포함.
- "Cross-account" → "교차 계정"(AWS 한국어 문서 표기). 첫 언급에 "교차 계정(cross-account)".
- "target health"(L99) → "대상 상태(target health)".
- "NACL"(L99)이 "네트워크 ACL"(L216)보다 먼저 → L99에서 "네트워크 ACL(NACL)".
- ENI·EBS·CIS 첫 언급 전개: "네트워크 인터페이스(ENI)", "CIS(Center for Internet Security) 벤치마크".
- **Resource Graph** 첫 언급(L11) → "AWSops가 구성한 리소스 관계 그래프(이 글에서는 Resource Graph로 표기)". Azure Resource Graph·AWS Resource Explorer와 혼동 방지.
- **Lambda MCP** §2 표(L41) → "AgentCore Gateway에 등록한 조회 도구와 교차 계정 연결"로 일반화. 용어는 §3.3(L109)에서 도입.

### M4. 코드 블록 — 재현 불가 3개, 출력 예시 0개
- L70~73 SQL: 바로 뒤 L75에서 부인하는 경로. 삭제하거나 관계 구성에 실제 쓰는 컬럼(예: `vpc_id`, `subnet_id`, `security_groups`)을 포함한 SQL로 교체.
- L207~214 JSON 입력 스키마 → **반환 결과 형태**로 교체(검사한 항목·차단 가능 규칙·검사 범위 필드). 실제 도구 반환 구조는 `agent/lambda/` 네트워크 MCP 구현에서 확인해 필드명을 맞춘다. 없는 필드를 만들지 않는다.
- 재현 가능한 블록 1개 추가(§3.3): AgentCore Gateway에 Lambda 타깃을 등록하는 boto3 호출 — 리포의 프로비저너(`agent/` 또는 `scripts/` 하위 `create_targets.py`)에서 실제 호출 형태를 가져와 축약.
- L175~179 Logs Insights 쿼리에 `| sort matching_events desc` 추가, 아래에 "조회 기간은 알람 상태 변경 시각 앞뒤 30분으로 지정합니다" 1문장.

### M5. 그림 3(`fig4-agentcore`) 캡션·내용 불일치 — L121~123
- 그림에 본문 미언급 요소: Code Interpreter, "Memory (프로비저닝만, 미연결)", "게이트웨이 ×9", "Gateway 등록 Lambda ×27". "코드 실행 (직접 호출)" 라벨 끝 스트레이 문자(¯).
- 캡션 "그림의 도구 수는 기본 타깃 카탈로그 기준"은 오류(그림 숫자는 Lambda·게이트웨이 개수).
- **수정:** drawio에서 Memory 박스 제거(Code Interpreter도 본문 설명이 없으면 제거), 스트레이 문자 제거, ×27은 `terraform/v2/foundation/ai.tf`의 `local.agent_lambdas`와 대조해 맞추거나 숫자 삭제. 본문 §3.3에 "도메인별 게이트웨이 9개에 조회 Lambda를 등록했습니다" 1문장. 캡션 → "그림 3. AgentCore Runtime과 Gateway가 호스트 계정의 읽기 전용 Lambda 도구를 호출하는 경로."

### M6. 그림 2(`fig1-overview`) 정보 과밀 + 캡션 4장 과다
- 4패널+각주 7행, 4086×3178. 블로그 폭에서 패널 내 문장 판독 불가.
- **수정:** `fig1-overview.yaml`/`.drawio`를 두 장으로 분할 — `fig2a`: ①운영자 접근 + ②대화형 AI, `fig2b`: ③인벤토리·Resource Graph + ④예약 진단. 패널 안 설명 문장은 본문으로 옮기고 그림에는 라벨만. 각주 전부 제거(B3 포함). 본문에서 두 그림을 §3 도입과 §5.2에 각각 배치.
- 캡션 4장 모두 1문장 40~80자로. 면책 문장은 본문으로.

### M7. 그림 파일명 ↔ 그림 번호 불일치
- `fig-sre-workflow`→그림 1, `fig1-overview`→그림 2, `fig4-agentcore`→그림 3, `fig2-private-edge`→그림 4.
- **수정:** M6 분할 후 최종 번호에 맞춰 `fig1-sre-workflow`, `fig2a-*`, `fig2b-*`, `fig3-agentcore`, (M11 적용 시 private-edge 제외) 로 `git mv`. `drawio/`, `images/`, 본문 참조, `README.md`, `render_preview.py`, `technical-notes.md` 동시 갱신.

### M8. 참고 자료 — L413~431
- GitHub 소스 파일 딥링크 5개(`graph-store.ts`, `inventory_read_mcp.py`, `sections.py`, `schedule_dispatcher.py`, `06-workers.md`) 삭제 → 리포 루트 링크(마치며 L411에 있음)로 대체.
- AWS 문서 링크 로케일 통일(`/ko_kr/` 전부 또는 전부 제거).
- 추가: Strands Agents 공식 문서, Model Context Protocol 사양, Powerpipe 문서, AWS Config·Resource Explorer·VPC Reachability Analyzer(B1). 총 8~12개.

### M9. 구조 요소 누락
- §3 앞에 "전제 조건" 3~4줄: 조회 전용 IAM 역할과 대상 계정 온보딩, Amazon Bedrock 모델 액세스, (선택) 외부 관측 데이터 소스 자격증명.
- "마치며" → "결론"으로. 다음 단계 2~3개 명시: "Amazon Bedrock AgentCore 콘솔에서 Gateway 하나에 Lambda 타깃 1개를 등록해 도구 계약이 어떻게 노출되는지 확인해 보세요." + 리포 배포 가이드 링크.
- 결론 뒤 저자 소개 자리표시자(`<!-- 저자 소개: 게시 담당자 확정 -->`).

### M10. 서드파티 표기
- L133 "Datadog, Dynatrace, New Relic의 프리셋" → "일부 관측 플랫폼이 공식 제공하는 MCP 서버를 Gateway 타깃으로 등록하는 경로도 있습니다. 실제 사용에는 별도 활성화와 인증 설정, 읽기 전용 확인, 런타임 도구 허용목록이 필요합니다."(B4에서 문단 삭제 시 해당 없음)
- L66 → "구성 정보는 오픈소스 도구 Steampipe(Turbot)로 수집합니다. 동기화를 활성화하면 기본 15분 간격으로 실행됩니다."
- L303 → "규칙 점검은 Steampipe와 함께 쓰는 오픈소스 벤치마크 실행 도구 Powerpipe로 CIS 벤치마크를 평가합니다."
- L107 → "AWS가 공개한 오픈소스 에이전트 SDK인 Strands Agents로 작성한 에이전트는…"

### M11. §6은 이전 아키텍처 글의 재탕 — L319~349, `fig2-private-edge`
- 인증·엣지 서술(L325~333)은 3~4문장으로 압축, 그림 4(private-edge) 제외.
- 워커 절(L339~349)에는 렌더만 되어 있는 `fig5-workers.png`를 배치하고 L345~349 산문을 절반으로.

## 3. Minor

- **m1 제목·번호 체계:** §6·§7 하위 절 번호 없음, §5·§6·§7은 H2 직후 도입 없이 H3, 제목 문법 의문형/~하기/명사구 혼재. 번호는 전체 부여 또는 전체 제거, 각 H2 아래 2~3문장 도입, 명사구 헤딩 우선.
- **m2 내부 은어·직역:** "원장"(7회) → 첫 언급 "작업 상태를 한 곳에 기록하는 공통 작업 기록(원장)"; `reaper` → "정리 작업(reaper)"; "SNS 확인된 수신자" → "수신 확인을 마친 Amazon SNS 구독자"; "도구 계약" → "도구의 이름·설명·입력 형식을 명시한 정의"; "선점" → "실행을 확보".
- **m3 표:** 8개 전부 3열, 6개가 같은 수사 구조. L188(원인 후보)·L243(비용 후보)는 불릿으로, L360·L377은 B4에서 삭제, 여섯 기둥 표(L267)·그래프 3관점 표(L90)·검증 표(L392)만 유지.
- **m4 리드 순서:** ①온콜 훅(L3+L5 압축) → ②문제 정의(L7) + AWSops 한 문장 → ③"이 글에서는 (1) 흩어진 운영 데이터를 조사 가능한 질문으로 바꾸는 설계, (2) Amazon Bedrock AgentCore에 읽기 전용 조회 도구를 연결하는 방법, (3) Well-Architected 여섯 가지 기둥 기반 정기 진단 자동화를 살펴봅니다."

## 4. 완료 기준 (Codex 자체 검증)

```bash
cd blog/2026-09-awsops
wc -w draft-awsops-architecture.md                       # 3,800~4,000
grep -cE '(아닙니다|않습니다)\.$' draft-awsops-architecture.md   # ≤ 10
grep -nE 'workers_enabled|diagnosis_schedule_enabled|diagnosis_notify_enabled|graph_rebuild_interval_mins|AWSOPS_EXTERNAL_ID|topology_nodes|topology_edges' draft-awsops-architecture.md   # 0건
grep -nE '(^|[^A-Za-z])Fargate' draft-awsops-architecture.md | grep -v 'AWS Fargate'   # 0건
grep -c '6개 기둥\|여섯 기둥' draft-awsops-architecture.md      # 0 (여섯 가지 기둥만)
grep -n 'blob/main' draft-awsops-architecture.md          # 0건
grep -n '^!\[' draft-awsops-architecture.md               # 파일명과 그림 번호 일치 확인
python3 render_preview.py                                 # preview.html 재생성, 이미지 경로 깨짐 없음
```

- `technical-notes.md` "게시 준비" 절 갱신, 이번 리뷰로 해결된 항목 표기.
- 최종 커밋 메시지에 어절 수 before/after 기록.

## 5. 참고: 잘 된 부분 (변경 금지)

- §4 프롬프트 블록쿼트 5개(L167·195·203·230·238)
- §5.2 5단계 목록(L283~287)과 "매시간 예약 확인", "15분 주기 digest" 수치
- 그림 1 `fig-sre-workflow` 및 그 캡션
- `technical-notes.md`의 근거·미검증 추적 구조
