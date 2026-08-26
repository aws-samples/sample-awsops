# AWSops v2 — P1f 착수 전 스코프/설계 3-AI 교차 검증

> 3-AI coordination (codex + gemini + kiro-style standalone). P1f("AgentCore 멱등 provisioner") 플랜 작성 전, P1f↔P3 스코프 경계 + 5개 설계 결정의 정합성 검증. 입력: `/tmp/p1f-scope-question.md` (이 문서에 요지 보존).

## Summary
- **Review Date**: 2026-05-31
- **Branch**: `feat/v2-architecture-design`
- **Reviewers**: codex (CLI), gemini (CLI), kiro-style (standalone 다관점 — kiro-cli 미설치, P1d와 동일 방식)
- **Scope**: P1f 스코프 경계(MIN/MID/MAX) + Q2 provisioner 호출 방식 + Q3 config 전달 + Q4 런타임 이미지/오케스트레이터 + Q5 완료 기준
- **Overall**: **PASS (조건부)** — Q2/Q4 만장일치, Q1/Q3/Q5는 종합으로 수렴
- **결정 스코프**: **MID-minus** (provisioner 기계 + 9 Gateway[#7 빈 상태] + Runtime/Memory/Interpreter + 대표 Lambda/타깃 슬라이스 + SSM config). 전체 Lambda 함대 배포·큐레이션·라우팅·UI = **P3**.

## 핵심 사실 (검증됨)
- v1: 8 Gateway, 19 Lambda, 등록 도구 ≈125(문서상; 실제 inlinePayload 합산은 datasource-diag 중복계상으로 130–138 편차 — v1 문서 불일치, P3에서 정밀 확정).
- **AgentCore Gateway/Target 모델**: 한 Gateway가 N개 Target(각 Target=Lambda 1 + 자체 inlinePayload). **Target은 독립** — 스키마 병합 없음. → 타깃 N개 등록은 N=3이든 13이든 `create_gateway_target` **동일 코드 경로**. 따라서 provisioner 검증은 **breadth(개수)가 아니라 path-coverage(경로 다양성)**.
- v1 멱등성: Gateway·Memory만 있음. **Runtime·Endpoint·Code-Interpreter·Target 스키마 드리프트는 멱등성 없음** → v2 래퍼의 핵심 산출물.
- config 주입(06e)은 **죽은 코드**(없는 const를 sed). 앱은 `data/config.json`의 `agentRuntimeArn`/`codeInterpreterName`/`memoryId`를 읽음. agent.py는 Gateway URL을 **런타임 list-gateways 자동발견** → URL 주입 불요.
- v2 Terraform: 단일 root `foundation/`(파일별 구성, `ai.tf` 부재 → eks.tf처럼 자족 파일 추가). **SSM/Secrets 리소스 부재**(Aurora 관리형 secret만). `terraform apply` 수동. **v2 Steampipe 서비스 미구축** → VPC Lambda(istio, steampipe-query) 차단.

## 각 AI 판정 요지

| Q | codex | gemini | kiro-style |
|---|-------|--------|-----------|
| Q1 스코프 | AGREE-W/MODS — MID, 단 **`reachability`(유일 write) 게이트/제외**(v2에 ADR-029 mutating 게이트 부재), read-only 하드라인 | AGREE — **full MID**(비-VPC 17 Lambda ~110도구 전량, 스케일 증명) | AGREE-W/MODS — **MID-minus**: 9 Gateway(#7 **빈 상태**) + 대표 ~3 타깃만. 전량 remap은 P3가 ≤25 큐레이션/#7 레지스트리로 **재작성→폐기 작업** |
| Q2 provisioner | AGREE — (A) post-apply Python, null_resource는 환상. + 머신리더블 diff 리포트 | AGREE — (A) Python. Node 포팅=불필요한 yak shave | AGREE — (A) Python. TF↔Python 이음새는 `terraform output -json` 한 계약 |
| Q3 config | AGREE-W/MODS — SSM 옳음. 앱이 config.json 읽으니 **env/SSM 우선** 해석 경로 필요 | **DISAGREE → 런타임 fetch**: make agentcore가 apply 후 SSM 기록 → ECS `valueFrom`는 **태스크 시작 시 빈 값 읽는 레이스**. BFF가 런타임 AWS SDK로 fetch (또는 SSM 기록 후 ECS bounce) | AGREE-W/MODS — SSM **String**(ARN은 비밀 아님). valueFrom 쓰면 **execution-role 권한**(P1d 배포 블로커 재발 주의) |
| Q4 이미지/오케 | AGREE-W/MODS — agent.py 재사용+arm64 dual ECR, 오케스트레이터 P4. CLI 서브프로세스 발견은 boto3로 견고화 | AGREE — 수정 0(자동발견), Opus는 P4 | AGREE — 9번째 자동 픽업, 오케스트레이터는 **P2 워커 위**라 P4 의존. region을 SSM/output에서 |
| Q5 완료 기준 | AGREE-W/MODS — 2회 no-op + **스키마 드리프트 reconcile** + read-only 저권한 도구 smoke | AGREE — 멱등+E2E가 골드. + **스키마 쿼터 ValidationException 트랩** | AGREE-W/MODS — no-op만으론 불충분(이미 멱등인 Gateway/Memory 증명 무의미). **드리프트 재실행 + Runtime 재실행 + SSM→런타임 경로 통과** smoke |

## 종합 (synthesis)

### Q1 — **MID-minus 채택** (kiro 논거 + codex 하드라인; gemini full-MID는 기각)
- **근거1 (기술)**: Target 독립 모델상 breadth는 provisioner 확신을 더하지 않음. **대표 슬라이스(다중도구 cross-account 1 + HTTP-proxy no-account 1 + 드리프트 테스트 1)가 모든 코드 경로를 커버**. gemini의 "스케일 증명"은 Bedrock *Agents* action-group 스키마 병합을 전제하나 AgentCore *Gateway*는 타깃별 독립이라 부적용.
- **근거2 (spec §9)**: §9는 "9 Gateway 재분배"를 **P3**에 명시 배정. Lambda 함대 배포 = 재분배 본체 = P3. P1f = provisioner **기계**.
- **근거3 (폐기 회피)**: P3가 ≤25 큐레이션 + hidden-handler 승격 + #7 레지스트리 + datasource-diag 재배치를 수행 → P1f가 전량 배포하면 "배포됐으나 §4 목표도 v1도 아닌 전이 토폴로지"가 SSM/Runtime에 박혀 **'done처럼 보이나 아님'** 디버깅 위험(kiro 최대 리스크).
- **carve-outs (만장일치 반영)**: ① **#7 External Observability = 빈 Gateway**(레지스트리·OTLP·datasource-diag 재배치는 P3). ② **datasource-diag(8) 미이전** — §4 #6 Monitoring은 "AWS 네이티브만"이라 외부 관측 도구는 #6 소속 아님 → P1f Monitoring=CloudWatch+CloudTrail가 **최종 상태**(전이 아님). ③ **`reachability`(유일 write op) 제외** — v2에 ADR-029 mutating-action 게이트 부재(codex). ④ **VPC Lambda(istio, steampipe-query) 제외** — v2 Steampipe 부재(만장일치).
- **대표 슬라이스 후보**: `iam-mcp`(14도구, 최대 스키마 + cross-account) · `aws-knowledge` 또는 `terraform-mcp`(HTTP-proxy, no account) · `core-mcp`(경량) — Lambda 배포 TF for_each **카탈로그 패턴**을 증명(P3가 리스트만 확장). *(정확한 후보는 플랜에서 확정.)*
- ⚠️ **소수의견 보존**: codex·gemini는 비-VPC **전체 카탈로그**(13 Lambda)를 선호. 종합은 (a) Target 독립 모델, (b) §9의 재분배=P3 문언, (c) 폐기 회피를 들어 **대표 슬라이스**로 수렴. 만약 "P2/P3 개발 중 실동작 에이전트 레이어가 필요"가 우선되면 full-MID로 상향 가능(트레이드오프: P3 재큐레이션 비용).

### Q2 — **(A) post-apply Python boto3 멱등 모듈** (만장일치)
- TF = ECR/IAM/Lambda/SSM(=TF가 잘하는 것). `make agentcore` = Runtime/Gateway/Target/Memory/Interpreter (list→create/update 멱등, **Runtime update는 role-arn+network-config 재전달**). `null_resource`+raw 지양(spec §8). **diff/no-op 리포트** 출력으로 드리프트 가시화(codex). 언어=Python(inlinePayload known-good; Node 포팅=리스크).

### Q3 — **SSM(String) source-of-truth + BFF 런타임 read** (gemini 레이스 해소)
- provisioner가 `agentRuntimeArn`/`codeInterpreterId`/`memoryId`를 **SSM String** `/awsops-v2/agentcore/*`에 기록. **web BFF는 런타임에 AWS SDK로 SSM read**(캐시) → config.json은 로컬개발 폴백. **web task role**에 `ssm:GetParameter`(execution-role 아님 — valueFrom 레이스/P1d 블로커 회피). Gateway URL 주입 불요(자동발견).

### Q4 — **agent.py 재사용 + arm64 dual ECR; 오케스트레이터 P4** (만장일치)
- 9번째 Gateway 자동 픽업(코드 0수정). arm64 buildx 명시. Runtime update 멱등은 모듈에. region은 SSM/output에서(베이크 상수 금지). 오케스트레이터(Opus)는 P2 워커 의존 → **P4**(memory ① 의 "+1"은 P1f 아님).

### Q5 — **GREEN 바 (강화)**
1. provisioner 2회 실행 → 2회차 clean no-op; **추가로** 의도적 **타깃 스키마 드리프트 재실행 → update-in-place**(Conflict/silent-skip 아님) + **Runtime 재실행**(role-arn+network 재전달).
2. 9 Gateway(#7 빈 상태 포함) + Runtime + Memory + Interpreter + **대표 타깃 슬라이스** 존재.
3. **SSM→BFF read 경로 통과** smoke: web가 SSM에서 runtimeArn 해석 → ≥1 Gateway 통해 read-only 저권한 도구 호출 → 실제 tool 결과 반환(손전달 ARN 금지).
4. **명시적 non-goal**(플랜에 기재): VPC Lambda, section=routing, ≤25 큐레이션, #7 레지스트리, datasource-diag 재배치, reachability, Incident 오케스트레이터 — 전부 P2/P3/P4.
5. 등록 타깃 catalog 검증 + ValidationException(스키마 쿼터) 트랩(gemini).

## Findings

| # | Severity | Lens | Finding | Recommendation |
|---|----------|------|---------|----------------|
| 1 | **HIGH** | Spec/Cost | full-MID(비-VPC 전량)은 P3 ≤25 큐레이션·#7 레지스트리가 재작성 → 폐기 + 전이 토폴로지 'done처럼 보임' | **MID-minus**: 대표 슬라이스로 모든 provisioner 경로 증명, 함대 배포는 P3 |
| 2 | **HIGH** | Spec | datasource-diag(8)→#7 이전은 P3 선점(§9 레지스트리=P3) | **#7 빈 Gateway** 생성, datasource-diag 미이전(§4 #6=AWS네이티브만 → Monitoring 최종상태와 일치) |
| 3 | **HIGH** | Reliability | Q3 **SSM 레이스**: post-apply 기록 vs ECS 태스크 시작 시점 valueFrom read | **BFF 런타임 SSM read**(web task role `ssm:GetParameter`); valueFrom 미사용 |
| 4 | **HIGH** | Security | `reachability` = 유일 write op, v2에 ADR-029 게이트 부재 | P1f에서 **제외**(Network=network-mcp+flow-monitor read-only) |
| 5 | MEDIUM | Ops | "2회 no-op"는 이미 멱등인 Gateway/Memory만 증명 가능 | 드리프트 재실행 + Runtime 재실행을 GREEN 바에 명시 |
| 6 | MEDIUM | Security | 신규 AgentCore Gateway IAM role/ provisioner creds = 새 권한면 | Gateway role을 특정 Lambda invoke ARN으로 최소화; provisioner creds=`bedrock-agentcore-control`로 스코프; read-only 불변식 보존 |
| 7 | MEDIUM | Ops | (A)는 `terraform plan`에 드리프트 안 보임 | 모듈 매 실행 self-reconcile + diff 리포트 + CI smoke |
| 8 | LOW | Reliability | VPC Lambda 차단이 비강제면 MAX-creep로 Steampipe 끌려옴 | non-goal로 문서·강제, 차단 의존성(v2 Steampipe) 별도 추적 |
| 9 | LOW | Sustainability | arm64 + 관리형(Runtime/Gateway/Memory) — 양호. 9 빈 Gateway는 거의 무비용 | 현행 유지 |

## Decision

| Verdict | 조건 |
|---|---|
| **PASS (조건부)** | Q2/Q4 만장일치. Q1=**MID-minus**, Q3=**BFF SSM read**, Q5=강화 바 반영 시 플랜 착수 적합 |

## Action Items (→ P1f 플랜 반영)
- [ ] **스코프 MID-minus**: provisioner 기계 + 9 Gateway(#7 빈) + Runtime/Memory/Interpreter + 대표 read-only 비-VPC Lambda 슬라이스 + SSM. (전량 함대/큐레이션/라우팅/UI/#7 레지스트리/datasource-diag 재배치/reachability/VPC Lambda/오케스트레이터 = **non-goal**)
- [ ] **Q2**: `make agentcore` post-apply Python boto3 멱등 모듈(list→create/update, Runtime update=role-arn+network 재전달, diff 리포트). TF=ECR/IAM/Lambda/SSM in `foundation/ai.tf`.
- [ ] **Q3**: SSM String `/awsops-v2/agentcore/*` + web BFF 런타임 SSM read + web task role `ssm:GetParameter`(config.json=로컬 폴백).
- [ ] **Q4**: agent.py 재사용 → arm64 dual ECR(`awsops-v2-agentcore`). 오케스트레이터 P4.
- [ ] **Q5 GREEN**: 2회 no-op + 드리프트 재실행 update-in-place + Runtime 재실행 + SSM→BFF→Gateway read-only smoke. non-goal 명시.
- [ ] **보안**: Gateway role 최소권한(특정 Lambda ARN), provisioner creds 스코프, read-only 불변식.
