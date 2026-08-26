# 챗 토폴로지/미사용-리소스 역량 복원 + 자동 라우팅 (설계)

> 발단: 사용자가 "토폴로지에서 미사용 리소스(빈 origin, 등록 없는 TG)를 추려줘"라고 물었으나
> 앱 챗이 (1) "/data로 가세요"라고 떠넘기고 (2) 존재하지 않는 "Infra 에이전트"를 환각.
> 사용자 진단: **"v1은 steampipe로 잘 답했는데 v2로 오며 인벤토리를 Aurora로 옮겼고, 그 Aurora
> 토폴로지 데이터를 AgentCore에 연결하는 MCP를 안 만들어서 에이전트가 눈이 멀었다."** — 정확함.

## 근본 원인 (코드 근거)
1. **역량 공백**: v2 어떤 게이트웨이에도 ELB/TG/CloudFront/미사용-리소스 조회 도구가 없음.
   - v1 ops = `run_steampipe_query`(라이브 Steampipe) → v2 ops = `core_helpers`(정적 2도구, 라이브 조회 불가).
   - 토폴로지 데이터는 Aurora `inventory_resources` + `topology_nodes/edges`(ADR-043 그래프)에만 존재 → AgentCore 미연결.
2. **라우팅 공백**: `lib/route.ts` 정규식·`lib/classifier.ts` 카테고리에 토폴로지/elb/alb/nlb/target group/cloudfront/origin/미사용 단어가 전무 → 결정론 fast-path miss → 약한 Haiku 분류기가 data로 오분류.
3. **떠넘김 안티패턴**: 라우팅이 비활성 섹션(ops 등)에 닿으면 `lib/assistant.ts` 폴백이 "어느 섹션 에이전트에게 물어보라"고 안내(=v1식 게이트웨이 이동). 메인 챗이 자동 라우팅 후 직접 답해야 함.
4. **환각 무방지**: `agent/agent.py` COMMON_FOOTER에 실제 에이전트 로스터도, "이름 지어내지 말 것" 규칙도 없음.

## 데이터 모델 (확정)
- `inventory_resources(resource_type, account_id, region, resource_id, data JSONB, captured_at)` — 22개 타입 동기화.
  - `target_group.data.target_health_descriptions[].TargetHealth.State` ✅ (health 판정 가능)
  - `cloudfront.data.origins[].DomainName`, `alb/nlb` 등 ✅
- `topology_nodes/topology_edges(class[flow|infra], source, target, rel[ORIGIN|TARGETS|ROUTES_TO|PROTECTED_BY])` — CF→LB→TG→target 그래프 materialized (`buildFlowGraph`/`buildInfraGraph`).
- 연결: 신규 Lambda는 **VPC 연결 + pg8000 + Aurora master secret**(진단 워커 `scripts/v2/workers/db.py`와 동일). RDS Data API는 비활성이므로 미사용.

## 워크스트림 (5)
### WS1 — 신규 read-only MCP Lambda `inventory_read_mcp.py` (역량 핵심)
ops 게이트웨이, VPC-attached, pg8000→Aurora. 도구:
- `find_unused_resources(category?)` — 고아 TG(LB미연결/등록0/healthy0), 빈 CF origin(ORIGIN→LB에 healthy 타깃 없음), 리스너 없는 LB, 미연결 EBS/EIP/ENI, 미참조 SG. `inventory_resources`+`topology_edges`에서 파생.
- `query_inventory(resource_type?, filters?, limit?)` — 동기화 리소스 목록/필터 (v1 run_steampipe_query 등가의 "리소스 현황").
- `get_topology(resource_id?)` — CF→LB→TG→target 체인을 topology 그래프에서.
- `inventory_summary()` — 타입별 카운트 + 동기화 신선도(`inventory_sync_runs`).
- 순수 파생 로직은 별도 함수로 분리 → fixture로 TDD(생 boto3/DB 없이).

### WS2 — 배선 (catalog + terraform + provision)
- `catalog.py`: `inventory-read-target` → ops 게이트웨이.
- `ai.tf`: lambda `inventory-read`(vpc_config — 진단워커식 private subnet + Aurora SG ingress) + env(AURORA_ENDPOINT/DATABASE/SECRET_ARN) + IAM(secretsmanager:GetSecretValue Aurora secret).
- `make agentcore`로 새 target provision (멱등).

### WS3 — 라우팅 보강 (web)
- `lib/route.ts`: 신규 **ops 규칙**(미사용|unused|orphan|고아|인벤토리|inventory|리소스 현황/목록/정리|토폴로지|topology|origin|\btg\b|미연결|unattached|미할당) + network에 LB/CF 명사(로드밸런서|load balancer|elb|alb|nlb|target group|cloudfront|리스너|listener).
- `lib/classifier.ts`: ops/network 카테고리 설명 보강(ELB/ALB/NLB/target group/CloudFront/topology/unused/orphaned).

### WS4 — 자동 답변 (떠넘김 제거)
- `lib/assistant.ts` SYSTEM: "어느 섹션에 물어보라"는 안내 제거. 제품 사용법만 답하고, AWS-데이터 질의는 라우터가 활성 게이트웨이로 자동 호출.
- `app/api/chat/route.ts`: 비활성 섹션에 닿으면 떠넘김 대신 최적 활성 게이트웨이로 재라우팅(또는 ops 활성화로 자연 해소).
- `lib/sections.ts`: **ops `active: true`** (WS1 도구 배포 후 최종 스위치).

### WS5 — 에이전트 정직성 (agent.py)
- COMMON_FOOTER: 실제 8섹션 로스터 + "에이전트 이름을 지어내지 말 것; 도구 없으면 솔직히 말하고 라우터가 처리한다고 안내."
- ops SKILL_BASE 프롬프트: 토폴로지/미사용 의사결정 패턴(`find_unused_resources`/`get_topology`/`query_inventory`).

## 구현 순서 (TDD, 의존성 순)
1. WS1 Lambda 파생 로직 + Python 테스트(fixture).
2. WS5 agent.py 프롬프트.
3. WS3 route.ts/classifier.ts + 테스트.
4. WS4 assistant.ts/route.ts + 테스트.
5. WS2 terraform/catalog (배선).
6. WS4 ops active:true (최종 스위치).

## 배포 계획
- `make deploy` (web: WS3/WS4) — terraform 불필요.
- **terraform apply (공유 인프라 → 컨트롤러/사용자가 `!`로 실행)**: 신규 lambda + VPC + IAM (WS2).
- `make agentcore` (새 target provision) → `make deploy` (ops 활성화 반영).
- 스모크: 챗에 동일 질문 → 떠넘김/환각 없이 `find_unused_resources` 호출해 답변.

## 리스크
- VPC Lambda 콜드스타트 + Aurora 연결(진단워커 검증됨). · 신선도: 동기화가 오래되면 답에 captured_at 명시.
- ops 활성화는 도구 배포 후에만(아니면 dead-end 재현). · 라우팅 이중매칭 → LLM 폴백(허용).
- read-only 불변식 준수(WS 전부 describe/SELECT만; 변경 없음).
