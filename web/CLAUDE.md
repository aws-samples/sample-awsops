# 웹 모듈 / Web Module

## 역할 / Role
Next.js 14 thin-BFF. 루트 경로(`/`) 서빙 — basePath 없음, fetch는 `/api/*`. standalone 빌드를 arm64 컨테이너로 ECS Fargate에 배포. 무겁거나 긴 작업은 인라인 실행하지 않고 `POST /api/jobs`로 워커 큐에 enqueue.
(Next.js 14 thin-BFF. Root path — no basePath. Standalone arm64 container on ECS Fargate. Heavy work is enqueued, never run inline.)

## 구성 / Layout
| 디렉토리 | 내용 / Contents | 규모 |
|---|---|---|
| `app/` | 페이지 + API 라우트 (App Router) | 36 pages / 86 API routes |
| `lib/` | 도메인 로직 — React 비의존 (domain logic, mostly React-free) | 118 modules |
| `components/` | 클라이언트 컴포넌트 (client components) | 88 files, 12 subdirs |

## 주요 파일 / Key Files
- `middleware.ts` — `/api/*` 전역 요청 바디 상한 2MB (라우트별 `readJsonBounded` 위의 defense-in-depth) (global 2MB body cap over per-route stream caps)
- `instrumentation.ts` — 서버 부팅 훅: graph-rebuild 주기 실행, 기본 OFF (`GRAPH_REBUILD_INTERVAL_MINS`) (server-boot hook for graph rebuild, default off)
- `next.config.mjs` — `output: 'standalone'` + `experimental.instrumentationHook` + 구경로 리다이렉트(`/ec2`, `/opencost`)
- `Dockerfile` — node:20-alpine 2-stage standalone, `CMD ["node","server.js"]`

## 규칙 / Rules
- 빌드/테스트: `npm run build` / `npm test` (vitest run). 테스트는 소스 옆 `*.test.ts(x)` colocate.
- 배포는 repo 루트에서 `make deploy` — arm64 buildx → ECR push → ECS 롤링 → smoke `/api/health`. arm64 필수.
- 컨테이너 배포 시 `HOSTNAME=0.0.0.0`을 task def 런타임 env로 명시 — 이미지 ENV만으론 부족 (ECS가 ENI IP로 덮어씀 → healthCheck UNHEALTHY).
- 앱 상태는 Aurora (node-pg, `lib/db.ts`) — v1의 `data/*.json`·Steampipe pg Pool 패턴 적용 안 됨.
- 모든 컴포넌트 `export default`, 프로덕션 standalone 빌드 기준.
