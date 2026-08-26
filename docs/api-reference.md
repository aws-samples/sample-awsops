# API 레퍼런스 / API Reference

## 역할 / Role
`web/app/api/**/route.ts` 전수(86개 라우트) 인덱스 — 경로·메서드·역할·인증.
(Full index of all 86 `route.ts` files under `web/app/api` — path, methods, role, auth.)
- 인증 컬럼: `verifyUser` = Cognito `awsops_token` 쿠키 검증(`@/lib/auth`). `없음` = 라우트 자체 비게이트(엣지 Lambda@Edge 게이트는 별도). 역할에 "admin"이 있으면 `isAdmin` 추가 게이트.
- 모든 라우트는 루트 경로(`/api/*`) — basePath 없음. web은 thin-BFF: 무거운 작업은 `POST /api/jobs`로 enqueue.

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

## inventory (6)
| 경로 | 메서드 | 역할 | 인증 |
|------|--------|------|------|
| `/api/inventory/[type]` | GET | 인벤토리 리소스 목록 — `iam_user`/`iam_role`은 admin 전용 | verifyUser |
| `/api/inventory/[type]/metrics` | GET | 보조 KPI 카드 (CloudWatch/Pricing) + `?ids=`/`?nodes=` 타입별 라이브 진단 플릿(ec2/rds/alb/nlb/s3/transit_gateway/lambda/ebs_volume/dynamodb/elasticache/opensearch/msk) — 실패 시 `{cards:[]}`로 조용히 degrade | verifyUser |
| `/api/inventory/[type]/refresh` | POST | warm Steampipe → Aurora sync 트리거 + 첫 페이지 반환 (락 중이면 `busy`) | verifyUser |
| `/api/inventory/cloudtrail/events` | GET | CloudTrail `LookupEvents` 조회 | verifyUser |
| `/api/inventory/summary` | GET | 타입/카테고리별 카운트 + 보안 분할(ec2 running, 미암호화 EBS 등) | verifyUser |
| `/api/inventory/trend` | GET | 일별 리소스 카운트 추세 (`inventory_snapshots`, 기본 14일/최대 90일) | verifyUser |

## eks (10)
| 경로 | 메서드 | 역할 | 인증 |
|------|--------|------|------|
| `/api/eks` | GET | 클러스터 목록 + 접근 상태(Access Entry 여부, 온보딩 가이드) | verifyUser |
| `/api/eks/fleet` | GET | 전 클러스터 서버측 라이브 집계 — raw pod row 미전송, 클러스터별 실패는 `reachable:false` | verifyUser |
| `/api/eks/node-eni` | GET | 인스턴스 타입별 ENI당 IPv4 한도 (미등재 타입 15 폴백) | verifyUser |
| `/api/eks/summary` | GET | v1 K8s-Overview 패리티 — 연결 클러스터 라이브 카운트 (실패는 0으로 degrade, 500 금지) | verifyUser |
| `/api/eks/[cluster]/incluster` | GET | in-cluster 리소스 목록 (`?kind=`, 클러스터 allowlist) | verifyUser |
| `/api/eks/[cluster]/incluster/describe` | GET | 단일 오브젝트 describe (K9s 패리티, secrets는 Kind 불가) | verifyUser |
| `/api/eks/[cluster]/k8sgpt` | GET | K8sGPT read-only 진단 (ADR-035) — admin + 클러스터 allowlist | verifyUser |
| `/api/eks/[cluster]/metrics` | GET | 컨트롤플레인 + ContainerInsights CloudWatch 메트릭 | verifyUser |
| `/api/eks/[cluster]/pod-transfer` | GET | NFM 파드 전송 쿼리 (최대 1h 윈도우) | verifyUser |
| `/api/eks/[cluster]/register` | POST, DELETE | 클러스터 등록/해제 (admin, EKS 공식 이름 패턴 검증) | verifyUser |

## nfm (2)
| 경로 | 메서드 | 역할 | 인증 |
|------|--------|------|------|
| `/api/nfm` | GET | NFM 상태(메뉴 게이트) — 모니터 목록 + Scope 수; 모니터 없으면 온보딩 안내로 degrade | verifyUser |
| `/api/nfm/query` | GET | NFM 모니터 쿼리 — 최대 1시간 윈도우 (초과 시 API ValidationException) | verifyUser |

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
| `/api/anfw` | GET | Network Firewall 방화벽/정책/룰그룹 목록+분석 — 트래픽·드롭 집계, 보호/로깅/전량 통과 기본/룰 용량 (룰 본문은 미탑재). `?view=logs` Alert/Flow 로그 Insights 집계 (CWL 대상만, stateful 룰 히트 카운트 포함), `?view=audit` CloudTrail 변경 감사 | verifyUser |

## dx (1)
| 경로 | 메서드 | 역할 | 인증 |
|------|--------|------|------|
| `/api/dx` | GET | Direct Connect 커넥션/VIF/게이트웨이 목록+분석 — AWS/DX 메트릭 다운 감지·피크 사용률·BGP 라우트 가시성 (호스티드 <1G는 커넥션 레벨 Bps 미발행 → VIF 레벨) | verifyUser |

## ip-inventory (1)
| 경로 | 메서드 | 역할 | 인증 |
|------|--------|------|------|
| `/api/ip-inventory` | GET | ENI 전량 + EIP + EKS 파드 IP 조인 (파드 맵 best-effort — 실패해도 ENI/EIP 반환) | verifyUser |

## tgw (1)
| 경로 | 메서드 | 역할 | 인증 |
|------|--------|------|------|
| `/api/tgw` | GET | Transit Gateway 상세 — 어태치먼트 + 라우트 테이블(+라우트). `ids`는 `tgw-` 접두사만 통과, 인벤토리로 TGW별 소속 리전 해석 | verifyUser |

## vpce (1)
| 경로 | 메서드 | 역할 | 인증 |
|------|--------|------|------|
| `/api/vpce` | GET | VPC Endpoint 목록+분석 — 인벤토리 VPC 리전 fan-out + PrivateLink 메트릭 기반 미사용 감지 | verifyUser |

## 기타 (54)
| 경로 | 메서드 | 역할 | 인증 |
|------|--------|------|------|
| `/api/accounts` | GET, POST, PATCH, DELETE | 등록 계정 CRUD (admin) — POST는 role assume + `GetCallerIdentity` anti-spoof 검증 후 insert | verifyUser |
| `/api/accounts/regions` | GET, POST, DELETE | 계정별 리전 활성/비활성 (`'self'` → 호스트 실제 id 해석) — 조회 auth / 변경 admin | verifyUser |
| `/api/actions` | GET, POST | 액션 목록/생성 (ADR-040/041, admin) | verifyUser |
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
| `/api/customization` | GET, POST, PUT | 스킬/에이전트 카탈로그 CRUD (ADR-031, admin) | verifyUser |
| `/api/datasources` | GET | 데이터소스 인스턴스 목록 — 크리덴셜 미노출 | verifyUser |
| `/api/datasources/generate` | POST | 자연어 → 쿼리 초안 생성 (리뷰용 — 절대 실행 안 함) | verifyUser |
| `/api/datasources/manage` | POST, PATCH | 인스턴스 생성/수정 + 크리덴셜 저장 (admin) | verifyUser |
| `/api/datasources/query` | POST | 인스턴스 대상 read-only 쿼리 실행 (admin 아님 — 탐색용) | verifyUser |
| `/api/datasources/test` | POST | 저장 전 연결 probe — SSRF 가드 (admin) | verifyUser |
| `/api/datasources/[id]` | DELETE | 인스턴스 삭제 — 스키마 캐시/크리덴셜 cascade, 기본값 재선정 (admin) | verifyUser |
| `/api/datasources/[id]/default` | POST | kind별 기본 인스턴스 지정 — 트랜잭션으로 기존 기본 해제 (admin) | verifyUser |
| `/api/datasources/[id]/diag-signals` | GET | 사전 정의 진단 시그널 (DB read only, egress 없음) | verifyUser |
| `/api/db` | GET | Aurora ping — public 테이블 카운트, `AURORA_ENDPOINT` 미설정 시 503 | 없음 |
| `/api/diagnosis` | GET, POST | AI 종합진단 리포트 목록/생성 — worker enqueue + 멱등키 | verifyUser |
| `/api/diagnosis/intent` | GET, POST | Plan-2 Intent Engine — `architecture_intent` 조회(auth) + 쓰기(admin) | verifyUser |
| `/api/diagnosis/schedule` | GET, PUT | 사용자별 자동 진단 스케줄 — row read/write만 (실행은 worker `schedule_dispatcher`) | verifyUser |
| `/api/diagnosis/subscribers` | GET, POST, DELETE | 진단 완료 메일링 리스트 (SNS) — 조회 auth / 변경 admin | verifyUser |
| `/api/diagnosis/[id]` | GET, PATCH, DELETE | 리포트 단건 조회/수정/삭제 | verifyUser |
| `/api/diagnosis/[id]/download` | GET | 산출물(md/docx/pdf) S3 프록시 다운로드 (presign 아님) | verifyUser |
| `/api/graph` | GET | 토폴로지 그래프 (ADR-043 read-only) — class `flow\|infra`, `?from=`으로 서브그래프 | verifyUser |
| `/api/health` | GET | 헬스체크 — 컨테이너/타깃그룹 health 경로와 일치 필수 | 없음 (공개) |
| `/api/incidents` | GET, POST | 인시던트 목록 + 수동 트리거 (ADR-032, admin) | verifyUser |
| `/api/incidents/prevention` | GET | 교차 인시던트 예방 인사이트 (admin, read-only) — Aurora 미설정/실패도 200 + 빈 목록 | verifyUser |
| `/api/incidents/webhook` | POST | 인시던트 ingress — HMAC 서명 웹훅 (ADR-022 active/standby 로테이션) | 없음 (HMAC 검증) |
| `/api/incidents/[id]` | GET | 인시던트 상세 (admin, read-only, UUID 가드) | verifyUser |
| `/api/insights` | GET | Overview용 최신 캐시 AI 인사이트 (DB read only) | verifyUser |
| `/api/insights/refresh` | POST | AI 인사이트 재생성 enqueue (admin) — 플래그 off 시 fail-closed, 중복 job dedup | verifyUser |
| `/api/integrations` | GET, POST, PUT | 통합 등록 — egress 커넥터 + ingress 웹훅 소스 (ADR-039, admin, SSRF 가드) | verifyUser |
| `/api/integrations/credential` | GET, PUT | 통합 크리덴셜 저장 — 단일 Secrets Manager secret에 slug(kind) 키 (admin) | verifyUser |
| `/api/integrations/schema` | GET, POST | 인스턴스 스키마 introspect/캐시 (admin) | verifyUser |
| `/api/jobs` | GET, POST | 비동기 작업 enqueue/목록 (P2 — `worker_jobs` + SQS) | verifyUser |
| `/api/jobs/[id]` | GET | 작업 상태 단건 조회 — UUID 형식 검증만 | 없음 |
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
