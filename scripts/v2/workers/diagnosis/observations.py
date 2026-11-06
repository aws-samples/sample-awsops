"""Bounded host-only Resolver/NFM reads; DNS window matches remain hypotheses."""
import datetime as dt
import ipaddress
import json
import math
import os
import re
import time

from . import discovery as d

MAX_GROUPS = 8
MAX_REGIONS = 8
MAX_PAGES = 2
MAX_ROWS = 50
MAX_MONITORS = 2
MAX_QUERIES = 6
MAX_POLLS = 8  # Backoff waits up to ~7.75s per query inside the 35s stage deadline.
CATEGORIES = ("INTRA_AZ", "INTER_AZ", "INTER_VPC")
MAX_ANSWERS = 8
# Resolver query logs carry answers as [{"Rdata", "Type", "Class"}]. Logs Insights
# flattens JSON arrays into indexed fields (answers.0.Rdata), so the bounded query
# projects those explicitly; one extra index proves the answer list was not truncated.
_ANSWER_FIELDS = tuple(f"answers.{i}.{key}" for i in range(MAX_ANSWERS + 1)
                       for key in ("Type", "Rdata"))
DNS_FIELDS = ("account_id", "region", "vpc_id", "query_timestamp", "query_name",
              "rcode", "answers", "srcaddr", "instance", *_ANSWER_FIELDS)
DNS_QUERY = ("fields account_id, region, vpc_id, query_timestamp, query_name, rcode, "
             "answers, " + ", ".join(_ANSWER_FIELDS)
             + ", srcaddr, srcids.instance as instance | limit 50")
_sleep = time.sleep


def _ip(value):
    try:
        return str(ipaddress.ip_address(value)) if isinstance(value, str) else None
    except ValueError:
        return None


def _host(value):
    if not isinstance(value, str) or len(value) > 254:
        return None
    value = value.rstrip(".").lower()
    return value if re.fullmatch(r"[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?", value) else None


def _qualified(bundle):
    account = bundle.get("coverage", {}).get("account")
    regions = bundle.get("coverage", {}).get("regions", {}).get("selected", [])
    resources = {r.get("id"): r for r in bundle.get("resources", [])}
    captures = {}
    for item in bundle.get("evidence", []):
        stamp = d._stamp(item.get("captured_at"))
        if (item.get("kind") == "inventory" and item.get("fresh") is True
                and item.get("coverage", {}).get("complete") is True
                and item.get("account") == account and stamp and d._fresh(stamp, 300)):
            for rid in item.get("resource_ids", []):
                resource = resources.get(rid)
                facts = resource.get("facts", {}) if resource else {}
                recorded = item.get("facts", {})
                keys = ("vpc_id", "private_ip_address", "endpoint_address", "endpoint_port")
                if (resource and item.get("region") == resource.get("region")
                        and isinstance(recorded, dict) and all(recorded.get(key) == facts[key]
                        for key in keys if key in facts)):
                    captures[rid] = max(stamp, captures.get(rid, stamp))
    return [(r, captures[r["id"]]) for r in bundle.get("resources", [])
            if r.get("id") in captures and r.get("account") == account
            and r.get("region") in regions]


def _flattened_answers(row):
    if not any(key in row for key in _ANSWER_FIELDS):
        return None
    if any(row.get(f"answers.{MAX_ANSWERS}.{key}") is not None for key in ("Type", "Rdata")):
        return []  # more answers than projected: refuse rather than bind a partial set
    answers = []
    for i in range(MAX_ANSWERS):
        kind, rdata = row.get(f"answers.{i}.Type"), row.get(f"answers.{i}.Rdata")
        if kind is None and rdata is None:
            break
        answers.append({"Type": kind, "Rdata": rdata})
    if any(row.get(f"answers.{j}.{key}") is not None for j in range(len(answers) + 1, MAX_ANSWERS)
           for key in ("Type", "Rdata")):
        return []  # a gap in the indexes cannot be an exact answer list
    return answers


def _answers(row):
    answers = row.get("answers")
    if answers is None or answers == "":
        answers = _flattened_answers(row)
    if isinstance(answers, str):
        if len(answers) > 8192:
            return None
        try:
            answers = json.loads(answers)
        except (ValueError, TypeError):
            return None
    if not isinstance(answers, list) or not 1 <= len(answers) <= 16:
        return None
    addresses, aliases = set(), set()
    for answer in answers:
        if not isinstance(answer, dict):
            return None
        # Real Resolver query log shape: {"Rdata": ..., "Type": ..., "Class": "IN"}.
        kind, rdata = answer.get("Type"), answer.get("Rdata")
        if answer.get("Class", "IN") != "IN":
            return None
        if kind in {"A", "AAAA"}:
            address = _ip(rdata)
            if address is None or (":" in address) != (kind == "AAAA"):
                return None
            addresses.add(address)
        elif kind == "CNAME":
            host = _host(rdata)
            if host is None:
                return None
            aliases.add(host)
        else:
            return None
    # Multiple aliases cannot establish the order/ownership of a CNAME chain.
    return (addresses, aliases) if addresses and len(aliases) <= 1 else None


def _dns_binding(bundle, row, qualified, start, end):
    account = bundle["coverage"]["account"]
    stamp = d._stamp(row.get("query_timestamp"))
    region, vpc = row.get("region"), row.get("vpc_id")
    answer = _answers(row)
    name, source_ip = _host(row.get("query_name")), _ip(row.get("srcaddr"))
    if (row.get("account_id") != account or not stamp or not start <= stamp <= end
            or row.get("rcode") != "NOERROR" or not answer or not name or not source_ip):
        return None
    addresses, aliases = answer
    local = [(r, capture) for r, capture in qualified if r["region"] == region
             and r.get("facts", {}).get("vpc_id") == vpc
             and abs((stamp - capture).total_seconds()) <= 300]
    instance = row.get("instance")
    sources = [r for r, _ in local if r["kind"] in {"ec2", "ecs_task"}
               and _ip(r["facts"].get("private_ip_address")) == source_ip
               and ((r["kind"] == "ec2" and instance == r["resource_id"])
                    or (r["kind"] == "ecs_task" and not instance))]
    if not sources and any(r["kind"] in {"lambda", "lambda_function"}
            and _ip(r["facts"].get("private_ip_address")) == source_ip for r, _ in local):
        d._mark(bundle, "gaps", "lambda_eni_identity_unresolved")
    targets = [r for r, _ in local if r["kind"] in {"rds", "rds_instance", "rds_proxy", "rds_cluster"}
               and _host(r["facts"].get("endpoint_address")) in {name, *aliases}]
    if len(sources) != 1 or len(targets) != 1:
        return None
    return {"source": sources[0], "target": targets[0], "stamp": stamp,
            "name": name, "ips": addresses, "source_ip": source_ip, "instance": instance,
            "region": region, "vpc": vpc, "source_id": row.get("query_source")}


def _network_matches(binding, flow, account):
    if not isinstance(flow, dict):
        return False
    for side in ("local", "remote"):
        if (flow.get(side + "VpcId") != binding["vpc"]
                or flow.get(side + "Region") != binding["region"]):
            return False
        for suffix, service, native in (("InstanceArn", "ec2", "instance/"),
                                        ("VpcArn", "ec2", "vpc/"),
                                        ("SubnetArn", "ec2", "subnet/")):
            arn = flow.get(side + suffix)
            if arn:
                identifier = flow.get(side + suffix.removesuffix("Arn") + "Id")
                if not isinstance(identifier, str) or arn != (
                        f"arn:aws:{service}:{binding['region']}:{account}:{native}{identifier}"):
                    return False
    if (flow.get("snatIp") and _ip(flow["snatIp"]) != _ip(flow.get("localIp"))
            or flow.get("dnatIp") and _ip(flow["dnatIp"]) != _ip(flow.get("remoteIp"))):
        return False
    if flow.get("query_region") and flow["query_region"] != binding["region"]:
        return False
    value = flow.get("value")
    if not isinstance(value, (int, float)) or isinstance(value, bool) or not math.isfinite(value) or value <= 0:
        return False
    port = binding["target"]["facts"].get("endpoint_port")
    if port is not None and (isinstance(flow.get("targetPort"), bool) or flow.get("targetPort") != port):
        return False
    for source, target in (("local", "remote"), ("remote", "local")):
        if (_ip(flow.get(source + "Ip")) == binding["source_ip"]
                and _ip(flow.get(target + "Ip")) in binding["ips"]):
            instance = flow.get(source + "InstanceId")
            if binding["source"]["kind"] == "ec2":
                return instance == binding["instance"]
            # Node EC2 identity or Pod metadata does not prove an ECS task owner.
            return not instance and not flow.get("kubernetesMetadata")
    return False


def project(bundle, dns_rows, flow_rows, *, start, end, source_id):
    """Project source clocks and narrowly qualified DNS/IP candidates, never calls."""
    start, end = d._stamp(start), d._stamp(end)
    if not start or not end or not 0 < (end - start).total_seconds() <= 3600:
        d._mark(bundle, "gaps", "network_window_invalid")
        return bundle
    qualified = _qualified(bundle)
    if any(isinstance(row, dict) and row.get("kubernetesMetadata")
           for row in flow_rows[:MAX_ROWS * MAX_QUERIES]):
        d._mark(bundle, "gaps", "pod_identity_unresolved")
    bindings = []
    for row in dns_rows[:MAX_ROWS * MAX_GROUPS]:
        binding = _dns_binding(bundle, row, qualified, start, end) if isinstance(row, dict) else None
        if binding is None:
            d._mark(bundle, "gaps", "dns_binding_unresolved")
        else:
            bindings.append(binding)
    peers = {}
    for binding in bindings:
        for address in binding["ips"]:
            key = (binding["region"], binding["vpc"], address)
            peers.setdefault(key, set()).add(binding["target"]["id"])
    conflict = {key for key, targets in peers.items() if len(targets) != 1}
    if conflict:
        d._mark(bundle, "gaps", "dns_ip_conflict")
    window = {"start": start.isoformat(), "end": end.isoformat()}
    for binding in bindings:
        resources = [binding["source"]["id"], binding["target"]["id"]]
        facts = {"query_name": binding["name"], "dns_timestamp": binding["stamp"].isoformat(),
                 "answer_ips": sorted(binding["ips"]), "ttl_known": False,
                 "binding": "dns_window_correlation", "direction": "undirected",
                 "source_id": d._id("source", binding["source_id"] or "resolver_query_logs")}
        evidence = d._evidence(bundle, "resolver_query_logs", "observed_dns_resolution", resources,
            facts, binding["stamp"], region=binding["region"], fresh=d._fresh(binding["stamp"], 300),
            window=window, coverage={"complete": False, "sampled": True})
        d._relationship(bundle, *resources, "observed_dns_resolution", evidence)
        if any((binding["region"], binding["vpc"], ip) in conflict for ip in binding["ips"]):
            continue
        for row in flow_rows[:MAX_ROWS * MAX_QUERIES]:
            if not _network_matches(binding, row, bundle["coverage"]["account"]):
                continue
            if row.get("unit") not in (None, "Bytes"):
                d._mark(bundle, "gaps", "network_unit_unsupported")
                continue
            item = d._evidence(bundle, "network_flow_monitor", "observed_network_flow", resources,
                {**facts, "dns_source_id": facts["source_id"],
                 "source_id": d._id("source", row.get("query_source") or source_id), "metric_name": "DATA_TRANSFERRED",
                 "value": row["value"], "unit": "Bytes", "port": row.get("targetPort"),
                 "destination_category": row.get("destinationCategory")},
                end, region=binding["region"], fresh=d._fresh(end, 300), window=window,
                coverage={"complete": False, "sampled": True})
            d._relationship(bundle, *resources, "observed_network_flow", item)
    return bundle


class _Reads:
    """One source-stage clock and budget checks before clients and each SDK call."""
    def __init__(self, bundle, budget, factory):
        self.bundle, self.budget, self.factory = bundle, budget, factory
        self.deadline = time.monotonic() + 35
        self.clients = {}

    def available(self):
        if self.budget.remaining(analysis=True) <= 2 or time.monotonic() >= self.deadline:
            d._mark(self.bundle, "incomplete", "network_evidence_deadline")
            return False
        return True

    def call(self, service, region, operation, **parameters):
        if not self.available():
            raise TimeoutError("network_evidence_deadline")
        key = service, region
        if key not in self.clients:
            self.clients[key] = self.factory(service, region, self.budget)
        if not self.available():
            raise TimeoutError("network_evidence_deadline")
        client = self.clients[key]
        config = getattr(client, "_client_config", None)
        if config is not None:
            timeout = config.connect_timeout + config.read_timeout
            if min(self.budget.remaining(analysis=True), self.deadline - time.monotonic()) <= timeout:
                d._mark(self.bundle, "incomplete", "network_evidence_deadline")
                raise TimeoutError("network_evidence_deadline")
        return getattr(client, operation)(**parameters)

    def pause(self, attempt=0):
        if self.available():
            _sleep(max(0, min(0.25 * 2 ** attempt, 1.5, self.budget.remaining(analysis=True) - 2,
                              self.deadline - time.monotonic())))

    def stop(self, service, region, operation, **parameters):
        if self.available():
            try:
                self.call(service, region, operation, **parameters)
            except Exception:
                d._mark(self.bundle, "incomplete", "network_query_cleanup_failed")


def _pages(reads, service, region, operation, key, *, lower=False):
    token = None
    for _ in range(MAX_PAGES):
        page_size = 25 if lower else 50
        params = {"maxResults" if lower else "MaxResults": page_size}
        if token:
            params["nextToken" if lower else "NextToken"] = token
        response = reads.call(service, region, operation, **params)
        rows = response.get(key, [])
        if not isinstance(rows, list):
            raise ValueError("invalid_source_rows")
        if len(rows) > page_size:
            d._mark(reads.bundle, "incomplete", "network_source_row_cap")
        yield from rows[:page_size]
        token = response.get("nextToken" if lower else "NextToken")
        if not token:
            return
    d._mark(reads.bundle, "incomplete", "network_source_page_cap")


def _groups(account, regions):
    try:
        values = json.loads(os.environ.get("DIAGNOSIS_DNS_LOG_GROUP_ARNS", "[]"))
    except ValueError:
        return {}, True
    if not isinstance(values, list) or len(values) > MAX_GROUPS:
        return {}, True
    groups = {}
    for value in values:
        if not isinstance(value, str):
            return {}, True
        match = re.fullmatch(r"arn:aws:logs:([a-z0-9-]+):(\d{12}):log-group:([A-Za-z0-9_./#-]{1,512})(?::\*)?", value)
        if not match or match[2] != account or match[1] not in regions:
            return {}, True
        groups.setdefault(match[1], {})[value.removesuffix(":*")] = match[3]
    return groups, False


def _dns(reads, region, approved, vpcs, start, end):
    rows = []
    configs = {row.get("Id"): row.get("DestinationArn", "").removesuffix(":*")
               for row in _pages(reads, "route53resolver", region, "list_resolver_query_log_configs", "ResolverQueryLogConfigs")
               if isinstance(row, dict) and row.get("OwnerId") == reads.bundle["coverage"]["account"]
               and row.get("Status") == "CREATED" and isinstance(row.get("DestinationArn"), str)
               and row["DestinationArn"].removesuffix(":*") in approved}
    selected = {}
    for row in _pages(reads, "route53resolver", region, "list_resolver_query_log_config_associations", "ResolverQueryLogConfigAssociations"):
        if (isinstance(row, dict) and row.get("Status") == "ACTIVE" and row.get("ResourceId") in vpcs
                and row.get("ResolverQueryLogConfigId") in configs):
            selected.setdefault(configs[row["ResolverQueryLogConfigId"]], set()).add(row["ResourceId"])
    for arn in sorted(selected)[:MAX_GROUPS]:
        query_id, finished = None, False
        try:
            response = reads.call("logs", region, "start_query", logGroupName=approved[arn],
                startTime=int(start.timestamp()), endTime=int(end.timestamp()), queryString=DNS_QUERY, limit=MAX_ROWS)
            query_id = response.get("queryId")
            if not isinstance(query_id, str) or not query_id:
                raise ValueError("dns_query_id_missing")
            for attempt in range(MAX_POLLS):
                result = reads.call("logs", region, "get_query_results", queryId=query_id)
                status = result.get("status")
                if status == "Complete":
                    finished = True
                    for fields in result.get("results", [])[:MAX_ROWS]:
                        if isinstance(fields, list):
                            row = {f["field"]: f.get("value") for f in fields[:64]
                                   if isinstance(f, dict) and f.get("field") in DNS_FIELDS}
                            if (row.get("region") == region and row.get("vpc_id") in selected[arn]
                                    and row.get("account_id") == reads.bundle["coverage"]["account"]):
                                rows.append({**row, "query_source": d._id("query", arn, query_id)})
                            else:
                                d._mark(reads.bundle, "gaps", "dns_group_scope_mismatch")
                    d._mark(reads.bundle, "incomplete", "dns_logs_bounded_window")
                    break
                if status not in {"Scheduled", "Running"}:
                    finished = True
                    d._mark(reads.bundle, "gaps", "dns_query_failed")
                    break
                reads.pause(attempt)
            if not finished:
                d._mark(reads.bundle, "incomplete", "dns_query_poll_cap")
        finally:
            if query_id and not finished:
                reads.stop("logs", region, "stop_query", queryId=query_id)
    return rows


def _flows(reads, regions, start, end):
    rows, monitors, queries = [], 0, 0
    d._mark(reads.bundle, "incomplete", "nfm_top_contributors_partial")
    d._mark(reads.bundle, "incomplete", "nfm_categories_omitted")
    account = reads.bundle["coverage"]["account"]
    for region in regions:
        try:
            for monitor in _pages(reads, "networkflowmonitor", region, "list_monitors", "monitors", lower=True):
                if not isinstance(monitor, dict):
                    continue
                name = monitor.get("monitorName")
                if (monitor.get("monitorStatus") != "ACTIVE" or not isinstance(name, str)
                        or not re.fullmatch(r"[a-zA-Z0-9_.-]{1,255}", name)
                        or monitor.get("monitorArn") != f"arn:aws:networkflowmonitor:{region}:{account}:monitor/{name}"):
                    continue
                if monitors >= MAX_MONITORS:
                    d._mark(reads.bundle, "incomplete", "nfm_monitor_cap")
                    return rows
                monitors += 1
                for category in CATEGORIES:
                    if queries >= MAX_QUERIES:
                        d._mark(reads.bundle, "incomplete", "nfm_query_cap")
                        return rows
                    queries += 1
                    query_id, finished = None, False
                    try:
                        response = reads.call("networkflowmonitor", region, "start_query_monitor_top_contributors",
                            monitorName=name, startTime=start, endTime=end, metricName="DATA_TRANSFERRED",
                            destinationCategory=category, limit=MAX_ROWS)
                        query_id = response.get("queryId")
                        if not isinstance(query_id, str) or not query_id:
                            raise ValueError("nfm_query_id_missing")
                        for attempt in range(MAX_POLLS):
                            result = reads.call("networkflowmonitor", region, "get_query_status_monitor_top_contributors",
                                                monitorName=name, queryId=query_id)
                            if result.get("status") == "SUCCEEDED":
                                finished = True
                                result = reads.call("networkflowmonitor", region, "get_query_results_monitor_top_contributors",
                                                    monitorName=name, queryId=query_id, maxResults=MAX_ROWS)
                                contributors = result.get("topContributors", [])
                                if isinstance(contributors, list):
                                    rows.extend({**row, "unit": result.get("unit"), "query_region": region,
                                                 "query_source": d._id("query", monitor["monitorArn"], query_id, category),
                                                 "destinationCategory": category}
                                                for row in contributors[:MAX_ROWS] if isinstance(row, dict))
                                if result.get("nextToken") or len(contributors) > MAX_ROWS:
                                    d._mark(reads.bundle, "incomplete", "nfm_row_cap")
                                break
                            if result.get("status") not in {"QUEUED", "RUNNING"}:
                                finished = True
                                d._mark(reads.bundle, "gaps", "nfm_query_failed")
                                break
                            reads.pause(attempt)
                        if not finished:
                            d._mark(reads.bundle, "incomplete", "nfm_query_poll_cap")
                    finally:
                        if query_id and not finished:
                            reads.stop("networkflowmonitor", region, "stop_query_monitor_top_contributors",
                                       monitorName=name, queryId=query_id)
        except Exception:
            d._mark(reads.bundle, "gaps", "nfm_unavailable")
    if not monitors:
        d._mark(reads.bundle, "gaps", "nfm_unavailable")
    return rows


def collect(bundle, budget, *, scope, client_factory):
    account = bundle.get("coverage", {}).get("account")
    if (os.environ.get("DIAGNOSIS_EVIDENCE_LOOP_ENABLED") != "true"
            or os.environ.get("DIAGNOSIS_NETWORK_EVIDENCE_ENABLED") != "true"):
        return bundle
    if scope != "self" or account != os.environ.get("DIAGNOSIS_HOST_ACCOUNT_ID") or not re.fullmatch(r"\d{12}", account or ""):
        d._mark(bundle, "gaps", "network_scope_unsupported")
        return bundle
    reads = _Reads(bundle, budget, client_factory)
    if not reads.available():
        return bundle
    from .workload_identities import collect_proxies
    collect_proxies(bundle, budget, client_factory)
    qualified = _qualified(bundle)
    vpcs = {}
    for resource, _ in qualified:
        vpc = resource.get("facts", {}).get("vpc_id")
        if isinstance(vpc, str) and re.fullmatch(r"vpc-[a-f0-9]{8,17}", vpc):
            vpcs.setdefault(resource["region"], set()).add(vpc)
    regions = sorted(vpcs)[:MAX_REGIONS]
    if len(vpcs) > MAX_REGIONS:
        d._mark(bundle, "incomplete", "network_region_cap")
    if not regions:
        d._mark(bundle, "gaps", "network_inventory_unqualified")
        return d._finish(bundle)
    approved, invalid = _groups(account, regions)
    if invalid:
        d._mark(bundle, "gaps", "dns_allowlist_invalid")
    end = d._now()
    start = end - dt.timedelta(minutes=5)
    dns_rows = []
    for region in regions:
        if region not in approved:
            continue
        try:
            dns_rows.extend(_dns(reads, region, approved[region], vpcs[region], start, end))
        except Exception:
            d._mark(bundle, "gaps", "dns_logs_unavailable")
    if not dns_rows:
        d._mark(bundle, "gaps", "dns_logs_unavailable")
    flows = _flows(reads, regions, start, end)
    project(bundle, dns_rows, flows, start=start, end=end, source_id="nfm_top_contributors")
    return d._finish(bundle)
