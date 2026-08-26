# 라이브러리 모듈 / Library Module

## 역할 / Role
API 라우트와 컴포넌트가 공유하는 도메인 로직 118개 모듈 (React 비의존 위주, `collectors/` 포함). 테스트는 vitest로 소스 옆 colocate.
(118 domain-logic modules shared by API routes and components, mostly React-free. Tests colocated, vitest.)

## 주요 파일 / Key Files
- `db.ts` — Aurora node-pg 공유 풀 `getPool()`: RDS IAM DB 인증(`awsops_web` 역할, master secret 아님). `password`를 함수로 전달해 커넥션마다 15분 토큰을 새로 서명 — 7일 secret 자동회전에 안전. `max: 3` (shared pool; IAM DB auth, per-connection fresh token)
- `auth.ts` — `verifyUser()`: `awsops_token` 쿠키 RS256 JWKS 재검증, alg 핀 + `token_use==='id'` (cookie re-verification)
- `aws-data.ts` — 챗 'aws-data' 라우트의 Steampipe SQL 계층: LLM SELECT 생성(자기교정 1회) → 라이브 실행(SELECT-only 가드, 200행 캡, 전용 소형 풀 `max: 2` + `statement_timeout: 35s` — 콜드 멀티 리전 와이드 스캔 실측 상향) → 행 기반 Bedrock 분석 스트림. **sonnet-5 응답은 thinking 블록으로 시작할 수 있음 — `content[0].text` 가정 금지, 텍스트 블록 전부 읽기.** 이력의 ⚠️ 시작 assistant 폴백 턴은 SQL 생성 컨텍스트에서 제외 — 모델이 "도구 불가"로 오도되는 이력 오염 방어 (LLM-generated Steampipe SQL over a guarded dedicated pool; never assume content[0] is the text block; filter ⚠️ fallback turns out of history)
- `collectors/` — auto-collect 콜렉터 6종 레지스트리 (idle-scan, eks/db/msk-optimize, trace-analyze, incident). `COLLECTORS`에 등록 한 줄이면 챗 라우트가 추가된다 — chat/route.ts는 `collectorByKey` 단일 generic 분기 (registry-driven: one entry adds a chat route)
- `nfm.ts` / `dns-logs.ts` / `ip-inventory.ts` / `tgw.ts` / `vpce.ts` / `dx.ts` / `anfw.ts` / `anfw-logs.ts` / `sg-analysis.ts` — 라이브 AWS 쿼리 계층 공통 패턴: **TTL 4분 캐시 + in-flight promise dedupe** (동일 키 동시 요청은 실행 중 promise 공유). 리소스 부재 시 available:false / 온보딩 안내로 degrade (TTL cache + in-flight dedupe; honest degrade when the source is absent)
- 파일별 함정 (per-file traps): `nfm.ts` 라이브 조회 상한 1h (`NFM_MAX_RANGE_SEC` — API ValidationException 실측, 더 긴 기간은 수집 파이프라인 필요) · `dns-logs.ts` Logs Insights `parse` 서버측 집계 — `@message`는 원시 JSON 텍스트라 내부 따옴표가 `\"`로 이스케이프되어 있어 정규식이 이를 매칭해야 함 · `vpce.ts` Interface 엔드포인트 미사용(유휴 과금) 감지 — `AWS/PrivateLinkEndpoints` BytesProcessed 0/시리즈 부재 · `tgw.ts` TGW는 리전 리소스 — 소속 리전별 EC2 클라이언트 필수, 기본 리전만 쓰면 조용히 빈 결과 · `dx.ts` 호스티드(<1G) 커넥션은 커넥션 레벨 Bps 미발행 → VIF 레벨 메트릭 사용, `VirtualInterfaceUtilization*`은 퍼센트 발행(실측 검증), VIF 응답의 `authKey`/`customerRouterConfig`는 민감정보 — row에 싣지 않음 · `anfw.ts` AWS/NetworkFirewall 메트릭은 3-dim(AZ,Engine,FirewallName)과 EndpointName 포함 4-dim이 동시 발행 — 3-dim만 채택(합산 시 이중 집계), recv/bytes는 Engine=Stateless만(SFE 포워딩 분이 Stateful recv에 중복 발행), Passed/Dropped/Rejected는 최종 처분 엔진에서 한 번만 발행돼 엔진 합산 유지(recv/bytes와 반대 계약이니 혼동 주의), 룰 그룹 룰 본문(RulesSource)은 응답에 미탑재 — 단 sid/msg/action은 서버 측 파싱해 룰 히트 카운트 조인에 사용(2026-08 신기능은 신규 API가 아니라 Alert 로그 집계, pass 룰은 로그 미발생이라 집계 불가, SID는 룰 그룹 단위 유일이라 조인은 (룰그룹,sid) 행 단위) · `anfw-logs.ts` Alert/Flow 로그는 CWL 대상만 Insights 집계(EVE JSON 도트 표기), 로깅 구성 조회 거부 시 /aws/network-firewall 접두사 발견 폴백 · `sg-analysis.ts` 사용 유무=ENI Groups 부착+SG 상호참조(둘 다 0=미사용), 소스/목적지=sg참조→이름·CIDR→VPC이름·0.0.0.0/0→인터넷·pl→프리픽스리스트명, 히트 매칭=Flow Logs(CWL, 기본 포맷 parse, dstaddr∈자기IP 인바운드만 — 아웃바운드 레코드 오매칭 방지) **(dstaddr,dstport,protocol) 튜플 매칭 — 룰-레벨 "정확" 산출 아님**: 같은 ENI에 SG가 여러 개거나 인바운드 룰이 겹치면 실제로는 다른 SG/룰이 허용한 트래픽이 이 룰의 히트로 잡힐 수 있음(과대추정 방향 — 거짓 idle 억제엔 유리하나 숫자 자체를 정밀한 룰 귀속으로 오독하면 안 됨, UI에 caveat 노출), NFM 폴백은 **상대 식별 전용**(양방향 바이트 집계라 룰 귀속 불가 — hits=null로 거짓 idle 억제, 전 7카테고리), pl/IPv6 CIDR/ICMP(type·code가 FromPort/ToPort라 dstport 비교 무의미) 룰과 스캔 범위 밖 참조 SG는 hits=n/a, `?regions=`로 페이지 스코프만 스캔(스코프별 detailCache 분리), detailCache는 build-then-swap(재실행 중 빈 구간 방지), classifyEni는 ip-inventory에서 재사용
- `dx-topology.ts` — DX 구성도 그래프 빌더 + SLA 복원력 판정 + dagre 레이아웃 (순수, dxAnalysis 데이터만 사용 — 추가 AWS 호출 없음). 함정: VIF의 `connectionId`는 LAG id(dxlag-)일 수 있음 — 노드 존재 확인 후 엣지 연결, SLA 티어는 sample-network-resilience-agent 규칙(Maximum=2로케이션×각2커넥션) (DX topology graph + SLA tier, pure)
- `i18n.ts` — `SUPPORTED_LANGS = ['ko','en','zh','ja']`가 single source of truth. 컴파일이 못 잡는 수동 lockstep 3곳: `agent/agent.py` 언어 지시문 맵, `bedrock-direct.ts` lang ternary, `components/inventory/metrics/guides.<lang>.tsx` (hand-maintained lockstep sites)
- `i18n-terms.ts` — `tt(label)`: 한국어 리터럴이 source 문자열, 미등록 문자열은 그대로 통과 (zero-risk fallback). 파라미터 패턴은 RULES 경유
- `eks-incluster.ts` — K8s API 직접 호출 (`aws eks get-token` 재현, P1e Access Entry + AdminViewPolicy). **read-only 불변식: GET만, write verb 절대 발행 금지.** 요청당 4s 타임아웃, AssumeRole 50분 캐시 (read-only invariant: GET only, never a write verb)
- `inventory-types.ts` — 인벤토리 타입 레지스트리(`InvType` spec — DetailPanel `sections`의 근거) (inventory type registry)
- `jobs.ts` — 워커 잡 생성/조회 (`worker_jobs` + SQS enqueue)
- `changelog.ts` — 사이드바 버전 칩 + 변경 이력 모달의 데이터 계층 (서버 전용, fs). **단일 진실 = repo 루트 `CHANGELOG.md`** — deploy.mjs가 빌드 직전 이미지로 복사(`/app/CHANGELOG.md`), 로컬 dev는 `../CHANGELOG.md` 폴백. 이중언어(# English / # 한국어) (the root CHANGELOG.md file is the single source of truth)
- `ssrf-guard.ts` — 외부 datasource 호출 SSRF 방어 (SSRF guard for external calls)

## 규칙 / Rules
- 새 라이브 AWS 쿼리 계층은 `nfm.ts`의 TTL 캐시 + in-flight dedupe 패턴을 복제한다.
- 언어 추가/변경은 `SUPPORTED_LANGS`부터 — TS 소비처는 컴파일로 깨지지만, 위 lockstep 3곳은 수동 갱신 필수.
- DB 접근은 반드시 `getPool()` 경유 — 풀 신규 생성·master secret 사용 금지.
