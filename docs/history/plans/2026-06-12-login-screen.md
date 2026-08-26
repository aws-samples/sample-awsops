# 로그인 화면 (F4 login-theme) — 구현 플랜

> 스펙: `docs/superpowers/specs/2026-06-12-login-screen-design.md` · 2026-06-12
> 원칙: TDD(라이브러리 로직은 테스트 먼저) · 태스크당 1커밋 · web 로직은 `web/lib/*.ts`+인접 `*.test.ts` 컨벤션 준수 · 라우트 핸들러는 thin adapter

## 전제 (검증 완료)

- `InitiateAuth`는 무서명 공개 오퍼레이션 → SDK 의존성 추가 없이 plain fetch
- env `COGNITO_CLIENT_ID`/`COGNITO_USER_POOL_ID`/`APP_DOMAIN`은 이미 workload.tf에서 주입됨(`web/lib/auth.ts`가 사용 중) → workload.tf 변경 없음
- region은 기존 패턴 `process.env.AWS_REGION || 'ap-northeast-2'` 재사용
- admin 유저는 영구 비밀번호로 시드됨(`aws_cognito_user.admin.password`) → NEW_PASSWORD 챌린지는 예외 케이스로만 처리
- **의존성 — AgentCore 테마 먼저**: 로그인 페이지는 새 테마 토큰(`brand`/`brand-action`/`negative`/`positive` + 쿨 뉴트럴)을 사용한다. `docs/superpowers/plans/2026-06-12-agentcore-theme-system.md` **Task 1–3 적용 후**(토큰→CSS변수 + `claude`→`brand` 리네임 + `--brand-action` + `data-theme` no-flash 스크립트) 본 플랜을 실행한다. 로그인 외형은 토큰 기반이라 활성 테마를 따른다(기본 teal 라이트, console 테마면 자동 다크).

### Task 1: 로그인 코어 로직 `web/lib/login.ts` (TDD)

**Files:**
- Create: `web/lib/login.ts`
- Test: `web/lib/login.test.ts`

- [ ] `login.test.ts` 먼저 작성 — `vi.stubGlobal('fetch', …)`로 cognito-idp 호출 모킹:
  성공(IdToken/ExpiresIn 반환), `NotAuthorizedException`/`UserNotFoundException` →
  `invalid_credentials`, `ChallengeName` 응답 → `challenge`,
  `PasswordResetRequiredException` → `challenge`, 네트워크 오류/5xx → `unavailable`,
  요청 형태(`X-Amz-Target: AWSCognitoIdentityProviderService.InitiateAuth`,
  `Content-Type: application/x-amz-json-1.1`, `AuthFlow: USER_PASSWORD_AUTH`) 검증
- [ ] `initiateAuth(email, password)` 구현 — `https://cognito-idp.{region}.amazonaws.com/`
  POST, 반환은 discriminated union
  `{ ok: true, idToken, expiresIn } | { ok: false, code: 'invalid_credentials' | 'challenge' | 'unavailable' }`
  (`expiresIn` = InitiateAuth `AuthenticationResult.ExpiresIn`, **초 단위** — Task 7 적용 후 43200;
  모든 `ChallengeName` 값은 단일 `challenge` 코드로 수렴)
- [ ] `sessionCookie(idToken, remember, expiresIn)` — `awsops_token=…; Path=/; Secure; HttpOnly; SameSite=Lax`
  + remember일 때만 `; Max-Age={expiresIn}` (세션 쿠키 vs 지속 쿠키) — 테스트는
  `remember=true, expiresIn=43200` → `Max-Age=43200` 정확 수치, `remember=false` →
  `Max-Age` 부재를 단언. 쿠키 이름은 edge 템플릿의 `awsops_token`과 동일해야
  함(결합 계약 — 변경 시 양쪽 동시)
- [ ] `safeNext(raw)` — `/`로 시작 && 2번째 문자가 `/`·`\`가 아니고 값에 `\` 미포함
  && 길이 ≤2048인 상대경로만 허용, 그 외 `'/'` (오픈 리다이렉트 차단 — 브라우저가
  `\`를 `/`로 정규화하므로 `/\evil.com` ≡ `//evil.com` 우회를 함께 차단) — 테스트에
  `//evil.com`, `/\evil.com`, `/@evil.com`(허용 — same-origin 경로),
  `https://evil.com`, 2049자 초과 케이스 포함
- [ ] `cd web && npx vitest run lib/login.test.ts` GREEN 확인 후 커밋

### Task 2: i18n 키 추가

**Files:**
- Modify: `web/lib/i18n.ts`

- [ ] ko/en 두 맵에 `login.*` 키 추가: `login.title`(로그인/Sign in), `login.subtitle`
  (Cloud Operations Dashboard — 양쪽 동일), `login.email`, `login.password`,
  `login.remember`(로그인 유지/Keep me signed in), `login.submit`(로그인 →/Sign in →),
  `login.busy`(인증 중…/Authenticating…), `login.secure`(보안 연결/Secure connection),
  `login.error.invalid_credentials`(이메일 또는 비밀번호가 올바르지 않습니다/Invalid email or password),
  `login.error.challenge`(계정 상태를 확인할 수 없습니다. 관리자에게 문의하세요/Account requires attention. Contact your administrator),
  `login.error.unavailable`(일시적인 오류입니다. 잠시 후 다시 시도하세요/Temporary error. Try again shortly)
- [ ] 카피에 'v2' 미포함 확인(기존 규칙) · 기존 vitest 전체 GREEN 후 커밋

### Task 3: `POST /api/auth/login` 라우트 (thin adapter)

**Files:**
- Create: `web/app/api/auth/login/route.ts`
- Test: `web/app/api/auth/login/route.test.ts`

- [ ] `route.test.ts` 먼저 — HTTP 어댑터 계층 검증(initiateAuth 모킹):
  잘못된 body = 400 `{ error: 'invalid_request' }`, 성공 = 200 + `Set-Cookie` 헤더 존재,
  `invalid_credentials` = 401, `challenge` = 403, `unavailable` = 502, 응답 JSON 구조
- [ ] `export const dynamic = 'force-dynamic'` · JSON body 파싱, `email`/`password`
  비어있지 않은 string + 길이 상한(254/256) 검증 → 위반 시 400 `{ error: 'invalid_request' }`
  (입력 검증 실패 = `invalid_request`, 인증 실패 = `invalid_credentials` — 코드 구분 유지)
- [ ] `initiateAuth` 호출 → 매핑: 성공 = 200 `{ ok: true }` + `Set-Cookie: sessionCookie(...)`,
  `invalid_credentials` = 401, `challenge` = 403, `unavailable` = 502 — 각각
  `{ error: <code> }` (메시지 문자열이 아닌 코드 반환, i18n은 클라이언트에서) ·
  로그인 응답에 `Cache-Control: no-store` 헤더 명시
- [ ] 로직은 전부 Task 1의 lib 함수 재사용(라우트에 신규 분기 없음) · vitest GREEN +
  `npx tsc --noEmit` 후 커밋

### Task 4: signout 단순화 (Hosted UI 왕복 제거)

**Files:**
- Modify: `web/app/api/auth/signout/route.ts`
- Modify: `web/components/shell/UserIdentity.tsx`

- [ ] signout 라우트: 쿠키 삭제 헤더 유지, 응답을 `{ redirect: '/login' }`로 교체
  (Cognito `/logout` URL 구성 제거 — 자체 폼 로그인엔 Hosted UI 브라우저 세션이 없음),
  상단 주석을 새 동작으로 갱신. `COGNITO_DOMAIN`/`APP_DOMAIN` env는 이 라우트에서
  미사용이 되지만 task def에서 제거하지 않음(lib/auth.ts 등 다른 소비자 + 무해)
- [ ] `UserIdentity.signOut()`: `window.location.href = redirect ?? '/login'`,
  catch 폴백도 `'/login'`으로 변경
- [ ] vitest 전체 GREEN + `npx tsc --noEmit` 후 커밋

### Task 5: ShellGate — 로그인 화면에서 앱 셸 미탑재

**Files:**
- Create: `web/components/shell/ShellGate.tsx`
- Test: `web/components/shell/ShellGate.test.tsx`
- Modify: `web/app/layout.tsx`

- [ ] `ShellGate.test.tsx` 먼저 — `vi.mock('next/navigation')`으로 `usePathname` 모킹:
  `/login`이면 children만(사이드바 미렌더), 그 외 경로면 AppShell 래핑 렌더 검증
- [ ] `ShellGate.tsx`(`'use client'`): `usePathname() === '/login'` → bare `{children}`,
  아니면 기존 조합(AppShell + CommandPalette + ChatDrawer)
- [ ] `layout.tsx`: `<AppShell>…</AppShell><CommandPalette/><ChatDrawer/>` 조합을
  `<ShellGate>{children}</ShellGate>`로 교체 (LanguageProvider는 바깥 유지)
- [ ] vitest GREEN 후 커밋

### Task 6: `/login` 페이지 UI (AgentCore teal 테마)

**Files:**
- Create: `web/app/login/page.tsx`

> 테마: 옛 DESIGN.md "1. Login"(paper+claude 오렌지)은 **AgentCore teal로 대체**. 색은 하드코딩하지 말고 **테마 토큰**만 사용 → 활성 테마를 그대로 따른다(기본 teal 라이트; console 테마 시 자동 다크). brand-500=teal `#01A88D`, 텍스트/링크는 brand-700, 버튼은 brand-action(AA).

- [ ] 페이지 셸: `bg-paper`(쿨 뉴트럴) 배경 + **teal·azure** radial glow 2개(top-left 16%/12%,
  bottom-right 84%/88%, `rgba(1,168,141,.12)` / `rgba(82,141,248,.10)`) · 400px 센터 컬럼 ·
  AwsopsMark 52px(teal 타일) + "AWSops"(xl/600) + `login.subtitle`(sm/secondary) 14px gap
- [ ] 카드: `bg-white`, radius 16, `shadow-card`, padding 28, `border-ink-100`, 필드 간 16px ·
  헤더 행 `login.title`(lg/600) + `bg-positive` dot "보안 연결" 배지 · 이메일/비밀번호
  필드(h-[42px], label xs/secondary, `border-ink-200` + `focus:border-brand focus:shadow-focus`) ·
  "로그인 유지" 체크박스(`accent-brand`, 기본 checked) ·
  "로그인 →" 풀폭 **`bg-brand-action` 버튼(흰 텍스트, AA 대비) `hover:bg-brand-action-hover`** — SSO 그리드·비밀번호 찾기 링크는 만들지 않음
- [ ] 동작(`'use client'` + `useSearchParams`는 `<Suspense>` 경계로 래핑 — Next 14 요건):
  submit → `POST /api/auth/login` → 성공 시 `window.location.replace(safeNext(next))`
  (`replace` 의도적 — 뒤로가기로 로그인 화면 복귀 방지),
  busy 동안 버튼 `login.busy` + disabled(가짜 850ms 아닌 실제 fetch 시간),
  오류 시 카드 상단 **`negative` 톤**(`bg-negative-surface text-negative-text border-negative-border`) 인라인 박스에 `login.error.{code}` 표시
- [ ] 푸터(2xs/muted, 중앙): `ap-northeast-2 · CloudFront → Lambda@Edge · RS256 JWT`
  ('v2'·`X-Custom-Secret` 미포함)
- [ ] `npm run build`(standalone) 성공 확인 후 커밋

### Task 7: Cognito 클라이언트 — USER_PASSWORD_AUTH + 토큰 수명 12h

**Files:**
- Modify: `terraform/foundation/auth.tf`

- [ ] `aws_cognito_user_pool_client.main`에 추가:
  `explicit_auth_flows = ["ALLOW_USER_PASSWORD_AUTH"]` — refresh 플로우는 구현하지
  않으므로 `ALLOW_REFRESH_TOKEN_AUTH` 미부여(최소권한; BFF는 RefreshToken을 즉시 폐기),
  `id_token_validity = 12`, `access_token_validity = 12`,
  `token_validity_units { id_token = "hours"  access_token = "hours" }`
- [ ] 주석: 자체 `/login` 폼의 BFF InitiateAuth 용도 + Hosted UI code 플로우는 폴백으로 공존 명기
- [ ] `terraform -chdir=terraform/foundation validate` 통과 후 커밋 (apply는 배포 절차에서)

### Task 8: Edge Lambda — 미인증 redirect를 `/login`으로

**Files:**
- Modify: `terraform/foundation/edge-lambda/cognito_edge.py.tftpl`

- [ ] `is_public()`에 `/login`, `/api/auth/login`, `/icon.svg` 추가(이유 주석 포함:
  로그인 페이지·인증 API·파비콘은 미인증 접근 필수) — **기존 항목
  `/_next/static/`·`/api/health`·`/api/auth/signout`은 그대로 유지**(additive 변경).
  `/icon.svg`는 `web/app/icon.svg`(App Router 파일 컨벤션)가 서빙 — 실존 확인 완료
- [ ] `lambda_handler`의 `return start_login(headers)` →
  `return login_redirect(uri, request.get('querystring', ''))` — 새 함수는
  `302 Location: /login?next={urllib.parse.quote(uri + ('?' + qs if qs else ''))}`
  + `Cache-Control: no-cache` (상대 Location, flow 쿠키 불필요) ·
  `start_login`/`handle_callback`은 다크 폴백으로 보존(flow 쿠키 `Max-Age=600`은
  PKCE 임시 상태용 의도적 단수명 — 변경하지 않음)
- [ ] `handle_callback`의 토큰 쿠키 `Max-Age=3600` → `43200`(12h 토큰 수명 정합)
- [ ] 렌더 산출물 파이썬 문법 검증: tftpl의 `${…}` 치환자를 더미 값으로 치환한 뒤
  `ast.parse`로 문법 확인 — 한 줄 `-c`가 아닌 **파이썬 스크립트 파일로 실행**(셸의
  `${` 이스케이프 함정 회피) + `terraform validate` + `plan` diff 확인 후 커밋
  (apply는 배포 절차에서)

### Task 9: 문서 갱신 + ADR-042

**Files:**
- Create: `docs/decisions/ADR-042-v2-inapp-login.md`
- Modify: `docs/decisions/CLAUDE.md` (ADR 인덱스)
- Modify: `CLAUDE.md`
- Modify: `docs/superpowers/specs/2026-06-12-login-screen-design.md`

- [ ] **ADR-042 작성** — v2 인앱 로그인(Cognito USER_PASSWORD_AUTH). 맥락(037 Hosted UI+PKCE),
  결정(자체 `/login` 폼 + 무서명 InitiateAuth + Edge redirect `/login`, `/_callback` 폴백 보존,
  AgentCore teal 테마), 트레이드오프(앱이 비번 처리 · MFA/재설정/페더레이션 UI 부재 ·
  USER_PASSWORD_AUTH · 최소권한으로 REFRESH 미부여 · id_token 12h), 대안(브랜드 랜딩→Hosted UI) 기각.
  파일명 `ADR-042-v2-inapp-login.md`(번호 = 최고+1; `ls docs/decisions/ADR-*.md`로 038 최고 확인) +
  `docs/decisions/CLAUDE.md` 인덱스에 ADR-038 형식 따라 한 줄 추가
- [ ] CLAUDE.md(국문·영문 두 섹션) 인증 불릿 갱신: 자체 `/login` 폼 +
  BFF `InitiateAuth(USER_PASSWORD_AUTH)` + Edge redirect `/login` + Hosted UI PKCE는
  다크 폴백 · signout은 쿠키 삭제 → `/login`
- [ ] 스펙 문서 상태 줄을 구현 완료로 갱신 후 커밋

## 배포 절차 (플랜 태스크 아님 — 컨트롤러 실행, 순서 엄수)

1. `make deploy` — `/login` 페이지·API 먼저 배포(edge가 아직 Hosted UI로 보내므로 무해)
2. `terraform -chdir=terraform/foundation plan -out tfplan` → **컨트롤러가 `apply tfplan`**
   (Cognito client + Edge Lambda 신규 버전 + CloudFront 연결 갱신 — 긴 apply)
3. 스모크: 시크릿 창 미인증 `GET /` → 302 `/login` → admin 로그인 → 대시보드 →
   로그아웃 → `/login` 복귀 → 잘못된 비밀번호 = 단일 오류 메시지 확인

## 롤백

- web: 직전 이미지로 ECS 재배포(`make deploy`는 태그 푸시 — 이전 태스크데프 리비전 지정)
- edge: `lambda_handler`의 redirect 한 줄을 `start_login(headers)`로 되돌려 re-apply
  (Hosted UI 플로우 즉시 복원 — `explicit_auth_flows` 추가와 `is_public()` 추가 경로는
  잔류해도 무해)
