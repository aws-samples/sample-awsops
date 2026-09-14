"""
AWS Network MCP Lambda - VPC, TGW, VPN, ENI, Network Firewall, Flow Logs
AWS 네트워크 MCP Lambda - VPC, TGW, VPN, ENI, Network Firewall, Flow Logs

# Provides 15+ network troubleshooting tools via AgentCore Gateway MCP.
# AgentCore Gateway MCP를 통해 15개 이상의 네트워크 트러블슈팅 도구를 제공합니다.
"""
import json
import time
from botocore.exceptions import BotoCoreError, ClientError
from cross_account import get_client, get_role_arn, resolve_tool_name


def _eni_read(read, key, unknown, component, *, resource_id=None, **kwargs):
    """One bounded describe call; failed/truncated evidence must not look complete."""
    scope = {"component": component}
    if resource_id is not None:
        scope["resourceId"] = resource_id
    try:
        response = read(**kwargs)
    except (ClientError, BotoCoreError) as exc:
        code = (exc.response.get("Error", {}).get("Code") if isinstance(exc, ClientError)
                else type(exc).__name__)
        unknown.append({**scope, "reason": "read_failed", "errorCode": code})
        return [], "read_failed"
    rows = response.get(key)
    if not isinstance(rows, list):
        unknown.append({**scope, "reason": "response_missing"})
        return [], "response_missing"
    if response.get("NextToken"):
        unknown.append({**scope, "reason": "truncated"})
        return rows, "truncated"
    return rows, None


def _eni_route_table(ec2, subnet_id, vpc_id, unknown):
    """An explicit subnet association wins; only an absent association permits main."""
    selection = {"status": "unknown", "basis": None, "candidateIds": []}
    if not subnet_id or not vpc_id:
        selection["reason"] = "scope_missing"
        unknown.append({"component": "routeTable", "reason": "scope_missing"})
        return None, selection
    for basis, filters in (
        ("explicit", [{"Name": "association.subnet-id", "Values": [subnet_id]}]),
        ("main", [{"Name": "vpc-id", "Values": [vpc_id]},
                  {"Name": "association.main", "Values": ["true"]}]),
    ):
        tables, reason = _eni_read(ec2.describe_route_tables, "RouteTables",
                                   unknown, "routeTable", Filters=filters)
        selection.update(basis=basis, candidateIds=sorted(
            rt["RouteTableId"] for rt in tables if rt.get("RouteTableId")))
        if reason:
            selection["reason"] = reason
            return None, selection
        if not tables and basis == "explicit":
            continue
        if len(tables) != 1:
            reason = "ambiguous" if tables else "missing"
        else:
            table = tables[0]
            associations = [a for a in table.get("Associations", [])
                            if (a.get("SubnetId") == subnet_id if basis == "explicit"
                                else a.get("Main") is True)]
            if not table.get("RouteTableId") or table.get("VpcId") != vpc_id:
                reason = "identity_mismatch"
            elif not associations:
                reason = "association_missing"
            elif any(a.get("AssociationState", {}).get("State") not in (None, "associated")
                     for a in associations):
                reason = "association_not_established"
            else:
                selection.update(status="selected", associations=associations)
                return table, selection
        selection["reason"] = reason
        unknown.append({"component": "routeTable", "reason": reason})
        return None, selection


def _eni_permissions(rules, peer_key, sg_id, unknown):
    """Keep legacy rule fields, emitting one row per peer, including its full metadata."""
    rows = []
    for rule in rules:
        base = {"proto": rule.get("IpProtocol"),
                "ports": "{}-{}".format(rule.get("FromPort", ""), rule.get("ToPort", ""))}
        if str(rule.get("IpProtocol")) in ("icmp", "1", "icmpv6", "58"):
            base.update(icmpType=rule.get("FromPort"), icmpCode=rule.get("ToPort"))
        peers = []
        for field, value_key, peer_type in (
            ("IpRanges", "CidrIp", "ipv4"),
            ("Ipv6Ranges", "CidrIpv6", "ipv6"),
            ("UserIdGroupPairs", "GroupId", "securityGroup"),
            ("PrefixListIds", "PrefixListId", "prefixList"),
        ):
            for peer in rule.get(field) or []:
                peers.append({**base, peer_key: peer.get(value_key),
                              "peerType": peer_type, "peer": peer})
        if not peers:
            peers.append({**base, peer_key: None, "peerType": "unknown", "peer": {}})
        if any(p[peer_key] is None for p in peers):
            unknown.append({"component": "securityGroups", "resourceId": sg_id,
                            "reason": "peer_missing"})
        rows.extend(peers)
    return rows


def _eni_route(route, unknown):
    # An instance target also carries its ENI; retain both and prefer the interface identity.
    targets = {key: route[key] for key in (
        "GatewayId", "NatGatewayId", "TransitGatewayId", "VpcPeeringConnectionId",
        "NetworkInterfaceId", "InstanceId", "EgressOnlyInternetGatewayId",
        "LocalGatewayId", "CarrierGatewayId", "CoreNetworkArn", "OdbNetworkArn", "IpAddress",
    ) if route.get(key)}
    target_type = next(iter(targets), None)
    dest = (route.get("DestinationCidrBlock") or route.get("DestinationIpv6CidrBlock")
            or route.get("DestinationPrefixListId"))
    if not targets:
        unknown.append({"component": "routes", "reason": "target_missing", "destination": dest})
    if not dest:
        unknown.append({"component": "routes", "reason": "destination_missing"})
    return {"dest": dest, "target": targets.get(target_type), "targetType": target_type,
            "targets": targets, "state": route.get("State", ""), "origin": route.get("Origin"),
            "instanceOwnerId": route.get("InstanceOwnerId")}


def _get_eni_details(ec2, eni_id):
    if not eni_id:
        return err("eni_id required")
    unknown = []
    enis, reason = _eni_read(ec2.describe_network_interfaces, "NetworkInterfaces",
                            unknown, "eni", resource_id=eni_id, NetworkInterfaceIds=[eni_id])
    if reason:
        # Only fixed diagnostic codes may leave the entry failure boundary.
        if reason == "read_failed" and unknown[0]["errorCode"] not in (
            "InvalidNetworkInterfaceID.NotFound", "UnauthorizedOperation",
            "AccessDenied", "AccessDeniedException", "AuthFailure",
            "RequestLimitExceeded", "Throttling", "ThrottlingException",
            "EndpointConnectionError", "ConnectionClosedError", "ConnectTimeoutError",
            "ReadTimeoutError", "SSLError",
        ):
            unknown[0]["errorCode"] = "ReadError"
        return {"statusCode": 400, "body": json.dumps({
            "error": "ENI lookup unavailable; configuration unassessed",
            "eniId": eni_id, "partial": True, "unknown": unknown,
        })}
    if len(enis) != 1:
        return err(f"ENI {eni_id}: expected one interface, found {len(enis)}")
    eni = enis[0]
    subnet_id, vpc_id = eni.get("SubnetId"), eni.get("VpcId")
    sgs, nacl_rules = [], []
    for sg in eni.get("Groups") or []:
        sg_id = sg.get("GroupId")
        projected = {"id": sg_id, "name": sg.get("GroupName"), "inbound": [], "outbound": [],
                     "partial": True}
        sgs.append(projected)
        if not sg_id:
            unknown.append({"component": "securityGroups", "reason": "identity_missing"})
            continue
        groups, reason = _eni_read(ec2.describe_security_groups, "SecurityGroups",
                                   unknown, "securityGroups", resource_id=sg_id, GroupIds=[sg_id])
        if reason:
            continue
        if len(groups) != 1 or groups[0].get("GroupId") != sg_id:
            unknown.append({"component": "securityGroups", "resourceId": sg_id,
                            "reason": "missing" if not groups else "ambiguous"})
            continue
        unknown_before_rules = len(unknown)
        for key, side, peer_key in (("IpPermissions", "inbound", "source"),
                                    ("IpPermissionsEgress", "outbound", "dest")):
            projected[side] = _eni_permissions(groups[0].get(key) or [], peer_key, sg_id, unknown)
        # Completeness is local to this group, including any missing rule peers.
        projected["partial"] = len(unknown) != unknown_before_rules

    nacl_id = None
    if subnet_id:
        nacls, reason = _eni_read(ec2.describe_network_acls, "NetworkAcls", unknown, "nacl",
                                 Filters=[{"Name": "association.subnet-id", "Values": [subnet_id]}])
        if not reason and len(nacls) != 1:
            unknown.append({"component": "nacl", "reason": "ambiguous" if nacls else "missing"})
        elif not reason:
            nacl_id = nacls[0].get("NetworkAclId")
            for entry in nacls[0].get("Entries") or []:
                ports = entry.get("PortRange") or {}
                icmp = entry.get("IcmpTypeCode") or {}
                nacl_rules.append({
                    "ruleNum": entry.get("RuleNumber"), "proto": entry.get("Protocol"),
                    "action": entry.get("RuleAction"),
                    "cidr": entry.get("CidrBlock") or entry.get("Ipv6CidrBlock", ""),
                    "ipv6Cidr": entry.get("Ipv6CidrBlock"), "egress": entry.get("Egress"),
                    "ports": "{}-{}".format(ports.get("From", ""), ports.get("To", "")),
                    "icmpType": icmp.get("Type"), "icmpCode": icmp.get("Code"),
                })
    else:
        unknown.append({"component": "nacl", "reason": "scope_missing"})
    table, selection = _eni_route_table(ec2, subnet_id, vpc_id, unknown)
    routes = [_eni_route(r, unknown) for r in (table or {}).get("Routes") or []]
    return ok({"eniId": eni_id, "privateIp": eni.get("PrivateIpAddress"), "vpcId": vpc_id,
               "subnetId": subnet_id, "az": eni.get("AvailabilityZone"),
               "securityGroups": sgs, "nacl": nacl_rules, "routes": routes,
               "naclId": nacl_id, "routeTableId": (table or {}).get("RouteTableId"),
               "routeSelection": selection, "partial": bool(unknown), "unknown": unknown})


def lambda_handler(event, context):
    # Parse event and extract tool name and arguments / 이벤트를 파싱하고 도구 이름과 인자를 추출
    params = event if isinstance(event, dict) else json.loads(event)
    t = resolve_tool_name(params, context)
    args = params.get("arguments", params)
    target_account_id = args.pop('target_account_id', None)
    role_arn = get_role_arn(target_account_id) if target_account_id else None
    region = args.get("region", "ap-northeast-2")

    # Auto-detect tool from parameters if tool_name not provided / tool_name이 없으면 파라미터로 도구를 자동 감지
    if not t:
        if "ip_address" in params: t = "find_ip_address"
        elif "eni_id" in params: t = "get_eni_details"
        elif "tgw_id" in params and "route_table_id" in params: t = "get_tgw_routes"
        elif "tgw_id" in params: t = "get_tgw_details"
        elif "vpc_id" in params and "flow" in str(params).lower(): t = "get_vpc_flow_logs"
        elif "vpc_id" in params: t = "get_vpc_network_details"
        elif "firewall_name" in params: t = "get_firewall_rules"
        elif "resource_type" in params: t = "describe_network"
        else: t = "get_path_trace_methodology"
        args = params

    try:
        # Initialize EC2 client for the specified region / 지정된 리전에 대한 EC2 클라이언트 초기화
        ec2 = get_client('ec2', region, role_arn)

        # ========== General / 일반 ==========
        # Return step-by-step network path tracing methodology / 네트워크 경로 추적 방법론을 단계별로 반환
        if t == "get_path_trace_methodology":
            return ok({"methodology": [
                "1. Identify source and destination (IP, ENI, instance)",
                "2. find_ip_address to locate the ENI",
                "3. get_eni_details for SG, NACL, route info",
                "4. Check Security Groups (inbound/outbound rules)",
                "5. Check NACLs (allow/deny rules, rule ordering)",
                "6. Check Route Tables (destination routing)",
                "7. If cross-VPC: check TGW routes (get_tgw_routes)",
                "8. If VPN: check VPN connection status (list_vpn_connections)",
                "9. If firewall: check firewall rules (get_firewall_rules)",
                "10. Check VPC Flow Logs for ACCEPT/REJECT (get_vpc_flow_logs)"]})

        # Find ENI by IP address (private first, then public) / IP 주소로 ENI 검색 (프라이빗 우선, 그 다음 퍼블릭)
        elif t == "find_ip_address":
            ip = args.get("ip_address", "")
            filters = []
            if ip:
                # Search by private IP first / 먼저 프라이빗 IP로 검색
                filters.append({"Name": "addresses.private-ip-address", "Values": [ip]})
                resp = ec2.describe_network_interfaces(Filters=filters)
                enis = resp.get("NetworkInterfaces", [])
                if not enis:
                    # Fallback: search by public IP / 대체: 퍼블릭 IP로 검색
                    filters = [{"Name": "association.public-ip", "Values": [ip]}]
                    resp = ec2.describe_network_interfaces(Filters=filters)
                    enis = resp.get("NetworkInterfaces", [])
            else:
                return err("ip_address required")
            results = [{"eniId": e["NetworkInterfaceId"], "privateIp": e.get("PrivateIpAddress"),
                "publicIp": e.get("Association", {}).get("PublicIp"),
                "vpcId": e.get("VpcId"), "subnetId": e.get("SubnetId"),
                "az": e.get("AvailabilityZone"), "status": e.get("Status"),
                "description": e.get("Description", "")[:100],
                "attachedTo": e.get("Attachment", {}).get("InstanceId", "")}
                for e in enis[:10]]
            return ok({"ip": ip, "enis": results, "count": len(results)})

        # Get full ENI details including SG, NACL, and route table / ENI 상세 정보 조회 (SG, NACL, 라우트 테이블 포함)
        elif t == "get_eni_details":
            return _get_eni_details(ec2, args.get("eni_id", ""))

        # ========== VPC / VPC 관련 ==========
        # List all VPCs with name and CIDR / 모든 VPC를 이름과 CIDR과 함께 목록 조회
        elif t == "list_vpcs":
            vpcs = ec2.describe_vpcs().get("Vpcs", [])
            return ok({"vpcs": [{"vpcId": v["VpcId"], "cidr": v.get("CidrBlock"),
                "state": v.get("State"), "name": next((t["Value"] for t in v.get("Tags", []) if t["Key"] == "Name"), "")}
                for v in vpcs[:20]]})

        # Get comprehensive VPC network details (subnets, route tables, SGs, IGW, NAT, endpoints)
        # VPC 네트워크 상세 조회 (서브넷, 라우트 테이블, 보안 그룹, IGW, NAT, 엔드포인트)
        elif t == "get_vpc_network_details":
            vpc_id = args.get("vpc_id", "")
            # Fetch VPC and all associated network resources / VPC 및 모든 관련 네트워크 리소스 조회
            vpc = ec2.describe_vpcs(VpcIds=[vpc_id])["Vpcs"][0]
            subnets = ec2.describe_subnets(Filters=[{"Name": "vpc-id", "Values": [vpc_id]}])["Subnets"]
            rts = ec2.describe_route_tables(Filters=[{"Name": "vpc-id", "Values": [vpc_id]}])["RouteTables"]
            sgs = ec2.describe_security_groups(Filters=[{"Name": "vpc-id", "Values": [vpc_id]}])["SecurityGroups"]
            igws = ec2.describe_internet_gateways(Filters=[{"Name": "attachment.vpc-id", "Values": [vpc_id]}])["InternetGateways"]
            nats = ec2.describe_nat_gateways(Filter=[{"Name": "vpc-id", "Values": [vpc_id]}])["NatGateways"]
            endpoints = ec2.describe_vpc_endpoints(Filters=[{"Name": "vpc-id", "Values": [vpc_id]}])["VpcEndpoints"]
            return ok({"vpcId": vpc_id, "cidr": vpc.get("CidrBlock"),
                "subnets": [{"id": s["SubnetId"], "cidr": s["CidrBlock"], "az": s["AvailabilityZone"],
                    "name": next((t["Value"] for t in s.get("Tags", []) if t["Key"] == "Name"), "")} for s in subnets],
                "routeTables": len(rts), "securityGroups": len(sgs),
                "internetGateways": [i["InternetGatewayId"] for i in igws],
                "natGateways": [{"id": n["NatGatewayId"], "state": n["State"], "subnetId": n.get("SubnetId")} for n in nats],
                "vpcEndpoints": [{"id": e["VpcEndpointId"], "service": e["ServiceName"], "type": e["VpcEndpointType"]} for e in endpoints[:10]]})

        # Retrieve VPC Flow Logs from CloudWatch Logs / CloudWatch Logs에서 VPC Flow Logs 조회
        elif t == "get_vpc_flow_logs":
            vpc_id = args.get("vpc_id", "")
            minutes = args.get("minutes", 30)
            filter_pattern = args.get("filter_pattern", "")
            # Check if flow logs are configured for this VPC / 이 VPC에 플로우 로그가 설정되어 있는지 확인
            fls = ec2.describe_flow_logs(Filters=[{"Name": "resource-id", "Values": [vpc_id]}])["FlowLogs"]
            if not fls:
                return ok({"vpc_id": vpc_id, "message": "No flow logs configured for this VPC"})
            log_group = fls[0].get("LogGroupName", "")
            if not log_group:
                return ok({"vpc_id": vpc_id, "flowLogs": [{"id": f["FlowLogId"], "destination": f.get("LogDestination", "")} for f in fls],
                    "message": "Flow logs use S3 destination, not CloudWatch"})
            # Query CloudWatch Logs for flow log events / CloudWatch Logs에서 플로우 로그 이벤트 조회
            logs = get_client('logs', region, role_arn)
            start = int((time.time() - minutes * 60) * 1000)
            try:
                resp = logs.filter_log_events(logGroupName=log_group, startTime=start, limit=50, filterPattern=filter_pattern)
                events = [{"timestamp": e.get("timestamp"), "message": e.get("message", "")[:200]} for e in resp.get("events", [])]
                return ok({"vpc_id": vpc_id, "logGroup": log_group, "events": events, "count": len(events)})
            except Exception as e:
                # Return error with log group info for debugging / 디버깅을 위해 로그 그룹 정보와 함께 오류 반환
                return ok({"vpc_id": vpc_id, "logGroup": log_group, "error": str(e)})

        # Describe network resources by type (SG, NACL, route table, subnet, VPC)
        # 유형별 네트워크 리소스 조회 (보안 그룹, NACL, 라우트 테이블, 서브넷, VPC)
        elif t == "describe_network":
            rt = args.get("resource_type", "")
            rid = args.get("resource_id", "")
            vpc = args.get("vpc_id", "")
            if rt == "security_group":
                f = [{"Name": "group-id", "Values": [rid]}] if rid else [{"Name": "vpc-id", "Values": [vpc]}] if vpc else []
                r = ec2.describe_security_groups(Filters=f) if f else ec2.describe_security_groups()
                r.pop("ResponseMetadata", None)
                return ok(r)
            elif rt == "nacl":
                f = [{"Name": "network-acl-id", "Values": [rid]}] if rid else [{"Name": "vpc-id", "Values": [vpc]}] if vpc else []
                r = ec2.describe_network_acls(Filters=f) if f else ec2.describe_network_acls()
                r.pop("ResponseMetadata", None)
                return ok(r)
            elif rt == "route_table":
                f = [{"Name": "route-table-id", "Values": [rid]}] if rid else [{"Name": "vpc-id", "Values": [vpc]}] if vpc else []
                r = ec2.describe_route_tables(Filters=f) if f else ec2.describe_route_tables()
                r.pop("ResponseMetadata", None)
                return ok(r)
            elif rt == "subnet":
                f = [{"Name": "subnet-id", "Values": [rid]}] if rid else [{"Name": "vpc-id", "Values": [vpc]}] if vpc else []
                r = ec2.describe_subnets(Filters=f) if f else ec2.describe_subnets()
                r.pop("ResponseMetadata", None)
                return ok(r)
            elif rt == "vpc":
                r = ec2.describe_vpcs(VpcIds=[rid] if rid else [])
                r.pop("ResponseMetadata", None)
                return ok(r)
            return err("Unknown resource_type: " + rt)

        # ========== Transit Gateway / Transit Gateway 관련 ==========
        # List all Transit Gateways / 모든 Transit Gateway 목록 조회
        elif t == "list_transit_gateways":
            tgws = ec2.describe_transit_gateways().get("TransitGateways", [])
            return ok({"transitGateways": [{"id": g["TransitGatewayId"], "state": g["State"],
                "ownerId": g.get("OwnerId"), "asn": g.get("Options", {}).get("AmazonSideAsn"),
                "name": next((t["Value"] for t in g.get("Tags", []) if t["Key"] == "Name"), "")}
                for g in tgws[:20]]})

        # Get TGW details with attachments and route tables / TGW 상세 정보, 어태치먼트, 라우트 테이블 조회
        elif t == "get_tgw_details":
            tgw_id = args.get("tgw_id", "")
            tgw = ec2.describe_transit_gateways(TransitGatewayIds=[tgw_id])["TransitGateways"][0]
            attachments = ec2.describe_transit_gateway_attachments(Filters=[{"Name": "transit-gateway-id", "Values": [tgw_id]}])["TransitGatewayAttachments"]
            rts = ec2.describe_transit_gateway_route_tables(Filters=[{"Name": "transit-gateway-id", "Values": [tgw_id]}])["TransitGatewayRouteTables"]
            return ok({"tgwId": tgw_id, "state": tgw["State"], "options": tgw.get("Options", {}),
                "attachments": [{"id": a["TransitGatewayAttachmentId"], "type": a["ResourceType"],
                    "resourceId": a.get("ResourceId", ""), "state": a["State"]}
                    for a in attachments[:20]],
                "routeTables": [{"id": r["TransitGatewayRouteTableId"], "state": r["State"],
                    "defaultAssociation": r.get("DefaultAssociationRouteTable", False)}
                    for r in rts]})

        # Search TGW route table for active/blackhole routes / TGW 라우트 테이블에서 활성/블랙홀 경로 검색
        elif t == "get_tgw_routes":
            rt_id = args.get("route_table_id", "")
            routes = ec2.search_transit_gateway_routes(
                TransitGatewayRouteTableId=rt_id,
                Filters=[{"Name": "state", "Values": ["active", "blackhole"]}])["Routes"]
            return ok({"routeTableId": rt_id, "routes": [{"dest": r.get("DestinationCidrBlock", ""),
                "type": r.get("Type", ""), "state": r.get("State", ""),
                "attachmentId": r.get("TransitGatewayAttachments", [{}])[0].get("TransitGatewayAttachmentId", "") if r.get("TransitGatewayAttachments") else ""}
                for r in routes[:50]]})

        # Get routes from all route tables of a TGW / TGW의 모든 라우트 테이블에서 경로 조회
        elif t == "get_all_tgw_routes":
            tgw_id = args.get("tgw_id", "")
            rts = ec2.describe_transit_gateway_route_tables(Filters=[{"Name": "transit-gateway-id", "Values": [tgw_id]}])["TransitGatewayRouteTables"]
            all_routes = []
            for rt in rts:
                rt_id = rt["TransitGatewayRouteTableId"]
                routes = ec2.search_transit_gateway_routes(TransitGatewayRouteTableId=rt_id,
                    Filters=[{"Name": "state", "Values": ["active", "blackhole"]}])["Routes"]
                all_routes.append({"routeTableId": rt_id, "routeCount": len(routes),
                    "routes": [{"dest": r.get("DestinationCidrBlock", ""), "state": r.get("State")} for r in routes[:20]]})
            return ok({"tgwId": tgw_id, "routeTables": all_routes})

        # List TGW peering attachments / TGW 피어링 어태치먼트 목록 조회
        elif t == "list_tgw_peerings":
            tgw_id = args.get("tgw_id", "")
            attachments = ec2.describe_transit_gateway_attachments(
                Filters=[{"Name": "transit-gateway-id", "Values": [tgw_id]}, {"Name": "resource-type", "Values": ["peering"]}])["TransitGatewayAttachments"]
            return ok({"tgwId": tgw_id, "peerings": [{"id": a["TransitGatewayAttachmentId"],
                "state": a["State"], "resourceId": a.get("ResourceId", "")} for a in attachments]})

        # ========== VPN / VPN 관련 ==========
        # List VPN connections with tunnel status / VPN 연결 목록 및 터널 상태 조회
        elif t == "list_vpn_connections":
            vpns = ec2.describe_vpn_connections().get("VpnConnections", [])
            return ok({"vpnConnections": [{"id": v["VpnConnectionId"], "state": v["State"],
                "type": v.get("Type", ""), "tgwId": v.get("TransitGatewayId", ""),
                "vgwId": v.get("VpnGatewayId", ""), "customerGw": v.get("CustomerGatewayId", ""),
                "tunnels": [{"status": t.get("Status"), "outsideIp": t.get("OutsideIpAddress")}
                    for t in v.get("VgwTelemetry", [])]}
                for v in vpns[:20]]})

        # ========== Network Firewall / 네트워크 방화벽 관련 ==========
        # List AWS Network Firewalls / AWS Network Firewall 목록 조회
        elif t == "list_network_firewalls":
            nfw = get_client('network-firewall', region, role_arn)
            fws = nfw.list_firewalls().get("Firewalls", [])
            return ok({"firewalls": [{"name": f.get("FirewallName"), "arn": f.get("FirewallArn")} for f in fws[:20]]})

        # Get firewall policy rules (stateless + stateful) / 방화벽 정책 규칙 조회 (스테이트리스 + 스테이트풀)
        elif t == "get_firewall_rules":
            nfw = get_client('network-firewall', region, role_arn)
            fw_name = args.get("firewall_name", "")
            # Describe firewall and its associated policy / 방화벽 및 연결된 정책 조회
            fw = nfw.describe_firewall(FirewallName=fw_name)
            policy_arn = fw["Firewall"].get("FirewallPolicyArn", "")
            policy = nfw.describe_firewall_policy(FirewallPolicyArn=policy_arn)
            fp = policy.get("FirewallPolicy", {})
            stateless = fp.get("StatelessRuleGroupReferences", [])
            stateful = fp.get("StatefulRuleGroupReferences", [])
            return ok({"firewallName": fw_name, "policyArn": policy_arn,
                "statelessRuleGroups": [r.get("ResourceArn", "").split("/")[-1] for r in stateless],
                "statefulRuleGroups": [r.get("ResourceArn", "").split("/")[-1] for r in stateful],
                "statelessDefaultActions": fp.get("StatelessDefaultActions", [])})

        return err("Unknown tool: " + t)

    except Exception as e:
        # Global error handler - return 500 with error message / 전역 오류 처리 - 오류 메시지와 함께 500 반환
        return {"statusCode": 500, "body": json.dumps({"error": str(e)})}


# Helper: return HTTP 200 success response / 헬퍼: HTTP 200 성공 응답 반환
def ok(body):
    return {"statusCode": 200, "body": json.dumps(body, default=str)}

# Helper: return HTTP 400 error response / 헬퍼: HTTP 400 오류 응답 반환
def err(msg):
    return {"statusCode": 400, "body": json.dumps({"error": msg})}
