# AWSops v2 아키텍처 심층 리뷰 — P1d 착수 전 정합성 검증

> Architecture Deep Review (kiro-review). P1d 플랜 작성 전, P1a~P1c 구현 인프라 + 설계 spec + P1d 설계 방향의 정합성/보안/Well-Architected 검증.

## Summary
- **Review Date**: 2026-05-31
- **Branch**: `feat/v2-architecture-design`
- **Changes**: 31 files, +4,146 (P1a~P1c 구현 + 설계 spec). TF 12개가 핵심.
- **Scope**: 구현된 `terraform/` 인프라 + 설계 spec(`2026-05-30-awsops-v2-architecture-design.md`) + P1d 설계 방향(thin-BFF / spine→web / dual-ECR / make deploy)
- **Kiro Review**: Standalone (kiro-cli-plugin 미설치 → 자체 다관점 리뷰)
- **Overall Risk**: **MEDIUM** — CRITICAL 1건은 P1d D5에 해결 계획이 이미 확정됨(mitigation plan 존재)
- **Verdict**: **REVIEW** → 권고 반영 시 **PASS**

## Findings

| # | Phase | Severity | Category | Finding | Recommendation |
|---|-------|----------|----------|---------|----------------|
| 1 | Adversarial/Code | **CRITICAL** | 인증 우회 | Lambda@Edge JWT가 **서명 미검증** — `decode_jwt_payload`가 base64 페이로드만 디코드, `exp`만 확인. 공격자가 임의 id_token을 위조(서명 무관)하고 `exp`를 미래로 두면 인증 통과 | **P1d D5(이미 계획됨)**: Cognito JWKS로 **RS256 서명 검증** + `iss`/`aud`(client_id)/`token_use` 검증 |
| 2 | Adversarial | **HIGH** | CSRF | OAuth authorization-code flow에 **`state` 파라미터 없음** → 로그인 CSRF / code injection 가능. `nonce`도 없어 서명 미검증과 결합 시 토큰 replay | **D5에 추가**: `/login` 요청 시 `state`(+선택 `nonce`) 생성·쿠키 바인딩, `/_callback`에서 검증 |
| 3 | Code/WA-보안 | MEDIUM | 네트워크 | ALB SG가 `cidr_blocks=[VPC CIDR]` 443 **전체 허용** — CloudFront VPC Origin 관리형 SG ingress만으로 도달 충분(메모리 학습 4529855) | **D2**: ALB SG의 VPC-CIDR 443 ingress 제거(최소권한, CF VPC Origin SG만 유지) |
| 4 | Code/WA-보안 | MEDIUM | 네트워크 | Aurora SG가 `VPC CIDR` 5432 전체 허용(in-VPC 마이그레이션 잔재) | 마이그레이션 채널을 **deploy host SG**로 한정하거나 마이그레이션 후 제거. make deploy의 psql 경로와 함께 D2에서 결정 |
| 5 | Code/WA-비용 | MEDIUM | 비용/성능 | `/_next/static/*` behavior에도 **viewer-request Lambda@Edge 부착** → 정적 자산 매 요청마다 edge 함수 실행(viewer-request는 캐시 앞단이라 캐시 히트에도 실행) | **D1/edge**: 정적 경로는 인증 우회(빠른 통과) 검토. `_next/static`은 해시 파일명이라 민감도 낮음. edge 함수에서 정적 prefix early-return |
| 6 | WA-안정성 | LOW(dev)/HIGH(prod) | 안정성 | 단일 NAT GW(AZ 장애 시 타 AZ egress 중단) / ECS `desired_count=1`(이중화 없음) / Aurora 단일 writer | **prod 백로그**: NAT per-AZ, ECS autoscaling+min2, Aurora reader 추가. dev는 비용상 현행 유지 |
| 7 | Code/Adversarial | MEDIUM | secret | Cognito `client_secret`이 Lambda@Edge **소스에 인라인**(templatefile 주입) — 평문으로 함수 코드에 박힘 | Lambda@Edge는 환경변수 미지원이라 일반적 제약. **인지 + 함수 코드 IAM 접근 최소화**. (대안: 런타임 SSM fetch는 viewer-request 콜드스타트/지연 비용) |
| 8 | WA-보안 | LOW | state | state 버킷에 TLS 강제(`aws:SecureTransport` deny) 버킷 정책 없음 | bootstrap에 deny-non-TLS 버킷 정책 추가(선택) |
| 9 | WA-운영 | LOW | 관측성 | Aurora Performance Insights / CloudWatch 알람·대시보드 미설정 | 이후 단계: PI on + ECS/ALB/Aurora 핵심 알람(P1 범위 밖 가능) |

## Well-Architected Score

| Pillar | Score | Status | 근거 |
|--------|-------|--------|------|
| 운영 우수성 | 3.5/5 | REVIEW | IaC 전부 Terraform✓, containerInsights✓, deployment circuit breaker(자동 롤백)✓, `plan` 미리보기✓ / 알람·관측성 보강 여지 |
| 보안 | 2.5/5 | **조건부** | TLS end-to-end✓, private ALB(VPC Origin)✓, KMS CMK 암호화✓, RDS-managed secret✓, Cognito✓ / **JWT 서명 미검증(#1)·state 누락(#2)·SG 과도(#3·4)**. #1·#2 P1d 해결 시 **4+/5** |
| 안정성 | 3/5 | REVIEW | 2-AZ 서브넷✓, ECS·TG 헬스체크✓, circuit breaker✓, Aurora backup 7d✓ / 단일 NAT·desired=1·단일 writer(dev OK) |
| 성능 효율성 | 4/5 | PASS | Graviton arm64✓, Aurora Serverless v2 auto-scale✓, CloudFront✓, SSE 경로 실측 GREEN✓ |
| 비용 최적화 | 4/5 | PASS | arm64(Graviton)✓, Serverless v2(0.5 ACU floor)✓, 단일 NAT(절감)✓, PriceClass_200✓ (~$73/mo) |
| 지속 가능성 | 4.5/5 | PASS | Graviton + full-serverless(Fargate/Aurora) + 적정 사이징 |

## P1d 설계 정합성 (핵심 질문: "아키텍처가 잘 맞는가")

| P1d 결정 | 설계 spec 근거 | 정합성 |
|---|---|---|
| **Thin BFF Next.js** (web=UI+얇은 /api/*, 무거운 백엔드는 P2 워커+AgentCore) | §2 "web·steampipe는 가볍게 유지", §2 "web(경량: 라우팅·SSE만)", §5 "fetch는 `/api/*`" | ✅ 정합 — OOM 안전성은 P2 워커 계층이 담당, thin-BFF가 이를 침해하지 않음 |
| **spine → web 리네임** | §2 토폴로지 `awsops-web`, 부록A | ✅ 정합 |
| **dual-tier ECR** (dev-private + prod-public) | §8 "ECR(dev private/prod public)", §8 OSS pull-count 배지(P1d) | ✅ 정합 |
| **make deploy 로컬** (build+push+롤링+smoke) | §8 4원칙 #1 "make deploy ENV=dev(앱 빌드+푸시+ECS 갱신)", #4 "ECS 롤링+circuit breaker" | ✅ 정합 (circuit breaker 이미 구현됨) |
| basePath 제거 / `/api/*` / SSE heartbeat≤20s / Aurora secret wire / JWT 하드닝 | §5, §2.1 SSE 실측, §7 Aurora, P1b 메모리 "JWT 하드닝 before P1d" | ✅ 정합 — SSE heartbeat≤20s는 edge.tf `origin_read_timeout=60` 이내로 안전 |

**결론**: P1a~P1c 구현은 설계 spec을 충실히 따랐고(엣지/Aurora/backend 전부 §과 일치), **P1d 4개 결정도 모두 spec과 정합**하여 진행에 적합. 단, 아래 조건을 P1d 플랜에 반영해야 보안 필러가 PASS 수준으로 올라감.

## Decision

| Verdict | 조건 |
|---|---|
| **REVIEW** | CRITICAL 1건(#1)이 존재하나 **P1d D5에 해결 계획이 이미 확정**되어 mitigation plan 충족. dev 환경. |
| → **PASS** 전환 조건 | 아래 Action Items #1~#4를 P1d 플랜에 반영 |

## Action Items (→ P1d 플랜 반영)
- [ ] **D5**: JWT **RS256 서명 검증**(JWKS) + `iss`/`aud`/`token_use` (#1, 이미 계획) — **+ OAuth `state`(CSRF) 추가** (#2)
- [ ] **D2**: ALB SG의 VPC-CIDR 443 ingress 제거 (#3); Aurora SG의 VPC-CIDR 5432를 deploy-host 한정/마이그레이션 후 제거로 재검토 (#4)
- [ ] **D1/edge**: `/_next/static/*` viewer-request 인증 early-return 검토 (#5)
- [ ] **prod 백로그**(P1d 범위 밖): NAT per-AZ, ECS autoscaling, Aurora reader (#6) / state TLS 버킷 정책 (#8) / PI·알람 (#9)

---

## 3자 크로스 리뷰 종합 (kiro 자체 / codex gpt-5.5 / gemini 0.44.1)

세 리뷰어에게 **동일 지시문**(`.codex-review-prompt.md`)으로 독립 교차검증을 수행. codex/gemini는 read-only로 git diff + 파일 직접 inspect.

### VERDICT 비교
| 리뷰어 | VERDICT | 핵심 논지 |
|---|---|---|
| kiro (자체 standalone) | REVIEW | CRITICAL 1건에 P1d D5 해결계획 존재 |
| codex (gpt-5.5) | REVIEW | 방향은 안전, edge auth 서명/state 수정 전 노출 금지 |
| gemini (0.44.1) | **FAIL** | auth 암호화 깨짐 + **보장된 배포 블로커** 존재 → 해결 없이는 진행 불가 |
| **종합** | **REVIEW (조건부)** | 방향 정합 ✅. 단 아래 **배포 블로커 + auth 하드닝을 P1d에 반드시 반영**(모두 P1d 범위 내 해결 가능) |

### ✅ 3자 합의 (consensus — 신뢰도 최상)
| 심각도 | 위치 | 항목 | 합의 |
|---|---|---|---|
| CRITICAL | `cognito_edge.py.tftpl:18-24` | JWT 서명 미검증(exp만) | **3/3** |
| HIGH | `cognito_edge.py.tftpl:28` | OAuth `state` 없음 → 로그인 CSRF | **3/3** |
| MEDIUM | `workload.tf:109` | ALB SG VPC-CIDR 443 과도 | **3/3** |
| MEDIUM | `data.tf:28` | Aurora SG VPC-CIDR 5432 과도 | **3/3** |
| MEDIUM | `edge.tf:98` | `/_next/static/*`도 viewer-request Lambda 실행 | **3/3** |

### 🆕 신규 발견 (단일/이중 리뷰어 — 채택)
| 심각도 | 위치 | 발견 | 발견자 |
|---|---|---|---|
| **HIGH** | `auth.tf:64` | **client_secret이 Lambda@Edge 소스/패키지에 렌더링** → 코드 접근자가 secret 복구. **PKCE/public client 전환**(secret 제거)으로 state(#2)와 동시 해결 | codex |
| **블로커** | `workload.tf:28-36` | **secret 주입은 `execution_role`이 `secretsmanager:GetSecretValue`+`kms:Decrypt` 보유해야** 함(ECS `secrets` valueFrom 방식). 현재 표준 정책만 → P1d secret wire 시 `ResourceInitializationError`로 task 크래시 | gemini(정확)·codex(task role로 언급) |
| **블로커** | `workload.tf:70-72,184` | **health check path 불일치**: 컨테이너 healthCheck + TG가 `/healthz` 하드코딩인데 P1d는 `/api/health` 사용 예정 → Next.js에 `/healthz` 없으면 health check 실패 → circuit breaker 무한 롤백 | gemini |
| LOW | `auth.tf:5` | Cognito **MFA off**(ops/admin 표면) → non-dev 노출 전 MFA | codex |

### 🔧 기술 정정 (cross-check로 확정)
- **secret 주입 권한 위치**: ECS `secrets`(`valueFrom`)로 컨테이너 env에 주입 시 → **execution role**이 권한 보유(task role 아님). 앱이 런타임 SDK로 직접 fetch하면 → task role. **P1d는 `secrets` valueFrom 방식 채택 → execution role에 부여**로 확정(gemini 지적이 정확).

### 📌 P1d 플랜 반영 (갱신·확정)
- **D1**: Next.js `/api/health`(가벼운 200) + `/api/stream`(SSE heartbeat≤20s) + `/api/db`(Aurora ping). 정적 자산 인증 early-return(#5).
- **D2 (rename + 와이어링 + 정합)**:
  - spine→web 리네임 + **TG/컨테이너 health check path를 `/api/health`로 통일**(블로커 해소).
  - **execution_role**에 `aurora_secret_arn` 한정 `secretsmanager:GetSecretValue` + KMS `kms:Decrypt` 부여 + ECS `secrets` valueFrom 주입(블로커 해소).
  - SG 최소화: ALB SG VPC-CIDR 443 제거(CF VPC Origin SG만), Aurora SG VPC-CIDR 5432 재검토(deploy-host 한정/제거).
- **D5 (auth 하드닝)**: JWT **RS256 서명 검증**(JWKS)+`iss`/`aud`/`token_use`/`nbf`/`iat`, fail-closed + OAuth **`state`(CSRF)** + **PKCE/public client 전환**(client_secret 제거). MFA는 선택(non-dev 전).
- **prod 백로그**(P1d 밖): NAT per-AZ, ECS autoscaling+min2, Aurora reader, state TLS 정책, PI·알람.

**결론**: 3자 모두 **P1d 방향(thin-BFF/rename/dual-ECR/make deploy)은 아키텍처적으로 정합**하다고 판정. gemini의 FAIL은 "현 코드 상태로 P1d를 짜면 배포가 깨진다"는 경고로, 위 D1/D2 정합 작업으로 해소된다 → **조건부 진행(REVIEW)**.
