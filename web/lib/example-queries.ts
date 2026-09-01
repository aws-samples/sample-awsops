// Curated Explore example chips (gap-audit L84, v1 parity): 4 raw queries + 4 natural-language
// prompts per connector kind. Module constants only — never user input — so the chips share the
// diag-signal catalog's injection posture (picking a chip can only run a curated expression).
// React-free (vitest).

export interface ExampleQuery { label: string; expr: string }

export const EXAMPLE_QUERIES: Record<string, ExampleQuery[]> = {
  prometheus: [
    { label: 'CPU 사용률', expr: '100 - (avg by (instance) (rate(node_cpu_seconds_total{mode="idle"}[5m])) * 100)' },
    { label: '메모리 가용량', expr: 'node_memory_MemAvailable_bytes' },
    { label: '타깃 상태', expr: 'up' },
    { label: 'HTTP 5xx 비율', expr: 'sum(rate(http_requests_total{status=~"5.."}[5m])) / sum(rate(http_requests_total[5m]))' },
  ],
  mimir: [
    { label: '타깃 상태', expr: 'up' },
    { label: '컨테이너 CPU Top5', expr: 'topk(5, sum by (namespace) (rate(container_cpu_usage_seconds_total[5m])))' },
    { label: '파드 재시작(1h)', expr: 'sum by (namespace) (increase(kube_pod_container_status_restarts_total[1h]))' },
    { label: '노드 디스크 여유', expr: 'node_filesystem_avail_bytes{mountpoint="/"}' },
  ],
  loki: [
    { label: '에러 로그', expr: '{job=~".+"} |= "error"' },
    { label: '최근 로그 스트림', expr: '{job=~".+"}' },
    { label: '로그 볼륨(5m)', expr: 'sum by (job) (count_over_time({job=~".+"}[5m]))' },
    { label: '경고 이상만', expr: '{job=~".+"} |~ "(?i)(error|warn|fatal)"' },
  ],
  tempo: [
    { label: '느린 트레이스(>500ms)', expr: '{ duration > 500ms }' },
    { label: '에러 트레이스', expr: '{ status = error }' },
    { label: 'HTTP 5xx 스팬', expr: '{ span.http.status_code >= 500 }' },
    { label: '전체 최근 트레이스', expr: '{}' },
  ],
  clickhouse: [
    // system.* is connector-blocked for user queries (clickhouse_mcp DANGER tokens) — SHOW is the
    // permitted way to enumerate; schema-specific trace queries come from the pre-built cards/chips
    // (card_catalog / diag signals resolve the real table from the cached schema).
    { label: '테이블 목록', expr: 'SHOW TABLES' },
    { label: '데이터베이스 목록', expr: 'SHOW DATABASES' },
    { label: '서버 버전', expr: 'SELECT version() AS version' },
    { label: '현재 DB · 시간', expr: 'SELECT currentDatabase() AS db, now() AS now' },
  ],
  jaeger: [
    { label: '서비스 트레이스 20건', expr: 'service=frontend&limit=20' },
    { label: '에러 태그 검색', expr: 'service=frontend&tags={"error":"true"}&limit=20' },
    { label: '느린 요청(>1s)', expr: 'service=frontend&minDuration=1s&limit=20' },
    { label: '특정 오퍼레이션', expr: 'service=frontend&operation=HTTP GET&limit=20' },
  ],
  dynatrace: [
    { label: '호스트 CPU', expr: 'builtin:host.cpu.usage:avg' },
    { label: '호스트 메모리', expr: 'builtin:host.mem.usage:avg' },
    { label: '서비스 응답시간', expr: 'builtin:service.response.time:avg' },
    { label: '서비스 실패율', expr: 'builtin:service.errors.total.rate:avg' },
  ],
  datadog: [
    { label: 'CPU 사용률', expr: 'avg:system.cpu.user{*}' },
    { label: '메모리 사용', expr: 'avg:system.mem.used{*}' },
    { label: '로드 애버리지', expr: 'avg:system.load.1{*}' },
    { label: '컨테이너 CPU', expr: 'avg:container.cpu.usage{*} by {container_name}' },
  ],
};

export const AI_EXAMPLES: Record<string, string[]> = {
  prometheus: ['모든 노드의 CPU 사용률', '메모리 사용률이 높은 인스턴스', '최근 5분 HTTP 에러 비율', '다운된 타깃 찾기'],
  mimir: ['네임스페이스별 CPU 상위 5개', '최근 1시간 파드 재시작 횟수', '디스크 여유 공간이 적은 노드', '전체 타깃 상태'],
  loki: ['최근 에러 로그 보여줘', '특정 잡의 로그 볼륨 추이', '경고 이상 로그만 필터', 'OOM 관련 로그 찾기'],
  tempo: ['500ms 넘게 걸린 트레이스', '에러가 난 트레이스', 'HTTP 500 응답 스팬', '가장 최근 트레이스'],
  // NL prompts go through the AI generator, which sees the cached schema — table-specific asks are
  // fine HERE (unlike the raw chips above, which must stay schema-agnostic).
  clickhouse: ['테이블 목록 보여줘', '데이터베이스 목록', '최근 1시간 스팬 수 (트레이스 테이블에서)', '서비스별 스팬 상위 10개'],
  jaeger: ['frontend 서비스 최근 트레이스', '에러 태그가 붙은 트레이스', '1초 넘게 걸린 요청', '특정 오퍼레이션 트레이스'],
  dynatrace: ['호스트 CPU 사용률 평균', '서비스 응답시간 추이', '실패율이 높은 서비스', '메모리 사용률'],
  datadog: ['전체 CPU 사용률', '컨테이너별 CPU 사용', '메모리 사용량 추이', '로드 애버리지'],
};

/** kind → 표시용 쿼리 언어 이름 (결과 메타데이터 바, AI 생성 배너 — gap-audit L88/L200). */
export const QUERY_LANGUAGE: Record<string, string> = {
  prometheus: 'PromQL', mimir: 'PromQL', loki: 'LogQL', tempo: 'TraceQL',
  clickhouse: 'SQL', jaeger: 'Jaeger search', dynatrace: 'metricSelector', datadog: 'Datadog query',
};
