"""Read-only network-connection inventory: TGW attachments, VPC peering connections and VPC
endpoints. Column names are the turbot/aws plugin v0.142.0 table columns (pinned in the
Dockerfile); these rows feed the cross-account network topology projection."""
import pytest

import sync_lambda  # PYTHONPATH must include scripts/v2/steampipe

CASES = {
    "transit_gateway_attachment": (
        "aws_ec2_transit_gateway_vpc_attachment", "transit_gateway_attachment_id",
        ("transit_gateway_id", "transit_gateway_owner_id", "attached_resource_type", "attached_resource_id",
         "resource_owner_id", "state", "association_state",
         "association_transit_gateway_route_table_id", "creation_time", "tags"),
    ),
    "vpc_peering_connection": (
        "aws_vpc_peering_connection", "id",
        ("status_code", "requester_owner_id", "requester_region", "requester_vpc_id",
         "requester_cidr_block", "accepter_owner_id", "accepter_region", "accepter_vpc_id",
         "accepter_cidr_block", "expiration_time", "tags"),
    ),
    "vpc_endpoint": (
        "aws_vpc_endpoint", "vpc_endpoint_id",
        ("vpc_endpoint_type", "service_name", "vpc_id", "owner_id", "state", "subnet_ids",
         "route_table_ids", "private_dns_enabled", "requester_managed", "creation_timestamp", "tags"),
    ),
}


@pytest.mark.parametrize("resource_type", sorted(CASES))
def test_network_connection_types_registered(resource_type):
    table, key, columns = CASES[resource_type]
    assert resource_type in sync_lambda.QUERIES
    assert resource_type in sync_lambda._ALLOWED
    sql, id_col, region_col = sync_lambda.QUERIES[resource_type]
    assert f"FROM {table} " in sql
    for col in (key, "region", "account_id", *columns):
        assert col in sql, col
    assert id_col == key
    assert region_col == "region"


@pytest.mark.parametrize("resource_type", sorted(CASES))
def test_network_connection_queries_are_select_only(resource_type):
    sql = sync_lambda.QUERIES[resource_type][0]
    assert sql.startswith("SELECT ")
    assert ";" not in sql


def test_attachment_columns_are_aliased_and_match_the_web_projection():
    sql = sync_lambda.QUERIES["transit_gateway_attachment"][0]
    assert "resource_type AS attached_resource_type" in sql
    assert "resource_id AS attached_resource_id" in sql
    # No bare `resource_id` column may reach `data` (it would shadow the row id in the UI).
    select_list = sql.split(" FROM ")[0]
    cols = [c.strip().split(" AS ")[-1] for c in select_list[len("SELECT "):].split(",")]
    assert "resource_id" not in cols and "resource_type" not in cols
    # Lockstep with the web projection that reads these fields.
    from pathlib import Path
    web = (Path(__file__).resolve().parents[3] / "web/lib/network-topology.ts").read_text()
    assert "data.attached_resource_type" in web and "data.attached_resource_id" in web
