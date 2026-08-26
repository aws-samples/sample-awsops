"""
Reachability-read MCP Lambda — computed ENI<->EC2 connectivity, DESCRIBE-ONLY.

Read-only v2 variant of reachability.py. The v1 tool created a VPC Reachability-Analyzer path
(create_network_insights_path / start_network_insights_analysis = AWS-resource MUTATION) — that is
permanently frozen under AWSops's read-only invariant. This variant instead STATICALLY evaluates
whether source can reach destination on a port by reading SGs, subnet NACLs, and route tables.

LIMITS (surfaced in every response's `disclaimer`): this is a static SG + NACL + route approximation,
same-account only. It does NOT model Transit Gateway route tables / blackholes, instance-level
firewalls (iptables/Windows FW), prefix-list contents, or DNS — use AWS Reachability Analyzer for a
definitive, packet-level verdict.

도달성-읽기 MCP — ENI<->EC2 연결성을 describe만으로 정적 평가(경로 생성 없음).
"""
import ipaddress
import json

from cross_account import get_client, get_role_arn, resolve_tool_name

_NUM = {"tcp": "6", "udp": "17", "icmp": "1"}
_EPHEMERAL = 49152  # one representative port in the 1024-65535 ephemeral range; the stateless NACL
# return-path is checked at this single port (approximation — see the response disclaimer)


def _proto_num(p):
    """Normalize a protocol token to its IANA number string. SG rules use names ('tcp') OR numbers
    ('6'); NACL rules use numbers — normalizing both sides makes the comparison form-agnostic."""
    return _NUM.get(str(p), str(p))


def _proto_eq(rule_proto, want):
    rp = str(rule_proto)
    return rp == "-1" or _proto_num(rp) == _proto_num(want)


def _cidr_contains(cidr, ip):
    try:
        return ipaddress.ip_address(ip) in ipaddress.ip_network(cidr, strict=False)
    except ValueError:
        return False


def _resolve_eni(ec2, ident):
    """Resolve an instance-id / eni-id / private-ip to a normalized ENI dict."""
    if ident.startswith("i-"):
        r = ec2.describe_instances(InstanceIds=[ident])
        for res in r.get("Reservations", []):
            for inst in res.get("Instances", []):
                nis = inst.get("NetworkInterfaces", [])
                if nis:
                    # primary ENI = Attachment.DeviceIndex 0 (multi-ENI hosts), fall back to first
                    primary = next((n for n in nis if n.get("Attachment", {}).get("DeviceIndex") == 0), nis[0])
                    return _norm_eni(primary)
        return None
    if ident.startswith("eni-"):
        nis = ec2.describe_network_interfaces(NetworkInterfaceIds=[ident]).get("NetworkInterfaces", [])
        return _norm_eni(nis[0]) if nis else None
    # private-IP path: the same IP can exist in multiple VPCs, and the filter also matches SECONDARY
    # IPs — so (a) reject an ambiguous multi-match (caller must use an eni-id/instance-id or it would
    # silently evaluate the wrong resource), and (b) evaluate the ACTUAL queried IP, not the ENI's
    # primary (a queried secondary IP must drive the SG/NACL/route eval).
    nis = ec2.describe_network_interfaces(
        Filters=[{"Name": "addresses.private-ip-address", "Values": [ident]}]
    ).get("NetworkInterfaces", [])
    if not nis:
        return None
    if len(nis) > 1:
        raise ValueError(f"private IP {ident} matches {len(nis)} ENIs (likely multiple VPCs) — pass an eni-id or instance-id to disambiguate")
    eni = _norm_eni(nis[0])
    eni["ip"] = ident  # use the queried address (may be a secondary IP), not the ENI primary
    return eni


def _norm_eni(eni):
    return {
        "id": eni.get("NetworkInterfaceId"),
        "ip": eni.get("PrivateIpAddress"),
        "subnet": eni.get("SubnetId"),
        "vpc": eni.get("VpcId"),
        "sg_ids": [g["GroupId"] for g in eni.get("Groups", [])],
    }


def _proto_port_match(rule, proto, port):
    rp = str(rule.get("IpProtocol", "-1"))
    if not _proto_eq(rp, proto):
        return False
    if rp == "-1":
        return True
    fp, tp = rule.get("FromPort"), rule.get("ToPort")
    if fp is None or tp is None:
        return True
    return fp <= port <= tp


def _sg_side_allows(sgs, proto, port, peer_ip, peer_sg_ids, egress):
    """Does any SG permit (proto,port) toward/from the peer (by CIDR or SG-id reference)?"""
    key = "IpPermissionsEgress" if egress else "IpPermissions"
    for sg in sgs:
        for rule in sg.get(key, []):
            if not _proto_port_match(rule, proto, port):
                continue
            for ipr in rule.get("IpRanges", []):
                if _cidr_contains(ipr.get("CidrIp", ""), peer_ip):
                    return True
            for pair in rule.get("UserIdGroupPairs", []):
                if pair.get("GroupId") in peer_sg_ids:
                    return True
    return False


def _nacl_allows(nacl, proto, port, peer_ip, egress):
    """Evaluate a (stateless) NACL: first matching rule by RuleNumber wins."""
    for e in sorted(nacl.get("Entries", []), key=lambda x: x.get("RuleNumber", 0)):
        if bool(e.get("Egress")) != egress:
            continue
        ep = str(e.get("Protocol", "-1"))
        if not _proto_eq(ep, proto):
            continue
        pr = e.get("PortRange")
        if ep != "-1" and pr and not (pr.get("From", 0) <= port <= pr.get("To", 65535)):
            continue
        if not _cidr_contains(e.get("CidrBlock", ""), peer_ip):
            continue
        return e.get("RuleAction") == "allow"
    return False  # implicit deny


def _route_exists(rt, dst_ip):
    # AWS routing is longest-prefix-match: the MOST SPECIFIC matching route wins. A more-specific
    # blackhole (e.g. a /24 to a deleted peering) overrides a broader active route (local /16), so
    # we can't just return True on any active match — pick the longest-prefix match and check ITS state.
    best_len, best_state = -1, None
    for r in rt.get("Routes", []):
        cidr = r.get("DestinationCidrBlock")
        if not cidr or not _cidr_contains(cidr, dst_ip):
            continue
        try:
            plen = int(cidr.split("/")[1])
        except (IndexError, ValueError):
            continue
        if plen > best_len:
            best_len, best_state = plen, r.get("State")
    if best_len < 0:
        return False
    return best_state != "blackhole"


def _nacl_for(ec2, subnet):
    r = ec2.describe_network_acls(Filters=[{"Name": "association.subnet-id", "Values": [subnet]}])
    nacls = r.get("NetworkAcls", [])
    return nacls[0] if nacls else None


def _rt_for(ec2, subnet, vpc):
    # explicit subnet association first
    r = ec2.describe_route_tables(Filters=[{"Name": "association.subnet-id", "Values": [subnet]}])
    rts = r.get("RouteTables", [])
    if rts:
        return rts[0]
    # subnets with NO explicit association use the VPC main route table — fall back to it, else a
    # subnet on the main RT is wrongly reported as "no route" (a very common configuration).
    m = ec2.describe_route_tables(Filters=[
        {"Name": "vpc-id", "Values": [vpc]},
        {"Name": "association.main", "Values": ["true"]},
    ])
    mrts = m.get("RouteTables", [])
    return mrts[0] if mrts else None


def check_reachability(ec2, source, destination, port, proto):
    src = _resolve_eni(ec2, source)
    dst = _resolve_eni(ec2, destination)
    blocking = []
    checked = []
    if not src or not dst:
        return {"reachable": False, "blocking_component": [{"layer": "resolve", "resource": source if not src else destination, "reason": "ENI not found"}], "checked": checked}

    src_sgs = ec2.describe_security_groups(GroupIds=src["sg_ids"]).get("SecurityGroups", []) if src["sg_ids"] else []
    dst_sgs = ec2.describe_security_groups(GroupIds=dst["sg_ids"]).get("SecurityGroups", []) if dst["sg_ids"] else []

    # 1) src SG egress permits dst:port
    checked.append("sg-egress")
    if not _sg_side_allows(src_sgs, proto, port, dst["ip"], dst["sg_ids"], egress=True):
        blocking.append({"layer": "sg-egress", "resource": ",".join(src["sg_ids"]), "reason": f"no egress rule for {proto}/{port} to {dst['ip']}"})

    # 2) dst SG ingress permits src:port
    checked.append("sg-ingress")
    if not _sg_side_allows(dst_sgs, proto, port, src["ip"], src["sg_ids"], egress=False):
        blocking.append({"layer": "sg-ingress", "resource": ",".join(dst["sg_ids"]), "reason": f"no ingress rule for {proto}/{port} from {src['ip']}"})

    # 3) NACLs (stateless) — only between different subnets; intra-subnet traffic bypasses NACLs.
    if src["subnet"] != dst["subnet"]:
        src_nacl, dst_nacl = _nacl_for(ec2, src["subnet"]), _nacl_for(ec2, dst["subnet"])
        if src_nacl and dst_nacl:
            checked.append("nacl")
            # forward: src egress dst:port, dst ingress src:port
            if not _nacl_allows(src_nacl, proto, port, dst["ip"], egress=True):
                blocking.append({"layer": "nacl-egress", "resource": src_nacl.get("NetworkAclId"), "reason": f"src subnet NACL denies egress {proto}/{port} to {dst['ip']}"})
            if not _nacl_allows(dst_nacl, proto, port, src["ip"], egress=False):
                blocking.append({"layer": "nacl-ingress", "resource": dst_nacl.get("NetworkAclId"), "reason": f"dst subnet NACL denies ingress {proto}/{port} from {src['ip']}"})
            # stateless return on ephemeral ports
            checked.append("nacl-return")
            if not _nacl_allows(dst_nacl, proto, _EPHEMERAL, src["ip"], egress=True):
                blocking.append({"layer": "nacl-return-egress", "resource": dst_nacl.get("NetworkAclId"), "reason": f"dst subnet NACL denies return egress (ephemeral) to {src['ip']}"})
            if not _nacl_allows(src_nacl, proto, _EPHEMERAL, dst["ip"], egress=False):
                blocking.append({"layer": "nacl-return-ingress", "resource": src_nacl.get("NetworkAclId"), "reason": f"src subnet NACL denies return ingress (ephemeral) from {dst['ip']}"})

    # 4) route from src subnet toward dst
    checked.append("route")
    src_rt = _rt_for(ec2, src["subnet"], src["vpc"])
    if not src_rt or not _route_exists(src_rt, dst["ip"]):
        blocking.append({"layer": "route", "resource": (src_rt or {}).get("RouteTableId", src["subnet"]), "reason": f"no active route from {src['subnet']} toward {dst['ip']}"})

    return {
        "reachable": len(blocking) == 0,
        "source": {"id": src["id"], "ip": src["ip"]},
        "destination": {"id": dst["id"], "ip": dst["ip"]},
        "blocking_component": blocking,
        "checked": checked,
        "disclaimer": (
            "Static SG/NACL/route approximation (same-account). Route uses longest-prefix-match incl. "
            "blackholes, but does NOT model Transit Gateway route tables, the destination return route, "
            "instance-level firewalls, prefix-list contents, or DNS; the NACL return-path is checked at "
            "a single representative ephemeral port. Use AWS Reachability Analyzer for a definitive "
            "packet-level verdict."
        ),
    }


def lambda_handler(event, context):
    params = event if isinstance(event, dict) else json.loads(event)
    tool_name = resolve_tool_name(params, context, default="check_reachability")
    args = params.get("arguments", params)
    target_account_id = args.pop("target_account_id", None) if isinstance(args, dict) else None
    role_arn = get_role_arn(target_account_id) if target_account_id else None

    if tool_name != "check_reachability":
        return {"statusCode": 400, "body": json.dumps({"error": "Unknown tool: " + str(tool_name)})}

    source = args.get("source")
    destination = args.get("destination")
    if not source or not destination:
        return {"statusCode": 400, "body": json.dumps({"error": "source and destination are required"})}
    try:
        port = int(args.get("port", 443))  # catalog declares port as a string → validate
    except (TypeError, ValueError):
        return {"statusCode": 400, "body": json.dumps({"error": f"port must be an integer, got {args.get('port')!r}"})}
    proto = str(args.get("protocol", "tcp")).lower()
    region = args.get("region", "ap-northeast-2")

    ec2 = get_client("ec2", region, role_arn)
    try:
        result = check_reachability(ec2, source, destination, port, proto)
    except ValueError as e:
        return {"statusCode": 400, "body": json.dumps({"error": str(e)})}  # e.g. ambiguous private IP
    return {"statusCode": 200, "body": json.dumps(result, default=str)}
