"""AWSops v2 — AI Diagnosis section catalog (Well-Architected Deep-Dive depth).

Each section: key, title, sources[] (collector keys it consumes), prompt (Korean-first, read-only framing).
The prompts are written to v1 WADD depth — expert persona, prescribed markdown tables, severity
([Critical]/[Warning]/[Info]) + priority (P1/P2/P3) + effort (Low/Med/High), AS-IS→TO-BE, and AWS pricing
HEURISTICS (real $ comes from the provided cost data; absent → "가격 데이터 없음"). Every prompt is grounded
ONLY in the collected data and must say "데이터 불가" where a signal is missing (no fabrication, no
auto-change). Keys/titles/sources are stable (the UI + report.py contract); only the prompt prose deepened.

Pillar → section map (6 Well-Architected pillars):
  Operational Excellence → recent_changes, observability_coverage
  Security               → security_posture, identity_access, data_protection, network_exposure
  Reliability            → reliability_ha, network_architecture
  Performance Efficiency → compute_infrastructure
  Cost Optimization      → cost_overview, cost_optimization
  Sustainability         → (no native v2 signal → legacy-generation proxy in compute/cost; the health
                            score marks it a data gap rather than fabricating a number)
"""

# Shared rules appended to every section prompt: language, evidence discipline, read-only, finding shape.
_RULES = (
    "마크다운 ### 소제목 + | 표 | + 불릿으로 구성하고 한국어로 답하라. "
    "제공된 데이터에만 근거하라 — 신호가 없으면 '데이터 불가'로 명시하고 추측/날조 금지. "
    "각 발견에 심각도 [Critical]/[Warning]/[Info], 우선순위 P1/P2/P3, 공수 Low/Med/High, 근거(소스)를 붙여라. "
    "AWS 리소스 변경·자동 실행을 제안하지 마라(읽기 전용 진단 — 권고만)."
)
# Pricing heuristics for the cost-bearing sections (rough guidance only; exact $ from the cost data).
_PRICING = (
    "참고 가격 휴리스틱(ap-northeast-2 개략치 — 정확 절감액은 제공된 cost 데이터(서비스별·usage-type·월추이)를 "
    "우선 사용하고, 비용 데이터가 없으면 '가격 데이터 없음'으로 명시): "
    "EBS gp2 $0.114/GB·gp3 $0.0912/GB(gp3 ~20%↓), 스냅샷 $0.05/GB, 미연결 EIP ~$3.6/월, "
    "NAT GW $0.045/hr + $0.045/GB, Inter-AZ 전송 $0.01/GB(왕복 $0.02), 인터넷 egress 첫 10TB $0.126/GB, "
    "S3 Standard $0.025 / S3-IA $0.0138 / Glacier-IR $0.005 / Deep Archive $0.002 (per GB·월), "
    "VPC Gateway Endpoint(S3/DynamoDB) 데이터 처리 무료, "
    "Graviton(arm64) 동급 x86 대비 ~20%↓, RDS Multi-AZ 비용 약 2배(운영 필수), SP/RI 최대 ~60-72%↓, Spot 최대 ~90%↓. "
)

SECTIONS = [
    {"key": "executive_summary", "title": "Executive Summary",
     "sources": ["inventory", "cost", "posture", "what_changed", "cw_metrics", "service_map", "idle", "commitment"],
     "prompt": (
         "당신은 6대 Well-Architected 기둥에 정통한 수석 클라우드 아키텍트다. 아래 계정 데이터로 경영진용 요약을 작성하라.\n"
         "### 인프라 건강 점수 (0~100)\n"
         "6대 기둥을 가중 합산해 점수를 산출하라(세부 가중): "
         "운영 우수성 15(모니터링/알람 8 + 변경관리 7) / 보안 20(공개노출 7 + 암호화 7 + IAM 6) / "
         "신뢰성 20(네트워크 7 + 데이터계층 7 + 컴퓨트 6) / 성능 15(컴퓨트 라이트사이징 8 + DB 7) / "
         "비용 20(효율 8 + 스토리지 6 + 유휴위생 6) / 지속가능성 10(Graviton 채택 5 + 효율 자원 5). "
         "(성능=CloudWatch 지표, 신뢰성=서비스맵/인벤토리, 비용=cost/idle/commitment, 운영 우수성=최근 변경 신호를 근거로). "
         "각 기둥의 점수와 근거를 표(| 기둥 | 가중 | 점수 | 근거 |)로 제시하라. 신호가 없는 기둥(예: 지속가능성 — v2는 탄소 데이터 없음)은 "
         "점수를 날조하지 말고 '데이터 부족'으로 명시하고 가중에서 제외하되, 제외한 가중치는 나머지 기둥에 비례 재정규화하여 100점 만점을 유지하라. "
         "점수 해석: 90+ 우수 / 70-89 양호 / 50-69 보통 / 50 미만 즉시 조치.\n"
         "### 핵심 리스크 Top 3\n"
         "가장 큰 리스크 3가지를 심각도·우선순위와 함께 한 문장씩.\n"
         "### 즉시 조치 (Quick Wins)\n"
         "이번 주 실행 가능한 P1 항목 3가지. " + _RULES)},

    {"key": "security_posture", "title": "Security Posture",
     "sources": ["posture", "inventory"],
     "prompt": (
         "당신은 AWS 보안 포스처·CIS 벤치마크에 정통한 수석 클라우드 보안 엔지니어다. "
         "Security Hub 심각도 분포와 인벤토리로 보안 상태를 진단하라.\n"
         "### 보안 점수 (0~100)\n점수와 감점 근거.\n"
         "### 공개 노출 (Public Exposure)\n표(| 리소스 | 유형 | 노출 | 심각도 | 권고 |): 퍼블릭 S3·0.0.0.0/0 SG(22/3389/3306/5432/6379)·퍼블릭 DB.\n"
         "### 암호화 커버리지\n표(| 리소스 유형 | 전체 | 암호화 | 미암호화 | 커버리지% | 심각도 |).\n"
         "Security Hub 미구독이면 인벤토리 신호만으로 한정 보고하고 그 사실을 명시하라. " + _RULES)},

    {"key": "network_architecture", "title": "Network Architecture",
     "sources": ["service_map", "inventory", "datasources_obs"],
     "prompt": (
         "당신은 AWS VPC 설계·하이브리드 연결에 정통한 수석 네트워크 아키텍트다. "
         "X-Ray 서비스맵 엣지(호출량/에러율)와 VPC/SG/서브넷 인벤토리로 네트워크·트래픽 흐름과 신뢰성을 진단하라.\n"
         "### 토폴로지\n표(| VPC | CIDR | 서브넷(pub/priv) | NAT | AZ수 |).\n"
         "### 단일 장애점(SPOF)\n단일 AZ·단일 NAT·이중화 부재를 심각도순 번호 목록으로.\n"
         "### 트래픽 이상\n비정상 에러율 엣지·의심 통신 경로. " + _RULES)},

    {"key": "compute_infrastructure", "title": "Compute Infrastructure",
     "sources": ["inventory", "cw_metrics", "cost"],
     "prompt": (
         "당신은 AWS 컴퓨트 라이트사이징에 정통한 수석 아키텍트다. EC2/Lambda/ECS/EKS 인벤토리·CloudWatch CPU·비용으로 진단하라.\n"
         "### 컴퓨트 인벤토리\n표(| 서비스 | 수 | 타입/구성 | Multi-AZ |).\n"
         "### 라이트사이징 기회\n표(| 리소스 | 현재 | 권장 | 예상 절감/월 | 공수 | 우선순위 |): CPU<10% 과대프로비저닝·구형 세대(m4/c4/r4)·"
         "x86→Graviton 후보(지속가능성 프록시). " + _PRICING + _RULES)},

    {"key": "database_storage", "title": "Database & Storage",
     "sources": ["inventory", "cw_metrics", "cost"],
     "prompt": (
         "당신은 AWS 관리형 DB·스토리지에 정통한 수석 DBA/스토리지 아키텍트다. "
         "RDS/DynamoDB/S3/EBS/ElastiCache/OpenSearch 인벤토리·사용률·비용으로 데이터 계층을 진단하라.\n"
         "### HA & 보안\n표(| 리소스 | Multi-AZ | 암호화 | 백업보존 | 자동 마이너 업글 | 상태 |): 미암호화·퍼블릭 접근·백업<7일은 [Critical]/[Warning].\n"
         "### 스토리지 최적화\n표(| 항목 | AS-IS | TO-BE | 예상 절감/월 | 공수 | 우선순위 |): gp2→gp3·미연결 볼륨·노후 스냅샷(노후 기준 예: 90일+ 미사용/미참조). " + _PRICING + _RULES)},

    {"key": "cost_overview", "title": "Cost Overview",
     "sources": ["cost"],
     "prompt": (
         "당신은 AWS 비용 관리에 정통한 수석 FinOps 분석가다. Cost Explorer 데이터(MTD 서비스별 + 3개월 총추이 monthly_totals + 상위 usage-type)로 지출 구조를 진단하라.\n"
         "### 비용 총괄 & 추이\n표(| 서비스 | 월비용($) | 비중% |) 상위 서비스(현재월) + 표(| 월 | 총비용($) | MoM% | 추세 |)로 3개월 총지출 추이. "
         "총지출 MoM +15%↑는 [Warning](서비스별 월비교 데이터는 미수집 — 추이는 총지출 기준, 집중도는 현재월 비중으로 판단).\n"
         "### 비용 동인 (Usage-Type)\n상위 usage-type(top_usage_types)을 분석해 숨은 동인을 짚어라 — DataTransfer/NatGateway/스토리지 등. 표(| usage-type | 월비용($) | 비고 |).\n"
         "### 집중 리스크 & 절감 후보\n단일 서비스가 총비용 40%↑이면 [Warning]. 절감 후보를 우선순위·예상효과와 함께(실행은 권고만). " + _PRICING + _RULES)},

    {"key": "recent_changes", "title": "Recent Changes",
     "sources": ["what_changed"],
     "prompt": (
         "당신은 운영 우수성(변경 관리)에 정통한 SRE다. 최근 24시간 CloudTrail 관리 이벤트로 '무엇이 바뀌었나'를 요약하라.\n"
         "### 변경 요약\n표(| 시각 | 이벤트 | 소스 | 리스크 |): 보안/네트워크/IAM 영향 변경을 [Warning] 이상으로 강조. "
         "이벤트가 없으면 '데이터 불가(최근 변경 없음 또는 CloudTrail 비활성)'로 명시하라. " + _RULES)},

    {"key": "recommendations", "title": "Recommendations",
     "sources": ["inventory", "cost", "posture", "service_map", "what_changed", "cw_metrics", "idle", "commitment"],
     "prompt": (
         "당신은 모든 발견을 종합하는 전략 클라우드 어드바이저다. 위 모든 섹션 데이터로 우선순위가 매겨진 read-only 로드맵을 작성하라.\n"
         "### 즉시 — Quick Wins (이번 주)\n표(| # | 조치 | 기둥 | 예상 효과 | 공수 Low | 우선순위 P1 |).\n"
         "### 단기 (1~3개월)\n표(| # | 조치 | 기둥 | 예상 효과/절감 | 공수 | 우선순위 |).\n"
         "### 중기 (3~6개월)\n표(| # | 조치 | 기둥 | 예상 효과/절감 | 공수 | 우선순위 |).\n"
         "### 우선순위 매트릭스 (영향×공수)\n High임팩트·Low공수=먼저 / High·High=계획 / Low·Low=빠른정리 / Low·High=후순위.\n"
         "### 예상 절감 총괄\n비용 데이터가 뒷받침되면 월/연 절감 추정을 제시(없으면 '가격 데이터 없음'). 자동 실행/변경 제안 금지. " + _PRICING + _RULES)},
]

# Plan 2 — intended-vs-actual drift section. Kept SEPARATE from the base SECTIONS and appended by
# report.generate, because it consumes ONLY the deterministic verdict list (passed/severity/observed) —
# never raw service-map edge text. invariants.py already decided pass/fail; the LLM only narrates drift.
INTENDED_VS_ACTUAL_SECTION = {
    "key": "intended_vs_actual", "title": "Intended vs Actual",
    "sources": ["intended_vs_actual"],
    "prompt": (
        "당신은 아키텍처 검증·드리프트 분석에 정통한 수석 아키텍트다. 아래는 운영자가 확정한 불변식(intended)을 "
        "실제 상태(actual)와 비교한 '판정(verdict)' 목록이다. passed=false 인 항목(드리프트)을 심각도 "
        "[Critical]/[Warning]/[Info]와 함께 표(| 불변식 | 심각도 | observed | 권고 |)로 정리하고 각 항목의 observed 근거를 명시하라. "
        "활성 불변식이 없으면 '데이터 불가(활성 불변식 없음)'로 보고하라. "
        "데이터(verdict)에만 근거하라 — 추측/날조 금지. AWS 리소스 변경·자동 실행을 제안하지 마라(읽기 전용 진단 — 권고만)."),
}

# Deep-tier catalog: the 8 base SECTIONS + 6 deep-only sections (14; report.generate appends
# INTENDED_VS_ACTUAL_SECTION → 15 total). Every deep section consumes ALREADY-COLLECTED sources
# (inventory/cw_metrics/cost/service_map/posture/what_changed) — no new collectors, no new IAM.
_DEEP_ONLY = [
    {"key": "identity_access", "title": "IAM & 자격 증명 심층",
     "sources": ["posture", "inventory"],
     "prompt": (
         "당신은 IAM 최소권한·자격 증명 위생에 정통한 수석 보안 엔지니어다. 인벤토리(IAM 사용자/역할/정책)·Security Hub posture로 진단하라.\n"
         "### IAM 평가\n표(| 발견 | 수 | 심각도 | 우선순위 |): 루트 키·MFA 미설정·90일+ 액세스키·과다권한(Admin/PowerUser 역할·인라인 정책·와일드카드 Action)·미사용 자격(90일+). "
         "posture 미구독이면 인벤토리 신호만으로 한정 보고하고 명시하라. " + _RULES)},

    {"key": "data_protection", "title": "데이터 보호 & 암호화",
     "sources": ["inventory", "posture"],
     "prompt": (
         "당신은 데이터 보호·암호화에 정통한 보안 아키텍트다. 인벤토리·posture로 저장·전송 데이터 보호를 진단하라.\n"
         "### 암호화 커버리지\n표(| 스토리지 유형 | 전체 | CMK | AWS관리키 | 미암호화 | 커버리지% |): 미암호화 [Critical], "
         "백업/스냅샷 부재·공개 접근을 짚어라. " + _RULES)},

    {"key": "network_exposure", "title": "네트워크 보안 / 노출",
     "sources": ["inventory", "service_map"],
     "prompt": (
         "당신은 공격면 분석에 정통한 보안 엔지니어다. 인벤토리(SG/서브넷/LB)·서비스맵으로 외부 노출면을 진단하라.\n"
         "### 노출면\n표(| 리소스 | 노출 경로 | 포트 | 심각도 | 권고 |): 0.0.0.0/0 인그레스·퍼블릭 서브넷·퍼블릭 엔드포인트·WAF 미연결 ELB. " + _RULES)},

    {"key": "reliability_ha", "title": "신뢰성 & 고가용성",
     "sources": ["inventory", "cw_metrics", "datasources_obs"],
     "prompt": (
         "당신은 신뢰성·HA 설계에 정통한 수석 아키텍트다. 인벤토리·CloudWatch 지표로 진단하라.\n"
         "### 신뢰성 평가\n표(| 리소스/계층 | Multi-AZ | 백업/복구 | 스케일링 | SPOF | 심각도 |): 단일 AZ·단일 NAT·백업 부재·ASG 부재. " + _RULES)},

    {"key": "observability_coverage", "title": "관측성 & 알람 커버리지",
     "sources": ["cw_metrics", "inventory"],
     "prompt": (
         "당신은 운영 우수성(관측성)에 정통한 SRE다. CloudWatch 지표/알람·인벤토리로 관측성 커버리지를 진단하라.\n"
         "### 커버리지\n표(| 리소스 | 알람 | 지표 | 로그 | 갭 | 심각도 |): 알람 미설정 핵심/고비용 리소스·지표 공백·로그 보존 미설정. " + _RULES)},

    {"key": "external_obs_signals", "title": "외부 관측성 신호 (Prometheus/Mimir)",
     "sources": ["datasources_obs"],
     "prompt": (
         "당신은 Kubernetes·노드 관측성에 정통한 수석 SRE다. 외부 datasource(Prometheus/Mimir)에서 "
         "미리 빌드된 진단 신호 결과(datasources_obs.findings[].results — 각 신호는 label `signal_key:query`로 "
         "식별; datasources_obs.findings[].signals에 신호별 pillar·threshold·title)로 컨테이너/노드 상태를 진단하라.\n"
         "### 신호 요약\n표(| 신호 | 인스턴스 | 관측치(상위) | 임계 | 판정 | 심각도 |): "
         "container_cpu_throttling·oom_kills·node_memory_pressure·node_disk_usage·network_pps·"
         "pod_right_sizing·cpu_saturation·pod_restarts 중 결과가 있는 것만. threshold 초과는 [Critical], 근접은 [Warning].\n"
         "### 권고\n표(| 조치 | 대상 | 우선순위 | 공수 |): P1/P2/P3 · Low/Med/High. "
         "datasources_obs가 비활성/연결없음/unavailable(metric 없음)이면 해당 신호는 '데이터 불가'로 명시하고 "
         "추측하지 말 것. 모든 조치는 운영자 검토용 권고만(자동 변경 금지). " + _RULES)},

    {"key": "cost_optimization", "title": "비용 최적화 심층",
     "sources": ["cost", "inventory", "cw_metrics", "idle", "commitment"],
     "prompt": (
         "당신은 AWS 비용 최적화에 정통한 FinOps 엔지니어다. 비용·인벤토리·CloudWatch 사용률·유휴(idle)·약정 커버리지(commitment)로 절감 기회를 진단하라.\n"
         "### 유휴 리소스 회수 (Idle & Waste)\n표(| 항목 | 수량 | 예상 회수/월($) |): 미연결 EBS(idle.unattached_ebs — est_monthly_usd를 회수 추정으로)·중지 EC2(idle.stopped_ec2, EBS는 계속 과금). idle.note의 미동기화 항목(EIP/스냅샷)은 '데이터 불가'.\n"
         "### 약정 커버리지 (RI/SP)\nRI 커버리지(commitment.ri_coverage_pct)·SP 커버리지(commitment.sp_coverage_pct)를 보고. 70% 미만이면 [Warning] + 약정 확대 권고. 값이 None이면 '데이터 불가'.\n"
         "### 최적화 기회\n표(| 조치 | 대상 | 예상 절감/월 | 공수 | 우선순위 |): 과대프로비저닝(CPU<10%)·구형 세대(m4/c4/r4)·gp2→gp3·Graviton 전환. " + _PRICING + _RULES)},
]

DEEP_SECTIONS = list(SECTIONS) + _DEEP_ONLY
