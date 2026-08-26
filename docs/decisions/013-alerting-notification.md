# ADR-013: 알림 · 통지 — 웹훅 수신 + SNS/이메일 + 리포트 다운로드 / Alerting · Notification — Webhook Ingest + SNS/Email + Report Download

## Status / 상태

**Accepted (2026-06-22) — consolidated.** consolidates: ADR-012 (SNS 알림 전략), ADR-014 (리포트 프록시 다운로드 URL), ADR-022 (알림 웹훅 HMAC-SHA256 인증).

이 ADR은 v2 현행(net) 결정만을 기술한다. 세 레거시 ADR의 v1 메커니즘(EC2 `data/config.json` 시크릿, `src/lib/alert-sqs-poller.ts` 폴러, `/awsops/api/*` 프록시 등)은 v1 이력으로만 남으며 여기서 재서술하지 않는다.

This ADR records only the current v2 (net) decisions. The v1 mechanisms of the three legacy ADRs (EC2 `data/config.json` secrets, the `src/lib/alert-sqs-poller.ts` poller, `/awsops/api/*` proxy, etc.) remain v1 history and are not restated here.

## Context / 컨텍스트

v2 엣지는 CloudFront → Lambda@Edge(viewer-request, RS256)로 보호되어 유효한 `awsops_token` 쿠키 없는 요청을 모두 차단한다(ADR-020/042). 그러나 알림·통지 도메인은 이 정책과 양립해야 하는 세 경로를 갖는다:

1. **인입 웹훅** — VPC 내부 발신기(Prometheus Alertmanager·Grafana·범용 emitter)는 브라우저 세션도 Cognito JWT도 가질 수 없으므로 Cognito-everywhere 규칙의 *유일한 예외* 가 필요하다.
2. **외부 통지(아웃바운드)** — 운영자에게 스케줄 진단 리포트 요약을 이메일로 전달해야 한다.
3. **리포트 다운로드** — 진단 리포트(DOCX/MD/PDF)는 S3에 영속되며 인증된 사용자에게 안전하게 전달되어야 한다.

The v2 edge (CloudFront → Lambda@Edge viewer-request, RS256) rejects any request without a valid `awsops_token` cookie (ADR-020/042). The alerting/notification domain must coexist with that posture across three paths: inbound webhooks from Cognito-incompatible VPC-internal emitters, outbound email notification, and authenticated report download.

## Decision / 결정

### 1. 인입 웹훅 — HMAC-SHA256 인증 / Inbound webhook — HMAC-SHA256 auth

알림 웹훅은 **HMAC-SHA256 + 상수 시간 비교**로 인증한다(`web/app/api/incidents/webhook/route.ts`, ADR-022에서 이식). 처리 순서:

- 요청당 **rate-limit** (클라이언트 IP당 분당 60회; CloudFront+ALB 2-hop이므로 `x-forwarded-for` 끝에서 두 번째 값).
- **SNS SubscriptionConfirmation** 은 `^https://sns\.[a-z0-9-]+\.amazonaws\.com/` 패턴 검증 후에만 `SubscribeURL` 을 호출.
- 헤더(`x-webhook-signature` | `x-hub-signature-256` | `x-alertmanager-signature`)에서 서명을 읽어 `sha256=` 접두어 제거 후 `HMAC_SHA256(secret, rawBody)` 와 `crypto.timingSafeEqual` 로 비교. **active/standby 쌍** 을 둘 다 시도해 무중단 회전을 지원(standby 매칭 시 감사 로그).
- 불일치 → HTTP 401(모든 실패 경로에 평평한 응답으로 프로빙 차단).
- 시크릿의 source of truth = **SSM Parameter(SecureString, WithDecryption)** — v1의 `data/config.json` 이 아님. 5분 캐시, 부재 시 degrade-safe.

인입 웹훅 라우트 전체는 `INCIDENT_LIFECYCLE_ENABLED` 플래그 뒤에서 동작하며(미설정 시 503, 수신·검증·triage·enqueue 일절 없음), 인시던트 라이프사이클은 ADR-032 다운그레이드에 따라 **analysis-only로 게이트**되어 있다. 즉 *인증 스킴 자체는 LIVE(코드)* 이나, 라우트 활성화는 게이트-OFF다.

Inbound webhooks are authenticated by HMAC-SHA256 with constant-time `timingSafeEqual`, active/standby rotation, SSM-sourced secrets, rate-limit (60/min/IP, 2-hop XFF), and SNS-URL-validated subscription confirmation. The route sits behind `INCIDENT_LIFECYCLE_ENABLED` (503 when off; ADR-032 analysis-only gate) — the auth scheme is live as code, the route activation is gated off.

### 2. SNS / 이메일 통지 / SNS / email notification

스케줄 진단 리포트 요약은 **단일 전용 SNS 토픽** 으로 발행되며, 인앱 구독 관리(`web/lib/diagnosis-notify.ts`)는 그 토픽의 이메일 구독만 다룬다(Subscribe/Unsubscribe/List). 토픽 ARN은 Terraform이 주입(`diagnosis_notify_enabled` 게이트)하며, 부재 시 기능 비활성.

`diagnosis_notify_enabled=true` 는 **현재 LIVE**다. 이는 외부-comms write이지만 IAM이 단일 토픽 ARN으로 스코프되어 **AWS-리소스 변경이 아니며**, ADR-040/041의 거버넌스된 외부 데이터/통지 write에 해당한다. (광역 `integrations_write_enabled` [Slack/Notion/Jira]는 OFF로 유지.) 구독 ARN은 `${topicArn}:${uuid}` 소유 검증으로 임의 토픽 unsubscribe를 차단한다.

Scheduled diagnosis summaries publish to one dedicated SNS topic; in-app subscription management touches only that topic's email subscriptions, scoped by IAM to the single topic ARN. `diagnosis_notify_enabled=true` is **LIVE** — an external-comms write that is NOT AWS-resource mutation and is governed per ADR-040/041. Subscription-ARN ownership is verified (`${topicArn}:${uuid}`) before unsubscribe.

### 3. 리포트 다운로드 — BFF 프록시 / Report download — BFF proxy

리포트 다운로드는 S3 presigned URL을 클라이언트에 노출하지 않고 **BFF가 프록시** 한다(`web/app/api/diagnosis/[id]/download/route.ts`). 라우트는 엣지 인증된 세션 하에서 S3 `GetObject` 로 객체를 조회해 `Content-Disposition: attachment` 와 함께 바이트를 스트리밍한다(ADR-014 패턴을 v2 루트 경로·node-pg·Aurora 모델로 이식). presigned URL의 만료·공유·철회 불가 문제를 원천 제거한다.

Report downloads are proxied by the BFF (no presigned URL exposed): the route fetches the S3 object via `GetObject` under the edge-authenticated session and streams it with `Content-Disposition: attachment` (ADR-014 pattern carried to the v2 root path). Eliminates presigned-URL staleness, shareability, and non-revocability.

## Consequences / 결과

### Positive / 긍정

- Cognito 비호환 발신기가 대시보드 인증 정책을 약화하지 않고 알림을 전달(HMAC + rate-limit + 단일 예외 경계).
- 페이로드 무결성 종단 보장; 소스별/active-standby 시크릿으로 회전·blast-radius 격리; 타이밍 사이드채널 저항.
- 통지가 단일 IAM-스코프 토픽으로 제한되어 거버넌스(ADR-040/041) 충족.
- 다운로드가 세션 수명과 정렬·즉시 철회 가능·사용자 단위 감사; 향후 S3 자산이 동일 프록시 패턴 재사용.

### Negative / Trade-offs / 부정 · 트레이드오프

- 운영자가 시크릿 배포·백업·승격/폐기(수동 회전, TTL 자동승격 없음) 책임.
- 15분 재전송 윈도우(시계편차 관용 ↔ 재전송 노출)·요청당 HMAC CPU(rate-limit이 완화).
- 모든 바이트가 BFF를 경유 → 대역폭·메모리 오버헤드 + BFF가 다운로드 경로 단일 장애점; S3 정상이어도 BFF 장애 시 다운로드 차단. (현행 리포트 크기에선 무시 가능, 대량 export는 청크 스트리밍 필요.)
- `cloudwatch`/`sqs` 는 고객 시크릿 HMAC 미산출 소스 → HMAC은 push 발신기(`alertmanager`/`grafana`/`generic`)에만 적용(ADR-022 정정 승계).

## 6 Pillars — 운영 우수성 (Operational Excellence) / 6 Pillars — Operational Excellence

- **단일 인증 예외의 경계화**: 인입 예외를 HMAC + rate-limit + 재전송 윈도우 + 플래그로 좁게 묶어, 운영 정책(Cognito-everywhere)을 깨지 않고 관측성 통합을 수용.
- **무중단 회전**: active/standby 시크릿 쌍 + SSM SoT로 발신기 조율 없는 시크릿 교체(감사 로그 포함).
- **거버넌스된 통지**: 외부 write를 단일 토픽 IAM 스코프 + flag-gate로 제한해 변경·자율 동결 원칙(ADR-041)과 분리 유지.
- **장애 격리·감사**: 다운로드를 세션 수명과 정렬하고 BFF 로그에 사용자 귀속, 인입을 thin-BFF 규칙대로 무거운 처리를 워커 티어로 위임.

## References / 참고

### Internal
- `web/app/api/incidents/webhook/route.ts` — HMAC active/standby + rate-limit + SNS confirm + SSM secrets (ADR-022 이식; `INCIDENT_LIFECYCLE_ENABLED` 게이트)
- `web/lib/diagnosis-notify.ts` — 단일 SNS 토픽 이메일 구독 관리 (`diagnosis_notify_enabled` 게이트, LIVE)
- `web/app/api/diagnosis/[id]/download/route.ts` — S3 프록시 다운로드 (`Content-Disposition: attachment`)
- `terraform/foundation/notify.tf` — SNS 토픽 (`diagnosis_notify_enabled`)
- ADR-032 (인시던트 라이프사이클 — analysis-only 게이트), ADR-040/041 (거버넌스된 외부 데이터/통지 write), ADR-020/042 (엣지 인증)
- `docs/reviews/2026-06-21-docs-reality-audit.md` — diagnosis_notify LIVE 2-티어·incidents webhook 검증

### External
- [Amazon SNS → email subscription](https://docs.aws.amazon.com/sns/latest/dg/sns-email-notifications.html)
- [Node.js crypto.timingSafeEqual](https://nodejs.org/api/crypto.html#cryptotimingsafeequala-b)
- [MDN Content-Disposition](https://developer.mozilla.org/en-US/docs/Web/HTTP/Headers/Content-Disposition)
