"""Topology discovery inventory additions: ENI ownership, Aurora cluster and RDS Proxy endpoints.
Validates registry membership, key columns and that credential-bearing columns stay out."""
import sync_lambda  # PYTHONPATH must include scripts/v2/steampipe


def _query(resource_type):
    assert resource_type in sync_lambda.QUERIES
    assert resource_type in sync_lambda._ALLOWED
    return sync_lambda.QUERIES[resource_type]


def test_eni_query_carries_ownership_fields():
    sql, id_col, region_col = _query("eni")
    assert "FROM aws_ec2_network_interface" in sql
    for col in ("interface_type", "description", "requester_id", "requester_managed",
                "attached_instance_id", "vpc_id", "subnet_id", "availability_zone",
                "private_ip_address", "private_ip_addresses"):
        assert col in sql, col
    # Public association data is not an ownership input: no association_* columns, and the
    # private_ip_addresses elements are rebuilt from two private keys so their nested
    # Association (public IP, DNS, owner) never reaches the stored row.
    assert "association_" not in sql
    assert "Association" not in sql
    assert "jsonb_build_object('PrivateIpAddress', a ->> 'PrivateIpAddress', 'Primary', a -> 'Primary')" in sql
    assert "AS private_ip_addresses" in sql
    assert (id_col, region_col) == ("network_interface_id", "region")


def test_rds_cluster_query_carries_every_dialable_endpoint():
    sql, id_col, region_col = _query("rds_cluster")
    assert "FROM aws_rds_db_cluster " in sql
    for col in ("endpoint", "reader_endpoint", "custom_endpoints", "members", "vpc_security_groups"):
        assert col in sql, col
    assert "master_user_name" not in sql
    assert (id_col, region_col) == ("db_cluster_identifier", "region")


def test_rds_proxy_query_excludes_auth_secrets():
    sql, id_col, region_col = _query("rds_proxy")
    assert "FROM aws_rds_db_proxy " in sql
    assert "endpoint" in sql and "vpc_subnet_ids" in sql
    assert " auth" not in sql and "role_arn" not in sql
    assert (id_col, region_col) == ("db_proxy_name", "region")


def test_rds_instance_query_carries_cluster_membership():
    sql, _, _ = _query("rds")
    assert "db_cluster_identifier" in sql
