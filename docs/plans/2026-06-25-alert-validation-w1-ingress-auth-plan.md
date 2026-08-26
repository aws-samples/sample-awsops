# Plan — W1 Ingress Auth Hardening (alert validation) — rev2

> 원천 / Source: `docs/specs/2026-06-24-webhook-alert-validation-design.md` (rev4, codex-PASS) §4/§4.1/§5/§8/§10.
> rev2: codex-가중 P2 게이트(codex+kimi+glm+opus+agy 전원 FAIL) 반영 — **TopicArn allowlist는 `source_allowlist` JSONB**(endpoint 아님)[verified], **replay/Timestamp 신선도**, **인증서 issuer/유효기간 검증**, **body 크기 캡(413)**, **단일 shared post-auth 파이프라인**(feedback-loop/isolate 보존), **verifyBearer length-guard**, **UnsubscribeConfirmation**, 로깅 위생, generic 401.
> Scope: **W1 only** — 인그레스 인증 하드닝(standalone PR). AlertValidation(W2)·SNS(W3)·Integrations UX/source_allowlist 등록(W4)은 별도.
> Posture: read-only 인증; AWS mutation 없음(ADR-005). `incident_lifecycle_enabled` 런타임 게이트 하(503). 시크릿 부재 → degrade-safe.
> Branch: `feat/v2-alert-validation`. TDD: red→green→commit. 테스트=vitest(worktree는 루트 node_modules 심링크).

## Mechanism / 현황[verified]
- `route.ts`: flag→rate-limit→**모든 비-SubscriptionConfirmation을 HMAC 검증**(SNS Notification 거부)→detect→normalize→`bearsSelfWritebackMarker` 필터→`isolatePayload`→triage 루프. **`rawBody = await request.text()`는 언바운드**[verified — DoS].
- `confirmSnsSubscription`: `SubscribeURL`을 `SNS_URL_PATTERN`(`/^https:\/\/sns\.[a-z0-9-]+\.amazonaws\.com\//`) 호스트 체크만 하고 **무서명·무-allowlist fetch**[verified].
- `incident-normalize.ts`: `detectAlertSource`(Type=Notification→cloudwatch), `normalizeCloudWatch`(SNS **엔벨로프** `body.Message`), `normalizeAlertmanager`(grouped 배열). `x-alert-source` 헤더가 현재 source로 사용됨.
- `integrations` 테이블[verified P2 migration]: ingress 컬럼 `direction`/`auth_mode`/`receive_path`/`inbound_auth_ref`/**`source_allowlist JSONB DEFAULT '[]'`**/`trigger_target`, kind CHECK ingress=`cloudwatch_sns|alertmanager|…`, `idx_integrations_dir_enabled (direction,enabled) WHERE enabled`. **`endpoint`는 egress 전용**(ingress 미검증/미사용). → **TopicArn allowlist 진실원천 = `source_allowlist` 배열**.
- 목표: **envelope-first 인증** — Type∈{Notification,SubscriptionConfirmation,UnsubscribeConfirmation}→SNS 서명+신선도+TopicArn allowlist; 그 외→Alertmanager **bearer** 또는 커스텀 **HMAC**. SNS-shaped를 직접 경로에서 generic-401 거부. 인증 후 **단일 shared 파이프라인**으로 합류(feedback-loop drop + isolate + triage 보존). `x-alert-source`는 인증에 절대 미사용.
- W1 fail-closed 노트: `source_allowlist`에 TopicArn이 등록(W4)되기 전엔 모든 SNS 알림이 401(정상 fail-closed; 회귀 아님). 통합 테스트용 seed 노트 포함.

## File scope (scope_guard allowlist)
- `web/lib/sns-verify.ts`
- `web/lib/sns-verify.test.ts`
- `web/lib/incident-ingress-auth.ts`
- `web/lib/incident-ingress-auth.test.ts`
- `web/lib/http-body.ts`           (add `readTextBounded`; `readJsonBounded` delegates — DRY)
- `web/lib/http-body.test.ts`
- `web/app/api/incidents/webhook/route.ts`
- `web/app/api/incidents/webhook/route.test.ts`
- `docs/plans/2026-06-25-alert-validation-w1-ingress-auth-plan.md`

### Task 1: SNS message verification — signature + freshness + cert validity (lib)

**Files:**
- Create: `web/lib/sns-verify.ts`
- Create: `web/lib/sns-verify.test.ts`

Pure verifier for AWS SNS HTTP(S) messages (Notification / SubscriptionConfirmation / UnsubscribeConfirmation). No route wiring.

- [ ] Test-first (no network/AWS — inject cert/fetcher + clock): `{ok:false}` for SignatureVersion∉{1,2}; SigningCertURL non-https / failing SNS host allowlist (`/^https:\/\/sns\.[a-z0-9-]+\.amazonaws\.com\//`) / non-cert path; bad signature; **Timestamp outside freshness window**; **expired/not-yet-valid or non-Amazon cert**. `{ok:true}` only for a fixture signed by a test RSA key with a valid fixture cert + fresh Timestamp.
- [ ] Canonical string per **real SNS types** — `Notification`: Message,MessageId,Subject(when present),Timestamp,TopicArn,Type; `SubscriptionConfirmation` & `UnsubscribeConfirmation`: Message,MessageId,SubscribeURL,Timestamp,Token,TopicArn,Type. `crypto.verify('RSA-SHA1'|'RSA-SHA256')` by SignatureVersion (1=SHA1, 2=SHA256)[opus verified].
- [ ] **Replay/freshness**[unanimous]: reject when `abs(now - Date.parse(Timestamp))` > window (SSM-tunable, default 15min; clock passed in for tests).
- [ ] **Cert validation**[unanimous]: parse PEM via `crypto.X509Certificate` — assert `validTo`/`validFrom` cover now AND subject/issuer is Amazon (e.g. subject CN endsWith `amazonaws.com` and issuer O=Amazon); host allowlist + https + **path is an SNS signing cert** (`/SimpleNotificationService-*.pem`).
- [ ] **Cert fetch guard**: injectable `fetchCert(url)`; default `fetch` with https-only + SNS host allowlist + 5s AbortController timeout + response size cap (16KB) + **TTL cache (1h)** keyed by SigningCertURL.
- [ ] **Logging hygiene**[glm]: never log Signature / SigningCertURL / TopicArn / tokens — only `{ok}` result.
- [ ] Verify: `cd web && ../node_modules/.bin/vitest run lib/sns-verify.test.ts` green.
- [ ] Commit: `feat(incident): SNS verify — sig + Timestamp freshness + cert validity (SSRF-safe) [W1]`

### Task 2: Ingress auth dispatch + TopicArn allowlist(source_allowlist) + bearer (lib)

**Files:**
- Create: `web/lib/incident-ingress-auth.ts`
- Create: `web/lib/incident-ingress-auth.test.ts`

- [ ] Test-first: `classifyEnvelope(body)` → `'sns'` iff `body.Type∈{Notification,SubscriptionConfirmation,UnsubscribeConfirmation}` else `'direct'` (examines **only `body.Type`**, never headers/`x-alert-source`)[glm].
- [ ] Test-first: `isTopicAllowed(topicArn, queryFn)` → true only if `topicArn` ∈ the **`source_allowlist` JSONB array** of an enabled `direction='ingress' AND kind='cloudwatch_sns'` row[opus/kimi/glm verified — NOT `endpoint`]. Inject `queryFn` (mock rows); empty allowlist/none → false (fail-closed).
- [ ] Test-first: `verifyBearer(authHeader, secrets[])` — parse `Authorization: Bearer <t>`; **length-guard before `timingSafeEqual`** (timingSafeEqual throws on unequal lengths + leaks length[opus]) or compare SHA-256 digests; active/standby; absent/empty secrets → false.
- [ ] `resolveSourceHint(body, header)` → allowed `AlertSource` enum only; **forced `'cloudwatch'` for SNS**; never influences auth[codex/glm]. Re-export HMAC `verifySignature` here for the direct-custom path.
- [ ] Verify: `vitest run lib/incident-ingress-auth.test.ts` green.
- [ ] Commit: `feat(incident): envelope-first auth — source_allowlist + length-safe bearer + HMAC [W1]`

### Task 3: Route — body cap + SNS path + single shared post-auth pipeline

**Files:**
- Modify: `web/lib/http-body.ts`
- Modify: `web/lib/http-body.test.ts`
- Modify: `web/app/api/incidents/webhook/route.ts`
- Modify: `web/app/api/incidents/webhook/route.test.ts`

- [ ] Test-first: **body over cap → 413** before parse (bounded read; e.g. 512KB). Forged/oversized payload does not OOM.
- [ ] Test-first: `Notification` → 401 unless `verifySnsMessage` passes AND `isTopicAllowed`; on pass → funnels into the **shared post-auth pipeline** (normalize → `bearsSelfWritebackMarker` drop → `isolatePayload` → triage). Test: an SNS Notification carrying AWSops' self-writeback marker is **dropped 200** (proves no separate path bypasses the ADR-034 breaker)[opus].
- [ ] Test-first: `SubscriptionConfirmation` → confirm SubscribeURL **only after** verify+allowlist; re-check SubscribeURL host (`SNS_URL_PATTERN`) immediately before fetch + https + timeout + response size cap[codex/glm]. `UnsubscribeConfirmation` → verify+allowlist → **200 ack, no confirm/triage**.
- [ ] Impl: after flag+rate-limit, bounded-read body; `classifyEnvelope`; SNS branch verifies+allowlists, routes confirm/unsubscribe/notification; **both auth branches converge on one shared pipeline** (no duplicated triage). Replace unguarded `confirmSnsSubscription`. Generic `401 {error:'Invalid authentication'}` (no scheme-revealing messages)[glm].
- [ ] Verify: `vitest run app/api/incidents/webhook/route.test.ts` green.
- [ ] Commit: `feat(incident): route — body cap + SNS verify/allowlist + shared post-auth pipeline [W1]`

### Task 4: Direct path — bearer (Alertmanager) + HMAC (custom) + reject SNS-shaped

**Files:**
- Modify: `web/app/api/incidents/webhook/route.ts`
- Modify: `web/app/api/incidents/webhook/route.test.ts`

- [ ] Test-first: direct POST with valid `Authorization: Bearer` → accepted; valid HMAC (custom) → accepted (back-compat); **SNS-shaped body on direct path → generic 401** (no impersonation); neither → 401.
- [ ] Test-first (degrade): **no bearer SSM param + valid HMAC → accepted**; neither secret configured → 401. `x-alert-source` ignored for auth; `resolveSourceHint` used post-auth only.
- [ ] Impl: direct branch tries bearer (`SSM_INCIDENT_BEARER_PARAM`/`_STANDBY` via existing degrade-safe `readSsm`) then HMAC; funnels into the shared pipeline with `resolveSourceHint`.
- [ ] Verify: full `cd web && ../node_modules/.bin/vitest run lib/sns-verify.test.ts lib/incident-ingress-auth.test.ts app/api/incidents/webhook/route.test.ts` green.
- [ ] Commit: `feat(incident): direct-path bearer + HMAC + reject SNS-shaped + post-auth source hint [W1]`

## Out of scope / guardrails
- AlertValidation·trigger_event·Haiku·SNS publish → W2/W3. **`source_allowlist` 등록 UX + ingress cloudwatch_sns 행 생성 → W4**(W1은 소비만; 미등록 시 SNS 401 fail-closed). per-integration `auth_mode`/`inbound_auth_ref` 활용도 W4(W1은 공유 SSM 시크릿).
- AWS mutation/autonomy 없음(ADR-005). **terraform 변경 없음**(SSM 파라미터는 degrade-safe read; 생성은 W3 게이트).
- 기존 flag 503·rate-limit·`bearsSelfWritebackMarker`·`isolatePayload`·HMAC 경로 보존. v1 `src/` 무수정.
