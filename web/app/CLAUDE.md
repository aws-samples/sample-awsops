# 앱 라우트 모듈 / App Routes Module

## 역할 / Role
Next.js App Router — 페이지 36개 + API 라우트 86개(`app/api/`). API는 thin-BFF: Aurora 조회, AWS SDK read, AgentCore 호출까지만. 장기/OOM 위험 작업은 `POST /api/jobs`로 enqueue.
(36 pages + 86 API routes. Thin-BFF: DB reads, AWS SDK reads, AgentCore calls only; long jobs are enqueued.)

## 구조 / Structure
- 페이지 (pages): 개요 `page.tsx`, `inventory/[type]`·`inventory/g/[group]`, `eks/`(개요·nodes·pods·deployments·services·explorer·cost·`[cluster]`), `topology/`(개요·infra·services·`resource/[id]`), `monitoring`, `network-flow`, `dns-query`, `ip-addresses`, `vpc-endpoints`, `direct-connect`, `network-firewall`, `security`, `compliance`, `cost`, `bedrock`, `agentcore`, `ai-diagnosis`, `assistant`, `datasources`, `integrations`(+`datasources/[id]`), `accounts`, `customization`, `jobs`, `login`
- API (`app/api/`): accounts, actions, agentcore, ai-usage, anfw, auth(login/signout), bedrock-metrics, changelog, chat(+threads/stats), compliance, cost, customization, datasources, db, diagnosis, dns-logs, dx, eks, graph, health, incidents, insights, integrations, inventory, ip-inventory, jobs, me, monitoring, nfm, opencost, overview, security, sg, stream, tgw, vpce

## 규칙 / Rules
- 인증: 비공개 API는 `verifyUser(request.headers.get('cookie'))` (`lib/auth.ts`, `awsops_token` 쿠키 RS256 JWKS 재검증) → null이면 401. 관리자 전용은 추가로 `isAdmin()` (`lib/admin.ts`). `/api/health`만 공개.
  (Private APIs: `verifyUser()` re-verifies the edge-set cookie; admin routes add `isAdmin()`. Only `/api/health` is public.)
- 라우트 핸들러는 `export const dynamic = 'force-dynamic'` 선언 (기존 91개 파일 일관 패턴).
- `api/chat`의 `aws-data`(Steampipe SQL, `lib/aws-data.ts`)와 auto-collect 콜렉터 6종(`lib/collectors/`)은 **로컬 핸들러** — AgentCore 게이트웨이가 없으므로 ADR-044 멀티 라우트 팬아웃에서 제외 (fan-out은 게이트웨이 보유 built-in만).
  (aws-data and the 6 collectors are local handlers with no AgentCore gateway behind them — excluded from multi-route fan-out.)
- 요청 바디는 `readJsonBounded` (`lib/http-body.ts`)로 파싱 — 스트림 상한; `middleware.ts` 2MB belt와 이중 방어.
- fetch 경로는 `/api/*` — v1의 `/awsops` 접두사 금지 (basePath 없음).
- 페이지 신설 시 `components/shell/Sidebar.tsx` 등록 + `lib/i18n.ts` nav 키를 함께 추가.
