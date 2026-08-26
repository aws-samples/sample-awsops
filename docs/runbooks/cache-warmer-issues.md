# Runbook: 캐시 워머 문제 해결 / Cache Warmer Troubleshooting

대시보드 캐시 프리워밍 (`src/lib/cache-warmer.ts`) 운영 이슈.
Troubleshooting for the dashboard cache pre-warming subsystem (`src/lib/cache-warmer.ts`).

## 정상 동작 / Expected Behavior
- 4분 주기로 대시보드 23개 + 모니터링 10개 쿼리를 백그라운드 실행
- 결과는 node-cache에 5분 TTL로 저장 (멀티 어카운트 prefix)
- Runs every 4 minutes; caches results with a 5-min TTL (accountId-prefixed keys)

## 확인 / Health Check
```bash
curl -s 'http://localhost:3000/awsops/api/steampipe?action=cache-status' | jq
```

정상 응답 예시 / Healthy response:
```json
{
  "isRunning": false,
  "lastWarmedAt": "2026-04-23T...",
  "lastDurationSec": 58,
  "dashboardQueries": 23,
  "monitoringQueries": 10,
  "intervalMin": 4,
  "warmCount": 312
}
```

## 증상별 대응 / Symptoms

### 1. `lastWarmedAt` 이 오래됨 (> 10분) / Stale warmer
```bash
# Steampipe 상태 / Steampipe health
steampipe service status

# pg pool 연결 테스트 / Test the pool
curl -s -X POST http://localhost:3000/awsops/api/steampipe \
  -H 'Content-Type: application/json' \
  -d '{"queries":{"ping":"SELECT 1 AS v"}}' | jq
```

원인 / Causes:
- Steampipe 서비스 다운 → `steampipe service restart`
- Statement timeout (120초 초과) → 쿼리 파일의 `LIMIT` 확인
- Next.js 프로세스 재시작으로 interval이 사라짐 → 자연스럽게 다음 요청 시 lazy-init

### 2. `lastError` 필드에 값이 있음 / Warmer errored
```bash
grep -i "cache-warmer\|CacheWarmer" /tmp/awsops-server.log | tail -30
```

자주 나오는 에러:
- `connection refused` → Steampipe pg 프로세스 다운
- `could not find column` → 쿼리 파일이 실제 스키마와 불일치 (`information_schema.columns` 로 확인)
- SCP 차단 컬럼 → CLAUDE.md "Steampipe 쿼리 규칙" 참조

### 3. 메모리 사용량 급증 / Memory spike
- node-cache 키가 계정별로 누적됨 → 인스턴스 재시작으로 초기화
- 장기 해결: `src/lib/steampipe.ts` 의 cache TTL 단축 또는 LRU 크기 제한

### 4. 첫 렌더링이 느림 / Cold start slow
캐시 워머는 **lazy-init** → 첫 API 요청이 들어와야 기동됨.
The warmer lazy-starts only after the first request arrives.

강제 시동 / Force start:
```bash
# 헬스체크로 워머 트리거 / Ping triggers the warmer
curl -s http://localhost:3000/awsops/api/steampipe?action=cache-status >/dev/null
```

## 관련 파일 / Related Files
- `src/lib/cache-warmer.ts` — 워머 루프
- `src/lib/steampipe.ts` — pg 풀 + cache
- `src/app/api/steampipe/route.ts` — `action=cache-status` 엔드포인트

## 참고 / Reference
- ADR-014: `docs/decisions/014-cross-cutting-cache-i18n-cdn.md`
