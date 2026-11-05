"""Use the actual inventory projection before matching workload and DB identities."""
import copy
import json

import pytest

from diagnosis import discovery as d, workload_identities as identities
from diagnosis.pillar_agents import _redacted_context
from diagnosis.test_discovery import ACCOUNT, REGION, I1, Budget, Database, inventory, provider, resource


def task(attachments=None):
    return {"last_status": "RUNNING", "attachments": attachments or [
        {"Type": "ElasticNetworkInterface", "Details": [
            {"Name": "subnetId", "Value": "subnet-0123456789abcdef0"},
            {"Name": "privateIPv4Address", "Value": "10.0.1.5"}]}]}


def collect_task(facts):
    return d.collect(Database([
        inventory("subnet", "subnet-0123456789abcdef0", {"vpc_id": "vpc-0123456789abcdef0"}),
        inventory("ecs_task", "task-1", facts)]), ACCOUNT, Budget())


def test_inventory_projection_preserves_task_address_for_internal_matching(provider):
    bundle = collect_task(task())
    facts = resource(bundle, "task-1")["facts"]
    assert facts["private_ip_address"] == "10.0.1.5"
    assert facts["vpc_id"] == "vpc-0123456789abcdef0"
    assert "workload_address_unresolved" not in bundle["gaps"]
    assert "10.0.1.5" not in json.dumps(_redacted_context(bundle))


def test_inventory_projection_preserves_ec2_ip_and_scoped_arn(provider):
    arn = f"arn:aws:ec2:{REGION}:{ACCOUNT}:instance/{I1}"
    bundle = d.collect(Database([inventory("ec2", I1, {
        "arn": arn, "private_ip_address": "10.0.1.5", "instance_type": "m7g.large"})]), ACCOUNT, Budget())
    instance = resource(bundle, I1)
    assert instance["facts"]["private_ip_address"] == "10.0.1.5"
    assert d._arn(instance) == arn
    prompt = json.dumps(_redacted_context(bundle))
    assert arn not in prompt and "10.0.1.5" not in prompt


def test_inventory_projection_preserves_exact_proxy_database_target(provider):
    arn = f"arn:aws:rds:{REGION}:{ACCOUNT}:db:orders"
    bundle = d.collect(Database([inventory("rds", "orders", {
        "arn": arn, "vpc_id": "vpc-0123456789abcdef0"})]), ACCOUNT, Budget())
    database = resource(bundle, "orders")
    assert identities.proxy_target({"TargetArn": arn}, [database], ACCOUNT, REGION,
                                   "vpc-0123456789abcdef0") == database
    assert d._arn(database) == arn
    assert arn not in json.dumps(_redacted_context(bundle))


@pytest.mark.parametrize("overflow", ["attachment", "detail"])
def test_overflow_before_projection_cannot_hide_conflicting_task_address(provider, overflow):
    first = task()["attachments"][0]
    conflicting = copy.deepcopy(first)
    conflicting["Details"][1]["Value"] = "10.0.1.6"
    if overflow == "attachment":
        attachments = [first] * 4 + [conflicting]
    else:
        first["Details"] += [{"Name": "unrelated", "Value": "safe"}] * 6
        first["Details"].append(conflicting["Details"][1])
        attachments = [first]
    bundle = collect_task(task(attachments))
    assert "private_ip_address" not in resource(bundle, "task-1")["facts"]
    assert "workload_address_unresolved" in bundle["gaps"]


@pytest.mark.parametrize("value", ["10.0.0.1 injected", "not-an-ip", "0.0.0.0", "127.0.0.1",
                                  "fd00:1234:5678::25"])
def test_invalid_address_is_not_preserved_as_an_internal_identity(value):
    facts = d._facts({"private_ip_address": value})
    assert facts.get("private_ip_address") in (None, "<ip>")


def test_foreign_arn_cannot_become_the_inventory_identity(provider):
    arn = f"arn:aws:rds:{REGION}:999900001111:db:orders"
    bundle = d.collect(Database([inventory("rds", "orders", {"arn": arn})]), ACCOUNT, Budget())
    assert d._arn(resource(bundle, "orders")) is None
    assert arn not in json.dumps(bundle)
