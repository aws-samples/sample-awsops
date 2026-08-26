"""AWSops Strands Agent with Dynamic Gateway Routing + Skill Prompts"""
# AWSops Strands agent: dynamic gateway routing + optimized skill prompts
# 동적 게이트웨이 라우팅 + 최적화된 스킬 프롬프트
import json
import logging
import os
import functools
import socket
import ipaddress
import urllib.parse
from contextlib import ExitStack
from strands import Agent
from strands.hooks import AfterToolCallEvent, HookProvider, HookRegistry
try:
    from strands.models import BedrockModel, CacheConfig
except ImportError:  # pre-CacheConfig strands
    from strands.models import BedrockModel
    CacheConfig = None
from strands.tools.mcp.mcp_client import MCPClient
from botocore.credentials import Credentials
from bedrock_agentcore.runtime import BedrockAgentCoreApp
from streamable_http_sigv4 import streamablehttp_client_with_sigv4, streamablehttp_client_with_headers
from account_utils import effective_account_id
import boto3

# Configure logging / 로깅 설정
logging.getLogger("strands").setLevel(logging.INFO)
logging.basicConfig(format="%(levelname)s | %(name)s | %(message)s", handlers=[logging.StreamHandler()])

# Initialize AgentCore application / AgentCore 애플리케이션 초기화
app = BedrockAgentCoreApp()

# Gateway URLs — 시작 시 AWS CLI로 자동 감지, 환경변수 폴백
# Gateway URLs — auto-detect via AWS CLI at startup, env var fallback
DEFAULT_GATEWAY = "ops"
# ADR-004: the web chat section key 'observability' routes to the provisioned 'external-obs'
# gateway (external-obs becomes a routed section once it bears connector tools — Prometheus,
# ClickHouse). Keeps the readable chat key while matching the deployed gateway short-name.
_GATEWAY_ALIAS = {"observability": "external-obs"}


def _resolve_gateway_key(role, gateways):
    """Map a chat/section role to an actual key in the runtime GATEWAYS map.

    BUGFIX: `_discover_gateways` derives keys via name.replace("awsops-","").replace("-gateway","").
    While v1 and v2 gateways COEXIST, v2 gateways are named `awsops-v2-<x>-gateway`, so discovery
    yields `v2-<x>` (e.g. `v2-external-obs`), whereas the GATEWAYS_JSON env fallback uses the
    canonical `<x>` (`external-obs`). The `observability`→`external-obs` alias only matched the env
    spelling; on the (primary) discovery path `external-obs` was absent → silent fallback to `ops`.

    We try the CANONICAL key first, then the `v2-`-prefixed transition spelling. This is
    forward-compatible: once v2 merges to main and the gateways are renamed to `awsops-<x>-gateway`
    (v1 retired, the `v2` name dropped), discovery yields the canonical `<x>` and the first branch
    matches — the `v2-` fallback becomes dead code. **REMOVE the `v2-` candidate at the v2→main
    cutover** (it is a coexistence shim, not permanent behavior)."""
    key = _GATEWAY_ALIAS.get(role, role)
    # canonical first; `v2-` = transition shim (drop at v2→main). The DEFAULT_GATEWAY fallback is
    # resolved the SAME tolerant way — under v2-only discovery the default is `v2-ops`, not `ops`,
    # so a hard `GATEWAYS[DEFAULT_GATEWAY]` would KeyError. Returning DEFAULT_GATEWAY as the last
    # resort yields None at the call site (GATEWAYS.get), which the MCP try-block degrades to a
    # tool-less Bedrock-direct answer — never a crash outside the try.
    for candidate in (key, f"v2-{key}", DEFAULT_GATEWAY, f"v2-{DEFAULT_GATEWAY}"):
        if candidate in gateways:
            return candidate
    return DEFAULT_GATEWAY
GATEWAY_REGION = os.environ.get("AWS_REGION", "ap-northeast-2")
SERVICE = "bedrock-agentcore"

def _discover_gateways():
    """AWS CLI로 Gateway URL 자동 감지 / Auto-discover gateway URLs via AWS CLI"""
    gateways = {}
    try:
        import subprocess, json as _json
        result = subprocess.run(
            ["aws", "bedrock-agentcore-control", "list-gateways", "--region", GATEWAY_REGION, "--output", "json"],
            capture_output=True, text=True, timeout=15
        )
        items = _json.loads(result.stdout).get("items", [])
        for g in items:
            # awsops-network-gateway → network
            short = g["name"].replace("awsops-", "").replace("-gateway", "")
            gid = g["gatewayId"]
            url = f"https://{gid}.gateway.{SERVICE}.{GATEWAY_REGION}.amazonaws.com/mcp"
            gateways[short] = url
        if gateways:
            print(f"[Agent] Auto-discovered {len(gateways)} gateways: {list(gateways.keys())}")
    except Exception as e:
        print(f"[Agent] Gateway auto-discovery failed: {e}, using env GATEWAYS_JSON fallback")

    # 환경변수 폴백: GATEWAYS_JSON='{"network":"https://...","ops":"https://..."}' / Env var fallback
    if not gateways:
        env_gw = os.environ.get("GATEWAYS_JSON", "")
        if env_gw:
            try:
                import json as _json
                gateways = _json.loads(env_gw)
                print(f"[Agent] Loaded {len(gateways)} gateways from GATEWAYS_JSON env")
            except:
                pass

    if not gateways:
        print("[Agent] WARNING: No gateways discovered. Agent will run without MCP tools.")
    return gateways

GATEWAYS = _discover_gateways()

# Bedrock Model / Bedrock 모델
# ADR-038: deterministic tool selection + prompt caching (verified against strands-agents 1.41.0:
# BedrockConfig exposes temperature / cache_config / cache_tools; cache_prompt is deprecated).
# Cache params are guarded — an unsupported version degrades to temperature-only (spec §6 no-op rule).
# Single source of truth for the model id — also streamed to the web as answer provenance
# ({"model": ...} frame), so the chat footer never goes stale when this migrates.
MODEL_ID = "global.anthropic.claude-sonnet-5"
try:
    if CacheConfig is None:
        raise TypeError("CacheConfig unavailable")
    model = BedrockModel(
        model_id=MODEL_ID,
        region_name="ap-northeast-2",  # global.* profile invoked from the home region so calls land in /aws/bedrock/invocation-logs (ap-northeast-2) for awsops-only cost attribution
        # NOTE: sonnet-5 rejects `temperature` on ConverseStream ("temperature is deprecated for
        # this model" — live-verified 2026-07-07, every request failed with a ValidationException
        # until this was dropped). The ADR-038 determinism rationale (temperature=0.0 for tool
        # selection) no longer applies to this model generation — omit rather than pass an invalid value.
        # Rollback contract: if MODEL_ID moves back to a temperature-accepting generation (e.g.
        # sonnet-4-6), restore temperature=0.0 here AND in the no-cache fallback below — ADR-038
        # determinism is suspended only while the model rejects the param, not repealed.
        cache_config=CacheConfig(strategy="auto"),  # auto cachePoint injection (system+messages)
        cache_tools="default",                      # toolConfig cachePoint, 5m TTL
    )
except (TypeError, ValueError) as e:  # older strands: unknown kwarg / CacheConfig missing; or CacheConfig(strategy="auto") rejected (ValueError/pydantic ValidationError)
    # NOTE: this fires once per cold start only. The production cache-degradation detector is
    # the cacheReadInputTokens usage check (ADR-038 Task 8) — do not rely on this line alone.
    print(f"[Agent] prompt caching unavailable ({e}); falling back to no-cache")
    model = BedrockModel(
        model_id=MODEL_ID,
        region_name="ap-northeast-2",  # global.* profile invoked from the home region so calls land in /aws/bedrock/invocation-logs (ap-northeast-2) for awsops-only cost attribution
    )

# ============================================================================
# Skill Base: Static decision patterns + workflows (rarely changes)
# 스킬 베이스: 정적 결정 패턴 + 워크플로우 (변경 드묾)
# Dynamic tool list is appended at runtime from MCP discovery
# 동적 도구 목록은 런타임에 MCP 탐색에서 추가됨
# ============================================================================
SKILL_BASE = {

    "network": """You are AWSops Network Specialist. Diagnose and explain AWS VPC networking, connectivity, and traffic.

## Decision Patterns — Match user question to tool chain:
| User asks about... | Tool chain |
|---|---|
| TGW, Transit Gateway 현황/라우팅 | list_transit_gateways → get_tgw_details → get_tgw_routes |
| TGW 피어링 | list_tgw_peerings |
| 연결 확인, "A가 B에 접근 가능?" | analyze_reachability |
| 트래픽 분석, flow log, 차단 패킷 | query_flow_logs |
| VPC 현황, 서브넷, 라우트 테이블 | list_vpcs → get_vpc_network_details |
| 네트워크 토폴로지, 전체 구성 | describe_network |
| IP 찾기, 리소스 식별 | find_ip_address |
| ENI 문제 | get_eni_details |
| VPN 상태 | list_vpn_connections |
| Network Firewall 규칙 | list_network_firewalls → get_firewall_rules |

## Troubleshooting Workflows:
- Connectivity: analyze_reachability → describe_network (SG/NACL) → query_flow_logs
- TGW routing: list_transit_gateways → get_tgw_routes → get_all_tgw_routes (compare)

## Rules:
- ALWAYS call tools for real-time data — never answer from memory
- For connectivity: always use the 3-step pattern (reachability → SG → flow logs)""",


    "container": """You are AWSops Container Specialist. Manage and troubleshoot EKS, ECS, and Istio service mesh.

## Decision Patterns — Match user question to tool chain:
| User asks about... | Tool chain |
|---|---|
| EKS 클러스터 상태/현황 | list_eks_clusters → get_eks_insights |
| EKS 네트워크 설정 | get_eks_vpc_config |
| EKS 로그/메트릭 | get_cloudwatch_logs / get_cloudwatch_metrics |
| EKS Pod 문제 | search_eks_troubleshoot_guide |
| K8s 매니페스트 생성 | generate_app_manifest |
| ECS 서비스/태스크 현황 | ecs_resource_management |
| ECS 태스크 실패 | ecs_troubleshooting_tool |
| ECS 배포 상태 | wait_for_service_ready |
| Istio 현황, 메시 상태 | istio_overview |
| Istio 트래픽 라우팅 | list_virtual_services → list_destination_rules |
| Istio 503, mTLS 오류 | istio_troubleshooting |
| Istio sidecar 문제 | check_sidecar_injection |

## Troubleshooting Workflows:
- EKS issues: list_eks_clusters → get_eks_insights → get_cloudwatch_logs → search_eks_troubleshoot_guide
- ECS failures: ecs_resource_management → ecs_troubleshooting_tool
- Istio 503: istio_overview → list_virtual_services → istio_troubleshooting

## Rules:
- ALWAYS call tools for real-time data — never answer from memory""",


    "ops": """You are AWSops Operations Assistant. Answer resource-inventory, topology, and unused-resource questions over the synced Aurora inventory (read-only).

## Decision Patterns:
| User asks about... | Tool chain |
|---|---|
| 미사용/고아 리소스, 정리 후보 (빈 origin, 등록 없는 TG, dead LB) | find_unused_resources |
| 전체 토폴로지, CF→LB→TG→타깃 체인 | get_topology |
| 리소스 현황/목록 (특정 타입: alb·nlb·target_group·cloudfront·ec2·ebs…) | query_inventory |
| 동기화 신선도 / 타입별 카운트 | inventory_summary |
| AWS 문서, 기능 설명 | search_documentation → read_documentation |
| 리전 가용성 | get_regional_availability |
| AWS CLI 명령 제안 (읽기 전용) | suggest_aws_commands |

## Rules:
- ALWAYS call a tool for real data — never answer inventory/topology questions from memory.
- find_unused_resources covers orphan target groups (no LB / 0 healthy), empty CloudFront origins,
  dead/idle load balancers, and unattached EBS — derived from the synced inventory. State the data's
  freshness (it reflects the latest inventory sync; use inventory_summary to check).
- ELB listeners, Elastic IPs, and detached ENIs are NOT synced yet — say so if asked rather than guessing.""",


    "data": """You are AWSops Data & Analytics Specialist. Manage and troubleshoot AWS databases and streaming.

## Decision Patterns:
| User asks about... | Tool chain |
|---|---|
| DynamoDB 테이블 목록 | list_tables |
| DynamoDB 스키마, 인덱스 | describe_table |
| DynamoDB 쿼리/검색 | query_table or get_item |
| DynamoDB 데이터 모델링 | dynamodb_data_modeling |
| DynamoDB 비용/용량 | describe_table → compute_performances_and_costs |
| RDS 인스턴스 현황 | list_db_instances |
| Aurora 클러스터 | list_db_clusters → describe_db_cluster |
| RDS SQL 실행 | execute_sql (Aurora Serverless only) |
| RDS 백업/스냅샷 | list_snapshots |
| ElastiCache 현황 | list_cache_clusters |
| Redis/Valkey 복제 | list_replication_groups → describe_replication_group |
| 캐시 모범사례 | elasticache_best_practices |
| Kafka/MSK 클러스터 | list_clusters → get_cluster_info |
| Kafka 연결 정보 | get_bootstrap_brokers |
| Kafka 설정 | get_configuration_info |
| Kafka 모범사례 | msk_best_practices |
| DB 선택 추천 | Ask workload pattern → recommend appropriate service |""",


    "security": """You are AWSops Security Specialist. Audit and improve AWS IAM security posture.

## Decision Patterns:
| User asks about... | Tool chain |
|---|---|
| 보안 현황, 요약 | get_account_security_summary |
| IAM 사용자 목록 | list_users |
| 사용자 권한 상세 | get_user → list_user_policies |
| IAM 역할 목록/상세 | list_roles → get_role_details |
| 그룹 멤버십 | list_groups → get_group |
| 정책 목록 | list_policies |
| 인라인 정책 내용 | get_user_policy or get_role_policy |
| 권한 테스트, "X가 Y 가능?" | simulate_principal_policy |
| Access Key 상태/로테이션 | list_access_keys |

## Audit Workflows:
- Security posture: get_account_security_summary → highlight critical issues
- User audit: get_user → list_user_policies → simulate_principal_policy
- Credential hygiene: list_users → list_access_keys → check last_used
- Trust policy: list_roles → get_role_details → analyze AssumeRolePolicyDocument

## Priority: MFA > Access key rotation > Unused credentials > Overly permissive policies""",


    "monitoring": """You are AWSops Monitoring Specialist. Analyze metrics, logs, and audit trails.

## Decision Patterns:
| User asks about... | Tool chain |
|---|---|
| 서버 성능, CPU/메모리 | get_metric_data → analyze_metric |
| 사용 가능한 메트릭 | get_metric_metadata |
| 현재 알람 상태 | get_active_alarms |
| 알람 이력 | get_alarm_history |
| 알람 추천 | get_metric_metadata → get_recommended_metric_alarms |
| 로그 그룹 목록 | describe_log_groups |
| 로그 분석 | analyze_log_group or execute_log_insights_query |
| "누가 변경했나?" | lookup_events |
| API 호출 패턴 분석 | lake_query |

## Correlation Pattern: metrics (what) + logs (why) + CloudTrail (who)
- Incident: get_active_alarms → get_metric_data → execute_log_insights_query → lookup_events

## External Datasources (when connected — tools appear in the list above; each uses its own query language):
## NOTE: Prometheus & ClickHouse are owned by the **Observability** section now — route those there.
| Source | Tools | Query language |
|---|---|---|
| Mimir | mimir_query[_range], *_labels, *_series | PromQL (e.g. rate(http_requests_total{code=~"5.."}[5m])) |
| Loki | loki_query_range / loki_query, loki_labels | LogQL (e.g. {app="x"} |= "error") |
| Tempo | tempo_search, tempo_get_trace | TraceQL (e.g. { status=error && duration>1s }) |
| OpenSearch | search_opensearch_logs | query_string |
- GENERATE the query in the correct language yourself from the user's natural-language ask.
- If a "## Datasource schemas (cached)" block is provided below, USE it (real metric/label/table/tag
  names) to write accurate queries — do NOT guess names.
- Multi-source incident correlation (e.g. "what spiked at 3:30?"): metrics (Prometheus/Mimir/CloudWatch
  → WHAT) → logs (Loki/OpenSearch/CloudWatch Logs → WHY) → traces (Tempo → WHERE) → CloudTrail (WHO).
  Query only the sources that are connected; synthesize across them.""",


    "observability": """You are AWSops Observability Specialist. Answer questions over EXTERNAL observability datasources — currently **Prometheus** (metrics) and **ClickHouse** (analytics / otel traces·logs) — by GENERATING the correct query language yourself and calling the read-only connector tools. Read-only by construction.

## Datasources (tools appear in the list above only when the datasource is connected):
| Source | Tools | Query language |
|---|---|---|
| Prometheus | prometheus_query / prometheus_query_range, prometheus_labels, prometheus_series, prometheus_metric_meta, prometheus_schema | PromQL (e.g. `rate(http_requests_total{code=~"5.."}[5m])`) |
| ClickHouse | clickhouse_query (read-only SELECT/SHOW/DESCRIBE), clickhouse_tables, clickhouse_describe, clickhouse_schema | SQL |

## Rules:
- GENERATE the query in the correct language yourself from the user's natural-language ask — never ask the user to write PromQL/SQL.
- If a "## Datasource schemas (cached)" block is provided below, USE it (real metric/label/table/column names) to write accurate queries — do NOT guess names.
- If a Prometheus/ClickHouse connector tool is present, ALWAYS call it for real data (never answer from memory). If NO connector tool is available (none configured for this account), say so honestly — do NOT fabricate metrics or rows.
- p99 / latency / error-rate / throughput → Prometheus PromQL (`histogram_quantile`, `rate`, `sum by`). Otel traces·logs·events stored in ClickHouse → SQL.
- Logs (Loki), distributed traces (Tempo) and long-term metrics (Mimir) live on the **Monitoring** section, not here — defer those there.
- For cross-source correlation, query each connected source and synthesize.""",


    "cost": """You are AWSops FinOps Specialist. Analyze costs and recommend optimizations.

## Decision Patterns:
| User asks about... | Tool chain |
|---|---|
| 이번 달/기간 비용 | get_today_date → get_cost_and_usage |
| 비용 비교 (전월 대비) | get_cost_and_usage_comparisons |
| 비용 증가 원인 | get_cost_comparison_drivers |
| 비용 예측 | get_cost_forecast |
| 서비스 가격 조회 | get_pricing |
| 예산 상태 | list_budgets |
| 필터 값 확인 | get_dimension_values or get_tag_values |

## Rules:
- Always show costs in USD with 2 decimal places
- Always identify top 3 cost drivers
- Always suggest optimization opportunities""",


    "diagnostics": """You are AWSops Datasource Connectivity Diagnostics Specialist.
Systematically diagnose datasource connection issues using a 6-step workflow.

## Decision Patterns — Match user question to tool chain:
| User asks about... | Tool chain |
|---|---|
| 데이터소스 연결 진단, 전체 진단 | run_full_diagnosis |
| URL 검증, SSRF 확인 | validate_datasource_url |
| DNS 해석, IP 확인 | resolve_dns |
| NLB 타겟 헬스, 로드밸런서 | check_nlb_targets |
| 보안그룹 체인, SG 분석 | analyze_security_groups |
| 네트워크 경로, TGW, 크로스VPC | trace_network_path |
| HTTP 연결 테스트, 레이턴시 | test_http_connectivity |
| K8s 서비스 엔드포인트, Pod 매칭 | check_k8s_service_endpoints |

## Diagnostic Workflow (run_full_diagnosis):
1. validate_datasource_url → URL structure, SSRF risk
2. resolve_dns → IP resolution, VPC CIDR mapping
3. check_nlb_targets (if NLB) → target group health
4. analyze_security_groups → SG chain analysis (source → destination)
5. trace_network_path (if cross-VPC) → TGW/Peering route verification
6. test_http_connectivity → actual HTTP health check

## Rules:
- For general "연결 안됨" or "진단해줘" → always use run_full_diagnosis
- For specific issues → use the targeted tool
- Always report pass/fail/warn status per step
- Provide actionable remediation for each failure""",


    "iac": """You are AWSops IaC Specialist. Help with Infrastructure as Code tools and best practices.

## Decision Patterns:
| User asks about... | Tool chain |
|---|---|
| CF 템플릿 검증 | validate_cloudformation_template → check_cloudformation_template_compliance |
| CF 배포 실패 | troubleshoot_cloudformation_deployment |
| CF 리소스 문서 | search_cloudformation_documentation |
| CDK 구성/API | search_cdk_documentation |
| CDK 예제 | search_cdk_samples_and_constructs |
| CDK 모범사례 | cdk_best_practices |
| 문서 상세 | read_iac_documentation_page |
| Terraform AWS 리소스 | SearchAwsProviderDocs or SearchAwsccProviderDocs (prefer AWSCC) |
| Terraform 모듈 | SearchSpecificAwsIaModules or SearchUserProvidedModule |

## Rule: Prefer AWSCC provider over AWS provider for Terraform when available""",

}

# Common footer appended to all prompts / 모든 프롬프트에 추가되는 공통 푸터
COMMON_FOOTER = """

## Multi-Account Rules
- If [Target Account: XXXX], MUST pass target_account_id='XXXX' to EVERY tool call.
- This is mandatory.

## Honesty & routing (do NOT hallucinate)
- The AWSops section agents are EXACTLY these 8: network, container, data, security, cost,
  monitoring, iac, ops. NEVER invent or name an agent that is not in this list.
- NEVER tell the user to type a slash command or "go to / switch to" another section — the main
  chat routes to the right section automatically. Just answer.
- If you lack a tool for the request, say so honestly and answer with what you have; do not
  fabricate tools, agents, or results.

Format responses in markdown. Respond in the user's language."""


def build_skill_prompt(gateway_role, tools):
    """Build optimized system prompt: static patterns + dynamic tool list.
    최적화된 시스템 프롬프트 생성: 정적 패턴 + 동적 도구 목록."""
    base = SKILL_BASE.get(gateway_role, SKILL_BASE[DEFAULT_GATEWAY])

    # Auto-format discovered tools / 발견된 도구 자동 포맷
    tool_lines = []
    for t in tools:
        name = t.tool_name
        # Extract first sentence of description / 설명의 첫 문장 추출
        desc = getattr(t, 'description', '') or ''
        short_desc = desc.split('.')[0].strip() if desc else name
        tool_lines.append(f"- **{name}**: {short_desc}")

    tool_section = f"\n\n## Available Tools ({len(tools)}):\n" + "\n".join(tool_lines)

    return base + tool_section + COMMON_FOOTER


def _filter_tools(tools, allowlist):
    """ADR-031/ADR-039: enforce the resolver-computed tool allowlist OUTSIDE the model.

    Keeps only tools whose ``.tool_name`` is in ``allowlist``, preserving the original
    tool order. ``None`` or ``[]`` ⇒ no restriction (the resolver omits the key when
    empty; ``[]`` is NOT deny-all). Unknown names in the allowlist are ignored. A
    non-empty allowlist that matches nothing yields an empty tool set (the agent then
    runs tool-less — safe). This is the single point where the per-account / per-skill
    cap actually takes effect at the runtime (the cap was previously dropped here)."""
    if not allowlist:
        return tools
    allow = set(allowlist)
    return [t for t in tools if getattr(t, "tool_name", None) in allow]


class SsrfBlocked(Exception):
    """Raised when an integration endpoint is blocked by SSRF guard."""
    pass


# Cloud instance-metadata endpoints that MUST be blocked even under the allowPrivate opt-in.
# IPv4 169.254.169.254 is already link-local; the IPv6 IMDS fd00:ec2::254 lives in fc00::/7 (ULA) so it
# would otherwise be treated as an opt-in-able private address (P4 gate finding) — block it explicitly.
_METADATA_IPS = frozenset({
    ipaddress.ip_address('169.254.169.254'),
    ipaddress.ip_address('fd00:ec2::254'),
})


def _ip_always_blocked(ip_str):
    """Returns True if the IP is metadata, loopback, link-local, multicast, reserved, or unspecified —
    i.e. blocked REGARDLESS of the per-account allowPrivate opt-in."""
    try:
        ip = ipaddress.ip_address(ip_str)
        if ip in _METADATA_IPS:
            return True
        return (ip.is_loopback or ip.is_link_local or ip.is_multicast or
                ip.is_reserved or ip.is_unspecified)
    except ValueError:
        return True  # Invalid IP is blocked


def _ip_is_private(ip_str):
    """Returns True if the IP is in a private range (RFC1918/ULA) AND not always blocked."""
    try:
        ip = ipaddress.ip_address(ip_str)
        # ipaddress.is_private includes link-local/loopback in some versions; we only want
        # the "opt-in" ranges (RFC1918 + RFC4193 ULA).
        return ip.is_private and not _ip_always_blocked(ip_str)
    except ValueError:
        return False


def _assert_host_allowed(url, allow_private, resolver=socket.getaddrinfo):
    """Assert the URL host is connectable: require https, resolve the host, and block any resolved IP
    that is always-blocked (metadata/loopback/link-local/...) or private-without-the-opt-in.

    KNOWN LIMITATION (P4 gate, accepted — matches ADR-011 / web/lib/ssrf-guard.ts, both resolve-based):
    this is resolve-and-recheck; the transport re-resolves at connect time, so a DNS-rebinding host
    could return a safe IP here and a blocked IP at connect. The layered mitigations are redirect:'manual'
    (set on both integration transports) + the registration-time literal-host guard (ssrf-guard.ts). True
    IP-pinning (connect to the validated IP with SNI/Host preserved) is deferred to P3 hardening."""
    parsed = urllib.parse.urlparse(url)
    if parsed.scheme != 'https':
        raise SsrfBlocked(f"SSRF block: HTTPS required for integration endpoints, got {parsed.scheme}")

    host = parsed.hostname
    if not host:
        raise SsrfBlocked(f"SSRF block: invalid or missing host in URL {url}")

    try:
        # Resolve all IPs for the host (could be dual-stack or have multiple A records)
        addr_info = resolver(host, 443, proto=socket.IPPROTO_TCP)
    except socket.gaierror as e:
        raise SsrfBlocked(f"SSRF block: could not resolve host {host}: {e}")

    if not addr_info:
        raise SsrfBlocked(f"SSRF block: could not resolve host {host} (no addresses returned)")

    for family, type, proto, canonname, sockaddr in addr_info:
        ip_str = sockaddr[0]
        if _ip_always_blocked(ip_str):
            raise SsrfBlocked(f"SSRF block: host {host} resolved to always-blocked IP {ip_str}")
        if _ip_is_private(ip_str) and not allow_private:
            raise SsrfBlocked(f"SSRF block: host {host} resolved to private IP {ip_str} and private access disabled")


def parse_secret(val):
    """Parse a secret string (JSON or raw) into a dict. / 비밀번호 문자열(JSON 또는 raw)을 dict로 파싱."""
    if not val:
        return {}
    try:
        parsed = json.loads(val)
        if isinstance(parsed, dict):
            return parsed
        return {"_raw": str(val)}
    except (ValueError, TypeError):
        return {"_raw": str(val)}


def auth_headers(transport, secret):
    """Generate auth headers for non-sigv4 transports. / 비-sigv4 전송용 인증 헤더 생성."""
    if transport == 'api_key':
        # {"header": "X-API-KEY", "value": "..."} or {"api_key": "..."} -> Authorization: ...
        header = secret.get("header", "Authorization")
        val = secret.get("value", secret.get("api_key", secret.get("_raw")))
        if not val:
            raise ValueError(f"Integration [api_key] missing value in secret")
        return {header: val}
    if transport == 'oauth_client_credentials':
        # Bearer-style for this increment: {"token": "..."} or raw
        val = secret.get("token", secret.get("_raw"))
        if not val:
            raise ValueError(f"Integration [oauth_client_credentials] missing token in secret")
        return {"Authorization": f"Bearer {val}"}
    if transport == 'sigv4':
        return {}
    raise ValueError(f"Unknown integration transport: {transport}")


def sigv4_params(endpoint, service=None, region=None):
    """Derive SigV4 service and region from endpoint or explicit params. / 엔드포인트 또는 명시적 파라미터에서 SigV4 서비스 및 리전 도출."""
    if not service:
        # We NO LONGER guess the service (e.g. 'execute-api'). It MUST be explicit for integrations
        # to prevent unsafe reuse of the gateway signer.
        raise ValueError("Integration [sigv4] transport requires an explicit 'sigv4Service'")

    if not region:
        # Try to derive from host: <id>.execute-api.<region>.amazonaws.com
        parsed = urllib.parse.urlparse(endpoint)
        host = parsed.hostname or ""
        parts = host.split('.')
        # execute-api pattern: hostname.execute-api.region.amazonaws.com
        if 'execute-api' in parts and len(parts) >= 4:
            region = parts[parts.index('execute-api') + 1]
        # lambda pattern: id.lambda-url.region.on.aws
        elif 'lambda-url' in parts and len(parts) >= 3:
            region = parts[parts.index('lambda-url') + 1]
        
        if not region:
            region = GATEWAY_REGION
            logging.info(f"SigV4: could not derive region from {host}, falling back to {region}")
    
    return service, region


# Short per-integration connect/read timeout — chat maxDuration is 120s; a slow or hung external
# MCP must not dominate the budget (the default 30s transport timeout is too long for N integrations).
INTEGRATION_CONNECT_TIMEOUT = 8

_secrets_client = None


def _get_secret(ref):
    """Fetch a SecretString from Secrets Manager (lazy, reused client — boto3 auto-refreshes the
    runtime role creds across warm starts). / Secrets Manager에서 SecretString 조회(지연 생성·재사용)."""
    global _secrets_client
    if _secrets_client is None:
        _secrets_client = boto3.client('secretsmanager', region_name=GATEWAY_REGION)
    return _secrets_client.get_secret_value(SecretId=ref).get('SecretString', '')


def select_integration_tools(live_tools, exposed_tools):
    """ADR-039: an egress-READ integration's live tools ∩ its admin ``exposed_tools`` (the ceiling).
    Empty ``exposed_tools`` ⇒ ``[]`` — a READ integration that exposes nothing contributes nothing
    (NOT 'all tools'). Output order follows ``live_tools``. The resolver's per-account toolAllowlist
    is then applied on top in the handler (defense-in-depth)."""
    allow = set(exposed_tools or [])
    if not allow:
        return []
    return [t for t in live_tools if getattr(t, "tool_name", None) in allow]


def _dedup_by_tool_name(tools):
    """Drop duplicate tool_names, keeping the FIRST occurrence (gateway tools precede integration tools
    in the union, so the gateway wins a collision). Prevents handing Agent(tools=) two same-named tools
    (P4 gate finding — external integrations could collide with a gateway tool name)."""
    seen = set()
    out = []
    for t in tools:
        n = getattr(t, "tool_name", None)
        if n in seen:
            continue
        seen.add(n)
        out.append(t)
    return out


def gather_integration_tools(specs, connect):
    """ADR-039 per-integration failure ISOLATION: connect+collect each integration's tools via the
    injected ``connect(spec)``; a failure (SsrfBlocked / unknown-transport ValueError / connect or
    list error) drops ONLY that integration — the gateway tools and the other integrations are
    unaffected — and is logged with the integration name + endpoint. This function NEVER raises, so
    an integration problem can never trigger the coarse outer Bedrock-direct fallback."""
    out = []
    for spec in (specs or []):
        name = spec.get("name") if isinstance(spec, dict) else None
        endpoint = spec.get("endpoint") if isinstance(spec, dict) else None
        try:
            out.extend(connect(spec))
        except Exception as e:
            logging.warning(f"[Agent] integration '{name}' ({endpoint}) dropped: {type(e).__name__}: {e}")
    return out


def _connect_integration(spec, stack):
    """Open ONE egress-READ integration MCP session (kept live via ``stack`` for the agent run) and
    return its exposed tools. Raises on SSRF/unknown-transport/connect/list error → the caller
    (gather_integration_tools) isolates it. Credentials are fetched at runtime from Secrets Manager
    by reference (the payload carries only the ARN, never plaintext — ADR-039 Q3=B)."""
    endpoint = spec.get("endpoint")
    transport = spec.get("transport")
    allow_private = bool(spec.get("allowPrivate"))
    exposed = spec.get("exposedTools") or []
    # Connection-time SSRF (https + DNS resolve-and-recheck + private opt-in) BEFORE any network call.
    _assert_host_allowed(endpoint, allow_private)
    if transport == 'sigv4':
        # service is REQUIRED (sigv4_params raises if absent) — never silently reuse the gateway signer.
        service, region = sigv4_params(endpoint, spec.get("sigv4Service"), spec.get("sigv4Region"))
        ak, sk, tok = get_aws_credentials()
        creds = Credentials(access_key=ak, secret_key=sk, token=tok)
        client = MCPClient(lambda: streamablehttp_client_with_sigv4(
            url=endpoint, credentials=creds, service=service, region=region,
            timeout=INTEGRATION_CONNECT_TIMEOUT))
    else:
        secret = parse_secret(_get_secret(spec["credentialsRef"])) if spec.get("credentialsRef") else {}
        headers = auth_headers(transport, secret)  # ValueError on unknown transport
        client = MCPClient(lambda: streamablehttp_client_with_headers(
            url=endpoint, headers=headers, timeout=INTEGRATION_CONNECT_TIMEOUT))
    stack.enter_context(client)
    live = get_all_tools(client)
    selected = select_integration_tools(live, exposed)
    logging.info(f"[Agent] integration '{spec.get('name')}' [{transport}] tools "
                 f"({len(selected)}/{len(live)}): {[t.tool_name for t in selected]}")
    return selected


def get_aws_credentials():
    """Get current AWS credentials for SigV4 signing. / 현재 AWS 자격 증명을 가져와 SigV4 서명에 사용."""
    session = boto3.Session()
    creds = session.get_credentials()
    if creds:
        frozen = creds.get_frozen_credentials()
        return frozen.access_key, frozen.secret_key, frozen.token
    return None, None, None


def create_gateway_transport(gateway_url):
    """Create SigV4-signed transport to a specific Gateway. / 특정 게이트웨이에 대한 SigV4 서명된 전송 생성."""
    access_key, secret_key, session_token = get_aws_credentials()
    credentials = Credentials(
        access_key=access_key,
        secret_key=secret_key,
        token=session_token,
    )
    return streamablehttp_client_with_sigv4(
        url=gateway_url,
        credentials=credentials,
        service=SERVICE,
        region=GATEWAY_REGION,
    )


def get_all_tools(client):
    """Get all tools from MCP client with pagination. / MCP 클라이언트에서 페이지네이션으로 모든 도구 조회."""
    tools = []
    more = True
    token = None
    while more:
        batch = client.list_tools_sync(pagination_token=token)
        tools.extend(batch)
        if batch.pagination_token is None:
            more = False
        else:
            token = batch.pagination_token
    return tools


class LanguageReminderHook(HookProvider):
    """Append a target-language reminder to EVERY tool result (max recency).

    The system-prompt sandwich + user-turn suffix alone still lose stochastically
    (live-tested 2026-07-28: zh/en flipped back to the Korean question's language on
    ~10-30% of runs whenever a large inventory tool result was the last turn). A
    reminder INSIDE each tool result is always the most recent instruction the model
    sees before continuing, which is what finally holds the language deterministically.
    Best-effort by design: any failure must never break the tool loop.
    """

    def __init__(self, reminder_text):
        self._reminder = reminder_text

    def register_hooks(self, registry: HookRegistry, **kwargs) -> None:
        registry.add_callback(AfterToolCallEvent, self._after_tool)

    def _after_tool(self, event) -> None:
        try:
            content = (event.result or {}).get("content")
            if isinstance(content, list):
                content.append({"text": self._reminder})
        except Exception:
            pass


# Tool-result language reminders (target-language text — native priming holds best).
LANG_TOOL_REMINDER = {
    "ko": "[도구 결과 수신 — 최종 답변은 반드시 한국어로 작성]",
    "en": "[Tool result received — write the final answer in English only, never in Korean]",
    "zh": "[已收到工具结果 — 最终回答必须仅使用简体中文，禁止使用韩语]",
    "ja": "[ツール結果受信 — 最終回答は必ず日本語のみで書くこと、韓国語は禁止]",
}


def build_conversation(payload):
    """Extract user input and conversation history from payload. / 페이로드에서 사용자 입력과 대화 히스토리 추출."""
    messages_list = payload.get("messages", [])
    if messages_list and isinstance(messages_list, list):
        history = []
        for msg in messages_list[:-1]:
            role = msg.get("role", "user")
            content = msg.get("content", "")
            if role in ("user", "assistant") and content:
                history.append({"role": role, "content": [{"text": content}]})
        last_msg = messages_list[-1]
        user_input = last_msg.get("content", "")
        return user_input, history

    # Legacy format / 레거시 형식
    user_input = payload.get("prompt", payload.get("message", ""))
    return user_input, []


# Host-account resolution (_host_account_id / effective_account_id) lives in
# account_utils.py so it is importable by tests without agent.py's runtime deps.
def build_account_directive(account_id, account_alias):
    """Build cross-account directive for system prompt. / 시스템 프롬프트용 크로스 어카운트 지시문 생성."""
    if not account_id or account_id == '__all__':
        return ''
    return f"""

## MANDATORY: Target Account
You are operating on AWS account: {account_alias} ({account_id}).
You MUST include "target_account_id": "{account_id}" in EVERY tool call's arguments.
This is a non-negotiable requirement for cross-account access."""


async def _stream_text(agent, user_input):
    """Yield assistant text deltas from a Strands agent run as ``{"delta": str}`` chunks,
    plus one ``{"tool": name}`` chunk per tool invocation (answer-provenance footer).

    Strands' ``stream_async`` yields a stream of event dicts; the incremental assistant
    text arrives under the ``"data"`` key. Tool-use events carry ``"current_tool_use"``
    and fire repeatedly while the tool input streams in — dedupe on ``toolUseId`` and
    skip events whose ``name`` hasn't arrived yet. Other lifecycle events are skipped
    (the agent loop still runs them — we just don't surface them). AgentCore Runtime
    JSON-encodes each yielded dict into an SSE ``data:`` frame, so embedded newlines
    are escaped and stay frame-safe. Old web images drop ``{"tool": ...}`` / ``{"model": ...}``
    / ``{"toolInput": ...}`` / ``{"usage": ...}`` frames as empty deltas, so agent/web can
    deploy in either order.

    v1-parity frames (2026-07-19):
    - ``{"toolInput": {"tool", "query"}}`` — the generated query (SQL/PromQL/LogQL/...) a tool
      is about to run, so the UI can show WHAT is being executed, not just the tool name. The
      tool input streams in fragments, so it is only emitted once complete — flushed when the
      next text delta arrives or a different tool starts (and at end-of-stream).
    - ``{"usage": {"inputTokens", "outputTokens"}}`` — accumulated token usage from the final
      Strands result metrics (per-answer cost footer)."""
    yield {"model": MODEL_ID}  # answer provenance: which model produced this (footer)
    seen_tools = set()
    pending = {}   # toolUseId -> {"name", "input"} — last (most complete) streamed input
    cur_tid = None

    def flush_tool_input(tid):
        entry = pending.pop(tid, None)
        if not entry:
            return None
        q = _extract_tool_query(entry["name"], entry["input"])
        return {"toolInput": {"tool": entry["name"], "query": q}} if q else None

    async for event in agent.stream_async(user_input):
        if "data" in event:
            if cur_tid:  # text resumed → the pending tool call's input is final
                frame = flush_tool_input(cur_tid)
                cur_tid = None
                if frame:
                    yield frame
            yield {"delta": event["data"]}
        tu = event.get("current_tool_use") or {}
        tool_use_id, tool_name = tu.get("toolUseId"), tu.get("name")
        if tool_use_id and tool_name:
            if cur_tid and cur_tid != tool_use_id:  # next tool started → previous input is final
                frame = flush_tool_input(cur_tid)
                if frame:
                    yield frame
            if tool_use_id not in seen_tools:
                seen_tools.add(tool_use_id)
                yield {"tool": tool_name}
            pending[tool_use_id] = {"name": tool_name, "input": tu.get("input")}
            cur_tid = tool_use_id
        res = event.get("result")
        if res is not None:  # final AgentResult → accumulated usage for the cost footer
            usage = _extract_usage(res)
            if usage:
                yield {"usage": usage}
    if cur_tid:  # answer ended right after a tool call (no trailing text delta)
        frame = flush_tool_input(cur_tid)
        if frame:
            yield frame


# Query-ish keys surfaced to the UI, in priority order (v1 showed the generated SQL/PromQL
# in the status line). Only string values count; capped so a huge query can't bloat a frame.
_QUERY_KEYS = ("sql", "query", "promql", "logql", "traceql", "expr", "query_string", "statement")
_QUERY_MAX = 800


def _extract_tool_query(tool_name, raw_input):
    """Best-effort: pull the human-meaningful query text out of a completed tool input.
    ``raw_input`` may be a dict, a complete JSON string, or a partial fragment (→ None)."""
    obj = raw_input
    if isinstance(obj, str):
        try:
            obj = json.loads(obj)
        except (ValueError, TypeError):
            return None  # partial fragment — never surface half a query
    if not isinstance(obj, dict):
        return None
    for k in _QUERY_KEYS:
        v = obj.get(k)
        if isinstance(v, str) and v.strip():
            return v.strip()[:_QUERY_MAX]
    return None


def _extract_usage(result):
    """Accumulated token usage from a Strands AgentResult (defensive: SDK shape may drift)."""
    try:
        metrics = getattr(result, "metrics", None)
        au = getattr(metrics, "accumulated_usage", None) if metrics else None
        if not au:
            return None
        get = au.get if isinstance(au, dict) else lambda k, d=None: getattr(au, k, d)
        inp, out = get("inputTokens"), get("outputTokens")
        if not isinstance(inp, int) or not isinstance(out, int):
            return None
        return {"inputTokens": inp, "outputTokens": out}
    except Exception:
        return None  # provenance is best-effort — never break the answer stream


# Main handler / 메인 핸들러
# Streaming entrypoint: yields ``{"delta": str}`` chunks → AgentCore Runtime streams them
# back as SSE (text/event-stream). The web BFF forwards each delta to the browser, so the
# user sees real incremental tokens (the previous version buffered the full answer and the
# BFF faked a typewriter). callback_handler=None disables Strands' default stdout printer.
@app.entrypoint
async def handler(payload):
    # ADR-006 RCA (EoG) — a second, read-only execution path distinct from chat. The
    # deterministic controller returns a structured dict (NOT a token stream), so it
    # short-circuits before build_conversation / the no-input guard. Flag-gated inside
    # handle_rca (RCA_ORCHESTRATOR_ENABLED); returns {"disabled": True} when off.
    if payload.get("mode") == "rca":
        # NOTE: `handler` is an async generator (it `yield`s deltas), so a bare `return <value>`
        # is a SyntaxError. Emit the structured RCA dict as a single event, then end the stream.
        # (RCA is flag-OFF/backlog — the runtime streaming contract for this dict is owned by the
        # RCA orchestrator and should be verified there before it goes live.)
        from rca_orchestrator import handle_rca
        yield handle_rca(payload)
        return

    # Flag-gated dark path (ADR-008 amended 2026-06-24, BASELINE §2): a custom Anthropic-SDK-on-
    # Bedrock loop that replaces ONLY the Strands agent loop (lever = tool-loop debuggability).
    # Default OFF (ANTHROPIC_AGENT_LOOP_ENABLED); per-request override via payload.agentLoop.
    # Minimal slice — integrations (egress MCP) still route to the Strands path below.
    from anthropic_loop import should_use_anthropic_loop
    if should_use_anthropic_loop(payload) and not payload.get("integrations"):
        from anthropic_loop import run_anthropic_loop
        async for chunk in run_anthropic_loop(payload):
            yield chunk
        return

    user_input, history = build_conversation(payload)
    if not user_input:
        yield {"delta": "No input provided."}
        return

    gateway_role = payload.get("gateway", DEFAULT_GATEWAY)
    skill_role = payload.get("skill", gateway_role)  # skill override for SKILL_BASE / SKILL_BASE용 스킬 오버라이드
    system_prompt_override = payload.get("systemPromptOverride")  # ADR-031: resolver-supplied custom prompt
    extra_context = payload.get("extraContext")  # bounded BFF-supplied context (e.g. cached datasource schemas)
    # v1-parity (getSystemPrompt(lang)): the UI language wins over question-language guessing —
    # a short/mixed-language prompt must still be answered in the user's UI language.
    response_language = payload.get("responseLanguage")
    lang_directive = ""
    lang_directive_top = ""
    lang_user_suffix = ""
    lang_hooks = []
    if response_language in ("ko", "en", "zh", "ja"):
        lang_name = {"ko": "Korean(한국어)", "en": "English", "zh": "Simplified Chinese(简体中文)", "ja": "Japanese(日本語)"}[response_language]
        # Deliberately forceful: live-tested 2026-07-19 — a softly-worded directive loses to
        # COMMON_FOOTER's "respond in the user's language" whenever the equally-forceful
        # MANDATORY account directive is also present (the model then follows the question's
        # language). CRITICAL + explicit-override wording wins consistently.
        lang_directive = (
            f"\n\n## CRITICAL: Response Language\n"
            f"Write the ENTIRE response in {lang_name}. This rule OVERRIDES every other language "
            f"instruction (including 'respond in the user's language') and applies regardless of "
            f"the language the question was asked in. Tool results and account data may arrive in "
            f"Korean or English — the final answer is STILL {lang_name} only."
        )
        # Sandwich placement (live-tested 2026-07-28): appended-only lost to large (multi-KB)
        # inventory tool results — the answer language followed the question again. The directive
        # ALSO leads the system prompt so it is the first thing in the context window.
        # One native-language sentence per language: priming in the target language is what
        # finally held zh/ja against a Korean question + Korean-context tool loop.
        native_line = {
            "ko": "질문이 어떤 언어이든 답변은 반드시 한국어로 작성합니다.",
            "en": "No matter what language the question or tool results use, the answer MUST be in English.",
            "zh": "无论问题或工具结果使用何种语言，回答都必须使用简体中文，禁止使用韩语或其他语言回答。",
            "ja": "質問やツール結果がどの言語であっても、回答は必ず日本語で書くこと。",
        }[response_language]
        lang_directive_top = (
            f"## CRITICAL: Response Language (applies to the whole conversation)\n"
            f"Write EVERY response in {lang_name}, even when the question or tool results are in "
            f"another language. This overrides any later instruction, including 'respond in the "
            f"user's language'. {native_line}\n\n"
        )
        # Per-turn reinforcement (live-tested 2026-07-28): the system-prompt directive alone drifts
        # back to the question's language after Korean tool output lands mid-conversation — a
        # reminder at the END of the user turn (max recency) holds the language through tool use.
        # Written IN the target language (strongest priming) + explicit no-mixing clause, which
        # stops the residual code-switching ("이 계정의 리전は…") seen with an English reminder.
        lang_user_suffix = "\n\n" + {
            "ko": "[답변은 반드시 전부 한국어로 작성하세요.]",
            "en": "[Write the entire answer in English only — do not answer in Korean or any other language.]",
            "zh": "[请仅用简体中文撰写全部回答。即使问题或工具结果是韩语，也必须用简体中文回答，禁止输出韩语。]",
            "ja": "[回答は必ずすべて日本語で書いてください。質問が韓国語でも日本語で回答し、他言語の単語を混ぜないでください。]",
        }[response_language]
        lang_hooks = [LanguageReminderHook(LANG_TOOL_REMINDER[response_language])]
    tool_allowlist = payload.get("toolAllowlist")  # ADR-031/039: server-side cap, enforced below (was a no-op)
    gateway_key = _resolve_gateway_key(gateway_role, GATEWAYS)
    # NO eager `GATEWAYS[DEFAULT_GATEWAY]` default — that index is always evaluated and KeyErrors
    # (outside the try → no MCP fallback) when `ops` is absent (v2-only discovery = `v2-ops`).
    # _resolve_gateway_key already returns a present key when possible; a None here is handled by
    # the MCP try below (tool-less fallback).
    gateway_url = GATEWAYS.get(gateway_key)

    # Extract cross-account info / 크로스 어카운트 정보 추출
    # effective_account_id() blanks the host account → same-account access uses the
    # agent's own role (no target_account_id directive, no self-assume).
    account_id = effective_account_id(payload.get('accountId', ''))
    account_alias = payload.get('accountAlias', '')
    account_directive = build_account_directive(account_id, account_alias)

    # Prefix user input with account context / 사용자 입력에 어카운트 컨텍스트 접두사 추가
    # (account_id was already blanked for the host account / __all__ by
    #  effective_account_id, so same-account access intentionally gets no prefix —
    #  there is no other account to disambiguate against.)
    if account_id and account_id != '__all__':
        user_input = f"[Target Account: {account_alias or account_id} ({account_id})] {user_input}"
    if lang_user_suffix:
        user_input = f"{user_input}{lang_user_suffix}"

    # ADR-039 P2-infra inc2: enabled egress-READ integrations the resolver surfaced (live MCP connect).
    integrations = payload.get("integrations") or []

    logging.info(f"Gateway: {gateway_role} -> {gateway_url} (history: {len(history)} messages, account: {account_id or 'default'}, integrations: {len(integrations)})")

    # `started` guards the fallback: once we have streamed even one delta to the client we must
    # NOT re-run the Bedrock-direct fallback — that would duplicate the partial answer. The fallback
    # therefore only fires on a failure BEFORE the first token (i.e. MCP connect / tool discovery),
    # which is exactly what the original try/except guarded against.
    started = False
    try:
        mcp_client = MCPClient(lambda: create_gateway_transport(gateway_url))

        # ExitStack keeps the gateway AND every integration MCP session live for the whole stream.
        with ExitStack() as stack:
            stack.enter_context(mcp_client)
            gateway_tools = get_all_tools(mcp_client)
            # ADR-039: live-connect each enabled egress-READ integration. Per-integration failures are
            # ISOLATED here (gateway tools always survive) — NOT escalated to the Bedrock-direct fallback.
            integration_tools = gather_integration_tools(
                integrations, lambda spec: _connect_integration(spec, stack))
            # ADR-031/039: enforce the resolver-computed allowlist OUTSIDE the model over BOTH gateway +
            # integration tools BEFORE the prompt tool-list and Agent(tools=) are built (cap is the ceiling).
            # Dedup first (gateway precedence) so a name collision never hands Agent two same-named tools.
            tools = _filter_tools(_dedup_by_tool_name(gateway_tools + integration_tools), tool_allowlist)
            tool_names = [t.tool_name for t in tools]
            logging.info(f"Gateway [{gateway_role}] tools ({len(tools)} = {len(gateway_tools)} gw + {len(integration_tools)} integ, allowlist={'on' if tool_allowlist else 'off'}): {tool_names}")

            # ADR-031: resolver override (custom agent) OR built-in SKILL_BASE; + dynamic tools + account directive
            if system_prompt_override:
                tool_lines = []
                for t in tools:
                    desc = getattr(t, 'description', '') or ''
                    short = desc.split('.')[0].strip() if desc else t.tool_name
                    tool_lines.append(f"- **{t.tool_name}**: {short}")
                tool_section = f"\n\n## Available Tools ({len(tools)}):\n" + "\n".join(tool_lines)
                system_prompt = system_prompt_override + tool_section + COMMON_FOOTER + account_directive
            else:
                system_prompt = build_skill_prompt(skill_role, tools) + account_directive

            # Cached datasource schemas (and any other BFF-supplied context) reach BOTH branches here.
            if extra_context:
                system_prompt = system_prompt + "\n\n" + str(extra_context)[:8000]
            # Sandwich: directive leads AND closes the system prompt (see lang_directive_top note).
            system_prompt = lang_directive_top + system_prompt + lang_directive
            # stdout diagnostic (root logging is not surfaced by the runtime log capture):
            # no user content — just whether the language controls made it into this run.
            print(f"lang-diag: lang={response_language} directive={'CRITICAL: Response Language' in system_prompt} "
                  f"suffix={user_input.endswith(']')} tools={len(tools)} sys_len={len(system_prompt)}", flush=True)

            agent = Agent(
                model=model,
                tools=tools,
                system_prompt=system_prompt,
                messages=history if history else None,
                callback_handler=None,
                hooks=lang_hooks,  # tool-result language reminder (no-op when responseLanguage unset)
            )

            async for chunk in _stream_text(agent, user_input):
                started = True
                yield chunk
        return

    except Exception as e:
        logging.error(f"Gateway MCP error [{gateway_role}]: {e}")
        if started:
            # We already streamed a partial answer; re-running would duplicate it. End gracefully.
            yield {"delta": "\n\n_[연결이 중단되어 응답이 일부만 전달되었습니다.]_"}
            return

    # Fallback: Bedrock direct with base prompt only (reached only on a pre-stream gateway failure).
    # 폴백: 베이스 프롬프트만으로 Bedrock 직접 호출 (스트림 시작 전 게이트웨이 실패 시에만 도달).
    base_prompt = (system_prompt_override or SKILL_BASE.get(skill_role, SKILL_BASE[DEFAULT_GATEWAY])) + COMMON_FOOTER + account_directive
    if extra_context:
        base_prompt = base_prompt + "\n\n" + str(extra_context)[:8000]
    base_prompt = lang_directive_top + base_prompt + lang_directive
    agent = Agent(
        model=model,
        system_prompt=base_prompt,
        messages=history if history else None,
        callback_handler=None,
        hooks=lang_hooks,  # tool-less fallback still benefits if tools attach later
    )
    async for chunk in _stream_text(agent, user_input):
        yield chunk


if __name__ == "__main__":
    app.run()
