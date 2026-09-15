# API 레퍼런스 / API Reference

## 역할 / Role
`web/app/api/**/route.ts` 경로 인덱스 — 경로·메서드·역할·인증.
(API route index under `web/app/api` — path, methods, role, auth.)
- 인증 컬럼: `verifyUser` = Cognito `awsops_token` 쿠키 검증(`@/lib/auth`). `없음` = 라우트 자체 비게이트(엣지 Lambda@Edge 게이트는 별도). 역할에 "admin"이 있으면 `isAdmin` 추가 게이트.
- 모든 라우트는 루트 경로(`/api/*`) — basePath 없음. web은 thin-BFF: 도메인 작업은 소유권을 검사하는 전용 라우트로 enqueue하며, 일반 `POST /api/jobs`는 허용된 noop 종류만 받는다.

## auth (2)
| 경로 | 메서드 | 역할 | 인증 |
|------|--------|------|------|
| `/api/auth/login` | POST | 자체 `/login` 폼 BFF — 무서명 Cognito `InitiateAuth` → `awsops_token` 쿠키 발급 (`lib/login.ts`) | 없음 (로그인 진입점) |
| `/api/auth/signout` | POST | 로그아웃 — HttpOnly 쿠키 서버측 만료. 의도적 비게이트(만료 토큰도 로그아웃 가능해야 함) | 없음 |

## chat (4)
| 경로 | 메서드 | 역할 | 인증 |
|------|--------|------|------|
| `/api/chat` | POST | AI 챗 — 분류기 → 게이트웨이/Code Interpreter/Bedrock direct 라우팅, SSE 스트리밍 | verifyUser |
| `/api/chat/stats` | GET | AI 호출 운영 통계 (게이트웨이별 호출량/성공률/평균 지연, `agentcore_stats` 집계) | verifyUser |
| `/api/chat/threads` | GET, DELETE | 대화 스레드 목록/검색(`?q=` 본인 메시지 substring) + 전체 삭제 | verifyUser |
| `/api/chat/threads/[id]` | GET, DELETE | 스레드 단건 조회/삭제 (사용자별 분리) | verifyUser |

## inventory (8)
| 경로 | 메서드 | 역할 | 인증 |
|------|--------|------|------|
| `/api/inventory/[type]` | GET | 인벤토리 리소스 목록 — `iam_user`/`iam_role`은 admin 전용; `ecs_cluster`는 MTD 비용(CE) 병합 기본, `?cost=0`으로 생략(비용 미표시 소비자용); `?view=agg`는 행 대신 전 플릿 집계(총계·state/dist/facet GROUP BY, 동일 스코프·게이트; 클라이언트 파생 키 차원은 제외되어 표본 유지, 버킷 상한 50) 반환 | verifyUser |
| `/api/inventory/[type]/metrics` | GET | 보조 KPI 카드 (CloudWatch/Pricing) + `?ids=`/`?nodes=` 타입별 라이브 진단 플릿(ec2/rds/alb/nlb/s3/transit_gateway/lambda/ebs_volume/dynamodb/elasticache/opensearch/msk) — 실패 시 `{cards:[]}`로 조용히 degrade | verifyUser |
| `/api/inventory/[type]/refresh` | POST | warm Steampipe → Aurora sync 트리거 + 첫 페이지 반환 (락 중이면 `busy`); admin 전용. `type=all`은 sync Lambda의 type=all fan-out을 1회 dispatch(행 미반환, `{status:'queued',dispatched:'all'}`; sync 비활성 시 503 `unconfigured`, enqueue 실패 시 503 `error`) | verifyUser |
| `/api/inventory/cloudtrail/events` | GET | CloudTrail `LookupEvents` 조회 — 드릴다운(`raw`+`accessKeyId`)은 admin 전용 subset, 그 외 사용자는 flat 필드만 | verifyUser |
| `/api/inventory/ebs_volume/related` | GET | 볼륨 드릴다운 — 스냅샷 20개 + 연결 EC2 enrichment (Aurora 교차조회, 계정 스코프) | verifyUser |
| `/api/inventory/security_group/inbound` | GET | SG 인바운드 규칙 체이닝 — 첨부 SG(≤20)의 인바운드 규칙 파싱 (Aurora 교차조회, 계정 스코프) | verifyUser |
| `/api/inventory/summary` | GET | Default returns account/region-filtered resource counts and security splits plus `collection`. `?view=collection` returns only `{ collection }`, skipping fleet aggregation. `collection.scope=aggregate` is the job-level ledger and is not narrowed by those filters; missing, failed and unknown evidence remains explicit and does not establish per-account health. | verifyUser |
| `/api/inventory/trend` | GET | 일별 리소스 카운트 추세 (`inventory_snapshots`, 기본 14일/최대 90일) — `accounts` 스코프(기본 self, `__all__`은 서버에서 self+스캔 스코프 내 활성 멤버[all_regions 또는 활성 리전 ≥1]로 해석, 검증된 CSV; 리전 차원 없음) + (일자, 타입)별 계정 커버리지·해석된 계정 목록(`accounts`)·계정 레지스트리 조회 실패 시 `degraded: true` 반환, 파생 보안 시리즈(public_s3_buckets 등)는 total에서 제외 | verifyUser |

### Inventory pagination and sweep ledger

In normal row mode, `GET /api/inventory/[type]` returns scoped `rows` plus nullable
`run` metadata. `limit` defaults to 100 and is upper-capped at 500; `offset` defaults
to 0. The route uses numeric coercion/defaults, without positive/integer validation
or a lower-bound clamp. Callers should send a positive integer limit and nonnegative
integer offset; negative/fractional values can reach PostgreSQL, with row-mode errors
returned as HTTP 500 and an error message rather than a validation 400.

`?view=agg` instead returns totals, state/distribution counts and facets, without
`rows` or `run`. Both modes retain authentication, type-specific admin checks and
the same account/region/global scope filters.

The normal-mode `run` is global per-type job/sweep metadata under `account_id='self'`,
including for member/all-account reads; its `row_count` is not the selected-scope
or page count. The collector marks the job `running` before row writes. A successful
finish advances `finished_at` and `last_success_at`; partial/failed finishes do not
advance the last-success timestamp. The endpoint exposes `status`, `finished_at`,
`row_count`, `error` and `last_success_at`, not a per-account completion certificate.

Rows and run metadata are separate reads, not an atomic snapshot across one request
or multiple pages. Missing run/timestamps, `running`/`partial`/`failed`, stale last
success or changed metadata between pages must not be read as fresh complete coverage.
Even stable successful metadata does not certify atomic page contents or AWS absence.
Bounded paging, freshness and coverage decisions belong to the caller.

Source: [inventory route](../web/app/api/inventory/[type]/route.ts),
[row/ledger reads](../web/lib/inventory.ts), and
[collector lifecycle](../scripts/v2/steampipe/sync_lambda.py).

## eks (10)
| 경로 | 메서드 | 역할 | 인증 |
|------|--------|------|------|
| `/api/eks` | GET | 클러스터 목록 + 접근 상태(Access Entry 여부, 온보딩 가이드) | verifyUser |
| `/api/eks/fleet` | GET | 전 클러스터 서버측 라이브 집계 — raw pod row 미전송, 클러스터별 실패는 `reachable:false` | verifyUser |
| `/api/eks/node-eni` | GET | 인스턴스 타입별 ENI당 IPv4 한도 (미등재 타입 15 폴백) | verifyUser |
| `/api/eks/summary` | GET | v1 K8s-Overview 패리티 — 연결 클러스터 라이브 카운트 (실패는 0으로 degrade, 500 금지) | verifyUser |
| `/api/eks/[cluster]/incluster` | GET | in-cluster 리소스 목록 (`?kind=`, 클러스터 allowlist) | verifyUser |
| `/api/eks/[cluster]/incluster/describe` | GET | 단일 오브젝트 describe (K9s 패리티, secrets는 Kind 불가) | verifyUser |
| `/api/eks/[cluster]/k8sgpt` | GET | K8sGPT read-only 진단 (ADR-006[legacy 035]) — admin + 클러스터 allowlist | verifyUser |
| `/api/eks/[cluster]/metrics` | GET | 컨트롤플레인 + ContainerInsights CloudWatch 메트릭 | verifyUser |
| `/api/eks/[cluster]/pod-transfer` | GET | NFM 파드 전송 쿼리 (최대 1h 윈도우) | verifyUser |
| `/api/eks/[cluster]/register` | POST, DELETE | 클러스터 등록/해제 (admin, EKS 공식 이름 패턴 검증) | verifyUser |

### EKS enumeration metadata

The `/api/eks` envelope includes `region` and `truncated` for the bounded web enumeration.
`region` remains present for an empty result. At most 25 clusters are described; continuation
means enumeration is incomplete. This does not enumerate other regions or prove pod ownership.
The envelope supplies enumeration evidence only. Array-only compatibility callers receive
no completeness metadata and must not treat a bounded array as an exhaustive fleet count.

## nfm (2)
| 경로 | 메서드 | 역할 | 인증 |
|------|--------|------|------|
| `/api/nfm` | GET | NFM 상태(메뉴 게이트) — 모니터 목록 + Scope 수; 모니터 없으면 온보딩 안내로 degrade | verifyUser |
| `/api/nfm/query` | GET | NFM 모니터 쿼리 — 최대 1시간 윈도우 (초과 시 API ValidationException) | verifyUser |

### NFM observation metadata

Successful `/api/nfm/query` responses retain `monitor`, `metric`, `category`, `range`,
`rows`, `unit` and `tookMs`, and include:

| Field | Meaning |
|---|---|
| `startTime`, `endTime` | ISO query bounds sent to NFM; preserved unchanged on a four-minute cache hit. |
| `queriedAt` | Result assembly time, also preserved on cache hits; not the current HTTP request time. |
| `capped` | The contributor limit was reached or a continuation token remained. More rows may exist. |

These are query bounds and truncation signals, not proof of complete traffic coverage.
The route owns `RANGE_ALLOWED` (900/1800/3600 seconds); an unsupported or omitted range
uses its existing 3600-second default. Metric/category allowlists remain in `nfm.ts`.

The standalone `topology-observations.ts` loader is **unwired until topology integration**.
Its `NetworkBatch` is a client result, not additional HTTP response fields: it carries
failed/capped categories, `complete`/`partial` status and per-category `verified`/`unknown`
window quality. `verified` means parseable, ordered bounds only. Failures use closed codes
(`query_failed`, `malformed_payload`, `malformed_rows`, `invalid_request`) without raw
upstream error text. Missing/invalid windows remain unknown and make the batch partial.
At most three workers bound category concurrency; cancellation stops further scheduling and result
application, without guaranteeing cancellation of a server query already started.

## dns-logs (2)
| 경로 | 메서드 | 역할 | 인증 |
|------|--------|------|------|
| `/api/dns-logs` | GET | Resolver query-log 설정 상태(메뉴 게이트) — 미설정/무권한도 200 + 빈 configs | verifyUser |
| `/api/dns-logs/analytics` | GET | Resolver 로그 집계 분석 (Logs Insights 병렬 폴링, `maxDuration` 60s, group은 라이브 allowlist 검증) | verifyUser |

## sg (1)
| 경로 | 메서드 | 역할 | 인증 |
|------|--------|------|------|
| `/api/sg` | GET | Security Group 사용 분석(ENI 부착+상호참조 미사용 감지, 룰 소스/목적지 식별). `?regions=`로 리전 스코핑(안 주면 인벤토리 전 리전). `?view=hits&id=sg-...` 트래픽 히트 매칭 — Flow Logs 우선(ACCEPT만 룰 귀속), NFM 폴백은 **상대 식별 전용**(양방향 집계라 룰 귀속 불가, hits=null) | verifyUser |

## anfw (1)
| 경로 | 메서드 | 역할 | 인증 |
|------|--------|------|------|
| `/api/anfw` | GET | Network Firewall 방화벽/정책/룰그룹 목록+분석 — 인벤토리 VPC 리전 fan-out, 트래픽·드롭 집계, 보호/로깅/전량 통과 기본/룰 용량 (룰 본문은 미탑재, `statefulSids`로 sid/msg/action/`noalert`만 파싱해 노출 — `noalert`는 alert/drop이어도 로그를 남기지 않는 룰이라 UI가 pass와 동일하게 취급). 도메인 리스트(`STATEFUL_DOMAIN`) 등 SID를 파싱할 수 없는 룰그룹은 `sidsUnparseable=true`(그 그룹이 참조되면 계정 전체 SID 귀속을 불신하게 만드는 신호 — 정책의 참조는 전체 ARN으로 대조한다: `ListRuleGroups`는 계정 소유 그룹만 열거해 이름만으로 대조하면 같은 리전의 관리형 그룹과 이름이 같은 계정 소유 그룹이 우연히 있을 때 관리형 참조를 놓친다). 어느 정책이든, 또는 어느 STATELESS 아닌(즉 STATEFUL/STATEFUL_DOMAIN/미확인 `?`) 룰 그룹이든 `lastModified`가 range 시작 이후(또는 `null`, 즉 확인 불가)면 UI는 계정 전체 SID 귀속을 불신 처리한다(정책 전용 규칙을 룰 그룹 자체의 in-place 수정에도 동일하게 확장: 삭제/재정의된 SID는 현재 토폴로지로 열거할 수 없어 지역적 taint로는 대체 불가하다). 로깅 구성 조회가 거부돼 접두사 발견(discovered)으로 ALERT 로그 그룹을 찾은 리전이 하나라도 있으면 동일하게 계정 전체를 불신 처리한다 — 그 리전은 방화벽/룰그룹 토폴로지를 확인할 수 없는데도 그 히트는 다른 리전과 똑같이 sid로 전역 병합되기 때문. `generatedAt`(ms epoch, 서버가 이 분석을 생성한 시각)은 UI가 룰그룹/정책의 `lastModified`를 range 시작과 비교할 때 브라우저 시계 대신 이 값을 기준으로 삼는다 — 클라이언트 시계 왜곡(특히 빠른 쪽)이 있으면 range 시작을 실제보다 늦게 계산해 mid-range 수정 가드가 fail-open할 수 있기 때문. `?view=logs` 응답의 `generatedAt`도 동일한 목적의 별도 값이다 — 이 두 뷰는 서로 독립된 4분 TTL 캐시라 시차가 날 수 있으므로, UI는 두 `generatedAt` 중 더 이른 쪽을 range 시작 기준으로 써야 한쪽만 캐시로 오래됐을 때도 mid-range 수정을 놓치지 않는다(단, 이 anchor는 로그 쪽이 더 오래된 캐시인 경우만 닫는다 — 토폴로지 쪽 fetch 자체가 오래된 캐시라면 그 안의 `lastModified`가 이미 스냅샷 시점 값이라 이후에 일어난 수정은 어느 anchor를 쓰든 다음 캐시 갱신 전까지는 보이지 않는다. 4분 TTL로 유효기간이 제한된 잔여 위험). **알려진 미해결 잔여 위험(문서화만 됨, 미해결)**: 방화벽이 range 도중 다른 정책으로 전환됐거나(어느 firewall이 어느 시점부터 그 정책을 썼는지 API에 없음), 방화벽 자체가 range 도중 **삭제**됐다면(`AnfwFirewallRow`에는 정책/룰그룹과 달리 `lastModified`가 원천적으로 없음 — `DescribeFirewall`이 반환하지 않음) 위 검사 전부를 통과한다 — 삭제된 방화벽의 로그 그룹과 히트는 여전히 존재해 다른 리전과 동일하게 sid로 전역 병합되기 때문. CloudTrail(`?view=audit`)의 `DeleteFirewall`/`DisassociateFirewallPolicy` 이벤트를 조인하면 닫을 수 있으나 아직 구현되지 않았다. `?range=`는 3600/21600/86400/604800 allowlist(그 외는 86400), `maxDuration` 60s, 상위 실패는 502. 부분 실패는 정직 강등: `degradedRegions`(firewalls/policies/ruleGroups 중 하나라도 List/Describe 실패 — 포괄 신호)·`firewallListDegradedRegions`(그 중 firewalls 자체만의 부분 실패로 좁힌 부분집합 — 로깅 구성을 확인 못 한 리전만 필요한 소비처용)·`metricsDegradedRegions`(CloudWatch 미순회/캡/쿼리 실패). `?view=logs` Alert/Flow 로그 Insights 집계(CWL 대상만). stateful 룰 히트 카운트(`ruleHits`, sid 단위로 미리 합산됨 — 튜플 단위로 자르지 않음)는 `alertRuleHits` 쿼리 실패·`alertTopNPartial`(어느 리전이든 로그 그룹 50개 초과로 청크 분할)·discovery unknown 시 `ruleHits=null`(빈 배열이 아님 — totalAlerts와 동일한 unknown≠0 계약); 최종 join 컷오프(100개 sid) 초과로 일부 sid가 누락됐을 수 있으면 `ruleHitsTruncated`; 어느 리전이든 리전별 상한(150개)에 도달해 present인 sid의 값 자체가 과소집계됐을 수 있으면 `ruleHitsPartial`(UI는 `≥N`으로 표기). UI는 이 시각적 절단 신호와 동일하게, 서빙 방화벽 중 일부만 ALERT 관측이 확인된(`observability === 'unknown'`) 룰의 양수 히트도 `≥N`으로 표기한다 — 관측 안 된 방화벽에서 발생한 매칭이 포함되지 않았을 수 있어서다. `alertCoverageComplete`(boolean, 계정 전체 단일 신호)는 사용된 모든 ALERT 로그 그룹의 `creationTime`/`retentionInDays`를 range 시작 시점과 비교한 것 — false는 "커버리지가 불완전함"과 "커버리지를 확인할 수 없음"(그룹을 못 찾음/`creationTime` 없음/데드라인 초과/`DescribeLogGroups` 거부됨— 이 페이지가 다른 곳에서 구분해 다루는 것과 같은 SCP 시나리오) 둘 다를 같은 값으로 뭉뚱그린다 — 두 경우 모두 `hits=0`을 확정 idle로 표시하지 않는 보수적 방향은 동일하지만, 원인이 하나가 아니다(단, 이 신호는 로그 그룹 메타데이터로부터의 추론일 뿐 — 같은 그룹에서 로깅이 range 중간에 껐다 켜졌다 했는지까지는 증명하지 않는다). `?view=audit`는 CloudTrail 변경 감사 | verifyUser |

## dx (1)
| 경로 | 메서드 | 역할 | 인증 |
|------|--------|------|------|
| `/api/dx` | GET | Direct Connect 커넥션/VIF/게이트웨이 목록+분석 — AWS/DX 메트릭 다운 감지·피크 사용률·BGP 라우트 가시성 (호스티드 <1G는 커넥션 레벨 Bps 미발행 → VIF 레벨). `locations[]`는 `available/down` owned·hosted의 확인된 위치/리전별 집계, `totals.locations`는 고유 위치명 수. 기타·미확인 상태는 원본 목록에 남지만 위치·상태·SLA 평가에서 제외·미평가로 고지하며 SLA는 owned만 대상. / Known deployed sites only; raw inventory remains available, excluded states are unassessed. 부분 실패는 정직 강등: `degradedRegions`·`metricsDegradedRegions`·`gatewaysDegraded`·행 단위 `associationsAvailable`·`totals.gatewaysAssociationsUnknown` | verifyUser |

## ip-inventory (1)
| 경로 | 메서드 | 역할 | 인증 |
|------|--------|------|------|
| `/api/ip-inventory` | GET | ENI 전량 + EIP + EKS 파드 IP 조인 (파드 맵 best-effort — 실패해도 ENI/EIP 반환) | verifyUser |

## tgw (1)
| 경로 | 메서드 | 역할 | 인증 |
|------|--------|------|------|
| `/api/tgw` | GET | Transit Gateway 상세 — 어태치먼트(+VPC 어태치먼트 options: DNS/IPv6/Appliance — VPC 타입만, 불완전 경로[조회 실패·페이지 캡 절단·미반환 VPC 행]는 optionsDegradedRegions로 공개, options만 누락) + 라우트 테이블(+라우트). `ids`는 `tgw-` 접두사만 통과, 인벤토리로 TGW별 소속 리전 해석 | verifyUser |

## vpce (1)
| 경로 | 메서드 | 역할 | 인증 |
|------|--------|------|------|
| `/api/vpce` | GET | VPC Endpoint 목록+분석 — 인벤토리 VPC 리전 fan-out + PrivateLink 메트릭 기반 미사용 감지 | verifyUser |

## 기타 (54)
| 경로 | 메서드 | 역할 | 인증 |
|------|--------|------|------|
| `/api/accounts` | GET, POST, PATCH, DELETE | 등록 계정 CRUD (admin) — POST는 role assume + `GetCallerIdentity` anti-spoof 검증 후 insert; 호스트 전용 모드의 외부 계정 POST는 409 / host-only foreign account POST returns 409 | verifyUser |
| `/api/accounts/regions` | GET, POST, DELETE | 계정별 리전 활성/비활성 (`'self'` → 호스트 실제 id 해석) — 조회 auth / 변경 admin | verifyUser |
| `/api/actions` | GET, POST | 액션 목록/생성 (ADR-007[legacy 040/041], admin) | verifyUser |
| `/api/actions/[id]` | GET, POST | 액션 상세/실행 (admin) — kill-switch 분기(integrations-write vs mutating-actions), 빈 이름 fail-closed | verifyUser |
| `/api/agentcore` | GET | AgentCore 컨트롤플레인 상태 (runtime/gateway/memory/interpreter, `?action=stats`) | verifyUser |
| `/api/ai-usage` | GET | 앱 Bedrock 토큰 비용 — `ai_usage_daily` SUM (스케줄 집계 산출물, 라이브 AWS 호출 없음) | verifyUser |
| `/api/bedrock-metrics` | GET | Bedrock 모델 사용 메트릭 — 단일 계정 라우트 (All accounts는 클라이언트 fan-out) | verifyUser |
| `/api/changelog` | GET | 사이드바 버전 칩 + 변경 이력 모달 데이터 — 저장소 `CHANGELOG.md`와 항상 일치 (배포된 커밋 = 표시 버전) | verifyUser |
| `/api/compliance/benchmarks` | GET | UI 셀렉터용 벤치마크 정적 allowlist | verifyUser |
| `/api/compliance/run` | POST | CIS 벤치마크 실행 enqueue — allowlist 검증 후 worker `compliance` job | verifyUser |
| `/api/compliance/runs` | GET | 실행 이력 목록 (`compliance_runs`) | verifyUser |
| `/api/compliance/runs/[id]` | GET | 실행 단건 상세 | verifyUser |
| `/api/cost` | GET | 비용 요약 — 기간 필터 `1m/3m/6m/12m` (미지정/오류 → 6개월) | verifyUser |
| `/api/cost/availability` | GET | Cost Explorer 가용성 probe (1h 캐시, `?force=1` 재확인) | verifyUser |
| `/api/cost/detail` | GET | 서비스별 비용 상세 (`?service=` 필수, ≤100자) | verifyUser |
| `/api/finops/findings` | GET | ADR-020 FinOps 기본 권장 엔진 — 미해결 findings + 최근 배치 실행(`finops_runs`) 조회, Aurora만 읽음(라이브 AWS 호출 없음). `finops_baseline_enabled=false`면 `{enabled:false, findings:[], lastRun:null}` | verifyUser |
| `/api/customization` | GET, POST, PUT | 스킬/에이전트 카탈로그 CRUD (ADR-004[legacy 031], admin) | verifyUser |
| `/api/datasources` | GET | 데이터소스 인스턴스 목록 — 크리덴셜 미노출 | verifyUser |
| `/api/datasources/generate` | POST | 자연어 → 쿼리 초안 생성 (리뷰용 — 절대 실행 안 함) | verifyUser |
| `/api/datasources/manage` | POST, PATCH | 인스턴스 생성/수정 + 크리덴셜 저장 (admin); `settings`(timeoutS 1–60[clickhouse 유효 최대 55]·clickhouse database)는 서버 측 sanitize 후 ds_settings JSONB에 저장 | verifyUser |
| `/api/datasources/query` | POST | 인스턴스 대상 read-only 쿼리 실행 (admin 아님 — 탐색용) | verifyUser |
| `/api/datasources/test` | POST | 저장 전 연결 probe — SSRF 가드 (admin) | verifyUser |
| `/api/datasources/[id]` | DELETE | 인스턴스 삭제 — 스키마 캐시/크리덴셜 cascade, 기본값 재선정 (admin) | verifyUser |
| `/api/datasources/[id]/cards` | GET | 사전 생성 대시보드 카드 조회 (read-only, auth) | verifyUser |
| `/api/datasources/[id]/default` | POST | kind별 기본 인스턴스 지정 — 트랜잭션으로 기존 기본 해제 (admin) | verifyUser |
| `/api/datasources/[id]/diag-signals` | GET | 사전 정의 진단 시그널 — Explore 칩 (DB read only, egress 없음). kind 범위: prometheus/mimir/loki 는 결정론 카탈로그, clickhouse 는 결정론 엔트리가 없어 폴백 전용. tempo 는 `tags_or_services` matcher 가 introspect 된 어떤 스키마에도 매칭되어 항상 ready 이므로 폴백에 도달하지 않는다. **LLM 폴백(`diag_signal_querygen_enabled`)은 clickhouse 전용이 아니다** — ready 0행인 *모든* 배선 kind 에서 발동하므로 라벨 미탐지로 0행이 된 loki 인스턴스의 칩에도 `provenance='generated'` 가 섞일 수 있다(리뷰 MAJOR-9). 생성 행은 칩 전용 — 리포트 경로 제외, 플래그 OFF 면 read 에서도 제외. jaeger/dynatrace/datadog 는 아직 배선 없음(빈 응답) | verifyUser |
| `/api/db` | GET | Aurora ping — success returns `status: "ok"`, `public_tables` and UTC ISO `server_time` from the same table-count/`clock_timestamp()` SELECT; unset `AURORA_ENDPOINT` remains 503 and database errors remain generic 500 responses | CloudFront edge authentication; BFF `verifyUser()` omitted (ADR-002 §2-4) |
| `/api/diagnosis` | GET, POST | AI 종합진단 리포트 목록/생성 — worker enqueue + 멱등키 | verifyUser |
| `/api/diagnosis/intent` | GET, POST | Plan-2 Intent Engine — `architecture_intent` 조회(auth) + 쓰기(admin) | verifyUser |
| `/api/diagnosis/schedule` | GET, PUT | 사용자별 자동 진단 스케줄 — row read/write만 (실행은 worker `schedule_dispatcher`) | verifyUser |
| `/api/diagnosis/subscribers` | GET, POST, DELETE | 진단 완료 메일링 리스트 (SNS) — 조회 auth / 변경 admin | verifyUser |
| `/api/diagnosis/notify` | GET, PUT | 알림 일시중지 토글 — GET 상태 조회 / PUT admin 전용 upsert (app_settings) | verifyUser (+PUT isAdmin) |
| `/api/diagnosis/subscribers/test` | POST | 진단 알림 테스트 발송 — 토픽 한정 SNS Publish 1건 (admin 전용) | verifyUser |
| `/api/diagnosis/[id]` | GET, PATCH, DELETE | 리포트 단건 조회/수정/삭제 | verifyUser |
| `/api/diagnosis/[id]/download` | GET | 산출물(md/docx/pdf) S3 프록시 다운로드 (presign 아님) | verifyUser |
| `/api/graph` | GET | 읽기 전용 토폴로지 그래프 — class `flow\|infra\|trace`, `?from=`으로 서브그래프. 모든 class는 `collection` 수집·보존 상태를 노출하며, `trace`는 관측 edge count를 함께 제공. 큐 `meta.claimedAccountId/claimedRegion`은 보존된 행도 destination ARN에서만 재계산하고 비-ARN/누락 한정자는 null; `identityProvenance=telemetry_claim` 고정, 호출자 폴백·AWS 인벤토리 bridge 없음. 동일 ARN은 데이터소스·환경 안에서만 호출자 간 연결. / Queue claims derive only from destination ARNs; unverified, scoped by datasource/environment, never inventory authority. [계약·배포 / Contract and rollout](runbooks/source-sync-observability.md) | verifyUser |
| `/api/health` | GET | 헬스체크 — 컨테이너/타깃그룹 health 경로와 일치 필수 | 없음 (공개) |
| `/api/incidents` | GET, POST | 인시던트 목록 + 수동 트리거 (ADR-006[legacy 032], admin) | verifyUser |
| `/api/incidents/prevention` | GET | 교차 인시던트 예방 인사이트 (admin, read-only) — Aurora 미설정/실패도 200 + 빈 목록 | verifyUser |
| `/api/incidents/webhook` | POST | 인시던트 ingress — HMAC 서명 웹훅 (ADR-022 active/standby 로테이션) | 없음 (HMAC 검증) |
| `/api/incidents/[id]` | GET | 인시던트 상세 (admin, read-only, UUID 가드) | verifyUser |
| `/api/insights` | GET | Overview용 최신 캐시 AI 인사이트 (DB read only) | verifyUser |
| `/api/insights/refresh` | POST | AI 인사이트 재생성 enqueue (admin) — 플래그 off 시 fail-closed, 중복 job dedup | verifyUser |
| `/api/integrations` | GET, POST, PUT | 통합 등록 — egress 커넥터 + ingress 웹훅 소스 (ADR-007[legacy 039], admin, SSRF 가드) | verifyUser |
| `/api/integrations/credential` | GET, PUT | 통합 크리덴셜 저장 — 단일 Secrets Manager secret에 slug(kind) 키 (admin) | verifyUser |
| `/api/integrations/schema` | GET, POST | 인스턴스 스키마 introspect/캐시 (admin) | verifyUser |
| `/api/deployment/readiness` | POST | 실제 웹 역할·SSM·AgentCore·인벤토리·모델 검증. nonce/account/known CloudFront 입력, no-store, 401/403/429/503. 프로세스당 단일 실행·60초 제한 / bounded deployment evidence | verifyUser + admin or deployment-verifiers |
| `/api/jobs` | GET, POST | 비동기 작업 enqueue/목록 (P2 — `worker_jobs` + SQS) | verifyUser |
| `/api/jobs/[id]` | GET | 작업 상태 단건 조회 — UUID 검증 + 소유자 또는 관리자 / owner-or-admin | verifyUser |
| `/api/jobs/observability` | GET | 접수 기간별 작업 시간·완료 목표: `windowHours` 1–168, 선택적 `type` 및 `targetMs` 1–86400000. 소유자/관리자 범위, 최대 2000건 표본·최근 50건 상세, 누락·잘림 시 미확정 / ownership-scoped workload observations | verifyUser |
| `/api/me` | GET | 현재 사용자 + `isAdmin` 시그널 (UI 표시용 — 쓰기 게이트는 서버측 별도 유지) | verifyUser |
| `/api/monitoring` | GET | 모니터링 허브 — `?tab=ec2\|rds` 플릿, `?series=`+`range`로 단일 리소스 시계열 | verifyUser |
| `/api/opencost/[cluster]` | GET, PUT | OpenCost 저장 설정 — 조회 auth / 저장 admin (null = 미저장, 페이지가 기본값 사용) | verifyUser |
| `/api/opencost/[cluster]/allocation` | GET | 1-day allocation — KPI + 파드별 비용, degrade-safe | verifyUser |
| `/api/opencost/[cluster]/bundle` | GET | 설치 번들(values.yaml + install.sh) 다운로드 — 사용자가 out-of-band 실행 (read-only) | verifyUser |
| `/api/opencost/[cluster]/status` | GET | 설치 상태 배지 — 403/에러도 200 `{installed:false, reason}` | verifyUser |
| `/api/overview` | GET | 대시보드 Overview 집계 — jobs/compliance는 계정 무관(Aurora 앱 레벨) | verifyUser |
| `/api/security` | GET | 보안 findings (`inventory_resources` 파생, read-only) + ECR 이미지 스캔 CVE(라이브, 실패 시 빈 탭) — `accounts` 파라미터 해석(`__all__` 포함) | verifyUser |
| `/api/security/refresh` | POST | 보안 관련 인벤토리 타입 재동기화 | verifyUser |
| `/api/stream` | GET | SSE 스트림 | 없음 |


## Configuration topology inventory evidence

`/api/inventory/{type}` returns scoped row captures and a self-keyed `run` describing
an aggregate sweep across connected accounts. The configuration page labels aggregate
status under every account scope, separately from inventory read failures. A successful
sweep is not per-account health proof; member clocks never borrow aggregate last-success.
Only RUNNING ECS tasks with subnet/VPC corroboration establish current IP ownership.
Ordinary EKS pod-IP ambiguity removes attribution without implying a failed read.
EKS evidence is limited to connected clusters returned in `/api/eks`'s configured
`region`; other regions are not assessed. Listed `entry-only`/`no-entry` clusters are
counted as not queried, independently of read failure/truncation. Inventory reads apply
account selection only. Failed HTTP reads do not synthesize unknown aggregate status.

## Collection disclosure (including trace)

The `GraphCollection` / `GraphCollectionSource` TypeScript contract is defined in
`web/components/topology/GraphCollectionStatus.tsx`; runtime input is still normalized.
Trace `sources[].windowStartMs/windowEndMs` identify the source query window, separately
from top-level `attempted_at/captured_at` and optional source capture/last-success clocks.
Positive `nodeDrops/edgeDrops/orphanSpans/invalidSpans/unresolvedMessaging` and
`infraUnavailable` remain visible for older persisted envelopes as well as newer producer flags.
Only node/edge drops or explicit truncation flags imply a processing limit; malformed spans
and unresolved parent/link/messaging evidence are distinct partial-result causes. Losses alone do not prove retention:
`retainedPrevious` is required for that claim. Source-detail totals include saved sources, with latest-attempt status counts labeled separately.
Missing collection metadata stays unknown rather than implying collector failure.


## Graph collection metadata

`GET /api/graph` returns `collection` for flow, infra and trace. Older responses without it remain compatible as unknown evidence. The shared TypeScript
contract is `GraphCollection` / `GraphCollectionSource` in
`web/components/topology/GraphCollectionStatus.tsx`; the renderer also validates unknown
runtime payloads for compatibility with older or malformed responses.

| Fields | Meaning |
| --- | --- |
| `status`, `stale`, `retainedPrevious` | Collection result and snapshot age/retention; a retained graph does not establish current traffic. Missing metadata stays unknown. |
| `attempted_at`, `captured_at` | Latest graph attempt and saved publication clocks, serialized as timestamps; neither substitutes for the source query window. |
| `sources[].sourceId/status/reasons/itemCount` | Per-source collection result and bounded reason vocabulary. |
| `sources[].producerStatus/attemptedAtMs/finishedAtMs` | Underlying inventory job outcome and start/finish clocks; not graph publication time or per-account success proof. |
| `failureReason` | Bounded failure category: `publication_failed`, `source_read_failed`, `not_attempted`, or API-only `state_read_failed`. |
| `sourceAttempted` | Explicit false records a source read not attempted within the rebuild budget; it never changes the saved publication clock. |
| `metadataTruncated` | Stored or computed recognized-field omission/malformation marker, shared by HTTP and SQL projections and included in freshness decisions. |
| `coverage` | `unknown` for a flow/infra `__all__` union; host state cannot prove union coverage and top-level `captured_at` is null. Trace `__all__` reads the existing host storage scope. |
| `windowStartMs/windowEndMs` | Optional graph-attempt window, distinct from per-source query windows and saved publication time. |
| `sources[].windowStartMs/windowEndMs` | Actual trace query window, in epoch milliseconds; displayed independently of publication time. |
| `nodeDrops`, `edgeDrops`, `orphanSpans`, `invalidSpans`, `unresolvedMessaging`, `infraUnavailable` | Existing trace loss counters and unavailable inventory context; span/messaging problems are distinct from processing limits. Positive losses are visible even for older rows without newer truncation flags. Loss alone does not imply that a previous graph was retained. |
| `evidenceKind`, `inputTruncated`, `graphTruncated` | Evidence kind is derived from graph class; `inventory` changes empty-result wording. Producer truncation remains separate from API read truncation. |
| `readStatus`, `readReason`, `readTruncated` | API read availability/coverage, independent of collector status: `ok`, `partial` (`row_limit`), or `unavailable` (`busy`/`timeout`/`query_failed`). |
| `sources[].scope/capturedAtMs/lastSuccessAtMs`, `publishedSources[]` | Optional source scope/capture/sweep clocks and saved-source provenance used by the graph-publication companion. Absent fields are not fabricated. |

The UI supports the existing trace envelope and optional inventory/saved-source
fields emitted by the bounded publication implementation in `web/lib/graph-store.ts`.
Source integration does not establish successful producer rollout or migration. Source details are collapsed and height-bounded; their count
includes distinct displayed saved-source entries. Identical latest/saved details are shown once, with the saved-source heading and a localized “Same displayed source evidence as above.” note; differing and saved-only evidence remains visible. Runtime, Lambda and migration rollout remain separate
from source integration. See [collection semantics and rollout](runbooks/source-sync-observability.md).


Graph requests admit two transactions per shared pool, with 1.5s statement/idle and 2s total transaction limits (below the auth revocation budget). JSON serialization runs after commit and release. Class reads return at most 4000 nodes and 8000 raw edges, then deduplicate bounded edge evidence; edges reference returned nodes. A sentinel row discloses read truncation without claiming collection failure. Existing per-hop traversal caps remain.

A missing or failed state read remains unknown; `failureReason=state_read_failed` is shown separately. Saved-source provenance is visible whenever present, including stale successful publications. Producer start/finish/status and source/attempt windows are separate clocks. For legacy single-account flow/infra rows, top-level `captured_at` may retain the old row display clock; `collection.captured_at` remains null and no source freshness is inferred.

Excess graph requests return HTTP 503, other read failures HTTP 500, with fixed `message="Graph read failed"`, class/account and unknown collection/read-unavailable metadata. Raw database messages are never returned. See [request/rollout details](runbooks/graph-read-contract.md).


All three graph pages render collection/read errors, parse safe non-2xx envelopes, abort superseded fetches and provide refresh. A shed request includes Retry-After: 1 and a fixed server-side shed diagnostic. Timeout SQLSTATEs (57014/25P03/25P04/55P03) produce readReason=timeout; they never imply empty collection or successful partial publication. Requested subgraph roots are prioritized before the node cap; fan-out capped and readTruncated remain distinct.

HTTP collection details use the same bounded key/status/reason vocabulary as the SQL-reader view: raw/private keys and injected read/coverage fields are excluded. Source arrays are capped at 128 and reason lists at 16; metadataTruncated discloses omitted/malformed metadata separately from graph row truncation. Safe null source clocks remain unknown for compatibility.

The two-second request deadline includes pool acquisition. Expired late checkouts return immediately without starting SQL; admission stays reserved until they settle, preventing an abandoned queue. Both annotation normalization and JSON serialization occur after release. Top-level windows use Graph attempt window start/end labels; individual source windows keep Source window start/end labels. SQL and HTTP projections share null-clock compatibility, the count/not-attempted vocabulary, and metadataTruncated. Reason deduplication alone is not omission.

Capped resource neighborhoods keep the requested root and nearest hops first, using the minimum distance from both traversal directions; lexical order only breaks ties within a hop. Authentication expiry (401 or a followed /login redirect), authorization denial (403), and other4xx rejections use a separate localized error path. They do not become query_failed or a retriable graph outage. Sign-in links stay on the local /login route, and stale graph content is cleared on rejection.

A reader-synthesized unknown result with no collection clocks or source records is neutral “No collection state recorded” information; it does not assert stale age or a collector failure. Unknown aggregate coverage has its own neutral wording. This presentation does not change the backend unknown/stale envelope or establish completeness. Read failures, retention, truncation, metadata loss and other actionable evidence still render alerts.

Shipped graph consumers retry only typed HTTP503 admission responses (readStatus=unavailable, readReason=busy), at most five requests within ten seconds. Auth/rejection, query, and untyped service errors are not retried. Scope changes/unmounts cancel waits and reads; exhausted recovery remains explicit unknown/unavailable, never confirmed empty.

Class-wide infra truncation prioritizes the actual `vpc`, `subnet`, and `sg` container kinds before resource nodes; within each rank, IDs provide deterministic order. The cap still bounds the response and does not certify complete connectivity. Recognized metadata fields with invalid types/ranges or unknown enum vocabulary set `metadataTruncated` in both projections; unknown private fields remain excluded without that signal. This deliberately treats vocabulary not understood by the reader as unknown coverage. Published inventory evidence is stale for contradictory status/count pairs, any nonempty or malformed reason list, or an invalid/future optional capture clock. A confirmed zero may omit its capture clock or use null, but requires `empty`, zero count, a succeeded producer and a valid last-success clock.
