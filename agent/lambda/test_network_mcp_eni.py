"""Offline ENI evidence regressions; exercise the handler, replace only EC2 I/O."""
import copy
import json
import os
import socket
import sys
from types import SimpleNamespace

import pytest
from botocore.exceptions import ClientError

sys.path.insert(0, os.path.dirname(__file__))
import cross_account as ca
import network_mcp as network


def route_table(table_id="rtb-main", *, subnet=None, main=True, target="nat-main"):
    association = {
        "Main": main,
        "RouteTableId": table_id,
        "RouteTableAssociationId": "rtbassoc-" + table_id,
        "AssociationState": {"State": "associated"},
    }
    if subnet:
        association["SubnetId"] = subnet
    return {
        "RouteTableId": table_id, "VpcId": "vpc-test",
        "Associations": [association],
        "Routes": [{"DestinationCidrBlock": "0.0.0.0/0", "NatGatewayId": target,
                    "State": "active", "Origin": "CreateRoute"}],
    }


def permission(**fields):
    return {
        "IpProtocol": "tcp", "FromPort": 443, "ToPort": 443,
        "IpRanges": [], "Ipv6Ranges": [], "UserIdGroupPairs": [], "PrefixListIds": [],
        **fields,
    }


class Ec2Evidence:
    """Filter-aware, describe-only fixture; unexpected/widened reads fail the test."""

    def __init__(self):
        self.enis = [{
            "NetworkInterfaceId": "eni-test", "PrivateIpAddress": "10.0.1.10",
            "VpcId": "vpc-test", "SubnetId": "subnet-test", "AvailabilityZone": "ap-northeast-2a",
            "Groups": [{"GroupId": "sg-test", "GroupName": "web"}],
        }]
        self.groups = [{
            "GroupId": "sg-test", "GroupName": "web", "VpcId": "vpc-test",
            "IpPermissions": [permission(IpRanges=[{"CidrIp": "10.0.0.0/16"}])],
            "IpPermissionsEgress": [permission(IpProtocol="-1", FromPort=None, ToPort=None,
                                              IpRanges=[{"CidrIp": "0.0.0.0/0"}])],
        }]
        self.nacls = [{
            "NetworkAclId": "acl-test", "VpcId": "vpc-test",
            "Associations": [{"SubnetId": "subnet-test", "NetworkAclId": "acl-test",
                              "NetworkAclAssociationId": "aclassoc-test"}],
            "Entries": [{"RuleNumber": 100, "Protocol": "6", "RuleAction": "allow",
                         "CidrBlock": "10.0.0.0/16", "Egress": False,
                         "PortRange": {"From": 443, "To": 443}}],
        }]
        self.tables = [route_table()]
        self.tokens = set()
        self.errors = set()
        self.omitted = set()
        self.route_calls = []

    def response(self, key, rows, scope):
        if scope in self.errors:
            raise ClientError({"Error": {"Code": "UnauthorizedOperation",
                                         "Message": "fixture read denied"}}, scope)
        result = {key: copy.deepcopy(rows)}
        if scope in self.omitted:
            result.pop(key)
        if scope in self.tokens:
            result["NextToken"] = "more-fixture-evidence"
        return result

    def describe_network_interfaces(self, **kwargs):
        assert kwargs == {"NetworkInterfaceIds": ["eni-test"]}
        return self.response("NetworkInterfaces", self.enis, "eni")

    def describe_security_groups(self, **kwargs):
        assert kwargs == {"GroupIds": ["sg-test"]}
        return self.response("SecurityGroups", self.groups, "securityGroups")

    def describe_network_acls(self, **kwargs):
        assert kwargs == {"Filters": [{"Name": "association.subnet-id", "Values": ["subnet-test"]}]}
        return self.response("NetworkAcls", self.nacls, "nacl")

    def describe_route_tables(self, **kwargs):
        self.route_calls.append(kwargs)
        filters = {f["Name"]: f["Values"] for f in kwargs["Filters"]}
        if "association.subnet-id" in filters:
            assert filters == {"association.subnet-id": ["subnet-test"]}
            rows = [rt for rt in self.tables if any(
                a.get("SubnetId") == "subnet-test" for a in rt["Associations"])]
            return self.response("RouteTables", rows, "explicit")
        assert filters in (
            {"vpc-id": ["vpc-test"]},
            {"vpc-id": ["vpc-test"], "association.main": ["true"]},
        )
        rows = [rt for rt in self.tables if rt["VpcId"] == "vpc-test"]
        if "association.main" in filters:
            rows = [rt for rt in rows if any(a.get("Main") for a in rt["Associations"])]
        return self.response("RouteTables", rows, "main")


@pytest.fixture
def ec2(monkeypatch):
    def no_network(*args, **kwargs):
        raise AssertionError("Live network access forbidden in ENI tests")

    monkeypatch.setattr(socket.socket, "connect", no_network)
    monkeypatch.setenv("AWSOPS_HOST_ACCOUNT_ID", "123456789012")
    ca._host_account_id.cache_clear()
    client = Ec2Evidence()

    def get_client(service, region, role_arn=None):
        assert (service, region, role_arn) == ("ec2", "ap-northeast-2", None)
        return client

    monkeypatch.setattr(network, "get_client", get_client)
    yield client
    ca._host_account_id.cache_clear()


def call_eni(**args):
    result = network.lambda_handler(
        {"tool_name": "get_eni_details", "arguments": {"eni_id": "eni-test", **args}}, None)
    body = json.loads(result["body"])
    assert result["statusCode"] == 200, body
    return body


def assert_unknown(body, component, reason):
    assert body["partial"] is True
    assert any(item["component"] == component and item["reason"] == reason
               for item in body["unknown"]), body


@pytest.mark.parametrize("main_first", [False, True])
def test_main_route_selection_ignores_unrelated_table_order(ec2, main_first):
    unrelated = route_table("rtb-custom", main=False, target="nat-unrelated")
    main = route_table()
    ec2.tables = [main, unrelated] if main_first else [unrelated, main]
    body = call_eni()
    assert body["routes"][0]["target"] == "nat-main"
    assert body["routeTableId"] == "rtb-main"
    assert body["routeSelection"]["basis"] == "main"
    assert body["routeSelection"]["status"] == "selected"
    assert body["partial"] is False
    assert body["unknown"] == []
    assert {"Name": "association.main", "Values": ["true"]} in ec2.route_calls[-1]["Filters"]


def test_explicit_subnet_table_overrides_main(ec2):
    ec2.tables.append(route_table("rtb-explicit", subnet="subnet-test",
                                  main=False, target="nat-explicit"))
    body = call_eni()
    assert body["routes"][0]["target"] == "nat-explicit"
    assert body["routeTableId"] == "rtb-explicit"
    assert body["routeSelection"]["basis"] == "explicit"
    assert len(ec2.route_calls) == 1  # no main fallback once explicitly associated


@pytest.mark.parametrize("tables", [[], [route_table("rtb-custom", main=False)]])
def test_missing_main_is_unknown_not_arbitrary_routes(ec2, tables):
    ec2.tables = tables
    body = call_eni()
    assert body["routes"] == []
    assert body["routeTableId"] is None
    assert body["routeSelection"]["status"] == "unknown"
    assert body["routeSelection"]["reason"] == "missing"
    assert_unknown(body, "routeTable", "missing")


@pytest.mark.parametrize("basis", ["explicit", "main"])
def test_ambiguous_route_tables_are_not_selected_by_order(ec2, basis):
    subnet = "subnet-test" if basis == "explicit" else None
    ec2.tables = [route_table("rtb-one", subnet=subnet),
                  route_table("rtb-two", subnet=subnet)]
    body = call_eni()
    assert body["routes"] == []
    assert body["routeTableId"] is None
    assert body["routeSelection"]["basis"] == basis
    assert body["routeSelection"]["reason"] == "ambiguous"
    assert body["routeSelection"]["candidateIds"] == ["rtb-one", "rtb-two"]
    assert_unknown(body, "routeTable", "ambiguous")
    assert len(ec2.route_calls) == (1 if basis == "explicit" else 2)


@pytest.mark.parametrize("state", ["associating", "disassociating", "disassociated", "failed"])
def test_unsettled_explicit_association_never_falls_back_to_main(ec2, state):
    table = route_table("rtb-explicit", subnet="subnet-test", main=False)
    table["Associations"][0]["AssociationState"]["State"] = state
    ec2.tables.append(table)
    body = call_eni()
    assert body["routes"] == []
    assert body["routeSelection"]["reason"] == "association_not_established"
    assert_unknown(body, "routeTable", "association_not_established")
    assert len(ec2.route_calls) == 1


@pytest.mark.parametrize("scope", ["explicit", "main"])
def test_truncated_table_response_cannot_prove_route_selection(ec2, scope):
    ec2.tokens.add(scope)
    body = call_eni()
    assert body["routes"] == []
    assert body["routeTableId"] is None
    assert body["routeSelection"]["reason"] == "truncated"
    assert_unknown(body, "routeTable", "truncated")
    assert len(ec2.route_calls) == (1 if scope == "explicit" else 2)


@pytest.mark.parametrize("direction,peer_key", [("IpPermissions", "source"),
                                               ("IpPermissionsEgress", "dest")])
def test_every_peer_survives_in_each_direction(ec2, direction, peer_key):
    ec2.groups[0][direction] = [permission(
        IpRanges=[{"CidrIp": "10.0.0.0/16", "Description": "internal"},
                  {"CidrIp": "0.0.0.0/0", "Description": "public"}],
        Ipv6Ranges=[{"CidrIpv6": "2001:db8::/64"}, {"CidrIpv6": "::/0"}],
        UserIdGroupPairs=[{"GroupId": "sg-peer-a", "UserId": "222222222222",
                           "VpcId": "vpc-peer", "VpcPeeringConnectionId": "pcx-peer",
                           "PeeringStatus": "active", "Description": "peered application"},
                          {"GroupId": "sg-peer-b", "UserId": "123456789012"}],
        PrefixListIds=[{"PrefixListId": "pl-one", "Description": "service one"},
                       {"PrefixListId": "pl-two"}],
    )]
    body = call_eni()
    side = "inbound" if peer_key == "source" else "outbound"
    rows = body["securityGroups"][0][side]
    assert [(r["proto"], r["ports"], r[peer_key]) for r in rows] == [
        ("tcp", "443-443", "10.0.0.0/16"), ("tcp", "443-443", "0.0.0.0/0"),
        ("tcp", "443-443", "2001:db8::/64"), ("tcp", "443-443", "::/0"),
        ("tcp", "443-443", "sg-peer-a"), ("tcp", "443-443", "sg-peer-b"),
        ("tcp", "443-443", "pl-one"), ("tcp", "443-443", "pl-two"),
    ]
    assert [r["peerType"] for r in rows] == [
        "ipv4", "ipv4", "ipv6", "ipv6", "securityGroup", "securityGroup", "prefixList", "prefixList"]
    assert rows[1]["peer"]["Description"] == "public"
    assert rows[4]["peer"] == {
        "GroupId": "sg-peer-a", "UserId": "222222222222", "VpcId": "vpc-peer",
        "VpcPeeringConnectionId": "pcx-peer", "PeeringStatus": "active",
        "Description": "peered application",
    }
    assert rows[6]["peer"]["Description"] == "service one"


@pytest.mark.parametrize("direction,side,key", [
    ("IpPermissions", "inbound", "source"), ("IpPermissionsEgress", "outbound", "dest")])
def test_ipv6_only_with_explicit_empty_other_peer_arrays(ec2, direction, side, key):
    ec2.enis[0].pop("PrivateIpAddress")
    ec2.groups[0][direction] = [permission(Ipv6Ranges=[{"CidrIpv6": "::/0"}])]
    body = call_eni()
    assert body["privateIp"] is None
    assert body["securityGroups"][0][side][0][key] == "::/0"
    assert body["partial"] is False


@pytest.mark.parametrize("proto,type_,code", [
    ("icmp", 8, 0), ("1", -1, -1), ("icmpv6", 128, 0), ("58", 3, 1)])
def test_sg_icmp_type_and_code_are_explicit(ec2, proto, type_, code):
    ec2.groups[0]["IpPermissions"] = [permission(
        IpProtocol=proto, FromPort=type_, ToPort=code, IpRanges=[{"CidrIp": "0.0.0.0/0"}])]
    row = call_eni()["securityGroups"][0]["inbound"][0]
    assert (row["icmpType"], row["icmpCode"]) == (type_, code)
    assert row["ports"] == f"{type_}-{code}"  # legacy field retained


def test_peerless_rule_is_unknown_not_a_crash_or_silent_omission(ec2):
    ec2.groups[0]["IpPermissions"] = [permission()]
    body = call_eni()
    row = body["securityGroups"][0]["inbound"][0]
    assert row["source"] is None
    assert row["peerType"] == "unknown"
    assert_unknown(body, "securityGroups", "peer_missing")


def test_ipv6_nacl_keeps_icmp_details_and_rule_order(ec2):
    ec2.nacls[0]["Entries"].extend([
        {"RuleNumber": 90, "Protocol": "58", "RuleAction": "deny", "Ipv6CidrBlock": "::/0",
         "Egress": True, "IcmpTypeCode": {"Type": 128, "Code": 0}},
        {"RuleNumber": 95, "Protocol": "1", "RuleAction": "allow", "CidrBlock": "10.0.0.0/8",
         "Egress": False, "IcmpTypeCode": {"Type": -1, "Code": -1}},
    ])
    body = call_eni()
    assert [r["ruleNum"] for r in body["nacl"]] == [100, 90, 95]
    ipv4, ipv6, icmp = body["nacl"]
    assert (ipv4["cidr"], ipv4["ports"]) == ("10.0.0.0/16", "443-443")
    assert (ipv6["cidr"], ipv6["ipv6Cidr"], ipv6["proto"], ipv6["action"], ipv6["egress"]) == (
        "::/0", "::/0", "58", "deny", True)
    assert (ipv6["icmpType"], ipv6["icmpCode"]) == (128, 0)
    assert (icmp["icmpType"], icmp["icmpCode"]) == (-1, -1)
    assert body["naclId"] == "acl-test"


@pytest.mark.parametrize("field,target", [
    ("GatewayId", "local"), ("GatewayId", "igw-test"), ("NatGatewayId", "nat-test"),
    ("TransitGatewayId", "tgw-test"), ("VpcPeeringConnectionId", "pcx-test"),
    ("NetworkInterfaceId", "eni-appliance"), ("InstanceId", "i-appliance"),
    ("EgressOnlyInternetGatewayId", "eigw-test"), ("LocalGatewayId", "lgw-test"),
    ("CarrierGatewayId", "cagw-test"), ("CoreNetworkArn", "arn:aws:networkmanager::123456789012:core-network/core-network-test"),
    ("OdbNetworkArn", "arn:aws:odb:ap-northeast-2:123456789012:odb-network/odb-test"),
    ("IpAddress", "10.0.2.20"),
])
def test_route_target_is_the_reported_resource_not_fabricated_local(ec2, field, target):
    ec2.tables[0]["Routes"] = [{"DestinationIpv6CidrBlock": "::/0", field: target,
                               "State": "blackhole", "Origin": "CreateRoute"}]
    row = call_eni()["routes"][0]
    assert (row["dest"], row["target"], row["state"]) == ("::/0", target, "blackhole")
    assert row["targetType"] == field
    assert row["targets"] == {field: target}
    assert row["origin"] == "CreateRoute"


def test_prefix_list_route_preserves_instance_and_interface_target_evidence(ec2):
    ec2.tables[0]["Routes"] = [{
        "DestinationPrefixListId": "pl-service", "InstanceId": "i-appliance",
        "InstanceOwnerId": "123456789012", "NetworkInterfaceId": "eni-appliance", "State": "active",
    }]
    row = call_eni()["routes"][0]
    assert row["dest"] == "pl-service"
    assert row["target"] == "eni-appliance"
    assert row["targets"] == {"NetworkInterfaceId": "eni-appliance", "InstanceId": "i-appliance"}
    assert row["instanceOwnerId"] == "123456789012"


def test_missing_target_is_unknown_not_local(ec2):
    ec2.tables[0]["Routes"] = [{"DestinationCidrBlock": "10.0.0.0/8", "State": "blackhole"}]
    body = call_eni()
    assert body["routes"][0]["target"] is None
    assert body["routes"][0]["targetType"] is None
    assert_unknown(body, "routes", "target_missing")


@pytest.mark.parametrize("scope", ["securityGroups", "nacl", "explicit", "main"])
def test_component_read_failure_preserves_other_eni_evidence(ec2, scope):
    ec2.errors.add(scope)
    body = call_eni()
    component = "routeTable" if scope in ("explicit", "main") else scope
    assert body["eniId"] == "eni-test"
    assert body["privateIp"] == "10.0.1.10"
    assert_unknown(body, component, "read_failed")
    issue = next(item for item in body["unknown"] if item["component"] == component)
    assert issue["errorCode"] == "UnauthorizedOperation"
    if scope == "explicit":
        assert len(ec2.route_calls) == 1
    if component == "routeTable":
        assert body["routes"] == []
    else:
        assert body["routes"][0]["target"] == "nat-main"


@pytest.mark.parametrize("attribute,component", [("groups", "securityGroups"), ("nacls", "nacl")])
def test_empty_component_response_is_unknown(ec2, attribute, component):
    setattr(ec2, attribute, [])
    body = call_eni()
    assert_unknown(body, component, "missing")
    assert body["routes"][0]["target"] == "nat-main"


@pytest.mark.parametrize("scope", ["securityGroups", "nacl", "explicit", "main"])
def test_omitted_result_list_is_not_evidence_of_absence(ec2, scope):
    ec2.omitted.add(scope)
    body = call_eni()
    component = "routeTable" if scope in ("explicit", "main") else scope
    assert_unknown(body, component, "response_missing")
    if component == "routeTable":
        assert body["routes"] == []
        assert body["routeSelection"]["reason"] == "response_missing"
    if scope == "explicit":
        assert len(ec2.route_calls) == 1


def test_empty_eni_response_returns_deliberate_error(ec2):
    ec2.enis = []
    result = network.lambda_handler({"eni_id": "eni-test"}, None)
    assert result["statusCode"] == 400
    assert "eni-test" in json.loads(result["body"])["error"]


def test_gateway_context_and_host_account_keep_legacy_response_fields(ec2):
    context = SimpleNamespace(client_context=SimpleNamespace(
        custom={"bedrockAgentCoreToolName": "network-mcp-target___get_eni_details"}))
    result = network.lambda_handler({"eni_id": "eni-test", "target_account_id": "123456789012"}, context)
    assert result["statusCode"] == 200
    body = json.loads(result["body"])
    assert {key: body[key] for key in ("eniId", "privateIp", "vpcId", "subnetId", "az")} == {
        "eniId": "eni-test", "privateIp": "10.0.1.10", "vpcId": "vpc-test",
        "subnetId": "subnet-test", "az": "ap-northeast-2a",
    }
    sg = body["securityGroups"][0]
    assert (sg["id"], sg["name"], sg["inbound"][0]["source"], sg["outbound"][0]["dest"]) == (
        "sg-test", "web", "10.0.0.0/16", "0.0.0.0/0")
