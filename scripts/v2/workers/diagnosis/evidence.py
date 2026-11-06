"""Code-owned evidence admission and semantic checks for untrusted model selections."""
from copy import deepcopy
from datetime import datetime
import math
import re


PILLARS = (
    "operational_excellence", "security", "reliability",
    "performance_efficiency", "cost_optimization", "sustainability",
)
CLAIMS = ("observation", "hypothesis", "sizing_candidate", "coverage_gap")
VERIFICATIONS = ("none", "resource_metrics", "provider_sizing", "graph_refresh")
KINDS = {
    "observed_call", "observed_network_flow", "observed_dns_resolution", "configured_dependency",
    "allowed_path", "candidate", "metrics", "provider_sizing", "inventory", "scope_summary",
}
FINDING_KEYS = {
    "id", "pillar", "severity", "resource_ids", "evidence_ids", "claim",
    "explanation", "prerequisites", "verification",
}
MIN_SAMPLE_RATIO = 0.8
# Only documented discovery projections enter the model context. Nested metrics
# retain numeric statistics, not arbitrary attribute maps/log/trace/config bodies.
FACT_KEYS = {
    "instance_type", "instance_id", "instance_state", "class", "engine", "version",
    "status", "state", "storage", "storage_type", "storageType", "endpoint", "port",
    "vpc_id", "vpcId", "subnet_id", "subnet_ids", "security_groups", "securityGroups",
    "private_ip", "private_ips", "eni_id", "eni_ids", "multi_az", "multiAZ",
    "replica", "writer", "members", "encrypted", "publicly_accessible",
    "backup_retention", "deletion_protection", "protected", "protected_tags",
    "current_type", "recommended_type", "resource_type", "lookback_days",
    "window_days", "performance_risk", "monthly_savings", "currency",
    "generation_time", "guard_hits", "missing_memory", "missing_io", "rank",
    "utilization", "projected_utilization", "savings_basis", "replica_source",
    "metrics", "dimensions", "metric_name", "namespace", "statistic", "period",
    "average", "maximum", "minimum", "p95", "peak", "value", "unit",
    "min", "max", "mean", "samples", "Name", "Value", "name",
    "sample_count", "expected_samples", "sample_ratio", "missing_metrics",
    "finding", "reason", "risk", "prerequisites", "correlation_id",
    "source_ref", "target_ref", "instance_ref", "database_ref", "instance_observations",
    "account", "region", "instance_id", "observed_pairs", "service_ref",
    "service", "service_name", "source", "target", "kind", "binding",
    "binding_evidence", "window", "start", "end", "captured_at", "fresh",
    "lookback", "complete", "coverage", "count", "total", "returned",
    "omitted", "truncated", "more_pages", "sampled", "confidence",
    "spanCount", "metricCount", "observationCount", "sampleCount",
    "collection", "readOutcome", "snapshotConsistent", "evidence_ids",
    "db_host", "relation", "provenance", "source_id", "pages",
    "regions", "region_coverage", "scope", "storage_scope", "inventory",
    "db_instance_class", "db_instance_identifier", "endpoint_address",
    "private_ip_address", "storage_encrypted", "backup_retention_period", "tags",
    "awsops:protected", "awsops:critical", "environment", "Environment", "env",
    "Owner", "owner", "Service", "graph_class",
    "Maximum", "Minimum", "Average", "Sum", "SampleCount",
    "cost_groups", "amount", "estimated", "partial_month", "posture_counts",
    "continuation", "change_events", "event_name", "event_source", "event_time",
    "commitment_coverage", "percentage", "resource_cost",
    "selected", "configured", "matched", "resources", "evidence", "relationships",
    "graph", "flow", "infra", "trace", "xray", "supporting", "sources", "sourceId",
    "lastSuccessAt", "producer_status", "unknown_attributes", "producerStatus",
    "itemCount", "windowStartMs", "windowEndMs", "capturedAtMs", "lastSuccessAtMs",
    "attemptedAtMs", "finishedAtMs", "reasons", "retained_previous",
    "instance_observations_omitted",
    "query_name", "dns_timestamp", "answer_ips", "ttl_known", "direction", "destination_category",
    "dns_source_id",
    # X-Ray service-graph edges: service references/names, call statistics and the
    # explicit binding marker that keeps unresolved service nodes out of observations.
    "from_ref", "to_ref", "from_name", "to_name", "calls", "error_rate", "fault_rate", "resource_binding",
    "architecture", "enabled",
}
# Compute Optimizer directions that are downsizing opportunities (finops/rules.py parity).
# Underprovisioned (upsize) and Optimized rows never validate as sizing candidates.
_DOWNSIZE_FINDINGS = {"ec2": {"Overprovisioned", "NotOptimized"},
                      "rds": {"Overprovisioned"}, "rds_instance": {"Overprovisioned"}}
_HAN_NUMERALS = "〇零一二三四五六七八九十百千萬万億亿兆兩两壹贰貳叁參肆伍陆陸柒捌玖拾佰仟"
_EN_NUM = (r"(?:zero|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|"
           r"fourteen|fifteen|sixteen|seventeen|eighteen|nineteen|twenty|thirty|forty|fifty|sixty|"
           r"seventy|eighty|ninety|hundred|thousand|million|billion|trillion)")
_NUMBER = re.compile(
    r"\d|[%$€£¥₩¢]"
    # Recognize numeral sequences and measured counts, preserving ordinary words
    # such as 不一致 / 一貫性 that contain an isolated numeral character.
    rf"|(?!万一|萬一)[{_HAN_NUMERALS}]{{2,}}"
    rf"|(?:为|為|是|达到|達到|约|約|共|有|は|が|およそ)\s*[{_HAN_NUMERALS}]+"
    r"(?=[\s。．.!！?？,，;；:：、]|です|だ|程度|左右|以内|以上|以下|$)"
    rf"|[{_HAN_NUMERALS}]\s*(?:个|個|台|次|倍|天|秒|分钟|分鐘|小时|小時|"
    r"毫秒|パーセント|件|回|時間|年間|ヶ月|か月|円)"
    r"|(?:美元|人民币|人民幣|ドル|ユーロ|달러|위안|엔화)"
    # A one-syllable numeral glued to a counter is an ordinary word (조건, 이번, 구분, 만일).
    r"|(?<![가-힣])(?:(?:[영일이삼사오육칠팔구십백천만억조]{2,}|다섯|여섯|일곱|여덟|아홉|스물|서른|"
    r"마흔|예순|일흔|여든|아흔)\s*|(?:[영일이삼사오육칠팔구십백천만억조]|한|하나|두|둘|세|셋|네|넷|열|쉰)\s+)"
    r"(?:퍼센트|프로|원|개|번|일|시간|분|초|배|건|달)"
    # English number words count only before a unit/counter ("one subnet route" is prose).
    rf"|\b{_EN_NUM}(?:[\s-]+(?:and[\s-]+)?{_EN_NUM})*[\s-]*(?:percent|per\s*cent|percentage|"
    r"times|fold|x|ms|milli(?:second)?s?|seconds?|minutes?|hours?|days?|weeks?|months?|years?|"
    r"[kmgtp]i?b|bytes?|requests?|calls?|errors?|failures?|retries|attempts?|cents?|dollars?|euros?)\b"
    r"|\b(?:hundreds|thousands|millions|billions|trillions|dollars?|euros?|yen|USD|EUR|JPY|KRW)\b",
    re.IGNORECASE,
)
_ID = re.compile(r"^[A-Za-z][A-Za-z0-9._:-]{0,127}$")


def _project(value, depth=0, *, mapping=False):
    if depth > 7:
        return None
    if value is None or isinstance(value, (bool, int)):
        return value
    if isinstance(value, float):
        return value if math.isfinite(value) else None
    if isinstance(value, str):
        return value[:1024]
    if isinstance(value, list):
        return [_project(item, depth + 1) for item in value[:64]]
    if isinstance(value, dict):
        result = {}
        for key, item in list(value.items())[:96]:
            if not isinstance(key, str):
                continue
            if key in FACT_KEYS or (mapping and re.fullmatch(r"[A-Za-z][A-Za-z0-9_./-]{0,63}", key)):
                if re.search(r"secret|password|token|credential|raw|policy|user.?data", key, re.I):
                    continue
                result[key] = _project(item, depth + 1, mapping=key in {
                    "metrics", "dimensions", "posture_counts", "xray",
                })
        return result
    return None


def _finite(value, minimum=0):
    return type(value) in (int, float) and math.isfinite(value) and value >= minimum


def _timestamp(value):
    if not isinstance(value, str):
        return False
    try:
        return datetime.fromisoformat(value.replace("Z", "+00:00")).tzinfo is not None
    except ValueError:
        return False


def _string_list(value, limit=16):
    return (isinstance(value, list) and len(value) <= limit
            and all(isinstance(item, str) and 0 < len(item) <= 256 for item in value)
            and len(set(value)) == len(value))


class EvidenceIndex:
    def __init__(self, bundle, account):
        if not isinstance(account, str) or not re.fullmatch(r"\d{12}", account):
            raise ValueError("evidence requires an explicit account")
        self.account = account
        self.resources = {}
        self.evidence = {}
        self.relationships = {}
        self.rejected = []
        self.downgraded = []
        self._sizing_resources = set()
        self._finding_ids = set()
        self.bundle = bundle if isinstance(bundle, dict) else {}
        self.coverage = _project(self.bundle.get("coverage", {}), mapping=True)
        self.gaps = [str(value)[:256] for value in self.bundle.get("gaps", [])[:64]]
        self.degraded = [str(value)[:256] for value in self.bundle.get("degraded", [])[:64]]
        self.incomplete = [str(value)[:256] for value in self.bundle.get("incomplete", [])[:64]]
        self._admit_resources(self.bundle.get("resources", []))
        self._admit_evidence(self.bundle.get("evidence", []))
        self._admit_relationships(self.bundle.get("relationships", []))

    def _reject(self, item_id, reason, item_type="finding"):
        self.rejected.append({"id": str(item_id)[:128], "reason": reason, "type": item_type})
        return None

    def _unique_rows(self, rows, item_type):
        if not isinstance(rows, list):
            self._reject("", "invalid_records", item_type)
            return []
        counts = {}
        for row in rows:
            if isinstance(row, dict) and isinstance(row.get("id"), str):
                counts[row["id"]] = counts.get(row["id"], 0) + 1
        result = []
        for row in rows:
            row_id = row.get("id") if isinstance(row, dict) else None
            if not isinstance(row_id, str) or not row_id or len(row_id) > 256:
                self._reject("", "invalid_id", item_type)
            elif counts[row_id] != 1:
                self._reject(row_id, "duplicate_id", item_type)
            else:
                result.append(row)
        return result

    def _admit_resources(self, rows):
        rows = self._unique_rows(rows, "resource")
        identities = {}
        for row in rows:
            if all(isinstance(row.get(key), str) for key in ("account", "region", "kind", "resource_id")):
                identity = self._native_identity(row)
                identities[identity] = identities.get(identity, 0) + 1
        for row in rows:
            if row.get("account") != self.account:
                self._reject(row["id"], "wrong_account", "resource")
                continue
            if not isinstance(row.get("region"), str) or not re.fullmatch(r"[a-z]{2}(?:-gov)?-[a-z]+-\d|global", row["region"]):
                self._reject(row["id"], "invalid_region", "resource")
                continue
            if not isinstance(row.get("kind"), str) or not isinstance(row.get("resource_id"), str):
                self._reject(row["id"], "invalid_identity", "resource")
                continue
            if identities.get(self._native_identity(row), 0) != 1:
                self._reject(row["id"], "ambiguous_identity", "resource")
                continue
            native = row["resource_id"]
            if native.startswith("arn:"):
                parts = native.split(":", 5)
                if (len(parts) != 6 or (parts[4] and parts[4] != self.account)
                        or (parts[3] and parts[3] != row["region"])):
                    self._reject(row["id"], "arn_scope_mismatch", "resource")
                    continue
            self.resources[row["id"]] = {
                key: deepcopy(row[key]) for key in ("id", "account", "region", "kind", "resource_id")
            }
            facts = _project(row.get("facts", {}))
            self.resources[row["id"]]["facts"] = facts if isinstance(facts, dict) else {}

    @staticmethod
    def _native_identity(row):
        native = row["resource_id"]
        parts = native.split(":", 5)
        if len(parts) == 6 and parts[0] == "arn":
            if row["kind"] == "ec2" and parts[2] == "ec2" and parts[5].startswith("instance/"):
                native = parts[5][len("instance/"):]
            elif row["kind"] in {"rds", "rds_instance"} and parts[2] == "rds" and parts[5].startswith("db:"):
                native = parts[5][len("db:"):]
        kind = "rds" if row["kind"] == "rds_instance" else row["kind"]
        return row["account"], row["region"], kind, native

    def _admit_evidence(self, rows):
        for row in self._unique_rows(rows, "evidence"):
            refs = row.get("resource_ids")
            summary = (row.get("kind") == "scope_summary" and row.get("account") == self.account
                       and isinstance(row.get("region"), str)
                       and re.fullmatch(r"[a-z]{2}(?:-gov)?-[a-z]+-\d|global", row["region"]))
            if not _string_list(refs) or (not refs and not summary) or any(ref not in self.resources for ref in refs):
                self._reject(row["id"], "unknown_resource", "evidence")
                continue
            if row.get("account", self.account) != self.account:
                self._reject(row["id"], "wrong_account", "evidence")
                continue
            regions = {self.resources[ref]["region"] for ref in refs}
            if refs and row.get("region") is not None and regions != {row["region"]}:
                self._reject(row["id"], "wrong_region", "evidence")
                continue
            if not isinstance(row.get("kind"), str) or row["kind"] not in KINDS or not isinstance(row.get("source"), str):
                self._reject(row["id"], "unknown_source_kind", "evidence")
                continue
            self.evidence[row["id"]] = {
                "id": row["id"], "source": row["source"][:128], "kind": row["kind"],
                "resource_ids": list(refs), "account": self.account,
                "regions": sorted(regions) if refs else [row["region"]], "facts": _project(row.get("facts", {})),
                "fresh": row.get("fresh") is True and _timestamp(row.get("captured_at")),
                "captured_at": row.get("captured_at"), "window": _project(row.get("window", {})),
                "coverage": _project(row.get("coverage", {}), mapping=True),
            }

    def _admit_relationships(self, rows):
        for row in self._unique_rows(rows, "relationship"):
            if (not isinstance(row.get("source"), str) or not isinstance(row.get("target"), str)
                    or not isinstance(row.get("kind"), str)):
                self._reject(row["id"], "invalid_relationship", "relationship")
                continue
            endpoints = {row.get("source"), row.get("target")}
            refs = row.get("evidence_ids")
            if (None in endpoints or any(ref not in self.resources for ref in endpoints)
                    or row.get("kind") not in KINDS or not _string_list(refs) or not refs):
                self._reject(row["id"], "invalid_relationship", "relationship")
                continue
            if any(ref not in self.evidence or not endpoints.issubset(self.evidence[ref]["resource_ids"])
                   or self.evidence[ref]["kind"] != row["kind"] for ref in refs):
                self._reject(row["id"], "unsupported_relationship", "relationship")
                continue
            self.relationships[row["id"]] = {key: deepcopy(row[key]) for key in
                                            ("id", "source", "target", "kind", "evidence_ids")}

    def model_context(self):
        return deepcopy({
            "resources": list(self.resources.values()), "evidence": list(self.evidence.values()),
            "relationships": list(self.relationships.values()), "coverage": self.coverage,
            "gaps": self.gaps, "degraded": self.degraded, "incomplete": self.incomplete,
        })

    def admitted_bundle(self):
        """The exact sanitized records used for analysis and deterministic rendering."""
        return self.model_context()

    @staticmethod
    def _complete(row, *, sampled=False):
        """Freshness is not completeness: paginated/capped/partial reads stay unconfirmed."""
        coverage = row.get("coverage")
        if not isinstance(coverage, dict) or coverage.get("complete") is not True:
            return False
        return not sampled or (_finite(coverage.get("sample_ratio"), MIN_SAMPLE_RATIO)
                               and coverage["sample_ratio"] <= 1)

    def _observation_supported(self, finding):
        refs = finding["resource_ids"]
        cited = [self.evidence[ref] for ref in finding["evidence_ids"]]
        if not cited or any(not row["fresh"] for row in cited):
            return False
        if len(refs) == 1:
            return any(row["kind"] == "metrics" and refs[0] in row["resource_ids"]
                       and self._complete(row, sampled=True) for row in cited)
        # A referenced scoped edge must preserve the actual pair. Sharing a
        # service/SG or joining independent aggregates never creates an observed edge.
        return len(refs) == 2 and any(
            row["kind"] in {"observed_call", "observed_network_flow"}
            and {row["source"], row["target"]} == set(refs)
            and set(row["evidence_ids"]).issubset(finding["evidence_ids"])
            and all(isinstance(self.evidence[eid]["facts"], dict)
                    and self.evidence[eid]["facts"].get("binding") != "dns_window_correlation"
                    and self.evidence[eid]["facts"].get("resource_binding") != "unresolved"
                    and self._complete(self.evidence[eid])
                    for eid in row["evidence_ids"])
            for row in self.relationships.values()
        )

    def _sizing_supported(self, finding):
        if len(finding["resource_ids"]) != 1:
            return False
        resource = self.resources[finding["resource_ids"][0]]
        if resource["kind"] not in {"ec2", "rds", "rds_instance"}:
            return False
        rows = [self.evidence[ref] for ref in finding["evidence_ids"]]
        provider = [row for row in rows if row["kind"] == "provider_sizing"]
        metrics = [row for row in rows if row["kind"] == "metrics"]
        if (len(provider) != 1 or not metrics or any(not row["fresh"] for row in rows)
                or not self._complete(provider[0])
                or not all(self._complete(row, sampled=True) for row in metrics)):
            return False
        facts = provider[0]["facts"]
        if not isinstance(facts, dict):
            return False
        if facts.get("finding") not in _DOWNSIZE_FINDINGS.get(resource["kind"], set()):
            return False
        if (not _finite(facts.get("lookback_days"), 14)
                or not _finite(facts.get("performance_risk"))
                or not _finite(facts.get("rank"), 1)
                or not _timestamp(facts.get("generation_time"))
                or not isinstance(facts.get("current_type"), str)
                or not isinstance(facts.get("recommended_type"), str)
                or facts.get("guard_hits") != []
                or facts.get("missing_memory") is not False
                or facts.get("missing_io") is not False):
            return False
        savings = facts.get("monthly_savings")
        if savings is not None and (not _finite(savings)
                                   or not isinstance(facts.get("currency"), str)
                                   or not re.fullmatch(r"[A-Z]{3}", facts["currency"])):
            return False
        if resource["facts"].get("protected") is True or resource["facts"].get("protected_tags"):
            return False
        current_type = (resource["facts"].get("instance_type") if resource["kind"] == "ec2"
                        else resource["facts"].get("db_instance_class", resource["facts"].get("class")))
        if not current_type or facts["current_type"] != current_type:
            return False
        for row in metrics:
            details = row["facts"]
            coverage = row["coverage"]
            if (not isinstance(details, dict) or not isinstance(coverage, dict)
                    or not _finite(details.get("window_days", coverage.get("lookback_days")), 14)
                    or details.get("missing_memory") is not False
                    or details.get("missing_io") is not False):
                return False
            dimension = "InstanceId" if resource["kind"] == "ec2" else "DBInstanceIdentifier"
            dimensions = details.get("dimensions")
            if isinstance(dimensions, list):
                pairs = [(item.get("Name"), item.get("Value")) for item in dimensions
                         if isinstance(item, dict)]
                if len(pairs) != len(dimensions) or len(set(name for name, _ in pairs)) != len(pairs):
                    return False
                dimensions = dict(pairs)
            native_id = self._native_identity(resource)[3]
            if (not isinstance(dimensions, dict) or dimensions != {dimension: native_id}
                    or not self._pressure_supported(details.get("metrics"), resource["kind"])):
                return False
        return True

    @staticmethod
    def _pressure_supported(metrics, kind):
        if not isinstance(metrics, dict):
            return False
        required = [("CPUUtilization", "p95"), ("CPUUtilization", "Maximum")]
        if kind == "ec2":
            # A declared missing_memory=False never substitutes for measured memory.
            required += [("MemoryUtilization", "Maximum"), ("EBSReadBytes", "Sum"),
                         ("EBSWriteBytes", "Sum")]
        else:
            required += [("FreeableMemory", "Minimum"), ("DatabaseConnections", "Maximum"),
                         ("ReadIOPS", "Maximum"), ("WriteIOPS", "Maximum"),
                         ("ReadLatency", "p95"), ("WriteLatency", "p95"),
                         ("DiskQueueDepth", "Maximum")]
        for name, statistic in required:
            values = metrics.get(name)
            values = values.get(statistic) if isinstance(values, dict) else None
            if (not isinstance(values, dict) or values.get("status") != "Complete"
                    or not _finite(values.get("samples"), 1)
                    or not _finite(values.get("max"))):
                return False
        return True

    def validate_finding(self, finding, *, pillar=None):
        row_id = finding.get("id", "") if isinstance(finding, dict) else ""
        if not isinstance(finding, dict) or set(finding) != FINDING_KEYS:
            return self._reject(row_id, "invalid_shape")
        if any(not isinstance(finding[key], str) for key in
               ("id", "pillar", "severity", "claim", "verification")):
            return self._reject(row_id, "invalid_selection")
        if (not isinstance(row_id, str) or not _ID.fullmatch(row_id)
                or finding["pillar"] not in PILLARS or (pillar and finding["pillar"] != pillar)
                or finding["severity"] not in {"low", "medium", "high", "critical"}
                or finding["claim"] not in CLAIMS or finding["verification"] not in VERIFICATIONS):
            return self._reject(row_id, "invalid_selection")
        if not _string_list(finding["resource_ids"]) or not _string_list(finding["evidence_ids"]):
            return self._reject(row_id, "invalid_references")
        if any(ref not in self.resources for ref in finding["resource_ids"]):
            return self._reject(row_id, "unknown_resource")
        if any(ref not in self.evidence for ref in finding["evidence_ids"]):
            return self._reject(row_id, "unknown_evidence")
        cited = [self.evidence[ref] for ref in finding["evidence_ids"]]
        if any(not set(finding["resource_ids"]).issubset(row["resource_ids"]) for row in cited):
            return self._reject(row_id, "unrelated_evidence")
        if not isinstance(finding["explanation"], str) or not _string_list(finding["prerequisites"]):
            return self._reject(row_id, "invalid_explanation")
        text = [finding["explanation"], *finding["prerequisites"]]
        if any(len(value) > 2000 or _NUMBER.search(value) for value in text):
            return self._reject(row_id, "model_numeric_assertion")
        scoped_summary = (finding["claim"] in {"hypothesis", "coverage_gap"} and cited
                          and all(row["kind"] == "scope_summary" for row in cited))
        if finding["claim"] != "coverage_gap" and (
                (not finding["resource_ids"] and not scoped_summary) or not finding["evidence_ids"]):
            return self._reject(row_id, "missing_evidence")
        if row_id in self._finding_ids:
            return self._reject(row_id, "duplicate_finding_id")
        result = deepcopy(finding)
        if result["claim"] == "observation" and not self._observation_supported(result):
            result["claim"] = "hypothesis"
            self.downgraded.append({"id": row_id, "reason": "unconfirmed_observation"})
        if result["claim"] == "sizing_candidate":
            if not self._sizing_supported(result):
                if (len(result["resource_ids"]) != 1
                        or not any(row["kind"] == "provider_sizing" for row in cited)):
                    return self._reject(row_id, "unsupported_sizing")
                result["claim"] = "hypothesis"
                result["explanation"] = "Provider opportunity requires additional verification."
                result["prerequisites"] = [
                    "Verify representative utilization, resource identity and protection guards."
                ]
                self.downgraded.append({"id": row_id, "reason": "unsupported_sizing"})
            else:
                resource = result["resource_ids"][0]
                if resource in self._sizing_resources:
                    return self._reject(row_id, "duplicate_sizing")
                self._sizing_resources.add(resource)
        self._finding_ids.add(row_id)
        return result

    def validate_request(self, request):
        if (not isinstance(request, dict) or set(request) != {"capability", "resource_ids"}
                or not isinstance(request.get("capability"), str)
                or request["capability"] not in VERIFICATIONS[1:]
                or not _string_list(request.get("resource_ids"), limit=4)
                or not request["resource_ids"]
                or any(ref not in self.resources for ref in request["resource_ids"])):
            return self._reject("", "invalid_follow_up", "request")
        if request["capability"] in {"resource_metrics", "provider_sizing"}:
            if any(self.resources[ref]["kind"] not in {"ec2", "rds", "rds_instance", "rds_cluster"}
                   for ref in request["resource_ids"]):
                return self._reject("", "unsupported_resource_capability", "request")
        return {"capability": request["capability"], "resource_ids": sorted(request["resource_ids"])}
