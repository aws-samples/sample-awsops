"""Tests for reachability_read_mcp — computed ENI<->EC2 connectivity (describe-only, no path creation)."""
import json
import os
import sys
import unittest
from unittest import mock

sys.path.insert(0, os.path.dirname(__file__))
import reachability_read_mcp as rr  # noqa: E402


# ── Fake EC2: serves describe_* from a scenario dict (deep-copied per call is unnecessary) ──
class FakeEc2:
    def __init__(self, scn):
        self.scn = scn

    def describe_network_interfaces(self, **kw):
        if "NetworkInterfaceIds" in kw:
            ids = kw["NetworkInterfaceIds"]
            return {"NetworkInterfaces": [e for e in self.scn["enis"] if e["NetworkInterfaceId"] in ids]}
        # filter by private-ip
        for f in kw.get("Filters", []):
            if f["Name"] == "addresses.private-ip-address":
                ips = f["Values"]
                return {"NetworkInterfaces": [e for e in self.scn["enis"] if e["PrivateIpAddress"] in ips]}
        return {"NetworkInterfaces": []}

    def describe_instances(self, **kw):
        ids = kw.get("InstanceIds", [])
        insts = [{"NetworkInterfaces": [e for e in self.scn["enis"] if e.get("_instance") in ids]}]
        return {"Reservations": [{"Instances": insts}]}

    def describe_security_groups(self, **kw):
        ids = kw.get("GroupIds", [])
        return {"SecurityGroups": [self.scn["sgs"][i] for i in ids if i in self.scn["sgs"]]}

    def describe_network_acls(self, **kw):
        for f in kw.get("Filters", []):
            if f["Name"] == "association.subnet-id":
                sn = f["Values"][0]
                nacl = self.scn["nacls"].get(sn)
                return {"NetworkAcls": [nacl] if nacl else []}
        return {"NetworkAcls": []}

    def describe_route_tables(self, **kw):
        names = {f["Name"]: f["Values"] for f in kw.get("Filters", [])}
        if "association.subnet-id" in names:
            rt = self.scn["rts"].get(names["association.subnet-id"][0])
            return {"RouteTables": [rt] if rt else []}
        # main route-table fallback query (vpc-id + association.main=true)
        if names.get("association.main") == ["true"]:
            mrt = self.scn.get("main_rt")
            return {"RouteTables": [mrt] if mrt else []}
        return {"RouteTables": []}


def _allow_all_nacl():
    return {"NetworkAclId": "acl-1", "Entries": [
        {"RuleNumber": 100, "Protocol": "-1", "Egress": False, "CidrBlock": "0.0.0.0/0", "RuleAction": "allow"},
        {"RuleNumber": 100, "Protocol": "-1", "Egress": True, "CidrBlock": "0.0.0.0/0", "RuleAction": "allow"},
    ]}


def _scenario():
    """A fully-reachable baseline: src 10.0.1.10 (sg-src) -> dst 10.0.2.20 (sg-dst) tcp/5432, same VPC."""
    return {
        "enis": [
            {"NetworkInterfaceId": "eni-src", "PrivateIpAddress": "10.0.1.10", "SubnetId": "subnet-a",
             "VpcId": "vpc-1", "Groups": [{"GroupId": "sg-src"}], "_instance": "i-src"},
            {"NetworkInterfaceId": "eni-dst", "PrivateIpAddress": "10.0.2.20", "SubnetId": "subnet-b",
             "VpcId": "vpc-1", "Groups": [{"GroupId": "sg-dst"}], "_instance": "i-dst"},
        ],
        "sgs": {
            "sg-src": {"GroupId": "sg-src", "GroupName": "src", "IpPermissions": [],
                       "IpPermissionsEgress": [{"IpProtocol": "-1", "IpRanges": [{"CidrIp": "0.0.0.0/0"}], "UserIdGroupPairs": []}]},
            "sg-dst": {"GroupId": "sg-dst", "GroupName": "dst",
                       "IpPermissions": [{"IpProtocol": "tcp", "FromPort": 5432, "ToPort": 5432,
                                          "IpRanges": [{"CidrIp": "10.0.1.0/24"}], "UserIdGroupPairs": []}],
                       "IpPermissionsEgress": [{"IpProtocol": "-1", "IpRanges": [{"CidrIp": "0.0.0.0/0"}], "UserIdGroupPairs": []}]},
        },
        "nacls": {"subnet-a": _allow_all_nacl(), "subnet-b": _allow_all_nacl()},
        "rts": {
            "subnet-a": {"RouteTableId": "rtb-a", "Routes": [{"DestinationCidrBlock": "10.0.0.0/16", "State": "active", "GatewayId": "local"}]},
            "subnet-b": {"RouteTableId": "rtb-b", "Routes": [{"DestinationCidrBlock": "10.0.0.0/16", "State": "active", "GatewayId": "local"}]},
        },
    }


class _Base(unittest.TestCase):
    def setUp(self):
        self.scn = _scenario()
        p = mock.patch.object(rr, "get_client", side_effect=lambda *a, **k: FakeEc2(self.scn))
        p.start(); self.addCleanup(p.stop)
        gr = mock.patch.object(rr, "get_role_arn", return_value=None)
        gr.start(); self.addCleanup(gr.stop)

    def _call(self, **args):
        ev = {"tool_name": "check_reachability", "arguments": {"source": "10.0.1.10", "destination": "10.0.2.20", "port": 5432, "protocol": "tcp", **args}}
        out = rr.lambda_handler(ev, None)
        return out, json.loads(out["body"])


class TestReachable(_Base):
    def test_allowed_via_cidr(self):
        out, body = self._call()
        self.assertEqual(out["statusCode"], 200)
        self.assertTrue(body["reachable"], body)
        self.assertIn("disclaimer", body)

    def test_allowed_via_sg_reference(self):
        # dst SG ingress references the SRC SG-id instead of a CIDR → must still be reachable
        self.scn["sgs"]["sg-dst"]["IpPermissions"] = [
            {"IpProtocol": "tcp", "FromPort": 5432, "ToPort": 5432, "IpRanges": [], "UserIdGroupPairs": [{"GroupId": "sg-src"}]}
        ]
        out, body = self._call()
        self.assertTrue(body["reachable"], body)

    def test_resolve_by_instance_id(self):
        out, body = self._call(source="i-src", destination="i-dst")
        self.assertEqual(out["statusCode"], 200)
        self.assertTrue(body["reachable"], body)

    def test_main_route_table_fallback(self):
        # src subnet has NO explicit RT association → must fall back to the VPC main RT, not "no route"
        self.scn["rts"].pop("subnet-a")
        self.scn["main_rt"] = {"RouteTableId": "rtb-main", "Routes": [
            {"DestinationCidrBlock": "10.0.0.0/16", "State": "active", "GatewayId": "local"}
        ]}
        out, body = self._call()
        self.assertTrue(body["reachable"], body)
        self.assertFalse(any(b["layer"] == "route" for b in body["blocking_component"]))

    def test_instance_primary_eni_by_device_index(self):
        # multi-ENI instance: resolver must pick DeviceIndex 0, not NetworkInterfaces[0]
        self.scn["enis"][0] = {
            "NetworkInterfaceId": "eni-secondary", "PrivateIpAddress": "10.9.9.9", "SubnetId": "subnet-z",
            "VpcId": "vpc-1", "Groups": [{"GroupId": "sg-none"}], "_instance": "i-src",
            "Attachment": {"DeviceIndex": 1},
        }
        self.scn["enis"].append({
            "NetworkInterfaceId": "eni-src", "PrivateIpAddress": "10.0.1.10", "SubnetId": "subnet-a",
            "VpcId": "vpc-1", "Groups": [{"GroupId": "sg-src"}], "_instance": "i-src",
            "Attachment": {"DeviceIndex": 0},
        })
        out, body = self._call(source="i-src")
        self.assertEqual(body["source"]["id"], "eni-src")  # primary, not the DeviceIndex-1 secondary


class TestBlocked(_Base):
    def test_sg_ingress_missing_port(self):
        self.scn["sgs"]["sg-dst"]["IpPermissions"] = [
            {"IpProtocol": "tcp", "FromPort": 443, "ToPort": 443, "IpRanges": [{"CidrIp": "10.0.1.0/24"}], "UserIdGroupPairs": []}
        ]
        out, body = self._call()
        self.assertFalse(body["reachable"])
        layers = [b["layer"] for b in body["blocking_component"]]
        self.assertIn("sg-ingress", layers)

    def test_nacl_forward_deny(self):
        self.scn["nacls"]["subnet-b"] = {"NetworkAclId": "acl-b", "Entries": [
            {"RuleNumber": 100, "Protocol": "-1", "Egress": False, "CidrBlock": "0.0.0.0/0", "RuleAction": "deny"},
            {"RuleNumber": 100, "Protocol": "-1", "Egress": True, "CidrBlock": "0.0.0.0/0", "RuleAction": "allow"},
        ]}
        out, body = self._call()
        self.assertFalse(body["reachable"])
        self.assertTrue(any("nacl" in b["layer"] for b in body["blocking_component"]))

    def test_nacl_return_path_deny(self):
        # forward allowed, but src subnet denies inbound ephemeral return traffic
        self.scn["nacls"]["subnet-a"] = {"NetworkAclId": "acl-a", "Entries": [
            {"RuleNumber": 100, "Protocol": "-1", "Egress": True, "CidrBlock": "0.0.0.0/0", "RuleAction": "allow"},
            {"RuleNumber": 100, "Protocol": "6", "Egress": False, "PortRange": {"From": 5432, "To": 5432}, "CidrBlock": "0.0.0.0/0", "RuleAction": "allow"},
            {"RuleNumber": 200, "Protocol": "-1", "Egress": False, "CidrBlock": "0.0.0.0/0", "RuleAction": "deny"},
        ]}
        out, body = self._call()
        self.assertFalse(body["reachable"])
        self.assertTrue(any("return" in b["layer"] for b in body["blocking_component"]))

    def test_no_route(self):
        self.scn["rts"]["subnet-a"] = {"RouteTableId": "rtb-a", "Routes": [
            {"DestinationCidrBlock": "172.16.0.0/16", "State": "active", "GatewayId": "local"}
        ]}
        out, body = self._call()
        self.assertFalse(body["reachable"])
        self.assertTrue(any(b["layer"] == "route" for b in body["blocking_component"]))

    def test_more_specific_blackhole_overrides_broad_active(self):
        # longest-prefix-match: a /24 blackhole to dst overrides the broader /16 active local route
        self.scn["rts"]["subnet-a"] = {"RouteTableId": "rtb-a", "Routes": [
            {"DestinationCidrBlock": "10.0.0.0/16", "State": "active", "GatewayId": "local"},
            {"DestinationCidrBlock": "10.0.2.0/24", "State": "blackhole"},
        ]}
        out, body = self._call()
        self.assertFalse(body["reachable"])
        self.assertTrue(any(b["layer"] == "route" for b in body["blocking_component"]))


class TestGuards(_Base):
    def test_unknown_tool(self):
        out = rr.lambda_handler({"tool_name": "create_path", "arguments": {}}, None)
        self.assertEqual(out["statusCode"], 400)

    def test_target_account_id_popped(self):
        out, body = self._call(target_account_id="123456789012")
        self.assertEqual(out["statusCode"], 200)

    def test_non_integer_port_400(self):
        out = rr.lambda_handler({"tool_name": "check_reachability", "arguments": {"source": "10.0.1.10", "destination": "10.0.2.20", "port": "abc"}}, None)
        self.assertEqual(out["statusCode"], 400)

    def test_ambiguous_private_ip_400(self):
        # same private IP on two ENIs (e.g. different VPCs) → must 400, not silently pick one
        self.scn["enis"].append({
            "NetworkInterfaceId": "eni-dup", "PrivateIpAddress": "10.0.1.10", "SubnetId": "subnet-x",
            "VpcId": "vpc-2", "Groups": [{"GroupId": "sg-x"}],
        })
        out = rr.lambda_handler({"tool_name": "check_reachability", "arguments": {"source": "10.0.1.10", "destination": "10.0.2.20", "port": 5432}}, None)
        self.assertEqual(out["statusCode"], 400)

    def test_no_mutating_boto3_calls_in_source(self):
        # the mutating APIs may appear in the docstring (explaining what was dropped) but must never
        # be CALLED — assert the call form `<api>(` is absent.
        src = open(os.path.join(os.path.dirname(__file__), "reachability_read_mcp.py")).read()
        for banned in ("create_network_insights_path(", "start_network_insights_analysis("):
            self.assertNotIn(banned, src, f"reachability-read must not call {banned}")


class TestCatalogWiring(unittest.TestCase):
    def test_reachability_target_registered(self):
        sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "..", "scripts", "v2", "agentcore"))
        import catalog
        t = catalog.TARGETS.get("reachability-read-target")
        self.assertIsNotNone(t, "reachability-read-target missing from catalog.TARGETS")
        self.assertEqual(t["gateway"], "network")
        self.assertEqual(t["lambda_key"], "reachability-read")
        self.assertEqual([x["name"] for x in t["tools"]], ["check_reachability"])


if __name__ == "__main__":
    unittest.main()
