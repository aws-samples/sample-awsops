"""Customer-facing architecture view of the admitted projection used by the specialists."""
from collections import Counter, defaultdict
from itertools import zip_longest
from . import presentation as view

# The evidence type determines what the reader can conclude about an endpoint pair.
_COPY = {
    "ko": ("현재 아키텍처", "분석에 포함된 구성요소", "유형", "수", "대표 리소스",
           "관계 유형", "양 끝점", "관측 근거와 범위", "호출 표본", "네트워크 흐름 (방향 미확정)",
           "DNS 조회", "구성 관계", "허용 경로", "검증된 구성요소가 없습니다.",
           "양 끝점을 확인한 관계가 없습니다. 리소스 목록만으로 서비스 호출이나 장애 전파 경로를 판정할 수 없습니다.",
           "아래 수치는 이번 분석에 포함된 범위입니다. 구성·허용·DNS 정보만으로 실제 서비스 호출을 확정할 수 없습니다.",
           "표시한 관계 / 분석에 포함된 관계", "트래픽 방향과 실행 리소스의 연결 여부는 원천 근거의 범위를 따릅니다."),
    "en": ("Current architecture", "Components in the assessed scope", "Type", "Count", "Example resource",
           "Relationship", "Endpoints", "Source and scope", "Observed call", "Network flow (direction unconfirmed)",
           "DNS lookup", "Configuration", "Permitted path", "No verified components were available.",
           "No relationship with verified endpoints was available. Inventory alone cannot establish a call or failure path.",
           "Counts cover the assessed projection. Configuration, permissions and DNS alone cannot establish a service call.",
           "Relationships shown / in scope", "Direction and workload attribution depend on the source evidence."),
    "ja": ("現在のアーキテクチャ", "分析対象の構成要素", "種類", "件数", "リソース例", "関係", "両端", "根拠と範囲",
           "観測された呼び出し", "ネットワークフロー（方向未確認）", "DNS 照会", "構成上の関係", "許可された経路",
           "確認済みの構成要素がありません。", "両端が確認できた関係がありません。構成一覧だけでは呼び出しや障害の波及経路を確定できません。",
           "件数は今回の分析範囲です。構成・許可・DNS だけでは実際の呼び出しを確定できません。",
           "表示した関係 / 分析対象の関係", "通信方向と実行リソースとの対応は観測範囲に依存します。"),
    "zh": ("当前架构", "本次评估的组件", "类型", "数量", "资源示例", "关系", "两个端点", "证据和范围",
           "观测到的调用", "网络流（方向未确认）", "DNS 查询", "配置关系", "允许的路径",
           "没有已验证的组件。", "没有两端均已确认的关系。仅凭清单无法判断调用关系或故障传播路径。",
           "数量只涵盖本次分析范围。配置、权限及 DNS 记录本身不足以确认服务调用。",
           "显示关系 / 评估范围内关系", "流量方向和工作负载归属取决于证据范围。"),
}
_KINDS = ("observed_call", "observed_network_flow", "observed_dns_resolution", "configured_dependency", "allowed_path")


def section(bundle, lang, priority_resources=()):
    (title, components, type_label, count_label, example, relation, endpoints, source,
     *descriptions, empty, no_edges, scope_note, shown, direction_note) = _COPY[lang]
    relation_labels = dict(zip(_KINDS, descriptions))
    resources = {r["id"]: r for r in bundle.get("resources", [])}
    evidence = {e["id"]: e for e in bundle.get("evidence", [])}
    body = ["[Info]", scope_note, f"### {components}"]
    kinds = Counter(r["kind"] for r in resources.values())
    if kinds:
        examples = {}
        for r in sorted(resources.values(), key=lambda r: r["resource_id"]):
            examples.setdefault(r["kind"], r["resource_id"])
        table = [f"| {type_label} | {count_label} | {example} |", "| --- | ---: | --- |"]
        for kind, count in sorted(kinds.items(), key=lambda item: (-item[1], item[0])):
            table.append(f"| {view._code(kind)} | {count} | {view._code(examples[kind])} |")
        body.append("\n".join(table))
    else:
        body.append(empty)

    def endpoint(key):
        resource = resources[key]
        name = view._code(resource["resource_id"])
        region = resource.get("region")
        return f"{name} ({view._code(region)})" if region else name

    groups = defaultdict(list)
    for edge in bundle.get("relationships", []):
        kind = edge["kind"]
        if kind not in _KINDS or edge["source"] not in resources or edge["target"] not in resources:
            continue
        # Each citation already passed EvidenceIndex admission. Keep its scope with the pair.
        cited = [evidence[i] for i in edge["evidence_ids"] if i in evidence]
        if not cited:
            continue
        a, b = endpoint(edge["source"]), endpoint(edge["target"])
        refs = []
        for record in cited:
            scope = {k: record[k] for k in ("kind", "region", "regions", "window", "captured_at", "fresh")
                     if k in record}
            scope["coverage"] = {k: v for k, v in record.get("coverage", {}).items()
                                 if k in {"sampled", "complete", "sample_ratio"}}
            facts = record.get("facts", {})
            details = [record.get("source"), facts.get("relation"), facts.get("resource_binding"),
                       view._scope_text(scope, lang)]
            refs.append(view._cell(view._scrubbed(" · ".join(str(v) for v in details if v))))
        label = relation_labels[kind]
        pair = f"{a} → {b}" if kind == "observed_call" else f"{a} / {b}"
        row = f"| {label} | {pair} | {'; '.join(dict.fromkeys(refs))} |"
        rank = (not all(r.get("fresh") is True for r in cited),
                not any(ref in priority_resources for ref in (edge["source"], edge["target"])), edge["id"])
        groups[kind].append((rank, row))
    if groups:
        table = [f"| {relation} | {endpoints} | {source} |", "| --- | --- | --- |"]
        # Include different evidence classes before filling the remaining example slots.
        batches = zip_longest(*(sorted(groups.get(kind, ())) for kind in _KINDS))
        rows = [item[1] for batch in batches for item in batch if item is not None][:12]
        body.extend([f"{shown} · {len(rows)} / {sum(map(len, groups.values()))}", "\n".join(table + rows), direction_note])
    else:
        body.append(no_edges)
    if resources:
        # Distinguish the customer's next investigation by the kind of evidence available.
        has_call = bool(groups.get("observed_call"))
        guidance = {
            "ko": ("대표 서비스 요청의 트레이스에서 호출자와 목적지를 같은 관측으로 확인하세요. 실행 워크로드와 연결되면 같은 시간대의 지연·오류를 비교해 영향 범위를 판단할 수 있습니다.",
                   "주요 업무 한 건의 진입점, 실행 주체, 데이터 목적지를 소유자와 대조하세요. 같은 요청의 호출 근거를 확보하기 전에는 배치·네트워크 정보만으로 장애 영향을 특정하기 어렵습니다."),
            "en": ("Check both ends in a trace for a representative request. Once bound to the running workload, compare latency and errors in that interval to assess impact.",
                   "Trace one important workload from entry point through execution to its data destination with the owner. Establish the same-request call before attributing impact from placement or network data."),
            "ja": ("代表リクエストの同一トレースで呼び出し元と宛先を確認し、実行主体を特定した後、同時間帯の遅延・エラーを比較します。",
                   "主要業務の入口・実行主体・データ宛先を所有者と確認し、同一リクエストの呼び出し根拠を取得して影響範囲を判断します。"),
            "zh": ("在典型请求的同一条追踪中核对调用双方。关联到执行工作负载后，对照同时段的延迟和错误来判断影响。",
                   "与负责人核对关键业务的入口、执行主体和数据目的地。先取得同一请求的调用证据，再判断故障影响范围。"),
        }[lang]
        body.append(guidance[0] if has_call else guidance[1])
    return {"key": "architecture", "title": title, "body": "\n\n".join(body)}
