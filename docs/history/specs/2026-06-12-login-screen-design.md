# 로그인 화면 (F4 login-theme) — 설계 스펙

> 2026-06-12 · 브랜치 `feat/v2-architecture-design` · 상태: **구현 완료**(F1–F9, ADR-039 채택) — 인증 = v1식 자체 폼, 외형 = **AgentCore teal 테마**. 결정 기록: `docs/decisions/039-v2-inapp-login.md`
>
> **테마 갱신(2026-06-12)**: 외형은 옛 DESIGN.md "1. Login"(paper+claude 오렌지)이 아니라 **AgentCore teal 테마**(brand/brand-action/negative/positive 토큰, 쿨 뉴트럴)를 따른다. **의존성**: `agentcore-theme-system` 플랜 Task 1–3(토큰→CSS변수 + `claude`→`brand` + `--brand-action`) 적용 후 구현. 로그인은 토큰 기반이라 활성 테마를 따른다(기본 teal 라이트, console=자동 다크).

## 1. 목표 / 범위

v1처럼 **자체 로그인 화면**(이메일/비밀번호 폼)을 v2에 추가한다. 디자인은 DESIGN.md
"1. Login" 섹션(F4 스펙, paper+ink+claude 테마)을 따르고, 인증은 web BFF가 Cognito
`InitiateAuth(USER_PASSWORD_AUTH)`를 직접 호출한다. Lambda@Edge의 RS256 JWKS 검증은
변경하지 않는다 — 쿠키에 담기는 것이 정상 발급된 `id_token`이므로 기존 검증을 그대로
통과한다.

**제외 (YAGNI):**
- DESIGN.md 목업의 SSO 2×2 그리드 — IdP가 `COGNITO`뿐이라 가짜 버튼이 됨
- v1의 "30일 로그인 유지" — id_token 만료(exp 검증)에 막혀 v1에서도 사실상 동작하지 않았음
- 푸터의 `X-Custom-Secret` 문구 — v1 전용 메커니즘(v2는 VPC Origin)
- 비밀번호 찾기 링크 — Hosted UI 의존이라 이번 슬라이스에서 제외

## 2. 인증 흐름

```
미인증 GET /any → Lambda@Edge → 302 /login?next=/any
/login 폼 제출 → POST /api/auth/login {email, password, remember}
  → BFF가 cognito-idp 공개 API InitiateAuth(USER_PASSWORD_AUTH)를 plain fetch로 호출
    (X-Amz-Target: AWSCognitoIdentityProviderService.InitiateAuth,
     Content-Type: application/x-amz-json-1.1 — 무서명 공개 오퍼레이션, SDK 의존성 불필요)
  → 성공: Set-Cookie awsops_token=<IdToken>; Path=/; Secure; HttpOnly; SameSite=Lax
       remember ✓ → Max-Age = 토큰 수명(12h) / ✗ → 세션 쿠키(Max-Age 없음)
  → 클라이언트가 window.location = next (상대경로 검증 후, 기본 '/')
이후 요청 → Edge가 기존 그대로 RS256 JWKS + iss/aud/token_use/exp 검증
```

- **세션 수명 = id_token 수명 12h**로 연장(현재 기본 1h). "로그인 유지" 체크박스는
  쿠키 지속성(브라우저 재시작 생존)만 제어한다 — 정직한 시맨틱.
- 기존 Hosted UI PKCE 플로우(`/_callback` 핸들러)는 **다크 폴백으로 코드 보존**,
  미인증 redirect 대상만 `/login`으로 변경.
- **로그아웃**: 자체 폼 로그인에는 Cognito 브라우저 세션이 없으므로 signout은
  쿠키 삭제 → `/login` 직행으로 단순화(Hosted UI `/logout` 왕복 제거).

## 3. Terraform 변경 (`terraform/foundation/`)

| 파일 | 변경 |
|---|---|
| `auth.tf` — `aws_cognito_user_pool_client.main` | `explicit_auth_flows = ["ALLOW_USER_PASSWORD_AUTH"]` 추가(refresh 플로우 미구현이므로 `ALLOW_REFRESH_TOKEN_AUTH` 미부여 — 최소권한, BFF는 RefreshToken 즉시 폐기) · `id_token_validity = 12`, `access_token_validity = 12` + `token_validity_units { id_token = "hours", access_token = "hours" }` |
| `edge-lambda/cognito_edge.py.tftpl` | `is_public()`에 `/login`, `/api/auth/login`, `/icon.svg` 추가 · 미인증 시 Hosted UI 대신 `302 /login?next={uri}` · `/_callback` 핸들러 코드 보존 · 폴백 쿠키 Max-Age 3600→43200 정합 |

Edge Lambda 변경은 CloudFront 배포 갱신을 동반(긴 apply) → saved tfplan,
**컨트롤러가 `apply tfplan` 실행**. 신규 플래그 불필요(기존 인증 경로의 정제).

## 4. 웹 변경 (`web/`)

| 파일 | 내용 |
|---|---|
| `app/login/page.tsx` (신규) | **AgentCore teal 테마**(토큰 기반, 활성 테마 따름): `bg-paper`(쿨 뉴트럴) 배경 + **teal·azure** radial glow 2개(`rgba(1,168,141,.12)`/`rgba(82,141,248,.10)`, top-left 16%/12% · bottom-right 84%/88%) · 400px 센터 컬럼 · AwsopsMark 52px(teal 타일) + "AWSops" + "Cloud Operations Dashboard" · `bg-white` 카드(radius 16, shadow-card, border-ink-100, padding 28) · "로그인" 헤더 + `bg-positive` dot "보안 연결" 배지 · 이메일/비밀번호 필드(h-[42px], `focus:border-brand focus:shadow-focus`) · "로그인 유지" 체크박스(`accent-brand`) · "로그인 →" 풀폭 **`bg-brand-action` 버튼(AA)** — busy는 실제 fetch 동안 "인증 중…" · 에러는 **`negative` 톤**(`bg-negative-surface text-negative-text border-negative-border`) 인라인 박스 · 푸터 `ap-northeast-2 · CloudFront → Lambda@Edge · RS256 JWT` |
| `app/api/auth/login/route.ts` (신규) | `InitiateAuth` plain fetch · 성공 시 쿠키 발급 · `NotAuthorizedException`/`UserNotFoundException` → 단일 메시지 "이메일 또는 비밀번호가 올바르지 않습니다"(계정 존재 비노출) · `ChallengeName` 응답(NEW_PASSWORD_REQUIRED 등) → 403 "관리자에게 문의하세요" |
| `app/api/auth/signout/route.ts` (수정) | 쿠키 삭제 + `{ redirect: '/login' }` 반환으로 단순화 |
| `components/shell/UserIdentity.tsx` (수정) | signout 응답의 redirect로 이동 (Cognito logout URL 의존 제거) |
| `components/shell/ShellGate.tsx` (신규) | client 컴포넌트 — `usePathname() === '/login'`이면 bare children, 아니면 AppShell + CommandPalette + ChatDrawer. `layout.tsx`에서 기존 조합을 이 컴포넌트로 교체(로그인 화면에 Cmd-K/챗 드로어 미탑재) |

- 카피에 'v2' 표기 금지(기존 규칙). 라벨은 기존 LanguageProvider i18n 패턴(ko 기본).
- env는 기존 주입분 재사용: `COGNITO_CLIENT_ID`(+ region은 `AWS_REGION`/기본
  `ap-northeast-2`). 신규 시크릿 없음(public client).

## 5. 에러 / 엣지 케이스

- `next`는 `/`로 시작하고 2번째 문자가 `/`·`\`가 아니며 `\`를 포함하지 않는 상대경로만
  허용(오픈 리다이렉트 차단 — 브라우저의 `\`→`/` 정규화로 `/\evil.com` ≡ `//evil.com`
  우회까지 차단)
- 브루트포스: Cognito 내장 lockout/스로틀에 위임 — BFF는 상태 없음(thin-BFF 유지)
- 만료 토큰 보유 상태에서 `/login` 접근 → public이므로 무한루프 없음
- 로그인 페이지 favicon `/icon.svg`는 public 예외로 깨짐 방지
- `InitiateAuth`는 자격증명이 필요 없는 공개 오퍼레이션 — task role 권한 추가 불필요

## 6. 배포 순서 (역순이면 redirect가 404로 떨어짐)

1. `make deploy` — `/login` 페이지·API를 먼저 배포 (edge가 아직 Hosted UI로 보내므로 무해)
2. `terraform plan -out tfplan` → 컨트롤러가 `apply tfplan` (client 플로우 + edge lambda + CloudFront 전파)
3. 스모크: 시크릿 창 미인증 → `/login` 리다이렉트 → admin 로그인 → 대시보드 → 로그아웃 → `/login` 복귀

## 7. 테스트

- `web/` vitest: login route 핸들러 단위 테스트(성공/오류 매핑/쿠키 속성/next 검증),
  ShellGate 분기 테스트
- edge 템플릿: 기존 패턴대로 수동 스모크(배포 순서 3단계) — 템플릿 단위 테스트 인프라 없음
