# ADR-002: 인증 · 로그인 (Cognito + Lambda@Edge RS256 + 인앱 로그인) / Authentication · Login (Cognito + Lambda@Edge RS256 + In-App Login)

## Status / 상태

Accepted (2026-06-22) — consolidated. consolidates: 020, 023, 042

## Context / 컨텍스트

AWSops는 민감한 AWS 계정 데이터(IAM·CloudTrail·비용·보안 상태)를 노출하고 운영자를 대신해 Bedrock/AgentCore를 호출하는 운영 대시보드이다. 어떤 요청도 인증 없이 백엔드(내부 ALB → Fargate)에 도달해서는 안 되며, 인증은 가능한 한 상류에서 종료되어야 한다. 동시에 일부 관리 화면(`/accounts`·`/alert-settings`·`/datasources`·진단 스케줄러)은 인증된 모든 사용자가 아니라 관리자만 접근할 수 있어야 한다.

AWSops is an operations dashboard that exposes sensitive AWS account data (IAM, CloudTrail, cost, security posture) and invokes Bedrock/AgentCore on behalf of operators. No request may reach the backend (internal ALB → Fargate) without authentication, and authentication should terminate as far upstream as possible. At the same time, certain administrative surfaces (`/accounts`, `/alert-settings`, `/datasources`, the diagnosis scheduler) must be reachable only by administrators, not every authenticated user.

엣지 인증을 위한 요구사항:
- CloudFront 엣지에서 미인증 트래픽을 거부해 오리진이 익명 스캔/캐시 응답에 노출되지 않도록 한다.
- 사용자 신원이 다운스트림으로 신뢰성 있게 전파되어 멀티 어카운트 필터링·AgentCore Memory 격리·관리자 게이트가 동일 신원을 키로 사용할 수 있어야 한다.
- 사용자가 별도 권한 체계를 학습하지 않도록 Cognito 위에서 관리자 권한을 게이팅한다.

Requirements that shape the design:
- Reject unauthenticated traffic at the CloudFront edge so the origin is never exposed to anonymous scans or cached responses.
- Propagate user identity downstream reliably so multi-account filtering, AgentCore Memory isolation, and the admin gate can all key off the same identity.
- Gate admin privileges on top of Cognito so operators learn no second access-control system.

## Decision / 결정

### 1. 엣지 인증 — Cognito + Lambda@Edge (RS256) / Edge auth — Cognito + Lambda@Edge (RS256)

Cognito User Pool이 신원을 관리한다(주 리전 `ap-northeast-2`). Python Lambda@Edge 함수(`us-east-1` — Lambda@Edge가 허용하는 유일한 리전)가 CloudFront `viewer-request` 이벤트에 연결되어 매 요청마다 `awsops_token` 쿠키를 검증한다. 검증은 **RS256 JWKS 서명 검증 + `iss`/`aud`/`token_use` 클레임 + OAuth `state` + PKCE public client**(클라이언트 시크릿 없음)로 수행한다. 검증된 ID 토큰은 `awsops_token` 쿠키(`Path=/; Secure; HttpOnly; SameSite=Lax`)에 담겨 모든 후속 요청에 전파된다. `viewer-request`는 CloudFront 캐시 조회 전에 발생하므로 미인증 사용자는 캐시된 HTML조차 받지 못한다.

A Cognito User Pool holds identities (primary region `ap-northeast-2`). A Python Lambda@Edge function (`us-east-1` — the only region Lambda@Edge allows) is attached to the CloudFront `viewer-request` event and validates the `awsops_token` cookie on every request. Validation performs **RS256 JWKS signature verification + `iss`/`aud`/`token_use` claims + OAuth `state` + PKCE public client** (no client secret). The verified ID token rides the `awsops_token` cookie (`Path=/; Secure; HttpOnly; SameSite=Lax`) on every subsequent request. Because `viewer-request` fires before the CloudFront cache lookup, unauthenticated users never receive even cached HTML.

미인증 요청은 엣지에서 자체 `/login` 페이지로 리다이렉트된다(`302 Location: /login?next={quoted uri}`, `Cache-Control: no-cache`). `next`는 오픈 리다이렉트에 대해 정제된다(`/`로 시작, 2번째 문자 ≠ `/`·`\`, `\` 미포함, ≤2048자; 브라우저 `\`→`/` 정규화 우회까지 차단; 기본값 `/`). `is_public()`은 `/login`·`/api/auth/login`·`/icon.svg`(로그인 페이지·인증 API·파비콘)를 미인증 허용한다.

Unauthenticated requests are redirected at the edge to the self-hosted `/login` page (`302 Location: /login?next={quoted uri}`, `Cache-Control: no-cache`). `next` is sanitized against open redirect (starts `/`, 2nd char ≠ `/`·`\`, no `\`, ≤2048 chars; the browser `\`→`/` normalization bypass is covered; defaults to `/`). `is_public()` allows `/login`, `/api/auth/login`, and `/icon.svg` (login page, auth API, favicon) unauthenticated.

### 2. 로그인 — 자체 호스팅 `/login` 폼 (1차 경로) / Login — self-hosted `/login` form (primary path)

로그인 주 경로는 **자체 호스팅 `/login` 폼**이다(AgentCore teal 테마, 활성 테마 추종; `ShellGate`가 `/login`을 제외한 모든 경로에 앱 셸을 탑재). 폼은 BFF `POST /api/auth/login`을 호출하고, BFF는 Cognito **`InitiateAuth(USER_PASSWORD_AUTH)`**를 **무서명 공개 오퍼레이션**으로 plain fetch(`cognito-idp.{region}.amazonaws.com`, `X-Amz-Target: AWSCognitoIdentityProviderService.InitiateAuth`, `Content-Type: application/x-amz-json-1.1`) 호출한다 — SDK·IAM·task-role 자격증명 불필요. 성공 시 Cognito가 반환한 `IdToken`을 `awsops_token` 쿠키로 발급한다("keep me signed in" ✓ → `Max-Age=43200`[12h, id_token 수명], ✗ → 세션 쿠키). 오류는 단일 코드로 수렴해 계정 존재를 노출하지 않는다: `NotAuthorizedException`/`UserNotFoundException` → `invalid_credentials`, 모든 `ChallengeName` → `challenge`(403, "관리자에게 문의"), 네트워크/5xx → `unavailable`(502).

The primary login path is the **self-hosted `/login` form** (AgentCore teal theme, follows the active theme; `ShellGate` mounts the app shell on every route except `/login`). The form calls BFF `POST /api/auth/login`, which invokes Cognito **`InitiateAuth(USER_PASSWORD_AUTH)`** as an **unsigned public operation** via plain fetch (`cognito-idp.{region}.amazonaws.com`, `X-Amz-Target: AWSCognitoIdentityProviderService.InitiateAuth`, `Content-Type: application/x-amz-json-1.1`) — no SDK, no IAM, no task-role credentials. On success it mints the Cognito-issued `IdToken` as the `awsops_token` cookie ("keep me signed in" ✓ → `Max-Age=43200` [12h, the id_token lifetime], ✗ → session cookie). Errors collapse to single codes so account existence is never disclosed: `NotAuthorizedException`/`UserNotFoundException` → `invalid_credentials`, any `ChallengeName` → `challenge` (403, "contact your administrator"), network/5xx → `unavailable` (502).

Cognito 클라이언트(`auth.tf`)는 최소권한으로 구성한다: `explicit_auth_flows = ["ALLOW_USER_PASSWORD_AUTH"]`만 부여하고 **`ALLOW_REFRESH_TOKEN_AUTH`는 부여하지 않는다**(BFF는 refresh 플로우를 구현하지 않고 반환된 RefreshToken을 즉시 폐기). `id_token_validity = 12` / `access_token_validity = 12`(hours). 12h id_token이 세션 전부다.

The Cognito client (`auth.tf`) is least-privilege: only `explicit_auth_flows = ["ALLOW_USER_PASSWORD_AUTH"]`, and **no `ALLOW_REFRESH_TOKEN_AUTH`** (the BFF implements no refresh flow and discards any returned RefreshToken). `id_token_validity = 12` / `access_token_validity = 12` (hours). The 12h id_token is the entire session.

signout은 쿠키를 삭제(`Max-Age=0`)하고 `/login`으로 리다이렉트한다 — 자체 폼은 Cognito 브라우저 세션을 만들지 않으므로 Hosted UI `/logout` 왕복이 없다.

Signout clears the cookie (`Max-Age=0`) and redirects to `/login` — the self-hosted form creates no Cognito browser session, so there is no Hosted UI `/logout` round-trip.

**Hosted UI PKCE 플로우(`/_callback`)는 다크 폴백으로 보존**된다(엣지 `start_login`/`handle_callback`, flow-cookie). MFA·비밀번호 재설정·페더레이션이 필요하면 이 경로로 복구 가능하나, 상시 경로는 자체 `/login`이다.

**The Hosted UI PKCE flow (`/_callback`) is retained as a dark fallback** (edge `start_login`/`handle_callback`, flow cookie). MFA, password reset, and federation are recoverable via this path, but the day-to-day path is the self-hosted `/login`.

### 3. 관리자 모델 — SSM + Cognito 그룹 / Admin model — SSM + Cognito group

관리자 강제는 서버측에서 수행한다(UI 숨김은 표시적 장치일 뿐 강제 경계가 아니다). 모든 변경 라우트는 검증된 ID 토큰에서 신원을 추출한 뒤 관리자 여부를 재확인한다. 사용자는 **Cognito `ADMIN_GROUP`**(`cognito:groups` 클레임)에 속하거나 **SSM 파라미터 allowlist**(`SSM_ADMIN_EMAILS_PARAM`, 쉼표 구분, 5분 캐시)에 이메일이 있으면 관리자로 판정된다(`web/lib/admin.ts`). 판정은 **fail-closed**다. 설정의 source of truth는 SSM이다.

Admin enforcement is server-side (UI hiding is cosmetic, not the enforcement boundary). Every mutating route extracts identity from the verified ID token and re-checks admin status. A user is admin if they are in the **Cognito `ADMIN_GROUP`** (`cognito:groups` claim) **OR** their email is in an **SSM-parameter allowlist** (`SSM_ADMIN_EMAILS_PARAM`, comma-separated, 5-min cache) — `web/lib/admin.ts`. The check is **fail-closed**. SSM is the configuration source of truth.

```
Browser ──HTTPS──► CloudFront
                       │
                       ▼
            Lambda@Edge viewer-request (us-east-1)
            RS256 JWKS + iss/aud/token_use
              │                    │
   no/invalid │                    │ valid awsops_token
       token  ▼                    ▼
       302 → /login        forward → internal ALB → Fargate (Next.js BFF)
                                     │
                                     ▼
                           admin gate (web/lib/admin.ts)
                           Cognito ADMIN_GROUP ∪ SSM allowlist, fail-closed
```

## Consequences / 영향

### Positive / 긍정적
- 엣지 거부로 오리진이 미인증 트래픽·캐시 응답에 노출되지 않고, RS256 JWKS 검증으로 위조·변조 토큰을 차단한다. / Edge rejection keeps the origin off unauthenticated traffic and cached responses; RS256 JWKS verification rejects forged/altered tokens.
- 자체 `/login` 폼은 대시보드와 일치하는 테마(AgentCore teal)를 제공하고 Cognito 크롬 단절이 없다. 엣지 RS256 검증기·`awsops_token` 쿠키 계약이 불변이라 신뢰 경계(엣지 검증)가 종단 보존된다. / The self-hosted `/login` form is on-brand (AgentCore teal) with no Cognito-chrome break; the edge RS256 validator and `awsops_token` cookie contract are unchanged, preserving the validate-at-edge trust boundary end-to-end.
- thin-BFF는 무상태·무자격증명 유지: `InitiateAuth`가 무서명/공개라 task-role 부여·SDK 의존성이 없고, 브루트포스 방어는 Cognito에 위임된다. / The thin-BFF stays stateless and credential-free: `InitiateAuth` is unsigned/public, so no task-role grant or SDK dependency is added; brute-force defense is delegated to Cognito.
- 최소권한: `ALLOW_REFRESH_TOKEN_AUTH` 생략으로 장수명 refresh 토큰이 브라우저/BFF에서 완전히 배제된다. / Least-privilege: omitting `ALLOW_REFRESH_TOKEN_AUTH` keeps long-lived refresh tokens entirely out of the browser/BFF.
- 관리자 신원이 검증된 ID 토큰에서 균일하게 전파되어 멀티 어카운트 필터링·Memory 격리·관리자 게이트가 동일 신원을 키로 쓴다. SSM이 source of truth라 신규 인프라(Identity Pool 등) 없이 감사·구성된다. / Admin identity propagates uniformly from the verified ID token, keyed by the same identity across multi-account filtering, Memory isolation, and the admin gate; SSM as source of truth makes it auditable without new infrastructure (no Identity Pool).

### Negative / 부정적
- 앱이 원시 비밀번호를 처리한다(HTTPS 경유, 미로깅, 미영속) — Hosted UI 경로엔 없던 자격증명 처리 표면. / The app handles raw passwords (over HTTPS, never logged, never persisted) — a credential-handling surface the Hosted-UI path did not have.
- 주 경로가 Hosted-UI MFA/비밀번호 재설정/페더레이션을 잃는다. 챌린지(`NEW_PASSWORD_REQUIRED` 등)는 인라인 플로우 대신 단일 "관리자 문의" 메시지로 노출된다(보존된 PKCE 다크 폴백으로 복구 가능). / The primary path loses Hosted-UI MFA / password reset / federation; challenges (`NEW_PASSWORD_REQUIRED`, etc.) surface as a single "contact your administrator" message rather than an inline flow (recoverable via the retained PKCE dark fallback).
- 12h id_token은 유출 쿠키의 유효 창을 넓힌다. HttpOnly + Secure + SameSite=Lax 및 refresh 토큰 부재로 완화된다. / The 12h id_token widens the window in which a leaked cookie is valid; mitigated by HttpOnly + Secure + SameSite=Lax and the absence of any refresh token.
- RBAC 세분화가 없다 — 관리자는 all-or-nothing이며 특정 화면만 위임할 수 없다. / No RBAC granularity — admin is all-or-nothing; a user cannot be scoped to a single surface.
- `next`는 매 로그인마다 오픈 리다이렉트에 대해 정제되어야 한다 — 아니면 폼이 오픈 리다이렉트 벡터가 된다. / `next` must be sanitized against open redirect on every login, or the form becomes an open-redirect vector.

## 6 Pillars (보안 / Security)

- **Identity & access management**: 신원은 Cognito User Pool 단일 출처. 엣지에서 RS256 JWKS로 모든 토큰을 검증하고(서명 + `iss`/`aud`/`token_use`), 관리자 권한은 검증된 ID 토큰의 Cognito 그룹·SSM allowlist로 서버측 fail-closed 게이팅한다. / Single identity source (Cognito User Pool); all tokens RS256-JWKS-verified at the edge (signature + `iss`/`aud`/`token_use`); admin privilege gated server-side, fail-closed, off the verified ID token's Cognito group / SSM allowlist.
- **최소권한 / Least privilege**: Cognito 클라이언트는 `ALLOW_USER_PASSWORD_AUTH`만, refresh 플로우 미부여. Lambda@Edge 역할은 기본 실행 권한만(AWS API 호출 없음). BFF는 무서명 공개 `InitiateAuth`만 호출해 task-role 자격증명을 보유하지 않는다. / Cognito client carries only `ALLOW_USER_PASSWORD_AUTH`, no refresh flow; the Lambda@Edge role holds only basic execution (no AWS API calls); the BFF calls only the unsigned public `InitiateAuth`, holding no task-role credentials.
- **토큰 보호 / Token protection**: ID 토큰은 `HttpOnly + Secure + SameSite=Lax` 쿠키로만 보관 — JS 접근 불가, HTTPS 전용, 크로스사이트 POST CSRF 저항. refresh 토큰은 브라우저/BFF에 절대 저장되지 않는다. / The ID token lives only in an `HttpOnly + Secure + SameSite=Lax` cookie — inaccessible to JS, HTTPS-only, CSRF-resistant; refresh tokens never reach the browser/BFF.
- **계정 열거 방지 / Account-enumeration resistance**: 로그인 오류는 단일 코드(`invalid_credentials`)로 수렴해 계정 존재를 노출하지 않는다. / Login errors collapse to a single `invalid_credentials` code so account existence is not disclosed.
- **오픈 리다이렉트 방지 / Open-redirect defense**: `next`는 엄격 검증(`/` 시작, 2번째 문자 ≠ `/`·`\`, `\` 미포함, ≤2048; `\`→`/` 정규화 우회 차단). / `next` is strictly validated (starts `/`, 2nd char ≠ `/`·`\`, no `\`, ≤2048; the `\`→`/` normalization bypass is covered).
- **브루트포스 / Brute force**: 무상태 thin-BFF는 시도 상태를 보관하지 않고 스로틀/lockout을 Cognito 내장 방어에 위임한다. / The stateless thin-BFF keeps no attempt state and delegates throttle/lockout to Cognito's built-in defenses.

## References / 참조

- `terraform/foundation/auth.tf` — Cognito User Pool / app client / 12h token validity / `ALLOW_USER_PASSWORD_AUTH`-only.
- `terraform/foundation/edge-lambda/cognito_edge.py.tftpl` — Lambda@Edge RS256 validator, `/login` redirect, `is_public()`, retained PKCE fallback (`start_login`/`handle_callback`).
- `web/app/login/page.tsx`, `web/app/api/auth/login/route.ts`, `web/lib/login.ts` — self-hosted login form + BFF `InitiateAuth`.
- `web/app/api/auth/signout/route.ts`, `web/components/shell/{ShellGate,UserIdentity}.tsx` — signout + shell gating.
- `web/lib/admin.ts` — admin gate (Cognito `ADMIN_GROUP` ∪ SSM `SSM_ADMIN_EMAILS_PARAM` allowlist, 5-min cache, fail-closed).
